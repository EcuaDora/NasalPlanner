"""
Registry операций

На импорте этого пакета мы пробегаемся по всем operations/*.py
(кроме __init__.py и модулей начинающихся с _), импортируем их
и складываем в registry по NAME.

Контракт каждого файла operations/*.py:

    NAME     : str          — имя endpoint'а, /api/<NAME>
    INPUTS   : list[str]    — ключи из session, которые нужны на вход
                              (перед запуском диспатчер проверит что они есть)
    OUTPUTS  : list[str]    — ключи, которые операция кладёт в session
    PARAMS   : dict         — параметры операции по умолчанию


    def run(session, params) -> None:
        '''Читает session по INPUTS, пишет по OUTPUTS. Без возврата.
        Всё что операция хочет отдать наружу — кладётся в session,
        фронт достаёт через GET /api/session/<key>.'''


"""

import importlib
import pkgutil
from pathlib import Path

_REQUIRED = ("NAME", "INPUTS", "OUTPUTS", "PARAMS", "run")


def _validate(mod) -> None:
    missing = [a for a in _REQUIRED if not hasattr(mod, a)]
    if missing:
        raise RuntimeError(
            f"operations module '{mod.__name__}' is missing required attrs: {missing}"
        )
    if not isinstance(mod.NAME, str) or not mod.NAME:
        raise RuntimeError(f"{mod.__name__}.NAME must be a non-empty string")
    if not callable(mod.run):
        raise RuntimeError(f"{mod.__name__}.run must be callable")


def _discover() -> dict[str, object]:
    out: dict[str, object] = {}
    # __path__ автоматически обрабатывается PyInstaller'овским pyi_rth_pkgutil
    # и работает и в dev, и в .exe. Голый Path(__file__).parent — нет.
    for mod_info in pkgutil.iter_modules(__path__):
        if mod_info.name.startswith("_"):
            continue
        mod = importlib.import_module(f"{__package__}.{mod_info.name}")
        if not hasattr(mod, "NAME"):
            continue
        _validate(mod)
        if mod.NAME in out:
            raise RuntimeError(
                f"duplicate operation NAME='{mod.NAME}' "
                f"in {mod.__name__} (already registered)"
            )
        out[mod.NAME] = mod
        print(f"[operations] registered: {mod.NAME}  ({mod.__name__})")
    return out


registry: dict[str, object] = _discover()
