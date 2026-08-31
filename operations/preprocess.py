"""
Таб 1: препроцессинг меша.

Адаптер над preprocess.py (лежит в корне проекта).

ПОЧЕМУ ВНЕШНИЙ ПРОЦЕСС, А НЕ import
───────────────────────────────────
Раньше здесь был `import preprocess` с подменой sys.argv — то есть pymeshlab
загружался ВНУТРЬ нашего процесса. В собранном PyInstaller-бандле это роняло
приложение целиком: pymeshlab тащит Qt и собственные нативные плагины-фильтры,
которые ищет по пути относительно своего __file__, а PyInstaller переносит
нативные библиотеки в корень _internal и ломает эту раскладку. Qt в такой
ситуации не бросает исключение — он вызывает abort(). Процесс умирает молча,
без traceback, и вместе с ним daemon-поток Flask. Со стороны выглядело как
«окно просто закрылось при переходе на следующую вкладку».

Теперь preprocess.py запускается ВНЕШНИМ интерпретатором через subprocess —
ровно тем же приёмом, что operations/infer.py (torch) и operations/dicom_series.py
(SimpleITK). Что это даёт:

  • pymeshlab больше не нужен в бандле → он в excludes, сборка легче на 400–700 МБ;
  • крэш дочернего процесса возвращает читаемую ошибку в интерфейс вместо
    смерти приложения;
  • preprocess.py можно править на месте, не пересобирая exe.

Плата: pymeshlab должен стоять во внешнем venv — том же, где torch/MONAI.

Контракт (не изменился):
    INPUTS  = ["mesh_raw"]       — исходный OBJ
    OUTPUTS = ["mesh_clean"]     — упрощённый и очищенный OBJ
    PARAMS  = {ratio, smooth}    — параметры упрощения и сглаживания
"""

import os
import subprocess
import sys


NAME = "preprocess"
INPUTS = ["mesh_raw"]
OUTPUTS = ["mesh_clean"]
PARAMS = {
    "ratio": 0.5,     # доля граней после упрощения
    "smooth": 10,     # итераций Taubin
    "python": "",     # путь к внешнему python; пусто → env / сохранённый конфиг / автопоиск
    "timeout": 0,   # секунд на препроцессинг; 0 = без ограничения
}


def _frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def _app_dir() -> str:
    """Каталог приложения: рядом с .exe в бандле, корень репо из исходников."""
    if _frozen():
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _saved_python() -> str:
    """Путь, который врач выбрал в карточке «Модель» — он же годится и сюда,
    это тот же venv с torch. Читаем тот же файл, что пишет infer_config.py."""
    try:
        from . import infer_config
        return (infer_config._load_saved().get("python") or "").strip()
    except Exception:
        pass
    # Запасной путь: читаем файл напрямую, если импорт почему-то не прошёл.
    try:
        import json
        base = (os.environ.get("NASAL_BASE_DIR", "").strip() or _app_dir())
        with open(os.path.join(base, ".nasal_infer_cfg.json"), "r", encoding="utf-8") as fh:
            d = json.load(fh)
        return (d.get("python") or "").strip() if isinstance(d, dict) else ""
    except Exception:
        return ""


def _has_pymeshlab(py: str, timeout: int = 10) -> bool:
    """Быстрая проверка через find_spec — без импорта самого пакета."""
    code = ("import importlib.util as u,sys;"
            "sys.exit(0 if u.find_spec('pymeshlab') is not None else 1)")
    try:
        return subprocess.run([py, "-c", code], capture_output=True,
                              timeout=timeout, **_no_window()).returncode == 0
    except Exception:
        return False


def _resolve_python(params: dict) -> str:
    """Порядок: параметр из UI → env → сохранённый выбор врача → автопоиск."""
    for cand in (
        (params.get("python") or "").strip(),
        os.environ.get("NASAL_PREPROCESS_PYTHON", "").strip(),
        os.environ.get("NASAL_INFER_PYTHON", "").strip(),
        _saved_python(),
    ):
        if cand and os.path.isfile(cand):
            return cand

    try:
        from . import infer_config
        for py in infer_config._python_candidates(deep=False):
            if _has_pymeshlab(py):
                return py
    except Exception:
        pass
    return ""



