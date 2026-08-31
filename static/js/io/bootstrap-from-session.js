/* ─── io/bootstrap-from-session ────────────────────────────────
   Восстановление сессии при открытии страницы.

   ЧТО БЫЛО. Скрипт умел ровно одно: скачать mesh_raw и прогнать через
   FileLoader.load(). Для исходного сценария — «Slicer залил OBJ и открыл
   UI» — этого хватало. Но с появлением архива сессии выяснилось, что
   этого мало: этапы разблокируются не наличием файлов на диске, а
   состоянием в памяти вкладки (tabs.js смотрит на M.rawV, M.V,
   M.zoneLabels). Архив честно клал всё в сессию, читать это было некому,
   и после загрузки открывались только этапы 01-03, а разметка КТ
   оставалась пустой.

   ЧТО СТАЛО. Проходим по манифесту и поднимаем всё, что есть, по
   цепочке:

     roi_ct+roi_mask → Tab0.restoreFromSession → этап 01 с редактором
     mesh_clean    → M.rawV/rawF           → открывает этап 03
     inner_surface → M.V/M.F + M.innerV/F  → открывает этап 04
     zones         → M.zoneLabels          → открывает этап 05
     unfolded      → Tab4.__serverPrecomputed
     paint_layer   → PaintLayer

   Каждый следующий шаг делается, только если предыдущий удался: без
   активного меша метки зон не к чему прикладывать, а без зон нет смысла
   в развёртке. Ошибка на любом шаге не роняет остальные — цепочка
   обрывается, и врач видит ровно те этапы, которые восстановились.

   ПОЧЕМУ mesh_clean, А НЕ mesh_raw. Раньше брали сырой OBJ и заново
   гоняли препроцессинг на сервере — это секунды на каждом открытии,
   притом результат уже лежит рядом в сессии. Сырой берём только если
   очищенного нет.
──────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  console.log('[версия] bootstrap · 2026-08-15 · данные и интерфейс разделены');

  const LOG = '[bootstrap] ';

  function ready() {
    return (
      window.FileLoader && typeof window.FileLoader.load === 'function' &&
      window.IO && typeof window.IO.parseOBJ === 'function' &&
      window.M && window.Geom
    );
  }

  function alreadyLoaded() {
    return !!(window.M && (window.M.rawV || window.M.V));
  }

  async function getText(key) {
    const r = await fetch('/api/session/' + encodeURIComponent(key),
                          { cache: 'no-store' });
    if (!r.ok) throw new Error(key + ': HTTP ' + r.status);
    return r.text();
  }

  async function getJSON(key) {
    const r = await fetch('/api/session/' + encodeURIComponent(key),
                          { cache: 'no-store' });
    if (!r.ok) throw new Error(key + ': HTTP ' + r.status);
    return r.json();
  }

  async function getBlob(key) {
    const r = await fetch('/api/session/' + encodeURIComponent(key),
                          { cache: 'no-store' });
    if (!r.ok) throw new Error(key + ': HTTP ' + r.status);
    return r.blob();
  }

  function refreshGates() {
    if (window.Tabs && window.Tabs.refreshGates) window.Tabs.refreshGates();
    /* Одно событие на всё восстановление, и с явным kind: вкладки видят,
       что данные пришли из сессии, а не от новой загрузки файла, и не
       начинают пересчёт с нуля. */
    window.dispatchEvent(new CustomEvent('data:change',
      { detail: { kind: 'session-restored' } }));
    window.dispatchEvent(new CustomEvent('data:change',
      { detail: { kind: 'obj-loaded' } }));
  }

  // ═══════════════════════════════════════════════════════════
  //  Шаги восстановления
  // ═══════════════════════════════════════════════════════════

  /* Этап 01. Открываем редактор срезов из уже готовых roi_ct и roi_mask.

     Раньше здесь звался CtLoader.handle() — и это было бесполезно: он
     всего лишь заливает файл обратно в сессию и шлёт 'ct:change'. Тома в
     редактор он не ставит, поэтому этап 01 оставался пустым, хотя данные
     лежали рядом. Правильная точка входа — Tab0.restoreFromSession. */
  async function restoreCT(manifest) {
    if (!manifest.roi_ct || !manifest.roi_mask) return false;
    if (!window.Tab0 || !window.Tab0.restoreFromSession) {
      console.warn(LOG + 'этап 01 не готов принять данные — КТ пропущено');
      return false;
    }
    /* Если вкладка сейчас видна — открываем сразу; иначе только отмечаем
       готовность, а редактор срезов поставится при входе. На скрытом
       холсте он строится вхолостую. */
    const stage = document.querySelector('.stage[data-stage="segment"]');
    if (stage && stage.classList.contains('active')) {
      return !!(await window.Tab0.restoreFromSession());
    }
    window.Tab0.__pendingRestore = true;
    return true;
  }

  /* Этап 02→03. Тот же commit, что делает FileLoader после препроцессинга:
     сырой меш плюс геометрия граней. */
  async function restoreMesh(manifest) {
    const key = manifest.mesh_clean ? 'mesh_clean'
              : (manifest.mesh_raw ? 'mesh_raw' : null);
    if (!key) return false;

    const mesh = window.IO.parseOBJ(await getText(key));
    if (!mesh.nV || !mesh.nF) throw new Error(key + ' пуст');

    /* M.reset() здесь НЕТ намеренно. Он обнуляет в том числе M.volume и
       M.volMask — состояние КТ, которое к этому моменту уже восстановлено.
       Сброс делается один раз в начале bootstrap, до всех шагов. */
    window.M.rawV  = mesh.V;   window.M.rawF  = mesh.F;
    window.M.rawNV = mesh.nV;  window.M.rawNF = mesh.nF;
    window.M.source = { type: key === 'mesh_clean' ? 'obj-cleaned' : 'obj-raw',
                        name: String(manifest[key] || key), bytes: 0 };

    const g = window.Geom.compute(mesh.V, mesh.F, mesh.nF);
    window.M.fn = g.fn; window.M.fa = g.fa; window.M.fc = g.fc;

    /* Событие рассылаем один раз в конце, когда всё состояние на месте,
       а не после каждого шага: подписчики не должны видеть половину
       восстановленной сессии. */
    return true;
  }

  /* Этап 03→04.

     ДАННЫЕ И ИНТЕРФЕЙС РАЗДЕЛЕНЫ. Сначала версия зависела от установки
     редактора этапа 03: он вызывался первым, а при неудаче я обрывал всю
     цепочку. Редактору нужен готовый холст, а во время фоновой загрузки
     вкладка 03 не активна и холст нулевого размера — установка не
     проходила, и вместе с ней отваливались зоны и развёртка. В архиве
     при этом всё лежало правильно: inner_surface 7 721 грань, zones
     ровно столько же.

     Теперь состояние восстанавливается разбором OBJ и ни от чего не
     зависит, а редактор ставится отдельной необязательной попыткой:
     не получилось сейчас — поставится при входе на вкладку. */
  async function restoreInner(manifest) {
    if (!manifest.inner_surface) return false;

    const mesh = window.IO.parseOBJ(await getText('inner_surface'));
    if (!mesh.nV || !mesh.nF) throw new Error('inner_surface пуст');

    window.M.innerV  = mesh.V;  window.M.innerF  = mesh.F;
    window.M.innerNV = mesh.nV; window.M.innerNF = mesh.nF;
    window.M.V  = mesh.V;  window.M.F  = mesh.F;
    window.M.nV = mesh.nV; window.M.nF = mesh.nF;

    const g = window.Geom.compute(mesh.V, mesh.F, mesh.nF);
    window.M.fn = g.fn; window.M.fa = g.fa; window.M.fc = g.fc;

    /* Редакторы здесь НЕ ставим. Их холсты во время фоновой загрузки
       скрыты и нулевого размера: объект редактора создаётся, картинка —
       нет, а вкладка потом видит непустой editor и решает, что всё уже
       показано. Внешне это выглядело как «данные восстановились, а на
       экране пусто» — при том что отчёт рапортовал успех.

       Каждый этап ставит свой редактор сам, при первом входе, когда
       холст получил размер. */
    return true;
  }

  /* Этап 04→05. Метки зон.

     Длину сверяем с активным мешем: архив от другого случая приложил бы
     метки к чужим граням, и зоны молча оказались бы бессмысленными.

     После восстановления просим этап открыться из них. Без этого он
     показывал пустой экран с кнопкой «Запустить сегментацию» — врач
     жал, и зоны считались заново поверх уже готовых, теряя ручные
     правки границ. Попытка необязательная: холст мог быть ещё не
     готов, тогда этап откроется при входе. */
  async function restoreZones(manifest) {
    if (!manifest.zones || !window.M.nF) return false;
    const j = await getJSON('zones');
    const arr = j && (j.labels || j.zone_labels || j);
    if (!arr || arr.length !== window.M.nF) {
      console.warn(LOG + 'метки зон не подходят к мешу (' +
                   (arr ? arr.length : 0) + ' против ' + window.M.nF + ') — пропущены');
      return false;
    }
    window.M.zoneLabels = new Uint8Array(arr);
    if (j && j.meta) window.M.zoneMeta = j.meta;

    /* Данные зон — сразу, до любого показа. Метки без zoneMeta вкладка
       считает несогласованными и уходит в полную пересегментацию;
       проверка эта происходит в наблюдателе за классами вкладок, который
       срабатывает раньше обработчика перехода, так что откладывать
       нельзя. Редактор при этом всё равно ставится при входе. */
    if (window.Tab3 && window.Tab3.restoreDataFromSession) {
      try { window.Tab3.restoreDataFromSession(); }
      catch (e) { console.warn(LOG + 'этап 04: ' + e.message); }
    }
    return true;

  }

  /* Этап 05. Просим сам этап поднять развёртку.

     Своего разбора здесь быть не должно: unfolded.json хранит uv, V и F
     списками пар и троек, а вкладка работает с плоскими массивами. Сырой
     JSON не проходил её же проверку (uv.length === nV*2), развёртка
     отбрасывалась и пересчитывалась заново. Разворачивает данные
     _fetchUnfolded внутри вкладки — она же используется после расчёта на
     сервере, поэтому формат заведомо совпадает. */
  async function restoreUnfold(manifest) {
    if (!manifest.unfolded) return false;
    if (!window.Tab4 || !window.Tab4.restoreFromSession) {
      console.warn(LOG + 'этап 05 без точки входа — развёртка пропущена');
      return false;
    }
    return !!(await window.Tab4.restoreFromSession());
  }

  /* Слой раскраски. Кладём снимок про запас и просим этап 05 приложить.

     Сам не разбираем и не накладываем намеренно. Слой живёт в индексном
     пространстве граней развёртки, а их к этому моменту может ещё не
     быть — развёртку строит сам этап при первом входе. Раньше здесь
     стоял прямой deserialize: он либо не срабатывал (слоя нет), либо
     срабатывал молча, без перерисовки, — карта и модель оставались в
     зональных цветах. Кто и когда накладывает снимок, теперь знает одно
     место, Tab4.applyPaintLayer; если разворачивать ещё нечего, оно
     само дождётся построения. */
  async function restorePaint(manifest) {
    if (!manifest.paint_layer) return false;
    const j = await getJSON('paint_layer');
    if (!j) return false;
    window.Tab4 = window.Tab4 || {};
    window.Tab4.__paintRestore = j;
    if (typeof window.Tab4.applyPaintLayer === 'function') {
      window.Tab4.applyPaintLayer();
    }
    return true;
  }

  // ═══════════════════════════════════════════════════════════

  async function bootstrap() {
    if (alreadyLoaded()) return;

    let manifest;
    try {
      const r = await fetch('/api/session', { cache: 'no-store' });
      if (!r.ok) return;                 // бэкенд лежит — тихо выходим
      manifest = await r.json();
    } catch (_) {
      return;
    }
    const keys = manifest ? Object.keys(manifest) : [];
    if (!keys.length) return;                       // пустая сессия

    console.log(LOG + 'в сессии: ' + keys.sort().join(', '));
    window.M.reset();                               // один раз, до всех шагов

    const done = [], skipped = [];
    /* Диагностика подробная намеренно. Первый же отчёт о работе архива
       был «этапы заблокированы, КТ пустое», и понять по нему, чего не
       хватило — файла в архиве, готовности модуля или совпадения
       размеров, — было нельзя. Теперь каждый шаг объясняет себя. */
    const step = async (name, fn, needed) => {
      if (needed === false) { skipped.push(name + ' (нет предыдущего)'); return false; }
      try {
        const ok = await fn(manifest);
        if (ok) done.push(name); else skipped.push(name + ' (нет данных)');
        return ok;
      } catch (e) {
        skipped.push(name + ' (' + e.message + ')');
        return false;
      }
    };

    // КТ независимо от меша: этап 01 самостоятелен
    await step('КТ', restoreCT);

    const hasMesh  = await step('меш', restoreMesh);
    const hasInner = await step('слизистая', restoreInner, hasMesh);
    const hasZones = await step('зоны', restoreZones, hasInner);
    /* Раскраска ДО развёртки. Порядок был обратный, и это оставляло щель:
       снимок ложился в window позже, чем этап 05 мог начать построение,
       — а слой создаётся именно там. Снимок ничего не строит и ни от
       чего, кроме зон, не зависит, так что положить его раньше
       безопасно и снимает гонку целиком. */
    await step('раскраска', restorePaint, hasZones);
    await step('развёртка', restoreUnfold, hasZones);

    /* Отчёт кладём в window: по одному серверному логу причину не
       определить — он не видит состояния вкладки. */
    window.__bootstrapReport = {
      session: keys.slice().sort(),
      restored: done.slice(),
      skipped: skipped.slice(),
      gates: {
        '03_слизистая': !!window.M.rawV,
        '04_зоны':      !!window.M.V,
        '05_развёртка': !!window.M.zoneLabels,
      },
    };
    console.log(LOG + 'восстановлено: ' + (done.join(', ') || 'ничего'));
    if (skipped.length) console.log(LOG + 'пропущено: ' + skipped.join(', '));
    console.log(LOG + 'замки: ' + JSON.stringify(window.__bootstrapReport.gates));

    refreshGates();

    /* Проверяем ещё раз через секунду: если этап всё-таки перезапустил
       свою обработку и сбросил состояние, это будет видно в консоли, а
       не останется загадкой. */
    setTimeout(() => {
      const now = { rawV: !!window.M.rawV, V: !!window.M.V,
                    zones: !!window.M.zoneLabels };
      const was = window.__bootstrapReport.gates;
      if (now.V !== was['04_зоны'] || now.zones !== was['05_развёртка']) {
        console.warn(LOG + 'состояние изменилось после восстановления: ' +
                     JSON.stringify(now) + ' — кто-то из этапов пересчитал своё');
      }
      if (window.Tabs && window.Tabs.refreshGates) window.Tabs.refreshGates();
    }, 1200);
    if (window.toast) {
      if (done.length) {
        window.toast('Восстановлено: ' + done.join(', ') +
          (skipped.length ? '. Не восстановлено: ' + skipped.length +
                            ' — подробности в консоли' : ''),
          skipped.length ? 'warn' : 'ok', 6000);
      } else {
        window.toast('Сессия не восстановилась — подробности в консоли', 'err', 6000);
      }
    }
  }

  /* Ждём остальные модули: у них тоже свои обработчики DOMContentLoaded. */
  function waitAndBootstrap() {
    let attempts = 0;
    const tick = () => {
      if (alreadyLoaded()) return;
      if (ready()) { bootstrap(); return; }
      if (++attempts > 50) {
        console.warn(LOG + 'модули не готовы за 5 с, выходим');
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
