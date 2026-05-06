"""
operations/unfold.py — развёртка слизистой (v5: septum-aware) + опц. BD-bound.

v5 главное отличие от v4:
  - cut_open_inner_loops больше НЕ режет все inner петли по периметру.
    Вместо этого — классификация по zone:
       * septum-перфорация ≥ 2мм → PRESERVE (дырка в UV, врач измеряет)
       * любая < 2мм → fan-fill (безопасно для мелких)
       * не-septum ≥ 2мм → cut-open (артефакт, крупный fan-fill ломает)
  - Нужны zone_labels (per-face) для классификации. Если их нет —
    используем PCA auto-segmentation.
  - В output добавлено preserved_perforations: список loop'ов с vertex
    indices, периметром, %septum_area — для фронта чтобы рисовать
    красную обводку и открывать "измерение дефекта".

v6 добавление: опциональный параметр `bound_iso_max` — после основного
unfold применяется Bounded-Distortion polish (модуль bd_polish), который
ограничивает iso (σ_max/σ_min) каждой грани сверху значением K_max.

Гарантии BD-полировки (line_search=True):
  - НЕ создаёт новые валидные инверсии
  - НЕ позволяет iso_max blow up (защита от выбросов)
  - При сходимости 99%+ валидных граней удовлетворяют σ₁/σ₂ ≤ K_max
  - На сложных топологиях (узкие места вокруг перфораций) 1-2 face'а
    могут остаться чуть выше K_max — это видно в info['bd_polish']

Совместимость: при bound_iso_max=None API идентичен предыдущей версии
(no-op, никаких изменений в поведении).

=== v6.5 R-патчи (включены по умолчанию, безопасные) ===
R1 (bd_polish, singular Lap_free guard): автоматическая Tikhonov-регуляризация
   если bd_polish сталкивается с сингулярным Лапласианом. info['bd_polish']
   ['used_regularization'] = True если применена.
R2 (bd_polish, blow-up guard): откат к best-iso state если iso растёт
   монотонно за 5 последних итераций И превышает start*1.2. info['bd_polish']
   ['hard_stop_reason'] выставляется если сработал.
R3 (adaptive_cuts, iso-aware overlap rollback): если cut поднял UV
   overlap_pairs > 1.2× + 20 И iso не улучшился на ≥5%, cut откатывается.
   info['adaptive_cuts']['n_cuts_rolled_back'] и ['rollbacks'] в результате.
   Параметры в PARAMS['adaptive_cuts_overlap_*'] (default: enabled).

Зоны грузятся из (в порядке приоритета):
  1. params['zone_labels'] — если фронт прислал явно
  2. session['zones']      — артефакт из предыдущего шага «zones»
  3. None                  — v5 fallback'ится в PCA auto-segmentation

Зарегистрируется автоматически через operations/__init__.py (по NAME).
"""

import json
import time
import numpy as np
import trimesh
import nasal_unfold_v5 as nasal_unfold  # drop-in: v5 API-совместим с v4
import bd_polish  # v6: bounded-distortion polish
import adaptive_cuts  # v6.1: distortion-driven mesh cuts
import overlap_cuts  # v6.2: detect global UV overlap (safety reporting)

