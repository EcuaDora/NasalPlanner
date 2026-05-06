"""
Препроцессинг меша перед сегментацией.

Шаги:
  1. Загрузка OBJ
  2. Чистка: слить дубли вершин, удалить вырожденные/дублированные грани
  3. Оставить ОДНУ компоненту (самую большую по числу граней)
  4. Упрощение: quadric edge collapse в 2 прохода (мягкий + доводка)
  5. Сглаживание: Taubin (lambda+/mu-) — сохраняет объём, не «съедает» детали
  6. Финальная чистка + повторно одна компонента
  7. Сохранение в *_clean.obj

Запуск:
    python preprocess.py Segment_6.obj
    python preprocess.py Segment_6.obj --ratio 0.5 --smooth 10
"""

import sys
import os
import argparse
import numpy as np
import trimesh
import pymeshlab as ml


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("input", help="входной .obj")
    ap.add_argument("-o", "--output", default=None, help="выходной .obj (default: <input>_clean.obj)")
    ap.add_argument("--ratio", type=float, default=0.5,
                    help="доля граней после упрощения (0.5 = половина). Default 0.5")
    ap.add_argument("--smooth", type=int, default=10,
                    help="число итераций Taubin сглаживания. Default 10")
    ap.add_argument("--no-smooth", action="store_true", help="отключить сглаживание")
    ap.add_argument("--no-decimate", action="store_true", help="отключить упрощение")
    return ap.parse_args()


def step(n, msg):
    print("\n[%d] %s" % (n, msg))


def main():
    args = parse_args()
    inp = args.input
    out = args.output or (os.path.splitext(inp)[0] + "_clean.obj")

    print("=" * 60)
    print("PREPROCESS: %s -> %s" % (inp, out))
    print("=" * 60)

    # ---------- 1. Загрузка ----------
    step(1, "Загрузка")
    mesh = trimesh.load(inp, force='mesh', process=False)
    print("  Исходный: %d V, %d F" % (len(mesh.vertices), len(mesh.faces)))

    # ---------- 2. Чистка ----------
    step(2, "Чистка топологии")
    mesh.merge_vertices()
    mesh.update_faces(mesh.unique_faces())
    mesh.update_faces(mesh.nondegenerate_faces())
    mesh.remove_unreferenced_vertices()
    print("  После чистки: %d V, %d F" % (len(mesh.vertices), len(mesh.faces)))

    # ---------- 3. Одна компонента ----------
    step(3, "Выделение главной компоненты")
    components = mesh.split(only_watertight=False)
    print("  Найдено компонент: %d" % len(components))
    if len(components) == 0:
        # Иногда split возвращает пусто, если меш «склеен». Берём весь меш.
        main = mesh
    else:
        main = max(components, key=lambda m: len(m.faces))
    print("  Главная: %d V, %d F" % (len(main.vertices), len(main.faces)))

    # ---------- 4-5. Pymeshlab: упрощение + сглаживание ----------
    ms = ml.MeshSet()
    ms.add_mesh(ml.Mesh(
        vertex_matrix=np.asarray(main.vertices, dtype=np.float64),
        face_matrix=np.asarray(main.faces, dtype=np.int32),
    ))

    faces_before = ms.current_mesh().face_number()

    if not args.no_decimate:
        step(4, "Упрощение (quadric edge collapse, 2 прохода)")
        target_final = max(int(faces_before * args.ratio), 500)
        target_mid = max(int(faces_before * (args.ratio + (1 - args.ratio) * 0.5)), target_final + 100)

        ms.meshing_decimation_quadric_edge_collapse(
            targetfacenum=target_mid,
            preservenormal=True,
            preserveboundary=True,
            preservetopology=True,
            optimalplacement=True,
            planarquadric=True,
        )
        print("  Проход 1: %d F" % ms.current_mesh().face_number())

        ms.meshing_decimation_quadric_edge_collapse(
            targetfacenum=target_final,
            preservenormal=True,
            preserveboundary=True,
            preservetopology=True,
            optimalplacement=True,
            planarquadric=True,
        )
        print("  Проход 2: %d F" % ms.current_mesh().face_number())
    else:
        step(4, "Упрощение пропущено (--no-decimate)")

    if not args.no_smooth and args.smooth > 0:
        step(5, "Сглаживание (Taubin, %d итераций)" % args.smooth)
        ms.apply_coord_taubin_smoothing(
            stepsmoothnum=args.smooth,
            lambda_=0.5,
            mu=-0.53,
        )
        print("  Готово")
    else:
        step(5, "Сглаживание пропущено")

    # ---------- 6. Финальная чистка ----------
    step(6, "Финальная чистка + одна компонента")
    V_out = ms.current_mesh().vertex_matrix()
    F_out = ms.current_mesh().face_matrix()
    final = trimesh.Trimesh(vertices=V_out, faces=F_out, process=False)
    final.merge_vertices()
    final.update_faces(final.unique_faces())
    final.update_faces(final.nondegenerate_faces())
    final.remove_unreferenced_vertices()

    components2 = final.split(only_watertight=False)
    if len(components2) > 1:
        print("  После сглаживания компонент: %d -> берём главную" % len(components2))
        final = max(components2, key=lambda m: len(m.faces))

    print("  Финал: %d V, %d F" % (len(final.vertices), len(final.faces)))

    # ---------- 7. Сохранение ----------
    step(7, "Сохранение")
    final.export(out)
    print("  -> %s" % out)
    print("=" * 60)
    print("Готово. Запусти сегментацию:")
    print("  python segment.py %s" % out)
    print("=" * 60)


if __name__ == "__main__":
    main()
