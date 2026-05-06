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

import os
import queue
import threading
import traceback

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