NAME = "unfold"
INPUTS = []
OUTPUTS = ["unfolded"]
PARAMS = {
    "mode": "single",                            # 'single' | 'charts'
    "arap_iterations": 80,

    # === v6 BD-BOUND (опционально) =================================
    "bound_iso_max": None,                       # K_max — None=без bound
    "bound_S_max":   None,                       # σ_max; None=auto из K_max
    "bound_iter":    200,                        # макс. iter BD-polish
    # ===============================================================

    # === v6.1 ADAPTIVE CUTS (опционально) ==========================
    # Distortion-driven mesh cutting: разрезает меш в местах высокого
    # iso для снижения дисторсии. Цена — 1-3 видимых шва ~0.3-1мм.
    # Применяется ПОСЛЕ unfold+BD, итеративно.
    "adaptive_cuts_max":       0,                # 0=off; 1-3 рекомендуется
    "adaptive_cuts_threshold": 1.8,              # iso_max выше → cut
    # === v6.5 R3: iso-aware overlap rollback (default ON) ==========
    # После каждого cut'а проверяем UV overlap_pairs. Если cut поднял
    # ov существенно И не дал iso-выигрыша — откатываем cut.
    # Безопасный default: ничего не меняет на «полезных» cut'ах,
    # предотвращает только cuts которые ломают UV без улучшения качества.
    "adaptive_cuts_overlap_rollback": True,
    "adaptive_cuts_overlap_growth_factor": 1.2,  # +20% overlap allowed
    "adaptive_cuts_overlap_min_threshold": 20,   # noise floor
    "adaptive_cuts_iso_improvement_threshold": 0.05,  # 5% rel iso reduction
    # ===============================================================

    # === v5 TOPOLOGY ===
    "classify_inner_loops": True,                # v5 core: умная обработка loops
    "septum_zone_label": 0,                      # какой label = septum
    "septum_area_pct_threshold": 50.0,           # ≥50% septum area → перфорация
    "min_preserved_loop_perimeter_mm": 2.0,      # minimum размер perforation
    "max_fan_fill_perimeter_mm": 2.0,            # > этого не-septum → cut

    # === LEGACY v4 (по умолчанию OFF в v5) ===
    "cut_open_inner_loops": False,               # v5: OFF
    "cut_min_loop_perimeter_mm": 15.0,
    "fill_perimeter_threshold_mm": 2.0,          # legacy, только если classify=False

    # Данные (frontend шлёт)
    "V": None,
    "F": None,
    "zone_labels": None,
}


def _load_mesh_from_params(params):
    V = params.get("V"); F = params.get("F")
    if not V or not F:
        return None, None
    V = np.asarray(V, dtype=np.float64).reshape(-1, 3)
    F = np.asarray(F, dtype=np.int64).reshape(-1, 3)
    return V, F


def _load_mesh_from_session(session, progress):
    for key in ("inner_surface", "mesh_clean"):
        if session.has(key):
            progress(f"Загрузка меша из session['{key}']…")
            mesh = trimesh.load(session.path(key), process=False)
            return (np.asarray(mesh.vertices, dtype=np.float64),
                    np.asarray(mesh.faces, dtype=np.int64), key)
    return None, None, None


def _load_zones(session, n_faces_expected, params, progress):
    """Зоны: params → session['zones'] → None (PCA-fallback в v5).

    Источник «session» наполняется на предыдущем шаге пайплайна (tab3
    «zones»), фронт пишет туда `{labels: [...]}`. Если фронт всё-таки
    прислал zone_labels в params текущего вызова — params приоритет.

    Returns:
        (zones_array | None, source_str | None)
    """
    zl = params.get("zone_labels")
    if zl:
        arr = np.asarray(zl, dtype=np.int32)
        if len(arr) == n_faces_expected:
            return arr, "params"
        progress(f"(params.zone_labels имеет {len(arr)} labels, "
                 f"ожидалось {n_faces_expected} — игнорирую)")

    if not session.has("zones"):
        return None, None
    path = session.path("zones")
    try:
        with open(path) as fh:
            data = json.load(fh)
        arr = None
        if isinstance(data, list):
            arr = np.asarray(data, dtype=np.int32)
        elif isinstance(data, dict):
            for key in ("labels", "zone_labels", "zones"):
                if key in data:
                    arr = np.asarray(data[key], dtype=np.int32); break
        if arr is None:
            return None, None
        if len(arr) != n_faces_expected:
            progress(f"(session['zones'] имеет {len(arr)} labels, "
                     f"ожидалось {n_faces_expected} — игнорирую)")
            return None, None
        return arr, "session"
    except Exception as e:
        progress(f"(read session['zones'] failed: {e})")
        return None, None


