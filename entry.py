r"""
Точка входа desktop-приложения.

Логика запуска:
  1. Парсим CLI-аргументы (--load <path>, --no-window)
  2. Поднимает Flask на 127.0.0.1:<свободный порт> в фоновом потоке
  3. Ждёт пока сервер ответит (health check)
  4. Если задан --load <path> — загружает файл через POST /api/upload/...
  5. Открывает нативное окно через pywebview, либо браузер.
     При --no-window — оставляем сервер крутиться без UI (для headless-режима
     из Slicer-плагина).

CLI:
  NasalPlanner.exe                              # обычный запуск
  NasalPlanner.exe --load C:\path\to\mesh.obj   # с авто-загрузкой OBJ
  NasalPlanner.exe --load C:\path\to\ct.nrrd    # с авто-загрузкой CT
  NASAL_PLANNER_BROWSER=1 NasalPlanner.exe      # форс браузер вместо окна

Работает и из исходников (`python entry.py ...`), и из PyInstaller-бандла.
"""

import argparse
import json
import mimetypes
import os
import socket
import sys
import threading
import time
import uuid
import webbrowser
from urllib import request as urlrequest

def _setup_streams():
    def _usable(st):
        if st is None:
            return False
        try:
            st.write(""); st.flush(); return True
        except Exception:
            return False

    frozen = getattr(sys, "frozen", False)
    if not frozen and _usable(sys.stdout) and _usable(sys.stderr):
        for st in (sys.stdout, sys.stderr):          # из исходников: только кодировка
            try:
                st.reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass
        return None
    try:
        base = os.path.dirname(sys.executable if frozen else os.path.abspath(__file__))
        path = os.path.join(base, "nasal_planner.log")
        fh = open(path, "a", encoding="utf-8", errors="replace", buffering=1)
        fh.write("\n" + "=" * 70 + "\nЗапуск: " +
                 time.strftime("%Y-%m-%d %H:%M:%S") + "\n")
        sys.stdout = fh
        sys.stderr = fh
        return path
    except Exception:
        try:
            devnull = open(os.devnull, "w")
            sys.stdout = devnull
            sys.stderr = devnull
        except Exception:
            pass
        return None


LOG_PATH = _setup_streams()
os.environ.setdefault("PYTHONIOENCODING", "utf-8")
from urllib.error import URLError


APP_VERSION = "2026.08.18"


def _frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def app_dir() -> str:
    if _frozen():
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def _fix_console_encoding() -> None:
    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.kernel32.SetConsoleOutputCP(65001)
        except Exception:
            pass
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            # windowed-режим PyInstaller: потоков может не быть вовсе
            pass


_fix_console_encoding()


os.environ.setdefault("NASAL_BASE_DIR", app_dir())
os.environ.setdefault("NASAL_PLANNER_VERSION", APP_VERSION)

from server import create_app  # noqa: E402  (после setdefault — намеренно)


def resource_path(relative: str) -> str:
    external = os.path.join(app_dir(), relative)
    if os.path.exists(external):
        return external
    if hasattr(sys, "_MEIPASS"):
        return os.path.join(sys._MEIPASS, relative)
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), relative)


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_until_up(host: str, port: int, timeout: float = 30.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.05)
    return False


def start_server(app, host: str, port: int) -> None:
    app.run(host=host, port=port, debug=False, use_reloader=False, threaded=True)


# ════════════════════════════════════════════════════════════════════════════
#                                  CLI
# ════════════════════════════════════════════════════════════════════════════
def _parse_args():
    """Парсим CLI. parse_known_args чтобы не падать на неожиданных аргументах
    (PyInstaller bootloader в режиме --onefile иногда подкидывает свои)."""
    p = argparse.ArgumentParser(
        prog="Nasal Planner",
        description="Nasal Planner — развёртка слизистой носовой полости",
    )
    p.add_argument(
        "--load",
        metavar="PATH",
        help="Путь к .obj или .nrrd для авто-загрузки при старте.",
    )
    p.add_argument(
        "--no-window",
        action="store_true",
        help="Не открывать pywebview-окно (headless-режим, для интеграций).",
    )
    p.add_argument(
        "--version",
        action="store_true",
        help="Напечатать версию сборки и выйти.",
    )
    args, _unknown = p.parse_known_args()
    return args


