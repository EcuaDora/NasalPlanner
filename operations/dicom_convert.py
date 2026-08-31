"""
operations/dicom_convert.py — собрать выбранную DICOM-серию в том ct_raw (.nrrd).

Контракт:
    NAME    = "dicom_convert"
    INPUTS  = []                     — файлы лежат в <session>/dicom_src
    OUTPUTS = ["ct_raw"]
    PARAMS  = {"python": "", "series_uid": ""}

После конвертации ct_raw становится таким же, как если бы врач загрузил
.nrrd напрямую — весь дальнейший пайплайн (infer → roi_pair → export_pair)
работает без изменений. Серия выбирается по series_uid (SeriesInstanceUID);
если пусто — берётся крупнейшая (поведение как авто-выбор в 3D Slicer).

Зависимые артефакты (mask_raw / roi_ct / roi_mask / train_pair) при загрузке
нового тома инвалидируются.
"""

import os

# переиспользуем резолв интерпретатора и поиск папки из dicom_series
from . import dicom_series as _ds

NAME = "dicom_convert"
INPUTS = []
OUTPUTS = ["ct_raw"]
PARAMS = {"python": "", "series_uid": ""}

_HELPER = os.path.join(os.path.dirname(__file__), "_dicom_helper.py")
_DEPENDENTS = ["mask_raw", "roi_ct", "roi_mask", "train_pair", "dicom_series_json"]


def run(session, params):
    progress = params.get("__progress__")
    py = _ds._resolve_python(params)
    series_uid = (params.get("series_uid") or "").strip()

    if progress:
        progress("Подготовка DICOM…")
    dicom_dir = _ds.dicom_dir(session)

    out_nrrd = session.reserve("ct_raw", ".nrrd")
    cmd = [py, _HELPER, "convert", dicom_dir, series_uid, out_nrrd]
    print("[dicom_convert] CMD:", " ".join(cmd), flush=True)
    _ds._run(cmd, progress)

    if not os.path.exists(out_nrrd):
        raise RuntimeError("серия не сконвертирована в NRRD")
    session.register("ct_raw", out_nrrd)

    # новый том — прежние результаты больше не валидны
    for k in _DEPENDENTS:
        try:
            session.delete(k)
        except Exception:
            pass