def _apply_bd_bound(result, K_max, S_max, n_iter, progress):
    """Применяет bd_polish после основного unfold.

    На входе берёт result['V'/'F'/'uv'/'valid'/'face_areas_3d'] и заменяет
    'uv' на полированный + пересчитывает per-face risk arrays и метрики.
    Возвращает (result_updated, bd_info_dict).
    """
    V_p = np.asarray(result['V'], dtype=np.float64)
    F_p = np.asarray(result['F'], dtype=np.int64)
    UV_p = np.asarray(result['uv'], dtype=np.float64)
    fa_p = np.asarray(result['face_areas_3d'])
    valid_p = np.asarray(result['valid'], dtype=bool)
    zl_p = np.asarray(result['zone_labels'])

    if S_max is None:
        # auto: для K_max=2 → S_max=1.5; для K_max=1.5 → S_max=1.25
        S_max = 1.0 + (K_max - 1.0) / 2.0
    S_min = 1.0 / S_max

    fa_n = (fa_p / max(fa_p.mean(), 1e-12)) * valid_p.astype(np.float64)

    progress(f"BD-polish: K={K_max:.2f}, S_max={S_max:.2f}, "
             f"S_min={S_min:.3f}, max_iter={n_iter}…")

    UV_new, info = bd_polish.bd_polish(
        V_p, F_p, UV_p,
        face_weight=fa_n, valid_mask=valid_p,
        K_max=float(K_max), S_max=float(S_max), S_min=float(S_min),
        n_iter=int(n_iter), tol=1e-7,
        line_search=True, verbose=False,
    )

    # Пересчёт метрик и per-face risk arrays с новым UV
    metrics_new, fa_arr_new = nasal_unfold._compute_metrics(
        V_p, F_p, UV_new, valid_p, zl_p, fa_p)

    # inversions считаем только по valid (как в bd_polish)
    sa = ((UV_new[F_p[:, 1], 0] - UV_new[F_p[:, 0], 0]) *
          (UV_new[F_p[:, 2], 1] - UV_new[F_p[:, 0], 1])
          - (UV_new[F_p[:, 2], 0] - UV_new[F_p[:, 0], 0]) *
          (UV_new[F_p[:, 1], 1] - UV_new[F_p[:, 0], 1]))
    metrics_new['inverted'] = int(((sa < 0) & valid_p).sum())
    metrics_new['inverted_total_incl_invalid'] = int((sa < 0).sum())

    result['uv'] = UV_new
    result['metrics'] = metrics_new
    result['face_edge_err_max'] = fa_arr_new['face_edge_err_max']
    result['face_L2'] = fa_arr_new['face_L2']
    result['face_iso'] = fa_arr_new['face_iso']
    result['face_area_ratio'] = fa_arr_new['face_area_ratio']
    result['face_risk_level'] = fa_arr_new['face_risk_level']

    return result, info


def _build_v5_opts(params):
    """Извлекает v5-параметры из params dict (без mode/V/F/zones — они отдельно)."""
    return {
        "arap_iterations": int(params.get("arap_iterations", 80)),
        "classify_inner_loops": bool(params.get("classify_inner_loops", True)),
        "septum_zone_label": int(params.get("septum_zone_label", 0)),
        "septum_area_pct_threshold": float(params.get(
            "septum_area_pct_threshold", 50.0)),
        "min_preserved_loop_perimeter_mm": float(params.get(
            "min_preserved_loop_perimeter_mm", 2.0)),
        "max_fan_fill_perimeter_mm": float(params.get(
            "max_fan_fill_perimeter_mm", 2.0)),
        "cut_open_inner_loops": bool(params.get("cut_open_inner_loops", False)),
        "cut_min_loop_perimeter_mm": float(params.get(
            "cut_min_loop_perimeter_mm", 15.0)),
        "fill_perimeter_threshold_mm": float(params.get(
            "fill_perimeter_threshold_mm", 2.0)),
    }


