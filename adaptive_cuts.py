"""
adaptive_cuts.py — distortion-driven mesh cutting для развёртки.

Идея:
  1. Базовая развёртка → находим грань с худшим iso (внутри меша).
  2. От её вершины Dijkstra'ой к ближайшей границе меша.
  3. Разрезаем меш вдоль пути (T-junction cut): внутренние вершины пути
     дублируются, оригинал и копия принадлежат разным сторонам.
  4. Развёртываем заново — новая граница даёт степень свободы, дисторсия
     перераспределяется в шов.

Это «cone-relief» техника без формальных cone singularities. Цена —
видимый шов на UV (~0.1-0.5мм длиной), выигрыш — iso_max уменьшается
на 30-60% за один cut. Применяется итеративно: 0-3 cuts (max).

Не трогает:
  - перфорации септума (пути через них блокированы)
  - invalid грани (fan-fill артефакты — путь через них блокирован)
  - уже сделанные cuts (path edges из предыдущих итераций блокированы)

=== v6.5 R3 patch: iso-aware overlap rollback ===
Cuts могут увеличивать UV overlap_pairs (когда cut'ы create «свободные»
boundaries которые потом «складываются» в плоскости). Если cut поднял
overlap'ы существенно И не дал iso-выигрыша — откатываем.

Параметры (default values безопасны для production):
  enable_overlap_rollback=True
  overlap_growth_factor=1.2      # +20% allowed
  overlap_min_threshold=20       # noise floor
  iso_improvement_threshold=0.05 # 5% iso reduction = «полезный» cut
"""

import heapq
import numpy as np
from collections import defaultdict


def find_boundary_vertices(F, n_verts=None):
    """Возвращает множество вершин на границе меша (incl perforation
    boundaries — это тоже валидная мишень для cut).

    Args:
        F: (nF, 3) face indices
        n_verts: общее число вершин (для bounds check)

    Returns:
        set[int] — индексы вершин на границе
    """
    edge_count = defaultdict(int)
    for f in F:
        for i in range(3):
            e = tuple(sorted([int(f[i]), int(f[(i+1) % 3])]))
            edge_count[e] += 1
    boundary_verts = set()
    for e, c in edge_count.items():
        if c == 1:
            boundary_verts.add(e[0])
            boundary_verts.add(e[1])
    return boundary_verts


def find_worst_face_vertex(V, F, face_iso, valid_mask, boundary_verts,
                              exclude_verts=None, min_path_len=3):
    """Находит worst face/vertex с УЧЁТОМ глубины пути до границы.

    Идея: face с максимальным iso, но _чтобы у него была вершина_, путь от
    которой до границы ≥ min_path_len (т.е. ≥1 internal vertex для T-cut).

    Returns:
        (vert_id, face_id, iso_value, depth) или (None, None, 0, 0).
    """
    if exclude_verts is None:
        exclude_verts = set()

    iso_v = np.where(valid_mask, face_iso, 0.0)
    order = np.argsort(iso_v)[::-1]

    # adjacency для BFS глубины
    adj = defaultdict(set)
    invalid_faces = set(np.where(~valid_mask)[0].tolist())
    for fi, f in enumerate(F):
        if int(fi) in invalid_faces:
            continue
        for i in range(3):
            a, b = int(f[i]), int(f[(i+1) % 3])
            adj[a].add(b); adj[b].add(a)

    def _depth_to_boundary(start):
        if start in boundary_verts:
            return 0
        visited = {start}
        queue = [(start, 0)]
        head = 0
        while head < len(queue):
            u, d = queue[head]; head += 1
            for v in adj[u]:
                if v in visited:
                    continue
                if v in boundary_verts:
                    return d + 1
                visited.add(v)
                queue.append((v, d + 1))
        return float('inf')

    for fi in order:
        if iso_v[fi] <= 1.0:
            return None, None, 0.0, 0
        verts = [int(v) for v in F[fi]]
        cand = [v for v in verts if v not in exclude_verts and v not in boundary_verts]
        if not cand:
            continue
        depths = [(v, _depth_to_boundary(v)) for v in cand]
        depths.sort(key=lambda x: -x[1])
        v_best, d_best = depths[0]
        if d_best + 1 < min_path_len:
            continue
        return v_best, int(fi), float(iso_v[fi]), d_best

    return None, None, 0.0, 0


