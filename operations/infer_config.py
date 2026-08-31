"""
operations/infer_config.py — авто-поиск путей модели для UI (без ручного ввода).

Контракт:
    NAME    = "infer_config"
    INPUTS  = []
    OUTPUTS = ["infer_config_json"]
    PARAMS  = {"deep": False}   # deep=true — более широкий поиск python

Возвращает не только «лучшие» пути, но и СПИСКИ найденных кандидатов —
фронт показывает их выпадающими списками (как «Найти» в Slicer), врачу не
нужно вводить путь руками. Для python кандидаты проверяются на наличие
torch / SimpleITK / monai (через find_spec — быстро, без импорта самих пакетов).

JSON:
{
  "python": "...", "script": "...", "ckpt": "...", "device": "auto",
  "candidates": {
     "python": [{"path": "...", "ok": true}, ...],
     "script": [{"path": "...", "ok": true}, ...],
     "ckpt":   [{"path": "...", "ok": true}, ...]
  },
  "found": {"python": bool, "script": bool, "ckpt": bool}
}
"""

import os
import glob
import subprocess

from proc_utils import no_window   # без всплывающего окна консоли

NAME = "infer_config"
INPUTS = []
OUTPUTS = ["infer_config_json"]
PARAMS = {"deep": False}


def _base_dirs():
    import sys
    cand = []
    env_base = os.environ.get("NASAL_BASE_DIR", "").strip()
    if env_base:
        cand.append(env_base)
    here = os.path.dirname(os.path.abspath(__file__))   # .../operations
    repo = os.path.dirname(here)                        # корень репо
    cand += [repo, here, os.getcwd()]
    # каталог исполняемого файла — на случай собранного exe (PyInstaller)
    try:
        cand.append(os.path.dirname(os.path.abspath(sys.executable)))
    except Exception:
        pass
    p = repo
    for _ in range(4):
        p = os.path.dirname(p)
        if p and p not in cand:
            cand.append(p)
    seen, out = set(), []
    for d in cand:
        try:
            rp = os.path.realpath(d)
        except Exception:
            continue
        if rp not in seen and os.path.isdir(rp):
            seen.add(rp)
            out.append(rp)
    return out



def _py_exe_names():
    if os.name == "nt":
        return [("Scripts", "python.exe"), ("python.exe",)]
    return [("bin", "python"), ("bin", "python3"), ("python3",), ("python",)]


def _python_candidates(deep):
    """Список существующих python-исполняемых рядом с приложением и в conda/venv."""
    out, seen = [], set()

    def add(p):
        try:
            rp = os.path.realpath(p)
        except Exception:
            return
        if rp in seen or not os.path.isfile(rp):
            return
        seen.add(rp)
        out.append(rp)

    env = os.environ.get("NASAL_INFER_PYTHON", "").strip()
    if env:
        add(env)

    env_names = (".venv", "venv", "env", ".conda", "conda", "miniconda3", "anaconda3")
    for base in _base_dirs():
        for e in env_names:
            for parts in _py_exe_names():
                add(os.path.join(base, e, *parts))
        # conda-style: <base>/envs/<name>/python(.exe)  и  <base>/*/envs/<name>/...
        for envs_root in (os.path.join(base, "envs"),):
            if os.path.isdir(envs_root):
                try:
                    names = sorted(os.listdir(envs_root))
                except OSError:
                    names = []
                for nm in names:
                    for parts in _py_exe_names():
                        add(os.path.join(envs_root, nm, *parts))
        # python прямо в каталоге
        for parts in _py_exe_names():
            add(os.path.join(base, *parts))

    # домашние conda-окружения
    home = os.path.expanduser("~")
    roots = [
        os.path.join(home, "miniconda3", "envs"),
        os.path.join(home, "anaconda3", "envs"),
        os.path.join(home, "mambaforge", "envs"),
        os.path.join(home, "AppData", "Local", "Programs", "Python"),
    ]
    for root in roots:
        if not os.path.isdir(root):
            continue
        try:
            children = sorted(os.listdir(root))
        except OSError:
            children = []
        for ch in children:
            for parts in _py_exe_names():
                add(os.path.join(root, ch, *parts))

    return out[: (40 if deep else 16)]


def _probe_python(py, timeout=8):
    """Есть ли в этом python torch / monai / SimpleITK / numpy (быстро, find_spec)."""
    code = (
        "import importlib.util as u,sys;"
        "m=['torch','monai','SimpleITK','numpy'];"
        "sys.exit(0 if all(u.find_spec(x) is not None for x in m) else 1)"
    )
    try:
        r = subprocess.run([py, "-c", code], capture_output=True, timeout=timeout,
                           **no_window())
        return r.returncode == 0
    except Exception:
        return False



