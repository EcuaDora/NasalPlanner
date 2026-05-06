"""
bd_polish.py — Bounded-Distortion ARAP polish для развёртки.

Применяется ПОСЛЕ основного unfold (single или charts). Ограничивает
дисторсию каждой грани:
   - σ_max ≤ S_max  (растяжение)
   - σ_min ≥ S_min  (сжатие, по умолчанию = 1/S_max)
   - σ_max/σ_min ≤ K_max  (изотропия = «отношение растяжений»)

Гарантия (при line_search=True):
   - НЕ создаёт новые инверсии валидных граней
   - НЕ позволяет iso_max ВЫРАСТИ резко (защита от blow-up'а в нестабильных
     топологиях типа fan-fill)
   - При сходимости все валидные грани удовлетворяют constraint, или близки
     к нему. Если bound недостижим геометрически (1-2 грани в плотных областях
     вокруг перфораций или fan-fill'ов), они стабилизируются на близком значении.

Реализация: SVD-based singular value projection + ARAP-like linear solve
с line search по |sa|<0 и iso_max растёт <50%.

Референс: Lipman 2012 «Bounded Distortion Mapping Spaces» (но проще,
без CCQP — используем soft constraint через line search).

=== v6.4 patches ===
R1 (singular Lap_free guard): Tikhonov-регуляризация ε≈1e-8·max(diag) если
    splu бросает «Factor is exactly singular». Спасает на мешах со слабо-
    связными fan-fill apex'ами (degenerate cot-веса). info['used_regularization']
    выставляется True если регуляризация применена.

R2 (blow-up guard с откатом): tracking лучшего iso состояния + hard stop
    если за последние 5 итераций iso только растёт И превысил
    iso_start*1.2. Спасает от drift'а на сложных топологиях (например меш
    из research-cohort где iso 3.38 без R2 → 7.47 с K=1.5).
    info['hard_stop_reason'] = 'blow_up_at_iter_N' если сработал.
"""
import numpy as np
import scipy.sparse as sp
from scipy.sparse.linalg import splu


def _local_2d_coords(V, F):
    p1 = V[F[:, 0]]; p2 = V[F[:, 1]]; p3 = V[F[:, 2]]
    e12 = p2 - p1; L12 = np.linalg.norm(e12, axis=1)
    L = np.maximum(L12, 1e-15); e12h = e12 / L[:, None]
    e13 = p3 - p1
    x3 = np.einsum('ij,ij->i', e13, e12h)
    y3 = np.sqrt(np.maximum(0, np.linalg.norm(e13, axis=1)**2 - x3**2))
    W = np.zeros((len(F), 3, 2))
    W[:, 1, 0] = L12; W[:, 2, 0] = x3; W[:, 2, 1] = y3
    return W, L12, x3, y3


def _cot_weights(V, F, clamp=True):
    p0 = V[F[:, 0]]; p1 = V[F[:, 1]]; p2 = V[F[:, 2]]
    e01 = p1 - p0; e12 = p2 - p1; e20 = p0 - p2
    cross = np.cross(e01, -e20)
    a2 = np.maximum(np.linalg.norm(cross, axis=1), 1e-30)
    c0 = np.einsum('ij,ij->i', e01, -e20) / a2
    c1 = np.einsum('ij,ij->i', -e01, e12) / a2
    c2 = np.einsum('ij,ij->i', -e12, e20) / a2
    cot = np.stack([c0, c1, c2], axis=1)
    if clamp: cot = np.maximum(cot, 0.0)
    return cot


def _compute_J(UV, F, L12, x3, y3):
    u0 = UV[F[:, 0]]; u1 = UV[F[:, 1]]; u2 = UV[F[:, 2]]
    du1 = u1 - u0; du2 = u2 - u0
    L = np.maximum(L12, 1e-15); y = np.maximum(y3, 1e-15)
    J = np.zeros((len(F), 2, 2))
    J[:, :, 0] = du1 / L[:, None]
    J[:, :, 1] = (du2 - du1 * (x3 / L)[:, None]) / y[:, None]
    bad = ~np.isfinite(J).all(axis=(1, 2))
    if bad.any(): J[bad] = np.eye(2)
    return J


