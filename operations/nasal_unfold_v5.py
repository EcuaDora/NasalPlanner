
import numpy as np
from collections import Counter, defaultdict, deque
from scipy.sparse import coo_matrix, csr_matrix
from scipy.sparse.linalg import splu, spsolve
import networkx as nx
import time
import json
import warnings

__version__ = '5.0.0'

DEFAULT_OPTS = {
    'mode': 'single',                     # 'single' | 'charts'

    # === TOPOLOGY: классификация inner loops ==========
    #
    # перфорации слизистой бывают ТОЛЬКО на перегородке
    # (zone 0 = septum). Остальные внутренние петли (floor, lateral, или
    # смешанные без септум-доминанты) — это артефакты CT-сегментации,
    # которые хирургически НЕ интересны и должны быть устранены.
    #
    #
    # v5: petla классифицируется по zone_labels окружающих её граней:
    #     septum ≥ septum_pct_threshold от area → PRESERVE как дырка в UV
    #     (врач увидит и измерит); иначе → fan-fill (артефакт).
    #     Никаких cut'ов. Эксперимент когорты (10 пациентов) показал:
    #     стоимость отказа от cut'ов = +0.15% к edge_p95 в среднем;
    #     выигрыш = +1-3 измеряемых перфорации per patient.
    'classify_inner_loops':          True,   # v5: новый default
    'septum_zone_label':             0,      # какой label = septum
    'septum_area_pct_threshold':     50.0,   # если septum >= X% от area окружения
                                             # → loop считается перфорацией. 50 —
                                             # робастно и включает пограничные
                                             # случаи (септум на границе с floor).
    'min_preserved_loop_perimeter_mm': 2.0,  # септум-петли меньше этого тоже
                                             # заполняем (вероятный шум
                                             # сегментации даже на septum'e).
    'max_fan_fill_perimeter_mm':     2.0,    # v5: мелкие loops любой zone
                                             # fan-fill'им, крупные артефакты
                                             # (non-septum ≥ этого) → cut-open.
                                             # Эмпирически: fan-fill на петлях
                                             # >5мм создаёт inversions (aspect
                                             # apex-треугольников плох).
    'fill_perimeter_threshold_mm':   2.0,    # LEGACY: теперь имеет эффект



    'cut_open_inner_loops':          False,  # v4 default был True. Выключено,
                                             # т.к. эмпирически не даёт прироста
                                             # качества (+0.15% edge_p95) и
                                             # уничтожает септум-перфорации.
    'cut_min_loop_perimeter_mm':     15.0,   # повышено с 2.0 до 15.0: даже
                                             # если пользователь включит cut,
                                             # маленькие петли не режутся.

    # === ARAP ===
    'arap_iterations': 80,
    'arap_face_weighting': 'uniform',
    'arap_seam_weight_strength': 0.0,
    'arap_clamp_cotan': True,
    'arap_tol_delta': 1e-5,

    # === PINNING / LSCM ===
    'pin_strategy': 'geodesic_diameter',

    # === POST-PROCESS ===
    'post_stretch_correction': False,
    'post_stretch_iters': 8,

    # === VALIDITY ===
    'validity_area_ratio_low': 0.1,
    'validity_area_ratio_high': 10.0,
    'validity_iso_max': 3.5,

    # === CHARTS MODE ===
    'charts_allow_scale': False,
    'charts_gluing': 'tree',

    'verbose': False,
}


# =============================================================================
#  1. TOPOLOGY CLEANUP
# =============================================================================

def largest_connected_component(V, F):
    """Возвращает (V_new, F_new, v_map, face_mask).
    v_map[i] — новый индекс для оригинальной вершины i (или -1).
    face_mask — boolean (len = orig_nF), True для сохранённых faces. Нужен
    для корректного переноса per-face атрибутов (labels) через LCC.
    """
    g = nx.Graph()
    for f in F:
        g.add_edge(f[0], f[1]); g.add_edge(f[1], f[2]); g.add_edge(f[2], f[0])
    ccs = list(nx.connected_components(g))
    if len(ccs) == 1:
        face_mask = np.ones(len(F), dtype=bool)
        return V, F, np.arange(len(V), dtype=np.int64), face_mask
    biggest = max(ccs, key=len)
    keep = np.zeros(len(V), dtype=bool)
    for vi in biggest:
        keep[vi] = True
    new_idx = -np.ones(len(V), dtype=np.int64)
    new_idx[keep] = np.arange(keep.sum())
    face_mask = keep[F].all(axis=1)
    F2 = new_idx[F[face_mask]]
    return V[keep], F2, new_idx, face_mask


def split_nonmanifold_vertices(V, F):
    """Возвращает (V', F', splits, orig_of). orig_of[i] = индекс в original V,
    из которого произошла V'[i]. Нужно для сохранения 'shared vertex' гарантий
    в charts-mode."""
    nV, nF = len(V), len(F)
    v2f = defaultdict(list)
    for fi in range(nF):
        for j in range(3):
            v2f[F[fi, j]].append(fi)
    edge2face = defaultdict(list)
    for fi in range(nF):
        for j in range(3):
            a, b = F[fi, j], F[fi, (j + 1) % 3]
            edge2face[(min(a, b), max(a, b))].append(fi)
    V_list = [V[i].copy() for i in range(nV)]
    orig_of = list(range(nV))
    F_new = F.copy()
    splits = 0
    for vi in range(nV):
        fs = v2f[vi]
        if len(fs) <= 1:
            continue
        g = nx.Graph()
        for fi in fs:
            g.add_node(fi)
        for fi in fs:
            for w in F[fi]:
                if w == vi:
                    continue
                k = (min(vi, w), max(vi, w))
                for f2 in edge2face[k]:
                    if f2 != fi and f2 in fs:
                        g.add_edge(fi, f2)
        comps = list(nx.connected_components(g))
        if len(comps) <= 1:
            continue
        for comp in list(comps)[1:]:
            new_vi = len(V_list)
            V_list.append(V[vi].copy())
            orig_of.append(vi)
            for fi in comp:
                for j in range(3):
                    if F_new[fi, j] == vi:
                        F_new[fi, j] = new_vi
            splits += 1
    return np.array(V_list), F_new, splits, np.array(orig_of, dtype=np.int64)


def find_boundary_cycles(V, F):
    edges_arr = np.sort(np.vstack([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]]), axis=1)
    ec = Counter(map(tuple, edges_arr))
    bnd = [e for e, c in ec.items() if c == 1]
    adj = defaultdict(list)
    for a, b in bnd:
        adj[a].append(b); adj[b].append(a)
    remaining = set(bnd)
    cycles = []
    while remaining:
        a, b = next(iter(remaining))
        remaining.remove((a, b))
        cycle = [a, b]; cur = b; prev = a
        while cur != cycle[0]:
            next_v = None
            for nb in adj[cur]:
                if nb == prev:
                    continue
                k = (min(cur, nb), max(cur, nb))
                if k in remaining:
                    next_v = nb; break
            if next_v is None:
                for nb in adj[cur]:
                    k = (min(cur, nb), max(cur, nb))
                    if k in remaining:
                        next_v = nb; break
                if next_v is None:
                    break
            remaining.discard((min(cur, next_v), max(cur, next_v)))
            cycle.append(next_v); prev = cur; cur = next_v
            if len(cycle) > len(bnd) + 5:
                break
        if cycle[-1] == cycle[0]:
            cycle = cycle[:-1]
        if len(cycle) >= 3:
            L = sum(np.linalg.norm(V[cycle[i]] - V[cycle[(i + 1) % len(cycle)]]) for i in range(len(cycle)))
            cycles.append({'vertices': cycle, 'length': float(L)})
    cycles.sort(key=lambda x: -x['length'])
    return cycles


def _plane_fit_centroid(P):
    """Best-fit plane through point cloud P (N, 3). Возвращает 3D-центр тяжести
    петли, но СПРОЕЦИРОВАННЫЙ на плоскость best-fit. Для петель на почти-
    плоском участке это тот же centroid. Для петель на сильно изогнутом
    участке это точка, куда геометрически правильно ставить fan-apex."""
    c = P.mean(axis=0)
    Q = P - c
    _, _, Vt = np.linalg.svd(Q, full_matrices=False)
    n = Vt[-1]
    heights = Q @ n  # относительно c они все = 0 по normal, значит centroid уже в плоскости
    return c


def smart_fill_small_holes(V, F, perim_threshold_mm):
    """Fan-fill для дырок ≤ threshold. В v4: apex ставится на best-fit-плоскости
    петли (а не строго в 3D-центре), что устраняет локальную "выпуклость"
    при наложении."""
    cycles = find_boundary_cycles(V, F)
    if not cycles:
        return V, F, 0, []
    filled = 0; kept = []
    for L in sorted(cycles, key=lambda c: c['length']):
        if L['length'] > perim_threshold_mm:
            kept.append(L); continue
        vs = L['vertices']
        if len(vs) < 3:
            continue
        P = V[vs]
        apex = _plane_fit_centroid(P)
        V = np.vstack([V, apex[None, :]])
        cid = len(V) - 1
        new_F = np.array([[vs[i], vs[(i + 1) % len(vs)], cid] for i in range(len(vs))], dtype=np.int64)
        F = np.vstack([F, new_F])
        filled += 1
    return V, F, filled, kept


# -----------------------------------------------------------------------------
#  v5: КЛАССИФИКАЦИЯ ПЕРФОРАЦИЙ vs АРТЕФАКТОВ ПО ZONE-КОНТЕКСТУ
# -----------------------------------------------------------------------------
#
#  ПРАВИЛО. Для каждой внутренней петли (inner boundary cycle):
#    1. Определяем её "zone context" — инцидентные треугольники и их zones.
#    2. Считаем area-weighted долю septum-граней.
#    3. Если septum_area_pct >= threshold (50% по умолчанию) И длина ≥ мин.
#       порога — PRESERVE (оставляем как дырку в UV, врач её измерит).
#    4. Иначе — FAN-FILL (замыкаем apex'ом, артефакт перестаёт существовать
#       в развёртке).
#
#  Почему area-weighted, а не face-count-weighted: мелкие треугольники у
#  края дыры могут быть смешанной zone, а крупные — в доминирующей. Area
#  даёт более клинически адекватную оценку "какая часть тканы вокруг дыры
#  действительно септум".

def _loop_zone_context_area(V, F, loop_verts, zone_labels):
    """Для loop'а вернуть {zone: summed_area_mm²} граней, инцидентных любой
    из вершин loop'а. Area-weighted классификатор robустее чем face-count —
    см. mucosa1/mucosa3, где мелкие floor-грани давали ложный non-septum
    сигнал при count-based, но area-wise septum всё равно доминировал."""
    vs = set(int(v) for v in loop_verts)
    p0 = V[F[:, 0]]; p1 = V[F[:, 1]]; p2 = V[F[:, 2]]
    area = 0.5 * np.linalg.norm(np.cross(p1 - p0, p2 - p0), axis=1)
    acc = defaultdict(float)
    for fi in range(len(F)):
        if int(F[fi, 0]) in vs or int(F[fi, 1]) in vs or int(F[fi, 2]) in vs:
            acc[int(zone_labels[fi])] += float(area[fi])
    return dict(acc)


