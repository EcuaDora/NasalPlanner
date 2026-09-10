# -*- mode: python ; coding: utf-8 -*-
r"""

Сборка:    pyinstaller nasal_planner.spec --noconfirm --clean
Результат: dist/NasalPlanner/NasalPlanner.exe  (+ папка _internal)

Требует PyInstaller >= 6.0.
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
    ("static", "static"),
    ("operations/_dicom_helper.py", "operations"),
    ("preprocess.py", "."),
    ("nasal_unfold_v5.py", "."),
    ("proc_utils.py", "."),
]
datas += collect_data_files("trimesh")

binaries = []
binaries += collect_dynamic_libs("rtree")


for pkg in ("webview", "pymeshfix", "embreex"):
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
        print(f"[spec] + {pkg}")
    except Exception:
        print(f"[spec] - {pkg} не установлен, пропускаю")


excludes = [
    "torch", "torchvision", "torchaudio",
    "monai", "SimpleITK", "pytorch_lightning", "lightning",
    "pymeshlab",
    "skimage", "scikit_image",
    "matplotlib", "pandas", "tensorflow", "sympy", "numba", "llvmlite",
    "tkinter", "IPython", "jupyter", "notebook",
    "PyQt5", "PyQt6", "PySide2", "PySide6",
    "pytest",
]


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
    noarchive=False,

)

pyz = PYZ(a.pure)

exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="NasalPlanner",    # без пробела: проще в CLI и в путях
    debug=False,
    strip=False,
    upx=False,
    console=False,
    icon=ICON,
)

coll = COLLECT(
    exe, a.binaries, a.datas,
    strip=False,
    upx=False,
    name="NasalPlanner",
)
