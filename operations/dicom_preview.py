"""
operations/dicom_preview.py — уменьшенный объём выбранной серии для окна выбора.

Контракт:
    NAME    = "dicom_preview"
    INPUTS  = []
    OUTPUTS = ["dicom_preview_json"]
    PARAMS  = {"python": "", "series_uid": ""}

Кладёт <prefix>.u8 (сырой uint8 том z,y,x) в session и пишет
dicom_preview_json {volume:key, dims:[X,Y,Z], spacing:[sx,sy,sz]}.
Браузер скачивает том один раз и листает срезы локально (как в Slicer).
prefix зависит от series_uid — тома разных серий не перетираются (кеш валиден).
"""

import os
import hashlib
from . import dicom_series as _ds

NAME = "dicom_preview"
INPUTS = []
OUTPUTS = ["dicom_preview_json"]
PARAMS = {"python": "", "series_uid": ""}

_HELPER = os.path.join(os.path.dirname(__file__), "_dicom_helper.py")


def run(session, params):
    import json
    progress = params.get("__progress__")
    py = _ds._resolve_python(params)
    series_uid = (params.get("series_uid") or "").strip()
    d = _ds.dicom_dir(session)

    tag = hashlib.md5((series_uid or "default").encode("utf-8")).hexdigest()[:8]
    prefix = "pv" + tag
    out_dir = session.dir

    u8 = os.path.join(out_dir, prefix + ".u8")
    meta_p = os.path.join(out_dir, prefix + ".json")
    err_p = os.path.join(out_dir, prefix + ".err")

    # Кеш ОШИБКИ: серия уже признана несобираемой — не считаем заново,
    # сразу возвращаем понятную причину (radial / нестандартная геометрия).
    if os.path.exists(err_p):
        try:
            with open(err_p, "r", encoding="utf-8") as fh:
                why = fh.read().strip()
        except OSError:
            why = ""
        raise _ds._ExpectedSeriesError(why or "Эта серия не собирается в объём.")

    # Кеш УСПЕХА: том уже сформирован для этой серии — пропускаем пересчёт.
    if not (os.path.exists(u8) and os.path.exists(meta_p)):
        cmd = [py, _HELPER, "preview", d, series_uid, out_dir, prefix]
        print("[dicom_preview] CMD:", " ".join(cmd), flush=True)
        try:
            _ds._run(cmd, progress)
        except _ds._ExpectedSeriesError as e:
            # запоминаем причину — больше эту серию не пересчитываем
            try:
                with open(err_p, "w", encoding="utf-8") as fh:
                    fh.write(str(e))
            except OSError:
                pass
            raise

    if not os.path.exists(u8) or not os.path.exists(meta_p):
        raise RuntimeError("объём превью не сформирован")

    with open(meta_p, "r", encoding="utf-8") as fh:
        meta = json.load(fh)

    key = prefix + "_vol"
    session.register(key, u8)

    out = session.reserve("dicom_preview_json", ".json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump({"volume": key, "dims": meta["dims"], "spacing": meta["spacing"]},
                  fh, ensure_ascii=False)
    session.register("dicom_preview_json", out)
