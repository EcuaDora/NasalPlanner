"""
operations/roi_pair.py — обрезка КТ и маски в один выровненный ROI.

ЗАЧЕМ. Модель пишет маску в геометрии ИСХОДНОГО КТ (полный том). Для двух
вещей нам нужен ROI вокруг сегментации:

  1) Редактирование на фронте — грузить и крутить полноразмерный КТ в браузере
     тяжело; ROI (~90×120×80 мм) лёгкий.
  2) Дообучение — паре (img, seg) нужна ИДЕНТИЧНАЯ геометрия (size/spacing/
     origin/direction), это требование audit_dataset.ipynb. Если резать КТ и
     маску ОДНИМ И ТЕМ ЖЕ индексным окном — геометрия совпадает побитово.

Контракт:
    INPUTS  = ["ct_raw"]               (mask_raw — по режиму, см. run)
    OUTPUTS = ["roi_ct", "roi_mask"]   — оба в одинаковой сетке
    PARAMS  = {"padding_mm": 8.0, "box": None, "mask_mode": "model"}

NRRD читаем/пишем без сторонних зависимостей (только numpy + stdlib).
Поддержаны encoding: raw, gzip; типы: uint8/int16/uint16/int32/uint32/
float/double; attached-данные (заголовок и данные в одном файле).
"""

import gzip
import os
import re

import numpy as np


NAME = "roi_pair"
# mask_raw НЕ в INPUTS намеренно: при ручном выборе области инференс может не
# запускаться вовсе. Наличие маски проверяется в run() по режиму — иначе
# диспетчер отклонял бы сценарий с пустой маской ещё до вызова.
INPUTS = ["ct_raw"]
OUTPUTS = ["roi_ct", "roi_mask"]
PARAMS = {
    "padding_mm": 8.0,   # отступ вокруг bbox маски (когда область ищем по ней)
    # Куб врача: доли 0..1 по осям, {"x0":..,"x1":..,"y0":..,"y1":..,"z0":..,"z1":..}.
    # None → область ищется по bbox маски, как раньше.
    "box": None,
    # "model" — внутри области берём предсказание модели (нужен mask_raw);
    # "empty" — маска нулевая, врач красит сам (mask_raw не нужен).
    "mask_mode": "model",
}



_NRRD_TYPE_TO_NP = {
    "signed char": np.int8, "int8": np.int8, "int8_t": np.int8,
    "uchar": np.uint8, "unsigned char": np.uint8, "uint8": np.uint8, "uint8_t": np.uint8,
    "short": np.int16, "short int": np.int16, "signed short": np.int16,
    "signed short int": np.int16, "int16": np.int16, "int16_t": np.int16,
    "ushort": np.uint16, "unsigned short": np.uint16, "unsigned short int": np.uint16,
    "uint16": np.uint16, "uint16_t": np.uint16,
    "int": np.int32, "signed int": np.int32, "int32": np.int32, "int32_t": np.int32,
    "uint": np.uint32, "unsigned int": np.uint32, "uint32": np.uint32, "uint32_t": np.uint32,
    "longlong": np.int64, "long long": np.int64, "int64": np.int64, "int64_t": np.int64,
    "float": np.float32, "double": np.float64,
}
_NP_TO_NRRD_TYPE = {
    np.dtype(np.int8): "signed char", np.dtype(np.uint8): "unsigned char",
    np.dtype(np.int16): "short", np.dtype(np.uint16): "unsigned short",
    np.dtype(np.int32): "int", np.dtype(np.uint32): "unsigned int",
    np.dtype(np.int64): "long long", np.dtype(np.float32): "float",
    np.dtype(np.float64): "double",
}


def _parse_vectors(text):
    """'(a,b,c) (d,e,f) ...' → np.array([[a,b,c],[d,e,f],...]) (float)."""
    out = []
    for grp in re.findall(r"\(([^)]*)\)", text):
        out.append([float(x) for x in grp.split(",")])
    return np.array(out, dtype=np.float64)