def _run_unfold_with_bd(V_in, F_in, zones_in, mode, params, progress):
    """v5 unfold + опциональный BD-polish. Возвращает result dict + bd_info.

    Используется как одиночный вызов ИЛИ как unfold_fn для adaptive_cut_loop.
    На входе V_in/F_in/zones_in могут быть «уже-разрезанные» — функция не
    делает предположений, просто прогоняет full pipeline.
    """
    v5_opts = _build_v5_opts(params)
    v5_opts["mode"] = mode

    try:
        result = nasal_unfold.unfold(V_in, F_in, zone_labels=zones_in, opts=v5_opts)
    except ValueError as e:
        raise RuntimeError(f"unfold failed: {e}")

    bd_info_dict = None
    K_max_raw = params.get("bound_iso_max", None)
    if K_max_raw is not None:
        try:
            K_max_f = float(K_max_raw)
            if K_max_f < 1.0:
                progress(f"⚠ bound_iso_max={K_max_f} < 1.0 (некорректно), пропуск")
            else:
                S_max_raw = params.get("bound_S_max", None)
                S_max_f = float(S_max_raw) if S_max_raw is not None else None
                bd_iter = int(params.get("bound_iter", 200))
                result, bd_info = _apply_bd_bound(
                    result, K_max_f, S_max_f, bd_iter, progress)
                bd_info_dict = {
                    'applied': True,
                    'K_max': bd_info['K_max'], 'S_max': bd_info['S_max'],
                    'S_min': bd_info['S_min'],
                    'n_iter_done': bd_info['n_iter_done'],
                    'converged': bd_info['converged'],
                    'iso_max_start': bd_info['iso_max_start'],
                    'iso_max_final': bd_info['iso_max_final'],
                    'iso_p99_final': bd_info['iso_p99_final'],
                    'inv_start': bd_info['inv_start'],
                    'inv_final': bd_info['inv_final'],
                    'used_regularization': bd_info.get('used_regularization', False),
                    'hard_stop_reason': bd_info.get('hard_stop_reason', None),
                }
                if bd_info_dict['used_regularization']:
                    progress("  ⚠ BD-polish: применена регуляризация (R1) — Lap_free был сингулярным")
                if bd_info_dict['hard_stop_reason']:
                    progress(f"  ↩ BD-polish: hard stop (R2) — {bd_info_dict['hard_stop_reason']}, откат к best iso")
        except Exception as e:
            progress(f"⚠ BD-polish failed: {e} — fallback к результату без bound")

    return result, bd_info_dict


