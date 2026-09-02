"""
Препроцессинг меша перед сегментацией.

Порядок (важен для гладкости и чистоты тонкого «кармана»):
  1. Загрузка OBJ
  2. Чистка топологии
  3. Одна компонента (крупнейшая)
  4. ИЗОТРОПНЫЙ REMESH (адаптивный) — равномерная гладкая сетка.
     Длина ребра считается из площади под целевое число граней.
     adaptive + ограничение репроекции (maxsurfdist) не дают вершинам
     на тонкой кромке «перепрыгивать» на противоположный лист → без шипов.
  5. REPAIR: убрать самопересечения, non-manifold, мелкие острова,
     переориентировать нормали, закрыть дырки (стирает «дротики» и борозды)
  6. Сглаживание Taubin
  7. REPAIR ещё раз (Taubin на тонких стенках мог создать самопересечения)
  8. Страховочный потолок граней (quadric, если remesh перелил)
  9. Финальная чистка + одна компонента, сохранение

Запуск:
    python preprocess.py Segment_6.obj
    python preprocess.py Segment_6.obj --target-faces 25000 --smooth 10
    python preprocess.py Segment_6.obj --no-remesh --ratio 0.5   # старый режим

Тонкость (почему были дефекты): объект — двустенный лист толщиной местами
1–2 вокселя. Remesh с ребром крупнее толщины путал листы: шипы по краю и
самопересекающиеся тёмные лоскуты. Лечится adaptive-remesh + repair.
"""

import sys
import os
import math
import argparse
import numpy as np
import trimesh
import pymeshlab as ml


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("input", help="входной .obj")
    ap.add_argument("-o", "--output", default=None, help="выходной .obj (default: <input>_clean.obj)")
    ap.add_argument("--target-faces", type=int, default=25000,
                    help="целевое число граней. 0 = без remesh, по --ratio. Default 25000")
    ap.add_argument("--min-faces", type=int, default=4000,
                    help="не опускаться ниже. Default 4000")
    ap.add_argument("--remesh-iters", type=int, default=3, help="итераций remesh. Default 3")
    ap.add_argument("--smooth-level", type=int, default=3,
                    help="ГЛАДКОСТЬ 0..4: 0 как есть · 1 лёгкое · 2 среднее · 3 сильное · 4 максимум. Default 3")
    ap.add_argument("--feature-deg", type=float, default=-1.0,
                    help="угол складки, которую remesh бережёт. -1 = взять из --smooth-level")
    ap.add_argument("--min-island", type=int, default=25,
                    help="удалять связные острова мельче N граней (убирает «дротики»). Default 25")
    ap.add_argument("--close-holes", type=int, default=3000,
                    help="макс. размер дырки (рёбер) для зашивания. Больше = закрывает длинные щели. Default 3000")
    ap.add_argument("--merge-close", type=float, default=0.1,
                    help="сшивать вершины ближе N%% диагонали bbox — лечит волосяные "
                         "трещины на стыке двух листов (несшитые совпадающие губы). "
                         "Порог мал, чтобы не схлопнуть тонкую стенку. 0 = выкл. Default 0.1")
    ap.add_argument("--selfintersect-fix", action="store_true",
                    help="УДАЛЯТЬ самопересекающиеся грани. По умолчанию НЕ удаляем: "
                         "удаление вырезает грани и на сложенном/тонком листе оставляет "
                         "ДЫРЫ и РАЗРЫВЫ (ровно то, что видно на этапе 1). Включать только "
                         "для заведомо чистых OBJ без складок.")
    ap.add_argument("--no-selfintersect-fix", action="store_true",
                    help="(устаревший no-op: самопересечения и так по умолчанию не трогаем)")
    ap.add_argument("--remesh", action="store_true",
                    help="включить изотропный remesh. По умолчанию ВЫКЛ — на уже-чистой "
                         "маске он репроецирует вершины на тонкий/дырчатый лист, СКЛАДЫВАЕТ "
                         "его → самопересечения → (после удаления) разрывы. Без него: "
                         "quadric-децимация + сглаживание, поверхность остаётся цела.")
    ap.add_argument("--no-remesh", action="store_true", help="без remesh: только quadric (старое)")
    ap.add_argument("--ratio", type=float, default=0.5,
                    help="доля граней для quadric-режима (если --no-remesh / target-faces 0). Default 0.5")
    ap.add_argument("--smooth", type=int, default=-1, help="итераций Taubin. -1 = взять из --smooth-level")
    ap.add_argument("--no-smooth", action="store_true", help="отключить сглаживание")
    ap.add_argument("--pre-smooth", type=int, default=12,
                    help="анти-террас: итераций Taubin ПЕРЕД remesh, на полной сетке. "
                         "Округляет ступеньки анизотропных срезов, пока featuredeg их "
                         "не залочил как «фичи». 0 = выкл. Default 12")
    ap.add_argument("--pre-hc", type=int, default=1,
                    help="доп. проходов HC-Laplacian перед remesh (сильнее давит террасы). Default 1")
    ap.add_argument("--no-decimate", action="store_true", help="отключить страховочную децимацию")
    ap.add_argument("--no-repair", action="store_true", help="отключить блок repair")
    return ap.parse_args()