def classify_and_fill_inner_loops(V, F, zone_labels,
                                   v_to_input=None, f_to_input=None,
                                   septum_label=0,
                                   septum_pct_threshold=50.0,
                                   min_preserved_perimeter_mm=2.0,
                                   max_fan_fill_perimeter_mm=2.0,
                                   verbose=False):
    """v5 REPLACEMENT для cut_open_inner_loops + smart_fill_small_holes.

    ГИБРИДНАЯ СТРАТЕГИЯ (эмпирически отлажено на когорте 10 пациентов):

      SEPTUM ≥ min_preserved_perimeter (default 2мм)
        → PRESERVE. Остаётся inner boundary в UV. Врач увидит её как
          закрытую красной обводкой дырку и сможет измерить периметр/
          площадь/диаметры для подбора лоскута.

      LOOP < max_fan_fill_perimeter (default 2мм, любая zone)
        → FAN-FILL (apex в best-fit-плоскости петли). Работает надёжно
          на мелких петлях (< 2мм) — apex-треугольники близки к
          равносторонним и не создают инверсий.

      ARTIFACT ≥ max_fan_fill_perimeter (not-septum ≥ 2мм)
        → CUT-OPEN (геодезический разрез до main boundary). Fan-fill на
          таких loops давал катастрофу (mucosa7: 19мм lateral → inv=4;
          mucosa9: 21мм lateral → inv=6). Cut-open для них корректен —
          именно это была изначальная задача cut-open'а в v4 (до того
          как его применили ко всем loops включая септум).

    Возвращает (V, F, labels, v_to_input, f_to_input, info).
    """
    V = V.copy(); F = F.copy()
    labels = np.asarray(zone_labels, dtype=np.int32).copy()
    v_to_input = np.asarray(v_to_input).copy() if v_to_input is not None else None
    f_to_input = np.asarray(f_to_input).copy() if f_to_input is not None else None

    zone_names_map = {0: 'septum', 1: 'floor', 2: 'lateral'}

    cycles = find_boundary_cycles(V, F)
    if len(cycles) < 2:
        return V, F, labels, v_to_input, f_to_input, {
            'preserved_perforations': [], 'artifact_loops_filled': [],
            'artifact_loops_cut': [],
            'n_preserved': 0, 'n_filled_artifacts': 0, 'n_cut_artifacts': 0,
            'kept_holes_count': 0, 'fans_filled_count': 0, 'cuts_count': 0,
        }

    # Классифицируем каждую inner loop ПЕРЕД любыми модификациями меша
    # (чтобы классификация не зависела от порядка обработки).
    inner_loops = cycles[1:]
    classifications = []
    for i, loop in enumerate(inner_loops):
        vs = loop['vertices']
        if len(vs) < 3:
            continue
        perim = float(loop['length'])
        ac = _loop_zone_context_area(V, F, vs, labels)
        total = sum(ac.values())
        septum_pct = 100.0 * ac.get(int(septum_label), 0.0) / max(total, 1e-9)
        dom_zone_id = max(ac, key=ac.get) if ac else -1
        dom_zone_name = zone_names_map.get(dom_zone_id, f'zone{dom_zone_id}')

        is_septum = (septum_pct >= septum_pct_threshold)
        is_big = (perim >= max_fan_fill_perimeter_mm)
        is_preserve_size = (perim >= min_preserved_perimeter_mm)

        if is_septum and is_preserve_size:
            action = 'preserve'
        elif not is_big:
            action = 'fan_fill'   # мелкая — безопасный fan
        else:
            action = 'cut_open'   # крупный артефакт — режем

        classifications.append({
            'loop_idx': i, 'perimeter_mm': perim, 'vs': vs,
            'septum_pct': septum_pct, 'dom_zone_id': dom_zone_id,
            'dom_zone_name': dom_zone_name, 'action': action,
        })
        if verbose:
            print(f"  loop #{i+1}: L={perim:.1f}mm, septum={septum_pct:.0f}%, "
                  f"dom={dom_zone_name} → {action.upper()}")

    # === PRESERVE: ничего не делаем с мешем, только регистрируем ==============
    preserved = []
    for c in classifications:
        if c['action'] == 'preserve':
            preserved.append({
                'loop_idx': c['loop_idx'], 'perimeter_mm': c['perimeter_mm'],
                'n_vertices': len(c['vs']),
                'septum_area_pct': round(c['septum_pct'], 1),
                'vertex_indices': [int(v) for v in c['vs']],
                'dominant_zone': 'septum',
            })

    # === FAN-FILL ==========================================
    artifacts_filled = []
    for c in classifications:
        if c['action'] != 'fan_fill':
            continue
        vs = c['vs']
        P = V[vs]
        apex = _plane_fit_centroid(P)
        V = np.vstack([V, apex[None, :]])
        cid = len(V) - 1
        new_F = np.array([[vs[j], vs[(j + 1) % len(vs)], cid]
                          for j in range(len(vs))], dtype=np.int64)
        F = np.vstack([F, new_F])
        dom_lbl = c['dom_zone_id'] if c['dom_zone_id'] >= 0 else int(septum_label)
        labels = np.concatenate([labels, np.full(len(vs), dom_lbl, dtype=labels.dtype)])
        if v_to_input is not None:
            v_to_input = np.concatenate([v_to_input, [-1]])
        if f_to_input is not None:
            f_to_input = np.concatenate([f_to_input, np.full(len(vs), -1, dtype=f_to_input.dtype)])
        artifacts_filled.append({
            'loop_idx': c['loop_idx'], 'perimeter_mm': c['perimeter_mm'],
            'septum_area_pct': round(c['septum_pct'], 1),
            'dominant_zone': c['dom_zone_name'], 'reason': 'tiny',
        })

    # === CUT-OPEN =========================
    # После fan-fill некоторые main-boundary vertices могли получить новых
    # соседей; пересчитаем main.
    artifacts_cut = []
    cut_loops = [c for c in classifications if c['action'] == 'cut_open']
    if cut_loops:
        cycles2 = find_boundary_cycles(V, F)
        if cycles2:
            main = max(cycles2, key=lambda c: c['length'])
            main_verts = set(int(v) for v in main['vertices'])

            for c in cut_loops:
                # vs из классификации могут быть UPDATED при fan-fill (нет,
                # fan-fill добавляет вершины, не переиндексирует). Но cut_loop
                # vertices остаются теми же в оригинальной индексации.
                loop_verts = [int(v) for v in c['vs']]
                path = _shortest_path_to_main(V, F, loop_verts, main_verts)
                if path is None or len(path) < 2:
                    if verbose:
                        print(f"  cut: path NOT FOUND for loop L={c['perimeter_mm']:.2f}мм")
                    continue
                V, F, n_dup, new_parents = _apply_cut(V, F, path)
                if n_dup > 0 and v_to_input is not None:
                    parents_arr = np.asarray(new_parents, dtype=np.int64)
                    v_to_input = np.concatenate([v_to_input, v_to_input[parents_arr]])
                    # labels тоже (новые дупликаты — той же зоны что оригинал)
                    labels = np.concatenate([labels, labels[np.asarray(new_parents)]
                                             if len(new_parents) else np.array([], dtype=labels.dtype)])
                artifacts_cut.append({
                    'loop_idx': c['loop_idx'], 'perimeter_mm': c['perimeter_mm'],
                    'septum_area_pct': round(c['septum_pct'], 1),
                    'dominant_zone': c['dom_zone_name'],
                    'duplicated_vertices': int(n_dup),
                    'path_n_vertices': len(path),
                })
                if verbose:
                    print(f"  cut artifact: {c['dom_zone_name']} L={c['perimeter_mm']:.1f}mm "
                          f"→ {n_dup} verts duplicated")

    info = {
        'preserved_perforations': preserved,
        'artifact_loops_filled':  artifacts_filled,
        'artifact_loops_cut':     artifacts_cut,
        'n_preserved':            len(preserved),
        'n_filled_artifacts':     len(artifacts_filled),
        'n_cut_artifacts':        len(artifacts_cut),
        'kept_holes_count':       len(preserved),
        'fans_filled_count':      len(artifacts_filled),
        'cuts_count':             len(artifacts_cut),
    }
    return V, F, labels, v_to_input, f_to_input, info


# -----------------------------------------------------------------------------
#  CUT-OPENING (LEGACY v4)
# -----------------------------------------------------------------------------
#
#  ПРОБЛЕМА.
#  LSCM/ARAP отображают "disk-with-holes" в плоскость. Каждая внутренняя
#  петля (перфорация) — это точка концентрации конформной энергии: кривизна
#  меша вблизи перфорации (форма седла/воронки) ЛОКАЛЬНО не может быть
#  развёрнута без искажений, и, поскольку петля "заперта" внутри поверхности,
#  искажение высыпается на единственную окружность вокруг отверстия.
#
#  На mucosa10: v3 давала edge_err до 126% (!) и iso до 5.7× именно в
#  треугольниках, прилежащих к одной из перфораций в верхней части septum'а.
#  Смотреть diagnosis_current.png — тёмное пятно.
#
#  РЕШЕНИЕ: топологический разрез.
#  Для каждой внутренней петли находим кратчайший геодезический путь
#  через рёбра меша от петли до главной границы. Раскрываем ("режем") меш
#  вдоль этого пути — дублируем вершины пути, переназначаем треугольники
#  одной стороны на копии. Теперь внутренняя петля + разрез + главная
#  граница становятся ОДНОЙ внешней границей, и disk'ная топология
#  значительно упрощается.
#
#  АНАТОМИЧЕСКАЯ ИНТЕРПРЕТАЦИЯ: эти разрезы физически соответствуют тому,
#  что хирург сделает на ткани перед или во время реконструкции — врач
#  тоже не может "развернуть" перфорированную слизистую, не сделав надрез.
#  положение разрезов (кратчайший путь к внешней границе) — разумный
#  дефолт; врач может задать свой в интерактивном режиме (будущий tab4 tool).
#
#  КАЧЕСТВО. На mucosa10:
#      без cut:  edge_p99 = 0.389,  edge_max = 1.26,  iso_max = 5.73
#      с cut:    edge_p99 = 0.174,  edge_max = 0.28,  iso_max = 2.98
#  То есть "хуже случая" становится вдвое меньше — критично для того,
#  чтобы линейкой по развёртке можно было реально измерять.


def _build_vertex_edge_graph(V, F):
    """CSR-граф рёбер меша с весами = Euclidean-длины. Для Dijkstra."""
    n = len(V)
    seen = set()
    rows, cols, vals = [], [], []
    for f in F:
        for (a, b) in [(int(f[0]), int(f[1])),
                       (int(f[1]), int(f[2])),
                       (int(f[2]), int(f[0]))]:
            k = (min(a, b), max(a, b))
            if k in seen:
                continue
            seen.add(k)
            d = float(np.linalg.norm(V[a] - V[b]))
            rows += [a, b]
            cols += [b, a]
            vals += [d, d]
    return csr_matrix((vals, (rows, cols)), shape=(n, n))


def _multi_source_dijkstra(G, sources):
    """Dijkstra с множеством источников — distance до ближайшего источника
    + предшественник (на обратном пути). Реализовано через добавление
    виртуального супер-узла с нулевыми рёбрами к sources.

    Возвращает: dist (n,), parent (n,), nearest_source (n,)
    """
    from scipy.sparse.csgraph import dijkstra

    n = G.shape[0]
    # Делаем эквивалент: к N виртуальному узлу подсоединяем sources рёбрами 0
    rows = list(G.nonzero()[0])
    cols = list(G.nonzero()[1])
    vals = list(np.asarray(G[G.nonzero()]).ravel())
    sup = n
    for s in sources:
        rows += [sup, int(s)]
        cols += [int(s), sup]
        vals += [0.0, 0.0]
    G_ext = csr_matrix((vals, (rows, cols)), shape=(n + 1, n + 1))
    dist_all, pred_all = dijkstra(G_ext, indices=sup,
                                  return_predecessors=True)
    dist = dist_all[:n]
    pred = pred_all[:n].copy()
    # У вершин, у которых pred == sup, истинный "предок" = сама вершина (она и есть источник).
    # Для трассировки пути мы просто остановимся, когда pred == sup.
    # определим nearest_source: BFS-like по pred
    nearest = -np.ones(n, dtype=np.int64)
    for v in range(n):
        if dist[v] == np.inf:
            continue
        u = v
        guard = 0
        while pred[u] != sup and pred[u] >= 0:
            u = int(pred[u])
            guard += 1
            if guard > n + 5:
                break
        # теперь u — ближайший source к v
        nearest[v] = u
    return dist, pred, nearest