def dijkstra_path_to_boundary(V, F, source_v, boundary_verts,
                                  exclude_verts=None,
                                  exclude_edges=None,
                                  exclude_faces=None):
    """Dijkstra от source_v до ближайшей вершины из boundary_verts.

    Args:
        V (nV,3), F (nF,3): меш
        source_v: int — вершина старта (interior)
        boundary_verts: set[int] — целевое множество
        exclude_verts: set[int] — вершины через которые НЕ ходить (исключение
            предыдущих cut-вершин, чтобы новый cut не пересекался со старым)
        exclude_edges: set[tuple(sorted)] — рёбра, через которые НЕ ходить
            (предыдущие cut пути)
        exclude_faces: set[int] — грани, через рёбра которых не ходим
            (например invalid faces — fan-fills)

    Returns:
        list[int] — путь [source_v, ..., boundary_v]; или None если
        граница недостижима.
    """
    if exclude_verts is None: exclude_verts = set()
    if exclude_edges is None: exclude_edges = set()
    if exclude_faces is None: exclude_faces = set()

    edge_faces = defaultdict(list)
    for fi, f in enumerate(F):
        if int(fi) in exclude_faces:
            continue
        for i in range(3):
            e = tuple(sorted([int(f[i]), int(f[(i+1) % 3])]))
            edge_faces[e].append(int(fi))


    adj = defaultdict(list)
    for e, faces in edge_faces.items():
        a, b = e
        if a in exclude_verts or b in exclude_verts:
            continue
        if e in exclude_edges:
            continue
        elen = float(np.linalg.norm(V[a] - V[b]))
        adj[a].append((b, elen))
        adj[b].append((a, elen))

    if source_v not in adj:
        return None

    dist = {source_v: 0.0}
    parent = {}
    pq = [(0.0, source_v)]

    while pq:
        d, u = heapq.heappop(pq)
        if d > dist.get(u, float('inf')) + 1e-12:
            continue
        if u != source_v and u in boundary_verts:
            path = [u]
            while path[-1] != source_v:
                path.append(parent[path[-1]])
            return list(reversed(path))
        for v, elen in adj[u]:
            new_d = d + elen
            if new_d < dist.get(v, float('inf')):
                dist[v] = new_d
                parent[v] = u
                heapq.heappush(pq, (new_d, v))
    return None


