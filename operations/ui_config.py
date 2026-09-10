"""
operations/ui_config.py — настройки интерфейса, переживающие перезапуск.

ЗАЧЕМ ОТДЕЛЬНАЯ ОПЕРАЦИЯ. Цвета зон врач переназначает под себя, и выбор
должен подниматься при следующем запуске. Положить его в сессию нельзя:
сессия обнуляется кнопкой «начать заново» и при открытии чужого архива, а
настройка интерфейса к данным пациента отношения не имеет — потерять её при
смене пациента было бы странно.

Поэтому храним рядом с репозиторием, тем же приёмом, что и пути к модели
(см. _cfg_store_path в infer_config.py): один JSON, который переживает и
сброс сессии, и перезапуск приложения.

Контракт:
    INPUTS  = []                      — сессия не нужна вовсе
    OUTPUTS = ["ui_config_json"]      — текущее состояние настроек
    PARAMS  = {"save": False, "reset": False, "zone_colors": None}

  • без параметров          — просто прочитать сохранённое;
  • save + zone_colors      — запомнить палитру врача;
  • reset                   — забыть её и вернуться к цветам по умолчанию.

ui_config_json = {"zone_colors": ["#rrggbb", ...] | None}

Значения ПО УМОЛЧАНИЮ здесь не хранятся сознательно: их знает фронт
(tab3-zones.js), и дублировать их на сервере значит завести второй источник
правды, который однажды разойдётся с первым. Отсутствие ключа означает
«врач ничего не менял, бери свои».
"""

import json
import os
import re


NAME = "ui_config"
INPUTS = []
OUTPUTS = ["ui_config_json"]
PARAMS = {
    "save": False,          # запомнить пришедшие значения
    "reset": False,         # забыть сохранённое
    "zone_colors": None,    # ["#rrggbb", "#rrggbb", "#rrggbb"]
}

_HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def _store_path():
    """Файл настроек интерфейса — рядом с репозиторием, как у infer_config."""
    base = (os.environ.get("NASAL_BASE_DIR", "").strip()
            or os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return os.path.join(base, ".nasal_ui_cfg.json")


def _load():
    try:
        with open(_store_path(), "r", encoding="utf-8") as fh:
            d = json.load(fh)
        return d if isinstance(d, dict) else {}
    except Exception:
        # Битый или отсутствующий файл — не повод падать: настройка
        # интерфейса не критична, врач просто увидит цвета по умолчанию.
        return {}


def _save(d):
    try:
        with open(_store_path(), "w", encoding="utf-8") as fh:
            json.dump(d, fh, ensure_ascii=False)
        return True
    except Exception:
        return False


def _clean_colors(value):
    """Три валидных #rrggbb или None.

    Проверяем строго: значение приходит из браузера и попадёт прямо в CSS и
    в THREE.Color. Кривая строка там не упадёт с ошибкой, а тихо даст чёрный
    цвет — зона просто исчезнет, и искать причину врач будет долго.
    """
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        return None
    out = []
    for v in value:
        if not isinstance(v, str) or not _HEX_RE.match(v.strip()):
            return None
        out.append(v.strip().lower())
    return out


def run(session, params):
    p = {**PARAMS, **(params or {})}
    store = _load()

    if p.get("reset"):
        store.pop("zone_colors", None)
        _save(store)
    elif p.get("save"):
        colors = _clean_colors(p.get("zone_colors"))
        if colors is None:
            raise ValueError(
                "zone_colors: ожидались три цвета вида #rrggbb, "
                f"получено {p.get('zone_colors')!r}"
            )
        store["zone_colors"] = colors
        _save(store)

    out = session.reserve("ui_config_json", ".json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump({"zone_colors": store.get("zone_colors")}, fh, ensure_ascii=False)
    session.register("ui_config_json", out)
