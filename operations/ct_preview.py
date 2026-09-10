"""
operations/ct_preview.py — уменьшенный предпросмотр ct_raw для выбора области.

ЗАЧЕМ. Врач иногда размечает не ту ноздрю, которую предложила модель, и ему
нужно указать область самому — кубом. Куб надо где-то рисовать, а полный КТ в
браузер не тянут: ровно поэтому в пайплайне и существует ROI.

ПОЧЕМУ НЕ ГОДИТСЯ ГОТОВОЕ ПРЕВЬЮ СЕРИИ (dicom_preview). Две причины, и каждой
достаточно.

  1. Оно строится из DICOM с DICOMOrient(img, "LPS"), а mode_convert, который
     делает ct_raw, ориентацию не меняет. Оси у двух томов совпадают не всегда,
     и куб, нарисованный на превью серии, поехал бы при переносе в ct_raw. Молча:
     на одних сериях сходилось бы, на других нет.

  2. ct_raw приходит не только из DICOM. Через ct-loader.js врач может открыть
     готовый .nrrd, и превью серии тогда не существует вовсе.

Поэтому превью считаем ИЗ САМОГО ct_raw. Индексы превью — это индексы ct_raw,
прореженные целым шагом, поэтому доли по осям переносятся обратно без всякой
геометрии: доля 0.4 по x означает 0.4 по x и в полном томе. Ошибиться негде.

Контракт:
    INPUTS  = ["ct_raw"]
    OUTPUTS = ["ct_preview_vol", "ct_preview_json"]
    PARAMS  = {"max_side": 192, "level": 300.0, "width": 2000.0}

ct_preview_json = {"volume": key, "dims": [X, Y, Z], "spacing": [sx, sy, sz],
                   "full_dims": [X, Y, Z]}

Байты тома — uint8, порядок как у (z, y, x) в C-порядке: x меняется быстрее
всего. Браузер читает как vol[x + X*y + X*Y*z] — тот же порядок, что у превью
серии, чтобы рисующий код был один на оба случая.
"""

import json
import os

import numpy as np

from .roi_pair import read_nrrd


NAME = "ct_preview"
INPUTS = ["ct_raw"]
OUTPUTS = ["ct_preview_vol", "ct_preview_json"]
PARAMS = {
    "max_side": 192,     # максимум вокселей по любой оси после прореживания
    "level": 300.0,      # костное окно, как в превью серии — кость видна уверенно
    "width": 2000.0,
}


def _spacing_from_header(header):
    """Модуль векторов space directions → мм на воксель.

    Порядок в NRRD — по возрастанию скорости изменения индекса: строка 0 это
    ось X (самая быстрая), дальше Y, дальше Z. Массив при этом (z, y, x), и
    перепутать эти два порядка здесь очень легко — возвращаем явно (sx, sy, sz)
    и подписываем на месте вызова.
    """
    sd = header.get("space directions")
    if sd is None or len(sd) == 0:
        return 1.0, 1.0, 1.0
    out = []
    for v in sd:
        if v is None:
            out.append(1.0)
            continue
        n = float(np.linalg.norm(np.asarray(v, dtype=float)))
        out.append(n if n > 0 else 1.0)
    while len(out) < 3:
        out.append(1.0)
    return out[0], out[1], out[2]     # sx, sy, sz


def run(session, params):
    progress = params.get("__progress__") or (lambda m: None)
    p = {**PARAMS, **(params or {})}

    ct_path = session.path("ct_raw")
    if ct_path is None:
        raise ValueError("session требует ct_raw")

    progress("Чтение КТ…")
    ct, ct_h = read_nrrd(ct_path)          # (z, y, x)
    if ct.ndim != 3:
        raise RuntimeError(f"ожидался трёхмерный том, получено {ct.ndim}D")
    nz, ny, nx = ct.shape

    progress("Уменьшение…")
    max_side = max(16, int(p["max_side"]))

    def _idx(n):
        step = max(1, int(np.ceil(n / float(max_side))))
        return np.arange(0, n, step)

    zi, yi, xi = _idx(nz), _idx(ny), _idx(nx)
    small = ct[np.ix_(zi, yi, xi)].astype(np.float32, copy=False)

    # костное окно → uint8
    lo = float(p["level"]) - float(p["width"]) / 2.0
    rng = float(p["width"]) or 1.0
    u8 = np.clip((small - lo) / rng, 0.0, 1.0) * 255.0
    u8 = u8.astype(np.uint8, copy=False)
    sz_, sy_, sx_ = u8.shape

    # спейсинг с учётом прореживания — чтобы пропорции в браузере были верные
    spx, spy, spz = _spacing_from_header(ct_h)
    esz = spz * (nz / max(1, sz_))
    esy = spy * (ny / max(1, sy_))
    esx = spx * (nx / max(1, sx_))

    progress("Сохранение превью…")
    out_vol = session.reserve("ct_preview_vol", ".u8")
    with open(out_vol, "wb") as fh:
        fh.write(u8.tobytes(order="C"))
    session.register("ct_preview_vol", out_vol)

    out_json = session.reserve("ct_preview_json", ".json")
    with open(out_json, "w", encoding="utf-8") as fh:
        json.dump({
            "volume": "ct_preview_vol",
            # порядок [X, Y, Z] — как ждёт рисующий код на фронте
            "dims": [int(sx_), int(sy_), int(sz_)],
            "spacing": [float(esx), float(esy), float(esz)],
            "full_dims": [int(nx), int(ny), int(nz)],
        }, fh, ensure_ascii=False)
    session.register("ct_preview_json", out_json)

    progress(f"Превью готово: {sx_}×{sy_}×{sz_}")