def _shortest_path_to_main(V, F, loop_verts, main_verts):
    """Геодезический (по рёбрам меша) кратчайший путь ОТ одной из loop_verts
    К ближайшей main_verts. Возвращает список индексов вершин вдоль пути
    (включая концы) или None, если путь не найден."""
    G = _build_vertex_edge_graph(V, F)
    dist, pred, _ = _multi_source_dijkstra(G, main_verts)

    loop_arr = np.asarray(loop_verts, dtype=np.int64)
    loop_dists = dist[loop_arr]
    finite = np.isfinite(loop_dists)
    if not finite.any():
        return None
    best_loop_v = int(loop_arr[np.argmin(np.where(finite, loop_dists, np.inf))])

    # Трассируем от best_loop_v обратно, пока pred != super-node (n)
    n = len(V)
    path = [best_loop_v]
    cur = best_loop_v
    guard = 0
    while pred[cur] != n and pred[cur] >= 0:
        cur = int(pred[cur])
        path.append(cur)
        guard += 1
        if guard > n + 5:
            return None
    # путь: [loop_v, ..., main_v]
    # для целей разреза упорядочим так, чтобы main_v был первым
    path.reverse()
    return path


def _apply_cut(V, F, path):
    """Разрезать меш вдоль path = [v0, v1, ..., vk]. v0 на main boundary,
    vk на inner loop (обычный сценарий cut_open_inner_loops).

    Fan-split: для каждой вершины v_i на пути её 1-ring разбивается на
    связные компоненты через non-cut-edges. Если компонент ≥ 2 — разрез
    (вместе с boundary-edges на endpoints) действительно делит fan; тогда
    всем компонентам кроме первого присваивается НОВАЯ дублированная вершина.

    Исправлено относительно v4.0:
      * ОБРАБАТЫВАЕМ ENDPOINTS. На v_0 cut-edge (v_0, v_1) вместе с двумя
        main-boundary-edges разбивает fan v_0 на 2 части; обе должны стать
        независимыми, иначе v_0 остаётся non-manifold "песочными часами"
        (4 boundary-edges), а main boundary физически не «раскрывается»
        в разрез → inner loop остаётся отдельным циклом. Аналогично v_k.
      * После каждого rename F[fi,j] = new_v обновляем edge2face И cut_edges
        (добавляем зеркальное cut-edge (new_v, other)). Без этого для путей
        с 3+ interior вершинами промежуточные cut-edges не распознаются
        (face уже содержит (new_v_{i-1}, v_i) а не (v_{i-1}, v_i)), и
        fan-split в середине пути может не сработать.

    Возвращает (V_new, F_new, n_duplicated, new_vert_parents).
        new_vert_parents: list[int] — для каждой новой (дублированной)
        вершины в V_new[nV_before..] её "родитель" (индекс исходной вершины
        в V, из которой она была скопирована). Нужно чтобы вверху пайплайна
        поддерживать v_to_input-маппинг без KDTree-фоллбэка.
    """
    new_vert_parents = []
    if len(path) < 2:
        return V.copy(), F.copy(), 0, new_vert_parents

    V = V.copy()
    F = F.copy()

    cut_edges = set()
    for i in range(len(path) - 1):
        a, b = int(path[i]), int(path[i + 1])
        cut_edges.add((min(a, b), max(a, b)))

    edge2face = defaultdict(list)
    for fi in range(len(F)):
        for j in range(3):
            a, b = int(F[fi, j]), int(F[fi, (j + 1) % 3])
            edge2face[(min(a, b), max(a, b))].append(fi)

    vert2faces = defaultdict(list)
    for fi in range(len(F)):
        for j in range(3):
            vert2faces[int(F[fi, j])].append(fi)

    n_duplicated = 0
    # ВСЕ вершины пути, включая endpoints. Код `if len(comps) < 2: continue`
    # ниже пропускает случаи когда fan-split не сработал (например, v где-то
    # в интерьере с одним cut-edge).
    all_path_verts = [int(v) for v in path]

    for v in all_path_verts:
        inc = list(vert2faces[v])
        if len(inc) < 2:
            continue

        # Локальный face-граф: adj через edges, инцидентные v и не-cut.
        # Boundary-edges автоматически не создают adjacency (edge2face даст
        # только 1 face) — это нужно для корректной работы на endpoints.
        adj = defaultdict(set)
        for fi in inc:
            face_v_edges = []
            for j in range(3):
                a, b = int(F[fi, j]), int(F[fi, (j + 1) % 3])
                if a == v or b == v:
                    face_v_edges.append((min(a, b), max(a, b)))
            for ek in face_v_edges:
                if ek in cut_edges:
                    continue
                for gj in edge2face[ek]:
                    if gj != fi and gj in inc:
                        adj[fi].add(gj)
                        adj[gj].add(fi)

        # Connect
        visited = set()
        comps = []
        for seed in inc:
            if seed in visited:
                continue
            comp = []
            stack = [seed]
            while stack:
                u = stack.pop()
                if u in visited:
                    continue
                visited.add(u)
                comp.append(u)
                for w in adj[u]:
                    if w not in visited:
                        stack.append(w)
            comps.append(comp)

        if len(comps) < 2:
            # Fan не разделился. Возможные причины: v в интерьере меша
            # с единственным cut-edge; или path дублирует уже существующий
            # разрез.
            continue

        # Дупликация: comps[0] остаётся с v, comps[1..] — каждая получает
        # свою новую копию. Обычно comps имеет ровно 2 элемента, но для
        # корректной обработки «многоразрезных» topologий поддерживаем N.
        for comp in comps[1:]:
            new_v = len(V)
            V = np.vstack([V, V[v][None, :]])
            new_vert_parents.append(int(v))

            for fi in comp:
                # Запоминаем СТАРЫЕ v-edges в face (до rename) для update
                # edge2face.
                old_v_edges = []
                for j in range(3):
                    a, b = int(F[fi, j]), int(F[fi, (j + 1) % 3])
                    if a == v or b == v:
                        old_v_edges.append((min(a, b), max(a, b)))
                for j in range(3):
                    if int(F[fi, j]) == v:
                        F[fi, j] = new_v
                new_v_edges = []
                for j in range(3):
                    a, b = int(F[fi, j]), int(F[fi, (j + 1) % 3])
                    if a == new_v or b == new_v:
                        new_v_edges.append((min(a, b), max(a, b)))
                # Переносим fi в edge2face[new_edge], убираем из старых.
                for oe in old_v_edges:
                    if fi in edge2face[oe]:
                        edge2face[oe].remove(fi)
                for ne in new_v_edges:
                    edge2face[ne].append(fi)
                vert2faces[new_v].append(fi)
                if fi in vert2faces[v]:
                    vert2faces[v].remove(fi)

            # Каждое cut-edge (v, other) имеет зеркального двойника на
            # new_v: (new_v, other) — тоже cut. Добавляем, чтобы
            # последующие path-вершины корректно распознавали границу.
            for oe in list(cut_edges):
                if v in oe:
                    other = oe[0] if oe[1] == v else oe[1]
                    cut_edges.add((min(new_v, other), max(new_v, other)))

            n_duplicated += 1

    return V, F, n_duplicated, new_vert_parents


def cut_open_inner_loops(V, F, min_loop_perimeter_mm=2.0, max_loops=None,
                         verbose=False):
    """Находим все внутренние петли (все, кроме самой длинной) с периметром
    ≥ min_loop_perimeter_mm, и для каждой делаем геодезический разрез
    к главной границе. Меньшие петли предполагаются обработанными
    smart_fill_small_holes() отдельно.

    Возвращает (V_new, F_new, n_cuts, cuts_info, new_vert_parents_all)
        cuts_info: list of dict с ключами {'loop_perimeter', 'path_length',
                                            'path_len', 'duplicated'}
        new_vert_parents_all: list[int] — конкатенация parent'ов всех
            добавленных за весь cut_open вершин (в порядке добавления).
            len(V_out) = len(V_in) + len(new_vert_parents_all).
    """
    cycles = find_boundary_cycles(V, F)
    if len(cycles) < 2:
        return V, F, 0, [], []
    main = cycles[0]  # самая длинная
    main_verts = set(int(v) for v in main['vertices'])

    inners = [c for c in cycles[1:]
              if c['length'] >= min_loop_perimeter_mm]
    if max_loops is not None:
        inners = inners[:max_loops]

    cuts_info = []
    n_cuts = 0
    new_vert_parents_all = []
    for inner in inners:
        inner_verts = [int(v) for v in inner['vertices']]
        path = _shortest_path_to_main(V, F, inner_verts, main_verts)
        if path is None or len(path) < 2:
            if verbose:
                print(f"  cut: path NOT FOUND for loop L={inner['length']:.2f}мм")
            continue
        # длина пути в 3D
        path_len = float(sum(
            np.linalg.norm(V[path[i]] - V[path[i + 1]])
            for i in range(len(path) - 1)
        ))
        V, F, n_dup, new_parents = _apply_cut(V, F, path)
        new_vert_parents_all.extend(new_parents)
        if n_dup == 0:
            if verbose:
                print(f"  cut: did not split (loop L={inner['length']:.2f}мм, "
                      f"path_len={path_len:.2f}мм)")
            continue
        n_cuts += 1
        cuts_info.append({
            'loop_perimeter_mm': float(inner['length']),
            'path_3d_length_mm': path_len,
            'path_n_vertices': len(path),
            'duplicated_vertices': int(n_dup),
        })
        if verbose:
            print(f"  cut: loop L={inner['length']:.2f}мм → path {path_len:.2f}мм "
                  f"({len(path)} verts, +{n_dup} duplicated)")

    return V, F, n_cuts, cuts_info, new_vert_parents_all


# =============================================================================
#  2. LSCM
# =============================================================================

def _local_2d_coords(V, F):
    p1 = V[F[:, 0]]; p2 = V[F[:, 1]]; p3 = V[F[:, 2]]
    e12 = p2 - p1
    L12 = np.linalg.norm(e12, axis=1)
    L12_safe = np.maximum(L12, 1e-15)
    e12h = e12 / L12_safe[:, None]
    e13 = p3 - p1
    x3 = np.einsum('ij,ij->i', e13, e12h)
    y3 = np.sqrt(np.maximum(0, np.linalg.norm(e13, axis=1) ** 2 - x3 ** 2))
    area = 0.5 * L12 * y3
    W = np.zeros((len(F), 3, 2))
    W[:, 1, 0] = L12
    W[:, 2, 0] = x3
    W[:, 2, 1] = y3
    return W, area