def run(session, params):
    progress = params.get("__progress__", lambda _msg: None)
    t_start = time.time()

    # 1. Mesh
    V, F = _load_mesh_from_params(params)
    mesh_src = "params"
    if V is None:
        V, F, mesh_src = _load_mesh_from_session(session, progress)
    if V is None:
        raise RuntimeError("нет меша: frontend не передал V/F в params, "
                           "и в session нет inner_surface/mesh_clean.")
    progress(f"Меш из '{mesh_src}': V={len(V)}, F={len(F)}")

    # 2. Zones (приоритет: params → session['zones'] от tab3 → None=PCA)
    zones, zone_src = _load_zones(session, len(F), params, progress)
    if zones is not None:
        progress(f"Зоны из '{zone_src}': "
                 f"{len(np.unique(zones))} классов, {len(zones)} faces")
    else:
        progress("Зон нет — v5 применит PCA auto-segmentation для классификации перфораций…")

    mode = params.get("mode", "single")

    # 3. Запуск pipeline.
    # Если adaptive_cuts_max > 0 — оборачиваем unfold+BD в loop с iterative cuts.
    # Иначе — обычный одиночный вызов.
    n_cuts_max = int(params.get("adaptive_cuts_max", 0))
    cuts_threshold = float(params.get("adaptive_cuts_threshold", 1.8))

    bd_info_dict = None
    cuts_info = None

    if n_cuts_max > 0:
        progress(f"v5: classify + LSCM + ARAP (mode={mode}) с adaptive cuts "
                 f"(max={n_cuts_max}, threshold={cuts_threshold})…")

        # Замыкаем bd_info через mutable container чтобы достать после loop'а
        _bd_capture = [None]

        def _unfold_fn(V_, F_, valid_, zl_):
            """Callback для adaptive_cut_loop. На каждом шаге вызывает
            unfold+BD на текущем (возможно уже разрезанном) меше.

            valid_ от cut_mesh_along_path содержит маску valid faces для
            предыдущей итерации; v5.unfold заново классифицирует loops,
            так что valid пересчитается с нуля. Передаём zl_ если есть.
            """
            r, bd_i = _run_unfold_with_bd(V_, F_, zl_, mode, params, progress)
            _bd_capture[0] = bd_i
            return r

        # Stub face_areas — не используется кроме первой итерации
        p0_, p1_, p2_ = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
        fa_init = 0.5 * np.linalg.norm(np.cross(p1_ - p0_, p2_ - p0_), axis=1)
        valid_init = np.ones(len(F), dtype=bool)

        result = adaptive_cuts.adaptive_cut_loop(
            V, F, valid_init, zones, fa_init,
            _unfold_fn,
            iso_threshold=cuts_threshold,
            max_cuts=n_cuts_max,
            verbose=False,
            enable_overlap_rollback=bool(params.get(
                "adaptive_cuts_overlap_rollback", True)),
            overlap_growth_factor=float(params.get(
                "adaptive_cuts_overlap_growth_factor", 1.2)),
            overlap_min_threshold=int(params.get(
                "adaptive_cuts_overlap_min_threshold", 20)),
            iso_improvement_threshold=float(params.get(
                "adaptive_cuts_iso_improvement_threshold", 0.05)),
        )
        for c in result.get('adaptive_cuts', {}).get('cuts', []):
            progress(f"  ✂ cut {c['iter']}: iso_before={c['iso_before']:.2f} "
                     f"→ путь {c['path_3d_length_mm']:.2f}мм "
                     f"(+{c['duplicated_vertices']} верш)")
        for rb in result.get('adaptive_cuts', {}).get('rollbacks', []):
            progress(f"  ↩ cut {rb['iter']} ROLLBACK: ov "
                     f"{rb['ov_before']}→{rb['ov_after']}, "
                     f"iso {rb['iso_before']:.2f}→{rb['iso_after']:.2f} "
                     f"({rb['reason']})")
        cuts_info = result.pop('adaptive_cuts', None)
        bd_info_dict = _bd_capture[0]

    else:
        progress(f"v5: classify + LSCM + ARAP (mode={mode})…")
        result, bd_info_dict = _run_unfold_with_bd(V, F, zones, mode, params, progress)

    if bd_info_dict is not None:
        progress(f"BD-polish готов: iso_max "
                 f"{bd_info_dict['iso_max_start']:.2f} → "
                 f"{bd_info_dict['iso_max_final']:.2f} "
                 f"({bd_info_dict['n_iter_done']} iter, "
                 f"converged={bd_info_dict['converged']})")

    # 4. v6.2 Detect global UV overlap (safety / clinical info)
    # Пересечения UV-граней в глобальном смысле — там где врач НЕ должен
    # измерять расстояния, потому что одна UV-точка соответствует двум
    # разным 3D местам. Фронт уже умеет визуализировать (cache.overlapMap),
    # но мы дублируем расчёт на бэке для точности (SAT vs raster) и
    # для audit trail / API consumers.
    progress("Проверка глобального overlap UV…")
    Vp_ = np.asarray(result['V'])
    Fp_ = np.asarray(result['F'], dtype=np.int64)
    UVp_ = np.asarray(result['uv'])
    valid_p_ = np.asarray(result['valid'], dtype=bool)
    fa_p_ = np.asarray(result['face_areas_3d'])

    try:
        ov = overlap_cuts.detect_uv_overlaps(
            Fp_, UVp_, valid_mask=valid_p_, face_areas_3d=fa_p_,
            skip_neighbors=True, compute_area=True, max_pairs=5000)
        u0_, u1_, u2_ = UVp_[Fp_[:, 0]], UVp_[Fp_[:, 1]], UVp_[Fp_[:, 2]]
        sa_ = 0.5 * ((u1_[:, 0] - u0_[:, 0]) * (u2_[:, 1] - u0_[:, 1])
                     - (u2_[:, 0] - u0_[:, 0]) * (u1_[:, 1] - u0_[:, 1]))
        total_uv_area = float(np.abs(sa_).sum())
        ov_pct_uv = (ov['area_uv_total'] / total_uv_area * 100) if total_uv_area > 0 else 0.0

        # Per-face overlap mask (для фронта — заменяет client-side raster)
        overlap_mask = np.zeros(len(Fp_), dtype=np.uint8)
        if ov['face_indices']:
            overlap_mask[ov['face_indices']] = 1

        overlap_info = {
            'detected': True,
            'n_pairs': int(ov['n_pairs']),
            'n_faces_in_overlap': len(ov['face_indices']),
            'area_uv_mm2': float(ov['area_uv_total']),
            'area_3d_mm2': float(ov['area_3d_total']),
            'area_uv_pct': float(ov_pct_uv),
            'truncated': bool(ov['truncated']),
            'face_indices': [int(x) for x in ov['face_indices']],
        }
        if overlap_info['n_pairs'] > 0:
            progress(f"⚠ Overlap: {overlap_info['n_pairs']} пар, "
                     f"{overlap_info['area_3d_mm2']:.1f}мм² "
                     f"({overlap_info['area_uv_pct']:.2f}% UV) — {overlap_info['n_faces_in_overlap']} граней")
        else:
            progress("✓ Overlap: нет пересечений в UV")
    except Exception as e:
        progress(f"⚠ Overlap detection failed: {e}")
        overlap_info = {'detected': False, 'error': str(e)}
        overlap_mask = np.zeros(len(Fp_), dtype=np.uint8)

    # 5. Save
    def _asarr(x):
        return x.tolist() if isinstance(x, np.ndarray) else x

    info = result["info"]
    if bd_info_dict is not None:
        info = {**info, "bd_polish": bd_info_dict}
    if cuts_info is not None:
        info = {**info, "adaptive_cuts": cuts_info}
    info = {**info, "overlap": overlap_info}

    # === v5 key addition: preserved_perforations для фронта =================
    # Каждая перфорация приходит как:
    #   {'loop_idx': int, 'perimeter_mm': float, 'n_vertices': int,
    #    'septum_area_pct': float, 'vertex_indices': list[int],
    #    'dominant_zone': 'septum'}
    # vertex_indices — в processed V/F индексации, фронт использует их
    # чтобы нарисовать boundary красной обводкой и открыть measurement panel.

    output = {
        "uv":                _asarr(result["uv"]),
        "V_processed":       _asarr(result["V"]),
        "F_processed":       _asarr(result["F"]),
        "valid":             _asarr(result["valid"]),
        "zone_labels":       _asarr(result["zone_labels"]),
        "face_areas_3d":     _asarr(result["face_areas_3d"]),


        "face_edge_err_max": _asarr(result.get("face_edge_err_max")),
        "face_L2":           _asarr(result.get("face_L2")),
        "face_iso":          _asarr(result.get("face_iso")),
        "face_area_ratio":   _asarr(result.get("face_area_ratio")),
        "face_risk_level":   _asarr(result.get("face_risk_level")),

        # v6.2: per-face overlap mask (1 = грань в зоне overlap, измерения
        # на ней недостоверны). Фронт может использовать вместо своего
        # client-side computeOverlapMap для большей точности.
        "face_overlap":      overlap_mask.tolist(),


        "preserved_perforations": info.get("preserved_perforations", []),
        "n_preserved_perforations": info.get("n_preserved_perforations", 0),


        "artifact_loops_filled":  info.get("artifact_loops", []),
        "artifact_loops_cut":     info.get("artifact_loops_cut", []),

        "metrics":           result["metrics"],
        "info":              info,
    }
    path = session.reserve("unfolded", ".json")
    with open(path, "w") as fh:
        json.dump(output, fh)
    session.register("unfolded", path)

    m, i = result["metrics"], info
    n_perf = i.get('n_preserved_perforations', 0)
    perf_txt = f"{n_perf} перфорация(и) септума" if n_perf > 0 else "перфораций нет"
    bd_txt = ""
    if bd_info_dict is not None:
        bd_txt = (f", iso_max={m['iso_max']:.2f}≤"
                  f"K{bd_info_dict['K_max']:.1f}")
    cuts_txt = ""
    if cuts_info is not None and cuts_info['n_cuts_applied'] > 0:
        total_mm = sum(c['path_3d_length_mm'] for c in cuts_info['cuts'])
        cuts_txt = f", ✂ {cuts_info['n_cuts_applied']} cuts={total_mm:.1f}мм"
        if cuts_info.get('n_cuts_rolled_back', 0) > 0:
            cuts_txt += f" (↩{cuts_info['n_cuts_rolled_back']} rb)"
    overlap_txt = ""
    if overlap_info.get('detected') and overlap_info['n_pairs'] > 0:
        overlap_txt = (f", ⚠ overlap {overlap_info['area_3d_mm2']:.1f}мм² "
                       f"({overlap_info['area_uv_pct']:.2f}%)")
    progress(
        f"Готово: L² p95={m['L2_p95']:.3f}, inverted={m['inverted']}, "
        f"edge p95={100*m['edge_err_p95']:.1f}%{bd_txt}{cuts_txt}{overlap_txt}, "
        f"{perf_txt}, "
        f"время={time.time()-t_start:.1f}s"
    )