def cut_mesh_along_path(V, F, path, valid=None, zone_labels=None,
                          face_areas_3d=None):
    """T-junction cut: разрезаем меш вдоль вершинного пути.

    path[0]   — внутренняя вершина (НЕ дублируется, T-junction)
    path[1..-2] — внутренние вершины пути (дублируются)
    path[-1]  — граничная вершина (НЕ дублируется, конец cut совпадает
                с существующей границей → cut просто продлевает её)

    Каждая дублируемая вершина:
      - 1-ring её граней разбивается на 2 компоненты при удалении path-рёбер.
      - Одна компонента сохраняет оригинал, вторая получает копию.

    Returns:
        V_new, F_new, valid_new, zone_labels_new, face_areas_new, info
    """
    V = np.asarray(V, dtype=np.float64)
    F = np.asarray(F, dtype=np.int64).copy()
    nV, nF = len(V), len(F)

    if valid is None:
        valid = np.ones(nF, dtype=bool)
    else:
        valid = np.asarray(valid, dtype=bool).copy()
    if zone_labels is None:
        zone_labels = np.zeros(nF, dtype=np.int32)
    else:
        zone_labels = np.asarray(zone_labels).copy()
    if face_areas_3d is None:
        p0, p1, p2 = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
        face_areas_3d = 0.5 * np.linalg.norm(np.cross(p1 - p0, p2 - p0), axis=1)
    else:
        face_areas_3d = np.asarray(face_areas_3d).copy()

    if len(path) < 2:
        return V, F, valid, zone_labels, face_areas_3d, {
            'cut_applied': False, 'reason': 'path too short'}

    path_edges = set()
    for i in range(len(path) - 1):
        e = tuple(sorted([int(path[i]), int(path[i+1])]))
        path_edges.add(e)

    # Внутренние вершины пути для дублирования
    to_dup = list(path[1:-1])  # T-junction: path[0] не дуп, path[-1] не дуп

    if not to_dup:
        return V, F, valid, zone_labels, face_areas_3d, {
            'cut_applied': False, 'reason': 'path has no interior vertices'}

    # edge → faces
    edge_faces = defaultdict(list)
    for fi in range(nF):
        for i in range(3):
            e = tuple(sorted([int(F[fi, i]), int(F[fi, (i+1) % 3])]))
            edge_faces[e].append(fi)

    V_list = V.tolist()
    duplicated_count = 0
    cut_components_failed = 0

    for v in to_dup:
        v_faces = []
        for fi in range(nF):
            if v in F[fi]:
                v_faces.append(fi)
        if len(v_faces) < 2:
            continue

        v_face_adj = defaultdict(set)
        for fi in v_faces:
            for i in range(3):
                a, b = int(F[fi, i]), int(F[fi, (i+1) % 3])
                if v != a and v != b:
                    continue
                e = tuple(sorted([a, b]))
                if e in path_edges:
                    continue
                for gi in edge_faces[e]:
                    if gi != fi and gi in v_faces:
                        v_face_adj[fi].add(gi)
                        v_face_adj[gi].add(fi)

        components = []
        unvisited = set(v_faces)
        while unvisited:
            start = next(iter(unvisited))
            comp = set()
            queue = [start]
            while queue:
                f = queue.pop()
                if f in comp:
                    continue
                comp.add(f)
                unvisited.discard(f)
                for g in v_face_adj[f]:
                    if g not in comp:
                        queue.append(g)
            components.append(comp)

        if len(components) != 2:
            # Path не разрезает 1-ring (например, путь идёт «вдоль» границы).
            # Пропускаем эту вершину.
            cut_components_failed += 1
            continue

        # Дублируем v: оригинал → component[0], копия → component[1]
        v_dup = len(V_list)
        V_list.append(V[v].tolist())
        for f in components[1]:
            for i in range(3):
                if F[f, i] == v:
                    F[f, i] = v_dup
                    break
        duplicated_count += 1

    V_new = np.array(V_list, dtype=np.float64)

    return V_new, F, valid, zone_labels, face_areas_3d, {
        'cut_applied': True,
        'path_length': len(path),
        'duplicated_vertices': duplicated_count,
        'cut_components_failed': cut_components_failed,
        'path_3d_length_mm': float(sum(
            np.linalg.norm(V[path[i+1]] - V[path[i]])
            for i in range(len(path) - 1))),
    }