def step(n, msg):
    print("\n[%s] %s" % (n, msg))


# Пресеты гладкости: уровень -> (Taubin, featuredeg, HC-проходов, face_scale)
# ВАЖНО: не укрупняем агрессивно — крупные плоские треугольники читаются как
# «квадратность». Держим ~25k граней, гладкость берём сглаживанием, а не вырезанием.
SMOOTH_LEVELS = {
    0: (0,   25, 0, 1.00),   # как есть
    1: (15,  45, 0, 1.00),   # лёгкое
    2: (30,  60, 1, 1.00),   # среднее
    3: (45,  70, 1, 0.90),   # сильное (по умолчанию)
    4: (70,  85, 2, 0.80),   # максимум
}


def _hc_smooth(ms, passes):
    """HC-Laplacian (Humphrey) — сильнее давит ступеньки, меньше усаживает, чем чистый Laplace."""
    for _ in range(int(passes)):
        _try(ms, "apply_coord_hc_laplacian_smoothing")


def _val(x):
    """Обернуть величину под тип pymeshlab (версии отличаются)."""
    if hasattr(ml, "AbsoluteValue"):
        return ml.AbsoluteValue(x)
    return x


def _edge_len_for_faces(area, target_faces):
    if area <= 0 or target_faces <= 0:
        return 1.0
    L = math.sqrt(4.0 * area / (math.sqrt(3.0) * target_faces))
    return float(min(max(L, 0.3), 3.0))   # мм: зажим 0.3..3.0


def _remesh(ms, L, iters, feature_deg):
    """Адаптивный изотропный remesh. Богатые параметры с деградацией по версии."""
    attempts = [
        dict(iterations=int(iters), adaptive=True, targetlen=_val(L),
             featuredeg=float(feature_deg),
             checksurfdist=True, maxsurfdist=_val(L * 0.7),
             splitflag=True, collapseflag=True, swapflag=True,
             smoothflag=True, reprojectflag=True),
        dict(iterations=int(iters), adaptive=True, targetlen=_val(L),
             featuredeg=float(feature_deg)),
        dict(iterations=int(iters), targetlen=_val(L)),
    ]
    last = None
    for kw in attempts:
        try:
            ms.meshing_isotropic_explicit_remeshing(**kw)
            return True
        except AttributeError:
            try:
                ms.apply_filter("remeshing_isotropic_explicit_remeshing",
                                iterations=int(iters), targetlen=_val(L))
                return True
            except Exception as e:
                last = e
        except Exception as e:
            last = e
    print("  Remesh недоступен (%s) — оставляю исходную сетку" % last)
    return False