def read_nrrd(path):
    """Читает NRRD. Возвращает (arr_zyx, header_dict).

    arr_zyx — numpy-массив в порядке осей (z, y, x), т.е. arr[z, y, x].
    (В NRRD первая ось меняется быстрее всего — это x; C-reshape (Z,Y,X)
    даёт ровно такой layout.)
    """
    with open(path, "rb") as fh:
        blob = fh.read()

    # Заголовок отделён от данных пустой строкой. Учитываем \n и \r\n.
    sep = blob.find(b"\n\n")
    sep_len = 2
    crlf = blob.find(b"\r\n\r\n")
    if crlf != -1 and (sep == -1 or crlf < sep):
        sep, sep_len = crlf, 4
    if sep == -1:
        raise ValueError(f"NRRD: не найден конец заголовка в {path}")

    header_text = blob[:sep].decode("utf-8", "replace")
    data_bytes = blob[sep + sep_len:]

    H = {}
    for line in header_text.splitlines():
        if not line or line.startswith("#") or line.upper().startswith("NRRD"):
            continue
        if ":=" in line:           # key-value field (метаданные Slicer)
            k, v = line.split(":=", 1)
            H[k.strip()] = v.strip()
        elif ":" in line:          # field
            k, v = line.split(":", 1)
            H[k.strip()] = v.strip()

    np_type = _NRRD_TYPE_TO_NP.get(H.get("type", "").lower())
    if np_type is None:
        raise ValueError(f"NRRD: неподдерживаемый type='{H.get('type')}'")

    sizes = [int(x) for x in H["sizes"].split()]
    if len(sizes) != 3:
        raise ValueError(f"NRRD: ожидается 3D, sizes={sizes}")
    X, Y, Z = sizes  # NRRD порядок: ось0=X (fastest), ось1=Y, ось2=Z

    encoding = H.get("encoding", "raw").lower()
    if encoding in ("gzip", "gz"):
        data_bytes = gzip.decompress(data_bytes)
    elif encoding == "raw":
        pass
    else:
        raise ValueError(f"NRRD: encoding '{encoding}' не поддержан (raw/gzip)")

    dtype = np.dtype(np_type)
    endian = H.get("endian", "little").lower()
    if dtype.itemsize > 1:
        dtype = dtype.newbyteorder("<" if endian == "little" else ">")

    count = X * Y * Z
    arr = np.frombuffer(data_bytes[: count * dtype.itemsize], dtype=dtype)
    if arr.size != count:
        raise ValueError(f"NRRD: данных {arr.size}, ожидалось {count} в {path}")
    # fastest=x → reshape (Z,Y,X) в C-порядке даёт arr[z,y,x]
    arr = arr.reshape(Z, Y, X).astype(np_type, copy=True)  # нативный порядок байт

    H["_sizes_xyz"] = (X, Y, Z)
    H["space directions"] = _parse_vectors(H.get("space directions", ""))
    H["space origin"] = (
        _parse_vectors(H.get("space origin", "(0,0,0)"))[0]
        if "space origin" in H else np.zeros(3)
    )
    return arr, H


