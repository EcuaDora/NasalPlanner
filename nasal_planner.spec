# -*- mode: python ; coding: utf-8 -*-
r"""
nasal_planner.spec — единственный источник правды для сборки.
Класть в корень проекта, рядом с entry.py.

Сборка:    pyinstaller nasal_planner.spec --noconfirm --clean
Результат: dist/NasalPlanner/NasalPlanner.exe  (+ папка _internal)

Требует PyInstaller >= 6.0.

СБОРОЧНОЕ ОКРУЖЕНИЕ — ЭТО БЕЛЫЙ СПИСОК
──────────────────────────────────────
В бандл попадает то, что установлено в venv, из которого запущен pyinstaller.
Проще не бороться с excludes, а не ставить лишнее:

    python -m venv .venv-build
    .\.venv-build\Scripts\activate
    pip install flask pywebview numpy trimesh scipy networkx pynrrd ^
                pymeshfix rtree embreex pyinstaller

Намеренно НЕ ставим: pymeshlab, torch, monai, SimpleITK, pytorch_lightning,
scikit-image. Всё это работает во внешнем интерпретаторе.

ПРОВЕРКА ПЕРЕД СБОРКОЙ
──────────────────────
Собирать нужно именно из .venv-build, а не из рабочего venv проекта.
Если в окружении есть лишнее, PyInstaller это заберёт — excludes ловит
не всё, а размер бандла растёт на сотни мегабайт.

    .\.venv-build\Scripts\activate
    python -c "import skimage" ; if ($?) { echo 'ЛИШНЕЕ: skimage' }
    python -c "import torch"   ; if ($?) { echo 'ЛИШНЕЕ: torch' }

Оба должны упасть с ModuleNotFoundError — это правильный результат.
"""

import glob
import os
from PyInstaller.utils.hooks import (
    collect_all, collect_data_files, collect_dynamic_libs, collect_submodules,
)

# ══════════════════════════════════════════════════════════════════════════
# hiddenimports
# ══════════════════════════════════════════════════════════════════════════
# operations/__init__.py находит модули через pkgutil.iter_modules() —
# динамика, статический анализатор её не видит. Без этого registry будет
# пустым и все POST /api/<op> начнут отдавать 404.
#
# ВАЖНО: collect_submodules("operations") здесь НЕ годится — она импортирует
# пакет, а __init__.py на импорте прогоняет _discover() и тянет trimesh/scipy.
# Стоит чему-то из этого не подняться в сборочном окружении — PyInstaller
# молча вернёт один "operations" без подмодулей, и вы получите пустой registry
# в собранном приложении. Читаем список с диска, без импорта.
_ops = sorted(
    "operations." + os.path.splitext(os.path.basename(f))[0]
    for f in glob.glob("operations/*.py")
    if not os.path.basename(f).startswith("_")
)
if not _ops:
    raise SystemExit("[spec] operations/*.py не найдены — запускай pyinstaller из корня проекта")
print(f"[spec] операций найдено: {len(_ops)} -> {', '.join(o.split('.')[1] for o in _ops)}")

hiddenimports = ["operations"] + _ops

# Корневые алгоритмические модули. Список ручной, потому что они импортируются
# ЛЕНИВО, внутри функций — статический анализатор такие импорты не видит.
#
# ЕСЛИ ДОБАВЛЯЕТЕ НОВЫЙ МОДУЛЬ В КОРЕНЬ ПРОЕКТА — ДОПИШИТЕ ЕГО СЮДА.
# Иначе из исходников всё работает, а в exe будет ImportError при первом
# обращении к соответствующей операции.
#
# Чего здесь намеренно нет:
#   preprocess       — теперь запускается внешним python (см. operations/preprocess.py),
#                      внутрь процесса не импортируется. Едет через datas.
#   segment_finalize — лежит в operations/, подхватывается через _ops автоматически.
#   eval_segment     — исследовательская обвязка, врачу не нужна.
hiddenimports += [
    "nasal_unfold_v5", "bd_polish", "adaptive_cuts", "overlap_cuts",
    "segment", "session", "server",
    # proc_utils — общий хелпер запуска дочерних процессов без окна консоли.
    # Импортируется из server.py и operations/*, но лениво, внутри функций.
    "proc_utils",
    # scipy — точечные подмодули, которые хуки иногда пропускают
    "scipy.sparse.linalg._isolve",
    "scipy.sparse.linalg._dsolve",
    "scipy.sparse.csgraph._validation",
    "scipy._lib.messagestream",
    # pywebview на Windows
    "webview.platforms.edgechromium",
    "webview.platforms.winforms",
    "clr_loader", "pythonnet",
]

