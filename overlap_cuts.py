"""
overlap_cuts.py — detect global UV overlaps + inject-and-stitch fix.

Проблема: ARAP гарантирует только локальную инъективность (signed area
> 0 per face), но НЕ глобальную. При сложной кривизне отдельные грани
могут наложиться в UV даже без флипов.

Этот модуль:
  1. detect_uv_overlaps — точное обнаружение пар треугольников,
     пересекающихся в UV (через grid-bucketing + SAT-test)
  2. inject_overlap_cuts_loop — итеративно режет меш через overlap-зоны
     и переразворачивает (использует adaptive_cuts)
"""
import numpy as np
from collections import defaultdict


# ──────────────────────────────────────────────────────────────────
# 1. DETECTION
# ──────────────────────────────────────────────────────────────────

def _triangles_intersect_2d(t1, t2, eps=1e-10):
    """SAT для двух треугольников в 2D. True если пересекаются."""
    for tri in (t1, t2):
        for i in range(3):
            edge = tri[(i + 1) % 3] - tri[i]
            normal = np.array([-edge[1], edge[0]])
            n_len = np.linalg.norm(normal)
            if n_len < eps:
                continue
            normal /= n_len
            proj1 = t1 @ normal
            proj2 = t2 @ normal
            if proj1.max() < proj2.min() - eps or proj2.max() < proj1.min() - eps:
                return False
    return True


def _triangle_overlap_area(t1, t2):
    """Sutherland-Hodgman → площадь пересечения двух CCW треугольников."""
    def _ccw(t):
        if (t[1, 0] - t[0, 0]) * (t[2, 1] - t[0, 1]) - \
           (t[2, 0] - t[0, 0]) * (t[1, 1] - t[0, 1]) < 0:
            return t[[0, 2, 1]]
        return t

    t1 = _ccw(np.asarray(t1)); t2 = _ccw(np.asarray(t2))
    output = [tuple(p) for p in t1]
    for i in range(3):
        if not output:
            return 0.0
        c1 = t2[i]; c2 = t2[(i + 1) % 3]; ed = c2 - c1
        new_output = []
        n = len(output)
        for j in range(n):
            p1 = np.array(output[j])
            p2 = np.array(output[(j + 1) % n])
            d1 = ed[0] * (p1[1] - c1[1]) - ed[1] * (p1[0] - c1[0])
            d2 = ed[0] * (p2[1] - c1[1]) - ed[1] * (p2[0] - c1[0])
            inside1 = d1 >= -1e-12; inside2 = d2 >= -1e-12
            if inside1:
                new_output.append(tuple(p1))
                if not inside2:
                    t = d1 / (d1 - d2 + 1e-30)
                    new_output.append(tuple(p1 + t * (p2 - p1)))
            elif inside2:
                t = d1 / (d1 - d2 + 1e-30)
                new_output.append(tuple(p1 + t * (p2 - p1)))
        output = new_output
    if len(output) < 3:
        return 0.0
    poly = np.array(output)
    area = 0.0
    for k in range(len(poly)):
        l = (k + 1) % len(poly)
        area += poly[k, 0] * poly[l, 1] - poly[l, 0] * poly[k, 1]
    return abs(area) / 2.0


