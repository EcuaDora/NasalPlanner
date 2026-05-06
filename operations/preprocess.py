"""
Таб 1: препроцессинг меша.

Адаптер над preprocess.py (лежит в корне проекта).
Сам preprocess.py не трогаем — он умеет работать как CLI-утилита,
а здесь мы вызываем его main() с подменой sys.argv.

Контракт:
    INPUTS  = ["mesh_raw"]       — исходный OBJ, который врач загрузил
    OUTPUTS = ["mesh_clean"]     — упрощённый и очищенный OBJ
    PARAMS  = {ratio, smooth}    — параметры упрощения и сглаживания

После этой операции таб 2 (segment) получит mesh_clean на вход.
"""

import sys


NAME = "preprocess"
INPUTS = ["mesh_raw"]
OUTPUTS = ["mesh_clean"]
PARAMS = {
    "ratio": 0.5,     # доля граней после упрощения
    "smooth": 10,     # итераций Taubin
}


def run(session, params):
    import preprocess as _user_script

    in_path = session.path("mesh_raw")
    if in_path is None:
        raise ValueError("session missing 'mesh_raw' — upload OBJ first")

    out_path = session.reserve("mesh_clean", ".obj")

    # Подмена sys.argv: preprocess.main() читает argparse из него.
    saved_argv = sys.argv
    try:
        sys.argv = [
            "preprocess.py",
            in_path,
            "-o", out_path,
            "--ratio", str(params["ratio"]),
            "--smooth", str(params["smooth"]),
        ]
        _user_script.main()
    finally:
        sys.argv = saved_argv

    session.register("mesh_clean", out_path)