def _project_sigma(s1, s2, K_max, S_max, S_min):
    """Closest-point projection: σ₁≤S_max, σ₂≥S_min, σ₁/σ₂≤K_max."""
    s1 = np.clip(s1, S_min, S_max)
    s2 = np.clip(s2, S_min, S_max)
    s2 = np.minimum(s2, s1)
    bad = s1 > K_max * s2
    if bad.any():
        y = (K_max * s1[bad] + s2[bad]) / (K_max * K_max + 1.0)
        y = np.clip(y, S_min, S_max / K_max)
        s1[bad] = K_max * y; s2[bad] = y
    return s1, s2


def _project_J(J, K_max, S_max, S_min):
    U, sig, Vt = np.linalg.svd(J)
    det_uvt = np.linalg.det(U @ Vt)
    flip = det_uvt < 0
    if flip.any():
        U[flip, :, -1] *= -1
        sig[flip, -1] *= -1
    s1p, s2p = _project_sigma(np.abs(sig[:, 0]), np.abs(sig[:, 1]),
                                K_max, S_max, S_min)
    sig_proj = np.stack([s1p, s2p], axis=1)
    L = np.einsum('fij,fj,fjk->fik', U, sig_proj, Vt)
    return L, np.abs(sig)


def bd_polish(V, F, UV_init,
                face_weight=None, valid_mask=None,
                K_max=2.0, S_max=1.5, S_min=None,
                n_iter=200, tol=1e-7,
                line_search=True, max_ls_steps=8,
                iso_growth_margin=1.5,
                verbose=False):
    """Bounded-Distortion ARAP polish.

    Args:
        V (n,3), F (m,3), UV_init (n,2): mesh + начальное UV.
        face_weight (m,): per-face weight (по умолчанию = 1, типично = площади).
        valid_mask (m,): bool — какие грани считать (False = invalid fan-fill,
            не контрибутирует, не подсчитывается в инверсиях/iso bounds).
        K_max: максимальное отношение растяжений σ₁/σ₂.
        S_max, S_min: максимальное и минимальное растяжение.
        line_search: гарантия не плодить новые валидные инверсии.
        iso_growth_margin: множитель допустимого временного роста iso_max
            в одну итерацию (по умолчанию 1.5 — позволяет проекции «двигать»,
            но защищает от резкого blow-up'а).

    Returns:
        UV_polished (n,2), info dict.
    """
    nF, nV = len(F), len(V)
    if S_min is None: S_min = 1.0 / S_max
    assert K_max >= 1.0 and S_min > 0 and S_min <= S_max
    if face_weight is None: face_weight = np.ones(nF)
    if valid_mask is None: valid_mask = np.ones(nF, dtype=bool)
    valid_mask = valid_mask.astype(bool)

    W, L12, x3, y3 = _local_2d_coords(V, F)
    cot = _cot_weights(V, F, clamp=True)

    edges_ij = [(0, 1), (1, 2), (2, 0)]
    edge_cot_idx = {(0, 1): 2, (1, 2): 0, (2, 0): 1}
    x_edges = np.zeros((nF, 3, 2))
    for k, (li, lj) in enumerate(edges_ij):
        x_edges[:, k, :] = W[:, lj, :] - W[:, li, :]
    edge_cot = np.stack([cot[:, edge_cot_idx[e]] for e in edges_ij], axis=1)
    edge_we = face_weight[:, None] * edge_cot
    edge_vi = np.stack([F[:, 0], F[:, 1], F[:, 2]], axis=1)
    edge_vj = np.stack([F[:, 1], F[:, 2], F[:, 0]], axis=1)
    a = edge_vi.ravel(); b_ = edge_vj.ravel(); w_ = edge_we.ravel()
    rows = np.concatenate([a, b_, a, b_])
    cols = np.concatenate([a, b_, b_, a])
    vals = np.concatenate([w_, w_, -w_, -w_])
    Lap = sp.coo_matrix((vals, (rows, cols)), shape=(nV, nV)).tocsc()

    pin_id = int(np.argmin(np.linalg.norm(UV_init - UV_init.mean(0), axis=1)))
    free_ids = np.delete(np.arange(nV), pin_id)
    Lap_free = Lap[free_ids][:, free_ids].tocsc()
    Lap_pin = Lap[free_ids][:, [pin_id]]

    # === R1 (v6.4): защита от сингулярного Lap_free ============================
    # Symptom: на мешах с weakly-connected fan-fill apex'ами (например меш t4 из
    # research-cohort, 39k F + многочисленные cone-singularities) splu бросает
    # `RuntimeError: Factor is exactly singular`. Это происходит когда после
    # classify_inner_loops fan-fill создаёт «острова» с очень малыми cot-весами.
    # Решение: Tikhonov-регуляризация с очень малым ε (≈ 1e-8 от max diagonal).
    # На well-posed мешах не меняет поведение; на degenerate случаях — спасает
    # от crash'а, и затем R2 ниже откатывает к лучшему состоянию.
    # ===========================================================================
    used_regularization = False
    try:
        solver = splu(Lap_free)
    except RuntimeError as e:
        if 'singular' not in str(e).lower():
            raise
        eps_reg = 1e-8 * float(Lap_free.diagonal().max())
        Lap_free_reg = Lap_free + eps_reg * sp.eye(Lap_free.shape[0], format='csc')
        solver = splu(Lap_free_reg)
        used_regularization = True
        if verbose:
            print(f"  [bd_polish] WARNING: Lap_free was singular, "
                  f"using +{eps_reg:.2e}·I regularization (R1)")

    UV = UV_init.copy()
    pin_uv = UV[pin_id:pin_id + 1].copy()

    def _signed_areas(UV_):
        u0, u1, u2 = UV_[F[:, 0]], UV_[F[:, 1]], UV_[F[:, 2]]
        return ((u1[:, 0] - u0[:, 0]) * (u2[:, 1] - u0[:, 1]) -
                (u2[:, 0] - u0[:, 0]) * (u1[:, 1] - u0[:, 1]))

    def _count_inv(UV_):
        return int(((_signed_areas(UV_) < 0) & valid_mask).sum())

    def _iso_max(UV_):
        J = _compute_J(UV_, F, L12, x3, y3)
        s = np.linalg.svd(J, compute_uv=False)
        iso = s[:, 0] / np.maximum(s[:, 1], 1e-12)
        iso_v = np.where(valid_mask, iso, 0.0)
        return float(iso_v.max()), iso

    inv_start = _count_inv(UV)
    iso_start, _ = _iso_max(UV)

    iso_p99_h = []; iso_max_h = []; inv_h = []; converged = False

    # === R2 (v6.4): blow-up guard с откатом к best-iso state ==================
    # Symptom: на меше t9 K=1.7 BD-polish даёт iso 3.38 → 5.10, при K=1.5 → 7.47.
    # Per-iter line_search с iso_growth_margin=1.5 не предотвращает это —
    # каждая итерация формально валидна, но накапливается catastrophic drift.
    # Решение: tracking лучшего iso состояния + hard stop если за последние
    # `iso_history_window` итераций iso только растёт И превысил
    # `iso_start * iso_blowup_factor`. Откат к запомненному best.
    # ===========================================================================
    iso_history_window = 5
    iso_blowup_factor = 1.2   # если iso > start*1.2 и monotonic growth → стоп
    fallback_UV = UV.copy()
    fallback_iso = float(iso_start)
    hard_stop_reason = None
    # ===========================================================================

    for it in range(n_iter):
        J = _compute_J(UV, F, L12, x3, y3)
        L_t, _ = _project_J(J, K_max, S_max, S_min)
        Lx = np.einsum('fij,fkj->fki', L_t, x_edges)
        rhs_contrib = edge_we[:, :, None] * Lx
        b_arr = np.zeros((nV, 2))
        np.add.at(b_arr, edge_vj, rhs_contrib)
        np.add.at(b_arr, edge_vi, -rhs_contrib)
        b_free = b_arr[free_ids] - Lap_pin @ pin_uv
        u_free = solver.solve(b_free)
        UV_proposed = UV.copy()
        UV_proposed[free_ids] = u_free; UV_proposed[pin_id] = pin_uv[0]

        if line_search:
            iso_cur, _ = _iso_max(UV)
            alpha = 1.0; accepted = False
            for ls in range(max_ls_steps + 1):
                UV_try = (1 - alpha) * UV + alpha * UV_proposed
                inv_try = _count_inv(UV_try)
                iso_try, _ = _iso_max(UV_try)
                if (inv_try <= inv_start and
                        iso_try <= iso_cur * iso_growth_margin + 1e-3):
                    UV = UV_try; accepted = True; break
                alpha *= 0.5
            if not accepted:
                converged = False
                if verbose: print(f"  [bd_polish] it={it}: line_search exhausted")
                break

        delta = np.linalg.norm(UV - UV_proposed) / (np.linalg.norm(UV) + 1e-12)

        iso_now, iso_arr = _iso_max(UV)
        iso_p99_h.append(float(np.percentile(np.where(valid_mask, iso_arr, 0.0), 99)))
        iso_max_h.append(iso_now)
        inv_h.append(_count_inv(UV))

        # === R2: tracking + hard stop =========================================
        if iso_now < fallback_iso:
            fallback_UV = UV.copy()
            fallback_iso = iso_now

        if (it >= iso_history_window and
                iso_now > iso_start * iso_blowup_factor):
            recent = iso_max_h[-iso_history_window:]
            monotonic_growth = all(recent[i+1] >= recent[i]
                                       for i in range(len(recent) - 1))
            if monotonic_growth:
                # Откат к best-iso state
                if verbose:
                    print(f"  [bd_polish] HARD STOP at it={it}: iso growing "
                          f"monotonically; falling back (iso "
                          f"{fallback_iso:.2f} <- {iso_now:.2f})")
                UV = fallback_UV
                iso_now, iso_arr = _iso_max(UV)

                iso_max_h[-1] = iso_now
                iso_p99_h[-1] = float(np.percentile(np.where(valid_mask, iso_arr, 0.0), 99))
                inv_h[-1] = _count_inv(UV)
                hard_stop_reason = f"blow_up_at_iter_{it}"
                converged = False
                break


        if verbose and (it < 3 or it % 20 == 0):
            print(f"  [bd_polish] it={it:3d} iso_max={iso_now:.3f} "
                  f"p99={iso_p99_h[-1]:.3f} inv={inv_h[-1]} Δ={delta:.2e}")

        if delta < tol and it > 5:
            converged = True
            if verbose: print(f"  [bd_polish] converged at iter {it}")
            break

    return UV, {
        'n_iter_done': len(iso_max_h),
        'converged': converged,
        'iso_max_start': iso_start,
        'iso_max_final': iso_max_h[-1] if iso_max_h else iso_start,
        'iso_p99_final': iso_p99_h[-1] if iso_p99_h else float('nan'),
        'inv_start': inv_start,
        'inv_final': inv_h[-1] if inv_h else inv_start,
        'iso_max_history': iso_max_h,
        'iso_p99_history': iso_p99_h,
        'inv_history': inv_h,
        'K_max': K_max, 'S_max': S_max, 'S_min': S_min,

        'used_regularization': used_regularization,  # R1: was Lap_free singular?
        'hard_stop_reason': hard_stop_reason,        # R2: did blow-up guard fire?
    }