def detect_uv_overlaps(F, UV, valid_mask=None, face_areas_3d=None,
                          skip_neighbors=True, compute_area=True,
                          max_pairs=10000):
    """Находит пары граней с overlap в UV.
    
    Args:
        F: (nF, 3); UV: (nV, 2)
        valid_mask: invalid грани игнорируются
        skip_neighbors: грани с общей вершиной не считаются overlap'ом
        max_pairs: hard limit для больших мешей с тяжёлым overlap'ом

    Returns:
        dict: pairs, face_indices, n_pairs, area_uv_total, area_3d_total
    """
    nF = len(F)
    F = np.asarray(F, dtype=np.int64)
    UV = np.asarray(UV, dtype=np.float64)
    if valid_mask is None:
        valid_mask = np.ones(nF, dtype=bool)
    valid_mask = np.asarray(valid_mask, dtype=bool)

    u0 = UV[F[:, 0]]; u1 = UV[F[:, 1]]; u2 = UV[F[:, 2]]
    bbox_min = np.minimum(np.minimum(u0, u1), u2)
    bbox_max = np.maximum(np.maximum(u0, u1), u2)

    diag = np.linalg.norm(bbox_max - bbox_min, axis=1)
    valid_diag = diag[valid_mask]
    cell = float(np.median(valid_diag)) * 2.0 if len(valid_diag) else 1.0
    if cell <= 0:
        cell = 1.0

    grid = defaultdict(list)
    for fi in range(nF):
        if not valid_mask[fi]:
            continue
        x0 = int(np.floor(bbox_min[fi, 0] / cell))
        y0 = int(np.floor(bbox_min[fi, 1] / cell))
        x1 = int(np.floor(bbox_max[fi, 0] / cell))
        y1 = int(np.floor(bbox_max[fi, 1] / cell))
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                grid[(x, y)].append(fi)

    pairs = []
    seen = set()
    overlap_face_set = set()
    area_uv_total = 0.0
    truncated = False

    for cell_faces in grid.values():
        if len(cell_faces) < 2:
            continue
        for i in range(len(cell_faces)):
            fa = cell_faces[i]
            for j in range(i + 1, len(cell_faces)):
                if len(pairs) >= max_pairs:
                    truncated = True
                    break
                fb = cell_faces[j]
                key = (fa, fb) if fa < fb else (fb, fa)
                if key in seen:
                    continue
                seen.add(key)

                if skip_neighbors:
                    if set(F[fa].tolist()) & set(F[fb].tolist()):
                        continue

                if (bbox_max[fa, 0] < bbox_min[fb, 0] or
                        bbox_min[fa, 0] > bbox_max[fb, 0] or
                        bbox_max[fa, 1] < bbox_min[fb, 1] or
                        bbox_min[fa, 1] > bbox_max[fb, 1]):
                    continue

                t1 = UV[F[fa]]; t2 = UV[F[fb]]
                if not _triangles_intersect_2d(t1, t2):
                    continue

                pairs.append(key)
                overlap_face_set.add(fa); overlap_face_set.add(fb)
                if compute_area:
                    area_uv_total += _triangle_overlap_area(t1, t2)
            if truncated: break
        if truncated: break

    overlap_face_list = sorted(overlap_face_set)
    area_3d_total = 0.0
    if face_areas_3d is not None and overlap_face_list:
        area_3d_total = float(np.asarray(face_areas_3d)[overlap_face_list].sum())

    return {
        'pairs': pairs,
        'face_indices': overlap_face_list,
        'n_pairs': len(pairs),
        'area_uv_total': float(area_uv_total),
        'area_3d_total': float(area_3d_total),
        'truncated': truncated,
    }


# ──────────────────────────────────────────────────────────────────
# 2. INJECT-AND-STITCH
# ──────────────────────────────────────────────────────────────────

def find_cut_anchor_for_overlap(V, F, UV, pairs, valid_mask,
                                   exclude_verts=None,
                                   pair_areas=None):
    """Выбирает вершину откуда резать через путь между overlap-гранями.

    Стратегия: 
      1. Берём overlap-пару с максимальной площадью пересечения
      2. Dijkstra по 3D mesh-graph от вершины fa до вершины fb
      3. Берём midpoint этого пути — это «saddle» который вызвал fold
      4. От midpoint найдём путь до boundary в основном цикле

    Args:
        pairs: list[(fa, fb)] — overlap pairs
        pair_areas: optional list of overlap areas (для сортировки)

    Returns: (vertex_id, face_id, info_dict) или (None, None, {})
    """
    if exclude_verts is None:
        exclude_verts = set()
    if not pairs:
        return None, None, {}

    F = np.asarray(F, dtype=np.int64)
    valid_mask = np.asarray(valid_mask, dtype=bool)
    invalid_faces = set(np.where(~valid_mask)[0].tolist())

    # adjacency 3D-mesh (не пускаем через invalid)
    adj = defaultdict(list)
    for fi, f in enumerate(F):
        if int(fi) in invalid_faces:
            continue
        for k in range(3):
            a, b = int(f[k]), int(f[(k + 1) % 3])
            elen = float(np.linalg.norm(V[a] - V[b]))
            adj[a].append((b, elen)); adj[b].append((a, elen))

    # Если есть pair_areas — сортируем pairs по убыванию площади
    if pair_areas is not None and len(pair_areas) == len(pairs):
        order = sorted(range(len(pairs)), key=lambda i: -pair_areas[i])
        pairs_sorted = [pairs[i] for i in order]
    else:
        pairs_sorted = pairs

    import heapq

    # Пробуем pairs от большего к меньшему
    for (fa, fb) in pairs_sorted[:5]:  # top-5 для надёжности
        # Берём «центральные» вершины каждой грани (средние из 3-х)
        # На самом деле любая вершина каждой грани — но возьмём первую
        for vA in F[fa]:
            for vB in F[fb]:
                vA, vB = int(vA), int(vB)
                if vA == vB or vA in exclude_verts or vB in exclude_verts:
                    continue

                # Dijkstra от vA до vB
                dist = {vA: 0.0}; parent = {}
                pq = [(0.0, vA)]
                found = False
                while pq:
                    d, u = heapq.heappop(pq)
                    if d > dist.get(u, float('inf')) + 1e-12:
                        continue
                    if u == vB:
                        found = True; break
                    for v, elen in adj[u]:
                        nd = d + elen
                        if nd < dist.get(v, float('inf')):
                            dist[v] = nd; parent[v] = u
                            heapq.heappush(pq, (nd, v))
                if not found:
                    continue


                path = [vB]
                while path[-1] != vA:
                    path.append(parent[path[-1]])
                path = list(reversed(path))
                if len(path) < 3:
                    continue

                mid_idx = len(path) // 2
                vMid = path[mid_idx]
                # Не возвращаем если midpoint в excluded
                if vMid in exclude_verts:
                    continue
                return vMid, int(fa), {
                    'pair': (int(fa), int(fb)),
                    'vA': vA, 'vB': vB,
                    'path_3d_length': float(sum(
                        np.linalg.norm(V[path[i+1]] - V[path[i]])
                        for i in range(len(path)-1))),
                    'path_n_verts': len(path),
                    'mid_idx': mid_idx,
                }
    return None, None, {}


