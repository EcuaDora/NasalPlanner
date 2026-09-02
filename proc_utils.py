"""
Запуск дочерних процессов без всплывающего консольного окна.

Зачем. На Windows любой subprocess.Popen/run из GUI-приложения (собранного
с console=False) открывает СВОЁ окно консоли: чёрный прямоугольник, который
мигает на долю секунды и исчезает. Технически всё работает, но врач видит
мигающие окна на каждом этапе и справедливо пугается.

Флаг CREATE_NO_WINDOW (0x08000000) говорит Windows не создавать консоль
для дочернего процесса. На Linux и macOS константы нет и она не нужна —
там возвращается пустой словарь, поведение не меняется.

STARTUPINFO с SW_HIDE добавлен для подстраховки: часть окружений
(старые Windows, некоторые способы запуска) игнорируют creationflags,
но уважают startupinfo.

Использование:

    from proc_utils import no_window
    subprocess.Popen(cmd, stdout=..., **no_window())
"""
from __future__ import annotations

import subprocess
import sys

_IS_WIN = sys.platform.startswith("win")

# 0x08000000 — CREATE_NO_WINDOW. Через getattr, потому что на не-Windows
# атрибута в модуле subprocess нет вообще.
_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)


def no_window() -> dict:
    """kwargs для subprocess, подавляющие окно консоли.

    Возвращает пустой dict на не-Windows, поэтому вызов безопасен
    в кроссплатформенном коде без дополнительных проверок.
    """
    if not _IS_WIN:
        return {}

    kw = {"creationflags": _CREATE_NO_WINDOW}

    try:
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        si.wShowWindow = 0  # SW_HIDE
        kw["startupinfo"] = si
    except Exception:
        # STARTUPINFO есть не во всех сборках Python под Windows —
        # creationflags и сам по себе решает задачу.
        pass

    return kw