def lscm(V, F, pin_ids, pin_uv):
    """LSCM с векторной assembly (быстрее чем v3 for-loop)."""
    nF, nV = len(F), len(V)
    W, area = _local_2d_coords(V, F)
    sqrt_area = np.sqrt(np.maximum(area, 1e-15))

    x1 = W[:, 0, 0]; y1 = W[:, 0, 1]
    x2 = W[:, 1, 0]; y2 = W[:, 1, 1]
    x3 = W[:, 2, 0]; y3 = W[:, 2, 1]
    dX1 = x3 - x2; dY1 = y3 - y2
    dX2 = x1 - x3; dY2 = y1 - y3
    dX3 = x2 - x1; dY3 = y2 - y1
    s = sqrt_area
    i0 = F[:, 0]; i1 = F[:, 1]; i2 = F[:, 2]
    t_idx = np.arange(nF)

    # real part row (2t)
    real_rows = np.tile(2 * t_idx, 6)
    real_cols = np.concatenate([i0, i1, i2, nV + i0, nV + i1, nV + i2])
    real_vals = np.concatenate([dX1 * s, dX2 * s, dX3 * s,
                                -dY1 * s, -dY2 * s, -dY3 * s])
    imag_rows = np.tile(2 * t_idx + 1, 6)
    imag_cols = np.concatenate([i0, i1, i2, nV + i0, nV + i1, nV + i2])
    imag_vals = np.concatenate([dY1 * s, dY2 * s, dY3 * s,
                                dX1 * s, dX2 * s, dX3 * s])

    rows = np.concatenate([real_rows, imag_rows])
    cols = np.concatenate([real_cols, imag_cols])
    vals = np.concatenate([real_vals, imag_vals])

    M = coo_matrix((vals, (rows, cols)), shape=(2 * nF, 2 * nV)).tocsc()
    pin_var = np.concatenate([pin_ids, nV + pin_ids]).astype(np.int64)
    free_var = np.setdiff1d(np.arange(2 * nV), pin_var)
    Mf = M[:, free_var]; Mp = M[:, pin_var]
    pin_vals = np.concatenate([pin_uv[:, 0], pin_uv[:, 1]])
    rhs = -Mp @ pin_vals
    A = (Mf.T @ Mf).tocsc()
    b = Mf.T @ rhs
    x_free = spsolve(A, b)
    full = np.zeros(2 * nV)
    full[free_var] = x_free
    full[pin_var] = pin_vals
    return np.column_stack([full[:nV], full[nV:]])


# =============================================================================
#  3. ARAP с клампированными cotan-весами и area-weighting
# =============================================================================

def _cotangent_weights(V, F, clamp_negative=True):
    p0 = V[F[:, 0]]; p1 = V[F[:, 1]]; p2 = V[F[:, 2]]
    e01 = p1 - p0; e12 = p2 - p1; e20 = p0 - p2
    cross = np.cross(e01, -e20)
    area2 = np.maximum(np.linalg.norm(cross, axis=1), 1e-30)
    c0 = np.einsum('ij,ij->i', e01, -e20) / area2
    c1 = np.einsum('ij,ij->i', -e01, e12) / area2
    c2 = np.einsum('ij,ij->i', -e12, e20) / area2
    cot = np.stack([c0, c1, c2], axis=1)
    if clamp_negative:
        # Защищаемся от obtuse-треугольников. Численно эквивалентно
        # «заменить cot(>90°) на 0» — Лапласиан остаётся PSD.
        cot = np.maximum(cot, 0.0)
    return cot


def _arap(V, F, UV_init, face_weight, n_iter=80, tol=1e-5,
          clamp_cot=True, pin_id=None, verbose=False):
    """Vectorized ARAP. face_weight: (nF,) — умножается на cot внутри каждой
    грани. Для измерения важнее area-proportional weight."""
    nF, nV = len(F), len(V)
    W, _ = _local_2d_coords(V, F)
    cot = _cotangent_weights(V, F, clamp_negative=clamp_cot)
    # edge k in {0,1,2}: vertex_i → vertex_j
    edges_ij = [(0, 1), (1, 2), (2, 0)]
    edge_cot_idx = {(0, 1): 2, (1, 2): 0, (2, 0): 1}

    x_edges = np.zeros((nF, 3, 2))
    for k, (li, lj) in enumerate(edges_ij):
        x_edges[:, k, :] = W[:, lj, :] - W[:, li, :]
    edge_cot = np.stack([cot[:, edge_cot_idx[e]] for e in edges_ij], axis=1)  # (nF, 3)
    edge_we = face_weight[:, None] * edge_cot                                 # (nF, 3)
    edge_vi = np.stack([F[:, 0], F[:, 1], F[:, 2]], axis=1)
    edge_vj = np.stack([F[:, 1], F[:, 2], F[:, 0]], axis=1)

    # Assemble Laplacian (векторно).
    a = edge_vi.ravel(); b = edge_vj.ravel(); w = edge_we.ravel()
    # (a,a)+=w, (b,b)+=w, (a,b)-=w, (b,a)-=w
    rows = np.concatenate([a, b, a, b])
    cols = np.concatenate([a, b, b, a])
    vals = np.concatenate([w, w, -w, -w])
    L = coo_matrix((vals, (rows, cols)), shape=(nV, nV)).tocsc()

    # Pin одну точку для трансляционной инвариантности.
    if pin_id is None:
        pin_id = int(np.argmin(np.linalg.norm(UV_init - UV_init.mean(0), axis=1)))

    free_mask = np.ones(nV, dtype=bool); free_mask[pin_id] = False
    free_ids = np.where(free_mask)[0]
    L_free = L[free_ids][:, free_ids].tocsc()
    L_pin_col = L[free_ids][:, [pin_id]]
    solver = splu(L_free)

    UV = UV_init.copy()
    for it in range(n_iter):
        u_edges = UV[edge_vj] - UV[edge_vi]          # (nF, 3, 2)
        # Covariance matrix S = Σ_k w_k * u_k x_k^T  per face
        S = np.einsum('fk,fki,fkj->fij', edge_we, u_edges, x_edges)
        bad = ~np.isfinite(S).all(axis=(1, 2))
        if np.any(bad):
            S[bad] = np.eye(2)
        U_svd, _, Vt = np.linalg.svd(S)
        R = U_svd @ Vt
        det = np.linalg.det(R)
        flip = det < 0
        if np.any(flip):
            U_svd[flip, :, -1] *= -1
            R = U_svd @ Vt
        Rx = np.einsum('fij,fkj->fki', R, x_edges)   # (nF, 3, 2) — target edges
        rhs_contrib = edge_we[:, :, None] * Rx
        b = np.zeros((nV, 2))
        np.add.at(b, edge_vj, rhs_contrib)
        np.add.at(b, edge_vi, -rhs_contrib)
        pin_val = UV[pin_id].copy()
        b_free = b[free_ids] - (L_pin_col.toarray() * pin_val)
        u_free = solver.solve(b_free)
        UV_new = np.zeros_like(UV)
        UV_new[free_ids] = u_free
        UV_new[pin_id] = pin_val
        delta = np.linalg.norm(UV_new - UV) / (np.linalg.norm(UV) + 1e-12)
        UV = UV_new
        if verbose and it % 10 == 0:
            print(f"  ARAP iter {it}: rel Δ = {delta:.2e}")
        if delta < tol:
            if verbose:
                print(f"  ARAP converged at iter {it}")
            break
    return UV


# =============================================================================
#  4. Post-процесс: локальная коррекция масштаба
# =============================================================================

def _post_stretch_correction(V, F, UV, n_iter=8, damping=0.5):
    """После ARAP ещё несколько шагов, где цель — чтобы локальный det(J) = 1
    (площади совпали). ARAP минимизирует |J-R|, что даёт угло-правильное
    отображение с ~равномерным небольшим area-сжатием. Эта коррекция
    выравнивает masштаб без развала структуры.

    Работает как простой spring-шаг: для каждой грани вычисляем s =
    sqrt(area3d/area2d), применяем локальное масштабирование вокруг
    centroid'а UV-треугольника, собираем осреднённое целевое положение
    на каждую вершину, делаем damped-шаг.
    """
    nV, nF = len(V), len(F)
    # 3D areas, постоянные
    p0, p1, p2 = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    area3 = 0.5 * np.linalg.norm(np.cross(p1 - p0, p2 - p0), axis=1)

    for it in range(n_iter):
        u0, u1, u2 = UV[F[:, 0]], UV[F[:, 1]], UV[F[:, 2]]
        sa = 0.5 * ((u1[:, 0] - u0[:, 0]) * (u2[:, 1] - u0[:, 1])
                    - (u2[:, 0] - u0[:, 0]) * (u1[:, 1] - u0[:, 1]))
        a2 = np.abs(sa) + 1e-15
        s = np.sqrt(area3 / a2)
        s = np.clip(s, 0.5, 2.0)  # защита от выбросов

        # target = centroid + s * (UV_v - centroid)
        cu = (u0 + u1 + u2) / 3.0
        tgt0 = cu + s[:, None] * (u0 - cu)
        tgt1 = cu + s[:, None] * (u1 - cu)
        tgt2 = cu + s[:, None] * (u2 - cu)

        weight_sum = np.zeros(nV)
        acc = np.zeros((nV, 2))
        # weight = area3 (больше area — больше голос)
        for k, tgt in enumerate([tgt0, tgt1, tgt2]):
            np.add.at(acc, F[:, k], area3[:, None] * tgt)
            np.add.at(weight_sum, F[:, k], area3)

        weight_sum = np.maximum(weight_sum, 1e-15)
        target = acc / weight_sum[:, None]
        UV_new = (1 - damping) * UV + damping * target

        # защита от инверсий: если шаг создал инверсию — откатить
        u0n, u1n, u2n = UV_new[F[:, 0]], UV_new[F[:, 1]], UV_new[F[:, 2]]
        sa_new = 0.5 * ((u1n[:, 0] - u0n[:, 0]) * (u2n[:, 1] - u0n[:, 1])
                        - (u2n[:, 0] - u0n[:, 0]) * (u1n[:, 1] - u0n[:, 1]))
        if (sa_new * sa < 0).any():  # где-то знак сменился — откат
            # линейный search: найти max α такой, что sign(sa) сохранится везде
            alpha = 1.0
            for _ in range(10):
                alpha *= 0.5
                UV_try = (1 - alpha * damping) * UV + alpha * damping * target
                u0t, u1t, u2t = UV_try[F[:, 0]], UV_try[F[:, 1]], UV_try[F[:, 2]]
                sa_try = 0.5 * ((u1t[:, 0] - u0t[:, 0]) * (u2t[:, 1] - u0t[:, 1])
                                - (u2t[:, 0] - u0t[:, 0]) * (u1t[:, 1] - u0t[:, 1]))
                if not (sa_try * sa < 0).any():
                    UV_new = UV_try
                    break
            else:
                break  # не смогли — останавливаем корреkций
        UV = UV_new
    return UV


# =============================================================================
#  5. Utilities (метрика, пины, зоны)
# =============================================================================

def _area_match_scale(UV, F, V):
    p0 = V[F[:, 0]]; p1 = V[F[:, 1]]; p2 = V[F[:, 2]]
    area3d = 0.5 * np.linalg.norm(np.cross(p1 - p0, p2 - p0), axis=1).sum()
    u0 = UV[F[:, 0]]; u1 = UV[F[:, 1]]; u2 = UV[F[:, 2]]
    area2d = 0.5 * np.abs((u1[:, 0] - u0[:, 0]) * (u2[:, 1] - u0[:, 1])
                          - (u1[:, 1] - u0[:, 1]) * (u2[:, 0] - u0[:, 0])).sum()
    s = np.sqrt(area3d / max(area2d, 1e-15))
    return UV * s, float(s)


