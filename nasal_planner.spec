# nasal_planner.spec
from PyInstaller.utils.hooks import (
    collect_submodules, collect_data_files, collect_dynamic_libs,
    collect_all,
)

hiddenimports = (
    collect_submodules("flask")
    + collect_submodules("werkzeug")
    + collect_submodules("jinja2")
    + collect_submodules("trimesh")
    + collect_submodules("skimage")
    + collect_submodules("operations")
    + [
        "scipy.sparse.linalg._isolve",
        "scipy.sparse.linalg._dsolve",
        "scipy.sparse.csgraph._validation",
        "scipy._lib.messagestream",
        "webview.platforms.edgechromium",
        "webview.platforms.winforms",
        "clr_loader", "pythonnet",
        "nasal_unfold_v5",
        "bd_polish",
        "adaptive_cuts",
        "overlap_cuts",
        "preprocess",
        "segment",
        "segment_finalize",
        "eval_segment",
        "session",
        "server",
    ]
)

datas = (
    [("static", "static")]
    + [("operations", "operations")]
    + [
        ("nasal_unfold_v5.py", "."),
        ("bd_polish.py", "."),
        ("adaptive_cuts.py", "."),
        ("overlap_cuts.py", "."),
        ("preprocess.py", "."),
        ("segment.py", "."),
        ("eval_segment.py", "."),
    ]
    + collect_data_files("pymeshlab")
    + collect_data_files("trimesh")
)

binaries = (
    collect_dynamic_libs("pymeshlab")
    + collect_dynamic_libs("rtree")
    + collect_dynamic_libs("pymeshfix")
    + collect_dynamic_libs("SimpleITK")
)

hiddenimports = list(hiddenimports)
datas = list(datas)
binaries = list(binaries)

embreex_datas, embreex_binaries, embreex_hiddenimports = collect_all("embreex")
datas += embreex_datas
binaries += embreex_binaries
hiddenimports += embreex_hiddenimports


excludes = [
    "tkinter", "matplotlib", "pandas", "PyQt5", "PyQt6",
    "torch", "tensorflow", "IPython", "jupyter", "notebook",
]

a = Analysis(
    ["entry.py"],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=excludes,
    noarchive=True,
)
pyz = PYZ(a.pure, a.zipped_data)
exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="Nasal Planner",
    console=False,        # для первой сборки. Потом → False
    upx=False,
    icon="static/logo.ico",
)
COLLECT(
    exe, a.binaries, a.zipfiles, a.datas,
    upx=False,
    name="Nasal Planner",
)