def write_nrrd(path, arr_zyx, header):
    """Пишет NRRD raw little-endian. Геометрия берётся из header
    ('space directions' (3×3), 'space origin' (3,), 'space')."""
    arr = np.ascontiguousarray(arr_zyx)
    Z, Y, X = arr.shape
    dtype = arr.dtype.newbyteorder("=")
    arr = arr.astype(dtype, copy=False)

    type_name = _NP_TO_NRRD_TYPE.get(np.dtype(arr.dtype.str.lstrip("<>=|")), None)
    if type_name is None:
        type_name = _NP_TO_NRRD_TYPE.get(np.dtype(arr.dtype), "short")

    sd = np.asarray(header["space directions"], dtype=np.float64)
    org = np.asarray(header["space origin"], dtype=np.float64).ravel()
    space = header.get("space", "left-posterior-superior")

    def vec(v):
        return "(" + ",".join(f"{x:.10g}" for x in v) + ")"

    lines = [
        "NRRD0004",
        "# saved by nasal-planner roi_pair",
        f"type: {type_name}",
        "dimension: 3",
        f"space: {space}",
        f"sizes: {X} {Y} {Z}",
        "space directions: " + " ".join(vec(sd[i]) for i in range(3)),
        "kinds: domain domain domain",
        "endian: little",
        "encoding: raw",
        "space origin: " + vec(org),
    ]
    head = ("\n".join(lines) + "\n\n").encode("ascii")

    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(head)
        fh.write(arr.tobytes(order="C"))  # x fastest


# ─────────────────────────────────────────────────────────────────────
# Геометрический кроп
# ─────────────────────────────────────────────────────────────────────

def _bbox_with_padding(mask_zyx, header, padding_mm):
    """bbox foreground'а маски + padding (в мм → воксели по каждой оси).
    Возвращает срезы (z0,z1,y0,y1,x0,x1) в полуинтервалах [lo, hi)."""
    nz = np.argwhere(mask_zyx > 0)
    if nz.size == 0:
        raise RuntimeError(
            "Маска пустая — модель ничего не нашла. Проверьте, что КТ "
            "охватывает зону носа/пазух, и попробуйте ещё раз."
        )
    z0, y0, x0 = nz.min(axis=0)
    z1, y1, x1 = nz.max(axis=0) + 1  # полуинтервал

    # spacing по осям = нормы столбцов space directions (ось0=X, ось1=Y, ось2=Z)
    sd = np.asarray(header["space directions"], dtype=np.float64)
    sx = np.linalg.norm(sd[0]) or 1.0
    sy = np.linalg.norm(sd[1]) or 1.0
    sz = np.linalg.norm(sd[2]) or 1.0
    px = int(round(padding_mm / sx))
    py = int(round(padding_mm / sy))
    pz = int(round(padding_mm / sz))

    Z, Y, X = mask_zyx.shape
    z0 = max(0, z0 - pz); z1 = min(Z, z1 + pz)
    y0 = max(0, y0 - py); y1 = min(Y, y1 + py)
    x0 = max(0, x0 - px); x1 = min(X, x1 + px)
    return int(z0), int(z1), int(y0), int(y1), int(x0), int(x1)


def _crop(arr_zyx, header, box):
    """Кроп массива + сдвиг space origin. Возвращает (arr, new_header)."""
    z0, z1, y0, y1, x0, x1 = box
    sub = arr_zyx[z0:z1, y0:y1, x0:x1].copy()

    sd = np.asarray(header["space directions"], dtype=np.float64)
    org = np.asarray(header["space origin"], dtype=np.float64).ravel()
    # origin сдвигается на (x0*dir0 + y0*dir1 + z0*dir2)
    new_org = org + x0 * sd[0] + y0 * sd[1] + z0 * sd[2]

    new_header = {
        "space": header.get("space", "left-posterior-superior"),
        "space directions": sd.copy(),
        "space origin": new_org,
    }
    return sub, new_header


def _box_from_fractions(frac, shape):
    """Куб, заданный долями 0..1 по каждой оси → срезы (z0,z1,y0,y1,x0,x1).

    Доли, а не воксели, потому что рисуют куб на прореженном превью
    (ct_preview), а применяем к полному ct_raw. Доля от прореживания не
    зависит: превью берётся шагом от нуля и покрывает тот же объём, поэтому
    0.4 по x означает 0.4 по x и здесь. Пересчитывать через мм не нужно, и
    геометрию сопоставлять тоже — а значит негде и ошибиться.
    """
    Z, Y, X = shape

    def _span(lo_key, hi_key, n):
        lo = float(frac.get(lo_key, 0.0))
        hi = float(frac.get(hi_key, 1.0))
        if hi < lo:
            lo, hi = hi, lo
        i0 = int(np.floor(max(0.0, min(1.0, lo)) * n))
        i1 = int(np.ceil(max(0.0, min(1.0, hi)) * n))
        i0 = max(0, min(n - 1, i0))
        i1 = max(i0 + 1, min(n, i1))
        return i0, i1

    z0, z1 = _span("z0", "z1", Z)
    y0, y1 = _span("y0", "y1", Y)
    x0, x1 = _span("x0", "x1", X)
    return z0, z1, y0, y1, x0, x1


