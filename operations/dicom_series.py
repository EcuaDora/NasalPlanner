"""
operations/dicom_series.py — перечислить DICOM-серии в загруженной папке.

Контракт:
    NAME    = "dicom_series"
    INPUTS  = []                     — файлы лежат в <session>/dicom_src (батч-загрузка)
    OUTPUTS = ["dicom_series_json"]  — JSON-список серий (фронт читает GET /api/session/...)
    PARAMS  = {"python": ""}         — интерпретатор с SimpleITK (или env NASAL_INFER_PYTHON)

Перечисление серий делает внешний интерпретатор инференса (там есть
SimpleITK) через _dicom_helper.py — ровно та же библиотека, которой потом
читает серию infer_swinunetr_cli.py, поэтому UID совпадают.

Файлы DICOM фронт заливает батчами в POST /api/dicom_upload → <session>/dicom_src.
"""

import os
import subprocess
from proc_utils import no_window   # без всплывающего окна консоли

NAME = "dicom_series"
INPUTS = []
OUTPUTS = ["dicom_series_json"]
PARAMS = {"python": ""}

_HELPER = os.path.join(os.path.dirname(__file__), "_dicom_helper.py")


def _resolve_python(params):
    py = (params.get("python") or "").strip() or os.environ.get("NASAL_INFER_PYTHON", "").strip()
    if not py:
        raise ValueError(
            "не задан Python окружения инференса. Укажите путь в «Настройки модели» "
            "на вкладке или переменную окружения NASAL_INFER_PYTHON."
        )
    if not os.path.exists(py):
        raise ValueError("Python окружения не найден: %s" % py)
    return py


def dicom_dir(session):
    """Папка с залитыми DICOM-файлами. Кидает понятную ошибку, если пусто."""
    dst = os.path.join(session.dir, "dicom_src")
    has_files = os.path.isdir(dst) and any(
        os.path.isfile(os.path.join(r, f))
        for r, _d, fs in os.walk(dst) for f in fs
    )
    if not has_files:
        raise ValueError("папка DICOM не загружена (нет session/dicom_src)")
    return dst


def _run(cmd, progress):
    if progress:
        progress("Запуск чтения DICOM…")
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"   # не падать на cp1251 при не-ASCII выводе
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1, encoding="utf-8", errors="replace", env=env,
        **no_window(),
    )
    tail = []
    for line in proc.stdout:
        line = line.rstrip("\n")
        tail.append(line)
        if len(tail) > 40:
            tail.pop(0)
        if progress and line.startswith("[INFO]"):
            progress(line.replace("[INFO]", "").strip() or "…")
        print("[dicom_series]", line, flush=True)
    code = proc.wait()
    if code != 0:
        text = "\n".join(tail)
        # Частые «ожидаемые» причины (необъёмная/radial-серия) — короткое понятное
        low = text.lower()
        if ("no series were found" in low or "неподдерживаемая геометрия" in low
                or "не объ" in low or "не читается как об" in low):
            print("[dicom_series] (серия не собирается в объём — пропускаем)", flush=True)
            raise _ExpectedSeriesError(
                "Эта серия не собирается в объём (нестандартная геометрия — "
                "например radial или одиночный topogram). Выберите осевую (ax) "
                "реконструкцию с наибольшим числом срезов."
            )
        raise RuntimeError("чтение DICOM завершилось с кодом %d:\n%s"
                           % (code, "\n".join(tail[-12:])))


class _ExpectedSeriesError(RuntimeError):
    pass


def run(session, params):
    progress = params.get("__progress__")
    py = _resolve_python(params)
    d = dicom_dir(session)

    out_json = session.reserve("dicom_series_json", ".json")
    cmd = [py, _HELPER, "list", d, out_json]
    print("[dicom_series] CMD:", " ".join(cmd), flush=True)
    _run(cmd, progress)

    if not os.path.exists(out_json):
        raise RuntimeError("список серий не сформирован")
    session.register("dicom_series_json", out_json)
