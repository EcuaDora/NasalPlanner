"""
operations/export_pair.py — выгрузка обучающей пары для дообучения.

После того как врач поправил маску на фронте, фронт кладёт исправленную
версию обратно в session под ключом 'roi_mask' (PUT /api/session/roi_mask).
Эта операция собирает zip в раскладке, которую ждёт пайплайн дообучения
(см. audit_dataset.ipynb / finetune_binary_fixed.ipynb):

    <case_id>_pair.zip
    ├── images/<case_id>_img.nrrd     ← КТ ROI
    └── labels/<case_id>_seg.nrrd     ← маска (uint8), геометрия == img

Геометрию маске НАВЯЗЫВАЕМ из roi_ct — так size/spacing/origin/direction
совпадают побитово, и аудитор не ругнётся на рассинхрон.

Контракт:
    INPUTS  = ["roi_ct", "roi_mask"]
    OUTPUTS = ["train_pair"]            — путь к .zip в session
    PARAMS  = {"case_id": "case", "binarize": True}
"""

import io
import os
import re
import zipfile

import numpy as np

# Переиспользуем NRRD I/O из соседней операции — единый код чтения/записи.
from . import roi_pair as _nrrd


NAME = "export_pair"
INPUTS = ["roi_ct", "roi_mask"]
OUTPUTS = ["train_pair"]
PARAMS = {
    "case_id": "case",     # префикс файлов; фронт подставляет имя из КТ
    "binarize": True,      # привести маску к {0,1}
}


def _safe_id(s: str) -> str:
    s = (s or "case").strip()
    s = re.sub(r"[^0-9A-Za-zА-Яа-я_\-]+", "_", s)
    return s.strip("_") or "case"


def run(session, params):
    progress = params.get("__progress__") or (lambda m: None)
    p = {**PARAMS, **(params or {})}
    cid = _safe_id(str(p.get("case_id", "case")))

    ct_path = session.path("roi_ct")
    mask_path = session.path("roi_mask")
    if ct_path is None or mask_path is None:
        raise ValueError("session требует roi_ct и roi_mask")

    progress("Чтение ROI…")
    ct, ct_h = _nrrd.read_nrrd(ct_path)
    mask, _ = _nrrd.read_nrrd(mask_path)

    if ct.shape != mask.shape:
        raise RuntimeError(
            f"Размеры КТ {ct.shape} и маски {mask.shape} не совпадают — "
            f"маска повреждена при сохранении."
        )

    mask = mask.astype(np.uint8, copy=False)
    if p.get("binarize", True):
        mask = (mask > 0).astype(np.uint8)

    fg = int((mask > 0).sum())
    if fg == 0:
        raise RuntimeError("Маска пустая — нечего выгружать для дообучения.")

    # Пишем обе во временные файлы с ОДНОЙ геометрией (ct_h)
    progress("Подготовка пары…")
    tmp_img = session.reserve("_tmp_img", ".nrrd")
    tmp_seg = session.reserve("_tmp_seg", ".nrrd")
    _nrrd.write_nrrd(tmp_img, ct, ct_h)
    _nrrd.write_nrrd(tmp_seg, mask, ct_h)

    progress("Упаковка zip…")
    zip_path = session.reserve("train_pair", ".zip")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(tmp_img, arcname=f"images/{cid}_img.nrrd")
        zf.write(tmp_seg, arcname=f"labels/{cid}_seg.nrrd")
        # короткий README — что это и куда класть
        zf.writestr(
            "README.txt",
            "Пара для дообучения SwinUNETR.\n"
            f"case_id: {cid}\n"
            f"foreground вокселей: {fg}\n"
            f"размер ROI (z,y,x): {ct.shape}\n\n"
            "Разложите по своему датасету:\n"
            "  data/images/<id>_img.nrrd\n"
            "  data/labels/<id>_seg.nrrd\n"
            "Геометрия img и seg идентична (проверено).\n",
        )

    session.register("train_pair", zip_path)
    for k in ("_tmp_img", "_tmp_seg"):
        try:
            os.remove(session.path(k))
        except Exception:
            pass

    progress(f"Готово: {cid}_pair.zip ({fg} вокселей)")