def adaptive_cut_loop(V, F, valid, zone_labels, face_areas_3d,
                          unfold_fn, iso_threshold=2.0, max_cuts=3,
                          verbose=False,
                          enable_overlap_rollback=True,
                          overlap_growth_factor=1.2,
                          overlap_min_threshold=20,
                          iso_improvement_threshold=0.05,
                          ):
    """Итеративно: unfold → ищем worst → cut → unfold → ...

    Останавливается когда iso_max ≤ threshold или max_cuts достигнут.

    Args:
        V, F, valid, zone_labels, face_areas_3d: исходные данные
        unfold_fn: callable (V, F, valid, zone_labels) → result_dict
            должна возвращать dict с ключами 'uv', 'face_iso',
            'V', 'F', 'valid', 'face_areas_3d', 'metrics' и т.д.
        iso_threshold: если iso_max ≤ этого, прекращаем cuts
        max_cuts: максимум cut'ов

        === v6.5 R3 parameters ===
        enable_overlap_rollback: если True (default), после каждого cut'а
            детектим UV overlap-pairs; откатываем cut если ov_after >
            ov_before*growth_factor + min_threshold И iso не улучшился.
        overlap_growth_factor: множитель allowed overlap growth (1.2 = +20%)
        overlap_min_threshold: ниже этого числа overlap'ов не trigger'им
            rollback (защита от шума при малых ov)
        iso_improvement_threshold: если cut снизил iso на ≥ этого rel-amount,
            принимаем cut несмотря на overlap growth (полезный cut)

    Returns:
        result_dict от последнего unfold + extra info про cuts
    """
    if enable_overlap_rollback:
        try:
            import overlap_cuts as _oc
        except ImportError:
            if verbose:
                print("  [cuts] overlap_cuts not available; disabling R3 rollback")
            enable_overlap_rollback = False

    cuts_applied = []
    cuts_rolled_back = []
    cut_path_verts = set()
    cut_path_edges = set()

    V_cur, F_cur = V.copy(), F.copy()
    valid_cur = valid.copy() if valid is not None else None
    zl_cur = zone_labels.copy() if zone_labels is not None else None
    fa_cur = face_areas_3d.copy() if face_areas_3d is not None else None


    result = unfold_fn(V_cur, F_cur, valid_cur, zl_cur)

    for cut_i in range(max_cuts):
        iso_max_now = float(result['metrics']['iso_max'])
        if iso_max_now <= iso_threshold:
            if verbose:
                print(f"  [cuts] iso_max={iso_max_now:.2f} ≤ {iso_threshold} — done")
            break

        # Используем V/F/valid из ТЕКУЩЕГО unfold result (он мог изменить меш —
        # внутренние loops, fan-fill и т.д.). Это «processed» меш.
        V_p = np.asarray(result['V'])
        F_p = np.asarray(result['F'], dtype=np.int64)
        valid_p = np.asarray(result['valid'], dtype=bool)
        face_iso = np.asarray(result['face_iso'])

        boundary_verts = find_boundary_vertices(F_p)
        invalid_faces = set(np.where(~valid_p)[0].tolist())

        v_worst, f_worst, iso_w, depth_w = find_worst_face_vertex(
            V_p, F_p, face_iso, valid_p, boundary_verts,
            exclude_verts=cut_path_verts, min_path_len=3)
        if v_worst is None:
            if verbose:
                print(f"  [cuts] no interior worst face deep enough for cut "
                      f"(iso_max={iso_max_now:.2f} concentrated near existing boundary)")
            break

        path = dijkstra_path_to_boundary(
            V_p, F_p, v_worst, boundary_verts,
            exclude_verts=cut_path_verts - {v_worst},
            exclude_edges=cut_path_edges,
            exclude_faces=invalid_faces)
        if path is None or len(path) < 2:
            if verbose:
                print(f"  [cuts] cut {cut_i+1}: no path from v={v_worst} to boundary")
            break

        if verbose:
            print(f"  [cuts] cut {cut_i+1}: face={f_worst} iso={iso_w:.2f} depth={depth_w} → "
                  f"path of {len(path)} verts, length="
                  f"{sum(np.linalg.norm(V_p[path[i+1]]-V_p[path[i]]) for i in range(len(path)-1)):.2f}мм")



        # === R3: запоминаем pre-cut state ДО изменений =====================
        if enable_overlap_rollback:
            try:
                ov_before_chk = _oc.detect_uv_overlaps(
                    F_p, np.asarray(result['uv']),
                    valid_mask=valid_p,
                    skip_neighbors=True, compute_area=False, max_pairs=2000)
                ov_before_n = int(ov_before_chk['n_pairs'])
            except Exception:
                ov_before_n = 0
            iso_before_cut = float(iso_max_now)

            V_pre = V_cur.copy()
            F_pre = F_cur.copy()
            valid_pre = valid_cur.copy() if valid_cur is not None else None
            zl_pre = zl_cur.copy() if zl_cur is not None else None
            fa_pre = fa_cur.copy() if fa_cur is not None else None
            result_pre = result
            cut_path_verts_pre = set(cut_path_verts)
            cut_path_edges_pre = set(cut_path_edges)


        V_cut, F_cut, valid_cut, zl_cut, fa_cut, cut_info = cut_mesh_along_path(
            V_p, F_p, path,
            valid=valid_p,
            zone_labels=np.asarray(result['zone_labels']),
            face_areas_3d=np.asarray(result['face_areas_3d']))

        if not cut_info['cut_applied']:
            if verbose:
                print(f"  [cuts] cut {cut_i+1}: not applied ({cut_info.get('reason')})")
            break


        cut_path_verts.update(path)
        for i in range(len(path) - 1):
            cut_path_edges.add(tuple(sorted([int(path[i]), int(path[i+1])])))


        V_cur, F_cur, valid_cur, zl_cur, fa_cur = V_cut, F_cut, valid_cut, zl_cut, fa_cut
        result = unfold_fn(V_cur, F_cur, valid_cur, zl_cur)

        # === R3 (v6.5): iso-aware overlap rollback ==========================
        # Принимаем cut если:
        #   (a) overlap-pairs не выросли существенно, ИЛИ
        #   (b) iso улучшился существенно (cut был «полезен» для дисторсии)
        # Иначе откатываем cut к предыдущему состоянию.
        # ===================================================================
        rolled_back = False
        if enable_overlap_rollback:
            try:
                Fp2 = np.asarray(result['F'], dtype=np.int64)
                UVp2 = np.asarray(result['uv'])
                vp2 = np.asarray(result['valid'], dtype=bool)
                ov_after_chk = _oc.detect_uv_overlaps(
                    Fp2, UVp2, valid_mask=vp2,
                    skip_neighbors=True, compute_area=False, max_pairs=2000)
                ov_after_n = int(ov_after_chk['n_pairs'])
            except Exception:
                ov_after_n = 0

            iso_after = float(result['metrics']['iso_max'])
            iso_improvement = ((iso_before_cut - iso_after) /
                                  max(iso_before_cut, 1e-9))


            grew_too_much = (ov_after_n >
                                  ov_before_n * overlap_growth_factor +
                                  overlap_min_threshold)
            no_iso_gain = iso_improvement < iso_improvement_threshold

            if grew_too_much and no_iso_gain:
                if verbose:
                    print(f"  [cuts] cut {cut_i+1} ROLLED BACK: "
                          f"ov {ov_before_n}→{ov_after_n} (factor "
                          f"{ov_after_n/max(ov_before_n,1):.1f}×), "
                          f"iso_improvement={iso_improvement*100:.1f}%")
                cuts_rolled_back.append({
                    'iter': cut_i + 1,
                    'iso_before': iso_before_cut,
                    'iso_after': iso_after,
                    'ov_before': ov_before_n,
                    'ov_after': ov_after_n,
                    'reason': 'overlap_growth_no_iso_gain',
                })

                V_cur = V_pre
                F_cur = F_pre
                valid_cur = valid_pre
                zl_cur = zl_pre
                fa_cur = fa_pre
                result = result_pre
                cut_path_verts = cut_path_verts_pre
                cut_path_edges = cut_path_edges_pre
                rolled_back = True
                # End loop — последующие cuts будут пытаться разрезать ту же
                # cone face через тот же путь, что бесполезно
                break


        if not rolled_back:
            cuts_applied.append({
                'iter': cut_i + 1,
                'face_id_in_processed': f_worst,
                'iso_before': iso_w,
                'path_length': len(path),
                'path_3d_length_mm': cut_info['path_3d_length_mm'],
                'duplicated_vertices': cut_info['duplicated_vertices'],
            })

        if verbose:
            print(f"  [cuts] after cut {cut_i+1}: iso_max="
                  f"{result['metrics']['iso_max']:.2f}, "
                  f"edge_p95={result['metrics']['edge_err_p95']*100:.2f}%, "
                  f"inv={result['metrics']['inverted']}")

    result['adaptive_cuts'] = {
        'n_cuts_applied': len(cuts_applied),
        'n_cuts_rolled_back': len(cuts_rolled_back),
        'cuts': cuts_applied,
        'rollbacks': cuts_rolled_back,
        'iso_max_final': float(result['metrics']['iso_max']),
    }
    return result