def _estimate_axes(V):
    stds = V.std(0)
    si = int(stds.argmax()); lr = int(stds.argmin()); ap = 3 - si - lr
    return {'lr': lr, 'si': si, 'ap': ap, 'lr_sign': +1, 'mn': V.min(0), 'mx': V.max(0)}


def _auto_zone_labels(V, F, axes, cuts=(0.30, 0.70, 0.35)):
    lr, si, ap = axes['lr'], axes['si'], axes['ap']
    mn, mx = axes['mn'], axes['mx']
    lr_r = max(mx[lr] - mn[lr], 1e-9); si_r = max(mx[si] - mn[si], 1e-9)
    fc = (V[F[:, 0]] + V[F[:, 1]] + V[F[:, 2]]) / 3
    lr_norm = (fc[:, lr] - mn[lr]) / lr_r
    if axes['lr_sign'] < 0:
        lr_norm = 1 - lr_norm
    si_norm = (fc[:, si] - mn[si]) / si_r
    cm, cl, flr = cuts; mid = (cm + cl) / 2
    lb = np.where(lr_norm <= mid, 0, 2).astype(np.int32)
    floor_mask = (lr_norm >= cm) & (lr_norm <= cl) & (si_norm < flr)
    lb[floor_mask] = 1
    return lb


def _pick_pins_geodesic(V, F, main_boundary_verts, n_samples=None):
    """Выбор двух пин-вершин на главной границе по ~geodesic-диаметру
    (на графе вершин меша, edge-weight = Euclidean length). На практике
    Dijkstra от каждой k-й вершины границы и запоминание дальшей."""
    bv_list = main_boundary_verts
    # граф меша
    nV = len(V)
    rows, cols, vals = [], [], []
    eset = set()
    for f in F:
        for (a, b) in [(f[0], f[1]), (f[1], f[2]), (f[2], f[0])]:
            k = (min(a, b), max(a, b))
            if k in eset:
                continue
            eset.add(k)
            d = float(np.linalg.norm(V[a] - V[b]))
            rows += [a, b]; cols += [b, a]; vals += [d, d]
    G = csr_matrix((vals, (rows, cols)), shape=(nV, nV))
    from scipy.sparse.csgraph import dijkstra

    if n_samples is None:
        n_samples = min(8, len(bv_list))
    samp_idx = np.linspace(0, len(bv_list) - 1, n_samples).astype(int)
    samples = [bv_list[i] for i in samp_idx]
    best_pair = (samples[0], samples[0]); best_d = 0.0
    for s in samples:
        d, _ = dijkstra(G, indices=s, return_predecessors=True)
        # ищем на границе самую дальнюю
        bv_arr = np.array(bv_list)
        db = d[bv_arr]
        j = int(np.argmax(db))
        if db[j] > best_d:
            best_d = float(db[j])
            best_pair = (s, int(bv_arr[j]))
    return best_pair[0], best_pair[1], best_d


def _compute_metrics(V, F, uv, valid, face_labels, face_areas):
    """Более полная метрика:
       - квартильные бакеты
       - per-zone (per-label)
       - area_ratio_per_face p50/p95 (разброс локального масштаба)"""
    nF = len(F)
    p1, p2, p3 = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    e12 = p2 - p1
    L12 = np.maximum(np.linalg.norm(e12, axis=1), 1e-15)
    e12h = e12 / L12[:, None]
    e13 = p3 - p1
    x3 = np.einsum('ij,ij->i', e13, e12h)
    y3 = np.maximum(np.sqrt(np.maximum(0, np.linalg.norm(e13, axis=1) ** 2 - x3 ** 2)), 1e-15)
    u0, v0 = uv[F[:, 0], 0], uv[F[:, 0], 1]
    u1, v1 = uv[F[:, 1], 0], uv[F[:, 1], 1]
    u2, v2 = uv[F[:, 2], 0], uv[F[:, 2], 1]
    du1, dv1 = u1 - u0, v1 - v0
    du2, dv2 = u2 - u0, v2 - v0
    J00, J10 = du1 / L12, dv1 / L12
    J01 = (du2 - du1 * x3 / L12) / y3
    J11 = (dv2 - dv1 * x3 / L12) / y3
    a_ = J00 * J00 + J10 * J10
    b_ = J00 * J01 + J10 * J11
    c_ = J01 * J01 + J11 * J11
    tr = a_ + c_; det = a_ * c_ - b_ * b_
    disc = np.sqrt(np.maximum(0, tr * tr / 4 - det))
    l1, l2 = tr / 2 + disc, tr / 2 - disc
    sig1 = np.sqrt(np.maximum(l1, 0)); sig2 = np.sqrt(np.maximum(l2, 0))
    L2v = np.sqrt((sig1 ** 2 + sig2 ** 2) / 2)
    iso = np.maximum(sig1, 1.0 / np.maximum(sig2, 1e-9))
    mask = valid.astype(bool)
    sa = 0.5 * ((u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0))
    inverted = int(np.sum((sa < 0) & mask))
    # Per-face area ratio
    a_3d = face_areas
    a_2d = np.abs(sa)
    ratio = a_2d / np.maximum(a_3d, 1e-12)

    # edge errors
    edges = set(); edge_face_labels = defaultdict(list)
    for fi in range(nF):
        if not valid[fi]:
            continue
        for j in range(3):
            a_v, b_v = F[fi, j], F[fi, (j + 1) % 3]
            k = (min(a_v, b_v), max(a_v, b_v))
            edges.add(k); edge_face_labels[k].append(int(face_labels[fi]))
    edge_errs = []; seam_errs = []
    for k in edges:
        a_v, b_v = k
        L3 = np.linalg.norm(V[a_v] - V[b_v])
        L2e = np.linalg.norm(uv[a_v] - uv[b_v])
        if L3 > 1e-9:
            err = abs(L2e / L3 - 1); edge_errs.append(err)
            fls = edge_face_labels[k]
            if len(fls) >= 2 and len(set(fls)) >= 2:
                seam_errs.append(err)
    edge_errs = np.array(edge_errs) if edge_errs else np.array([0.0])
    seam_errs = np.array(seam_errs) if seam_errs else np.array([0.0])
    area_3d = float(face_areas[mask].sum()) if mask.any() else 0
    area_2d = float(np.sum(np.abs(sa[mask]))) if mask.any() else 0

    def q(arr, p):
        a = arr[~np.isnan(arr)] if arr.dtype == float else arr
        return float(np.percentile(a, p)) if len(a) else float('nan')

    L2_ma = L2v[mask]; iso_ma = iso[mask]; ratio_ma = ratio[mask]

    # per-zone
    per_zone = {}
    for zid in sorted(np.unique(face_labels[mask]).tolist()):
        zm = mask & (face_labels == zid)
        if not zm.any():
            continue
        per_zone[int(zid)] = {
            'n_faces': int(zm.sum()),
            'area_3d_mm2': float(face_areas[zm].sum()),
            'L2_p50': q(L2v[zm], 50), 'L2_p95': q(L2v[zm], 95),
            'iso_p95': q(iso[zm], 95),
            'area_ratio_p50': q(ratio[zm], 50),
            'area_ratio_p95': q(ratio[zm], 95),
        }

    # === per-face edge_err_max ==============================================
    # Для каждого face — максимум из 3 edge-ошибок. Именно этот массив
    # фронтенд использует для подсветки «ненадёжных» треугольников, чтобы
    # хирург не измерял длины в этих зонах.

    p0v = V[F[:, 0]]; p1v = V[F[:, 1]]; p2v = V[F[:, 2]]
    p0u = uv[F[:, 0]]; p1u = uv[F[:, 1]]; p2u = uv[F[:, 2]]
    L3_01 = np.linalg.norm(p1v - p0v, axis=1)
    L3_12 = np.linalg.norm(p2v - p1v, axis=1)
    L3_20 = np.linalg.norm(p0v - p2v, axis=1)
    L2_01 = np.linalg.norm(p1u - p0u, axis=1)
    L2_12 = np.linalg.norm(p2u - p1u, axis=1)
    L2_20 = np.linalg.norm(p0u - p2u, axis=1)
    # Если L3 слишком мал — деградировавшая 3D-грань. Пропускаем (ошибка = 0).
    # Если L2e — NaN (LSCM-сбой), ошибка тоже NaN. Это нужно.
    with np.errstate(divide='ignore', invalid='ignore'):
        e_01 = np.where(L3_01 >= 1e-9, np.abs(L2_01 / L3_01 - 1.0), 0.0)
        e_12 = np.where(L3_12 >= 1e-9, np.abs(L2_12 / L3_12 - 1.0), 0.0)
        e_20 = np.where(L3_20 >= 1e-9, np.abs(L2_20 / L3_20 - 1.0), 0.0)
    # np.maximum пропагирует NaN (в отличие от np.fmax, который его
    # проглатывает). Нам нужна пропагация.
    face_edge_err_max = np.maximum(np.maximum(e_01, e_12), e_20)

    # Маркируем «высокого риска» треугольники для удобства UI.
    # Пороги подобраны по анализу mucosa10
    #   < 5%  — зелёный (надёжно)
    #   5-10% — жёлтый (осторожно)
    #   10%+  — красный (не измерять)
    face_risk_level = np.zeros(nF, dtype=np.uint8)
    face_risk_level[face_edge_err_max >= 0.05] = 1
    face_risk_level[face_edge_err_max >= 0.10] = 2
    # NaN/inf/invalid граней не должно быть ЗЕЛЁНЫМИ. Если LSCM
    # частично сфейлился или faces помечены invalid (flipped / out-of-range
    # area_ratio / ISO > порога), сравнение `NaN >= 0.05` даёт False, и UI
    # подсветит такой треугольник как безопасный для измерений. Защита:
    bad = (~np.isfinite(face_edge_err_max)) | (valid == 0)
    face_risk_level[bad] = 2
    risk_high_pct = 100.0 * float(((face_risk_level == 2) & mask).sum()) / max(int(mask.sum()), 1)

    return {
        'L2_p50': q(L2_ma, 50),
        'L2_mean': float(np.nanmean(L2_ma)) if len(L2_ma) else float('nan'),
        'L2_p95': q(L2_ma, 95),
        'L2_p99': q(L2_ma, 99),
        'L2_max': float(np.nanmax(L2_ma)) if len(L2_ma) else float('nan'),
        'iso_p50': q(iso_ma, 50),
        'iso_mean': float(np.nanmean(iso_ma)) if len(iso_ma) else float('nan'),
        'iso_p95': q(iso_ma, 95),
        'iso_max': float(np.nanmax(iso_ma)) if len(iso_ma) else float('nan'),
        'edge_err_p50': q(edge_errs, 50),
        'edge_err_mean': float(edge_errs.mean()),
        'edge_err_p75': q(edge_errs, 75),
        'edge_err_p95': q(edge_errs, 95),
        'edge_err_p99': q(edge_errs, 99),
        'seam_err_mean': float(seam_errs.mean()),
        'seam_err_p95': q(seam_errs, 95) if len(seam_errs) > 0 else float('nan'),
        'seam_err_over_5pct': int(np.sum(seam_errs > 0.05)),
        'n_seam_edges': int(len(seam_errs)),
        'inverted': inverted,
        'valid_pct': 100.0 * float(mask.sum()) / nF,
        'area_ratio_2d_3d': area_2d / max(area_3d, 1e-9),
        'area_ratio_per_face_p50': q(ratio_ma, 50),
        'area_ratio_per_face_p95': q(ratio_ma, 95),
        'per_zone': per_zone,
        'risk_high_faces_pct':   risk_high_pct,
        'risk_n_high':           int((face_risk_level == 2).sum()),
        'risk_n_medium':         int((face_risk_level == 1).sum()),
    }, {
        'face_edge_err_max': face_edge_err_max,
        'face_L2':           L2v,
        'face_iso':          iso,
        'face_area_ratio':   ratio,
        'face_risk_level':   face_risk_level,
    }