def _script_candidates():
    out, seen = [], set()
    env = os.environ.get("NASAL_INFER_SCRIPT", "").strip()
    if env and os.path.isfile(env):
        out.append(env); seen.add(os.path.realpath(env))
    for base in _base_dirs():
        for sub in ("", "Resources", os.path.join("Resources", "Scripts"), "scripts"):
            cand = os.path.join(base, sub, "infer_swinunetr_cli.py")
            if os.path.isfile(cand):
                rp = os.path.realpath(cand)
                if rp not in seen:
                    seen.add(rp); out.append(cand)
    return out


def _ckpt_candidates():
    out, seen = [], set()
    env = os.environ.get("NASAL_INFER_CKPT", "").strip()
    if env and os.path.isfile(env):
        out.append(env); seen.add(os.path.realpath(env))
    preferred = ("model_2class.ckpt", "model.ckpt", "nasal_2class.ckpt")
    for base in _base_dirs():
        for n in preferred:
            cand = os.path.join(base, n)
            if os.path.isfile(cand):
                rp = os.path.realpath(cand)
                if rp not in seen:
                    seen.add(rp); out.append(cand)
    # любые *.ckpt в базовых каталогах и на 1 уровень вглубь
    for base in _base_dirs():
        hits = glob.glob(os.path.join(base, "*.ckpt")) + glob.glob(os.path.join(base, "*", "*.ckpt"))
        for h in sorted(hits):
            rp = os.path.realpath(h)
            if rp not in seen:
                seen.add(rp); out.append(h)
    return out


def _cfg_store_path():
    """Файл для запоминания выбранных путей между запусками (рядом с репо)."""
    base = (os.environ.get("NASAL_BASE_DIR", "").strip()
            or os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return os.path.join(base, ".nasal_infer_cfg.json")


def _fix_mojibake(s: str) -> str:
    if not s or s.isascii():
        return s
    if os.path.exists(s):
        return s
    try:
        fixed = s.encode("cp1251").decode("utf-8")
        if fixed != s and os.path.exists(fixed):
            return fixed
    except (UnicodeEncodeError, UnicodeDecodeError):
        pass
    return s


def _load_saved():
    try:
        with open(_cfg_store_path(), "r", encoding="utf-8") as fh:
            import json
            d = json.load(fh)
            if not isinstance(d, dict):
                return {}
            return {k: (_fix_mojibake(v) if isinstance(v, str) else v)
                    for k, v in d.items()}
    except Exception:
        return {}


def run(session, params):
    import json

    # Режим сохранения выбора врача
    if params.get("save"):
        store = {k: _fix_mojibake(str(params.get(k, "") or ""))
                 for k in ("python", "script", "ckpt")}
        try:
            with open(_cfg_store_path(), "w", encoding="utf-8") as fh:
                json.dump(store, fh, ensure_ascii=False)
        except Exception:
            pass
        out = session.reserve("infer_config_json", ".json")
        with open(out, "w", encoding="utf-8") as fh:
            json.dump({"saved": True}, fh, ensure_ascii=False)
        session.register("infer_config_json", out)
        return

    deep = bool(params.get("deep"))
    # при ручном «Искать заново» (deep) — игнорируем запомненное, ищем заново
    saved = {} if deep else _load_saved()

    py_cands = _python_candidates(deep)
    py_info, best_py = [], ""
    for p in py_cands:
        ok = _probe_python(p)
        py_info.append({"path": p, "ok": ok})
        if ok and not best_py:
            best_py = p
    if not best_py and py_info:
        best_py = py_info[0]["path"]

    scripts = _script_candidates()
    ckpts = _ckpt_candidates()

    # ранее сохранённый врачом выбор имеет приоритет (и добавляется в кандидаты)
    def _prefer(saved_val, auto_val, cand_list, probe=False):
        if saved_val and os.path.exists(saved_val):
            if saved_val not in [c["path"] for c in cand_list]:
                ok = _probe_python(saved_val) if probe else True
                cand_list.insert(0, {"path": saved_val, "ok": ok})
            return saved_val
        return auto_val

    best_py = _prefer(saved.get("python"), best_py, py_info, probe=True)
    script_cands = [{"path": s, "ok": True} for s in scripts]
    ckpt_cands = [{"path": c, "ok": True} for c in ckpts]
    best_script = _prefer(saved.get("script"), scripts[0] if scripts else "", script_cands)
    best_ckpt = _prefer(saved.get("ckpt"), ckpts[0] if ckpts else "", ckpt_cands)

    cfg = {
        "python": best_py,
        "script": best_script,
        "ckpt": best_ckpt,
        "device": "auto",
        "candidates": {"python": py_info, "script": script_cands, "ckpt": ckpt_cands},
        "found": {
            "python": any(c["ok"] for c in py_info),
            "script": bool(script_cands),
            "ckpt": bool(ckpt_cands),
        },
    }

    out = session.reserve("infer_config_json", ".json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, ensure_ascii=False)
    session.register("infer_config_json", out)
