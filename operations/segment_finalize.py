"""
operations/segment_finalize.py — пост-обработка маски внутренней поверхности
под развёртку (этап 4).

ЦЕЛЬ: превратить маску выделенных фейсов в топологически корректный
«лист» — одна связная компонента, без мелких дыр, без 1-фейс-«усиков»,
с понятной границей. Это критично для LSCM/ABF и подобных методов
параметризации: они требуют 2-manifold поверхность, желательно
гомеоморфную диску (1 граница, genus=0, Euler χ=1).

ЧТО ДЕЛАЕМ:
  1. Connected components → отбрасываем крошечные (< 2% от крупнейшей).
  2. Hair removal — фейсы с 0 или 1 выделенным соседом
     (изолированные или «хвостики»). Итерируется до 2 проходов.
  3. Fill small holes — невыделенные компоненты, полностью окружённые
     выделением, меньше 1% от площади выделения.
  4. Повтор пп. 1–3.
  5. Final keep-largest-component — гарантия 1 компоненты.

ЧТО НЕ ДЕЛАЕМ (принципиально):
  - НЕ трогаем вершины: никакого smoothing, subdivision, remesh.
  - НЕ меняем форму фейсов: каждый треугольник остаётся как в mesh_clean.
  - НЕ добавляем/не двигаем точки.
Все операции — только на БИНАРНОЙ МАСКЕ над фейсами mesh_clean.
Геометрия, площади, углы, размеры — сохранены побитово.

АНАЛИЗ ТОПОЛОГИИ (только отчёт, без коррекции):
  - boundary_loops — число граничных циклов.
  - Euler characteristic χ = V − E + F.
  - Интерпретация:
      disk           : 1 loop, χ=1       → ready for LSCM
      closed         : 0 loops, χ=2      → нужен разрез
      multi-boundary : n loops, χ=2−n    → genus-0 c дырками, LSCM
                                            работает с лёгкими искажениями
      higher-genus   : χ<2−n             → тоннели, нужен разрез

INPUT:  mesh_clean (полный меш) + inner_surface (текущая маска как submesh)
OUTPUT: inner_surface (очищенный submesh) + finalize_report (JSON)
"""

NAME = "segment_finalize"
INPUTS = ["mesh_clean", "inner_surface"]
OUTPUTS = ["inner_surface", "finalize_report"]
PARAMS = {
    "min_component_face_frac": 0.02,   # компоненты меньше 2% от крупнейшей — мусор
    "hole_fill_face_frac": 0.01,       # дыры меньше 1% от выделения — закрыть
    "hair_max_iters": 2,               # max проходов hair removal (консервативно)
    "cleanup_iters": 2,                # сколько раз прогнать весь цикл очистки
    "min_surround_for_fill": 0.9,      # доля соседей-из-выделения чтоб закрыть дыру
}