def run(session, params):
    progress = params.get("__progress__") or (lambda m: None)
    p = {**PARAMS, **(params or {})}

    ct_path = session.path("ct_raw")
    if ct_path is None:
        raise ValueError("session требует ct_raw")

    box_frac = p.get("box") or None
    mask_mode = str(p.get("mask_mode") or "model").strip()

    progress("Чтение КТ…")
    ct, ct_h = read_nrrd(ct_path)

    # ── Маска: от модели или пустая ───────────────────────────────────
    #
    # mask_raw больше не в INPUTS: при ручном выборе области врач может
    # вообще не запускать инференс, и требовать маску на входе значило бы
    # запрещать сценарий, ради которого куб и появился. Поэтому проверяем
    # здесь и по режиму — с внятным сообщением, а не «missing inputs».
    mask = None
    mask_h = None
    if mask_mode != "empty":
        mask_path = session.path("mask_raw")
        if mask_path is None:
            raise ValueError(
                "session требует mask_raw: сначала инференс, либо "
                "передайте mask_mode='empty' для разметки с нуля"
            )
        progress("Чтение маски…")
        mask, mask_h = read_nrrd(mask_path)
        if ct.shape != mask.shape:
            raise RuntimeError(
                f"Геометрия КТ {ct.shape} и маски {mask.shape} не совпадают. "
                f"Маска должна быть в пространстве исходного КТ (infer пишет так)."
            )

    # ── Область интереса: куб врача или bbox маски ────────────────────
    if box_frac:
        progress("Область задана вручную…")
        box = _box_from_fractions(box_frac, ct.shape)
    else:
        if mask is None:
            raise ValueError(
                "без маски область интереса задать нечем: пришлите box "
                "с долями по осям"
            )
        progress("Поиск области интереса…")
        box = _bbox_with_padding(mask, mask_h, float(p["padding_mm"]))

    # КТ режем тем же окном, но геометрию (origin) считаем от заголовка КТ
    roi_ct, roi_ct_h = _crop(ct, ct_h, box)
    if mask is None:
        # Пустая маска той же формы: врач закрасит сам. dtype uint8 —
        # тот же, что у обрезанной маски модели, иначе пара (img, seg)
        # для дообучения разъедется по типу.
        roi_mask = np.zeros_like(roi_ct, dtype=np.uint8)
    else:
        roi_mask, _ = _crop(mask, mask_h, box)
        # Маске НАВЯЗЫВАЕМ геометрию КТ — гарантия побитового совпадения пары
        roi_mask = roi_mask.astype(np.uint8, copy=False)

    progress("Сохранение ROI…")
    out_ct = session.reserve("roi_ct", ".nrrd")
    out_mask = session.reserve("roi_mask", ".nrrd")
    write_nrrd(out_ct, roi_ct, roi_ct_h)
    write_nrrd(out_mask, roi_mask, roi_ct_h)  # та же геометрия, что у roi_ct
    session.register("roi_ct", out_ct)
    session.register("roi_mask", out_mask)

    phys = [
        (box[1] - box[0]),  # z vox
        (box[3] - box[2]),  # y vox
        (box[5] - box[4]),  # x vox
    ]
    progress(f"ROI готов: {phys[2]}×{phys[1]}×{phys[0]} вокселей")
