"""
Тонкий диспатчер. НЕ знает имён конкретных операций.
Всё специфичное живёт в operations/*.py.

Endpoints:
  GET    /                       — главная страница (static/nasal-planner.html)
  GET    /<path>                 — статика

  GET    /api/operations         — метаданные всех зарегистрированных операций
  POST   /api/<op_name>          — запустить операцию. body = JSON с параметрами
                                   (опционально, дефолты берутся из PARAMS)

  GET    /api/session            — манифест session: {key: filename}
  GET    /api/session/<key>      — файл артефакта (для рендера или скачивания)
  PUT    /api/session/<key>      — загрузить правленую версию артефакта
                                   (multipart 'file' или raw JSON body)
  DELETE /api/session            — полный сброс сессии

  POST   /api/upload/<key>       — прямая заливка файла в session под ключом <key>
                                   (используется для mesh_raw при старте)

  GET    /api/health             — для entry.py, чтобы понять что сервер поднялся
"""

import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback

from proc_utils import no_window   # без всплывающего окна консоли

from flask import (
    Flask,
    Response,
    request,
    send_from_directory,
    send_file,
    jsonify,
    abort,
)

import session as _session_module
import operations


def create_app(static_dir: str) -> Flask:
    app = Flask(__name__, static_folder=static_dir, static_url_path="")

    # Загрузка DICOM может быть объёмной (сотни срезов). Снимаем лимиты,
    # которые в новых Flask/Werkzeug по умолчанию приводят к HTTP 413.
    app.config["MAX_CONTENT_LENGTH"] = None
    for _k in ("MAX_FORM_MEMORY_SIZE",):
        try: app.config[_k] = None
        except Exception: pass
    try: app.config["MAX_FORM_PARTS"] = 1_000_000
    except Exception: pass

    # ============================================================
    # Front
    # ============================================================

    @app.route("/")
    def index():
        for name in ("nasal-planner.html", "test.html", "index.html"):
            if os.path.exists(os.path.join(static_dir, name)):
                return send_from_directory(static_dir, name)
        abort(404, "no HTML found in static/")

    @app.route("/<path:path>")
    def static_files(path: str):
        full = os.path.join(static_dir, path)
        if not os.path.exists(full):
            abort(404)
        return send_from_directory(static_dir, path)

    # ============================================================
    # Health
    # ============================================================

    @app.route("/api/health")
    def health():
        return jsonify({"ok": True})

    # ============================================================
    # Operations
    # ============================================================

    @app.route("/api/operations")
    def list_operations():
        """Метаданные всех операций — фронт знает какие endpoint'ы доступны."""
        return jsonify({
            name: {
                "inputs": list(op.INPUTS),
                "outputs": list(op.OUTPUTS),
                "params": dict(op.PARAMS),
            }
            for name, op in operations.registry.items()
        })

    @app.route("/api/<op_name>", methods=["POST"])
    def run_operation(op_name: str):
        """Запуск операции по имени. Тонкая валидация + вызов op.run()."""
        op = operations.registry.get(op_name)
        if op is None:
            return jsonify({"error": f"unknown operation '{op_name}'"}), 404

        sess = _session_module.get()

        # Проверим что все требуемые INPUTS есть в session
        missing = [k for k in op.INPUTS if not sess.has(k)]
        if missing:
            return jsonify({
                "error": (
                    f"session missing required inputs: {missing}. "
                    f"Run prerequisite operations first or upload the file."
                ),
                "needed": missing,
            }), 400

        # Мержим дефолтные PARAMS с тем что прислал фронт
        user_params = request.get_json(silent=True) or {}
        params = {**op.PARAMS, **user_params}

        try:
            op.run(sess, params)
        except Exception as e:
            traceback.print_exc()
            return jsonify({"error": f"'{op_name}' failed: {e}"}), 500

        return jsonify({
            "ok": True,
            "operation": op_name,
            "outputs": list(op.OUTPUTS),
            "session": sess.manifest(),
        })

    @app.route("/api/<op_name>/stream", methods=["POST"])
    def run_operation_stream(op_name: str):
        """Запуск операции с стримингом прогресса через Server-Sent Events.

        Фронт делает fetch с ReadableStream и парсит строки вида 'data: {...}\\n\\n'.
        Поток событий:
            data: {"stage": "Чтение CT…"}
            data: {"stage": "Растеризация ROI-меша…"}
            ...
            data: {"ok": true, "session": {...}}      — финал, успех
            data: {"error": "..."}                     — финал, ошибка

        Операция должна принимать в params служебный ключ '__progress__'
        (fn(msg)). Если не принимает — прогресса не будет, но финальный
        статус всё равно пришлётся.
        """
        op = operations.registry.get(op_name)
        if op is None:
            return jsonify({"error": f"unknown operation '{op_name}'"}), 404

        sess = _session_module.get()
        missing = [k for k in op.INPUTS if not sess.has(k)]
        if missing:
            return jsonify({
                "error": f"session missing required inputs: {missing}",
                "needed": missing,
            }), 400

        user_params = request.get_json(silent=True) or {}
        params = {**op.PARAMS, **user_params}

        # Очередь сообщений: воркер-поток пишет, генератор-ответ читает.
        q: "queue.Queue[dict]" = queue.Queue()
        SENTINEL = object()

        def worker():
            # __progress__ — внутренний ключ для operations/*.py.
            params["__progress__"] = lambda msg: q.put({"stage": str(msg)})
            try:
                op.run(sess, params)
                q.put({"ok": True,
                       "operation": op_name,
                       "outputs": list(op.OUTPUTS),
                       "session": sess.manifest()})
            except Exception as e:
                # «Ожидаемые» ситуации (например, серия не собирается в объём)
                # логируем спокойно — без пугающего трейсбека.
                if type(e).__name__ == "_ExpectedSeriesError":
                    print("[%s] %s" % (op_name, e), flush=True)
                else:
                    traceback.print_exc()
                q.put({"error": f"'{op_name}' failed: {e}"})
            finally:
                q.put(SENTINEL)

        t = threading.Thread(target=worker, daemon=True)
        t.start()

        def generate():
            import json as _json
            while True:
                item = q.get()
                if item is SENTINEL:
                    break
                yield f"data: {_json.dumps(item, ensure_ascii=False)}\n\n"

        # Content-Type text/event-stream + отключённый кэш + chunked transfer
        return Response(generate(), mimetype="text/event-stream",
                        headers={"Cache-Control": "no-cache",
                                 "X-Accel-Buffering": "no"})

    # ============================================================
    # Session
    # ============================================================

    @app.route("/api/session")
    def session_manifest():
        return jsonify(_session_module.get().manifest())

    # ============================================================
    # Архив сессии (.nplan) — сохранение и открытие одним файлом
    # ============================================================
    #
    # ВАЖНО про порядок. Эти маршруты объявлены ДО "/api/session/<key>",
    # иначе Flask сопоставит "archive" с <key>: обработчик пойдёт искать
    # артефакт с таким именем, не найдёт и вернёт HTML-страницу 404.
    # На фронте это выглядело как
    #     Unexpected token '<', "<!doctype "... is not valid JSON
    # то есть как поломка JSON, хотя маршрута просто не существовало.

    def _archive_name() -> str:
        return "nasal-" + time.strftime("%Y%m%d-%H%M") + ".nplan"

    ARCHIVE_FORMAT = 1

    def _build_archive(sess) -> str:
        """Собрать .nplan (обычный ZIP) во временном файле, вернуть путь.

        Формат манифеста должен совпадать с тем, что уже писали прежние
        версии приложения, иначе старые архивы перестанут открываться:

            {"format": 1, "app_version": ..., "created": ...,
             "entries": {"ct_raw": {"file": "data/ct_raw.nrrd",
                                    "size": 45527852}, ...}}
        """
        import zipfile
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".nplan")
        tmp.close()

        entries = {}
        with zipfile.ZipFile(tmp.name, "w", zipfile.ZIP_DEFLATED) as z:
            for key, fname in sess.manifest().items():
                src = sess.path(key)
                if not src or not os.path.exists(src):
                    continue
                arc = "data/" + os.path.basename(src)
                z.write(src, arc)
                entries[key] = {"file": arc, "size": os.path.getsize(src)}

            man = {
                "format": ARCHIVE_FORMAT,
                "app_version": time.strftime("%Y.%m.%d"),
                "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "light": False,
                "skipped": [],
                "entries": entries,
            }
            z.writestr("manifest.json",
                       json.dumps(man, ensure_ascii=False, indent=2))
        return tmp.name

    @app.route("/api/session/archive", methods=["GET"])
    def session_archive_get():
        sess = _session_module.get()
        try:
            path = _build_archive(sess)
        except Exception as e:
            return jsonify({"error": f"не удалось собрать архив: {e}"}), 500
        return send_file(path, as_attachment=True,
                         download_name=_archive_name(),
                         mimetype="application/zip")

    @app.route("/api/session/save_to_disk", methods=["POST"])
    def session_save_to_disk():
        """Положить архив рядом с приложением и вернуть путь.

        Запасной путь для окружений без showSaveFilePicker: врач не
        выбирает место, зато видит, куда именно легло."""
        sess = _session_module.get()
        try:
            tmp = _build_archive(sess)
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

        base = os.path.dirname(sys.executable if getattr(sys, "frozen", False)
                               else os.path.abspath(__file__))
        out = os.path.join(base, _archive_name())
        try:
            shutil.move(tmp, out)
        except Exception as e:
            return jsonify({"ok": False, "error": f"не удалось записать: {e}"}), 500
        return jsonify({"ok": True, "path": out, "size": os.path.getsize(out)})

    @app.route("/api/session/archive", methods=["POST"])
    def session_archive_post():
        """Открыть .nplan: распаковать артефакты в текущую сессию.

        Возвращает loaded — список фактически восстановленных ключей.
        Фронт по нему решает, какие вкладки восстанавливать: опрашивать
        все подряд нельзя, отсутствующие дадут 404 в журнале и будут
        выглядеть как поломка."""
        import zipfile
        if "file" not in request.files:
            return jsonify({"error": "нет файла в запросе"}), 400

        f = request.files["file"]
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".nplan")
        f.save(tmp.name)
        tmp.close()

        sess = _session_module.get()
        loaded = []
        try:
            with zipfile.ZipFile(tmp.name) as z:
                names = set(z.namelist())
                if "manifest.json" not in names:
                    return jsonify({"error": "это не архив сессии: нет manifest.json"}), 400
                man = json.loads(z.read("manifest.json").decode("utf-8"))

                # Основной формат: {"entries": {key: {"file": ..., "size": ...}}}
                # Плоский {key: filename} поддерживаем на случай архивов,
                # собранных другой версией.
                raw = man.get("entries")
                if isinstance(raw, dict):
                    items = [(k, (v.get("file") if isinstance(v, dict) else v))
                             for k, v in raw.items()]
                else:
                    items = [(k, v) for k, v in man.items()
                             if isinstance(v, str)]

                for key, fname in items:
                    if not fname:
                        continue
                    entry = fname if fname in names else "data/" + os.path.basename(fname)
                    if entry not in names:
                        continue          # артефакта в архиве нет — пропускаем
                    ext = os.path.splitext(fname)[1] or ".bin"
                    dst = sess.reserve(key, ext)
                    with z.open(entry) as src, open(dst, "wb") as out:
                        shutil.copyfileobj(src, out)
                    sess.register(key, dst)
                    loaded.append(key)
        except zipfile.BadZipFile:
            return jsonify({"error": "файл повреждён или не является архивом"}), 400
        except Exception as e:
            return jsonify({"error": str(e)}), 500
        finally:
            try:
                os.unlink(tmp.name)
            except OSError:
                pass

        return jsonify({"ok": True, "loaded": loaded})

    @app.route("/api/session/<key>", methods=["GET"])
    def session_get(key: str):
        sess = _session_module.get()
        path = sess.path(key)
        if path is None:
            abort(404, f"no artifact '{key}' in session")
        return send_file(path, as_attachment=False)

    @app.route("/api/session/<key>", methods=["PUT"])
    def session_put(key: str):
        """Сохранить правленую версию артефакта (от фронта после редактирования)."""
        sess = _session_module.get()

        if "file" in request.files:
            f = request.files["file"]
            ext = os.path.splitext(f.filename or ".bin")[1] or ".bin"
            path = sess.reserve(key, ext)
            f.save(path)
            sess.register(key, path)
        else:
            body = request.get_data()
            if not body:
                return jsonify({"error": "empty body"}), 400
            ext = ".json" if request.content_type == "application/json" else ".bin"
            sess.write_bytes(key, body, ext)

        return jsonify({"ok": True, "key": key})

    @app.route("/api/session", methods=["DELETE"])
    def session_reset():
        _session_module.get().reset()
        return jsonify({"ok": True})

    # ============================================================
    # Upload — удобный shortcut для залива файла в session
    # ============================================================

    @app.route("/api/upload/<key>", methods=["POST"])
    def upload(key: str):
        """Залить файл в session под ключом <key>. Фронт использует это
        для исходного OBJ: POST /api/upload/mesh_raw с multipart 'file'.
        Дальше можно дёргать POST /api/preprocess."""
        if "file" not in request.files:
            return jsonify({"error": "missing 'file' field"}), 400
        f = request.files["file"]
        if not f.filename:
            return jsonify({"error": "empty filename"}), 400

        # Если загружают mesh_raw — инвалидируем всё, что от него зависит
        # (mesh_clean, inner_surface, zones…), НО сохраняем ct_raw:
        # он грузится независимо, не должен теряться при перезаливе OBJ.
        sess = _session_module.get()
        if key == "mesh_raw":
            sess.reset_except(["ct_raw"])

        ext = os.path.splitext(f.filename)[1] or ".bin"
        path = sess.reserve(key, ext)
        f.save(path)
        sess.register(key, path)

        return jsonify({"ok": True, "key": key, "session": sess.manifest()})

    # ============================================================
    # DICOM — батч-загрузка файлов папки в session/dicom_src
    # ============================================================

    @app.route("/api/dicom_upload", methods=["POST"])
    def dicom_upload():
        """Принять часть файлов DICOM-папки (multipart, поле 'files').
        ?reset=1 в первом запросе очищает прежнюю папку. Файлы пишутся в
        <session>/dicom_src с сохранением относительного пути. Маленькие
        батчи вместо одного гиганта — чтобы не упираться в лимит запроса."""
        import shutil
        sess = _session_module.get()

        # Новый DICOM обесценивает ВСЮ цепочку: маску, меш, слизистую,
        # зоны, развёртку. Раньше чистилась только папка dicom_src, а
        # артефакты предыдущего пациента оставались в сессии — и при
        # переходе на «Зоны» или «Развёртку» врач увидел бы ЧУЖИЕ данные,
        # выглядящие совершенно достоверно.
        #
        # Так и было на практике: в одной сессии лежали ct_raw от 18:37,
        # inner_surface и unfolded.json от 18:34 (прошлый случай) и
        # mesh_raw от 18:25 (позапрошлый). Плюс ~600 МБ мусора.
        #
        # reset() делает свежую временную папку, поэтому чистить
        # dicom_src отдельно уже не нужно.
        if request.args.get("reset") == "1":
            sess.reset()

        dst = os.path.join(sess.dir, "dicom_src")
        os.makedirs(dst, exist_ok=True)
        root = os.path.realpath(dst)
        saved = 0
        for f in request.files.getlist("files"):
            rel = (f.filename or "").replace("\\", "/").lstrip("/")
            if not rel:
                continue
            target = os.path.realpath(os.path.join(dst, rel))
            if target != root and not target.startswith(root + os.sep):
                continue  # защита от выхода за пределы папки
            os.makedirs(os.path.dirname(target), exist_ok=True)
            f.save(target)
            saved += 1
        return jsonify({"ok": True, "saved": saved})

    @app.route("/api/dicom_pick_dir", methods=["POST"])
    def dicom_pick_dir():
        """Папка DICOM выбрана во встроенном проводнике (серверный путь).
        Копируем её содержимое в <session>/dicom_src — тот же результат, что
        и батч-загрузка через /api/dicom_upload, но без выгрузки по HTTP.
        Приложение локальное (FS = машина пользователя), поэтому путь читаем
        напрямую. Тело JSON: {dir: "<абсолютный путь к папке>"}."""
        import shutil
        data = request.get_json(silent=True) or {}
        raw = (data.get("dir") or "").strip()
        src = os.path.abspath(raw) if raw else ""
        if not src or not os.path.isdir(src):
            return jsonify({"ok": False, "error": "папка не найдена"}), 400

        sess = _session_module.get()
        # То же, что и при батч-загрузке: новый DICOM = новый случай,
        # прежние артефакты не должны пережить смену пациента.
        sess.reset()
        dst = os.path.join(sess.dir, "dicom_src")
        os.makedirs(dst, exist_ok=True)
        root = os.path.realpath(dst)

        saved = 0
        for cur, _dirs, names in os.walk(src):
            for name in names:
                sp = os.path.join(cur, name)
                rel = os.path.relpath(sp, src).replace("\\", "/").lstrip("/")
                target = os.path.realpath(os.path.join(dst, rel))
                if target != root and not target.startswith(root + os.sep):
                    continue  # защита от выхода за пределы папки
                os.makedirs(os.path.dirname(target), exist_ok=True)
                try:
                    shutil.copy2(sp, target)
                    saved += 1
                except OSError:
                    pass
        return jsonify({"ok": True, "saved": saved})

    # ============================================================
    # Разрешить путь к python по выбранной папке окружения + проверка
    # ============================================================

    @app.route("/api/resolve_python")
    def resolve_python():
        """dir = выбранная в проводнике папка окружения (или сам python).
        Находит интерпретатор внутри и проверяет torch/monai/SimpleITK/numpy.
        Возвращает {python, ok}."""
        raw = request.args.get("dir", "") or ""
        d = os.path.abspath(raw) if raw else ""

        cands = []
        if d and os.path.isfile(d):
            cands.append(d)               # выбрали сам исполняемый файл
        base = d if os.path.isdir(d) else os.path.dirname(d)
        if base:
            if os.name == "nt":
                cands += [
                    os.path.join(base, "Scripts", "python.exe"),
                    os.path.join(base, "python.exe"),
                    os.path.join(base, "Scripts", "pythonw.exe"),
                ]
            else:
                cands += [
                    os.path.join(base, "bin", "python"),
                    os.path.join(base, "bin", "python3"),
                    os.path.join(base, "python"),
                    os.path.join(base, "python3"),
                ]

        py = ""
        for c in cands:
            if os.path.isfile(c):
                py = c
                break

        ok = False
        if py:
            code = (
                "import importlib.util as u,sys;"
                "m=['torch','monai','SimpleITK','numpy'];"
                "sys.exit(0 if all(u.find_spec(x) is not None for x in m) else 1)"
            )
            try:
                r = subprocess.run([py, "-c", code], capture_output=True, timeout=12,
                                   **no_window())
                ok = r.returncode == 0
            except Exception:
                ok = False

        return jsonify({"python": py, "ok": ok})

    # ============================================================
    # Обзор файловой системы (для выбора python/скрипта/ckpt в UI)
    # ============================================================

    @app.route("/api/fs_list")
    def fs_list():
        """Содержимое каталога для файлового пикера. path=@drives — список
        дисков (Windows) / корня (POSIX). Приложение локальное (FS = машина
        пользователя), поэтому листинг безопасен в рамках одного юзера."""
        import string
        raw = request.args.get("path", "") or ""

        if raw == "@drives":
            roots = []
            if os.name == "nt":
                for ch in string.ascii_uppercase:
                    d = f"{ch}:\\"
                    if os.path.exists(d):
                        roots.append({"name": d, "path": d})
            else:
                roots.append({"name": "/", "path": "/"})
            return jsonify({"path": "@drives", "parent": None, "dirs": roots, "files": []})

        path = os.path.abspath(raw) if raw else os.path.expanduser("~")
        if not os.path.isdir(path):
            path = os.path.expanduser("~")

        dirs, files = [], []
        try:
            for name in sorted(os.listdir(path), key=lambda s: s.lower()):
                full = os.path.join(path, name)
                try:
                    if os.path.isdir(full):
                        dirs.append({"name": name, "path": full})
                    elif os.path.isfile(full):
                        files.append({"name": name, "path": full})
                except OSError:
                    pass
        except OSError as e:
            return jsonify({"error": str(e), "path": path,
                            "parent": os.path.dirname(path), "dirs": [], "files": []})

        parent = os.path.dirname(path)
        if not parent or parent == path:
            parent = "@drives"
        return jsonify({"path": path, "parent": parent, "dirs": dirs, "files": files})

    # ============================================================
    # Legacy endpoint (совместимость с test.html)
    # ============================================================

    @app.route("/api/preprocess_oneshot", methods=["POST"])
    def preprocess_oneshot():
        """One-shot для test.html: принять OBJ, запустить preprocess,
        отдать cleaned.obj. Внутри — обычный upload + run_operation."""
        if "file" not in request.files:
            return jsonify({"error": "missing 'file'"}), 400
        f = request.files["file"]

        sess = _session_module.get()
        sess.reset()
        raw_path = sess.reserve("mesh_raw", ".obj")
        f.save(raw_path)
        sess.register("mesh_raw", raw_path)

        op = operations.registry["preprocess"]
        try:
            params = {
                **op.PARAMS,
                "ratio": float(request.form.get("ratio", op.PARAMS["ratio"])),
                "smooth": int(request.form.get("smooth", op.PARAMS["smooth"])),
            }
            op.run(sess, params)
        except Exception as e:
            traceback.print_exc()
            return jsonify({"error": str(e)}), 500

        return send_file(
            sess.path("mesh_clean"),
            mimetype="model/obj",
            download_name="cleaned.obj",
        )

    return app
