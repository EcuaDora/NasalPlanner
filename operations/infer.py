"""
operations/infer.py — автосегментация КТ моделью SwinUNETR.

Что делает: запускает ВНЕШНИЙ инференс-скрипт (infer_swinunetr_cli.py) в
отдельном python-окружении, где установлены torch / MONAI / ckpt. Сам
nasal-planner НЕ тянет torch — он только дёргает subprocess, ровно как это
делал модуль 3D Slicer (_buildCmd / _runCmd в AutoSegSwinUNETR.py).

Контракт:
    INPUTS  = ["ct_raw"]      — NRRD-том КТ, который врач загрузил (ct-loader.js)
    OUTPUTS = ["mask_raw"]    — предсказанная маска в геометрии исходного КТ
                                (обычный labelmap .nrrd, НЕ .seg.nrrd — так
                                 проще читать в roi_pair.py и в JS)
Прогресс: операция поддерживает служебный ключ params["__progress__"] —
функцию fn(msg). server.py /api/infer/stream передаёт её и стримит сообщения
во фронт как Server-Sent Events. Мы парсим stdout внешнего процесса построчно
и шлём «человеческие» статусы.

Конфигурация путей (python / скрипт / checkpoint) берётся в таком порядке:
    1) то, что прислал фронт в теле запроса (params)
    2) переменные окружения NASAL_INFER_PYTHON / NASAL_INFER_SCRIPT /
       NASAL_INFER_CKPT
    3) значения PARAMS по умолчанию (пустые → понятная ошибка)
"""

import os
import re
import subprocess
from proc_utils import no_window   # без всплывающего окна консоли
import sys


NAME = "infer"
INPUTS = ["ct_raw"]
OUTPUTS = ["mask_raw"]
PARAMS = {
    # Пути к внешнему окружению инференса. Пустые по умолчанию — фронт
    # подставит сохранённые в настройках, либо сработают env-переменные.
    "python":   "",   # путь к python.exe окружения с torch/MONAI
    "script":   "",   # путь к infer_swinunetr_cli.py
    "ckpt":     "",   # путь к .ckpt
    "device":   "auto",  # auto | cpu | cuda
    "postprocess": True,  # морфология + крупнейшая компонента (как в Slicer)
}

_STAGE_RULES = [
    (re.compile(r"DICOM|Loading checkpoint|Model loaded"), "Загрузка модели…"),
    (re.compile(r"Preprocessing"),                          "Предобработка КТ…"),
    (re.compile(r"Midface ROI|localiz"),                    "Локализация лицевой зоны…"),
    (re.compile(r"Inference|sliding|patches"),              "Инференс модели…"),
    (re.compile(r"Mapping to original"),                    "Перенос маски в КТ-пространство…"),
    (re.compile(r"Postprocessing"),                         "Постобработка маски…"),
    (re.compile(r"Saving|Saved"),                           "Сохранение результата…"),
]


def _humanize(line: str) -> str | None:
    for rx, msg in _STAGE_RULES:
        if rx.search(line):
            return msg
    return None


_PCT_RX = re.compile(r"(\d{1,3})\s*%")
_CNT_RX = re.compile(r"(\d+)\s*/\s*(\d+)")


def _parse_progress(line: str) -> str | None:
    """tqdm-подобную строку («74%|██▍ | 31/42 …») → аккуратный статус с баром.
    Возвращает None, если это не прогресс."""
    has_bar = "%|" in line
    mp = _PCT_RX.search(line)
    mc = _CNT_RX.search(line)
    if not (has_bar or mp or mc):
        return None
    pct = int(mp.group(1)) if mp else None
    a = b = None
    if mc:
        a, b = int(mc.group(1)), int(mc.group(2))
        if pct is None and b:
            pct = int(round(100.0 * a / max(1, b)))
    if pct is None:
        return None
    pct = max(0, min(100, pct))
    fill = int(round(pct / 10.0))
    bar = "█" * fill + "·" * (10 - fill)
    txt = "Инференс модели… %d%%  %s" % (pct, bar)
    if a is not None:
        txt += "  %d/%d" % (a, b)
    return txt


def _resolve(params: dict, key: str, env: str) -> str:
    val = (params.get(key) or "").strip()
    if not val:
        val = (os.environ.get(env) or "").strip()
    return val


def _require_file(path: str, what: str) -> None:
    if not path:
        raise ValueError(
            f"Не задан путь: {what}. Укажите его в карточке «Модель» на вкладке "
            f"сегментации или через переменную окружения."
        )
    if not os.path.exists(path):
        raise FileNotFoundError(f"{what} не найден: {path}")