def _try(ms, fname, **kw):
    """Вызвать фильтр pymeshlab, если он есть; при ошибке — без параметров; тихо пропустить."""
    fn = getattr(ms, fname, None)
    if fn is None:
        return False
    try:
        fn(**kw)
        return True
    except Exception:
        try:
            fn()
            return True
        except Exception as e:
            print("  repair «%s» пропущен: %s" % (fname, e))
            return False


def _merge_close(ms, pct):
    """Сшить губы волосяных трещин: слить вершины ближе pct%% диагонали bbox.
    Именно этого шага не хватало против «рваных линий» — на стыке двух листов
    remesh/децимация оставляют совпадающие, но НЕсшитые вершины; close_holes
    их не берёт (нет одиночной петли границы), а слияние — берёт.
    Порог держим маленьким: двустенный лист 1–2 вокселя схлопывать нельзя.
    Тип порога различается по версиям pymeshlab — пробуем варианты, БЕЗ
    падения на дефолт (там ~1%, что схлопнет стенку)."""
    if not pct or pct <= 0:
        return False
    for maker in ("PercentageValue", "Percentage"):
        cls = getattr(ml, maker, None)
        if cls is None:
            continue
        try:
            ms.meshing_merge_close_vertices(threshold=cls(pct))
            return True
        except Exception:
            pass
    try:
        ms.meshing_merge_close_vertices(threshold=pct)   # некоторые сборки берут float %
        return True
    except Exception as e:
        print("  merge_close пропущен: %s" % e)
        return False


def _repair(ms, min_island, close_holes, fix_selfintersect, merge_pct=0.1):
    """Non-manifold, мелкие острова, зашивание дырок. Удаление самопересечений
    — опционально (оно может распороть тонкий шов), по умолчанию выключено.
    merge_pct — сшивка волосяных трещин ДО ремонта (см. _merge_close)."""
    _try(ms, "meshing_re_orient_faces_coherently")
    _merge_close(ms, merge_pct)     # сначала сшить губы трещин, потом чинить/закрывать
    if fix_selfintersect:
        _try(ms, "meshing_remove_selfintersecting_faces")
    _try(ms, "meshing_repair_non_manifold_edges")
    _try(ms, "meshing_repair_non_manifold_vertices")
    _try(ms, "meshing_remove_null_faces")
    _try(ms, "meshing_remove_connected_component_by_face_number",
         mincomponentsize=int(min_island), removeunref=True)
    _try(ms, "meshing_remove_unreferenced_vertices")
    # два прохода: сначала крупные щели, потом мелкое
    _try(ms, "meshing_close_holes", maxholesize=int(close_holes), selfintersection=False)
    _try(ms, "meshing_close_holes", maxholesize=int(close_holes), selfintersection=False)
    _try(ms, "meshing_re_orient_faces_coherently")


def _quadric_to(ms, target, preserve_boundary=False):
    # preserveboundary=True раньше ЛОЧИЛ любые открытые края: интерьер
    # упрощался, а губы дырки оставались на месте → тонкие сливеры и
    # T-стыки вдоль щелей (те самые «разрывы»). После надёжного закрытия
    # дырок границу беречь незачем — ставим False, топологию бережём.
    ms.meshing_decimation_quadric_edge_collapse(
        targetfacenum=int(target),
        preservenormal=True, preserveboundary=bool(preserve_boundary),
        preservetopology=True,
        optimalplacement=True, planarquadric=True,
    )


