"""
operations/segment.py — выделение внутренней поверхности (слизистой) из
очищенного меша. Потребляет `mesh_clean`, пишет `inner_surface`.

АЛГОРИТМ.
После ручной сегментации в 3D Slicer вход — замкнутый тонкий «карман»
(водонепроницаемый манифолд, volume ≈ 13 см³, толщина прослойки 1-5 мм):
внутренний лист слизистой + внешний лист (захваченная ткань) + ободок
по краю. Нужно отделить внутренний от внешнего.

Два независимых признака разделяют классы:

  1) hit_fwd — доля лучей из конуса ±60° вокруг нормали (K=15), попавших
     в меш на ≤ max_dist. Внутренний лист «смотрит» в замкнутый просвет
     носа — часть лучей под углом цепляет соседние части того же листа
     (вогнутость) или противоположную стенку. Внешний лист смотрит в
     открытое пространство — лучи улетают, hit_fwd ≈ 0. Хорошо работает
     на широкой части слизистой.

  2) n·r_bbox — скалярное произведение нормали фейса с единичным вектором
     от центра bbox к центру фейса, со знаком «-». Для внутреннего листа,
     охватывающего просвет, нормаль направлена К центру bbox (score > 0),
     для внешнего листа, обёрнутого снаружи — ОТ центра (score < 0).
     Хорошо работает на плоских участках и около ободка, где SDF молчит.

Итог:  score = α·hit_fwd + (−n·r̂),  threshold, keep largest component,
fill small holes, morphological opening. На 7 парах ground-truth:
mean F1 = 0.86, IoU = 0.75, P = 0.88, R = 0.86.

"""

NAME = "segment"
INPUTS = ["mesh_clean"]
OUTPUTS = ["inner_surface"]
PARAMS = {
    # Ray-cast
    "n_rays_per_dir":   15,     # лучей в конусе (вперёд)
    "half_angle_deg":   60.0,   # полуугол конуса — широкий, чтоб цеплять вогнутость
    "max_dist":         40.0,   # мм; выше считаем луч «миссом в мир»

    # Комбинирование признаков
    "alpha_hit":        3.0,    # вес hit_fwd в суммарном score
    "threshold":       -0.2,    # порог: score > threshold → inner

    # Сглаживание и topological cleanup
    "smooth_iters":     2,      # лапласово сглаживание на графе фейсов
    "open_iters":       1,      # morphological opening
    "close_small_hole_frac": 0.002,  # доля nF для заливки «дыр»
}


def run(session, params):
    import numpy as np
    import trimesh

    progress = params.get("__progress__") or (lambda m: None)
    p = {**PARAMS, **(params or {})}

    progress("Загрузка очищенного меша…")
    mesh = trimesh.load(session.path("mesh_clean"), force="mesh", process=False)
    if len(mesh.faces) == 0:
        raise RuntimeError("mesh_clean пустой (нет граней)")

    trimesh.repair.fix_winding(mesh)
    try:
        if mesh.is_volume and mesh.volume < 0:
            mesh.invert()
    except Exception:
        pass

    nF = len(mesh.faces)

    # ── 2. Признак 1: hit_fwd (SDF-like, ha=60°) ────────────────
    progress(f"Ray-cast enclosure ({int(p['n_rays_per_dir'])} лучей × "
             f"{nF:,} фейсов)…".replace(",", " "))
    hit_fwd = _hit_fwd(
        mesh,
        n_rays=int(p["n_rays_per_dir"]),
        half_angle_deg=float(p["half_angle_deg"]),
        max_dist=float(p["max_dist"]),
        progress=progress,
    )

    # ── 3. Признак 2: n·r_bbox ──────────────────────────────────
    progress("Расчёт ориентации нормалей относительно центра…")
    nr_score = _nr_bbox_score(mesh)

    # ── 4. Smoothing на графе смежности фейсов ──────────────────
    progress("Сглаживание признаков…")
    iters = int(p["smooth_iters"])
    hit_fwd_s = _smooth_on_faces(mesh, hit_fwd, iters=iters)
    nr_s      = _smooth_on_faces(mesh, nr_score, iters=iters)

    # ── 5. Комбинированный score + threshold ────────────────────
    progress("Классификация фейсов…")
    score = float(p["alpha_hit"]) * hit_fwd_s + nr_s
    raw = score > float(p["threshold"])

    # ── 6. Topological cleanup ──────────────────────────────────
    progress("Очистка маски…")
    mask = _clean_mask(
        mesh, raw,
        close_small_hole_frac=float(p["close_small_hole_frac"]),
        open_iters=int(p["open_iters"]),
    )

    n_sel = int(mask.sum())
    if n_sel == 0:
        raise RuntimeError(
            "Внутренняя поверхность не найдена. Попробуйте понизить "
            "threshold до -0.5 и увеличить alpha_hit до 5.0."
        )

    frac = 100.0 * n_sel / nF

    # ── 7. Export submesh ───────────────────────────────────────
    progress(f"Экспорт ({n_sel:,} фейсов, {frac:.1f}% меша)…"
             .replace(",", " "))
    inner = mesh.submesh([np.where(mask)[0]], append=True)
    out_path = session.reserve("inner_surface", ".obj")
    inner.export(out_path)
    session.register("inner_surface", out_path)