def _resolve_script() -> str:
    """preprocess.py: сначала рядом с .exe
    потом внутри бандла, потом рядом с пакетом (запуск из исходников)."""
    cands = []
    env = os.environ.get("NASAL_PREPROCESS_SCRIPT", "").strip()
    if env:
        cands.append(env)
    cands.append(os.path.join(_app_dir(), "preprocess.py"))
    meipass = getattr(sys, "_MEIPASS", "")
    if meipass:
        cands.append(os.path.join(meipass, "preprocess.py"))
    cands.append(os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "preprocess.py"))

    for c in cands:
        if c and os.path.isfile(c):
            return c
    return ""



def _no_window() -> dict:
    if os.name == "nt":
        return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
    return {}


def _child_env() -> dict:
    """Окружение для дочернего python.

    КРИТИЧНО: PyInstaller подставляет свой _internal в начало PATH. Дочерний
    интерпретатор из чужого venv может подхватить оттуда наши DLL (numpy/MKL,
    libiomp5md.dll, zlib) вместо своих и упасть с access violation. Вырезаем
    каталог бандла из PATH перед запуском.
    """
    env = dict(os.environ)
    env.setdefault("PYTHONIOENCODING", "utf-8")
    env.setdefault("PYTHONUNBUFFERED", "1")

    meipass = getattr(sys, "_MEIPASS", "")
    if meipass:
        target = os.path.normcase(os.path.abspath(meipass))
        kept = []
        for d in env.get("PATH", "").split(os.pathsep):
            if not d:
                continue
            try:
                if os.path.normcase(os.path.abspath(d)) == target:
                    continue
            except Exception:
                pass
            kept.append(d)
        env["PATH"] = os.pathsep.join(kept)
    return env


def _tail(text: str, n: int = 40) -> str:
    lines = [l for l in (text or "").splitlines() if l.strip()]
    return "\n".join(lines[-n:])


def _run_external(python: str, script: str, in_path: str, out_path: str,
                  ratio, smooth, timeout: int) -> None:
    cmd = [
        python, "-u", script,
        in_path,
        "-o", out_path,
        "--ratio", str(ratio),
        "--smooth", str(smooth),
    ]
    print("[preprocess] CMD:", " ".join(cmd), flush=True)

    kwargs = dict(
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        env=_child_env(), **_no_window()
    )
    if timeout and int(timeout) > 0:
        kwargs["timeout"] = int(timeout)

    try:
        r = subprocess.run(cmd, **kwargs)
    except subprocess.TimeoutExpired:
        raise RuntimeError(
            f"Препроцессинг не уложился в {timeout} с. Меш слишком большой — "
            f"уменьшите отмеченную область или поднимите параметр timeout."
        )
    except OSError as e:
        raise RuntimeError(f"Не удалось запустить препроцессинг: {e}")

    out = (r.stdout or "") + (r.stderr or "")
    for line in out.splitlines():
        if line.strip():
            print("[preprocess]", line, flush=True)

    if r.returncode != 0:
        raise RuntimeError(
            f"Препроцессинг завершился с кодом {r.returncode}.\n{_tail(out)}"
        )



def run(session, params):
    p = {**PARAMS, **(params or {})}

    in_path = session.path("mesh_raw")
    if in_path is None:
        raise ValueError("session missing 'mesh_raw' — upload OBJ first")

    out_path = session.reserve("mesh_clean", ".obj")

    script = _resolve_script()
    if not script:
        raise FileNotFoundError(
            "Не найден preprocess.py. Положите его рядом с приложением "
            "или задайте переменную окружения NASAL_PREPROCESS_SCRIPT."
        )

    python = _resolve_python(p)

    if not python:
        if _frozen():
            raise FileNotFoundError(
                "Не найден python с установленным pymeshlab.\n"
                "Укажите его в карточке «Модель» на вкладке сегментации "
                "(тот же интерпретатор, что для инференса) или задайте "
                "переменную окружения NASAL_PREPROCESS_PYTHON.\n"
                "В этом окружении должен быть установлен pymeshlab: "
                "pip install pymeshlab"
            )
        print("[preprocess] внешний python не найден — запускаю in-process "
              "(допустимо только из исходников)", flush=True)
        import preprocess as _user_script
        saved_argv = sys.argv
        try:
            sys.argv = ["preprocess.py", in_path, "-o", out_path,
                        "--ratio", str(p["ratio"]), "--smooth", str(p["smooth"])]
            _user_script.main()
        finally:
            sys.argv = saved_argv
    else:
        _run_external(python, script, in_path, out_path,
                      p["ratio"], p["smooth"], p.get("timeout", 900))

    if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
        raise RuntimeError(
            "Препроцессинг отработал, но очищенный OBJ не создан или пуст. "
            "Проверьте лог выше."
        )

    session.register("mesh_clean", out_path)