def main():
    args = parse_args()
    inp = args.input
    out = args.output or (os.path.splitext(inp)[0] + "_clean.obj")

    # Гладкость: из уровня, но явные --smooth / --feature-deg перекрывают
    lvl = max(0, min(4, args.smooth_level))
    pre_taubin, pre_feat, pre_hc, pre_scale = SMOOTH_LEVELS[lvl]
    taubin_iters = args.smooth if args.smooth >= 0 else pre_taubin
    feat_deg = args.feature_deg if args.feature_deg >= 0 else pre_feat
    hc_passes = pre_hc
    # эффективное число граней: сильные уровни укрупняют сетку (легче сгладить террасы)
    target_faces_eff = max(args.min_faces, int(args.target_faces * pre_scale)) if args.target_faces > 0 else 0

    print("=" * 60)
    print("PREPROCESS: %s -> %s" % (inp, out))
    print("Гладкость: уровень %d (Taubin %d, featuredeg %.0f, HC %d, грани ~%d)"
          % (lvl, taubin_iters, feat_deg, hc_passes, target_faces_eff))
    print("=" * 60)

    step(1, "Загрузка")
    mesh = trimesh.load(inp, force='mesh', process=False)
    print("  Исходный: %d V, %d F" % (len(mesh.vertices), len(mesh.faces)))

    step(2, "Чистка топологии")
    mesh.merge_vertices()
    mesh.update_faces(mesh.unique_faces())
    mesh.update_faces(mesh.nondegenerate_faces())
    mesh.remove_unreferenced_vertices()
    print("  После чистки: %d V, %d F" % (len(mesh.vertices), len(mesh.faces)))

    step(3, "Выделение главной компоненты")
    components = mesh.split(only_watertight=False)
    print("  Найдено компонент: %d" % len(components))
    main_m = mesh if len(components) == 0 else max(components, key=lambda m: len(m.faces))
    print("  Главная: %d V, %d F" % (len(main_m.vertices), len(main_m.faces)))
    surf_area = float(main_m.area) if len(main_m.faces) else 0.0

    ms = ml.MeshSet()
    ms.add_mesh(ml.Mesh(
        vertex_matrix=np.asarray(main_m.vertices, dtype=np.float64),
        face_matrix=np.asarray(main_m.faces, dtype=np.int32),
    ))
    faces_before = ms.current_mesh().face_number()

    # Remesh по умолчанию ВЫКЛ (см. --remesh): на уже-чистой маске он складывает
    # тонкий лист и рвёт поверхность. Включается только явным --remesh.
    use_remesh = args.remesh and (not args.no_remesh) and args.target_faces and args.target_faces > 0

    step("3.5", "Анти-террас: сглаживание ДО remesh")
    # Террасы от анизотропных срезов (толстый z, напр. 1.25 мм против 0.49 мм в
    # плоскости) — это резкие ~90° вогнутые складки на границах срезов. Именно
    # они читаются как «разрывы». Если сгладить их ЗДЕСЬ, на полной сетке и ДО
    # remesh, то featuredeg (по умолч. 70°) не залочит их как «фичи», и remesh
    # их уберёт. Иначе remesh репроецирует прямо на террасы и «печёт» борозды.
    if not args.no_smooth and args.pre_smooth > 0:
        for _ in range(max(0, int(args.pre_hc))):
            _try(ms, "apply_coord_hc_laplacian_smoothing")
        try:
            ms.apply_coord_taubin_smoothing(stepsmoothnum=int(args.pre_smooth),
                                            lambda_=0.5, mu=-0.53)
            print("  pre-smooth: HC×%d + Taubin %d (складки-террасы сглажены до remesh)"
                  % (max(0, int(args.pre_hc)), int(args.pre_smooth)))
        except Exception as e:
            print("  pre-smooth пропущен: %s" % e)
    else:
        print("  Пропущен (--pre-smooth 0 / --no-smooth)")

    step(4, "Remesh")
    if use_remesh:
        L = _edge_len_for_faces(surf_area, target_faces_eff)
        print("  Площадь %.0f мм², ребро %.2f мм, adaptive, %d итер." % (surf_area, L, args.remesh_iters))
        if _remesh(ms, L, args.remesh_iters, feat_deg):
            print("  После remesh: %d F" % ms.current_mesh().face_number())
    else:
        print("  Пропущен (--no-remesh / target-faces 0)")

    step(5, "Repair (самопересечения, non-manifold, острова, дырки)")
    if args.no_repair:
        print("  Пропущен (--no-repair)")
    else:
        _repair(ms, args.min_island, args.close_holes, bool(args.selfintersect_fix), args.merge_close)
        print("  После repair: %d F" % ms.current_mesh().face_number())

    step(6, "Сглаживание (уровень %d)" % lvl)
    if not args.no_smooth and taubin_iters > 0:
        ms.apply_coord_taubin_smoothing(stepsmoothnum=int(taubin_iters), lambda_=0.5, mu=-0.53)
        print("  Taubin: %d итераций" % taubin_iters)
        if hc_passes > 0:
            _hc_smooth(ms, hc_passes)
            print("  HC-Laplacian: %d прох." % hc_passes)
    else:
        print("  Пропущено (уровень 0 / --no-smooth)")

    step(7, "Repair после сглаживания")
    if not args.no_repair:
        _repair(ms, args.min_island, args.close_holes, bool(args.selfintersect_fix), args.merge_close)
        print("  После repair: %d F" % ms.current_mesh().face_number())
    else:
        print("  Пропущен")

    step(8, "Страховочный потолок граней")
    now = ms.current_mesh().face_number()
    if args.target_faces and args.target_faces > 0:
        target_final = min(faces_before, target_faces_eff)
    else:
        target_final = int(faces_before * args.ratio)
    target_final = max(target_final, args.min_faces, 500)
    target_final = min(target_final, now)
    if args.no_decimate:
        print("  Отключено (--no-decimate)")
    elif now > int(target_final * 1.15):
        print("  quadric %d -> %d F" % (now, target_final))
        _quadric_to(ms, target_final)
        print("  После децимации: %d F" % ms.current_mesh().face_number())
    else:
        print("  Не нужен (%d F в пределах цели %d F)" % (now, target_final))

    step(9, "Финальная чистка + одна компонента")
    # Финальная сшивка+закрытие на самом ms: децимация (шаг 8) на тонком листе
    # могла приоткрыть швы. Делаем до передачи в trimesh, пока доступны фильтры
    # pymeshlab (merge_close берёт трещины, которые fill_holes из trimesh не видит).
    if not args.no_repair:
        _merge_close(ms, args.merge_close)
        _try(ms, "meshing_close_holes", maxholesize=int(args.close_holes), selfintersection=False)
        _try(ms, "meshing_re_orient_faces_coherently")
        print("  Финальная сшивка+закрытие: %d F" % ms.current_mesh().face_number())
    V_out = ms.current_mesh().vertex_matrix()
    F_out = ms.current_mesh().face_matrix()
    final = trimesh.Trimesh(vertices=V_out, faces=F_out, process=False)
    final.merge_vertices()
    final.update_faces(final.unique_faces())
    final.update_faces(final.nondegenerate_faces())
    final.remove_unreferenced_vertices()
    comps2 = final.split(only_watertight=False)
    if len(comps2) > 1:
        print("  Компонент: %d -> берём главную" % len(comps2))
        final = max(comps2, key=lambda m: len(m.faces))
    # страховка: дозакрыть оставшиеся дырки средствами trimesh
    try:
        if not final.is_watertight:
            trimesh.repair.fill_holes(final)
    except Exception:
        pass
    # диагностика: сколько граничных (открытых) рёбер осталось
    try:
        open_edges = int((trimesh.grouping.group_rows(
            final.edges_sorted, require_count=1)).shape[0])
    except Exception:
        open_edges = -1
    # диагностика террас: резкие вогнутые складки (их дно читается как «трещина»).
    # 96% таких на анизотропных данных сидят на границах срезов. Много складок =
    # террасирование осталось → поднять --pre-smooth / --pre-hc.
    try:
        ang = final.face_adjacency_angles
        conv = final.face_adjacency_convex
        creases = int(((ang > math.radians(55)) & (~conv)).sum())
    except Exception:
        creases = -1
    print("  Финал: %d V, %d F | watertight=%s | открытых рёбер=%s | резких складок=%s"
          % (len(final.vertices), len(final.faces),
             getattr(final, "is_watertight", "?"), open_edges, creases))

    final.export(out)
    print("  -> %s" % out)
    print("=" * 60)
    print("Готово. Запусти сегментацию:")
    print("  python segment.py %s" % out)
    print("=" * 60)


if __name__ == "__main__":
    main()