def _cone_directions(n_rays, half_angle_deg, rng):
    """N единичных векторов в конусе ±half_angle вокруг +z."""
    import numpy as np
    cos_max = np.cos(np.deg2rad(half_angle_deg))
    z = rng.uniform(cos_max, 1.0, n_rays)
    phi = rng.uniform(0.0, 2 * np.pi, n_rays)
    r = np.sqrt(np.clip(1.0 - z * z, 0.0, 1.0))
    return np.stack([r * np.cos(phi), r * np.sin(phi), z], axis=1)


def _hit_fwd(mesh, n_rays=15, half_angle_deg=60.0, max_dist=40.0,
             eps=1e-4, batch_faces=4000, progress=None):
    """Для каждого фейса — доля лучей в конусе ±half_angle вокруг нормали,
    попавших в меш на ≤ max_dist мм. Векторизовано, с батчингом."""
    import numpy as np

    fc = mesh.triangles_center.astype(np.float64)
    fn = mesh.face_normals.astype(np.float64)
    nF = len(mesh.faces)
    rng = np.random.default_rng(42)
    dirs_local = _cone_directions(n_rays, half_angle_deg, rng)
    K = n_rays

    hit_fwd = np.zeros(nF, dtype=np.float32)
    rmi = mesh.ray  # embreex если есть, иначе trimesh fallback

    last_report = 0
    for b0 in range(0, nF, batch_faces):
        b1 = min(b0 + batch_faces, nF)
        B = b1 - b0
        bfn = fn[b0:b1]
        bfc = fc[b0:b1]
        # Ортонормальная рамка (u, v, n) на фейс — векторно
        helper = np.tile(np.array([0.0, 0.0, 1.0]), (B, 1))
        helper[np.abs(bfn[:, 2]) > 0.95] = np.array([0.0, 1.0, 0.0])
        u = np.cross(helper, bfn)
        u /= np.linalg.norm(u, axis=1, keepdims=True) + 1e-12
        v = np.cross(bfn, u)
        world_dirs = (
            dirs_local[None, :, 0, None] * u[:, None, :]
            + dirs_local[None, :, 1, None] * v[:, None, :]
            + dirs_local[None, :, 2, None] * bfn[:, None, :]
        )
        origins = np.broadcast_to(
            (bfc + eps * bfn)[:, None, :], (B, K, 3)
        ).reshape(B * K, 3)
        directions = world_dirs.reshape(B * K, 3)

        hits, idx_ray, _ = rmi.intersects_location(
            origins, directions, multiple_hits=False
        )
        if len(idx_ray):
            d = np.linalg.norm(hits - origins[idx_ray], axis=1)
            close = d < max_dist
            if close.any():
                face_idx = b0 + (idx_ray[close] // K)
                cnt = np.zeros(nF, dtype=np.int32)
                np.add.at(cnt, face_idx, 1)
                hit_fwd[:] = np.maximum(hit_fwd, cnt / float(K))

        if progress is not None and nF > 10000:
            pct = int(100 * b1 / nF)
            if pct - last_report >= 25:
                progress(f"Ray-cast: {pct}% ({b1:,}/{nF:,})"
                         .replace(",", " "))
                last_report = pct

    return hit_fwd


def _nr_bbox_score(mesh):
    """Скалярное произведение нормали с единичным вектором от центра bbox
    к центру фейса, со знаком минус. INNER → >0, OUTER → <0.

    Обоснование: внутренний лист охватывает воздушный просвет, который
    находится примерно в центре объёма; значит нормаль смотрит К центру.
    Внешний лист обёрнут вокруг седла с наружной стороны, нормаль смотрит
    ОТ центра.
    """
    import numpy as np
    fc = mesh.triangles_center.astype(np.float64)
    fn = mesh.face_normals.astype(np.float64)
    center = mesh.bounds.mean(axis=0)
    r = fc - center
    rn = np.linalg.norm(r, axis=1, keepdims=True) + 1e-9
    return -np.einsum("ij,ij->i", fn, r / rn).astype(np.float32)


def _smooth_on_faces(mesh, x, iters=1):
    """Лапласово сглаживание скалярного поля на графе смежности фейсов."""
    import numpy as np
    from scipy import sparse
    adj = mesh.face_adjacency
    nF = len(mesh.faces)
    if len(adj) == 0 or iters <= 0:
        return x.astype(np.float64)
    r = np.concatenate([adj[:, 0], adj[:, 1]])
    c = np.concatenate([adj[:, 1], adj[:, 0]])
    A = sparse.csr_matrix((np.ones(len(r)), (r, c)), shape=(nF, nF))
    deg = np.asarray(A.sum(axis=1)).ravel()
    deg[deg == 0] = 1
    L = sparse.diags(1.0 / deg) @ A
    y = x.astype(np.float64).copy()
    for _ in range(iters):
        y = 0.5 * y + 0.5 * (L @ y)
    return y


def _clean_mask(mesh, raw_mask, close_small_hole_frac=0.002, open_iters=1):
    """Topological cleanup: крупнейшая компонента → заливка мелких дыр →
    morphological opening → повторная крупнейшая компонента."""
    import numpy as np
    from scipy import sparse
    from scipy.sparse.csgraph import connected_components

    adj = mesh.face_adjacency
    nF = len(mesh.faces)
    if not raw_mask.any() or len(adj) == 0:
        return raw_mask.copy()

    A = sparse.csr_matrix(
        (np.ones(2 * len(adj)),
         (np.concatenate([adj[:, 0], adj[:, 1]]),
          np.concatenate([adj[:, 1], adj[:, 0]]))),
        shape=(nF, nF),
    )

    # Largest connected component среди selected
    sel_idx = np.where(raw_mask)[0]
    sub = A[sel_idx][:, sel_idx]
    _, lbl = connected_components(sub, directed=False)
    keep = int(np.argmax(np.bincount(lbl)))
    mask = np.zeros(nF, dtype=bool)
    mask[sel_idx[lbl == keep]] = True

    # Заливка мелких «дыр» в выбранной области
    out_idx = np.where(~mask)[0]
    if len(out_idx):
        sub2 = A[out_idx][:, out_idx]
        _, lbl2 = connected_components(sub2, directed=False)
        sizes2 = np.bincount(lbl2)
        hole_thresh = max(10, int(close_small_hole_frac * nF))
        for c_id in range(len(sizes2)):
            if sizes2[c_id] < hole_thresh:
                cand = out_idx[lbl2 == c_id]
                neigh = A[cand].indices
                neigh_out = np.setdiff1d(neigh, cand)
                if len(neigh_out) and mask[neigh_out].mean() > 0.85:
                    mask[cand] = True

    # Morphological opening (erode → dilate на графе фейсов)
    def erode(m):
        a, b = adj[:, 0], adj[:, 1]
        o = np.zeros(nF, dtype=bool)
        o[a[m[a] & ~m[b]]] = True
        o[b[m[b] & ~m[a]]] = True
        return m & ~o

    def dilate(m):
        a, b = adj[:, 0], adj[:, 1]
        add = np.zeros(nF, dtype=bool)
        add[b[m[a] & ~m[b]]] = True
        add[a[m[b] & ~m[a]]] = True
        return m | add

    for _ in range(open_iters):
        mask = dilate(erode(mask))

    # Финальная крупнейшая компонента
    ids = np.where(mask)[0]
    if not len(ids):
        return mask
    sub3 = A[ids][:, ids]
    _, lbl3 = connected_components(sub3, directed=False)
    keep3 = int(np.argmax(np.bincount(lbl3)))
    final = np.zeros(nF, dtype=bool)
    final[ids[lbl3 == keep3]] = True
    return final
