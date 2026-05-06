"""
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
  Nasal Planner.exe                              # обычный запуск
  Nasal Planner.exe --load C:\path\to\mesh.obj   # с авто-загрузкой OBJ
  Nasal Planner.exe --load C:\path\to\ct.nrrd    # с авто-загрузкой CT
  NASAL_PLANNER_BROWSER=1 Nasal Planner.exe      # форс браузер вместо окна

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
from urllib.error import URLError

from server import create_app


def resource_path(relative: str) -> str:
    """Абсолютный путь к ресурсу — работает и в dev, и в PyInstaller-бандле."""
    if hasattr(sys, "_MEIPASS"):
        base = sys._MEIPASS
    else:
        base = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, relative)


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
            title="Nasal Planner",
            url=url,
            width=1280,
            height=800,
            min_size=(900, 600),
            maximized=True,
        )
        # Иконка, если есть. pywebview жуёт и .ico, и .png.
        icon_path = resource_path(os.path.join("static", "icon.ico"))
        if os.path.isfile(icon_path):
            try:
                webview.create_window(**kwargs, icon=icon_path)
            except TypeError:
                # Старая версия pywebview без параметра icon
                webview.create_window(**kwargs)
        else:
            webview.create_window(**kwargs)
        webview.start()
        return True
    except Exception as e:
        # На WSL без WSLg, на голом Linux без GTK/Qt, или если backend не собран —
        # не валимся с трейсом, просто уведомляем и возвращаем False.
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
def main() -> None:
    args = _parse_args()

    static_dir = resource_path("static")
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