def run(session, params):
    progress = params.get("__progress__") or (lambda m: None)
    p = {**PARAMS, **(params or {})}

    ct_path = session.path("ct_raw")
    if ct_path is None:
        raise ValueError("session missing 'ct_raw' — сначала загрузите КТ (.nrrd)")

    python = _resolve(p, "python", "NASAL_INFER_PYTHON")
    script = _resolve(p, "script", "NASAL_INFER_SCRIPT")
    ckpt   = _resolve(p, "ckpt",   "NASAL_INFER_CKPT")

    _require_file(python, "Python окружения инференса")
    _require_file(script, "Скрипт infer_swinunetr_cli.py")
    _require_file(ckpt,   "Checkpoint модели (.ckpt)")

    # Выход — обычный labelmap .nrrd (не .seg.nrrd): один массив
    out_path = session.reserve("mask_raw", ".nrrd")

    cmd = [
        python, "-u", script,
        "--input", ct_path,
        "--output", out_path,
        "--ckpt", ckpt,
        "--device", str(p.get("device", "auto")),
    ]
    if not p.get("postprocess", True):
        cmd.append("--no-postprocess")

    progress("Старт инференса…")
    _run_streaming(cmd, progress)

    if not os.path.exists(out_path):
        raise RuntimeError(
            "Инференс завершился, но файл маски не создан. Проверьте лог "
            "процесса (вывод печатается в консоль сервера)."
        )

    session.register("mask_raw", out_path)
    progress("Готово")


def _run_streaming(cmd, progress):
    """Запуск subprocess с построчным чтением stdout → progress().

    Дублируем сырые строки в stdout сервера (для отладки) и одновременно
    конвертируем ключевые в короткие статусы для спиннера фронта.
    """
    # На Windows важно, чтобы дочерний python видел utf-8 stdout — CLI сам
    # делает reconfigure(encoding="utf-8"), но подстрахуемся переменной.
    env = dict(os.environ)
    env.setdefault("PYTHONIOENCODING", "utf-8")
    env.setdefault("PYTHONUNBUFFERED", "1")

    print("[infer] CMD:", " ".join(cmd), flush=True)

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        env=env,
        **no_window(),
    )

    def _log(msg):
        """Печать строки от дочернего процесса — не роняя приложение.

        Инференс рисует прогресс-бар символами вроде «▋» (U+258B).
        В сборке с console=False stdout открыт в кодировке локали
        (cp1251 на русской Windows), и такая строка вызывала
        UnicodeEncodeError — наружу это всплывало как
        «Ошибка сегментации: 'infer' failed», хотя расчёт шёл нормально.

        entry.py переоткрывает потоки в utf-8, но здесь дублируем защиту:
        infer.py вызывается и напрямую, вне собранного приложения.
        """
        try:
            print("[infer]", msg, flush=True)
        except UnicodeEncodeError:
            # print успевает выдать префикс до падения на самом сообщении,
            # поэтому во второй попытке печатаем только очищенный текст.
            enc = (getattr(sys.stdout, "encoding", None) or "ascii")
            print(msg.encode(enc, "replace").decode(enc, "replace"), flush=True)
        except Exception:
            pass                        # stdout может быть None при console=False

    last_stage = None
    last_prog = None

    tail: list[str] = []
    TAIL_MAX = 40

    try:
        assert proc.stdout is not None
        for raw in proc.stdout:
            # tqdm обновляет строку через \r — режем и по \r, и по \n
            for line in raw.replace("\r", "\n").split("\n"):
                line = line.strip()
                if not line:
                    continue
                _log(line)                      # сырой лог сервера
                tail.append(line)
                if len(tail) > TAIL_MAX:
                    del tail[0]
                prog = _parse_progress(line)
                if prog is not None:
                    if prog != last_prog:
                        progress(prog)
                        last_prog = prog
                    continue
                stage = _humanize(line)
                if stage and stage != last_stage:
                    progress(stage)
                    last_stage = stage
    finally:
        proc.stdout and proc.stdout.close()

    code = proc.wait()
    if code != 0:
        # Полный лог — рядом с сессией, чтобы можно было прислать файл.
        log_path = None
        try:
            # Рядом с файлом маски: путь известен точно, а у session
            # атрибута .dir может не быть.
            log_path = os.path.splitext(out_path)[0] + "_error.log"
            with open(log_path, "w", encoding="utf-8", errors="replace") as fh:
                fh.write("CMD: " + " ".join(cmd) + "\n")
                fh.write("EXIT CODE: %d\n\n" % code)
                fh.write("\n".join(tail))
        except Exception:
            log_path = None

        # В сообщение выносим последние строки: обычно именно там traceback
        # или причина вроде «CUDA out of memory» / «No module named monai».
        # Служебный шум (прогресс-бары, [INFO]) отбрасываем.
        useful = [
            ln for ln in tail
            if ln and not ln.startswith(("[INFO]", "[info]"))
            and "%|" not in ln and not ln.startswith("\u2588")
        ]
        detail = " · ".join(useful[-3:]) if useful else " · ".join(tail[-3:])
        if len(detail) > 300:
            detail = detail[:300] + "…"

        msg = f"Инференс завершился с ошибкой (код {code})."
        if detail:
            msg += f" {detail}"
        if log_path:
            msg += f" Полный лог: {log_path}"
        raise RuntimeError(msg)