def inject_overlap_cuts_loop(V, F, valid, zone_labels, face_areas_3d,
                                  unfold_fn,
                                  max_cuts=3,
                                  area_3d_threshold_mm2=0.5,
                                  area_pct_threshold=0.05,
                                  verbose=False):
    """Iterative inject-and-stitch для устранения UV overlap'ов.

    На каждом шаге:
      unfold → uv → detect_uv_overlaps → если overlap > threshold:
        find_cut_anchor → Dijkstra→boundary → cut_mesh → re-unfold
      else: stop

    Args:
        unfold_fn: callable (V_, F_, valid_, zl_) → result_dict с ключами
            'uv', 'V', 'F', 'valid', 'face_areas_3d', 'metrics' и т.д.
        area_3d_threshold_mm2: абсолютный порог суммарной 3D-площади overlap
        area_pct_threshold: или относительный (% от total UV area)
        max_cuts: макс число cut'ов

    Returns:
        result + 'overlap_cuts' info dict.
    """
    import adaptive_cuts as ac

    cut_path_verts = set()
    cut_path_edges = set()
    cuts_applied = []

    V_cur = V.copy()
    F_cur = F.copy()
    valid_cur = valid.copy() if valid is not None else None
    zl_cur = zone_labels.copy() if zone_labels is not None else None

    result = unfold_fn(V_cur, F_cur, valid_cur, zl_cur)
    overlap_history = []

    for cut_i in range(max_cuts + 1):
        Vp = np.asarray(result['V'])
        Fp = np.asarray(result['F'], dtype=np.int64)
        UVp = np.asarray(result['uv'])
        valid_p = np.asarray(result['valid'], dtype=bool)
        fa_p = np.asarray(result['face_areas_3d'])

        ov = detect_uv_overlaps(Fp, UVp, valid_mask=valid_p,
                                    face_areas_3d=fa_p,
                                    skip_neighbors=True, compute_area=True)
        # total UV area for pct threshold
        u0, u1, u2 = UVp[Fp[:, 0]], UVp[Fp[:, 1]], UVp[Fp[:, 2]]
        sa = ((u1[:, 0] - u0[:, 0]) * (u2[:, 1] - u0[:, 1]) -
              (u2[:, 0] - u0[:, 0]) * (u1[:, 1] - u0[:, 1])) * 0.5
        total_uv_area = float(np.abs(sa).sum())
        ov_pct = (ov['area_uv_total'] / total_uv_area * 100.0) if total_uv_area > 0 else 0.0

        ov_summary = {
            'iter': cut_i,
            'n_pairs': ov['n_pairs'],
            'area_uv': ov['area_uv_total'],
            'area_uv_pct': ov_pct,
            'area_3d_mm2': ov['area_3d_total'],
            'n_faces_in_overlap': len(ov['face_indices']),
        }
        overlap_history.append(ov_summary)

        if verbose:
            print(f"  [overlap] iter {cut_i}: pairs={ov['n_pairs']}, "
                  f"area={ov['area_3d_total']:.2f}мм² ({ov_pct:.2f}% UV), "
                  f"faces={len(ov['face_indices'])}")

        # Stop conditions
        below_abs = ov['area_3d_total'] < area_3d_threshold_mm2
        below_pct = ov_pct < area_pct_threshold
        if below_abs or below_pct or ov['n_pairs'] == 0:
            if verbose:
                print(f"  [overlap] под порогом → done")
            break
        if cut_i >= max_cuts:
            if verbose:
                print(f"  [overlap] max_cuts={max_cuts} достигнут, stop")
            break


        pair_areas = []
        for (fa, fb) in ov['pairs']:
            t1 = UVp[Fp[fa]]; t2 = UVp[Fp[fb]]
            pair_areas.append(_triangle_overlap_area(t1, t2))

        v_anchor, f_anchor, info_a = find_cut_anchor_for_overlap(
            Vp, Fp, UVp, ov['pairs'], valid_p,
            exclude_verts=cut_path_verts, pair_areas=pair_areas)
        if v_anchor is None:
            if verbose:
                print(f"  [overlap] не найден разумный midpoint между парами — stop")
            break

        # Boundary verts (для Dijkstra) на текущем processed mesh
        from adaptive_cuts import find_boundary_vertices, dijkstra_path_to_boundary
        boundary_verts = find_boundary_vertices(Fp)
        invalid_faces = set(np.where(~valid_p)[0].tolist())

        path = dijkstra_path_to_boundary(
            Vp, Fp, v_anchor, boundary_verts,
            exclude_verts=cut_path_verts - {v_anchor},
            exclude_edges=cut_path_edges,
            exclude_faces=invalid_faces)
        if path is None or len(path) < 3:
            if verbose:
                print(f"  [overlap] нет пути от midpoint v={v_anchor} к boundary "
                      f"(или слишком короткий)")
            break

        path_3d_mm = float(sum(np.linalg.norm(Vp[path[i+1]] - Vp[path[i]])
                               for i in range(len(path)-1)))
        if verbose:
            print(f"  [overlap] cut {cut_i+1}: midpoint v={v_anchor} "
                  f"(path A→B длиной {info_a.get('path_n_verts', 0)} верш, "
                  f"{info_a.get('path_3d_length', 0):.2f}мм) "
                  f"→ boundary {len(path)} верш, {path_3d_mm:.2f}мм")


        V_cut, F_cut, valid_cut, zl_cut, fa_cut, cut_info = ac.cut_mesh_along_path(
            Vp, Fp, path, valid=valid_p,
            zone_labels=np.asarray(result['zone_labels']),
            face_areas_3d=fa_p)
        if not cut_info['cut_applied']:
            if verbose:
                print(f"  [overlap] cut не применён ({cut_info.get('reason')})")
            break

        cut_path_verts.update(path)
        for i in range(len(path) - 1):
            cut_path_edges.add(tuple(sorted([int(path[i]), int(path[i+1])])))

        cuts_applied.append({
            'iter': cut_i + 1,
            'face_id_in_processed': f_anchor,
            'anchor_vertex': v_anchor,
            'path_length': len(path),
            'path_3d_length_mm': path_3d_mm,
            'duplicated_vertices': cut_info['duplicated_vertices'],
            'overlap_area_3d_before_mm2': ov['area_3d_total'],
            'n_overlap_pairs_before': ov['n_pairs'],
            'pair_path_3d_length_mm': info_a.get('path_3d_length', 0),
        })

        V_cur, F_cur, valid_cur, zl_cur = V_cut, F_cut, valid_cut, zl_cut
        result = unfold_fn(V_cur, F_cur, valid_cur, zl_cur)

    result['overlap_cuts'] = {
        'n_cuts_applied': len(cuts_applied),
        'cuts': cuts_applied,
        'history': overlap_history,
        'final_overlap_area_3d_mm2': overlap_history[-1]['area_3d_mm2'] if overlap_history else 0.0,
        'final_overlap_pct': overlap_history[-1]['area_uv_pct'] if overlap_history else 0.0,
    }
    return result
