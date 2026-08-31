#!/usr/bin/env python3
"""
Вспомогательный скрипт для работы с DICOM — запускается ВНЕШНИМ
интерпретатором инференса (тем, где установлен SimpleITK), а НЕ venv
приложения. Поэтому весь импорт SimpleITK — внутри функций.

Имя начинается с «_», поэтому operations/__init__.py его НЕ регистрирует
как операцию и НЕ импортирует. Операции dicom_series.py / dicom_convert.py
находят его по пути и запускают через subprocess.

Режимы:
    list    <dicom_root> <out_json>
        — перечислить все DICOM-серии в папке (рекурсивно). Пишет JSON:
          {"series":[{"uid","count","description","modality",
                      "rows","cols","patient","study"}...]} — по убыванию
          числа срезов (как авто-выбор в 3D Slicer).

    convert <dicom_root> <series_uid|''> <out_nrrd>
        — собрать выбранную серию в один том и сохранить .nrrd.
          Пустой series_uid → берётся самая «толстая» серия.

Логика выбора серии повторяет infer_swinunetr_cli.py:
GetGDCMSeriesIDs / GetGDCMSeriesFileNames, при нескольких сериях —
наибольшая по числу файлов.
"""

import sys
import os
import json


def _iter_dirs(root):
    """root + все вложенные папки (на случай раскладки «папка на серию»)."""
    seen = set()
    stack = [root]
    while stack:
        d = stack.pop()
        rp = os.path.realpath(d)
        if rp in seen or not os.path.isdir(d):
            continue
        seen.add(rp)
        yield d
        try:
            for name in os.listdir(d):
                sub = os.path.join(d, name)
                if os.path.isdir(sub):
                    stack.append(sub)
        except OSError:
            pass


def _collect_series(root):
    """{series_uid: {'dir':..., 'files':[...]}} по всем папкам."""
    import SimpleITK as sitk
    reader = sitk.ImageSeriesReader
    found = {}
    for dpath in _iter_dirs(root):
        try:
            sids = reader.GetGDCMSeriesIDs(dpath)
        except Exception:
            sids = []
        for sid in sids:
            try:
                files = list(reader.GetGDCMSeriesFileNames(dpath, sid))
            except Exception:
                files = []
            if not files:
                continue
            # одна и та же серия может попасться в нескольких папках —
            # оставляем вариант с бОльшим числом файлов
            if sid not in found or len(files) > len(found[sid]["files"]):
                found[sid] = {"dir": dpath, "files": files}
    return found


def _read_tags(first_file):
    import SimpleITK as sitk
    out = {}
    try:
        r = sitk.ImageFileReader()
        r.SetFileName(first_file)
        r.LoadPrivateTagsOn()
        r.ReadImageInformation()

        def g(tag):
            try:
                return (r.GetMetaData(tag) or "").strip()
            except Exception:
                return ""

        out["description"] = g("0008|103e")   # SeriesDescription
        out["modality"]    = g("0008|0060")   # Modality
        out["rows"]        = g("0028|0010")   # Rows
        out["cols"]        = g("0028|0011")   # Columns
        out["patient"]     = g("0010|0010")   # PatientName
        out["study"]       = g("0008|1030")   # StudyDescription
        out["thickness"]   = g("0018|0050")   # SliceThickness (мм)
        out["kernel"]      = g("0018|1210")   # ConvolutionKernel (ядро реконструкции)
        out["pixel"]       = g("0028|0030")   # PixelSpacing (row\col, мм)
    except Exception:
        pass
    return out


def _safe(s):
    """Убрать суррогаты / неэнкодируемое + управляющие символы — метаданные DICOM
    часто не UTF-8 и содержат разделители (^), иначе в UI видны прямоугольники."""
    if not isinstance(s, str):
        return ""
    s = s.encode("utf-8", "replace").decode("utf-8")
    # имя пациента DICOM: компоненты разделяются '^' → пробелы
    s = s.replace("^", " ")
    # выкидываем непечатаемые/управляющие символы
    s = "".join(ch for ch in s if ch == " " or (ord(ch) >= 0x20 and ord(ch) != 0x7f))
    # схлопываем пробелы
    s = " ".join(s.split())
    return s


def mode_list(root, out_json):
    series = _collect_series(root)
    items = []
    for sid, info in series.items():
        files = info["files"]
        tags = _read_tags(files[0]) if files else {}
        items.append({
            "uid": _safe(sid),
            "count": len(files),
            # объёмная серия = можно собрать 3D-том (одиночные topogram/protocol — нет)
            "volumetric": len(files) >= 10,
            "description": _safe(tags.get("description")) or "(без описания)",
            "modality": _safe(tags.get("modality")),
            "rows": _safe(tags.get("rows")),
            "cols": _safe(tags.get("cols")),
            "patient": _safe(tags.get("patient")),
            "study": _safe(tags.get("study")),
            "thickness": _safe(tags.get("thickness")),
            "kernel": _safe(tags.get("kernel")),
            "pixel": _safe(tags.get("pixel")),
        })
    items.sort(key=lambda x: x["count"], reverse=True)
    with open(out_json, "w", encoding="utf-8", errors="replace") as fh:
        json.dump({"series": items}, fh, ensure_ascii=True)
    print("[INFO] Серий найдено: %d" % len(items), flush=True)
    if len(items) > 1:
        print("[INFO] Несколько серий — по умолчанию крупнейшая (%d срезов)"
              % items[0]["count"], flush=True)