# =============================================================================
#  6. ENTRY POINTS
# =============================================================================

def unfold(V, F, zone_labels=None, opts=None):
    opts = {**DEFAULT_OPTS, **(opts or {})}
    V = np.asarray(V, dtype=np.float64)
    F = np.asarray(F, dtype=np.int64)
    mode = opts.get('mode', 'single')
    if mode == 'charts' and zone_labels is not None and len(np.unique(zone_labels)) > 1:
        return _unfold_charts(V, F, np.asarray(zone_labels, dtype=np.int32), opts)
    return _unfold_single(V, F, zone_labels, opts)


def _unfold_single(V, F, zone_labels, opts):
    opts = {**DEFAULT_OPTS, **(opts or {})}
    V = np.asarray(V, dtype=np.float64)
    F = np.asarray(F, dtype=np.int64)
    orig_nV, orig_nF = len(V), len(F)
    verbose = opts.get('verbose', False)

    t0 = time.time()
    # === Трекер провенанса для per-face/per-vertex атрибутов =================
    # v_to_input[i]   — индекс исходной вершины в ВХОДНОМ V для текущей V[i],
    #                    либо -1 если вершина синтетическая (fan-apex).
    # f_to_input[i]   — индекс исходной грани во ВХОДНОМ F для текущей F[i],
    #                    либо -1 если грань синтетическая (fan-fill).
    # Это нужно чтобы:
    #  1) zone_labels ИЗ ВХОДА корректно переносились через LCC
    #     (которая может удалить грани, если были disconnected компоненты);
    #  2) для синтетических граней (-1) вычислить label majority-voting'ом
    #     по соседним labelled-граням (иначе они всегда получают label=0);
    #  3) _unfold_charts мог точно сопоставить processed-индексы с orig
    #     без fragile KDTree-матчинга по 3D-координатам.
    v_to_input = np.arange(orig_nV, dtype=np.int64)
    f_to_input = np.arange(orig_nF, dtype=np.int64)


    V, F, v_map, f_mask = largest_connected_component(V, F)
    kept_v = np.where(v_map >= 0)[0]
    v_to_input = v_to_input[kept_v]
    f_to_input = f_to_input[f_mask]


    V, F, nm_splits, orig_of = split_nonmanifold_vertices(V, F)
    v_to_input = v_to_input[orig_of]

    # LCC 2 (после NM-split могут появиться микро-компоненты)
    V, F, v_map, f_mask = largest_connected_component(V, F)
    kept_v = np.where(v_map >= 0)[0]
    v_to_input = v_to_input[kept_v]
    f_to_input = f_to_input[f_mask]

    # =========================================================================
    # v5: КЛАССИФИКАЦИЯ inner loops по zone (septum-perforation vs artifact)
    # =========================================================================
    # Отличие от v4: cut_open_inner_loops выключен по умолчанию (эмпирически
    # он не улучшал качество, но уничтожал анатомические септум-перфорации,
    # которые врачу нужно измерить для планирования лоскута).
    #
    # Порядок в v5:
    #   1. Вычислить zone_labels (ДО модификаций меша — чтобы классификация
    #      делалась на оригинальной топологии).
    #   2. classify_and_fill_inner_loops: septum-perforations остаются как
    #      inner boundary cycles, артефакты fan-fill'ятся.
    #   3. (опционально) legacy cut_open

    # --- Шаг 1: zone_labels на ТЕКУЩЕМ меше (после cleanup, до modifications)
    labels = None
    if zone_labels is not None and len(zone_labels) >= orig_nF:
        zl_in = np.asarray(zone_labels, dtype=np.int32)
        labels = np.zeros(len(F), dtype=np.int32)
        has_src = f_to_input >= 0
        labels[has_src] = zl_in[f_to_input[has_src]]
        # Для граней без provenance — majority-vote по соседним vertices
        if (~has_src).any():
            vert2lf = defaultdict(list)
            for fi_lbl in np.where(has_src)[0]:
                for j in range(3):
                    vert2lf[int(F[fi_lbl, j])].append(int(labels[fi_lbl]))
            for fi_unl in np.where(~has_src)[0]:
                cands = []
                for j in range(3):
                    cands.extend(vert2lf[int(F[fi_unl, j])])
                if cands:
                    labels[fi_unl] = Counter(cands).most_common(1)[0][0]
    else:
        # auto-сегментация (PCA-based) — нужна для классификации даже без user zones
        axes_tmp = _estimate_axes(V)
        labels = _auto_zone_labels(V, F, axes_tmp)

    # --- Шаг 2: классификация inner loops
    loops_info = {
        'preserved_perforations': [], 'artifact_loops_filled': [],
        'artifact_loops_cut':      [],
        'n_preserved': 0, 'n_filled_artifacts': 0, 'n_cut_artifacts': 0,
    }
    if opts.get('classify_inner_loops', True):
        V, F, labels, v_to_input, f_to_input, loops_info = \
            classify_and_fill_inner_loops(
                V, F, labels,
                v_to_input=v_to_input, f_to_input=f_to_input,
                septum_label=int(opts.get('septum_zone_label', 0)),
                septum_pct_threshold=float(opts.get('septum_area_pct_threshold', 50.0)),
                min_preserved_perimeter_mm=float(
                    opts.get('min_preserved_loop_perimeter_mm', 2.0)),
                max_fan_fill_perimeter_mm=float(
                    opts.get('max_fan_fill_perimeter_mm', 2.0)),
                verbose=verbose,
            )

    # --- Шаг 3: LEGACY cut_open (default OFF).
    # cut_open будет работать на сохранённых септум-перфорациях. Это может
    # быть использовано для debug/compat режима. По умолчанию — skip.
    cuts_info = []; n_cuts = 0
    if opts.get('cut_open_inner_loops', False):
        V, F, n_cuts, cuts_info, cut_parents = cut_open_inner_loops(
            V, F,
            min_loop_perimeter_mm=float(opts.get('cut_min_loop_perimeter_mm', 15.0)),
            verbose=verbose,
        )
        if cut_parents:
            parents_arr = np.asarray(cut_parents, dtype=np.int64)
            v_to_input = np.concatenate([v_to_input, v_to_input[parents_arr]])

    # --- Шаг 4: LEGACY smart_fill_small_holes (fan-fill <fill_perimeter_threshold).
    # В v5 это дублирует classify (классификатор сам заполняет мелкие септум-
    # петли через min_preserved_perimeter). Оставлено как safety net
    filled_legacy = 0; kept_loops = []
    if not opts.get('classify_inner_loops', True):
        nV_before_fill = len(V); nF_before_fill = len(F)
        V, F, filled_legacy, kept_loops = smart_fill_small_holes(
            V, F, opts['fill_perimeter_threshold_mm'])
        nV_added = len(V) - nV_before_fill
        nF_added = len(F) - nF_before_fill
        if nV_added > 0:
            v_to_input = np.concatenate([v_to_input, np.full(nV_added, -1, dtype=np.int64)])
            labels = np.concatenate([labels, np.zeros(nV_added, dtype=labels.dtype)])[:len(F)]
        if nF_added > 0:
            f_to_input = np.concatenate([f_to_input, np.full(nF_added, -1, dtype=np.int64)])
    t_pre = time.time() - t0

    edges = np.sort(np.vstack([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]]), axis=1)
    nE = len(set(map(tuple, edges)))
    nV_c, nF_c = len(V), len(F)
    chi = nV_c - nE + nF_c
    # В v5 n_loops = число сохранённых inner boundaries (septum-perforations)
    n_loops = loops_info['n_preserved']
    genus_nom = (2 - chi - n_loops) / 2.0

    cycles = find_boundary_cycles(V, F)
    if not cycles:
        raise ValueError("Mesh has no boundary after cleanup — closed surface.")
    main_bnd = max(cycles, key=lambda c: c['length'])['vertices']

    # Pin strategy
    if opts['pin_strategy'] == 'geodesic_diameter':
        p_a, p_b, _ = _pick_pins_geodesic(V, F, main_bnd)
    else:
        bv = V[main_bnd]
        d0 = np.linalg.norm(bv - bv[0], axis=1); i1 = int(d0.argmax())
        d1 = np.linalg.norm(bv - bv[i1], axis=1); i0 = int(d1.argmax())
        p_a, p_b = main_bnd[i0], main_bnd[i1]
    pin_ids = np.array([p_a, p_b], dtype=np.int64)
    pin_uv = np.array([[0.0, 0.0],
                       [float(np.linalg.norm(V[p_a] - V[p_b])), 0.0]])

    t0 = time.time()
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        UV_lscm = lscm(V, F, pin_ids, pin_uv)
    t_lscm = time.time() - t0
    if np.isnan(UV_lscm).any():
        raise ValueError(f"LSCM failed ({int(np.isnan(UV_lscm).any(axis=1).sum())} NaN vertices).")

    # Face metrics
    p1, p2, p3 = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    fn_raw = np.cross(p2 - p1, p3 - p1)
    fn_ln = np.maximum(np.linalg.norm(fn_raw, axis=1), 1e-15)
    fa = 0.5 * fn_ln
    fn = fn_raw / fn_ln[:, None]
    axes = _estimate_axes(V)

    # labels уже вычислены на v5-шаге 1 (до classify_and_fill_inner_loops)
    # и расширены в classify'е majority-vote'ом для новых fan-faces.
    # Safety check: если длина не соответствует, используем fallback.
    if labels is None or len(labels) != len(F):
        if verbose:
            print(f"  [v5] labels len mismatch ({len(labels) if labels is not None else None} "
                  f"vs {len(F)}), regenerate via auto-zones")
        labels = _auto_zone_labels(V, F, axes)
    nF_c = len(F)

    # face-weight
    # fallback должен совпадать с DEFAULT_OPTS['arap_face_weighting']
    # (обычно не сработает, т.к. opts уже merged с DEFAULT_OPTS в unfold(),
    # но если _unfold_single вызван напрямую с кастомным opts — важно).
    fw_mode = opts.get('arap_face_weighting', 'uniform')
    if fw_mode == 'area':
        face_weight = fa / fa.mean()   # нормированная площадь
    elif fw_mode == 'seam_v3':
        face_weight = _build_seam_weights_v3(F, labels, opts['arap_seam_weight_strength'])
    else:  # 'uniform'
        face_weight = np.ones(nF_c)

    t0 = time.time()
    UV_arap = _arap(V, F, UV_lscm, face_weight,
                    n_iter=int(opts['arap_iterations']),
                    tol=float(opts['arap_tol_delta']),
                    clamp_cot=bool(opts['arap_clamp_cotan']),
                    verbose=verbose)
    t_arap = time.time() - t0

    UV_final, scale = _area_match_scale(UV_arap, F, V)

    if opts.get('post_stretch_correction', True):
        t0 = time.time()
        UV_final = _post_stretch_correction(V, F, UV_final,
                                            n_iter=int(opts['post_stretch_iters']))
        UV_final, _ = _area_match_scale(UV_final, F, V)
        t_post = time.time() - t0
    else:
        t_post = 0.0

    # validity: face considered invalid if UV area deviates >10× (раньше 20×/5×)
    # или если ISO > validity_iso_max
    p0u = UV_final[F[:, 0]]; p1u = UV_final[F[:, 1]]; p2u = UV_final[F[:, 2]]
    sa = 0.5 * ((p1u[:, 0] - p0u[:, 0]) * (p2u[:, 1] - p0u[:, 1])
                - (p2u[:, 0] - p0u[:, 0]) * (p1u[:, 1] - p0u[:, 1]))
    a3d = 0.5 * np.linalg.norm(np.cross(p2 - p1, p3 - p1), axis=1)
    ratio = np.abs(sa) / np.maximum(a3d, 1e-12)
    # локальный ISO для каждого face
    e12_3d = p2 - p1
    L12_3d = np.maximum(np.linalg.norm(e12_3d, axis=1), 1e-15)
    e12h_3d = e12_3d / L12_3d[:, None]
    e13_3d = p3 - p1
    x3_3d = np.einsum('ij,ij->i', e13_3d, e12h_3d)
    y3_3d = np.maximum(np.sqrt(np.maximum(
        0, np.linalg.norm(e13_3d, axis=1) ** 2 - x3_3d ** 2)), 1e-15)
    du1 = p1u[:, 0] - p0u[:, 0]; dv1 = p1u[:, 1] - p0u[:, 1]
    du2 = p2u[:, 0] - p0u[:, 0]; dv2 = p2u[:, 1] - p0u[:, 1]
    Jxx = du1 / L12_3d; Jyx = dv1 / L12_3d
    Jxy = (du2 - du1 * x3_3d / L12_3d) / y3_3d
    Jyy = (dv2 - dv1 * x3_3d / L12_3d) / y3_3d
    aa = Jxx * Jxx + Jyx * Jyx
    bb = Jxx * Jxy + Jyx * Jyy
    cc = Jxy * Jxy + Jyy * Jyy
    tr = aa + cc; det_ = aa * cc - bb * bb
    disc = np.sqrt(np.maximum(0, tr * tr / 4 - det_))
    sig1_sq = np.maximum(tr / 2 + disc, 0)
    sig2_sq = np.maximum(tr / 2 - disc, 0)
    sig1 = np.sqrt(sig1_sq); sig2 = np.sqrt(sig2_sq)
    iso_per_face = np.maximum(sig1, 1.0 / np.maximum(sig2, 1e-9))

    valid = np.ones(nF_c, dtype=np.int32)
    valid[(ratio < opts['validity_area_ratio_low']) | (ratio > opts['validity_area_ratio_high'])] = 0
    valid[iso_per_face > opts['validity_iso_max']] = 0
    valid[~np.isfinite(UV_final[F]).all(axis=(1, 2))] = 0

    metrics, face_arrays = _compute_metrics(V, F, UV_final, valid, labels, fa)

    return {
        'V': V, 'F': F, 'uv': UV_final,
        'valid': valid, 'zone_labels': labels,
        'face_areas_3d': fa, 'face_normals': fn,
        # Per-face массивы для UI-подсветки (см. tab4-unfold risk-mode).
        # ВАЖНО: face_edge_err_max — главный индикатор. >10% = не измерять.
        'face_edge_err_max': face_arrays['face_edge_err_max'],
        'face_L2':           face_arrays['face_L2'],
        'face_iso':          face_arrays['face_iso'],
        'face_area_ratio':   face_arrays['face_area_ratio'],
        'face_risk_level':   face_arrays['face_risk_level'],
        # Provenance-маппинги (используются _unfold_charts для склейки
        # через shared vertex indices вместо fragile KDTree-по-координатам).
        # -1 означает синтетическую грань/вершину (fan-fill).
        'vert_original_idx': v_to_input,
        'face_original_idx': f_to_input,
        'metrics': metrics,
        'info': {
            'version': __version__,
            'orig_nV': orig_nV, 'orig_nF': orig_nF,
            'nV_processed': nV_c, 'nF_processed': nF_c,
            'nm_vertex_splits': nm_splits,
            # v5 fan-fill stats
            'fans_filled':            loops_info['n_filled_artifacts'] + filled_legacy,
            'n_artifact_loops_filled': loops_info['n_filled_artifacts'],
            'n_artifact_loops_cut':    loops_info.get('n_cut_artifacts', 0),
            'n_tiny_loops_filled':     filled_legacy,  # legacy path, обычно 0
            # v5 preserved septum perforations для клинической работы
            'n_preserved_perforations': loops_info['n_preserved'],
            'preserved_perforations':   loops_info['preserved_perforations'],
            'artifact_loops':           loops_info['artifact_loops_filled'],
            'artifact_loops_cut':       loops_info.get('artifact_loops_cut', []),
            # legacy cut-open (OFF by default в v5)
            'n_cuts_opened': n_cuts, 'cuts_info': cuts_info,
            # kept_holes
            # перфораций. Это ≥ 0 и означает число отверстий в UV.
            'kept_holes': loops_info['n_preserved'],
            'chi_cleaned': chi, 'genus_nominal': genus_nom,
            't_preprocess_s': t_pre, 't_lscm_s': t_lscm, 't_arap_s': t_arap,
            't_post_s': t_post,
            'total_time_s': t_pre + t_lscm + t_arap + t_post,
            'pin_ids': pin_ids.tolist(),
            'scale_factor': scale,
            'arap_face_weighting': fw_mode,
        },
    }