def run(session, params):
    import json
    import numpy as np
    import trimesh
    from scipy import sparse
    from scipy.sparse.csgraph import connected_components
    from scipy.spatial import cKDTree
    from collections import defaultdict

    progress = params.get("__progress__") or (lambda m: None)

    progress("Загрузка мешей…")
    mesh = trimesh.load(session.path("mesh_clean"), force="mesh", process=False)
    trimesh.repair.fix_winding(mesh)
    if mesh.volume < 0:
        mesh.invert()
    nF = len(mesh.faces)
    if nF == 0:
        raise RuntimeError("mesh_clean пустой")

    inner = trimesh.load(session.path("inner_surface"),
                         force="mesh", process=False)
    if len(inner.faces) == 0:
        raise RuntimeError("inner_surface пустой — выделите хотя бы несколько фейсов")

    # ── 2. Build mask через centroid-matching ─────────────────
    # inner_surface — это submesh mesh_clean, значит координаты фейсов
    # совпадают bit-exact. KDTree найдёт по центроидам их индексы в mesh.
    progress("Сопоставление маски с исходным мешем…")
    mesh_fc = mesh.triangles_center
    inner_fc = inner.triangles_center
    tree = cKDTree(mesh_fc)
    d, idx = tree.query(inner_fc, k=1)
    tol = max(1e-3, float(np.linalg.norm(mesh.extents)) * 1e-5)
    mask = np.zeros(nF, dtype=bool)
    valid = d < tol
    mask[idx[valid]] = True
    if valid.sum() < len(inner.faces) * 0.9:
        progress(
            f"Внимание: сопоставилось {int(valid.sum())}/{len(inner.faces)}"
            " — возможно, inner_surface и mesh_clean из разных сессий"
        )
    n_initial = int(mask.sum())

    # ── 3. Adjacency matrix (sparse) ──────────────────────────
    adj = mesh.face_adjacency
    if len(adj) == 0:
        raise RuntimeError("mesh_clean не manifold — пересчитайте этап 1")
    A = sparse.csr_matrix(
        (
            np.ones(2 * len(adj)),
            (
                np.concatenate([adj[:, 0], adj[:, 1]]),
                np.concatenate([adj[:, 1], adj[:, 0]]),
            ),
        ),
        shape=(nF, nF),
    )

    stats = {
        "initial_faces": n_initial,
        "removed_small_components": 0,
        "removed_small_components_faces": 0,
        "removed_hair_faces": 0,
        "filled_hole_faces": 0,
        "components_initial": 0,
    }

    sel_idx = np.where(mask)[0]
    if len(sel_idx):
        sub = A[sel_idx][:, sel_idx]
        ncc_init, _ = connected_components(sub, directed=False)
        stats["components_initial"] = int(ncc_init)

    edge_a, edge_b = adj[:, 0], adj[:, 1]

    def count_selected_nbrs(m):
        out = np.zeros(nF, dtype=np.int32)
        edge_both_sel = m[edge_a] & m[edge_b]
        np.add.at(out, edge_a[edge_both_sel], 1)
        np.add.at(out, edge_b[edge_both_sel], 1)
        return out

    # ── 4. Cleanup loop ───────────────────────────────────────
    progress("Очистка маски: компоненты, усики, дыры…")
    for _iteration in range(int(params["cleanup_iters"])):
        # Drop small components
        sel_idx = np.where(mask)[0]
        if not len(sel_idx):
            break
        sub = A[sel_idx][:, sel_idx]
        ncc, lbl = connected_components(sub, directed=False)
        sizes = np.bincount(lbl)
        largest_size = int(sizes.max())
        min_sz = max(2, int(params["min_component_face_frac"] * largest_size))
        if ncc > 1:
            for ci in range(ncc):
                if sizes[ci] < min_sz:
                    drop_faces = sel_idx[lbl == ci]
                    mask[drop_faces] = False
                    stats["removed_small_components"] += 1
                    stats["removed_small_components_faces"] += int(sizes[ci])

        #  Hair removal (iterated)
        for _ in range(int(params["hair_max_iters"])):
            nc = count_selected_nbrs(mask)
            # Фейс выделен, но у него 0 или 1 выделенных соседей:
            #   0 соседей = изолированный треугольник (точно мусор)
            #   1 сосед   = хвостик (не подходит для развёртки)
            hair = mask & (nc <= 1)
            if not hair.any():
                break
            mask[hair] = False
            stats["removed_hair_faces"] += int(hair.sum())

        #  Fill small holes
        out_idx = np.where(~mask)[0]
        if not len(out_idx):
            continue
        sub2 = A[out_idx][:, out_idx]
        _, lbl2 = connected_components(sub2, directed=False)
        sizes2 = np.bincount(lbl2)
        cur_sel = int(mask.sum())
        hole_thresh = max(3, int(params["hole_fill_face_frac"] * cur_sel))
        min_surround = float(params["min_surround_for_fill"])
        for ci in range(len(sizes2)):
            if sizes2[ci] < hole_thresh:
                cand = out_idx[lbl2 == ci]
                neigh = A[cand].indices
                neigh_out = np.setdiff1d(neigh, cand)
                # заполняем только если компонента реально «окружена»
                # выделением (не задевает внешнюю границу меша)
                if len(neigh_out) and mask[neigh_out].mean() >= min_surround:
                    mask[cand] = True
                    stats["filled_hole_faces"] += int(sizes2[ci])

    # ── 5. keep ONLY largest component ─────────────────
    sel_idx = np.where(mask)[0]
    if len(sel_idx):
        sub = A[sel_idx][:, sel_idx]
        ncc, lbl = connected_components(sub, directed=False)
        if ncc > 1:
            sizes = np.bincount(lbl)
            keep = int(np.argmax(sizes))
            out = np.zeros(nF, dtype=bool)
            out[sel_idx[lbl == keep]] = True
            dropped = int((mask & ~out).sum())
            if dropped:
                stats["removed_small_components"] += ncc - 1
                stats["removed_small_components_faces"] += dropped
            mask = out

    n_final = int(mask.sum())
    stats["final_faces"] = n_final
    if n_final == 0:
        raise RuntimeError(
            "После очистки не осталось фейсов — исходное выделение "
            "слишком фрагментировано"
        )

    # ── 6. Build submesh + топологический анализ ──────────────
    progress("Анализ топологии…")
    sel_face_ids = np.where(mask)[0]
    inner_mesh = mesh.submesh([sel_face_ids], append=True)

    # Сравним площадь перед/после — должна отличаться ровно на сумму
    # добавленных/убранных фейсов из mesh (sanity check: геометрия
    # каждого фейса НЕ менялась).
    area_before_faces = mesh.area_faces[np.where(
        np.isin(np.arange(nF), idx[valid]))[0]].sum()  # исходный inner был submesh
    area_after = inner_mesh.area
    stats["area_mm2_final"] = float(area_after)

    V = int(len(inner_mesh.vertices))
    F = int(len(inner_mesh.faces))
    E = int(len(inner_mesh.edges_unique))
    chi = V - E + F

    # Boundary loops: граничное ребро — ребро submesh'а, встречающееся
    # в одном фейсе. Затем строим граф по граничным вершинам и считаем
    # его connected components.
    try:
        e = inner_mesh.edges_sorted.astype(np.int64)
        MAX_V = int(e.max()) + 1
        key = e[:, 0] * MAX_V + e[:, 1]
        _, inv, counts = np.unique(key, return_inverse=True, return_counts=True)
        per_instance = counts[inv]
        bedges = e[per_instance == 1]
        nbrs = defaultdict(set)
        for a, b in bedges:
            nbrs[int(a)].add(int(b))
            nbrs[int(b)].add(int(a))
        visited = set()
        n_loops = 0
        for start in list(nbrs.keys()):
            if start in visited:
                continue
            stack = [start]
            while stack:
                v = stack.pop()
                if v in visited:
                    continue
                visited.add(v)
                for nb in nbrs[v]:
                    if nb not in visited:
                        stack.append(nb)
            n_loops += 1
    except Exception as ex:
        print(f"[segment_finalize] boundary loops analysis failed: {ex}")
        n_loops = -1

    stats["euler_characteristic"] = int(chi)
    stats["boundary_loops"] = int(n_loops)


    warnings_list = []
    disk_ready = False
    topology = "unknown"
    # Невырожденные кейсы:
    if n_loops == 1 and chi == 1:
        topology = "disk"
        disk_ready = True
    elif n_loops == 0:
        topology = "closed"
    elif n_loops >= 1:
        genus = max(0, (2 - chi - n_loops) // 2)
        if genus == 0:
            topology = f"genus0_{n_loops}b"
            if n_loops == 1:
                pass
        else:
            topology = f"genus{genus}_{n_loops}b"
            warnings_list.append(
                f"Тоннель в поверхности (genus={genus}). Для корректной "
                "развёртки нужен разрез вдоль тоннеля — пройдитесь "
                "«Ластиком» поперёк «ручки»."
            )

    stats["topology"] = topology
    stats["disk_ready"] = bool(disk_ready)
    stats["warnings"] = warnings_list

    # ── 7. Export outputs ─────────────────────────────────────
    progress(f"Экспорт ({n_final:,} фейсов)…".replace(",", " "))
    out_path = session.reserve("inner_surface", ".obj")
    inner_mesh.export(out_path)
    session.register("inner_surface", out_path)

    report_path = session.reserve("finalize_report", ".json")
    with open(report_path, "w", encoding="utf-8") as fh:
        json.dump(stats, fh, ensure_ascii=False, indent=2)
    session.register("finalize_report", report_path)

    # Итоговая строка в progress (для SSE-вызовов)
    changed = (stats["removed_small_components_faces"]
               + stats["removed_hair_faces"]
               + stats["filled_hole_faces"])
    if changed == 0:
        summary = f"Готово без правок. {n_final:,} фейсов".replace(",", " ")
    else:
        parts = []
        if stats["removed_small_components_faces"]:
            parts.append(
                f"{stats['removed_small_components_faces']} ф. мелких компонент"
            )
        if stats["removed_hair_faces"]:
            parts.append(f"{stats['removed_hair_faces']} «усиков»")
        if stats["filled_hole_faces"]:
            parts.append(f"{stats['filled_hole_faces']} ф. дыр")
        summary = (
            f"Готово: {n_initial:,}→{n_final:,} фейсов. "
            + "Удалено/закрыто: " + ", ".join(parts)
            + f". Топология: {topology}."
        ).replace(",", " ")
    progress(summary)