# ════════════════════════════════════════════════════════════════════════════
#                              Авто-загрузка файла
# ════════════════════════════════════════════════════════════════════════════
def _classify_file(path: str) -> str:
    """Определяем тип по расширению. Возвращает 'mesh_raw' / 'ct_raw' / ''."""
    name = os.path.basename(path).lower()
    if name.endswith(".obj"):
        return "mesh_raw"
    if name.endswith(".nrrd") or name.endswith(".nhdr"):
        return "ct_raw"
    return ""


def _upload_file(path: str, host: str, port: int, key: str) -> None:
    """POST <file> в /api/upload/<key>. Без зависимости от requests."""
    boundary = f"----NasalPlannerLoadBoundary{uuid.uuid4().hex}"
    with open(path, "rb") as f:
        file_data = f.read()

    mime, _ = mimetypes.guess_type(path)
    mime = mime or "application/octet-stream"

    body = b""
    body += f"--{boundary}\r\n".encode()
    body += (
        f'Content-Disposition: form-data; name="file"; '
        f'filename="{os.path.basename(path)}"\r\n'
    ).encode()
    body += f"Content-Type: {mime}\r\n\r\n".encode()
    body += file_data
    body += f"\r\n--{boundary}--\r\n".encode()

    req = urlrequest.Request(
        f"http://{host}:{port}/api/upload/{key}",
        data=body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(body)),
        },
        method="POST",
    )
    with urlrequest.urlopen(req, timeout=60) as r:
        resp = json.loads(r.read().decode("utf-8"))
        if not resp.get("ok"):
            raise RuntimeError(f"upload failed: {resp}")


def _try_autoload(path: str, host: str, port: int) -> None:
    """Загружает файл в session, если задан --load. Не падает на ошибке —
    только пишет в stderr, чтобы UI всё равно открылся."""
    if not path:
        return
    if not os.path.isfile(path):
        print(f"[entry] --load: файл не найден: {path}", file=sys.stderr)
        return

    key = _classify_file(path)
    if not key:
        print(
            f"[entry] --load: неподдерживаемое расширение: {path}. "
            f"Ожидается .obj, .nrrd или .nhdr.",
            file=sys.stderr,
        )
        return

    try:
        print(f"[entry] --load: загружаю {os.path.basename(path)} как {key}…")
        _upload_file(path, host, port, key)
        print(f"[entry] --load: ✓ загружено")
    except (URLError, OSError, RuntimeError) as e:
        print(f"[entry] --load: ошибка загрузки: {e}", file=sys.stderr)


# ════════════════════════════════════════════════════════════════════════════
#                              UI (pywebview / browser)
# ════════════════════════════════════════════════════════════════════════════
def _find_icon() -> str:
    """Спек ищет static/icon.ico, потом static/logo.ico — здесь так же,
    иначе окно остаётся без иконки, когда в проекте только logo.ico."""
    for name in ("icon.ico", "logo.ico"):
        p = resource_path(os.path.join("static", name))
        if os.path.isfile(p):
            return p
    return ""


