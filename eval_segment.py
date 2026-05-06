"""
eval_segment.py — оценка алгоритма выделения внутренней слизистой
против ручной ground-truth от врача.

Usage:
    python eval_segment.py /path/to/folder_with_objs
    # или
    python eval_segment.py .  # текущая папка

Ожидает пары файлов в указанной папке:
    selected_object_cleanN.obj  — вход (замкнутое «седло» из 3D Slicer)
    mucosaN.obj                  — ground-truth (желаемая внутренняя поверхность)
где N — число-идентификатор (2, 3, 4, 6, 7, 9, …).

Алгоритм сопоставления фейсов: для каждого фейса ВХОДНОГО меша ищем
ближайший центроид фейса GT в пределах tol_mm мм. Если есть — фейс
считается «positive в GT». То же для предсказания (здесь тождественно,
т.к. предсказание — подмножество фейсов входного меша).

Метрики:
    Precision = TP / (TP + FP)  — из предсказанных сколько в GT
    Recall    = TP / (TP + FN)  — из GT сколько поймано
    F1        = 2PR / (P+R)
    IoU       = TP / (TP + FP + FN)
    AreaErr%  = |Area_pred - Area_gt| / Area_gt * 100
"""
import os
import sys
import glob
import re
import time
import numpy as np
import trimesh
from scipy.spatial import cKDTree

# Пути ищем относительно этого файла, чтобы можно было импортировать
# segment.py из рабочей папки.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import segment   #обновлённый алгоритм


# ─── Fake session для запуска segment.run без полного бэкенда ──────
class _FakeSession:
    def __init__(self, in_path, out_path):
        self._paths = {"mesh_clean": in_path}
        self._out_path = out_path

    def path(self, key):
        return self._paths[key]

    def reserve(self, key, ext):
        return self._out_path

    def register(self, key, p):
        self._paths[key] = p

    def has(self, key):
        return key in self._paths


# ─── Per-face IoU через ближайший центроид ─────────────────────────
def _gt_face_mask(input_mesh, gt_mesh, tol_mm=1.0):
    """Mask на фейсах input_mesh: True, если рядом есть фейс из gt_mesh."""
    if len(gt_mesh.faces) == 0:
        return np.zeros(len(input_mesh.faces), dtype=bool)
    gt_c = gt_mesh.triangles_center
    in_c = input_mesh.triangles_center
    tree = cKDTree(gt_c)
    d, _ = tree.query(in_c, k=1, distance_upper_bound=tol_mm)
    return np.isfinite(d)


def _pred_face_mask(input_mesh, pred_mesh, tol_mm=1e-3):
    """Mask на фейсах input_mesh: True, если этот фейс есть в pred_mesh
    (предсказание — submesh исходного, центроиды совпадают с точностью
    до float)."""
    if len(pred_mesh.faces) == 0:
        return np.zeros(len(input_mesh.faces), dtype=bool)
    pr_c = pred_mesh.triangles_center
    in_c = input_mesh.triangles_center
    tree = cKDTree(pr_c)
    d, _ = tree.query(in_c, k=1, distance_upper_bound=tol_mm)
    return np.isfinite(d)


def _metrics(pred, gt):
    tp = int(np.sum(pred & gt))
    fp = int(np.sum(pred & ~gt))
    fn = int(np.sum(~pred & gt))
    tn = int(np.sum(~pred & ~gt))
    P = tp / max(tp + fp, 1)
    R = tp / max(tp + fn, 1)
    F1 = 2 * P * R / max(P + R, 1e-12)
    IoU = tp / max(tp + fp + fn, 1)
    return dict(TP=tp, FP=fp, FN=fn, TN=tn,
                Precision=P, Recall=R, F1=F1, IoU=IoU)


def _area(mesh):
    return float(mesh.area) if len(mesh.faces) else 0.0


def run_one(input_path, gt_path, params=None, tol_mm=1.0, work_dir=None):
    input_mesh = trimesh.load(input_path, force="mesh", process=False)
    gt_mesh    = trimesh.load(gt_path,    force="mesh", process=False)

    work_dir = work_dir or os.path.dirname(input_path)
    pred_path = os.path.join(work_dir, "_pred_" + os.path.basename(input_path))

    # segment.run ожидает session с mesh_clean
    sess = _FakeSession(input_path, pred_path)
    t0 = time.time()
    segment.run(sess, {**segment.PARAMS, **(params or {})})
    dt = time.time() - t0

    pred_mesh = trimesh.load(pred_path, force="mesh", process=False)

    gt_mask   = _gt_face_mask(input_mesh, gt_mesh, tol_mm=tol_mm)
    pred_mask = _pred_face_mask(input_mesh, pred_mesh)

    m = _metrics(pred_mask, gt_mask)
    m["time_s"]     = dt
    m["nF_input"]   = len(input_mesh.faces)
    m["nF_gt"]      = len(gt_mesh.faces)
    m["nF_pred"]    = len(pred_mesh.faces)
    m["area_gt"]    = _area(gt_mesh)
    m["area_pred"]  = _area(pred_mesh)
    m["area_err_%"] = 100.0 * abs(m["area_pred"] - m["area_gt"]) / max(m["area_gt"], 1e-9)
    return m


def main(folder, params=None):
    # Находим все пары по N из имени
    cleans = sorted(glob.glob(os.path.join(folder, "selected_object_clean*.obj")))
    rows = []
    for cp in cleans:
        name = os.path.basename(cp)
        mobj = re.search(r"clean(\d+)\.obj$", name)
        if not mobj:
            continue
        n = mobj.group(1)
        gp = os.path.join(folder, f"mucosa{n}.obj")
        if not os.path.isfile(gp):
            print(f"[skip] нет {gp}")
            continue
        print(f"[pair {n}] {os.path.basename(cp)}  ↔  {os.path.basename(gp)}")
        try:
            m = run_one(cp, gp, params=params)
            m["pair"] = n
            rows.append(m)
            print(f"   F1={m['F1']:.3f}  IoU={m['IoU']:.3f}  "
                  f"P={m['Precision']:.3f}  R={m['Recall']:.3f}  "
                  f"areaErr={m['area_err_%']:.1f}%  "
                  f"{m['nF_pred']}/{m['nF_gt']} фейсов  ({m['time_s']:.1f} с)")
        except Exception as e:
            print(f"   [error] {e}")

    if not rows:
        print("\nНи одной пары не обработано.")
        return

    # Сводка
    keys = ["F1", "IoU", "Precision", "Recall", "area_err_%", "time_s"]
    print("\n╔═════════ Summary ══════════╗")
    print(f"  pairs = {len(rows)}")
    for k in keys:
        vals = [r[k] for r in rows]
        print(f"  {k:12s}  mean={np.mean(vals):.3f}  "
              f"median={np.median(vals):.3f}  "
              f"min={np.min(vals):.3f}  max={np.max(vals):.3f}")
    print("╚════════════════════════════╝")


if __name__ == "__main__":
    folder = sys.argv[1] if len(sys.argv) > 1 else "."
    # можно передать подкрутку параметров как --margin 1.0 и т.п.
    # для MVP — просто прогон с дефолтами:
    main(folder)