def mode_convert(root, series_uid, out_nrrd):
    import SimpleITK as sitk
    series = _collect_series(root)
    if not series:
        raise SystemExit("Нет DICOM-серий в папке: %s" % root)

    if series_uid and series_uid in series:
        info = series[series_uid]
        chosen = series_uid
    else:
        # самая «толстая» серия — как авто-выбор в Slicer
        chosen = max(series, key=lambda k: len(series[k]["files"]))
        info = series[chosen]
        if series_uid:
            print("[INFO] UID %s не найден, выбрана крупнейшая серия"
                  % series_uid, flush=True)

    files = info["files"]
    print("[INFO] Серия: %s, файлов: %d" % (chosen, len(files)), flush=True)
    reader = sitk.ImageSeriesReader()
    reader.SetFileNames(files)
    img = reader.Execute()
    sitk.WriteImage(img, out_nrrd, True)  # useCompression=True -> gzip NRRD
    print("[INFO] DICOM -> NRRD: %s" % out_nrrd, flush=True)


def mode_preview(root, series_uid, out_dir, prefix="preview"):
    """Выгружает УМЕНЬШЕННЫЙ объём серии (uint8, костное окно, ориентация LPS)
    одним файлом <prefix>.u8 + <prefix>.json с dims/spacing. Браузер из него
    мгновенно рисует любую плоскость и листает срезы (как в Slicer)."""
    import SimpleITK as sitk
    import numpy as np
    import json as _json

    series = _collect_series(root)
    if not series:
        raise SystemExit("Нет DICOM-серий в папке: %s" % root)
    if series_uid and series_uid in series:
        info = series[series_uid]
    else:
        info = series[max(series, key=lambda k: len(series[k]["files"]))]

    files = info["files"]
    if len(files) < 10:
        raise SystemExit("серия не объёмная (срезов: %d)" % len(files))

    reader = sitk.ImageSeriesReader()
    reader.SetFileNames(files)
    try:
        img = reader.Execute()
    except Exception as e:
        raise SystemExit("серия не читается как объём (нестандартная геометрия): %s"
                         % str(e).splitlines()[-1][:120])

    try:
        img = sitk.DICOMOrient(img, "LPS")    # анатомическая ориентация, как в Slicer
    except Exception:
        pass
    try:
        sx, sy, sz = img.GetSpacing()         # мм: x(L), y(P), z(S)
    except Exception:
        sx = sy = sz = 1.0

    arr = np.asarray(sitk.GetArrayFromImage(img)).astype("float32")   # (z, y, x)
    if arr.ndim != 3:
        raise SystemExit("неподдерживаемая геометрия серии")
    z, y, x = arr.shape

    # костное КТ-окно как в Slicer (L=300, W=2000) -> uint8
    lo = 300.0 - 2000.0 / 2.0
    rng = 2000.0
    u8 = np.clip((arr - lo) / rng, 0.0, 1.0) * 255.0
    u8 = u8.astype("uint8")

    # уменьшаем, чтобы объём быстро дошёл до браузера, но достаточно резко
    # для уверенного выбора серии (макс. размер оси ~256 вокселей)
    MAX = 256
    def _axis_idx(n):
        step = max(1, int(np.ceil(n / float(MAX))))
        return np.arange(0, n, step)
    zi = _axis_idx(z); yi = _axis_idx(y); xi = _axis_idx(x)
    small = u8[np.ix_(zi, yi, xi)]
    nz, ny, nx = small.shape
    # эффективный спейсинг с учётом прореживания (для верных пропорций в браузере)
    esz = sz * (z / max(1, nz)); esy = sy * (y / max(1, ny)); esx = sx * (x / max(1, nx))

    # сырые байты тома (порядок z,y,x — C-order) + метаданные
    with open(os.path.join(out_dir, prefix + ".u8"), "wb") as fh:
        fh.write(small.tobytes(order="C"))
    with open(os.path.join(out_dir, prefix + ".json"), "w", encoding="utf-8") as fh:
        _json.dump({"dims": [int(nx), int(ny), int(nz)],
                    "spacing": [float(esx), float(esy), float(esz)]}, fh)
    print("[INFO] Объём превью: %dx%dx%d" % (nx, ny, nz), flush=True)


def main(argv):
    # вывод в UTF-8 — чтобы не падать на консолях cp1251 (Windows) при не-ASCII
    for _s in (sys.stdout, sys.stderr):
        try:
            _s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    if not argv:
        raise SystemExit("usage: _dicom_helper.py list|convert|preview ...")
    cmd = argv[0]
    if cmd == "list":
        if len(argv) < 3:
            raise SystemExit("usage: list <dicom_root> <out_json>")
        mode_list(argv[1], argv[2])
    elif cmd == "convert":
        if len(argv) < 4:
            raise SystemExit("usage: convert <dicom_root> <series_uid|''> <out_nrrd>")
        mode_convert(argv[1], argv[2], argv[3])
    elif cmd == "preview":
        if len(argv) < 4:
            raise SystemExit("usage: preview <dicom_root> <series_uid|''> <out_dir> [prefix]")
        prefix = argv[4] if len(argv) > 4 and argv[4] else "preview"
        mode_preview(argv[1], argv[2], argv[3], prefix)
    else:
        raise SystemExit("unknown mode: %s" % cmd)


if __name__ == "__main__":
    main(sys.argv[1:])