def run_in_window(url: str) -> bool:
    """Пытаемся открыть нативное окно через pywebview.
    Возвращает True если получилось, False если был graceful фолбэк нужен."""
    try:
        import webview
    except ImportError:
        print("[entry] pywebview не установлен, откроется в браузере")
        return False

    try:
        kwargs = dict(
            title=f"Nasal Planner {APP_VERSION}",
            url=url,
            width=1280,
            height=800,
            min_size=(900, 600),
            maximized=True,
        )
        icon_path = _find_icon()
        if icon_path:
            try:
                webview.create_window(**kwargs, icon=icon_path)
            except TypeError:
                # Старая версия pywebview без параметра icon
                webview.create_window(**kwargs)
        else:
            webview.create_window(**kwargs)

        def _set_win_icon():
            if not icon_path or not sys.platform.startswith("win"):
                return
            try:
                import ctypes
                from ctypes import wintypes
                u32, k32 = ctypes.windll.user32, ctypes.windll.kernel32

                IMAGE_ICON, LR_LOADFROMFILE, LR_DEFAULTSIZE = 1, 0x0010, 0x0040
                WM_SETICON = 0x0080
                ICON_SMALL, ICON_BIG = 0, 1

                title = kwargs["title"]
                hwnd = 0
                for _ in range(50):                 # окно появляется не мгновенно
                    hwnd = u32.FindWindowW(None, title)
                    if hwnd:
                        break
                    time.sleep(0.1)
                if not hwnd:
                    return

                for flag, size in ((ICON_BIG, 32), (ICON_SMALL, 16)):
                    h = u32.LoadImageW(None, icon_path, IMAGE_ICON, size, size,
                                       LR_LOADFROMFILE)
                    if not h:
                        h = u32.LoadImageW(None, icon_path, IMAGE_ICON, 0, 0,
                                           LR_LOADFROMFILE | LR_DEFAULTSIZE)
                    if h:
                        u32.SendMessageW(hwnd, WM_SETICON, flag, h)

                GCLP_HICON, GCLP_HICONSM = -14, -34
                setClass = getattr(u32, "SetClassLongPtrW", None) or u32.SetClassLongW
                for gcl, size in ((GCLP_HICON, 32), (GCLP_HICONSM, 16)):
                    h = u32.LoadImageW(None, icon_path, IMAGE_ICON, size, size,
                                       LR_LOADFROMFILE)
                    if h:
                        try:
                            setClass(hwnd, gcl, h)
                        except Exception:
                            pass
            except Exception as e:
                print(f"[entry] иконку окна поставить не удалось: {e}",
                      file=sys.stderr, flush=True)

        threading.Thread(target=_set_win_icon, daemon=True).start()

        webview.start()

        print("[entry] webview.start() вернул управление — окно закрылось",
              flush=True)
        return True
    except Exception as e:
        print(f"[entry] pywebview не стартовал ({type(e).__name__}: {e})")
        print("[entry] Откроется в браузере.")
        return False


def run_in_browser(url: str) -> None:
    """Fallback: открыть дефолтный браузер и держать Flask в main-потоке."""
    print(f"[entry] Открываю {url} в браузере.")
    print("[entry] Сервер работает. Ctrl+C для остановки.")
    try:
        webbrowser.open(url)
    except Exception as e:
        print(f"[entry] Не смог открыть браузер автоматически ({e}).")
        print(f"[entry] Открой вручную: {url}")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[entry] Выход.")


def run_headless(url: str) -> None:
    """Headless-режим: только Flask, без UI. Для интеграций (Slicer-плагин и т.п.)."""
    print(f"[entry] Headless-режим. Сервер: {url}")
    print("[entry] Ctrl+C для остановки.")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[entry] Выход.")


# ════════════════════════════════════════════════════════════════════════════
#                                  main
# ════════════════════════════════════════════════════════════════════════════
def _set_app_id() -> None:
    if not sys.platform.startswith("win"):
        return
    try:
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(
            "NasalUnwrap.Planner")
    except Exception:
        pass


def main() -> None:
    _set_app_id()          # до любых окон
    args = _parse_args()

    if args.version:
        print(APP_VERSION)
        return

    print(f"[entry] Nasal Planner {APP_VERSION}", flush=True)
    print(f"[entry] frozen={_frozen()}  app_dir={app_dir()}", flush=True)

    static_dir = resource_path("static")
    print(f"[entry] static={static_dir}", flush=True)
    app = create_app(static_dir=static_dir)

    host = "127.0.0.1"
    port = find_free_port()

    t = threading.Thread(target=start_server, args=(app, host, port), daemon=True)
    t.start()

    if not wait_until_up(host, port):
        print("[entry] Сервер не стартовал за 30 секунд", file=sys.stderr)
        sys.exit(1)

    # Авто-загрузка файла, если запрошена через --load
    _try_autoload(args.load, host, port)

    url = f"http://{host}:{port}/"

    # Принудительный режим браузера через env var
    force_browser = os.environ.get("NASAL_PLANNER_BROWSER", "").strip() in (
        "1", "true", "yes",
    )

    if args.no_window:
        run_headless(url)
        return

    if force_browser:
        run_in_browser(url)
        return

    if not run_in_window(url):
        run_in_browser(url)


if __name__ == "__main__":
    main()
