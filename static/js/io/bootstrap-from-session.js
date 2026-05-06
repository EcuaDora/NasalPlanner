/* ─── io/bootstrap-from-session ────────────────────────────────
   Автоподхват уже залитого в session OBJ при открытии страницы.

   Кейс: внешний агент (например, Slicer-модуль NasalPlanner.py) сделал
   POST /api/upload/mesh_raw и открыл UI в браузере. Наш фронт обычно
   ждёт, пока пользователь сам перетащит файл — это плохо, потому что
   меш-то уже на сервере.

   Что делаем:
     1. На DOMContentLoaded ждём, пока FileLoader / IO / M будут готовы
     2. Спрашиваем /api/session
     3. Если manifest.mesh_raw есть, а window.M.rawV — пуст:
        а) тянем байты mesh_raw обратно
        б) собираем фейковый File-объект
        в) дёргаем window.FileLoader.load(file) — точно тот же путь,
           что и при drag&drop, включая preprocess + рендер.

   Дублированный upload (мы заливаем те же байты обратно как mesh_raw)
   безопасен: server.py его просто перезапишет, reset_except(['ct_raw'])
   ничего полезного не сломает (CT при загрузке из Slicer'а нет, OBJ
   тот же самый).

   Если session пуста (юзер просто открыл entry.py без агента) — скрипт
   ничего не делает.
──────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // Не запускаемся, если уже что-то загружено локально (на случай
  // повторного триггера.
  function alreadyHaveMesh() {
    return !!(window.M && window.M.rawV);
  }

  function readyToBootstrap() {
    return (
      window.FileLoader &&
      typeof window.FileLoader.load === 'function' &&
      window.IO && typeof window.IO.parseOBJ === 'function' &&
      window.M && window.Geom
    );
  }

  async function bootstrap() {
    if (alreadyHaveMesh()) return;

    let manifest;
    try {
      const r = await fetch('/api/session', { cache: 'no-store' });
      if (!r.ok) {
        // Бэкенд лежит / эндпоинт не там, где ожидаем — тихо выходим
        return;
      }
      manifest = await r.json();
    } catch (_e) {
      return;
    }

    const rawName = manifest && manifest.mesh_raw;
    if (!rawName) return;   // session пустая — нормальный путь, выходим

    // Качаем байты обратно. /api/session/<key> отдаёт файл as-is.
    let blob;
    try {
      const r = await fetch('/api/session/' + encodeURIComponent('mesh_raw'),
                            { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      blob = await r.blob();
    } catch (e) {
      console.warn('[bootstrap-from-session] не смог достать mesh_raw:', e);
      return;
    }

    // Имя файла: пробуем взять из манифеста, иначе шаблон. Расширение .obj
    // обязательно — FileLoader.classify() роутит по нему.
    let displayName = String(rawName || 'from-agent.obj');
    if (!/\.obj$/i.test(displayName)) displayName = 'from-agent.obj';

    const file = new File([blob], displayName, { type: 'model/obj' });

    // Лог в консоль — пусть в DevTools видно, кто триггерит загрузку.
    // Тосты не показываем сами: FileLoader.loadObj покажет свой
    // «OBJ обработан / Препроцессинг не выполнен» как при ручной загрузке.
    console.log('[bootstrap-from-session] auto-loading mesh_raw from session ('
                + (file.size / 1024).toFixed(1) + ' КБ)');

    try {
      await window.FileLoader.load(file);
    } catch (e) {
      console.error('[bootstrap-from-session] FileLoader.load failed:', e);
    }
  }

  // Ждём пока другие модули зарегистрируются — у них на DOMContentLoaded
  // тоже свои listener'ы. Делаем небольшой polling вместо setTimeout-гадания.
  function waitAndBootstrap() {
    let attempts = 0;
    const tick = () => {
      if (alreadyHaveMesh()) return;
      if (readyToBootstrap()) { bootstrap(); return; }
      if (++attempts > 50) {  //
        console.warn('[bootstrap-from-session] FileLoader не готов за 5с, выходим');
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitAndBootstrap);
  } else {
    waitAndBootstrap();
  }
})();