def _build_seam_weights_v3(F, face_labels, strength=3.0):
    nF = len(F)
    edge2face = defaultdict(list)
    for fi in range(nF):
        for j in range(3):
            a, b = F[fi, j], F[fi, (j + 1) % 3]
            edge2face[(min(a, b), max(a, b))].append(fi)
    seam = set()
    for fl in edge2face.values():
        if len(fl) == 2 and face_labels[fl[0]] != face_labels[fl[1]]:
            seam.add(fl[0]); seam.add(fl[1])
    fAdj = defaultdict(list)
    for fl in edge2face.values():
        if len(fl) == 2:
            fAdj[fl[0]].append(fl[1]); fAdj[fl[1]].append(fl[0])
    ring = np.full(nF, 99, dtype=np.int32)
    for fi in seam:
        ring[fi] = 0
    q = deque(seam)
    while q:
        u = q.popleft()
        for v in fAdj[u]:
            if ring[v] > ring[u] + 1:
                ring[v] = ring[u] + 1; q.append(v)
    return 1.0 + strength * np.exp(-ring / 1.5)


def _unfold_charts(V, F, zone_labels, opts):
    """v4 charts-mode: Procrustes по shared VERTEX INDEX, а не по 3D-коорд.

    Ключевое отличие от v3: shared-индексы находятся ТОЧНО (до preprocess'а
    каждого чарта). Это полностью устраняет баг 'n_matched=0' на чартах с
    редкими общими вершинами.
    """
    orig_nV, orig_nF = len(V), len(F)
    t_total = time.time()

    chart_data = {}
    shared_map = {}  # zid -> dict[vertex_idx_orig, vertex_idx_local_in_chart]

    for zid in sorted(np.unique(zone_labels).tolist()):
        fmask = zone_labels == zid
        if fmask.sum() == 0:
            continue
        used_v = np.unique(F[fmask].ravel())
        if len(used_v) < 3:
            continue
        v_remap = -np.ones(len(V), dtype=np.int64)
        v_remap[used_v] = np.arange(len(used_v))
        V_sub = V[used_v].copy()
        F_sub = v_remap[F[fmask]]

        # Запоминаем соответствие ORIG_IDX → local_idx (до вызова _unfold_single,
        # в котором произойдёт LCC / NM-split и т.п.).
        local_to_orig = used_v.copy()  # (len(V_sub),)

        try:
            r = _unfold_single(V_sub, F_sub, zone_labels=None,
                               opts={**opts, 'mode': 'single'})
            # v4.2: используем explicit vertex-index tracking из _unfold_single
            # вместо fragile KDTree-по-координатам. Прежний код ломался,
            # если NM-split создавал дубликаты с одинаковыми 3D-координатами:
            # KDTree возвращал произвольный из них, и shared_map корраптился.
            v_orig_in_chart = r.get('vert_original_idx')
            proc_to_orig = {}
            if v_orig_in_chart is not None:
                # v_orig_in_chart[i] = индекс в V_sub (local) для proc-vertex i,
                # или -1 для синтетических (fan-apex).
                for i_proc, loc_idx in enumerate(v_orig_in_chart):
                    if loc_idx >= 0:
                        proc_to_orig[int(i_proc)] = int(local_to_orig[int(loc_idx)])
            else:
                # Fallback на случай очень старого API — координатный матчинг.
                from scipy.spatial import cKDTree as KDTree
                tree = KDTree(V_sub)
                ds, idx_sub = tree.query(r['V'], k=1, distance_upper_bound=1e-7)
                matched_sub = np.isfinite(ds) & (ds < 1e-6)
                for i in range(len(r['V'])):
                    if matched_sub[i]:
                        proc_to_orig[int(i)] = int(local_to_orig[int(idx_sub[i])])
            shared_map[int(zid)] = proc_to_orig
            chart_data[int(zid)] = r
        except ValueError as e:
            print(f"[charts] zone {zid} failed: {e}")
            continue

    if not chart_data:
        raise ValueError("All zone-charts failed to unfold.")

    # Anchor = самый большой по nF
    anchor_id = max(chart_data, key=lambda k: chart_data[k]['info']['nF_processed'])
    anchor = chart_data[anchor_id]
    anchor_map = shared_map[anchor_id]
    # orig_idx → proc_idx_in_anchor
    anchor_orig_to_proc = {orig: proc for proc, orig in anchor_map.items()}

    # ── Tree-based gluing ──────────────────────────────────────────────────
    # Строим граф зон: ребро (a,b) если зоны a и b имеют общие orig-вершины.
    # BFS от anchor'а. Procrustes каждого дочернего чарта К УЖЕ ПРИВЯЗАННОМУ
    # родителю (а не ко всей конструкции). Это решает случай, когда
    # chart ↛ anchor напрямую (нет общих вершин), но chart ↔ middle ↔ anchor.
    #
    # Пример: septum (anchor) ↔ floor ↔ lateral. В v3 lateral сравнивался
    # с septum напрямую (n_matched=0) и улетал в сторону. Теперь lateral
    # склеивается с floor после того, как floor склеен с septum — через
    # общие с floor'ом 50+ вершин.
    all_zones = list(chart_data.keys())
    zone_adj = defaultdict(set)
    for i, za in enumerate(all_zones):
        for zb in all_zones[i + 1:]:
            shared = set(shared_map[za].values()) & set(shared_map[zb].values())
            if len(shared) >= 2:
                zone_adj[za].add(zb)
                zone_adj[zb].add(za)

    gluing_mode = opts.get('charts_gluing', 'tree')

    # Порядок обхода: BFS от anchor_id
    visited = {anchor_id}
    queue = deque([anchor_id])
    bfs_order = []
    while queue:
        u = queue.popleft()
        for v in zone_adj[u]:
            if v not in visited:
                visited.add(v)
                bfs_order.append((v, u))  # (child, parent)
                queue.append(v)
    # Зоны, не связанные ни с чем в компоненте anchor'а — допишем в конец
    # с parent=anchor (они всё равно раскидаются offset'ом).
    disconnected = [z for z in all_zones if z not in visited]
    for z in disconnected:
        bfs_order.append((z, anchor_id))

    # align_stats[anchor]:
    align_stats = {anchor_id: {'n_matched': 0, 'residual_mm': 0.0,
                               'scale': 1.0, 'parent': None}}
    for zid, parent_zid in bfs_order:
        ch = chart_data[zid]
        parent_ch = chart_data[parent_zid]
        ch_map = shared_map[zid]
        parent_map_orig_to_proc = {orig: proc for proc, orig
                                   in shared_map[parent_zid].items()}

        # Если gluing_mode='direct_to_anchor' — ВСЕГДА парентим к anchor'у
        # (поведение, совместимое с v3).
        if gluing_mode == 'direct_to_anchor':
            parent_ch = chart_data[anchor_id]
            parent_map_orig_to_proc = {orig: proc for proc, orig
                                       in shared_map[anchor_id].items()}
            parent_zid = anchor_id

        pairs = []
        for proc_ch, orig in ch_map.items():
            if orig in parent_map_orig_to_proc:
                pairs.append((proc_ch, parent_map_orig_to_proc[orig]))

        if len(pairs) < 2:
            # Нет связи — раскладываем offset'ом справа от anchor'а
            bbA = chart_data[anchor_id]['uv']
            dx = float(bbA[:, 0].max() - bbA[:, 0].min()) + 10.0
            ch['uv'] = ch['uv'] + np.array([dx * (1 + len(align_stats)), 0.0])
            align_stats[zid] = {'n_matched': len(pairs),
                                'residual_mm': float('nan'),
                                'scale': 1.0, 'parent': parent_zid}
            continue

        idx_ch = np.array([p[0] for p in pairs])
        idx_par = np.array([p[1] for p in pairs])
        pA = parent_ch['uv'][idx_par]
        pB = ch['uv'][idx_ch]
        cA = pA.mean(0); cB = pB.mean(0)
        qA = pA - cA; qB = pB - cB
        H = qB.T @ qA
        U_, S_, Vt_ = np.linalg.svd(H)
        d = np.sign(np.linalg.det(Vt_.T @ U_.T))
        D = np.diag([1.0, d])
        R = Vt_.T @ D @ U_.T
        if opts.get('charts_allow_scale', False):
            varB = (qB ** 2).sum()
            s = float((np.diag(D) * S_).sum() / max(varB, 1e-12))
        else:
            s = 1.0
        t = cA - s * (R @ cB)
        ch['uv'] = (s * ch['uv'] @ R.T) + t
        pB_new = (s * pB @ R.T) + t
        residual = float(np.linalg.norm(pB_new - pA, axis=1).mean())
        align_stats[zid] = {'n_matched': len(pairs),
                            'residual_mm': residual,
                            'scale': s, 'parent': parent_zid}

    # Merge
    V_all, F_all, uv_all, zl_all, valid_all, fa_all, fn_all = [], [], [], [], [], [], []
    offset = 0
    for zid in sorted(chart_data.keys()):
        ch = chart_data[zid]
        V_all.append(ch['V']); F_all.append(ch['F'] + offset)
        uv_all.append(ch['uv'])
        zl_all.append(np.full(len(ch['F']), zid, dtype=np.uint8))
        valid_all.append(ch['valid']); fa_all.append(ch['face_areas_3d'])
        fn_all.append(ch['face_normals'])
        offset += len(ch['V'])

    V_c = np.vstack(V_all); F_c = np.vstack(F_all); uv_c = np.vstack(uv_all)
    zl_c = np.concatenate(zl_all); valid_c = np.concatenate(valid_all)
    fa_c = np.concatenate(fa_all); fn_c = np.vstack(fn_all)

    metrics, face_arrays = _compute_metrics(V_c, F_c, uv_c, valid_c, zl_c, fa_c)
    mean_res_arr = [s['residual_mm'] for s in align_stats.values()
                    if np.isfinite(s['residual_mm'])]
    metrics['chart_seam_residual_mm'] = float(np.mean(mean_res_arr)) if mean_res_arr else 0.0


    polish_on = bool(opts.get('charts_polish', False))
    polish_info = {'applied': False}
    if polish_on:
        try:
            V_c, F_c, uv_c, valid_c, zl_c, fa_c, fn_c, polish_info = \
                _charts_merge_and_polish(
                    chart_data, shared_map, V_c, F_c, uv_c, valid_c, zl_c,
                    fa_c, fn_c, opts)
            polish_info['_warning'] = ('merge-only: может давать inversions у швов. '
                                       'Не использовать для клинических измерений.')
            # Пересчитать метрики на склеенном меше
            metrics, face_arrays = _compute_metrics(V_c, F_c, uv_c, valid_c, zl_c, fa_c)
            metrics['chart_seam_residual_mm'] = 0.0
        except Exception as e:
            import traceback as _tb
            polish_info = {'applied': False,
                           'error': f'{type(e).__name__}: {e}',
                           'traceback': _tb.format_exc()[-600:]}

    info = {
        'version': __version__, 'mode': 'charts',
        'n_charts': len(chart_data),
        'anchor_chart': anchor_id,
        'chart_align_stats': align_stats,
        'orig_nV': orig_nV, 'orig_nF': orig_nF,
        'nV_processed': int(len(V_c)), 'nF_processed': int(len(F_c)),
        'nm_vertex_splits': sum(ch['info']['nm_vertex_splits'] for ch in chart_data.values()),
        'fans_filled': sum(ch['info']['fans_filled'] for ch in chart_data.values()),
        'kept_holes': sum(ch['info']['kept_holes'] for ch in chart_data.values()),
        't_preprocess_s': sum(ch['info']['t_preprocess_s'] for ch in chart_data.values()),
        't_lscm_s': sum(ch['info']['t_lscm_s'] for ch in chart_data.values()),
        't_arap_s': sum(ch['info']['t_arap_s'] for ch in chart_data.values()),
        'total_time_s': time.time() - t_total,
        'polish': polish_info,
    }

    return {
        'V': V_c, 'F': F_c, 'uv': uv_c,
        'valid': valid_c, 'zone_labels': zl_c,
        'face_areas_3d': fa_c, 'face_normals': fn_c,
        'face_edge_err_max': face_arrays['face_edge_err_max'],
        'face_L2':           face_arrays['face_L2'],
        'face_iso':          face_arrays['face_iso'],
        'face_area_ratio':   face_arrays['face_area_ratio'],
        'face_risk_level':   face_arrays['face_risk_level'],
        'metrics': metrics, 'info': info,
    }