# ══════════════════════════════════════════════════════════════════════════
# datas
# ══════════════════════════════════════════════════════════════════════════
datas = [
    # фронтенд: nasal-planner.html + css/ + js/
    # Запасная копия: entry.resource_path() сначала ищет static/ рядом с .exe,
    # что позволяет обновлять интерфейс без пересборки.
    ("static", "static"),
    # _dicom_helper.py исполняется ВНЕШНИМ интерпретатором как скрипт
    # (operations/dicom_series.py строит путь от своего __file__),
    # поэтому нужен как обычный .py-файл, а не замороженный модуль.
    ("operations/_dicom_helper.py", "operations"),

    # ── Скрипты для ВНЕШНЕГО интерпретатора ───────────────────────────
    #
    # Их нельзя класть в hiddenimports: они не импортируются внутрь
    # процесса, а запускаются как отдельные .py другим python — тем,
    # где стоят pymeshlab и torch. Замороженный модуль так вызвать
    # нельзя, нужен именно файл на диске.
    #
    # Без этой строки собранное приложение падало на первом же переходе
    # с этапа разметки:
    #     FileNotFoundError: Не найден preprocess.py.
    #     Положите его рядом с приложением или задайте
    #     переменную окружения NASAL_PREPROCESS_SCRIPT.
    # Из исходников при этом всё работало — файл лежит в корне проекта,
    # и _resolve_script() находил его там.
    ("preprocess.py", "."),

    # nasal_unfold_v5 и proc_utils УЖЕ есть в hiddenimports, то есть
    # доступны как модули внутри процесса. Кладём их ещё и файлами:
    # это позволяет править алгоритм развёртки, не пересобирая .exe —
    # resource_path() и обычный импорт возьмут копию рядом с .exe.
    ("nasal_unfold_v5.py", "."),
    ("proc_utils.py", "."),
]
datas += collect_data_files("trimesh")

binaries = []
binaries += collect_dynamic_libs("rtree")

# ══════════════════════════════════════════════════════════════════════════
# Опциональные пакеты — подхватываем только если реально установлены
# ══════════════════════════════════════════════════════════════════════════
# webview (pywebview) — БЕЗ него приложение открывается в браузере, а не в
# окне. Если тут напечатается "- webview", ставь: pip install pywebview
#
# pymeshlab из этого списка УБРАН СОЗНАТЕЛЬНО. Он тащит Qt и собственные
# нативные плагины-фильтры, которые ищет относительно своего __file__, а
# PyInstaller переносит нативные библиотеки в корень _internal. Qt, не найдя
# плагин, вызывает abort() — процесс умирает молча, без traceback. Именно это
# роняло приложение при переходе с вкладки сегментации на следующую.
# Теперь preprocess.py работает во внешнем интерпретаторе.
for pkg in ("webview", "pymeshfix", "embreex"):
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
        print(f"[spec] + {pkg}")
    except Exception:
        print(f"[spec] - {pkg} не установлен, пропускаю")

# ══════════════════════════════════════════════════════════════════════════
# excludes
# ══════════════════════════════════════════════════════════════════════════
# torch/monai/SimpleITK/pytorch_lightning нужны только скриптам
# infer_swinunetr_cli.py и _dicom_helper.py, а их запускает ВНЕШНИЙ
# интерпретатор. pymeshlab — только preprocess.py, тоже внешнему.
# В бандле им делать нечего.
# NB: collect_dynamic_libs("SimpleITK") из прошлой версии убран — он тянул
# ~100 МБ мёртвых DLL в обход excludes.
excludes = [
    "torch", "torchvision", "torchaudio",
    "monai", "SimpleITK", "pytorch_lightning", "lightning",
    "pymeshlab",
    # scikit-image не импортируется НИ ОДНИМ файлом проекта — ни прямо,
    # ни через marching_cubes (меш строит pymeshlab во внешнем питоне).
    # Но trimesh опционально пробует его импортировать, и если пакет
    # оказался в сборочном venv, PyInstaller утащит его целиком: это
    # ~80-120 МБ вместе с зависимостями. Держим в excludes, чтобы сборка
    # не зависела от чистоты окружения.
    "skimage", "scikit_image",
    "matplotlib", "pandas", "tensorflow", "sympy", "numba", "llvmlite",
    "tkinter", "IPython", "jupyter", "notebook",
    "PyQt5", "PyQt6", "PySide2", "PySide6",
    "pytest",
]

# ══════════════════════════════════════════════════════════════════════════
# Сборка
# ══════════════════════════════════════════════════════════════════════════
# Иконка: entry.py ищет для окна static/icon.ico, затем static/logo.ico —
# здесь тот же порядок.
ICON = None
for _c in ("static/icon.ico", "static/logo.ico"):
    if os.path.isfile(_c):
        ICON = _c
        break

a = Analysis(
    ["entry.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=excludes,
    noarchive=False,        # было True — это отладочный режим: все модули
                            # ложатся россыпью .pyc вместо PYZ-архива
)

pyz = PYZ(a.pure)           # a.zipped_data с PyInstaller 6.0 всегда пуст (egg'и выкинули)

exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="NasalPlanner",    # без пробела: проще в CLI и в путях
    debug=False,
    strip=False,
    upx=False,              # UPX ломает DLL numpy/scipy → ImportError у врача
    console=False,          # Окно консоли скрыто — врача пугают чёрные окна.
                            # Для диагностики временно поставьте True
                            # и пересоберите: без консоли падение при старте
                            # не покажет ничего.
                            # NB: дочерние процессы (инференс, чтение DICOM)
                            # прячутся отдельно, через proc_utils.no_window() —
                            # console=False на них не влияет.
    icon=ICON,
)

coll = COLLECT(
    exe, a.binaries, a.datas,
    strip=False,
    upx=False,
    name="NasalPlanner",
)