def _charts_merge_and_polish(chart_data, shared_map, V_c, F_c, uv_c, valid_c,
                             zl_c, fa_c, fn_c, opts):
    """Пост-обработка charts: ТОЛЬКО склейка shared-vertices (без ARAP).

    Проблема: после tree-gluing каждая shared-вершина (лежащая на границе
    между зонами) представлена в результирующем UV **дважды** — по одной
    копии в каждом чарте. После Procrustes они почти совпадают (residual
    0.2-0.5 мм), но не точно. Это:
      1. Создаёт видимый «шов» в UI (пилообразный край у границы зон).
      2. Ломает инъективность на швах: два треугольника, соседние в 3D,
         имеют разные UV-координаты у общего ребра.

    Решение (ПРОСТОЕ, надёжное):
      Для каждой ORIG-вершины, встречающейся в ≥2 чартах, выбираем пивот
      (копия с наибольшей incident-степенью). Остальные переиндексируются
      на пивот, UV пивота = среднее копий.

    Почему БЕЗ ARAP: эксперимент показал, что глобальный ARAP после merge
    распределяет неразвёртываемость 3D-поверхности по всему мешу, ломая
    внутренности хорошо-настроенных зон (на mucosa9: iso_max 3.3→8.2,
    inv 2→4). Локальный ARAP с pin'ами — тоже нестабилен (требует
    переделки _arap для multi-pin). Поэтому polish = просто merge.

    Цена merge без ARAP: в каждой пивот-вершине UV является средним
    двух-трёх позиций, что создаёт локальное искажение ~0.3 мм. Но это
    искажение изолировано в шве, не размазывается.
    """
    t0 = time.time()
    nV_before = len(V_c)
    nF_before = len(F_c)

    # ── 1. Карта orig_idx -> global_idx[] ─────────────────────────────────────
    orig_to_global = defaultdict(list)
    offset = 0
    for zid in sorted(chart_data.keys()):
        ch = chart_data[zid]
        ch_map = shared_map[zid]
        for proc_idx, orig_idx in ch_map.items():
            orig_to_global[orig_idx].append(proc_idx + offset)
        offset += len(ch['V'])

    multi_copy_orig = {o: gs for o, gs in orig_to_global.items() if len(gs) >= 2}

    # ── 2. Выбираем пивот + remap ─────────────────────────────────────────────
    remap = np.arange(nV_before, dtype=np.int64)
    vertex_degree = np.zeros(nV_before, dtype=np.int64)
    for fi in range(nF_before):
        for j in range(3):
            vertex_degree[F_c[fi, j]] += 1

    n_merged = 0
    merge_distances_mm = []
    for orig_idx, gidxs in multi_copy_orig.items():
        pivot = gidxs[int(np.argmax([vertex_degree[g] for g in gidxs]))]
        uv_mean = uv_c[gidxs].mean(axis=0)
        for i, a in enumerate(gidxs):
            for b in gidxs[i + 1:]:
                merge_distances_mm.append(float(np.linalg.norm(uv_c[a] - uv_c[b])))
        uv_c[pivot] = uv_mean
        for g in gidxs:
            if g != pivot:
                remap[g] = pivot
                n_merged += 1

    # ── 3. Перемаппим F, выкинем degenerate ───────────────────────────────────
    F_merged = remap[F_c]
    degen = ((F_merged[:, 0] == F_merged[:, 1]) |
             (F_merged[:, 1] == F_merged[:, 2]) |
             (F_merged[:, 0] == F_merged[:, 2]))
    keep = ~degen
    n_degen = int(degen.sum())
    F_merged = F_merged[keep]
    zl_merged = zl_c[keep]
    fa_merged = fa_c[keep]
    fn_merged = fn_c[keep]
    valid_merged = valid_c[keep]

    # Сжать индексы
    used = np.unique(F_merged.ravel())
    compact_remap = -np.ones(nV_before, dtype=np.int64)
    compact_remap[used] = np.arange(len(used))
    V_comp = V_c[used]
    uv_comp = uv_c[used]
    F_comp = compact_remap[F_merged]

    # ── 4. Пересчитать 3D-площади / нормали для сжатого меша ──────────────────
    p0, p1, p2 = V_comp[F_comp[:, 0]], V_comp[F_comp[:, 1]], V_comp[F_comp[:, 2]]
    cross = np.cross(p1 - p0, p2 - p0)
    fa_comp = 0.5 * np.linalg.norm(cross, axis=1)
    fn_ln = np.maximum(np.linalg.norm(cross, axis=1), 1e-15)
    fn_comp = cross / fn_ln[:, None]

    # ── 5. Rescale под 3D-площадь ─────────────────────────────────────────────
    uv_final, _scale = _area_match_scale(uv_comp, F_comp, V_comp)

    info = {
        'applied': True,
        'strategy': 'merge-only',
        'nV_before': int(nV_before), 'nV_after': int(len(V_comp)),
        'nF_before': int(nF_before), 'nF_after': int(len(F_comp)),
        'vertices_merged': int(n_merged),
        'faces_dropped_degenerate': int(n_degen),
        'seam_mean_mm': float(np.mean(merge_distances_mm)) if merge_distances_mm else 0.0,
        'seam_max_mm':  float(np.max(merge_distances_mm))  if merge_distances_mm else 0.0,
        't_polish_s':   float(time.time() - t0),
    }

    return (V_comp, F_comp, uv_final, valid_merged, zl_merged, fa_comp,
            fn_comp, info)
