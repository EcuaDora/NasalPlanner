/* ─── tabs/tab4-unfold ─────────────────────────────────────────
   Этап 4: развёртка UV + измерения + аннотации + экспорты.

   Контракт с tab3:
       window.M.V             — Float64Array xyz  (активный submesh)
       window.M.F             — Int32Array v0,v1,v2 (trimesh)
       window.M.nV, M.nF      — счётчики
       window.M.zoneLabels    — Uint8Array 0/1/2 (SEP / FLR / LAT) per-face
       window.M.zoneMeta      — { eML, eUP, eAP, areas, totalArea } (опц.)
       window.M.zoneBoundaries — { sep_flr, flr_lat, sep_lat } seam edges (опц.)

   События (от tab3 и других):
       data:change { kind:'zones:done'        }   — зоны готовы
       data:change { kind:'zones:edit'        }   — ползунки крутят
       data:change { kind:'zones:invalidated' }   — всё устарело
       data:change { kind:'reset'|'mesh-replaced' } — сброс

   Внутренние события (наши):
       data:change { kind:'unfold:built' }        — UV и метрики готовы
       data:change { kind:'unfold:invalidated' }  — сброшен локальный кэш

   Публичный API:
       window.Tab4.onActivate()          — вызывается при tab:change→unfold
       window.Tab4.build()               — принудительно построить развёртку
       window.Tab4.diagnoseState()       — текущий статус готовности
──────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  window.Tab4 = window.Tab4 || {};

  /* ═══ DEV/CLINICAL MODE ═══
     Клинический интерфейс показывает только тот минимум что нужен хирургу:
       tools: Навигация · Линейка · Область · Перфорация · Флап
       цвет:  Зоны · Риск · Толщина · Риск-зоны
     Всё техническое (L²/ISO/Шов, Polygon, Цепочка, Лассо, Inspect, Патч,
     Charts, Overlap) — за флагом ?dev=1 для настройки алгоритма */
  const DEV_MODE = (function () {
    try {
      return new URLSearchParams(window.location.search).has('dev')
          || localStorage.getItem('nasal.devMode') === '1';
    } catch (_) { return false; }
  })();
  if (DEV_MODE) {
    try { document.body.classList.add('nasal-dev-mode'); } catch (_) {}
    console.log('[tab4] DEV MODE ON — показаны все инструменты');
  }
  (function () {
    const st = document.createElement('style');
    st.textContent =
      'body:not(.nasal-dev-mode) .t4-dev-only { display: none !important; }' +
      '.t4-placeholder { opacity: .55; cursor: help; }' +
      '.t4-placeholder:hover { opacity: .85; }';
    document.head.appendChild(st);
  })();

  /* ═══════════════════════════════════════════════════════════ STATE ═══ */
  let cache = null;
  let cacheSourceV = null;
  let cacheSourceF = null;
  let cacheZoneLabels = null;
  /* Snapshot исходного (pre-server) меша — V/F/zoneLabels — снимается при
     первом успешном buildUnfold в server-режиме. */
  let _origInput = null;

  let activeTool = 'pointer';
  let colorMode = 'zones';
  let showHeatmap = false;
  let showOverlap = true;
  let inspectedFace = -1;

  let polygonPts = [];
  let rulerPts = [];
  let rulerChainPts = [];
  let lassoPath = [];
  let lassoDrawing = false;
  // Состояние 3D-лассо (отдельное, чтобы не мешать UV-лассо).
  // lasso3DPath — массив {x,y} в client-пространстве glCanvas.
  // lasso3DSvg — overlay-SVG поверх 3D-пейна, в нём рисуется path.
  let lasso3DPath = [];
  let lasso3DDrawing = false;
  let lasso3DSvg = null;
  let lasso3DPathEl = null;
  let selectedFaces = null;
  let measurementResult = null;

  /* ═══ Мульти-замер диаметров перфорации ═════════════════════════════
     Каждая ПАРА кликов добавляет новый отрезок — геодезическая длина
     A→B по поверхности (тот же Dijkstra, что у инструмента Линейка).
     Несколько отрезков на одной перфорации хранятся одновременно,
     каждый со своим цветом и номером. Не сбрасываются при следующем
     клике — копятся, пока врач не нажмёт «Очистить» или Esc.

       measureLines     — массив завершённых замеров
                          [{ a:{vi,u,v,x,y,z}, b:{...},
                             dist_mm, path_3d:[vi,vi,...] }]
       measurePending   — точка A замера, для которого ещё нет точки B.
                          null если ждём начала нового отрезка.
   ════════════════════════════════════════════════════════════════════ */
  let measureLines = [];
  let measurePending = null;
  // Палитра цветов для отрезков — циклическая, 6 различимых тонов.
  const MEASURE_COLORS = ['#00d0ff', '#ff66cc', '#ffcc33', '#88ee44', '#ff8844', '#aa44ff'];
  const MEASURE_COLORS_3D = [0x00d0ff, 0xff66cc, 0xffcc33, 0x88ee44, 0xff8844, 0xaa44ff];

  let scene3, cam3, ren3, meshGroup, annotGroup, hoverMesh3d = null;
  let gridHelper3 = null, axesHelper3 = null;
  let threeInited = false;
  let orb = { theta: -1.0, phi: Math.PI / 3.2 }, orbDist = 120;
  let orbTarget = null;
  let isDrag = false, isPan = false, lastMX = 0, lastMY = 0;
  let downX = 0, downY = 0, rafId = 0;
  let threeRaycaster = null;

  let unfTx = null;
  let view2 = { tx: 0, ty: 0, s: 1 };
  /* Глобальный флаг — true только во время exportUVAsPNG. Используется
     несколькими функциями рендеринга: drawGrid2D фиксирует 1мм/1см-сетку,
     render2D пропускает рисование триангуляции и измерительных оверлеев. */
  let _pngExporting = false;
  // Пан 2D-развёртки: shift+ЛКМ или средняя кнопка зажимают pan-режим
  let uvPanning = false, uvPanLX = 0, uvPanLY = 0;

  // v5: видимость контуров перфораций (можно скрыть тумблером в toolbar)
  let _perfVisible = true;
  // v5: индекс перфорации, которую надо временно подсветить (после клика
  // в правой панели). -1 — нет подсветки.
  let _highlightedPerfIdx = -1;
  // v5: индекс перфорации, для которой СЕЙЧАС открыты детали в правой
  // панели. Нужен для toggle-поведения: повторный клик по строке списка
  // перфораций сворачивает её детали (= скрывает meas-panel).
  // -1 — детали не показаны (или показано что-то другое: линейка/область).
  let _shownPerfIdx = -1;
  // v5: state перетаскивания флапа в симуляторе
  let _flapDrag = null;

  let glCanvas = null, uvCanvas = null, uvCtx = null;
  let toolbarEl = null, measFloatEl = null, distPanelEl = null;
  let legendPanelEl = null;   // секция-легенда цвет-режима в правом sidebar
  let measPanelEl = null;     // секция текущего измерения в правом sidebar
  let perfPanelEl = null;     // секция деталей выбранной перфорации (отдельная карточка,
                              // чтобы не затирать вывод активного инструмента в meas-card)
  let cursorTipEl = null;
  let splitRatio = 0.5;          // 0..1, доля ширины левой (3D) панели
  let splitterDragging = false;
  let domBuilt = false;

  const ZONE_NAMES = ['Перегородка', 'Дно', 'Лат. стенка'];
  const ZONE_DESCS = ['septum', 'floor', 'lateral'];

  /* ═══ HELPERS ═══ */
  const _$ = (id) => (typeof window.$ === 'function') ? window.$(id) : document.getElementById(id);
  const _toast = (msg, kind) => { if (typeof window.toast === 'function') window.toast(msg, kind); };

  /* ─── Локальный спиннер этапа 04 (#spinnerUnfold) ───────────────────
     buildUnfold() — самая долгая операция в приложении: проверка сервера,
     SSE-стрим LSCM+ARAP, fetch UV, computeDistortion / computeJacobian /
     computeSeamRings / computeOverlapMap. Раньше единственным
     индикатором был поток toast'ов справа, а в центре оставался белый
     прямоугольник — пользователь не понимал, идёт ли работа.

     Те же стили .spinner-overlay и .spinner-text, что в stage 1 — UI
     одинаковый на всех этапах, как и просил пользователь. */
  function _showSpinner(text) {
    const sp = document.getElementById('spinnerUnfold');
    const tx = document.getElementById('spinnerUnfoldText');
    if (tx) tx.textContent = text || 'Обработка…';
    if (sp) sp.classList.add('show');
  }
  function _setSpinnerText(text) {
    const tx = document.getElementById('spinnerUnfoldText');
    if (tx) tx.textContent = text || '';
  }
  function _hideSpinner() {
    const sp = document.getElementById('spinnerUnfold');
    if (sp) sp.classList.remove('show');
  }

  function fmtNum(x, d) { if (d == null) d = 4; return isFinite(x) ? x.toFixed(d) : '—'; }
  function fmtPct(x) { return isFinite(x) ? (x * 100).toFixed(2) + '%' : '—'; }

  function disposeCache() {
    if (!cache) return;
    cache = null;
    cacheSourceV = null;
    cacheSourceF = null;
    cacheZoneLabels = null;
    // Инвалидируем snapshot — источник (этап 3) изменился, значит то что
    // мы когда-то запомнили уже не соответствует текущему M.
    _origInput = null;
    clearMeasurementsState();
    clearInspect3D();
    if (meshGroup) meshGroup.clear();
    if (annotGroup) annotGroup.clear();
    // v5 fix: форсим render пустой сцены — иначе в GPU buffer остаётся
    // последний кадр со старым мешем до следующего render-цикла, и
    // canvas визуально не «чистится» при reset / mesh-replaced.
    if (ren3 && scene3 && cam3) {
      try { ren3.render(scene3, cam3); } catch (_) {}
    }
    // Аналогично — сбрасываем 2D канвас, чтобы предыдущая развёртка не
    // оставалась на экране после disposeCache.
    if (uvCtx && uvCanvas) {
      uvCtx.save();
      uvCtx.setTransform(1, 0, 0, 1, 0, 0);
      uvCtx.clearRect(0, 0, uvCanvas.width, uvCanvas.height);
      uvCtx.restore();
    }
    /* Возвращаем левую панель и прячем top-тулбар — развёртки больше нет,
       пользователю снова могут понадобиться подсказки/CTA в левой колонке.
       Правую панель тоже разворачиваем, если она была схлопнута. Снимаем
       .t4-built — язычки-переключатели прячутся. */
    const stage = document.querySelector('.stage[data-stage="unfold"]');
    if (stage) {
      stage.classList.remove('t4-focused');
      stage.classList.remove('t4-focused-r');
      stage.classList.remove('t4-built');
    }
    const topTb = document.getElementById('t4-toptools');
    if (topTb) topTb.classList.remove('show');
    dispatchDataChange('unfold:invalidated');
  }

  function dispatchDataChange(kind, extra) {
    try {
      window.dispatchEvent(new CustomEvent('data:change',
        { detail: Object.assign({ kind: kind }, extra || {}) }));
    } catch (_) { }
  }

  /* ═══ DIAGNOSTIC + WARNING ═══ */
  function _labelsEqual(a, b) {
    // Быстрое сравнение typed-arrays по содержимому. Sampling-based:
    // проверяем первые 8, последние 8 и 16 случайных — этого достаточно,
    // чтобы отличить «тот же массив с новым ref» от «реально другие labels».
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    if (a === b) return true;
    const n = a.length;
    const check = [0, 1, 2, 3, 4, 5, 6, 7, n-1, n-2, n-3, n-4, n-5, n-6, n-7, n-8];
    for (let k = 0; k < 16; k++) check.push((k * 2654435761) % n);
    for (const i of check) if (a[i] !== b[i]) return false;
    return true;
  }

  function diagnoseState() {
    const M = window.M;
    if (!M || !M.V || !M.F || !M.nF) return { kind: 'no-mesh' };
    if (!M.zoneLabels) return { kind: 'no-zones' };
    if (M.zoneLabels.length !== M.nF) return { kind: 'stale' };
    if (cache) {
      // Сравнение по ref быстрое — если совпадает, всё ок.
      if (cacheSourceV === M.V && cacheSourceF === M.F &&
          cacheZoneLabels === M.zoneLabels) {
        return { kind: 'ok' };
      }
      // Ref'ы не совпали — но это может быть просто пересоздание typed-
      // array в tab3 с тем же содержимым (частый случай при tab:change).
      // Сравниваем по содержимому; если одинаково — обновляем ref'ы и OK.
      if (cache.nV === M.V.length / 3 && cache.nF === M.F.length / 3 &&
          _labelsEqual(cacheZoneLabels, M.zoneLabels)) {
        cacheSourceV = M.V;
        cacheSourceF = M.F;
        cacheZoneLabels = M.zoneLabels;
        return { kind: 'ok' };
      }
      return { kind: 'cache-stale' };
    }
    return { kind: 'ok' };
  }
  window.Tab4.diagnoseState = diagnoseState;

  function updateWarningUI() {
    const d = diagnoseState();
    const tab = document.querySelector('.tab[data-tab="unfold"]');
    if (tab) tab.classList.toggle('tab-stale', d.kind === 'stale' || d.kind === 'cache-stale');
    const stage = document.querySelector('.stage[data-stage="unfold"]');
    if (!stage) return;
    const empty = stage.querySelector('.empty-state');
    if (!empty) return;

    const messages = {
      'no-mesh':     { title: 'Меш не загружен', sub: 'Вернитесь на этап 1 и откройте OBJ.', cta: null },
      'no-zones':    { title: 'Сегментация ещё не выполнена', sub: 'Пройдите этап 3.', cta: { label: 'Перейти к этапу 3', target: 'zones' } },
      'stale':       { title: 'Данные этапа 2 изменились', sub: 'Зоны устарели. Пересчитайте этап 3.', cta: { label: 'Пересчитать зоны', target: 'zones' } },
      'cache-stale': { title: 'Зоны обновились', sub: 'Развёртка построена на старой разметке.', cta: { label: 'Перестроить развёртку', target: 'rebuild' } },
      'ok':          { title: 'Готово к построению', sub: 'Зоны согласованы с текущим мешем.', cta: { label: 'Построить развёртку', target: 'rebuild' } },
    };
    const m = messages[d.kind];

    if (d.kind === 'ok' && cache) { empty.style.display = 'none'; return; }
    empty.style.display = '';
    empty.innerHTML =
      '<div class="empty-title">' + m.title + '</div>' +
      '<div class="empty-sub" style="max-width:420px;line-height:1.5">' + m.sub + '</div>' +
      (m.cta
        ? ('<button type="button" class="btn-open-big" data-t4-act="' + m.cta.target + '" ' +
          'style="margin-top:18px;min-width:240px;justify-content:center">' + m.cta.label + '</button>')
        : '');

    if (toolbarEl) toolbarEl.style.display = 'none';
    if (measFloatEl) measFloatEl.style.display = 'none';
    if (legendPanelEl) legendPanelEl.style.display = 'none';
    /* ВАЖНО: прячем КАРТОЧКУ целиком (.t4-meas-card / .t4-perf-card), а не
       только её внутренний body (#t4-meas-panel / #t4-perf-panel). Раньше
       здесь было `measPanelEl.style.display = 'none'`, что скрывало только
       тело — а сам .card с заголовком ("ОБЛАСТЬ", "ЛИНЕЙКА" и т.д.)
       оставался висеть, причём этот display:none на panel'е никогда
       не сбрасывался обратно (showMeasFloat правит только measCard.display
       и innerHTML). В итоге после любого warning-эпизода (например, юзер
       подвигал ползунок зон в tab3 → cache инвалидировался → updateWarningUI
       спрятал тело) при возврате на tab4 и выборе любого инструмента
       заголовок появлялся, а контент — нет. То же для perf-card:
       раньше она вовсе не пряталась в warning-state. */
    const _measCard = document.getElementById('t4-meas-card');
    if (_measCard) _measCard.style.display = 'none';
    const _perfCard = document.getElementById('t4-perf-card');
    if (_perfCard) _perfCard.style.display = 'none';
    if (glCanvas) glCanvas.style.display = 'none';
    if (uvCanvas) uvCanvas.style.display = 'none';
    const split = document.getElementById('t4-split');
    if (split) split.style.display = 'none';
    /* Снимаем focus-режим: левая и правая панели + старый UI возвращаются,
       новый top-тулбар скрывается, язычки-переключатели пропадают (через
       снятие .t4-built). */
    stage.classList.remove('t4-focused');
    stage.classList.remove('t4-focused-r');
    stage.classList.remove('t4-built');
    const topTb = document.getElementById('t4-toptools');
    if (topTb) topTb.classList.remove('show');
  }

  /* ═══ CSS INJECTION ═══ */
  function injectCSS() {
    if (document.getElementById('tab4-unfold-css')) return;
    const s = document.createElement('style');
    s.id = 'tab4-unfold-css';
    s.textContent = [
      '.tab.tab-stale::after{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;',
      '  background:#ff9f3c;margin-left:8px;vertical-align:middle;box-shadow:0 0 0 3px rgba(255,159,60,.18)}',

      /* ═══════════════════════════════════════════════════════════
         СТАТИЧЕСКИЕ ВИДЖЕТЫ ЛЕВОЙ ПАНЕЛИ — Инструменты + Подсказки.
         Раньше эти блоки были «стеной текста» (.hint-text dim с <br>),
         что мешало хирургу быстро визуально найти нужный инструмент.
         Теперь — структурированный список с иконками, совпадающими с
         иконками в верхнем тулбаре. Хирург видит инструмент в описании
         и сразу узнаёт его в тулбаре.
         ═══════════════════════════════════════════════════════════ */
      '.t4-tool-list{display:flex;flex-direction:column;gap:8px;margin-top:2px}',
      '.t4-tool-row{display:flex;gap:10px;align-items:flex-start;',
      '  padding:8px 9px;border-radius:6px;',
      '  background:rgba(0,240,255,.04);',
      '  border:1px solid rgba(0,240,255,.14);',
      '  transition:background .15s ease, border-color .15s ease,',
      '    transform .15s ease}',
      '.t4-tool-row:hover{background:rgba(0,240,255,.08);',
      '  border-color:rgba(0,240,255,.32);transform:translateX(2px)}',
      '.t4-tool-ico{flex-shrink:0;width:26px;height:26px;border-radius:5px;',
      '  display:flex;align-items:center;justify-content:center;',
      '  background:rgba(0,240,255,.10);',
      '  border:1px solid rgba(0,240,255,.28);',
      '  color:var(--cyan,#00d0ff);',
      '  box-shadow:inset 0 0 8px rgba(0,240,255,.08)}',
      '.t4-tool-text{flex:1;min-width:0}',
      '.t4-tool-name{font-family:inherit;',
      '  font-weight:700;font-size:12px;letter-spacing:.06em;',
      '  color:var(--cyan,#00d0ff);text-transform:uppercase;',
      '  margin-bottom:3px}',
      '.t4-tool-desc{font-size:11.5px;line-height:1.4;color:var(--tx2);',
      '  font-family:inherit}',
      'body.light-theme .t4-tool-row{background:rgba(79,124,219,.04);',
      '  border-color:rgba(79,124,219,.18)}',
      'body.light-theme .t4-tool-row:hover{background:rgba(79,124,219,.09);',
      '  border-color:rgba(79,124,219,.36)}',
      'body.light-theme .t4-tool-ico{background:rgba(79,124,219,.10);',
      '  border-color:rgba(79,124,219,.28);color:#4F7CDB;',
      '  box-shadow:inset 0 0 8px rgba(79,124,219,.08)}',
      'body.light-theme .t4-tool-name{color:#4F7CDB}',
      'body.light-theme .t4-tool-desc{color:#5d6f80}',

      /* Подсказки — список с cyan-точками-буллитами */
      '.t4-tip-list{list-style:none;padding:0;margin:0;',
      '  display:flex;flex-direction:column;gap:9px}',
      '.t4-tip-list li{position:relative;padding-left:18px;',
      '  font-size:12.5px;line-height:1.5;color:var(--tx2);',
      '  font-family:inherit}',
      '.t4-tip-list li::before{content:"";position:absolute;',
      '  left:4px;top:8px;width:6px;height:6px;border-radius:50%;',
      '  background:var(--cyan,#00d0ff);',
      '  box-shadow:0 0 6px rgba(0,240,255,.55)}',
      '.t4-warn-tag{display:inline-block;padding:1px 6px;border-radius:3px;',
      '  background:rgba(220,40,60,.14);',
      '  border:1px solid rgba(220,40,60,.4);',
      '  color:#ff6075;font-weight:600;font-size:11.5px;',
      '  letter-spacing:.02em}',
      'body.light-theme .t4-tip-list li{color:#5d6f80}',
      'body.light-theme .t4-tip-list li::before{background:#4F7CDB;',
      '  box-shadow:0 0 4px rgba(79,124,219,.4)}',
      'body.light-theme .t4-warn-tag{background:rgba(220,40,60,.08);',
      '  border-color:rgba(220,40,60,.35);color:#c43040}',

      /* ═══════════════════════════════════════════════════════════
         СТАТИЧЕСКИЕ ВИДЖЕТЫ ПРАВОЙ ПАНЕЛИ (ДО ПОСТРОЕНИЯ РАЗВЁРТКИ).
         После build() весь .panel.right .card перестраивается в
         .t4-distcard (см. ensureDOM). Эти стили — только для
         HTML-плэйсхолдера, который видит хирург до того, как нажмёт
         «Построить развёртку».
         ═══════════════════════════════════════════════════════════ */
      /* Двойной tile: 3D (cyan) и 2D (amber) — те же цвета, что у
         меток t4-label над сплит-вью, чтобы хирург сразу понимал,
         какая панель за что отвечает. */
      '.t4-views{display:flex;gap:8px;margin:4px 0 12px}',
      '.t4-view{flex:1;padding:14px 8px 12px;border-radius:6px;',
      '  text-align:center;position:relative;overflow:hidden;',
      '  background:rgba(0,0,0,.20);border:1px solid var(--brd)}',
      '.t4-view::before{content:"";position:absolute;inset:0;',
      '  pointer-events:none;opacity:.55}',
      '.t4-view>*{position:relative;z-index:1}',
      '.t4-view-3d{border-color:rgba(0,240,255,.30)}',
      '.t4-view-3d::before{background:radial-gradient(ellipse at center,',
      '  rgba(0,240,255,.14),transparent 70%)}',
      '.t4-view-2d{border-color:rgba(255,207,102,.30)}',
      '.t4-view-2d::before{background:radial-gradient(ellipse at center,',
      '  rgba(255,207,102,.14),transparent 70%)}',
      '.t4-view-tag{font-family:inherit;',
      '  font-weight:700;font-size:18px;letter-spacing:.18em;',
      '  margin-bottom:4px}',
      '.t4-view-3d .t4-view-tag{color:var(--cyan,#00d0ff);',
      '  text-shadow:0 0 10px rgba(0,240,255,.55)}',
      '.t4-view-2d .t4-view-tag{color:#ffcf66;',
      '  text-shadow:0 0 10px rgba(255,207,102,.55)}',
      '.t4-view-text{font-size:11px;color:var(--tx2);line-height:1.35;',
      '  font-family:inherit}',
      'body.light-theme .t4-view{background:rgba(255,255,255,.55)}',
      'body.light-theme .t4-view-3d{border-color:rgba(79,124,219,.32)}',
      'body.light-theme .t4-view-3d .t4-view-tag{color:#4F7CDB;',
      '  text-shadow:0 0 6px rgba(79,124,219,.4)}',
      'body.light-theme .t4-view-3d::before{background:radial-gradient(',
      '  ellipse at center,rgba(79,124,219,.10),transparent 70%)}',
      'body.light-theme .t4-view-2d{border-color:rgba(176,106,0,.32)}',
      'body.light-theme .t4-view-2d .t4-view-tag{color:#b06a00;',
      '  text-shadow:0 0 6px rgba(176,106,0,.4)}',
      'body.light-theme .t4-view-2d::before{background:radial-gradient(',
      '  ellipse at center,rgba(176,106,0,.10),transparent 70%)}',
      'body.light-theme .t4-view-text{color:#5d6f80}',

      /* Анатомические зоны — простой список со swatch + название */
      '.t4-zone-row{display:flex;align-items:center;gap:10px;',
      '  padding:6px 0;font-size:13px;font-family:inherit}',
      '.t4-zone-row+.t4-zone-row{border-top:1px solid rgba(255,255,255,.04)}',
      '.t4-zone-sw{flex-shrink:0;width:14px;height:14px;border-radius:3px;',
      '  box-shadow:inset 0 0 0 1px rgba(0,0,0,.25),',
      '  0 0 6px currentColor}',
      '.t4-zone-name{flex:1;color:var(--tx)}',
      'body.light-theme .t4-zone-row+.t4-zone-row{border-top-color:#eef1f5}',
      'body.light-theme .t4-zone-name{color:#1f2a37}',

      '.t4-split{position:absolute;inset:0;display:grid;grid-template-columns:1fr 1fr;gap:1px;',
      '  background:var(--brd);z-index:2}',
      '.t4-split>div{position:relative;overflow:hidden;background:var(--card-solid)}',
      /* Канвас в каждом pane занимает ВСЮ область КРОМЕ верхней
         34-px полосы — там живёт лейбл «3D» / «2D развёртка». Раньше
         canvas был на 100% высоты pane, и лейбл (absolute top:10px)
         ложился прямо поверх сетки/осей. Теперь сетка физически не может
         доходить до верха — её рисует только канвас, а он начинается
         ниже header-полосы. */
      '.t4-split canvas{display:block;position:absolute;',
      '  top:34px;left:0;width:100%;height:calc(100% - 34px)}',
      '.t4-label{position:absolute;top:8px;left:10px;font-size:9px;',
      '  font-family:"Share Tech Mono","Consolas","Menlo",monospace;letter-spacing:.1em;text-transform:uppercase;',
      '  color:var(--cyan);background:rgba(0,10,20,.72);padding:3px 8px;border-radius:3px;',
      '  border:1px solid var(--brd);z-index:3;pointer-events:none}',
      '.t4-toolbar{position:absolute;top:8px;right:10px;z-index:5;display:flex;gap:3px;',
      '  background:rgba(0,10,20,.88);backdrop-filter:blur(10px);',
      '  padding:3px;border-radius:6px;border:1px solid var(--brd);',
      '  box-shadow:0 2px 12px rgba(0,0,0,.4)}',
      '.t4-btn{width:30px;height:30px;border-radius:4px;border:none;',
      '  background:transparent;cursor:pointer;color:var(--tx2);',
      '  display:flex;align-items:center;justify-content:center;position:relative;',
      '  transition:all .15s;font-family:"Share Tech Mono","Consolas","Menlo",monospace;font-size:10px;font-weight:700}',
      '.t4-btn:hover{background:rgba(0,240,255,.08);color:var(--tx)}',
      '.t4-btn.active{background:rgba(0,240,255,.15);color:var(--cyan);',
      '  box-shadow:0 0 8px rgba(0,240,255,.15);border:1px solid rgba(0,240,255,.2)}',
      '.t4-btn .t4-tip{display:none;position:absolute;top:calc(100% + 5px);right:0;',
      '  background:rgba(0,10,20,.95);border:1px solid var(--brd);color:var(--cyan);',
      '  font-size:9px;padding:3px 7px;border-radius:3px;white-space:nowrap;',
      '  font-family:"Share Tech Mono","Consolas","Menlo",monospace;letter-spacing:.04em;z-index:10}',
      '.t4-btn:hover .t4-tip{display:block}',
      '.t4-sep{width:1px;background:var(--brd);margin:4px 2px}',
      '.t4-measfloat{position:absolute;bottom:10px;right:10px;z-index:5;',
      '  background:rgba(0,10,20,.92);backdrop-filter:blur(12px);',
      '  padding:10px 12px;border-radius:8px;border:1px solid var(--brd);',
      '  box-shadow:0 2px 12px rgba(0,0,0,.45);font-size:11px;max-width:280px}',
      '.t4-measfloat .t4-title{font-size:8px;font-weight:700;color:var(--cyan);',
      '  text-transform:uppercase;letter-spacing:.14em;margin-bottom:6px;',
      '  font-family:inherit}',
      '.t4-row{display:flex;justify-content:space-between;gap:8px;padding:2px 0;align-items:center}',
      '.t4-lab{color:var(--tx2);font-family:inherit;font-size:11px}',
      '.t4-val{font-family:"Share Tech Mono","Consolas","Menlo",monospace;font-weight:700;color:var(--cyan);font-size:12px}',
      '.t4-hint{font-size:10px;color:var(--tx3);margin-top:5px;line-height:1.4;',
      '  font-family:"Share Tech Mono","Consolas","Menlo",monospace}',
      '.t4-distcard .t4-section{font-size:9px;color:var(--cyan);text-transform:uppercase;',
      '  letter-spacing:.12em;font-family:inherit;',
      '  margin:10px 0 5px;padding-top:6px;border-top:1px solid var(--brd)}',
      '.t4-distcard .t4-section:first-child{border-top:0;margin-top:0;padding-top:0}',
      '.t4-distcard .t4-row{border-bottom:1px solid rgba(255,255,255,.03)}',

      /* ═══ Стиль правой панели tab4 — синхронизирован с tab3 ═══════
         Раньше использовалась самопальная вёрстка t4-row + цветные
         фоновые блоки. Теперь — те же primitives, что в tab3-zones.js:
         zn-stat-row для строк со swatch (зоны), stat-row для пар
         «ключ-значение», ep-divider/ep-section-title для разделов. */
      /* Заголовки секций в карточке метрик. Согласовано с .ep-ctrls-title
         в tab2/tab3 — мелкий uppercase, серый цвет (--tx3), без рамок и
         без декоративных полосок. В предыдущих табах все sub-headers
         именно такие — здесь делаем точно так же, чтобы хирург не
         перенастраивал глаз между этапами. */
      '.t4-distcard .ep-section-title{',
      '  font-size:11px;letter-spacing:.16em;text-transform:uppercase;',
      '  color:var(--tx3);font-weight:700;',
      '  margin:0 0 8px;padding:0;border:0;',
      '  font-family:inherit}',
      '.t4-distcard .ep-section-title.warn{',
      '  color:var(--orange,#ff8844)}',
      /* Разделитель — градиент transparent → glow → transparent,
         тот же приём, что в .ep-divider из tab2/tab3. */
      '.t4-distcard .ep-divider{',
      '  height:1px;margin:16px 0 12px;',
      '  background:linear-gradient(90deg,transparent,var(--brd-glow),transparent)}',
      /* Подсказка под секцией — простой курсивный текст, без фонов
         и рамок (как .ep-hint в tab2/tab3). */
      '.t4-distcard .ep-hint{margin-top:8px;font-size:12px;line-height:1.5;',
      '  color:var(--tx2);padding:0;background:transparent;border:0}',
      '.t4-distcard .ep-hint b{color:var(--cyan);font-weight:600}',
      'body.light-theme .t4-distcard .ep-hint b{color:#4F7CDB}',

      /* zn-stat-row — строка с цветным swatch (для зон).
         Тонкая разделительная линия между строками + чуть крупнее swatch
         делает блок «Точность по зонам» легче читаемым с расстояния
         (хирург смотрит на экран не вплотную). */
      '.t4-distcard .zn-stat-row{display:flex;align-items:center;gap:10px;',
      '  padding:7px 10px 7px 0;font-size:12.5px;font-family:inherit}',
      '.t4-distcard .zn-stat-row+.zn-stat-row{',
      '  border-top:1px solid rgba(255,255,255,.05)}',
      '.t4-distcard .zn-swatch{flex-shrink:0;width:12px;height:12px;border-radius:3px}',
      '.t4-distcard .zn-stat-k{flex:1;color:var(--tx2)}',
      '.t4-distcard .zn-stat-v{font-variant-numeric:tabular-nums;font-weight:600;',
      '  color:var(--tx);font-family:"Share Tech Mono","Consolas","Menlo",monospace;font-size:12.5px}',
      '.t4-distcard .zn-stat-v.good{color:var(--green,#00c070)}',
      '.t4-distcard .zn-stat-v.warn{color:#e8c83c}',
      '.t4-distcard .zn-stat-v.bad{color:var(--red,#e04050)}',
      'body.light-theme .t4-distcard .zn-stat-row+.zn-stat-row{',
      '  border-top-color:#eef1f5}',

      /* Перфорации — компактные кликабельные строки.
         Красная обводка уже однозначно говорит «можно ткнуть»,
         шеврон-стрелка справа была излишним декором. Лёгкий
         сдвиг и подсветка на hover — этого достаточно. */
      '.t4-distcard .t4-perf-list{display:flex;flex-direction:column;gap:6px;margin-top:4px}',
      '.t4-distcard .t4-perf-item{display:flex;align-items:center;gap:10px;',
      '  padding:7px 10px;border-radius:5px;cursor:pointer;',
      '  background:rgba(220,40,60,.05);border:1px solid rgba(220,40,60,.22);',
      '  transition:background .15s ease, border-color .15s ease}',
      '.t4-distcard .t4-perf-item:hover{background:rgba(220,40,60,.10);',
      '  border-color:rgba(220,40,60,.45)}',
        '.t4-distcard .t4-perf-item.t4-perf-item-active{',
        '  background:rgba(220,40,60,.14);border-color:rgba(220,40,60,.6);',
        '  box-shadow:inset 0 0 0 1px rgba(220,40,60,.3)}',
      '.t4-distcard .t4-perf-num{flex-shrink:0;width:20px;height:20px;',
      '  border-radius:50%;background:rgba(220,40,60,.16);',
      '  border:1.5px solid rgba(220,40,60,.75);color:#d42a3c;',
      '  font-size:10.5px;font-weight:700;display:flex;',
      '  align-items:center;justify-content:center;',
      '  font-family:"Share Tech Mono","Consolas","Menlo",monospace}',
      '.t4-distcard .t4-perf-stats{flex:1;min-width:0;',
      '  display:flex;flex-direction:column;gap:2px;font-size:12px}',
      '.t4-distcard .t4-perf-row{display:flex;justify-content:space-between;',
      '  gap:10px;align-items:baseline}',
      '.t4-distcard .t4-perf-k{color:var(--tx2);font-family:inherit;',
      '  font-weight:400}',
      '.t4-distcard .t4-perf-v{color:#d42a3c;font-weight:600;',
      '  font-family:"Share Tech Mono","Consolas","Menlo",monospace;',
      '  font-variant-numeric:tabular-nums;white-space:nowrap}',
      'body.light-theme .t4-distcard .ep-hint{color:#5d6f80}',
      'body.light-theme .t4-distcard .zn-stat-k{color:#64748b}',
      'body.light-theme .t4-distcard .zn-stat-v{color:#1f2a37}',
      'body.light-theme .t4-distcard .zn-stat-v.good{color:#0a8a4a}',
        'body.light-theme .t4-distcard .zn-stat-v.warn{color:#c08020}',
        'body.light-theme .t4-distcard .zn-stat-v.bad{color:#c43040}',
      /* Прокручиваемая правая панель — фиксированная высота, овер-скролл,
         тонкая cyan-полоска. Раньше карточка просто переполнялась за
         границы видимого вьюпорта на маленьких экранах: измерения
         флапа, перфораций и кнопки списка диаметров отрезались. */
      '.stage[data-stage="unfold"] .panel.right{display:flex;flex-direction:column;',
      '  max-height:100vh;overflow:hidden}',

      /* ═══════════════════════════════════════════════════════════
         ЛЕВАЯ ПАНЕЛЬ — тоже скроллится, иначе на низких экранах
         (laptop 13" + браузерный chrome + dev-tools) три карточки
         «Этап 04 / Что можно делать / Подсказки» физически не
         помещаются — последняя строка обрезается. Без overflow
         содержимое просто исчезало за нижней кромкой панели.
         ═══════════════════════════════════════════════════════════ */
      '.stage[data-stage="unfold"] .panel.left{',
      '  overflow-y:auto;overflow-x:hidden;',
      '  scrollbar-width:thin;scrollbar-color:rgba(0,240,255,.35) transparent}',
      '.stage[data-stage="unfold"] .panel.left::-webkit-scrollbar{width:6px}',
      '.stage[data-stage="unfold"] .panel.left::-webkit-scrollbar-track{background:transparent}',
      '.stage[data-stage="unfold"] .panel.left::-webkit-scrollbar-thumb{',
      '  background:rgba(0,240,255,.35);border-radius:3px}',
      '.stage[data-stage="unfold"] .panel.left::-webkit-scrollbar-thumb:hover{',
      '  background:rgba(0,240,255,.6)}',
      'body.light-theme .stage[data-stage="unfold"] .panel.left{',
      '  scrollbar-color:rgba(79,124,219,.45) transparent}',
      'body.light-theme .stage[data-stage="unfold"] .panel.left::-webkit-scrollbar-thumb{',
      '  background:rgba(79,124,219,.45)}',
      /* До билда развёртки правая панель полностью скрыта: пока идёт
         «Получение результата…», метрик ещё нет, и карточка не должна
         мелькать. Раскрывается классом .t4-built при готовности. */
      '.stage[data-stage="unfold"]:not(.t4-built) .panel.right{',
      '  width:0!important;min-width:0!important;padding:0!important;',
      '  border-left-color:transparent!important;overflow:hidden!important}',
      '.stage[data-stage="unfold"]:not(.t4-built) .panel.right > *{',
      '  opacity:0;pointer-events:none}',
      /* ═══ ПРАВАЯ ПАНЕЛЬ — общий скролл по обеим карточкам ═══
         Раньше .t4-distcard имела flex:1 1 auto + свой overflow-y:auto:
         когда она была единственной карточкой это работало (заполняла всю
         панель). Теперь рядом — отдельная .t4-meas-card. При коротком
         содержимом dist-card всё равно растягивалась на всю свободную
         высоту → внутри образовывалась пустая зона.
         Решение: dist-card сжимается/растягивается строго по содержимому
         (flex:0 0 auto), скроллится сама ПАНЕЛЬ при переполнении.
         Аналогично tab3-zones (зоны/инструкция). */
      '.stage[data-stage="unfold"] .panel.right{',
      '  overflow-y:auto;overflow-x:hidden;',
      '  scrollbar-width:thin;scrollbar-color:rgba(0,240,255,.35) transparent}',
      '.stage[data-stage="unfold"] .panel.right::-webkit-scrollbar{width:6px}',
      '.stage[data-stage="unfold"] .panel.right::-webkit-scrollbar-track{background:transparent}',
      '.stage[data-stage="unfold"] .panel.right::-webkit-scrollbar-thumb{',
      '  background:rgba(0,240,255,.35);border-radius:3px}',
      '.stage[data-stage="unfold"] .panel.right::-webkit-scrollbar-thumb:hover{',
      '  background:rgba(0,240,255,.6)}',
      'body.light-theme .stage[data-stage="unfold"] .panel.right{',
      '  scrollbar-color:rgba(79,124,219,.45) transparent}',
      'body.light-theme .stage[data-stage="unfold"] .panel.right::-webkit-scrollbar-thumb{',
      '  background:rgba(79,124,219,.45)}',
      /* Карточки в правой панели — естественная высота по контенту.
         Никакого flex-grow и flex-shrink — иначе либо растягиваются,
         либо обрезаются (см. tab3-zones для аналогичной ситуации). */
      '.stage[data-stage="unfold"] .panel.right > .card{',
      '  flex:0 0 auto;overflow:visible}',
      '.t4-val.good{color:var(--green)}',
      '.t4-val.warn{color:#ffaa33}',
      '.t4-val.bad{color:var(--red)}',
      'body.light-theme .t4-split{background:#d1d8e0}',
      // 3D-пейн чуть серее правого 2D — отделяет окна визуально.
      // Тон совпадает с scene3.background (0xe9eef4) чтобы 34px-полоска
      // лейбла "3D" не контрастировала с холстом.
      'body.light-theme .t4-split>div#t4-3d{background:#e9eef4}',
      'body.light-theme .t4-split>div#t4-uv{background:#fdfdfe}',
      // Dark-тема: 3D чуть глубже, чем правый
      '.t4-split>div#t4-3d{background:#070d18}',
      '.t4-split>div#t4-uv{background:#0b1220}',
      'body.light-theme .t4-label{background:rgba(255,255,255,.92);border-color:#dfe4ec}',
      'body.light-theme .t4-toolbar{background:rgba(255,255,255,.95);border-color:#dfe4ec}',
      'body.light-theme .t4-btn{color:#475569}',
      'body.light-theme .t4-btn:hover{background:#f1f5f9;color:#334155}',
      'body.light-theme .t4-measfloat{background:rgba(255,255,255,.97);border-color:#dfe4ec;color:#0f172a}',
      'body.light-theme .t4-lab{color:#475569}',
      'body.light-theme .t4-val{color:#4F7CDB}',
      'body.light-theme .t4-hint{color:#64748b}',
      'body.t4-tool-inspect .t4-split canvas{cursor:help}',
      'body.t4-tool-polygon .t4-split canvas,',
      'body.t4-tool-ruler .t4-split canvas,',
      'body.t4-tool-rulerchain .t4-split canvas,',
      'body.t4-tool-measure .t4-split canvas,',
      'body.t4-tool-lasso .t4-split canvas{cursor:crosshair}',
      'body.t4-tool-patch .t4-split canvas{cursor:cell}',
      /* Shift+drag или средняя кнопка → курсор-«рука» для пана 2D-развёртки.
         Класс вешается/снимается в uv_onMouseDown/Up/Leave.               */
      'body.t4-uv-panning #t4-canvas,',
      'body.t4-uv-panning .t4-split canvas{cursor:grabbing!important}',
      '#t4-uv canvas{cursor:default}',
      /* === Новый split (flex) + draggable-сплиттер === */
      '.t4-split{display:flex!important;grid-template-columns:none!important;gap:0!important;background:transparent!important}',
      '.t4-pane{position:relative;overflow:hidden;background:var(--card-solid);flex:1 1 50%;min-width:80px}',
      /* Жирная граница между 3D и 2D-пейнами — двухцветный градиент намекает,
         что слева "3D-зона" (cyan), справа "2D-зона" (amber). Не даёт двум
         областям "сливаться" визуально. */
      '.t4-splitter{flex:0 0 6px;cursor:col-resize;position:relative;z-index:3;',
      '  background:linear-gradient(to right,',
      '    rgba(0,240,255,.18) 0%, var(--brd) 45%, var(--brd) 55%, rgba(255,207,102,.18) 100%);',
      '  transition:background .15s}',
      '.t4-splitter::before{content:"";position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);',
      '  width:2px;height:26px;background:var(--cyan);opacity:.35;border-radius:1px;transition:opacity .15s}',
      '.t4-splitter:hover,.t4-splitter.dragging{background:rgba(0,240,255,.3)}',
      '.t4-splitter:hover::before,.t4-splitter.dragging::before{opacity:.9;height:36px}',
      'body.t4-splitter-dragging{cursor:col-resize!important;user-select:none}',
      'body.t4-splitter-dragging *{cursor:col-resize!important;pointer-events:none}',
      'body.t4-splitter-dragging .t4-splitter{pointer-events:auto}',
      /* === Cursor tooltip (следует за курсором при hover) === */
      '.t4-cursortip{position:absolute;z-index:9;pointer-events:none;display:none;',
      '  background:rgba(0,10,20,.92);backdrop-filter:blur(8px);',
      '  padding:4px 8px;border-radius:4px;border:1px solid var(--brd);',
      '  font-family:"Share Tech Mono","Consolas","Menlo",monospace;font-size:10px;',
      '  box-shadow:0 2px 8px rgba(0,0,0,.45);white-space:nowrap;',
      '  transition:transform .05s linear}',
      '.t4-cursortip .t4-ctip-fi{color:#ffcf66;font-weight:700}',
      '.t4-cursortip .t4-ctip-zn{display:inline-block;width:7px;height:7px;border-radius:2px;',
      '  margin:0 5px;vertical-align:middle;box-shadow:0 0 3px currentColor}',
      '.t4-cursortip .t4-ctip-met{color:var(--cyan);margin-left:6px;font-weight:700}',
      '.t4-cursortip .t4-ctip-zl{color:var(--tx2);font-family:inherit;font-size:11px}',
      'body.light-theme .t4-cursortip{background:rgba(255,255,255,.97);border-color:#dfe4ec;color:#0f172a}',
      'body.light-theme .t4-cursortip .t4-ctip-fi{color:#c06800}',
      'body.light-theme .t4-cursortip .t4-ctip-met{color:#4F7CDB}',
      'body.light-theme .t4-cursortip .t4-ctip-zl{color:#475569}',
      /* === Focus-pulse ring для dblclick fly-to === */
      '.t4-focuspulse{position:absolute;border:2px solid var(--cyan);border-radius:50%;',
      '  pointer-events:none;z-index:4;animation:t4pulse .7s ease-out forwards}',
      '@keyframes t4pulse{0%{transform:translate(-50%,-50%) scale(.3);opacity:1}',
      '  100%{transform:translate(-50%,-50%) scale(2.2);opacity:0}}',

      /* === 3D-лассо overlay-SVG ===
         Лежит поверх glCanvas, занимает всю область пейна (минус 34px
         header-полоса, как и канвас — см. правило выше). pointer-events:
         none, чтобы события мыши попадали в канвас. Линия — двойная:
         тонкая «тень» под cyan-обводкой даёт читаемость и на светлом, и
         на тёмном фоне без переключения цвета. */
      '.t4-lasso3d-svg{position:absolute;top:34px;left:0;right:0;bottom:0;',
      '  width:100%;height:calc(100% - 34px);pointer-events:none;z-index:4;',
      '  display:none;overflow:visible}',
      '.t4-lasso3d-svg.active{display:block}',
      '.t4-lasso3d-shadow{fill:rgba(0,240,255,.06);stroke:rgba(0,0,0,.35);',
      '  stroke-width:2.5;stroke-linejoin:round;stroke-linecap:round}',
      '.t4-lasso3d-line{fill:none;stroke:var(--cyan);stroke-width:1.4;',
      '  stroke-dasharray:5 4;stroke-linejoin:round;stroke-linecap:round;',
      '  filter:drop-shadow(0 0 3px rgba(0,240,255,.55))}',
      'body.light-theme .t4-lasso3d-shadow{fill:rgba(79,124,219,.05);',
      '  stroke:rgba(255,255,255,.85)}',
      'body.light-theme .t4-lasso3d-line{stroke:#3a5fb8;',
      '  filter:drop-shadow(0 0 2px rgba(79,124,219,.45))}',
      /* Курсор-«лассо» когда инструмент активен над 3D */
      'body.t4-tool-lasso #t4-3d canvas{cursor:crosshair}',

      /* ═══════════════════════════════════════════════════════════
         FOCUS MODE — после нажатия «Построить развёртку» скрываем
         левую панель и показываем язычок для её возврата. Анимация
         через width/padding — border-right у .panel.left = 0 в
         собранном виде, чтобы ничего не «щёлкало».
         ═══════════════════════════════════════════════════════════ */
      '.stage[data-stage="unfold"] .panel.left{',
      '  transition:width .28s ease, padding .28s ease,',
      '    min-width .28s ease, border-color .28s ease}',
      '.stage[data-stage="unfold"].t4-focused .panel.left{',
      '  width:0!important;min-width:0!important;padding:0!important;',
      '  border-right-color:transparent!important;overflow:hidden!important}',
      '.stage[data-stage="unfold"].t4-focused .panel.left > *{opacity:0;pointer-events:none}',
      /* Правая панель — чуть уже в focus-режиме, чтобы ещё немного добрать ширины канвасам. */
      '.stage[data-stage="unfold"] .panel.right{transition:width .28s ease, padding .28s ease,',
      '    min-width .28s ease, border-color .28s ease}',
      '.stage[data-stage="unfold"].t4-focused .panel.right{width:300px}',
      /* Полное схлопывание правой панели — симметрично левой. Отдельный
         класс .t4-focused-r, чтобы левый и правый collapse были независимыми.
         Включается кнопкой-закрытия в правой панели, выключается язычком
         .t4-reopen-r на правой кромке. */
      '.stage[data-stage="unfold"].t4-focused-r .panel.right{',
      '  width:0!important;min-width:0!important;padding:0!important;',
      '  border-left-color:transparent!important;overflow:hidden!important}',
      '.stage[data-stage="unfold"].t4-focused-r .panel.right > *{opacity:0;pointer-events:none}',

      /* Язычок-переключатель ЛЕВОЙ панели. Виден всегда, пока развёртка
         построена (.t4-built). Клик → toggle .t4-focused. Стрелка SVG
         по умолчанию смотрит вправо (>). Когда панель открыта (нет
         .t4-focused) — поворачиваем её на 180° чтобы смотрела влево (<),
         намекая, что клик её закроет. В .t4-focused (панель схлопнута)
         — нулевой поворот, стрелка ">" зовёт раскрыть. */
      '.t4-reopen{position:absolute;top:50%;left:0;transform:translateY(-50%);',
      '  width:24px;height:84px;border-radius:0 8px 8px 0;',
      '  background:linear-gradient(90deg,rgba(0,240,255,.10),var(--card) 70%);',
      '  border:1px solid rgba(0,240,255,.35);border-left:none;',
      '  color:var(--cyan);cursor:pointer;display:none;',
      '  align-items:center;justify-content:center;z-index:6;',
      '  box-shadow:2px 0 10px rgba(0,240,255,.18),2px 0 8px rgba(0,0,0,.25);',
      '  transition:width .15s ease, background .15s ease, color .15s ease,',
      '    box-shadow .15s ease}',
      '.t4-reopen:hover{width:32px;background:linear-gradient(90deg,rgba(0,240,255,.28),var(--card) 80%);',
      '  border-color:rgba(0,240,255,.6);',
      '  box-shadow:2px 0 16px rgba(0,240,255,.45),2px 0 8px rgba(0,0,0,.3)}',
      '.t4-reopen svg{opacity:.95;transition:transform .28s ease;width:12px;height:16px}',
      '.t4-reopen:hover svg{opacity:1}',
      '.stage[data-stage="unfold"].t4-built .t4-reopen{display:flex}',
      /* Панель открыта → стрелка смотрит влево (закрыть) */
      '.stage[data-stage="unfold"].t4-built .t4-reopen svg{transform:rotate(180deg)}',
      /* Панель закрыта → стрелка смотрит вправо (открыть) + усиленный glow,
         чтобы пользователь сразу нашёл «вход» обратно */
      '.stage[data-stage="unfold"].t4-built.t4-focused .t4-reopen{',
      '  background:linear-gradient(90deg,rgba(0,240,255,.22),var(--card) 85%);',
      '  box-shadow:2px 0 14px rgba(0,240,255,.4),2px 0 8px rgba(0,0,0,.3)}',
      '.stage[data-stage="unfold"].t4-built.t4-focused .t4-reopen svg{transform:rotate(0deg)}',
      'body.light-theme .t4-reopen{background:linear-gradient(90deg,rgba(79,124,219,.12),#fdfdfe 70%);',
      '  border-color:rgba(79,124,219,.4);color:#4F7CDB}',
      'body.light-theme .t4-reopen:hover{background:linear-gradient(90deg,rgba(79,124,219,.25),#fdfdfe 80%)}',

      /* Язычок-переключатель ПРАВОЙ панели (зеркало .t4-reopen). Базовая
         SVG стрелка смотрит влево ("<"). Когда панель открыта — поворот
         180° → стрелка ">", зовёт закрыть. В .t4-focused-r — нулевой
         поворот, стрелка "<" зовёт открыть. */
      '.t4-reopen-r{position:absolute;top:50%;right:0;transform:translateY(-50%);',
      '  width:24px;height:84px;border-radius:8px 0 0 8px;',
      '  background:linear-gradient(270deg,rgba(0,240,255,.10),var(--card) 70%);',
      '  border:1px solid rgba(0,240,255,.35);border-right:none;',
      '  color:var(--cyan);cursor:pointer;display:none;',
      '  align-items:center;justify-content:center;z-index:6;',
      '  box-shadow:-2px 0 10px rgba(0,240,255,.18),-2px 0 8px rgba(0,0,0,.25);',
      '  transition:width .15s ease, background .15s ease, color .15s ease,',
      '    box-shadow .15s ease}',
      '.t4-reopen-r:hover{width:32px;background:linear-gradient(270deg,rgba(0,240,255,.28),var(--card) 80%);',
      '  border-color:rgba(0,240,255,.6);',
      '  box-shadow:-2px 0 16px rgba(0,240,255,.45),-2px 0 8px rgba(0,0,0,.3)}',
      '.t4-reopen-r svg{opacity:.95;transition:transform .28s ease;width:12px;height:16px}',
      '.t4-reopen-r:hover svg{opacity:1}',
      '.stage[data-stage="unfold"].t4-built .t4-reopen-r{display:flex}',
      /* Панель открыта → стрелка смотрит вправо (закрыть) */
      '.stage[data-stage="unfold"].t4-built .t4-reopen-r svg{transform:rotate(180deg)}',
      /* Панель закрыта → стрелка смотрит влево (открыть) + усиленный glow */
      '.stage[data-stage="unfold"].t4-built.t4-focused-r .t4-reopen-r{',
      '  background:linear-gradient(270deg,rgba(0,240,255,.22),var(--card) 85%);',
      '  box-shadow:-2px 0 14px rgba(0,240,255,.4),-2px 0 8px rgba(0,0,0,.3)}',
      '.stage[data-stage="unfold"].t4-built.t4-focused-r .t4-reopen-r svg{transform:rotate(0deg)}',
      'body.light-theme .t4-reopen-r{background:linear-gradient(270deg,rgba(79,124,219,.12),#fdfdfe 70%);',
      '  border-color:rgba(79,124,219,.4);color:#4F7CDB}',
      'body.light-theme .t4-reopen-r:hover{background:linear-gradient(270deg,rgba(79,124,219,.25),#fdfdfe 80%)}',

      /* Кнопка-закрытия в верхнем правом углу правой панели БОЛЬШЕ НЕ ИСПОЛЬЗУЕТСЯ.
         Оставлено правило скрытия на случай, если где-то ещё создаётся элемент
         с этим классом. Переключение теперь целиком через язычок .t4-reopen-r. */
      '.t4-rcollapse{display:none!important}',

      /* ═══════════════════════════════════════════════════════════
         TOP TOOLBAR — лаконичная полоса в одну строку над сплит-вью.
         Функциональные группы разделены только вертикальными линиями —
         без громоздких лейблов «ИНСТРУМЕНТЫ/ЦВЕТ/ВИД», которые раньше
         съедали ~90 px ширины без смысловой нагрузки. При нехватке
         ширины появляется горизонтальный скролл.
         Старый .t4-toolbar (absolute в углу) оставлен для обратной
         совместимости, но скрыт.
         ═══════════════════════════════════════════════════════════ */
      '.t4-toptools{display:none;flex-wrap:nowrap;align-items:center;gap:0;',
      '  padding:4px 8px;background:var(--card);border:1px solid var(--brd);',
      '  border-radius:var(--rad);box-shadow:var(--shadow);',
      '  backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);',
      '  position:relative;flex-shrink:0;z-index:4;',
      '  overflow-x:auto;overflow-y:visible;',
      /* scrollbar полностью скрыт — видимая полоска создавала иллюзию андерлайна.
         Прокрутка работает колёсиком/тачпадом при нехватке ширины. */
      '  scrollbar-width:none;-ms-overflow-style:none}',
      '.t4-toptools::-webkit-scrollbar{display:none;width:0;height:0}',
      '.t4-toptools::before{content:"";position:absolute;top:0;left:0;right:0;height:1px;',
      '  background:linear-gradient(90deg, transparent, var(--brd-glow), transparent);',
      '  pointer-events:none}',
      '.t4-toptools.show{display:flex}',
      /* Группы — без лейблов, только с вертикальным сепаратором слева */
      '.t4-tgroup{display:flex;align-items:center;gap:2px;padding:0 6px;',
      '  position:relative;flex-shrink:0}',
      '.t4-tgroup:first-child{padding-left:2px}',
      '.t4-tgroup:last-child{padding-right:2px}',
      '.t4-tgroup+.t4-tgroup{margin-left:6px;padding-left:12px}',
      '.t4-tgroup+.t4-tgroup::before{content:"";position:absolute;left:0;top:4px;bottom:4px;',
      '  width:1px;background:var(--brd);opacity:.8}',
      /* Старые лейблы больше не показываем (на всякий случай — тихо прячем) */
      '.t4-tgroup-label{display:none}',
      /* Кнопки — компактные, иконка + короткий текст */
      '.t4-btn2{display:inline-flex;align-items:center;gap:6px;height:28px;',
      '  padding:0 9px;border-radius:4px;border:1px solid transparent;',
      '  background:transparent;color:var(--tx2);cursor:pointer;',
      '  font-family:"Share Tech Mono","Consolas",monospace;font-size:10px;font-weight:700;',
      '  letter-spacing:.08em;text-transform:uppercase;',
      '  transition:background .12s ease, color .12s ease, border-color .12s ease;',
      '  position:relative;white-space:nowrap;flex-shrink:0}',
      '.t4-btn2 svg{flex-shrink:0;opacity:.85;width:13px;height:13px}',
      '.t4-btn2>span:not(.t4-tip){line-height:1}',
      '.t4-btn2:hover{background:rgba(0,240,255,.08);color:var(--tx);',
      '  border-color:var(--brd)}',
      '.t4-btn2:hover svg{opacity:1}',
      '.t4-btn2.active{background:rgba(0,240,255,.14);color:var(--cyan);',
      '  border-color:rgba(0,240,255,.28);',
      '  box-shadow:0 0 8px rgba(0,240,255,.18), inset 0 0 10px rgba(0,240,255,.06)}',
      '.t4-btn2.active svg{opacity:1}',
      /* Цветные swatch-индикаторы для кнопок режимов раскраски */
      '.t4-btn2 .t4-sw{display:inline-block;width:9px;height:9px;border-radius:2px;',
      '  flex-shrink:0;box-shadow:inset 0 0 0 1px rgba(0,0,0,.25),0 0 4px currentColor}',
      '.t4-sw-zones{background:linear-gradient(135deg,#00b4ff 0%,#00b4ff 33%,#00ff88 33%,#00ff88 66%,#ff8844 66%)}',
      '.t4-sw-L2{background:linear-gradient(90deg,#3b6be8 0%,#e8e8e8 50%,#e03050 100%)}',
      '.t4-sw-iso{background:linear-gradient(90deg,#2a6bc8 0%,#ffd878 50%,#e06040 100%)}',
      '.t4-sw-ring{background:linear-gradient(135deg,#1b783e 0%,#a8d84a 100%)}',
      '.t4-sw-risk{background:linear-gradient(90deg,#00d060 0%,#ffb030 50%,#ff3350 100%)}',
      /* Тултип — строго hidden по умолчанию, появляется при hover с задержкой */
      '.t4-btn2 .t4-tip{visibility:hidden;opacity:0;',
      '  position:absolute;top:calc(100% + 8px);left:50%;',
      '  transform:translateX(-50%) translateY(-4px);',
      '  background:rgba(0,10,20,.96);',
      '  border:1px solid var(--brd);color:var(--cyan);',
      '  font-size:10px;padding:6px 10px;border-radius:4px;white-space:normal;',
      '  max-width:280px;width:max-content;line-height:1.4;',
      '  font-family:"Share Tech Mono","Consolas","Menlo",monospace;letter-spacing:.04em;z-index:20;',
      '  pointer-events:none;box-shadow:0 2px 12px rgba(0,0,0,.5);',
      '  transition:opacity .15s ease, transform .15s ease, visibility .15s}',
      '.t4-btn2:hover .t4-tip{visibility:visible;opacity:1;',
      '  transform:translateX(-50%) translateY(0);transition-delay:.5s}',
      /* Если кнопка в последней группе — тултип прижимаем к правому краю */
      '.t4-tgroup:last-child .t4-btn2 .t4-tip{left:auto;right:0;',
      '  transform:translateY(-4px)}',
      '.t4-tgroup:last-child .t4-btn2:hover .t4-tip{transform:translateY(0)}',
      /* Light theme */
      'body.light-theme .t4-toptools{background:rgba(255,255,255,.96);',
      '  border-color:#dfe4ec}',
      'body.light-theme .t4-tgroup+.t4-tgroup::before{background:#dfe4ec}',
      'body.light-theme .t4-btn2{color:#5a6472}',
      'body.light-theme .t4-btn2:hover{background:#f1f5f9;color:#2a3440;',
      '  border-color:#dfe4ec}',
      'body.light-theme .t4-btn2.active{color:#4F7CDB;',
      '  background:rgba(79,124,219,.08);border-color:rgba(79,124,219,.25)}',
      'body.light-theme .t4-btn2 .t4-tip{background:rgba(255,255,255,.98);',
      '  color:#2a3440;border-color:#dfe4ec;',
      '  box-shadow:0 2px 12px rgba(0,0,0,.15)}',
      /* ═══════════════════════════════════════════════════════════
         ПРАВАЯ ПАНЕЛЬ — немного шире в focus-режиме, чтобы длинные
         подписи метрик (L² stretch · mean, Ошибка длины · mean и т.п.)
         не обрезались посреди слова. Контент переносится по строкам,
         а не клипается.
         ═══════════════════════════════════════════════════════════ */
      '.t4-distcard .t4-row{align-items:flex-start;flex-wrap:wrap;gap:4px 8px}',
      '.t4-distcard .t4-lab{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;',
      '  word-break:normal;hyphens:none;line-height:1.35}',
      '.t4-distcard .t4-val{flex:0 0 auto;white-space:nowrap}',
      /* Раньше тут было `.t4-distcard{padding-top:0}` и
         `.t4-distcard>.card-title{margin-top:0;margin-bottom:0}` — это
         компенсировало sticky-заголовок, который сам себе делал
         padding-top. Теперь sticky'я нет (карточка не скроллится
         внутри себя), и dist-card должна выглядеть как обычная .card —
         с дефолтными отступами из app.css, чтобы быть единообразной
         с соседней .t4-meas-card. */

      /* ═══════════════════════════════════════════════════════════
         ЛЕГЕНДА ЦВЕТ-РЕЖИМА — отдельная секция в правом sidebar,
         раньше была плавающей панелью поверх 2D-развёртки (.t4-measfloat)
         и перекрывала ~30% мешa. Теперь вставляется над метриками,
         когда выбран любой режим кроме ZONES. В режиме ZONES скрыта.

         Стиль согласован с .ep-ctrls-title из tab2/tab3 — серый
         uppercase-заголовок без рамок и боковых полосок, тот же
         визуальный язык, что и у других sub-headers в карточках.
         ═══════════════════════════════════════════════════════════ */
      '.t4-legend-panel{margin:0 0 14px;padding:0;',
      '  background:transparent;border:0}',
      '.t4-legend-title{font-size:11px;letter-spacing:.16em;',
      '  text-transform:uppercase;color:var(--tx3);font-weight:700;',
      '  margin:0 0 8px;padding:0;',
      '  font-family:inherit}',
      '.t4-legend-body{padding:0}',
      '.t4-legend-body .t4-row{display:flex;justify-content:space-between;',
      '  gap:8px;padding:3px 0;align-items:center;font-size:12px}',
      '.t4-legend-body .t4-lab{color:var(--tx2)}',
      '.t4-legend-body .t4-val{font-family:"Share Tech Mono","Consolas","Menlo",monospace;',
      '  font-weight:600;color:var(--cyan);font-size:12px}',
      '.t4-legend-body .t4-hint{font-size:11.5px;color:var(--tx2);',
      '  margin-top:8px;line-height:1.5}',
      'body.light-theme .t4-legend-body .t4-val{color:#4F7CDB}',
      'body.light-theme .t4-legend-body .t4-lab{color:#475569}',
      'body.light-theme .t4-legend-body .t4-hint{color:#64748b}',

      /* ═══════════════════════════════════════════════════════════
         ПАНЕЛЬ ТЕКУЩЕГО ИЗМЕРЕНИЯ — раньше жила плавающей карточкой
         (.t4-measfloat) в правом-нижнем углу и перекрывала ~25%
         развёртки. Затем была вложенной секцией внутри .t4-distcard.
         Теперь — самостоятельная .card в правой панели (.t4-meas-card),
         появляется/скрывается в зависимости от активного инструмента.
         Стилизация .t4-meas-panel минимальная: card сама даёт обводку,
         padding и заголовок (.card-title), как в левой панели.
         ═══════════════════════════════════════════════════════════ */
      '.t4-measfloat{display:none!important}',
      '.t4-meas-panel{margin:0;padding:0;background:transparent;border:0}',
      '.t4-meas-body{padding:0}',
      '.t4-meas-body .t4-row{display:flex;justify-content:space-between;',
      '  gap:8px;padding:4px 0;align-items:center;font-size:12.5px}',
      '.t4-meas-body .t4-lab{color:var(--tx2)}',
      '.t4-meas-body .t4-val{font-family:"Share Tech Mono","Consolas","Menlo",monospace;',
      '  font-weight:600;color:var(--cyan);font-size:12.5px;',
      '  font-variant-numeric:tabular-nums}',
      '.t4-meas-body .t4-hint{font-size:12px;color:var(--tx2);',
      '  margin-top:8px;line-height:1.5}',
      '.t4-meas-body .t4-hint b{color:var(--cyan);font-weight:600}',
      /* Подсекция внутри meas-panel — например «Рекомендуемый лоскут»
         в перфорации. Заголовок согласован с .ep-section-title
         (серый uppercase 11px), отделяется от выше идущих метрик
         тонкой границей сверху. */
      '.t4-meas-body .t4-meas-subsection{margin-top:14px;padding-top:10px;',
      '  border-top:1px solid var(--brd-glow)}',
      '.t4-meas-body .t4-meas-subtitle{font-size:11px;letter-spacing:.16em;',
      '  text-transform:uppercase;color:var(--tx3);font-weight:700;',
      '  margin:0 0 8px;font-family:inherit}',
      /* stat-row внутри measure body — лаконичная подложка без
         декоративных ромбов, согласованно с app.css. */
      '.t4-meas-body .stat-row{padding:4px 0;font-size:12px;',
      '  border-bottom:1px solid rgba(0,240,255,.06);position:relative}',
      '.t4-meas-body .stat-row:last-child{border-bottom:none}',
      '.t4-meas-body .stat-row::before,',
      '.t4-meas-body .stat-row::after{',
      '  content:none!important;display:none!important;',
      '  background:none!important;',
      '}',
      '.t4-meas-body .stat-row{display:flex;justify-content:space-between;',
      '  align-items:center;gap:8px;padding-left:0!important}',
        /* Лейблы (max/min/средний) — sans-serif inherit, иначе они
         наследуют Share Tech Mono из глобальных стилей .stat-row
         в app.css, у которого нет кириллических глифов: «средний»
         рендерится с подменными буквами и читается как «среgний».
         .stat-v (числовое значение) специально оставляем
         моноширинным — это акцентируется на «цифровом» характере
         данных, как в .t4-val везде. */
      '.t4-meas-body .stat-row .stat-k{font-family:inherit;',
      '  color:var(--tx2);font-weight:400}',
      '.t4-meas-body .stat-row .stat-v{',
      '  font-family:"Share Tech Mono","Consolas","Menlo",monospace;',
      '  font-weight:600;font-variant-numeric:tabular-nums}',
      'body.light-theme .t4-meas-body .t4-val{color:#4F7CDB}',
      'body.light-theme .t4-meas-body .t4-hint{color:#5d6f80}',
      'body.light-theme .t4-meas-body .t4-hint b{color:#4F7CDB}',
      'body.light-theme .t4-meas-body .stat-row{border-bottom-color:rgba(79,124,219,.10)}',

      /* Сводка диаметров — лейбл и числа в столбик. Раньше был flex-row
       с justify-content:space-between + text-align:right у значения:
       при 4-5 диаметрах строка переполнялась и вторая строка прижималась
       к правому краю (оптически — «съезжала» с первой). Теперь лейбл
       сверху, числа во всю ширину снизу с естественным left-align при
       переносе. */
      '.t4-meas-headline{display:flex;flex-direction:column;',
      '  align-items:stretch;gap:4px;padding:8px 10px;margin-bottom:10px;',
      '  background:rgba(0,240,255,.08);border:1px solid rgba(0,240,255,.25);',
      '  border-radius:5px}',
      '.t4-meas-headline-k{font-family:inherit;',
      '  font-size:11px;font-weight:700;color:var(--cyan);',
      '  text-transform:uppercase;letter-spacing:.16em}',
      '.t4-meas-headline-v{font-family:"Share Tech Mono","Consolas","Menlo",monospace;',
      '  font-size:13px;font-weight:700;color:var(--cyan);',
      '  font-variant-numeric:tabular-nums;',
      '  text-align:left;line-height:1.4;word-break:break-word}',
      'body.light-theme .t4-meas-headline{background:rgba(79,124,219,.06);',
      '  border-color:rgba(79,124,219,.25)}',
      'body.light-theme .t4-meas-headline-k,',
      'body.light-theme .t4-meas-headline-v{color:#4F7CDB}',

      /* ═══════════════════════════════════════════════════════════
         СЛАЙДЕРЫ ФЛАП-СИМУЛЯТОРА — единый неон-стиль c tab2/tab3.
         Тот же 4-px трек + 16-px cyan-кружок + glow. CSS-переменная
         --ep-pct (ставится при рендере) красит «пройденную» часть
         в cyan, остальную — в полупрозрачный cyan.
         Раньше ползунки были раскрашены через accent-color и выглядели
         как стандартные браузерные range — выпадали из общей стилистики
         других вкладок.
         ═══════════════════════════════════════════════════════════ */
      '.t4-flap-row{margin-bottom:10px}',
      '.t4-flap-row-head{display:flex;justify-content:space-between;',
      '  align-items:baseline;font-size:12px;color:var(--tx2);margin-bottom:3px}',
      '.t4-flap-lab{color:var(--tx2)}',
      '.t4-flap-val{font-family:"Share Tech Mono","Consolas","Menlo",monospace;',
      '  font-weight:600;color:var(--cyan);font-variant-numeric:tabular-nums}',
      '.t4-flap-slider{-webkit-appearance:none;appearance:none;',
      '  width:100%;height:22px;margin:0;',
      '  background:transparent;cursor:pointer;outline:none}',
      /* WebKit track */
      '.t4-flap-slider::-webkit-slider-runnable-track{',
      '  height:4px;border-radius:2px;',
      '  background:linear-gradient(to right,',
      '    var(--cyan) 0%, var(--cyan) var(--ep-pct,30%),',
      '    rgba(0,240,255,.12) var(--ep-pct,30%), rgba(0,240,255,.12) 100%);',
      '  box-shadow:0 0 6px rgba(0,240,255,.18)}',
      '.t4-flap-slider::-webkit-slider-thumb{',
      '  -webkit-appearance:none;appearance:none;',
      '  width:16px;height:16px;border-radius:50%;',
      '  background:var(--cyan);border:2px solid var(--bg2);',
      '  margin-top:-6px;',
      '  box-shadow:0 0 0 1px var(--cyan), 0 0 12px rgba(0,240,255,.6);',
      '  cursor:grab;transition:transform .12s ease, box-shadow .12s ease}',
      '.t4-flap-slider:hover::-webkit-slider-thumb{transform:scale(1.15);',
      '  box-shadow:0 0 0 1px var(--cyan), 0 0 18px rgba(0,240,255,.8)}',
      '.t4-flap-slider:active::-webkit-slider-thumb{cursor:grabbing;transform:scale(1.05)}',
      /* Firefox */
      '.t4-flap-slider::-moz-range-track{height:4px;border-radius:2px;',
      '  background:rgba(0,240,255,.12)}',
      '.t4-flap-slider::-moz-range-progress{height:4px;border-radius:2px;',
      '  background:var(--cyan);box-shadow:0 0 6px rgba(0,240,255,.4)}',
      '.t4-flap-slider::-moz-range-thumb{width:16px;height:16px;border-radius:50%;',
      '  background:var(--cyan);border:2px solid var(--bg2);',
      '  box-shadow:0 0 0 1px var(--cyan), 0 0 12px rgba(0,240,255,.6);',
      '  cursor:grab}',
      /* Light theme — синий #4F7CDB вместо cyan, согласовано с tab2/tab3 */
      'body.light-theme .t4-flap-val{color:#4F7CDB}',
      'body.light-theme .t4-flap-slider::-webkit-slider-runnable-track{',
      '  background:linear-gradient(to right,',
      '    #4F7CDB 0%, #4F7CDB var(--ep-pct,30%),',
      '    rgba(79,124,219,.18) var(--ep-pct,30%), rgba(79,124,219,.18) 100%);',
      '  box-shadow:0 0 4px rgba(79,124,219,.18)}',
      'body.light-theme .t4-flap-slider::-webkit-slider-thumb{',
      '  background:#4F7CDB;',
      '  box-shadow:0 0 0 1px #4F7CDB, 0 0 10px rgba(79,124,219,.45)}',
      'body.light-theme .t4-flap-slider:hover::-webkit-slider-thumb{',
      '  box-shadow:0 0 0 1px #4F7CDB, 0 0 14px rgba(79,124,219,.65)}',
      'body.light-theme .t4-flap-slider::-moz-range-track{background:rgba(79,124,219,.18)}',
      'body.light-theme .t4-flap-slider::-moz-range-progress{background:#4F7CDB;',
      '  box-shadow:0 0 4px rgba(79,124,219,.4)}',
      'body.light-theme .t4-flap-slider::-moz-range-thumb{background:#4F7CDB;',
      '  box-shadow:0 0 0 1px #4F7CDB, 0 0 10px rgba(79,124,219,.45)}',

      /* Список замеров — компактные строки */
      '.t4-meas-list{display:flex;flex-direction:column;gap:4px;',
      '  margin-bottom:8px}',
      '.t4-meas-row{display:flex;align-items:center;gap:8px;',
      '  padding:5px 8px;border-radius:4px;',
      '  background:rgba(255,255,255,.02);',
      '  border:1px solid var(--brd);transition:border-color .15s ease}',
      '.t4-meas-row:hover{border-color:rgba(0,240,255,.35)}',
      '.t4-meas-num{display:flex;align-items:center;justify-content:center;',
      '  width:20px;height:20px;border-radius:50%;color:#06090f;',
      '  font-family:"Share Tech Mono","Consolas","Menlo",monospace;font-size:11px;',
      '  font-weight:700;flex-shrink:0}',
      '.t4-meas-len{flex:1;font-family:"Share Tech Mono","Consolas","Menlo",monospace;',
      '  font-size:13px;font-weight:700;font-variant-numeric:tabular-nums}',
      '.t4-meas-del{background:transparent;border:0;cursor:pointer;',
      '  color:var(--tx3);font-size:16px;line-height:1;padding:2px 6px;',
      '  border-radius:3px;transition:color .15s ease,background .15s ease}',
      '.t4-meas-del:hover{color:var(--red,#e04050);',
      '  background:rgba(220,40,60,.12)}',
      'body.light-theme .t4-meas-row{background:rgba(0,0,0,.02)}',

      /* Статистика под списком */
      '.t4-meas-stats{margin-top:8px;padding-top:6px;',
      '  border-top:1px solid var(--brd)}',

      /* Pending-индикатор. Раньше был `display:flex` — это ломало
         текст без пульсирующей точки: `Точка <b>A</b> поставлена...`
         flex разбивал на 3 анонимных flex-айтема (текст, <b>, текст),
         длинный третий айтем сжимался и переносился, а первые два
         оставались "колонкой" слева. Теперь это обычный block:
         текст течёт нормально, а пульс-точка (если есть) — inline-block
         с vertical-align:middle, выглядит так же как в flex-варианте. */
      '.t4-meas-pending{display:block;',
      '  margin-top:8px;padding:6px 10px;font-size:11.5px;',
      '  font-family:inherit;color:var(--cyan);line-height:1.45;',
      '  background:rgba(0,240,255,.06);border:1px dashed rgba(0,240,255,.35);',
      '  border-radius:4px}',
      '.t4-meas-pending b{color:var(--cyan);font-weight:700}',
      '.t4-meas-pulse{display:inline-block;width:8px;height:8px;',
      '  border-radius:50%;background:var(--cyan);',
      '  box-shadow:0 0 8px var(--cyan);vertical-align:middle;',
      '  margin-right:6px;',
      '  animation:t4-pulse 1.2s ease-in-out infinite;flex-shrink:0}',
      '@keyframes t4-pulse{0%,100%{opacity:1;transform:scale(1)}',
      '  50%{opacity:.4;transform:scale(.6)}}',
      'body.light-theme .t4-meas-pending{color:#4F7CDB;',
      '  background:rgba(79,124,219,.06);border-color:rgba(79,124,219,.35)}',
      'body.light-theme .t4-meas-body .t4-lab{color:#475569}',
      'body.light-theme .t4-meas-body .t4-hint{color:#64748b}',

      /* ═══════════════════════════════════════════════════════════
         SUB-SECTION LABELS — заголовки 3D-/2D-пейнов.
         Сидят в верхней 34-px полосе pane, физически ВЫШЕ канваса
         (см. правило `.t4-split canvas{top:34px;...}`) — поэтому не
         могут перекрыть сетку, оси или контент развёртки.
         «3D» — слева, циан;  «2D развёртка» — справа, янтарь.
         Зеркальная симметрия + разный цвет однозначно отделяют 2 области.
         ═══════════════════════════════════════════════════════════ */
      '.t4-split .t4-label{top:6px;',
      '  padding:6px 11px 6px 10px;',
      '  font-size:12px;font-family:inherit;',
      '  letter-spacing:.18em;text-transform:uppercase;font-weight:700;',
      '  background:rgba(0,10,20,.78);backdrop-filter:blur(6px);',
      '  border-radius:4px;color:var(--cyan);',
      '  display:flex;align-items:center;gap:8px;',
      '  box-shadow:0 2px 8px rgba(0,0,0,.3)}',
      /* 3D — слева, циан */
      '#t4-3d > .t4-label{left:12px;right:auto;color:var(--cyan)}',
      '#t4-3d > .t4-label::before{content:"";display:inline-block;width:2px;height:14px;',
      '  background:var(--cyan);border-radius:1px;box-shadow:0 0 4px var(--cyan)}',
      /* 2D — справа, янтарный (отличный от циана), чтобы пользователь
         сразу видел: это другая область, не та же самая. */
      '#t4-uv > .t4-label{right:12px;left:auto;color:#ffcf66;',
      '  border:1px solid rgba(255,207,102,.25)}',
      '#t4-uv > .t4-label::after{content:"";display:inline-block;width:2px;height:14px;',
      '  background:#ffcf66;border-radius:1px;box-shadow:0 0 4px #ffcf66;',
      '  order:2;margin-left:4px}',
      'body.light-theme .t4-split .t4-label{background:rgba(255,255,255,.92);',
      '  border-color:#dfe4ec;',
      '  box-shadow:0 2px 8px rgba(0,0,0,.1)}',
      'body.light-theme #t4-3d > .t4-label{color:#4F7CDB}',
      'body.light-theme #t4-3d > .t4-label::before{background:#4F7CDB;',
      '  box-shadow:0 0 4px #4F7CDB}',
      'body.light-theme #t4-uv > .t4-label{color:#b06a00;',
      '  border-color:rgba(176,106,0,.3)}',
      'body.light-theme #t4-uv > .t4-label::after{background:#b06a00;',
      '  box-shadow:0 0 4px #b06a00}',

      /* Старый floating-тулбар (#t4-toolbar) полностью заменён новым
         .t4-toptools над сплит-вью. Прячем его ВСЕГДА (а не только в
         .t4-focused, как было раньше) — иначе при открытии левой панели
         через язычок .t4-reopen он "выскакивает" в верхний-правый угол
         поверх 2D-развёртки и дублирует кнопки нового тулбара. */
      '.stage[data-stage="unfold"] #t4-toolbar{display:none!important}',
      '.t4-toolbar{display:none!important}',

      /* ═══ Floating «Fit» кнопки в углах 2D/3D-панелей ═══
         Заметная пилюля с иконкой, подписью «Вписать» и (для 2D) хоткеем F.
         Становится ярче при hover. Размещается в правом-нижнем углу так,
         чтобы не перекрывать scale-bar / osi-gizmo.                      */
      '.t4-fitbtn{position:absolute;right:10px;bottom:10px;z-index:4;',
      '  display:inline-flex;align-items:center;gap:6px;height:28px;',
      '  padding:0 10px 0 8px;border-radius:14px;cursor:pointer;',
      '  background:rgba(0,10,20,.7);backdrop-filter:blur(8px);',
      '  border:1px solid rgba(0,240,255,.3);color:var(--cyan);',
      '  font-family:"Share Tech Mono","Consolas",monospace;',
      '  font-size:10px;font-weight:700;letter-spacing:.12em;',
      '  text-transform:uppercase;',
      '  transition:background .12s ease, color .12s ease, ',
      '    border-color .12s ease, box-shadow .12s ease;',
      '  box-shadow:0 2px 10px rgba(0,0,0,.35)}',
      '.t4-fitbtn:hover{background:rgba(0,10,20,.92);',
      '  border-color:rgba(0,240,255,.7);',
      '  box-shadow:0 0 14px rgba(0,240,255,.35),0 2px 10px rgba(0,0,0,.4)}',
      '.t4-fitbtn:active{transform:translateY(1px)}',
      /* Кнопка PNG-экспорта в 2D-pane: тот же стиль, но позиция
         немного выше «ВПИСАТЬ», чтобы они не накладывались. На 3D-pane
         фит — единственная кнопка справа-снизу; на 2D-pane мы добавили
         вторую, поэтому их разносим вертикально. */
      '.t4-pngbtn{bottom:48px}',
      '.t4-fitbtn .t4-fitlab{line-height:1}',
      '.t4-fitbtn .t4-fitkey{display:inline-block;min-width:14px;height:14px;',
      '  padding:0 3px;margin-left:2px;border-radius:3px;',
      '  background:rgba(0,240,255,.18);border:1px solid rgba(0,240,255,.35);',
      '  font-size:9px;line-height:14px;text-align:center;color:var(--cyan);',
      '  letter-spacing:0}',
      'body.light-theme .t4-fitbtn{background:rgba(255,255,255,.88);',
      '  border-color:rgba(79,124,219,.35);color:#4F7CDB}',
      'body.light-theme .t4-fitbtn:hover{background:rgba(255,255,255,.98);',
      '  border-color:rgba(79,124,219,.7);',
      '  box-shadow:0 0 12px rgba(79,124,219,.3),0 2px 10px rgba(0,0,0,.12)}',
      'body.light-theme .t4-fitbtn .t4-fitkey{background:rgba(79,124,219,.12);',
      '  border-color:rgba(79,124,219,.3);color:#4F7CDB}',
    ].join('\n');
    document.head.appendChild(s);
  }

  /* ═══ DOM INJECTION ═══ */
  function ensureDOM() {
    if (domBuilt) return;
    const stage = document.querySelector('.stage[data-stage="unfold"]');
    if (!stage) return;
    const workarea = stage.querySelector('.workarea');
    const viewport = stage.querySelector('.workarea .viewport');
    if (!workarea || !viewport) return;

    const split = document.createElement('div');
    split.className = 't4-split';
    split.id = 't4-split';
    split.style.display = 'none';
    split.innerHTML =
      '<div class="t4-pane" id="t4-3d"><div class="t4-label">3D</div><canvas id="t4-gl"></canvas></div>' +
      '<div class="t4-splitter" id="t4-splitter" title="Перетащите, чтобы изменить пропорции"></div>' +
      '<div class="t4-pane" id="t4-uv"><div class="t4-label">2D</div><canvas id="t4-canvas"></canvas></div>';

    viewport.appendChild(split);
    glCanvas = split.querySelector('#t4-gl');
    uvCanvas = split.querySelector('#t4-canvas');
    uvCtx = uvCanvas.getContext('2d');

    // ── Floating-кнопка «Вписать» только в 3D-панели ──────────────────
    // 3D: пересчитывает orbDist/orbTarget из bbox (тот же код, что в
    //     upload3DMesh → orbTarget + orbDist).
    // На 2D-развёртке кнопку убрали — клавиша F и дабл-клик мимо фигуры
    // выполняют ту же функцию, а пустой угол освобождает место для
    // скобы-эталона «X см».
    const fitBtnSVG =
      '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">' +
        '<path d="M2 5V2h3M12 5V2H9M2 9v3h3M12 9v3H9" ' +
          'stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
      '</svg>';

    const fit3DBtn = document.createElement('button');
    fit3DBtn.type = 'button';
    fit3DBtn.className = 't4-fitbtn';
    fit3DBtn.id = 't4-fit-3d';
    fit3DBtn.title = 'Вписать модель в окно (сброс камеры)';
    fit3DBtn.innerHTML = fitBtnSVG + '<span class="t4-fitlab">Вписать</span>';
    fit3DBtn.addEventListener('click', () => {
      if (!cache || !threeInited) return;
      fit3D(/*keepAngle*/ false);
    });
    split.querySelector('#t4-3d').appendChild(fit3DBtn);

    /* ── PNG-экспорт развёртки ──────────────────────────────────────────
       Кнопка в 2D-pane'е, в углу, рядом с «ВПИСАТЬ». Сохраняет
       развёртку как PNG в реальном масштабе (по умолчанию 300 DPI ≈
       11.81 px/мм). Под печать «1:1»: распечатать на A4 при 300 DPI и
       линейкой проверить — совпадёт. Полностью переиспользует render2D
       через временную подмену unfTx/view2 на оффскрин-канвас. */
    const pngBtn = document.createElement('button');
    pngBtn.type = 'button';
    pngBtn.className = 't4-fitbtn t4-pngbtn';
    pngBtn.id = 't4-png-uv';
    pngBtn.title = 'Сохранить развёртку как PNG (масштаб 1:1, 300 DPI)';
    pngBtn.innerHTML =
      '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">' +
        '<path d="M7 1.5v6m0 0L4.5 5M7 7.5L9.5 5" stroke="currentColor" ' +
          'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
        '<path d="M2 10v1.5A1.5 1.5 0 0 0 3.5 13h7a1.5 1.5 0 0 0 1.5-1.5V10" ' +
          'stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
      '</svg>' +
      '<span class="t4-fitlab">PNG</span>';
    pngBtn.addEventListener('click', () => {
      if (!cache) return;
      exportUVAsPNG();
    });
    split.querySelector('#t4-uv').appendChild(pngBtn);

    // ── SVG-overlay для 3D-лассо ──────────────────────────────────────
    // Лежит поверх glCanvas в пейне #t4-3d; pointer-events:none чтобы
    // мышь шла в канвас. Видимость переключается классом .active в
    // lasso3DStart/Cancel.
    const lassoSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    lassoSvg.setAttribute('class', 't4-lasso3d-svg');
    lassoSvg.setAttribute('id', 't4-lasso3d');
    const shadowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    shadowPath.setAttribute('class', 't4-lasso3d-shadow');
    const linePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    linePath.setAttribute('class', 't4-lasso3d-line');
    lassoSvg.appendChild(shadowPath);
    lassoSvg.appendChild(linePath);
    split.querySelector('#t4-3d').appendChild(lassoSvg);
    lasso3DSvg = lassoSvg;
    lasso3DPathEl = { shadow: shadowPath, line: linePath };

    // Cursor-tooltip — один на весь viewport, репозиционируется при hover.
    const ctip = document.createElement('div');
    ctip.className = 't4-cursortip';
    ctip.id = 't4-cursortip';
    ctip.innerHTML =
      '<span class="t4-ctip-fi" id="t4-ctip-fi">#—</span>' +
      '<span class="t4-ctip-zn" id="t4-ctip-zn"></span>' +
      '<span class="t4-ctip-zl" id="t4-ctip-zl">—</span>' +
      '<span class="t4-ctip-met" id="t4-ctip-met"></span>';
    viewport.appendChild(ctip);
    cursorTipEl = ctip;

    /* ═══ НОВЫЙ ВЕРХНИЙ ТУЛБАР (над сплит-вью, во всю ширину workarea) ═══
       Три семантические группы:
         ИНСТРУМЕНТЫ (навигация/измерения) │ ЦВЕТ (режим раскраски) │ ВИД (тумблеры).
       Каждая группа имеет подпись и accent-полоску. Кнопки крупнее старых,
       с иконкой и подписью одновременно. Клики делегируются по id — хендлеры
       в bindEvents() совместимы со старыми кнопками.                         */
    const btn2 = (id, tip, label, svg) =>
      '<button class="t4-btn2" id="' + id + '" title="' + tip + '">' +
      (svg || '') + '<span>' + label + '</span>' +
      '<span class="t4-tip">' + tip + '</span></button>';
    const topTb = document.createElement('div');
    topTb.className = 't4-toptools';
    topTb.id = 't4-toptools';
    topTb.innerHTML =
      '<div class="t4-tgroup">' +
        btn2('t4-pointer2', 'Навигация (1) — клики и измерения на 2D; орбита/пан/зум на 3D. На 2D: колесо = зум к курсору, Shift+ЛКМ или средняя кнопка = пан, F или 2× клик мимо грани = вписать.', 'Навиг.',
          '<svg width="14" height="14" viewBox="0 0 18 18" fill="none"><path d="M3 2l10 7.5-4.2.8L6.3 15z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" fill="currentColor" fill-opacity="0.18"/></svg>') +
        btn2('t4-ruler2', 'Линейка 2 точки (3) — геодезическая длина между точками', 'Линейка',
          '<svg width="14" height="14" viewBox="0 0 18 18" fill="none"><path d="M3 15L15 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="3" cy="15" r="1.4" fill="currentColor" opacity="0.7"/><circle cx="15" cy="3" r="1.4" fill="currentColor" opacity="0.7"/></svg>') +
        btn2('t4-area2', 'Область — клики по точкам, 2× клик замкнуть. Площадь + периметр выделенной зоны.', 'Область',
          '<svg width="14" height="14" viewBox="0 0 18 18" fill="none"><path d="M4 4L14 4L15 10L10 15L3 13Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" fill="currentColor" fill-opacity="0.15"/></svg>') +
        // Лассо — измерительный инструмент по природе (свободное выделение
        // площади), стоит рядом с «Линейка / Область», а не у «Флап».
        btn2('t4-lasso2', 'Лассо (5) — свободное выделение фейсов: зажми ЛКМ и обведи область. Работает и на 2D, и в 3D-вью.', 'Лассо',
          '<svg width="14" height="14" viewBox="0 0 18 18" fill="none"><ellipse cx="9" cy="8" rx="6.2" ry="4.8" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2.2 1.8" fill="none"/><path d="M13 11c1 2 1.5 4 .5 5s-2 .5-2-1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/></svg>') +
        // Замер — клиническое измерение перфорации. Под капотом тот же
        // polygon-pipeline, но отчёт даёт max/min диаметр (Feret),
        // площадь, периметр, форму. Те же формулы, что у авто-детектора
        // перфораций, поэтому числа врача и алгоритма сопоставимы.
        btn2('t4-measure2', 'Замер (9) — клиническое измерение перфорации. Обведи край кликами, 2× клик или Enter завершит. Получишь max/min диаметр, площадь, периметр.', 'Замер',
          '<svg width="14" height="14" viewBox="0 0 18 18" fill="none"><ellipse cx="9" cy="9" rx="6" ry="4.5" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2 1.5" fill="none"/><line x1="3" y1="9" x2="15" y2="9" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/><circle cx="3" cy="9" r="1" fill="currentColor"/><circle cx="15" cy="9" r="1" fill="currentColor"/></svg>') +
        // Флап — итоговое действие (после того как врач промерил перфорацию).
        // Логично последним в группе инструментов.
        btn2('t4-flap2', 'Симуляция лоскута — выберите перфорацию, укажите параметры лоскута (размер, угол), система покажет площадь и запас.', 'Флап',
          '<svg width="14" height="14" viewBox="0 0 18 18" fill="none"><ellipse cx="9" cy="9" rx="6.2" ry="3.5" stroke="#00d0ff" stroke-width="1.6" fill="#00d0ff" fill-opacity="0.15" transform="rotate(-20 9 9)"/></svg>') +
        // === dev-only инструменты ===
        btn2('t4-polygon2', 'Полигон (2) — клики для вершин, 2× клик замкнуть', 'Полиг.',
          '<svg width="14" height="14" viewBox="0 0 18 18" fill="none"><path d="M4 4L14 4L15 10L10 15L3 13Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" fill="currentColor" fill-opacity="0.15"/><circle cx="4" cy="4" r="1.1" fill="currentColor"/><circle cx="14" cy="4" r="1.1" fill="currentColor"/><circle cx="15" cy="10" r="1.1" fill="currentColor"/><circle cx="10" cy="15" r="1.1" fill="currentColor"/><circle cx="3" cy="13" r="1.1" fill="currentColor"/></svg>') +
        btn2('t4-chain2', 'Цепочка точек (4)', 'Цепочка',
          '<svg width="14" height="14" viewBox="0 0 18 18" fill="none"><path d="M2 14L7 9L11 12L16 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="2" cy="14" r="1.2" fill="currentColor"/><circle cx="7" cy="9" r="1.2" fill="currentColor"/><circle cx="11" cy="12" r="1.2" fill="currentColor"/><circle cx="16" cy="4" r="1.2" fill="currentColor"/></svg>') +
        btn2('t4-inspect2', 'Inspect — метрики под курсором (6)', 'Inspect',
          '<svg width="14" height="14" viewBox="0 0 18 18" fill="none"><circle cx="8" cy="8" r="4.5" stroke="currentColor" stroke-width="1.5" fill="none"/><line x1="11.2" y1="11.2" x2="15.2" y2="15.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/></svg>') +
        btn2('t4-patch2', 'Залатать дырку (7)', 'Патч',
          '<svg width="14" height="14" viewBox="0 0 18 18" fill="none"><path d="M4 6 L9 3 L14 6 L14 12 L9 15 L4 12 Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" fill="none"/><circle cx="9" cy="9" r="2" fill="currentColor" opacity="0.9"/></svg>') +
      '</div>' +
      '<div class="t4-tgroup">' +
        btn2('t4-czones2', 'Раскраска по зонам (septum/floor/lateral)', 'Зоны',
          '<span class="t4-sw t4-sw-zones"></span>') +
        btn2('t4-crisk2',  'Риск измерения: зелёный &lt;5%, жёлтый 5-10%, красный ≥10% ошибки. В красных зонах не измерять.', 'Риск',
          '<span class="t4-sw t4-sw-risk"></span>') +
        // «Толщина» и «Риск-зоны» убраны — это были placeholder'ы для
        // будущих функций (требовали outer-surface из CT и атлас landmark'ов
        // соответственно). Кнопки висели нерабочими и сбивали с толку.
        // Вернутся, когда соответствующие данные появятся.
        btn2('t4-cL22',    'Раскраска L² stretch (сжатие/растяжение относительно 1.0)', 'L²',
          '<span class="t4-sw t4-sw-L2"></span>') +
        btn2('t4-ciso2',   'Раскраска iso-deviation (отклонение от изометрии)', 'Iso',
          '<span class="t4-sw t4-sw-iso"></span>') +
        btn2('t4-cring2',  'Раскраска близости к шву (переходу между зонами)', 'Шов',
          '<span class="t4-sw t4-sw-ring"></span>') +
      '</div>' +
      '<div class="t4-tgroup">' +
        btn2('t4-perf2',   'Видимость перфораций перегородки (красная обводка). Список — в правой панели.', 'Перфорация',
          '<svg width="14" height="14" viewBox="0 0 18 18" fill="none"><circle cx="9" cy="9" r="5" stroke="#d42a3c" stroke-width="1.8" fill="#d42a3c" fill-opacity="0.15"/></svg>') +
        btn2('t4-clear2', 'Очистить измерения (Esc)',                    'Очистить',
          '<svg width="14" height="14" viewBox="0 0 18 18" fill="none"><path d="M5 5l8 8M13 5l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>') +
        btn2('t4-charts2', 'Charts — развернуть каждую зону отдельно и сшить Procrustes. Edge-ошибка меньше на ~15%.', 'Charts',
          '<svg width="14" height="14" viewBox="0 0 18 18" fill="none"><path d="M3 4h5v5H3z M10 9h5v5h-5z" stroke="currentColor" stroke-width="1.4" fill="currentColor" fill-opacity="0.15"/></svg>') +
        btn2('t4-overlap2', 'Подсветка overlap-зон (O)',                  'Overlap',
          '<svg width="14" height="14" viewBox="0 0 18 18" fill="none"><circle cx="6.5" cy="9" r="4" stroke="currentColor" stroke-width="1.3" fill="currentColor" fill-opacity="0.18"/><circle cx="11.5" cy="9" r="4" stroke="currentColor" stroke-width="1.3" fill="currentColor" fill-opacity="0.18"/></svg>') +
      '</div>';
    // Вставляем над viewport (workarea = flex column → элементы-сестры)
    workarea.insertBefore(topTb, viewport);

    // === Пометка dev-only кнопок + placeholder-кнопок ===
    // CSS-правило body:not(.nasal-dev-mode) .t4-dev-only { display:none }
    // в начале IIFE скроет эти кнопки в клиническом режиме. Активация —
    // через ?dev=1 или localStorage.setItem('nasal.devMode','1').
    // ВАЖНО: 't4-lasso2' раньше был в этом списке и поэтому в клиническом
    // UI просто отсутствовал. Теперь лассо — официальный инструмент
    // выделения (работает и на 2D-развёртке, и в 3D-вью), поэтому
    // выведен из dev-only.
    const devOnlyIds = ['t4-polygon2','t4-chain2','t4-inspect2',
                        't4-patch2','t4-cL22','t4-ciso2','t4-cring2',
                        't4-charts2','t4-overlap2'];
    devOnlyIds.forEach(id => {
      const el = _$(id);
      if (el) el.classList.add('t4-dev-only');
    });
    // Placeholder для не-реализованных слоёв убран вместе с кнопками
    // 't4-cthick2' (Толщина) и 't4-crisk_zones2' (Риск-зоны) — они
    // ждали outer-surface из CT и атлас landmark'ов соответственно.
    // Когда данные появятся — кнопки и эта пометка вернутся.

    /* ═══ Язычок-переключатель левой панели. Клик → toggle .t4-focused.
       Виден всегда, пока на stage стоит .t4-built. Стрелка-иконка
       поворачивается через CSS в зависимости от состояния. ═══ */
    const reopen = document.createElement('button');
    reopen.type = 'button';
    reopen.className = 't4-reopen';
    reopen.id = 't4-reopen';
    reopen.title = 'Свернуть/развернуть панель подсказок';
    reopen.innerHTML =
      '<svg width="10" height="14" viewBox="0 0 10 14" fill="none">' +
        '<path d="M3 2l4 5-4 5" stroke="currentColor" stroke-width="1.5" ' +
          'stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>';
    reopen.addEventListener('click', () => {
      stage.classList.toggle('t4-focused');
      // Дадим CSS-transition доиграть, потом ресайзим канвасы
      setTimeout(() => {
        if (cache) {
          fit2D(); render2D();
          if (threeInited && ren3 && glCanvas) {
            const c = ren3.domElement;
            ren3.setSize(c.clientWidth, c.clientHeight, false);
            if (cam3) { cam3.aspect = c.clientWidth / Math.max(c.clientHeight, 1); cam3.updateProjectionMatrix(); }
          }
        }
      }, 300);
    });
    workarea.appendChild(reopen);

    /* ═══ Язычок-переключатель правой панели (зеркально левому).
       Клик → toggle .t4-focused-r. ═══ */
    const reopenR = document.createElement('button');
    reopenR.type = 'button';
    reopenR.className = 't4-reopen-r';
    reopenR.id = 't4-reopen-r';
    reopenR.title = 'Свернуть/развернуть панель метрик';
    reopenR.innerHTML =
      '<svg width="10" height="14" viewBox="0 0 10 14" fill="none">' +
        '<path d="M7 2l-4 5 4 5" stroke="currentColor" stroke-width="1.5" ' +
          'stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>';
    reopenR.addEventListener('click', () => {
      stage.classList.toggle('t4-focused-r');
      setTimeout(() => {
        if (cache) {
          fit2D(); render2D();
          if (threeInited && ren3 && glCanvas) {
            const c = ren3.domElement;
            ren3.setSize(c.clientWidth, c.clientHeight, false);
            if (cam3) { cam3.aspect = c.clientWidth / Math.max(c.clientHeight, 1); cam3.updateProjectionMatrix(); }
          }
        }
      }, 300);
    });
    workarea.appendChild(reopenR);

    /* ═══ СТАРЫЙ FLOATING ТУЛБАР (остаётся как legacy — на случай,
       если кто-то в коде ссылается на toolbarEl/id=t4-toolbar).
       В focused-режиме его скрывает правило #t4-toolbar{display:none}.  ═══ */
    const tb = document.createElement('div');
    tb.className = 't4-toolbar';
    tb.id = 't4-toolbar';
    tb.style.display = 'none';
    const btn = (id, tip, label, svg) =>
      '<button class="t4-btn" id="' + id + '" title="' + tip + '">' +
      (svg || '<span>' + label + '</span>') +
      '<span class="t4-tip">' + tip + '</span></button>';
    const sep = '<div class="t4-sep"></div>';
    tb.innerHTML =
      btn('t4-pointer',  'Навигация (1)', 'NAV',
          '<svg width="16" height="16" viewBox="0 0 18 18" fill="none"><path d="M3 2l10 7.5-4.2.8L6.3 15z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" fill="currentColor" fill-opacity="0.18"/></svg>') +
      btn('t4-polygon',  'Полигон (2)', 'POL',
          '<svg width="16" height="16" viewBox="0 0 18 18" fill="none"><path d="M4 4L14 4L15 10L10 15L3 13Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" fill="currentColor" fill-opacity="0.15"/><circle cx="4" cy="4" r="1.1" fill="currentColor"/><circle cx="14" cy="4" r="1.1" fill="currentColor"/><circle cx="15" cy="10" r="1.1" fill="currentColor"/><circle cx="10" cy="15" r="1.1" fill="currentColor"/><circle cx="3" cy="13" r="1.1" fill="currentColor"/></svg>') +
      btn('t4-ruler',    'Линейка 2 точки (3)', 'RUL',
          '<svg width="16" height="16" viewBox="0 0 18 18" fill="none"><path d="M3 15L15 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="3" cy="15" r="1.4" fill="currentColor" opacity="0.7"/><circle cx="15" cy="3" r="1.4" fill="currentColor" opacity="0.7"/></svg>') +
      btn('t4-chain',    'Цепочка (4)', 'CH',
          '<svg width="16" height="16" viewBox="0 0 18 18" fill="none"><path d="M2 14L7 9L11 12L16 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="2" cy="14" r="1.2" fill="currentColor"/><circle cx="7" cy="9" r="1.2" fill="currentColor"/><circle cx="11" cy="12" r="1.2" fill="currentColor"/><circle cx="16" cy="4" r="1.2" fill="currentColor"/></svg>') +
      btn('t4-lasso',    'Лассо (5)', 'LAS',
          '<svg width="16" height="16" viewBox="0 0 18 18" fill="none"><ellipse cx="9" cy="8" rx="6.2" ry="4.8" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2.2 1.8" fill="none"/><path d="M13 11c1 2 1.5 4 .5 5s-2 .5-2-1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/></svg>') +
      btn('t4-inspect',  'Inspect — метрики грани (6)', 'INS',
          '<svg width="16" height="16" viewBox="0 0 18 18" fill="none"><circle cx="8" cy="8" r="4.5" stroke="currentColor" stroke-width="1.5" fill="none"/><line x1="11.2" y1="11.2" x2="15.2" y2="15.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/></svg>') +
      btn('t4-patch',    'Залатать дырку (7) · клик внутри перфорации', 'PAT',
          '<svg width="16" height="16" viewBox="0 0 18 18" fill="none"><path d="M4 6 L9 3 L14 6 L14 12 L9 15 L4 12 Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" fill="none"/><path d="M9 3 L9 15 M4 6 L14 12 M14 6 L4 12" stroke="currentColor" stroke-width="0.8" opacity="0.55"/><circle cx="9" cy="9" r="2" fill="currentColor" opacity="0.9"/></svg>') +
      sep +
      btn('t4-czones',   'Цвет: зоны', 'ZN') +
      btn('t4-cL2',      'Цвет: L² stretch', 'L²') +
      btn('t4-ciso',     'Цвет: iso dev', 'ISO') +
      btn('t4-cring',    'Цвет: близость к шву', 'RNG') +
      btn('t4-crisk',    'Цвет: риск измерения (красный = не измерять)', 'RSK') +
      sep +
      btn('t4-charts',   'Режим charts — развернуть каждую зону отдельно + Procrustes-сшивка (M). Edge-ошибка меньше на ~15%, но на границах зон видны швы 0.2-0.5мм.', 'CH') +
      btn('t4-overlap',  'Overlap-зоны (O)', 'OV') +
      btn('t4-clear',    'Очистить измерения (Esc)', '✕');
    viewport.appendChild(tb);
    toolbarEl = tb;

    const mf = document.createElement('div');
    mf.className = 't4-measfloat';
    mf.id = 't4-measfloat';
    mf.style.display = 'none';
    mf.innerHTML = '<div class="t4-title" id="t4-mf-title">Измерение</div><div id="t4-mf-body"></div>';
    viewport.appendChild(mf);
    measFloatEl = mf;

    const right = stage.querySelector('.panel.right');
    if (right) {
      const card = right.querySelector('.card');
      if (card) {
        card.classList.add('t4-distcard');
        // Карточка должна быть relative для абсолютно позиционированной кнопки-закрытия.
        const cs = getComputedStyle(card);
        if (cs.position === 'static') card.style.position = 'relative';
        card.innerHTML = '<div class="card-title">Качество и анатомия</div>' +
          // Секция-легенда цвет-режима — над метриками, скрыта пока colorMode=zones.
          // Раньше то же содержимое показывалось плавающей карточкой поверх развёртки.
          '<div id="t4-legend-panel" class="t4-legend-panel" style="display:none"></div>' +
          '<div id="t4-distpanel"><div class="t4-hint">Нажмите «Построить развёртку».</div></div>';
        // Кнопка-закрытия в верхнем правом углу убрана: сворачивание/разворачивание
        // правой панели теперь делается через язычок .t4-reopen-r на правой кромке
        // (симметрично левой панели).
        distPanelEl   = card.querySelector('#t4-distpanel');
        legendPanelEl = card.querySelector('#t4-legend-panel');

        // ═══ ОТДЕЛЬНАЯ КАРТОЧКА для деталей выбранной перфорации.
        //     Раньше детали перфорации писались в ту же meas-card, что и
        //     активный инструмент → когда юзер измерял что-то линейкой,
        //     а потом кликал по перфорации в списке — измерение затиралось.
        //     Теперь это отдельная карточка t4-perf-card, она встаёт МЕЖДУ
        //     dist-card (где список перфораций) и meas-card (где работает
        //     инструмент). Логика та же: card-title и тело меняются через
        //     showPerfFloat, скрывается через hidePerfFloat. Видна только
        //     когда юзер выбрал конкретную перфорацию.
        const perfCard = document.createElement('div');
        perfCard.className = 'card t4-perf-card';
        perfCard.id = 't4-perf-card';
        perfCard.style.display = 'none';
        perfCard.innerHTML =
          '<div class="card-title" id="t4-perf-card-title">Перфорация</div>' +
          // Используем тот же класс t4-meas-panel что и meas-card: все CSS
          // правила для .t4-meas-body внутри (строки t4-row, t4-meas-subsection,
          // t4-meas-headline и т.д.) автоматически работают и здесь.
          '<div id="t4-perf-panel" class="t4-meas-panel"></div>';
        right.appendChild(perfCard);
        perfPanelEl = perfCard.querySelector('#t4-perf-panel');

        // ═══ ОТДЕЛЬНАЯ КАРТОЧКА для активного инструмента (линейка / область /
        //     лассо / inspect / замер / флап). Раньше .t4-meas-panel был
        //     ВНУТРИ .t4-distcard под метриками — теперь это самостоятельный
        //     .card как в левой панели. Card-title динамически меняется
        //     (Линейка / Замер диаметров / Лоскут и т.д.) из showMeasFloat.
        //     Карточка скрыта, пока инструмент не активен.
        const measCard = document.createElement('div');
        measCard.className = 'card t4-meas-card';
        measCard.id = 't4-meas-card';
        measCard.style.display = 'none';
        measCard.innerHTML =
          '<div class="card-title" id="t4-meas-card-title">Измерение</div>' +
          '<div id="t4-meas-panel" class="t4-meas-panel"></div>';
        right.appendChild(measCard);
        measPanelEl = measCard.querySelector('#t4-meas-panel');
      }
    }

    bindEvents();

    /* ═══ ResizeObserver — 2D зафиксирована, значит при любом
       изменении размеров её pane'а надо пересобрать fit (иначе она
       вылезет за края или окажется сжатой в углу). 3D-канвас тоже
       ресайзим тут, чтобы не плодить обсерверы. Следим за двумя
       pane'ами + viewport на случай, если кто-то меняет сам
       контейнер. Debounce не нужен — fit2D/render2D дешёвые.  ═══ */
    const paneUV = split.querySelector('#t4-uv');
    const pane3D = split.querySelector('#t4-3d');
    if (window.ResizeObserver && paneUV && pane3D) {
      const ro = new ResizeObserver(() => {
        if (!cache) return;
        // fit2D: ребилд scale/translate под новые размеры канваса.
        fit2D(); render2D();
        // 3D: только ресайз рендера — камеру не трогаем, орбита сохраняется.
        if (threeInited && ren3 && glCanvas) {
          const c = ren3.domElement;
          const W = c.clientWidth, H = c.clientHeight;
          if (W > 0 && H > 0) {
            ren3.setSize(W, H, false);
            if (cam3) { cam3.aspect = W / Math.max(H, 1); cam3.updateProjectionMatrix(); }
          }
        }
      });
      ro.observe(paneUV);
      ro.observe(pane3D);
    }

    domBuilt = true;
  }

  function bindEvents() {
    _$('t4-pointer').onclick  = () => setTool('pointer');
    _$('t4-polygon').onclick  = () => setTool('polygon');
    _$('t4-ruler').onclick    = () => setTool('ruler');
    _$('t4-chain').onclick    = () => setTool('rulerchain');
    _$('t4-lasso').onclick    = () => setTool('lasso');
    _$('t4-inspect').onclick  = () => setTool('inspect');
    _$('t4-patch').onclick    = () => setTool('patch');
    _$('t4-czones').onclick   = () => setColorMode('zones');
    _$('t4-cL2').onclick      = () => setColorMode('L2');
    _$('t4-ciso').onclick     = () => setColorMode('iso');
    _$('t4-cring').onclick    = () => setColorMode('ring');
    _$('t4-crisk').onclick    = () => setColorMode('risk');
    _$('t4-overlap').onclick  = toggleOverlap;
    _$('t4-charts').onclick   = () => toggleChartsMode();
    _$('t4-clear').onclick    = () => { clearMeasurementsState(); if (cache) { render2D(); render3DAnnotations(); } };

    /* ═══ Хендлеры нового top-toolbar (t4-*2) ═══
       Делегируем на те же функции — состояния (.active) синхронизируются
       в setTool/setColorMode/toggleOverlap/toggleChartsMode через общий
       refresh-хук syncToolbarState(), заменяющий прямое обращение к id. */
    const bindAlt = (id, fn) => { const b = _$(id); if (b) b.onclick = fn; };
    bindAlt('t4-pointer2', () => setTool('pointer'));
    bindAlt('t4-polygon2', () => setTool('polygon'));
    bindAlt('t4-ruler2',   () => setTool('ruler'));
    bindAlt('t4-chain2',   () => setTool('rulerchain'));
    bindAlt('t4-lasso2',   () => setTool('lasso'));
    bindAlt('t4-measure2', () => setTool('measure'));
    bindAlt('t4-inspect2', () => setTool('inspect'));
    bindAlt('t4-patch2',   () => setTool('patch'));
    bindAlt('t4-czones2',  () => setColorMode('zones'));
    bindAlt('t4-cL22',     () => setColorMode('L2'));
    bindAlt('t4-ciso2',    () => setColorMode('iso'));
    bindAlt('t4-cring2',   () => setColorMode('ring'));
    bindAlt('t4-crisk2',   () => setColorMode('risk'));
    bindAlt('t4-overlap2', toggleOverlap);
    bindAlt('t4-charts2',  () => toggleChartsMode());
    bindAlt('t4-perf2',    togglePerfVisibility);
    bindAlt('t4-clear2',   () => { clearMeasurementsState(); if (cache) { render2D(); render3DAnnotations(); } });
    // v5 клинические инструменты и слои
    bindAlt('t4-area2',        () => setTool('polygon'));   // alias для клинического UI
    // Флап — toggle: открыт ↔ закрыт. _flap == null означает «нет
    // активной симуляции», подсветка кнопки следует за этим состоянием.
    bindAlt('t4-flap2',        () => toggleFlapSimulator());
    // bindAlt для 't4-cthick2' и 't4-crisk_zones2' удалён — кнопки убраны
    // из тулбара (см. injectCSS / DOM-блок). Сами showPlaceholderInfo-обработчики
    // оставлены на случай возврата кнопок.

    uvCanvas.addEventListener('mousedown', uv_onMouseDown);
    uvCanvas.addEventListener('mousemove', uv_onMouseMove);
    uvCanvas.addEventListener('mouseup',   uv_onMouseUp);
    uvCanvas.addEventListener('mouseleave', uv_onMouseLeave);
    uvCanvas.addEventListener('dblclick',  uv_onDblClick);
    uvCanvas.addEventListener('wheel',     uv_onWheel, { passive: false });
    uvCanvas.addEventListener('contextmenu', e => e.preventDefault());

    glCanvas.addEventListener('mousedown', gl_onMouseDown);
    glCanvas.addEventListener('mousemove', gl_onMouseMove);
    glCanvas.addEventListener('mouseup',   gl_onMouseUp);
    glCanvas.addEventListener('mouseleave', gl_onMouseLeave);
    glCanvas.addEventListener('dblclick',   gl_onDblClick);
    glCanvas.addEventListener('wheel',     gl_onWheel, { passive: false });
    glCanvas.addEventListener('contextmenu', e => e.preventDefault());

    setupSplitter();
  }

  /* ═══ Draggable splitter ═══ */
  function setupSplitter() {
    const sp = _$('t4-splitter');
    const split = _$('t4-split');
    if (!sp || !split) return;
    const applyRatio = () => {
      const left = split.querySelector('#t4-3d');
      const right = split.querySelector('#t4-uv');
      if (!left || !right) return;
      left.style.flex  = splitRatio + ' 1 0';
      right.style.flex = (1 - splitRatio) + ' 1 0';
    };
    applyRatio();
    sp.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      splitterDragging = true;
      sp.classList.add('dragging');
      document.body.classList.add('t4-splitter-dragging');
    });
    document.addEventListener('mousemove', function (e) {
      if (!splitterDragging) return;
      const r = split.getBoundingClientRect();
      if (r.width < 20) return;
      let ratio = (e.clientX - r.left - 3) / (r.width - 6);
      ratio = Math.max(0.1, Math.min(0.9, ratio));
      splitRatio = ratio;
      applyRatio();
      // Немедленно репозиционируем содержимое
      if (cache) {
        fit2D(); render2D();
        if (threeInited && ren3) {
          const c = ren3.domElement;
          ren3.setSize(c.clientWidth, c.clientHeight, false);
          if (cam3) { cam3.aspect = c.clientWidth / Math.max(c.clientHeight, 1); cam3.updateProjectionMatrix(); }
        }
      }
    });
    document.addEventListener('mouseup', function () {
      if (!splitterDragging) return;
      splitterDragging = false;
      sp.classList.remove('dragging');
      document.body.classList.remove('t4-splitter-dragging');
    });
    // Double-click на сплиттер — сбросить к 50/50.
    sp.addEventListener('dblclick', function () {
      splitRatio = 0.5; applyRatio();
      if (cache) {
        fit2D(); render2D();
        if (threeInited && ren3) {
          const c = ren3.domElement;
          ren3.setSize(c.clientWidth, c.clientHeight, false);
          if (cam3) { cam3.aspect = c.clientWidth / Math.max(c.clientHeight, 1); cam3.updateProjectionMatrix(); }
        }
      }
    });
  }

  /* ═══ ГЕОМЕТРИЯ И UV ═══ */
  function buildVertexAdj() {
    const M = window.M;
    const V = M.V, F = M.F, nV = M.nV, nF = M.nF;
    const adj = new Array(nV);
    for (let i = 0; i < nV; i++) adj[i] = [];
    const seen = new Set();
    for (let fi = 0; fi < nF; fi++) for (let j = 0; j < 3; j++) {
      let a = F[fi * 3 + j], b = F[fi * 3 + (j + 1) % 3];
      const k = a < b ? a * 1048576 + b : b * 1048576 + a;
      if (seen.has(k)) continue; seen.add(k);
      const dx = V[a * 3] - V[b * 3], dy = V[a * 3 + 1] - V[b * 3 + 1], dz = V[a * 3 + 2] - V[b * 3 + 2];
      const w = Math.sqrt(dx * dx + dy * dy + dz * dz);
      adj[a].push([b, w]); adj[b].push([a, w]);
    }
    return adj;
  }

  function buildFaceAdj() {
    const M = window.M;
    const F = M.F, nF = M.nF;
    const edge2face = new Map();
    for (let fi = 0; fi < nF; fi++) for (let j = 0; j < 3; j++) {
      let a = F[fi * 3 + j], b = F[fi * 3 + (j + 1) % 3];
      const k = a < b ? a * 1048576 + b : b * 1048576 + a;
      if (!edge2face.has(k)) edge2face.set(k, []);
      edge2face.get(k).push(fi);
    }
    const adj = new Array(nF); for (let i = 0; i < nF; i++) adj[i] = [];
    for (const fs of edge2face.values()) {
      if (fs.length === 2) { adj[fs[0]].push(fs[1]); adj[fs[1]].push(fs[0]); }
    }
    return adj;
  }

  function computeFaceGeom() {
    const M = window.M; const V = M.V, F = M.F, nF = M.nF;
    const fn = new Float64Array(nF * 3), fa = new Float64Array(nF), fc = new Float64Array(nF * 3);
    for (let fi = 0; fi < nF; fi++) {
      const i0 = F[fi * 3], i1 = F[fi * 3 + 1], i2 = F[fi * 3 + 2];
      const ax = V[i0 * 3], ay = V[i0 * 3 + 1], az = V[i0 * 3 + 2];
      const bx = V[i1 * 3], by = V[i1 * 3 + 1], bz = V[i1 * 3 + 2];
      const cx = V[i2 * 3], cy = V[i2 * 3 + 1], cz = V[i2 * 3 + 2];
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      const ln = Math.max(Math.sqrt(nx * nx + ny * ny + nz * nz), 1e-15);
      fn[fi * 3] = nx / ln; fn[fi * 3 + 1] = ny / ln; fn[fi * 3 + 2] = nz / ln;
      fa[fi] = ln * 0.5;
      fc[fi * 3] = (ax + bx + cx) / 3; fc[fi * 3 + 1] = (ay + by + cy) / 3; fc[fi * 3 + 2] = (az + bz + cz) / 3;
    }
    cache._fn = fn; cache._fa = fa; cache._fc = fc;
    cache.face_area = fa;
  }

  function estimateAxes() {
    const M = window.M;
    const V = M.V, fa = cache._fa, fn = cache._fn, fc = cache._fc, nF = M.nF, nV = M.nV;
    let mnx = 1e30, mny = 1e30, mnz = 1e30, mxx = -1e30, mxy = -1e30, mxz = -1e30;
    for (let i = 0; i < nV; i++) {
      const x = V[i * 3], y = V[i * 3 + 1], z = V[i * 3 + 2];
      if (x < mnx) mnx = x; if (y < mny) mny = y; if (z < mnz) mnz = z;
      if (x > mxx) mxx = x; if (y > mxy) mxy = y; if (z > mxz) mxz = z;
    }
    const bb = [mxx - mnx, mxy - mny, mxz - mnz];
    const mn = [mnx, mny, mnz], mx = [mxx, mxy, mxz];
    const idx = [0, 1, 2]; idx.sort((a, b) => bb[a] - bb[b]);
    const lr = idx[0], si = idx[1], ap = idx[2];
    const sm = (mn[si] + mx[si]) / 2;
    let wL = 0, hL = 0, wH = 0, hH = 0;
    for (let fi = 0; fi < nF; fi++) {
      const below = fc[fi * 3 + si] < sm;
      const ha = Math.abs(fn[fi * 3 + si]);
      if (below) { wL += fa[fi]; hL += ha * fa[fi]; }
      else { wH += fa[fi]; hH += ha * fa[fi]; }
    }
    wL = wL || 1e-9; wH = wH || 1e-9;
    const lm = (mn[lr] + mx[lr]) / 2;
    let aL = 0, aH = 0;
    for (let fi = 0; fi < nF; fi++) { if (fc[fi * 3 + lr] < lm) aL += fa[fi]; else aH += fa[fi]; }
    return { lr, si, ap, lr_sign: aL >= aH ? 1 : -1, si_sign: (hL / wL >= hH / wH) ? 1 : -1, mn, mx, bb };
  }

  function vertexLabels() {
    const M = window.M; const nV = M.nV, nF = M.nF, F = M.F; const lb = M.zoneLabels;
    const cnt = new Int32Array(nV * 3);
    for (let fi = 0; fi < nF; fi++) { const l = lb[fi]; for (let j = 0; j < 3; j++) cnt[F[fi * 3 + j] * 3 + l]++; }
    const vl = new Int32Array(nV);
    for (let i = 0; i < nV; i++) {
      let m = cnt[i * 3], mi = 0;
      if (cnt[i * 3 + 1] > m) { m = cnt[i * 3 + 1]; mi = 1; }
      if (cnt[i * 3 + 2] > m) mi = 2;
      vl[i] = mi;
    }
    return vl;
  }

  function computeGeodesicUV() {
    const M = window.M;
    const V = M.V, F = M.F, nF = M.nF, nV = M.nV;
    const axes = cache.axes;
    const lr = axes.lr, si = axes.si, ap = axes.ap, lr_sign = axes.lr_sign, mn = axes.mn, mx = axes.mx;
    const lr_r = Math.max(mx[lr] - mn[lr], 1e-9);
    const ap_r = Math.max(mx[ap] - mn[ap], 1e-9);

    const vl = vertexLabels();
    let cm_abs = 1e30, cl_abs = -1e30;
    for (let i = 0; i < nV; i++) {
      if (vl[i] !== 1) continue;
      let l = (V[i * 3 + lr] - mn[lr]) / lr_r;
      if (lr_sign < 0) l = 1 - l;
      if (l < cm_abs) cm_abs = l;
      if (l > cl_abs) cl_abs = l;
    }
    if (!isFinite(cm_abs)) { cm_abs = 0.3; cl_abs = 0.7; }
    const fw = (cl_abs - cm_abs) * lr_r;
    cache.fw = fw; cache.cm = cm_abs; cache.cl = cl_abs;
    cache.vertex_labels = vl;

    const fb = new Set(); const seen2 = new Set();
    for (let fi = 0; fi < nF; fi++) for (let j = 0; j < 3; j++) {
      const a = F[fi * 3 + j], b = F[fi * 3 + (j + 1) % 3];
      const k = a < b ? a * 1048576 + b : b * 1048576 + a;
      if (seen2.has(k)) continue; seen2.add(k);
      if (vl[a] === 1 && vl[b] !== 1) fb.add(a);
      if (vl[b] === 1 && vl[a] !== 1) fb.add(b);
    }
    if (fb.size === 0) for (let i = 0; i < nV; i++) if (vl[i] === 1) fb.add(i);

    const vAdj = cache.vAdj;
    const geo = new Float64Array(nV); geo.fill(1e18);
    const pq = [];
    const push = (d, v) => { pq.push([d, v]); let i = pq.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (pq[p][0] <= pq[i][0]) break; [pq[p], pq[i]] = [pq[i], pq[p]]; i = p; } };
    const pop = () => { const t = pq[0], l = pq.pop(); if (pq.length > 0) { pq[0] = l; let i = 0; for (;;) { let s = i, le = 2 * i + 1, r = 2 * i + 2; if (le < pq.length && pq[le][0] < pq[s][0]) s = le; if (r < pq.length && pq[r][0] < pq[s][0]) s = r; if (s === i) break; [pq[i], pq[s]] = [pq[s], pq[i]]; i = s; } } return t; };
    for (const vi of fb) { geo[vi] = 0; push(0, vi); }
    while (pq.length > 0) {
      const [du, u] = pop(); if (du > geo[u]) continue;
      for (const [nb, w] of vAdj[u]) {
        if (vl[nb] === 1) continue;
        const nd = du + w;
        if (nd < geo[nb]) { geo[nb] = nd; push(nd, nb); }
      }
    }

    const uv = new Float64Array(nV * 2);
    for (let vi = 0; vi < nV; vi++) {
      const ap_raw = (V[vi * 3 + ap] - mn[ap]) / ap_r;
      let lr_raw = (V[vi * 3 + lr] - mn[lr]) / lr_r;
      if (lr_sign < 0) lr_raw = 1 - lr_raw;
      const x = ap_raw * ap_r;
      if (vl[vi] === 1) {
        uv[vi * 2] = x;
        uv[vi * 2 + 1] = Math.max(0, Math.min(1, (lr_raw - cm_abs) / Math.max(cl_abs - cm_abs, 1e-9))) * fw;
      } else if (vl[vi] === 0) {
        uv[vi * 2] = x;
        uv[vi * 2 + 1] = -Math.min(geo[vi], 200);
      } else {
        uv[vi * 2] = x;
        uv[vi * 2 + 1] = fw + Math.min(geo[vi], 200);
      }
    }

    const vld = new Uint8Array(nF);
    for (let fi = 0; fi < nF; fi++) {
      const i0 = F[fi * 3], i1 = F[fi * 3 + 1], i2 = F[fi * 3 + 2];
      const y0 = uv[i0 * 2 + 1], y1 = uv[i1 * 2 + 1], y2 = uv[i2 * 2 + 1];
      const ymn = Math.min(y0, y1, y2), ymx = Math.max(y0, y1, y2);
      if (ymn < -0.5 && ymx > fw + 0.5) continue;
      if (ymx - ymn > fw * 1.5) continue;
      const ax2 = V[i0 * 3], ay2 = V[i0 * 3 + 1], az2 = V[i0 * 3 + 2];
      const bx2 = V[i1 * 3], by2 = V[i1 * 3 + 1], bz2 = V[i1 * 3 + 2];
      const cx2 = V[i2 * 3], cy2 = V[i2 * 3 + 1], cz2 = V[i2 * 3 + 2];
      const ex = bx2 - ax2, ey = by2 - ay2, ez = bz2 - az2;
      const fx = cx2 - ax2, fy = cy2 - ay2, fz = cz2 - az2;
      const nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx;
      const a3 = Math.sqrt(nx * nx + ny * ny + nz * nz) * 0.5;
      if (a3 < 1e-12) continue;
      const a2 = Math.abs(0.5 * ((uv[i1 * 2] - uv[i0 * 2]) * (y2 - y0) - (uv[i2 * 2] - uv[i0 * 2]) * (y1 - y0)));
      if (a2 < 1e-12) continue;
      const r = a2 / a3;
      if (r >= 0.05 && r <= 5) vld[fi] = 1;
    }
    cache.uv = uv;
    cache.valid = vld;
  }

  function computeDistortion() {
    const M = window.M; const F = M.F, nF = M.nF;
    const uv = cache.uv, valid = cache.valid, fa = cache.face_area;
    const dist = new Float64Array(nF);
    for (let fi = 0; fi < nF; fi++) {
      if (!valid[fi]) { dist[fi] = NaN; continue; }
      const i0 = F[fi * 3], i1 = F[fi * 3 + 1], i2 = F[fi * 3 + 2];
      const a2 = Math.abs(0.5 * ((uv[i1 * 2] - uv[i0 * 2]) * (uv[i2 * 2 + 1] - uv[i0 * 2 + 1]) - (uv[i2 * 2] - uv[i0 * 2]) * (uv[i1 * 2 + 1] - uv[i0 * 2 + 1])));
      dist[fi] = a2 / Math.max(fa[fi], 1e-15);
    }
    cache.distortion = dist;
  }

  function computeJacobianMetrics() {
    const M = window.M; const V = M.V, F = M.F, nF = M.nF;
    const uv = cache.uv, valid = cache.valid;
    const s1 = new Float64Array(nF), s2 = new Float64Array(nF);
    const L2 = new Float64Array(nF), iso = new Float64Array(nF);
    for (let fi = 0; fi < nF; fi++) {
      if (!valid[fi]) { s1[fi] = NaN; s2[fi] = NaN; L2[fi] = NaN; iso[fi] = NaN; continue; }
      const i0 = F[fi * 3], i1 = F[fi * 3 + 1], i2 = F[fi * 3 + 2];
      const ax = V[i0 * 3], ay = V[i0 * 3 + 1], az = V[i0 * 3 + 2];
      const bx = V[i1 * 3], by = V[i1 * 3 + 1], bz = V[i1 * 3 + 2];
      const cx = V[i2 * 3], cy = V[i2 * 3 + 1], cz = V[i2 * 3 + 2];
      const e12x = bx - ax, e12y = by - ay, e12z = bz - az;
      const L12 = Math.sqrt(e12x * e12x + e12y * e12y + e12z * e12z);
      if (L12 < 1e-15) { s1[fi] = NaN; s2[fi] = NaN; L2[fi] = NaN; iso[fi] = NaN; continue; }
      const hx = e12x / L12, hy = e12y / L12, hz = e12z / L12;
      const e13x = cx - ax, e13y = cy - ay, e13z = cz - az;
      const x3 = e13x * hx + e13y * hy + e13z * hz;
      const e13sq = e13x * e13x + e13y * e13y + e13z * e13z;
      const y3 = Math.sqrt(Math.max(0, e13sq - x3 * x3));
      if (y3 < 1e-15) { s1[fi] = NaN; s2[fi] = NaN; L2[fi] = NaN; iso[fi] = NaN; continue; }
      const u0 = uv[i0 * 2], v0 = uv[i0 * 2 + 1];
      const u1 = uv[i1 * 2], v1 = uv[i1 * 2 + 1];
      const u2 = uv[i2 * 2], v2 = uv[i2 * 2 + 1];
      const du1 = u1 - u0, dv1 = v1 - v0;
      const du2 = u2 - u0, dv2 = v2 - v0;
      const J00 = du1 / L12, J10 = dv1 / L12;
      const J01 = (du2 - du1 * x3 / L12) / y3;
      const J11 = (dv2 - dv1 * x3 / L12) / y3;
      const a = J00 * J00 + J10 * J10;
      const b = J00 * J01 + J10 * J11;
      const c = J01 * J01 + J11 * J11;
      const tr = a + c, det = a * c - b * b;
      const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
      const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
      const S1 = Math.sqrt(Math.max(l1, 0));
      const S2 = Math.sqrt(Math.max(l2, 0));
      s1[fi] = S1; s2[fi] = S2;
      L2[fi] = Math.sqrt((S1 * S1 + S2 * S2) / 2);
      iso[fi] = Math.max(S1, 1 / Math.max(S2, 1e-12));
    }
    cache.sigma1 = s1; cache.sigma2 = s2; cache.L2 = L2; cache.iso = iso;
  }

  function computeSeamRings() {
    const M = window.M; const F = M.F, nF = M.nF, nV = M.nV;
    const labels = M.zoneLabels, faceAdj = cache.faceAdj, vAdj = cache.vAdj;
    const seamEdges = []; const seenE = new Set(); const seamV = new Set();
    for (let fi = 0; fi < nF; fi++) {
      const la = labels[fi];
      for (const fj of faceAdj[fi]) {
        if (fj < fi) continue;
        const lb2 = labels[fj]; if (la === lb2) continue;
        const t1 = [F[fi * 3], F[fi * 3 + 1], F[fi * 3 + 2]];
        const t2set = new Set([F[fj * 3], F[fj * 3 + 1], F[fj * 3 + 2]]);
        const shared = t1.filter(v => t2set.has(v));
        if (shared.length !== 2) continue;
        const [a, b] = shared.sort((x, y) => x - y);
        const k = a * 1048576 + b;
        if (seenE.has(k)) continue; seenE.add(k);
        seamEdges.push([a, b, Math.min(la, lb2), Math.max(la, lb2)]);
        seamV.add(a); seamV.add(b);
      }
    }
    cache.seam_edges = seamEdges;

    const vRing = new Int32Array(nV); for (let i = 0; i < nV; i++) vRing[i] = 2147483647;
    const q = []; for (const v of seamV) { vRing[v] = 0; q.push(v); }
    let qi = 0;
    while (qi < q.length) {
      const u = q[qi++];
      for (const pair of vAdj[u]) {
        const nb = pair[0];
        if (vRing[nb] > vRing[u] + 1) { vRing[nb] = vRing[u] + 1; q.push(nb); }
      }
    }
    const fRing = new Int32Array(nF);
    for (let fi = 0; fi < nF; fi++) {
      const r0 = vRing[F[fi * 3]], r1 = vRing[F[fi * 3 + 1]], r2 = vRing[F[fi * 3 + 2]];
      fRing[fi] = Math.min(r0, r1, r2);
    }
    cache.face_seam_ring = fRing;
    cache.vertex_seam_ring = vRing;
  }

  function computeGlobalMetricsSummary() {
    const M = window.M; const nF = M.nF, V = M.V;
    const valid = cache.valid, labels = M.zoneLabels, fa = cache.face_area;
    const L2 = cache.L2, iso = cache.iso, uv = cache.uv;
    const seam = cache.seam_edges, ring = cache.face_seam_ring;

    const pct = (arr, p) => { if (!arr.length) return NaN; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
    const mean = a => a.reduce((s, v) => s + v, 0) / Math.max(a.length, 1);

    const L2v = [], isov = [];
    for (let fi = 0; fi < nF; fi++) {
      if (!valid[fi]) continue;
      if (!isNaN(L2[fi])) L2v.push(L2[fi]);
      if (!isNaN(iso[fi])) isov.push(iso[fi]);
    }
    const global = {
      L2_mean: mean(L2v), L2_p95: pct(L2v, 0.95), L2_p99: pct(L2v, 0.99),
      L2_max: L2v.length ? Math.max.apply(null, L2v) : NaN,
      iso_mean: mean(isov), iso_p95: pct(isov, 0.95),
      iso_max: isov.length ? Math.max.apply(null, isov) : NaN,
      nFacesValid: L2v.length
    };
    const perZone = {};
    for (let z = 0; z < 3; z++) {
      const arr = [], isoz = []; let area = 0;
      for (let fi = 0; fi < nF; fi++) {
        if (!valid[fi] || labels[fi] !== z) continue;
        if (!isNaN(L2[fi])) arr.push(L2[fi]);
        if (!isNaN(iso[fi])) isoz.push(iso[fi]);
        area += fa[fi];
      }
      perZone[z] = { n: arr.length, area, L2_mean: mean(arr), L2_p95: pct(arr, 0.95), iso_p95: pct(isoz, 0.95) };
    }
    let seamErrs = [];
    if (seam) {
      for (const [a, b] of seam) {
        const dx = V[a * 3] - V[b * 3], dy = V[a * 3 + 1] - V[b * 3 + 1], dz = V[a * 3 + 2] - V[b * 3 + 2];
        const L3 = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const du = uv[a * 2] - uv[b * 2], dv = uv[a * 2 + 1] - uv[b * 2 + 1];
        const L2e = Math.sqrt(du * du + dv * dv);
        if (L3 > 1e-9) seamErrs.push(Math.abs(L2e / L3 - 1));
      }
    }
    const seamStats = {
      nSeamEdges: seam ? seam.length : 0,
      mean_err: mean(seamErrs), p95_err: pct(seamErrs, 0.95),
      max_err: seamErrs.length ? Math.max.apply(null, seamErrs) : 0,
      overThreshold: seamErrs.filter(e => e > 0.05).length
    };
    const ringStats = {};
    for (const r of [0, 1, 2, 3, 5]) {
      const arr = [];
      for (let fi = 0; fi < nF; fi++) { if (!valid[fi] || ring[fi] !== r) continue; if (!isNaN(L2[fi])) arr.push(L2[fi]); }
      ringStats[r] = { n: arr.length, L2_mean: mean(arr), L2_p95: pct(arr, 0.95) };
    }
    cache.metricsSummary = { global, perZone, seamStats, ringStats };
  }

  function computeOverlapMap() {
    const M = window.M; const F = M.F, nF = M.nF;
    const uv = cache.uv, valid = cache.valid;
    const ppm = 2.0, margin = 2;
    let u_min = 1e30, v_min = 1e30, u_max = -1e30, v_max = -1e30;
    for (let fi = 0; fi < nF; fi++) {
      if (!valid[fi]) continue;
      for (let j = 0; j < 3; j++) {
        const vi = F[fi * 3 + j]; const u = uv[vi * 2], v = uv[vi * 2 + 1];
        if (u < u_min) u_min = u; if (v < v_min) v_min = v;
        if (u > u_max) u_max = u; if (v > v_max) v_max = v;
      }
    }
    u_min -= margin; v_min -= margin; u_max += margin; v_max += margin;
    const W = Math.ceil((u_max - u_min) * ppm);
    const H = Math.ceil((v_max - v_min) * ppm);
    const count = new Uint8Array(W * H);
    const overlapFace = new Uint8Array(nF);
    for (let fi = 0; fi < nF; fi++) {
      if (!valid[fi]) continue;
      const i0 = F[fi * 3], i1 = F[fi * 3 + 1], i2 = F[fi * 3 + 2];
      const u0 = uv[i0 * 2], v0 = uv[i0 * 2 + 1];
      const u1 = uv[i1 * 2], v1 = uv[i1 * 2 + 1];
      const u2 = uv[i2 * 2], v2 = uv[i2 * 2 + 1];
      const ulo = Math.max(0, Math.floor((Math.min(u0, u1, u2) - u_min) * ppm));
      const uhi = Math.min(W, Math.ceil((Math.max(u0, u1, u2) - u_min) * ppm) + 1);
      const vlo = Math.max(0, Math.floor((Math.min(v0, v1, v2) - v_min) * ppm));
      const vhi = Math.min(H, Math.ceil((Math.max(v0, v1, v2) - v_min) * ppm) + 1);
      if (uhi <= ulo || vhi <= vlo) continue;
      const e1u = u1 - u0, e1v = v1 - v0, e2u = u2 - u0, e2v = v2 - v0;
      const d00 = e1u * e1u + e1v * e1v, d01 = e1u * e2u + e1v * e2v, d11 = e2u * e2u + e2v * e2v;
      const denom = d00 * d11 - d01 * d01;
      if (Math.abs(denom) < 1e-20) continue;
      for (let py = vlo; py < vhi; py++) {
        const vy = v_min + (py + 0.5) / ppm;
        for (let px = ulo; px < uhi; px++) {
          const vx = u_min + (px + 0.5) / ppm;
          const qu = vx - u0, qv = vy - v0;
          const dp0 = qu * e1u + qv * e1v, dp1 = qu * e2u + qv * e2v;
          const a = (d11 * dp0 - d01 * dp1) / denom;
          const b = (d00 * dp1 - d01 * dp0) / denom;
          if (a >= 0 && b >= 0 && a + b <= 1) count[py * W + px]++;
        }
      }
    }
    const overlap = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) overlap[i] = count[i] > 1 ? 1 : 0;
    for (let fi = 0; fi < nF; fi++) {
      if (!valid[fi]) continue;
      const i0 = F[fi * 3], i1 = F[fi * 3 + 1], i2 = F[fi * 3 + 2];
      const u0 = uv[i0 * 2], v0 = uv[i0 * 2 + 1];
      const u1 = uv[i1 * 2], v1 = uv[i1 * 2 + 1];
      const u2 = uv[i2 * 2], v2 = uv[i2 * 2 + 1];
      const ulo = Math.max(0, Math.floor((Math.min(u0, u1, u2) - u_min) * ppm));
      const uhi = Math.min(W, Math.ceil((Math.max(u0, u1, u2) - u_min) * ppm) + 1);
      const vlo = Math.max(0, Math.floor((Math.min(v0, v1, v2) - v_min) * ppm));
      const vhi = Math.min(H, Math.ceil((Math.max(v0, v1, v2) - v_min) * ppm) + 1);
      if (uhi <= ulo || vhi <= vlo) continue;
      let found = false;
      for (let py = vlo; py < vhi && !found; py++) {
        for (let px = ulo; px < uhi; px++) {
          if (overlap[py * W + px]) { overlapFace[fi] = 1; found = true; break; }
        }
      }
    }
    cache.overlapMap = overlapFace;
  }

  function dijkstraPath(src, dst) {
    const nV = window.M.nV;
    const vAdj = cache.vAdj;
    const dist = new Float64Array(nV); dist.fill(1e18);
    const prev = new Int32Array(nV).fill(-1);
    const pq = [];
    const push = (d, v) => { pq.push([d, v]); let i = pq.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (pq[p][0] <= pq[i][0]) break; [pq[p], pq[i]] = [pq[i], pq[p]]; i = p; } };
    const pop = () => { const t = pq[0], l = pq.pop(); if (pq.length > 0) { pq[0] = l; let i = 0; for (;;) { let s = i, le = 2 * i + 1, r = 2 * i + 2; if (le < pq.length && pq[le][0] < pq[s][0]) s = le; if (r < pq.length && pq[r][0] < pq[s][0]) s = r; if (s === i) break; [pq[i], pq[s]] = [pq[s], pq[i]]; i = s; } } return t; };
    dist[src] = 0; push(0, src);
    while (pq.length > 0) {
      const [du, u] = pop(); if (u === dst) break; if (du > dist[u]) continue;
      for (const [nb, w] of vAdj[u]) { const nd = du + w; if (nd < dist[nb]) { dist[nb] = nd; prev[nb] = u; push(nd, nb); } }
    }
    if (dist[dst] >= 1e17) return { path: [], dist: 0 };
    const path = []; let c = dst; while (c !== -1) { path.push(c); c = prev[c]; } path.reverse();
    return { path, dist: dist[dst] };
  }

  /* ═══════════════════════════════════════════════════════════ HOLE PATCH ═══
     Залатывание дырок в UV/3D-меше:
       1) findBoundaryLoops() — находит все замкнутые петли граничных рёбер
          валидной области (включая внешний периметр + перфорации).
       2) findHoleUnderPoint(ux,uy) — возвращает внутреннюю петлю, внутри
          которой лежит точка (наименьшая по площади из содержащих).
          Внешний периметр автоматически исключается (он всегда больше).
       3) patchHole(loop) — добавляет 1 новую вершину в 3D-центроиде +
          fan-триангуляцию к ней. Расширяет cache.V/F/uv/zoneLabels и все
          per-face/per-vertex массивы. window.M не трогается.
       4) undoLastPatch() — откатывает последнее залатывание.

     Наблюдения:
       • cache.valid маркирует грани, попавшие в UV. Петлю строим только
         по рёбрам валидных граней.
       • Зона заплатки = majority из зон соседних граничных граней.
       • Синтетические заплатки не участвуют в метриках искажения: их
         σ₁/σ₂/L²/iso остаются NaN, face_seam_ring = 99 (далеко от швов).
     ═══════════════════════════════════════════════════════════════════ */

  function findBoundaryLoops() {
    if (!cache) return [];
    const F = cache.F, nF = cache.nF, valid = cache.valid;
    // 1. Подсчёт рёбер (только по валидным граням).
    const ec = new Map();
    for (let fi = 0; fi < nF; fi++) {
      if (!valid[fi]) continue;
      for (let j = 0; j < 3; j++) {
        const a = F[fi * 3 + j], b = F[fi * 3 + (j + 1) % 3];
        const k = a < b ? a * 1048576 + b : b * 1048576 + a;
        ec.set(k, (ec.get(k) || 0) + 1);
      }
    }
    // 2. Boundary edges → adjacency map (vid → [neighbor vids]).
    const adj = new Map();
    for (const [k, cnt] of ec) {
      if (cnt !== 1) continue;
      const a = Math.floor(k / 1048576), b = k % 1048576;
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a).push(b);
      adj.get(b).push(a);
    }
    // 3. Walk loops.
    const loops = [];
    const visited = new Set();
    for (const start of adj.keys()) {
      if (visited.has(start)) continue;
      const loop = [start]; visited.add(start);
      let cur = start, prev = -1;
      while (true) {
        const nbrs = adj.get(cur);
        if (!nbrs) break;
        // Берём не-предыдущего соседа.
        let next = -1;
        for (const n of nbrs) { if (n !== prev) { next = n; break; } }
        if (next === -1 || next === start) break;
        if (visited.has(next)) break; // защита от зависаний на не-манифолдных участках
        loop.push(next); visited.add(next);
        prev = cur; cur = next;
      }
      if (loop.length >= 3) loops.push(loop);
    }
    return loops;
  }

  function _loopUVPolyAndArea(loop) {
    const uv = cache.uv;
    const pts = [];
    for (const vi of loop) pts.push({ u: uv[vi * 2], v: uv[vi * 2 + 1] });
    // Signed area (Gauss / shoelace).
    let sa = 0;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      sa += pts[i].u * pts[j].v - pts[j].u * pts[i].v;
    }
    sa *= 0.5;
    return { pts, absArea: Math.abs(sa), signedArea: sa };
  }

  function findHoleUnderPoint(ux, uy) {
    const loops = findBoundaryLoops();
    if (loops.length === 0) return null;
    const candidates = [];
    for (const loop of loops) {
      const info = _loopUVPolyAndArea(loop);
      if (pointInPolygonUV(ux, uy, info.pts)) {
        candidates.push({ loop, ...info });
      }
    }
    if (candidates.length < 2) return null; // только внешний (1) или клик вне меша (0)
    // Берём наименьшую по абс. площади из содержащих — это внутренняя дырка.
    candidates.sort((a, b) => a.absArea - b.absArea);
    return candidates[0];
  }

  /* Расширение typed-arrays новыми данными (возвращает новый массив). */
  function _extendArray(oldArr, oldLen, newLen, fillValue, TypedCtor) {
    const Ctor = TypedCtor || (oldArr ? oldArr.constructor : Float64Array);
    const out = new Ctor(newLen);
    if (oldArr) out.set(oldArr.subarray ? oldArr.subarray(0, oldLen) : oldArr.slice(0, oldLen));
    if (fillValue !== undefined && fillValue !== 0) {
      for (let i = oldLen; i < newLen; i++) out[i] = fillValue;
    }
    return out;
  }

  function patchHole(hole) {
    if (!cache || !hole || !hole.loop) return null;
    const loop = hole.loop;
    const N = loop.length;
    if (N < 3) return null;

    const oldNV = cache.nV, oldNF = cache.nF;

    // --- Центроиды в 3D и UV ---
    let cx3 = 0, cy3 = 0, cz3 = 0, cu = 0, cv = 0;
    const V0 = cache.V, uv0 = cache.uv;
    for (const vi of loop) {
      cx3 += V0[vi * 3];    cy3 += V0[vi * 3 + 1]; cz3 += V0[vi * 3 + 2];
      cu  += uv0[vi * 2];   cv  += uv0[vi * 2 + 1];
    }
    cx3 /= N; cy3 /= N; cz3 /= N; cu /= N; cv /= N;

    // --- Определяем зону заплатки: majority соседних граней ---
    const boundarySet = new Set(loop);
    const zCount = [0, 0, 0];
    const F0 = cache.F, zl0 = cache.zoneLabels;
    for (let fi = 0; fi < oldNF; fi++) {
      if (!cache.valid[fi]) continue;
      let touch = 0;
      for (let j = 0; j < 3; j++) if (boundarySet.has(F0[fi * 3 + j])) { touch++; break; }
      if (touch) zCount[zl0[fi]]++;
    }
    let patchZone = 0, maxZ = zCount[0];
    if (zCount[1] > maxZ) { patchZone = 1; maxZ = zCount[1]; }
    if (zCount[2] > maxZ) { patchZone = 2; }

    // --- Направление обхода петли (для правильной ориентации) ---
    // Берём одно граничное ребро (loop[0]-loop[1]), находим adjacent face,
    // смотрим в каком порядке это ребро идёт в face → инвертируем наоборот,
    // чтобы fan-треугольники смотрели ИЗНУТРИ дырки НАРУЖУ, в соответствии
    // с существующей ориентацией.
    const a0 = loop[0], b0 = loop[1];
    let flipOrient = false;
    for (let fi = 0; fi < oldNF; fi++) {
      if (!cache.valid[fi]) continue;
      for (let j = 0; j < 3; j++) {
        const va = F0[fi * 3 + j], vb = F0[fi * 3 + (j + 1) % 3];
        if (va === a0 && vb === b0) { flipOrient = true; break; }       // ребро идёт a→b
        if (va === b0 && vb === a0) { flipOrient = false; break; }       // b→a → наш fan a→b→c согласован
      }
    }

    // --- Расширяем массивы ---
    const newNV = oldNV + 1;
    const newNF = oldNF + N;
    const newVi = oldNV;

    const V = _extendArray(cache.V, oldNV * 3, newNV * 3);
    V[newVi * 3]     = cx3;
    V[newVi * 3 + 1] = cy3;
    V[newVi * 3 + 2] = cz3;
    const uv = _extendArray(cache.uv, oldNV * 2, newNV * 2);
    uv[newVi * 2]     = cu;
    uv[newVi * 2 + 1] = cv;

    const F = _extendArray(cache.F, oldNF * 3, newNF * 3, 0, Int32Array);
    const zoneLabels = _extendArray(cache.zoneLabels, oldNF, newNF, patchZone, Uint8Array);
    const valid = _extendArray(cache.valid, oldNF, newNF, 1, Uint8Array);

    // per-face arrays
    const _fa = _extendArray(cache._fa, oldNF, newNF);
    const _fn = _extendArray(cache._fn, oldNF * 3, newNF * 3);
    const _fc = _extendArray(cache._fc, oldNF * 3, newNF * 3);
    const distortion  = cache.distortion ? _extendArray(cache.distortion, oldNF, newNF, NaN) : null;
    const L2          = cache.L2         ? _extendArray(cache.L2,         oldNF, newNF, NaN) : null;
    const iso         = cache.iso        ? _extendArray(cache.iso,        oldNF, newNF, NaN) : null;
    const sigma1      = cache.sigma1     ? _extendArray(cache.sigma1,     oldNF, newNF, NaN) : null;
    const sigma2      = cache.sigma2     ? _extendArray(cache.sigma2,     oldNF, newNF, NaN) : null;
    const face_seam_ring = cache.face_seam_ring ? _extendArray(cache.face_seam_ring, oldNF, newNF, 99, Int16Array) : null;
    const overlapMap  = cache.overlapMap ? _extendArray(cache.overlapMap, oldNF, newNF, 0, Uint8Array) : null;
    const patchFaceMask = _extendArray(cache.patchFaceMask, oldNF, newNF, 1, Uint8Array);

    // Заполняем новые грани
    for (let i = 0; i < N; i++) {
      const a = loop[i], b = loop[(i + 1) % N];
      const fi = oldNF + i;
      if (flipOrient) {
        F[fi * 3] = b; F[fi * 3 + 1] = a; F[fi * 3 + 2] = newVi;
      } else {
        F[fi * 3] = a; F[fi * 3 + 1] = b; F[fi * 3 + 2] = newVi;
      }
      // Геометрия fan-грани
      const i0 = F[fi * 3], i1 = F[fi * 3 + 1], i2 = F[fi * 3 + 2];
      const ax = V[i0 * 3], ay = V[i0 * 3 + 1], az = V[i0 * 3 + 2];
      const bx = V[i1 * 3], by = V[i1 * 3 + 1], bz = V[i1 * 3 + 2];
      const cx = V[i2 * 3], cy = V[i2 * 3 + 1], cz = V[i2 * 3 + 2];
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      const ln = Math.max(Math.sqrt(nx * nx + ny * ny + nz * nz), 1e-15);
      _fn[fi * 3] = nx / ln; _fn[fi * 3 + 1] = ny / ln; _fn[fi * 3 + 2] = nz / ln;
      _fa[fi] = ln * 0.5;
      _fc[fi * 3] = (ax + bx + cx) / 3; _fc[fi * 3 + 1] = (ay + by + cy) / 3; _fc[fi * 3 + 2] = (az + bz + cz) / 3;
    }

    // --- Обновляем cache ---
    cache.V = V; cache.uv = uv; cache.F = F;
    cache.nV = newNV; cache.nF = newNF;
    cache.zoneLabels = zoneLabels; cache.valid = valid;
    cache._fa = _fa; cache._fn = _fn; cache._fc = _fc;
    cache.face_area = _fa;
    if (distortion)   cache.distortion   = distortion;
    if (L2)           cache.L2           = L2;
    if (iso)          cache.iso          = iso;
    if (sigma1)       cache.sigma1       = sigma1;
    if (sigma2)       cache.sigma2       = sigma2;
    if (face_seam_ring) cache.face_seam_ring = face_seam_ring;
    if (overlapMap)   cache.overlapMap   = overlapMap;
    cache.patchFaceMask = patchFaceMask;

    // --- Incremental update vAdj + faceAdj для новых рёбер ---
    // vAdj: новая вершина соединена со всеми петлевыми.
    if (cache.vAdj) {
      // Увеличим массив adj до newNV
      while (cache.vAdj.length < newNV) cache.vAdj.push([]);
      const V2 = V;
      for (const vi of loop) {
        const dx = V2[vi * 3] - cx3, dy = V2[vi * 3 + 1] - cy3, dz = V2[vi * 3 + 2] - cz3;
        const w = Math.sqrt(dx * dx + dy * dy + dz * dz);
        cache.vAdj[newVi].push([vi, w]);
        cache.vAdj[vi].push([newVi, w]);
      }
    }

    // faceAdj: полный пересчёт для новых граней — они могут быть соседями
    // и между собой, и со старыми граничными гранями. Проще всего — добавить
    // записи для newFaceIds и дополнить существующие.
    if (cache.faceAdj) {
      while (cache.faceAdj.length < newNF) cache.faceAdj.push([]);
      const edgeMap = new Map();
      // Собираем edge → face для старых (только граничные грани нам важны)
      // и для новых.
      const faceRange = [];
      for (let fi = 0; fi < oldNF; fi++) {
        if (!cache.valid[fi]) continue;
        // Только грани, инцидентные петле — остальные не могут быть соседями новых.
        let inc = false;
        for (let j = 0; j < 3; j++) if (boundarySet.has(F[fi * 3 + j])) { inc = true; break; }
        if (inc) faceRange.push(fi);
      }
      for (let fi = oldNF; fi < newNF; fi++) faceRange.push(fi);
      for (const fi of faceRange) {
        for (let j = 0; j < 3; j++) {
          const a = F[fi * 3 + j], b = F[fi * 3 + (j + 1) % 3];
          const k = a < b ? a * 1048576 + b : b * 1048576 + a;
          if (!edgeMap.has(k)) edgeMap.set(k, []);
          edgeMap.get(k).push(fi);
        }
      }
      for (const [, fl] of edgeMap) {
        if (fl.length !== 2) continue;
        const [f1, f2] = fl;
        // Добавляем связь только если её ещё нет.
        if (cache.faceAdj[f1].indexOf(f2) < 0) cache.faceAdj[f1].push(f2);
        if (cache.faceAdj[f2].indexOf(f1) < 0) cache.faceAdj[f2].push(f1);
      }
    }

    // Патч-запись (для undo)
    const addedFaceIds = [];
    for (let i = 0; i < N; i++) addedFaceIds.push(oldNF + i);
    const patchRecord = {
      newVi, addedFaceIds, loop: loop.slice(),
      zone: patchZone,
      uv: { u: cu, v: cv },
      xyz: { x: cx3, y: cy3, z: cz3 },
      area3d: addedFaceIds.reduce((s, fi) => s + _fa[fi], 0),
    };
    cache.patches.push(patchRecord);
    return patchRecord;
  }

  function undoLastPatch() {
    if (!cache || !cache.patches || cache.patches.length === 0) return null;
    const patch = cache.patches.pop();
    const oldNV = cache.nV - 1, oldNF = cache.nF - patch.addedFaceIds.length;

    const trim = (arr, newLen) => (arr && arr.subarray ? arr.slice(0, newLen) : (arr ? arr.slice(0, newLen) : null));

    cache.V = trim(cache.V, oldNV * 3);
    cache.uv = trim(cache.uv, oldNV * 2);
    cache.F = trim(cache.F, oldNF * 3);
    cache.zoneLabels = trim(cache.zoneLabels, oldNF);
    cache.valid = trim(cache.valid, oldNF);
    cache._fa = trim(cache._fa, oldNF);
    cache._fn = trim(cache._fn, oldNF * 3);
    cache._fc = trim(cache._fc, oldNF * 3);
    cache.face_area = cache._fa;
    if (cache.distortion)     cache.distortion     = trim(cache.distortion, oldNF);
    if (cache.L2)             cache.L2             = trim(cache.L2, oldNF);
    if (cache.iso)            cache.iso            = trim(cache.iso, oldNF);
    if (cache.sigma1)         cache.sigma1         = trim(cache.sigma1, oldNF);
    if (cache.sigma2)         cache.sigma2         = trim(cache.sigma2, oldNF);
    if (cache.face_seam_ring) cache.face_seam_ring = trim(cache.face_seam_ring, oldNF);
    if (cache.overlapMap)     cache.overlapMap     = trim(cache.overlapMap, oldNF);
    if (cache.patchFaceMask)  cache.patchFaceMask  = trim(cache.patchFaceMask, oldNF);

    cache.nV = oldNV; cache.nF = oldNF;

    // Обрезаем vAdj/faceAdj
    if (cache.vAdj && cache.vAdj.length > oldNV) {
      // Удаляем ссылки на удалённую вершину из adj-списков соседей.
      for (const vi of patch.loop) {
        if (!cache.vAdj[vi]) continue;
        cache.vAdj[vi] = cache.vAdj[vi].filter(e => e[0] < oldNV);
      }
      cache.vAdj.length = oldNV;
    }
    if (cache.faceAdj && cache.faceAdj.length > oldNF) {
      // Удаляем ссылки на удалённые грани из adj-списков.
      for (let fi = 0; fi < oldNF; fi++) {
        if (!cache.faceAdj[fi]) continue;
        cache.faceAdj[fi] = cache.faceAdj[fi].filter(x => x < oldNF);
      }
      cache.faceAdj.length = oldNF;
    }

    return patch;
  }

  /* Публичный входной API: залатать дырку под кликом в UV. */
  function patchAtUVPoint(ux, uy) {
    if (!cache) { _toast('Сначала постройте развёртку', 'warn'); return false; }
    const hole = findHoleUnderPoint(ux, uy);
    if (!hole) { _toast('Не найдена внутренняя граница под точкой клика', 'warn'); return false; }
    // Защита: очень маленькие петли (< 3-4 вершин) — пропускаем (обычно это артефакты).
    if (hole.loop.length < 3) { _toast('Слишком маленькая граница', 'warn'); return false; }
    const rec = patchHole(hole);
    if (!rec) { _toast('Ошибка залатывания', 'error'); return false; }

    // Полный перерендер обоих видов.
    upload3DMesh();
    fit2D();
    render2D();
    render3DAnnotations();
    updateDistortionPanel();
    _toast('Дырка залатана: ' + rec.addedFaceIds.length + ' грани, +' + rec.area3d.toFixed(2) + ' мм²', 'ok');
    dispatchDataChange('unfold:patched', { zone: rec.zone, area: rec.area3d });
    return true;
  }


  /* ═══ MAIN BUILD ENTRY ═══ */

  /* ── Встроенный server-bridge: автодетект /api/unfold и вызов через SSE ── */
  let SERVER_UNFOLD_AVAILABLE = null;  // null=не проверяли, true/false=результат
  let unfoldMode = 'single';  // 'single' | 'charts' — режим развёртки

  function toggleChartsMode() {
    unfoldMode = (unfoldMode === 'charts') ? 'single' : 'charts';
    const el  = _$('t4-charts');  if (el)  el.classList.toggle('active', unfoldMode === 'charts');
    const el2 = _$('t4-charts2'); if (el2) el2.classList.toggle('active', unfoldMode === 'charts');
    const msg = (unfoldMode === 'charts')
      ? 'Режим: charts — развёртка по зонам отдельно + Procrustes-сшивка (edge_err меньше на ~15%, но видны швы 0.2-0.5 мм)'
      : 'Режим: single — одна сплошная UV + разрез перфораций (надёжно, без швов)';
    _toast(msg, 'info');
    if (cache && window.M && window.M.V) {
      buildUnfold();
    }
  }

  async function _checkServerUnfold() {
    if (SERVER_UNFOLD_AVAILABLE !== null) return SERVER_UNFOLD_AVAILABLE;
    try {
      const r = await fetch('/api/operations');
      if (!r.ok) { SERVER_UNFOLD_AVAILABLE = false; return false; }
      const ops = await r.json();
      SERVER_UNFOLD_AVAILABLE = !!(ops && ops.unfold);
      console.log('[tab4] server unfold available:', SERVER_UNFOLD_AVAILABLE,
                  '· available ops:', Object.keys(ops || {}));
      return SERVER_UNFOLD_AVAILABLE;
    } catch (e) {
      console.warn('[tab4] /api/operations недоступен:', e.message);
      SERVER_UNFOLD_AVAILABLE = false;
      return false;
    }
  }

  async function _pushZonesToSession(zoneLabels) {
    const body = JSON.stringify({ labels: Array.from(zoneLabels) });
    const r = await fetch('/api/session/zones', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (!r.ok) throw new Error('PUT /api/session/zones → HTTP ' + r.status);
  }

  async function _runUnfoldStream(onProgress) {
    const M = window.M;
    const body = {
      mode: unfoldMode,                      // 'single' | 'charts'
      arap_iterations: 80,
      // v5: классификация inner loops (septum-perforation vs artifact).
      // Септум-перфорации сохраняются как дырки в UV для измерения хирургом.
      classify_inner_loops: true,
      septum_zone_label: 0,
      septum_area_pct_threshold: 50.0,
      min_preserved_loop_perimeter_mm: 2.0,
      max_fan_fill_perimeter_mm: 2.0,
      // v4 legacy OFF — иначе cut-open режет то, что classify preserved.
      cut_open_inner_loops: false,
      fill_perimeter_threshold_mm: 2.0,
      V: Array.from(M.V),                    // flat [x,y,z,x,y,z,...]
      F: Array.from(M.F),                    // flat [a,b,c,a,b,c,...]
      zone_labels: Array.from(M.zoneLabels),
    };
    const r = await fetch('/api/unfold/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error('POST /api/unfold/stream → HTTP ' + r.status + ': ' + (await r.text()));
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', final = null;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (!payload) continue;
        try {
          const ev = JSON.parse(payload);
          if (ev.stage) { console.log('[tab4]', ev.stage); onProgress && onProgress(ev.stage); }
          else final = ev;
        } catch {}
      }
    }
    if (!final) throw new Error('Сервер закрыл stream без финального события');
    if (final.error) throw new Error('Сервер: ' + final.error);
    return final;
  }

  async function _fetchUnfolded() {
    const r = await fetch('/api/session/unfolded');
    if (!r.ok) throw new Error('GET /api/session/unfolded → HTTP ' + r.status);
    const data = await r.json();
    const nV = data.V_processed.length, nF = data.F_processed.length;
    const V = new Float64Array(nV * 3);
    const F = new Int32Array(nF * 3);
    const uv = new Float64Array(nV * 2);
    for (let i = 0; i < nV; i++) {
      V[i*3]   = data.V_processed[i][0];
      V[i*3+1] = data.V_processed[i][1];
      V[i*3+2] = data.V_processed[i][2];
      uv[i*2]  = data.uv[i][0];
      uv[i*2+1]= data.uv[i][1];
    }
    for (let i = 0; i < nF; i++) {
      F[i*3]   = data.F_processed[i][0];
      F[i*3+1] = data.F_processed[i][1];
      F[i*3+2] = data.F_processed[i][2];
    }
    return {
      V, F, nV, nF, uv,
      valid:          new Uint8Array(data.valid),
      zoneLabels:     new Uint8Array(data.zone_labels),
      face_areas_3d:  new Float64Array(data.face_areas_3d),
      // v4: per-face массивы для UI-подсветки «ненадёжных» граней.
      // Сервер возвращает null для совместимости со старым v3-бэкендом.
      face_edge_err_max: data.face_edge_err_max ? new Float64Array(data.face_edge_err_max) : null,
      face_L2:           data.face_L2           ? new Float64Array(data.face_L2)           : null,
      face_iso:          data.face_iso          ? new Float64Array(data.face_iso)          : null,
      face_area_ratio:   data.face_area_ratio   ? new Float64Array(data.face_area_ratio)   : null,
      face_risk_level:   data.face_risk_level   ? new Uint8Array(data.face_risk_level)     : null,
      // v6.2: per-face overlap mask с бэка (1 = грань в зоне UV-перекрытия,
      // измерения там недостоверны). SAT-based — точнее чем client-side raster.
      // Если бэк не прислал — fallback на computeOverlapMap (raster ~0.5мм).
      face_overlap:      data.face_overlap      ? new Uint8Array(data.face_overlap)        : null,
      // v5: сохранённые септум-перфорации (клинически значимые) +
      // информация про то, что серверу пришлось подрезать/заполнить.
      preserved_perforations: data.preserved_perforations || [],
      artifact_loops_filled:  data.artifact_loops_filled  || [],
      artifact_loops_cut:     data.artifact_loops_cut     || [],
      metrics:        data.metrics,
      info:           data.info,
    };
  }

  async function buildUnfold() {
    const d = diagnoseState();
    if (d.kind === 'no-mesh' || d.kind === 'no-zones' || d.kind === 'stale') {
      _toast('Нельзя построить: ' + d.kind, 'warn');
      updateWarningUI();
      return;
    }
    const M = window.M;
    ensureDOM();
    injectCSS();

    // Спиннер на всю длительность buildUnfold. Финальный _hideSpinner —
    // в finally, чтобы не остался висеть на любом непредвиденном throw'е
    // в синхронной части (computeDistortion / init3D / upload3DMesh и т.д.).
    _showSpinner('Проверка сервера…');
    try {

    // ── Сервер: пробуем использовать LSCM+ARAP backend если есть
    const serverOK = await _checkServerUnfold();
    if (serverOK) {
      // ── Snapshot/restore исходного меша ─────────────────────────
      // Ниже на success-пути мы делаем M.V = result.V (и т.д.) — это
      // перетирает исходные данные meshem от сервера. Значит перед
      // ОЧЕРЕДНЫМ запуском (например, юзер тогглит charts) сервер должен
      // получить ЧИСТЫЕ исходные V/F/zoneLabels, а не предыдущий result.
      // Делаем snapshot один раз и восстанавливаем каждый следующий раз.
      if (!_origInput) {
        _origInput = {
          V: new Float64Array(M.V),
          F: new Int32Array(M.F),
          nV: M.nV, nF: M.nF,
          zoneLabels: new Uint8Array(M.zoneLabels),
        };
      } else {
        M.V = new Float64Array(_origInput.V);
        M.F = new Int32Array(_origInput.F);
        M.nV = _origInput.nV;
        M.nF = _origInput.nF;
        M.zoneLabels = new Uint8Array(_origInput.zoneLabels);
      }
      console.log('[tab4] → server mode (operations/unfold.py)');
      _toast('Серверная развёртка (LSCM+ARAP)…', 'info');
      _setSpinnerText('Серверная развёртка (LSCM+ARAP)…');
      try {
        // onProgress: и тоаст справа (прежнее поведение), и подпись
        // под спиннером — совпадает с тем, как это сделано в tab2/tab3.
        await _runUnfoldStream((stage) => {
          _toast(stage, 'info');
          _setSpinnerText(stage);
        });
        _setSpinnerText('Получение результата…');
        const result = await _fetchUnfolded();
        console.log('[tab4] ✓ server result:', result.metrics);
        // Подменяем M данными с сервера (очищенный меш + labels)
        M.V = result.V; M.F = result.F;
        M.nV = result.nV; M.nF = result.nF;
        // FIX: server возвращает result.zoneLabels со СВОЕЙ переразметкой
        // (enforce sep↔lat пустой, distribute labels на новые fill-faces
        // и т.п.). Это ломает визуальную консистентность tab3↔tab4 — на
        // 4-м табе виден другой раскрас, чем на 3-м. Если у нас есть
        // tab3-snapshot, переносим НАШИ labels на server-mesh через NN
        // по центроидам граней (~150-300мс на 8k faces). Иначе — fallback
        // на server-labels (поведение по умолчанию).
        if (typeof window.__tab3RemapLabels === 'function') {
          const remapped = window.__tab3RemapLabels(result.V, result.F, result.nF);
          M.zoneLabels = remapped || result.zoneLabels;
        } else {
          M.zoneLabels = result.zoneLabels;
        }
        // precomputed UV — ниже будет подхвачен
        window.Tab4.__serverPrecomputed = {
          uv: result.uv, valid: result.valid,
          face_areas_3d: result.face_areas_3d,
          face_edge_err_max: result.face_edge_err_max,
          face_L2:           result.face_L2,
          face_iso:          result.face_iso,
          face_area_ratio:   result.face_area_ratio,
          face_risk_level:   result.face_risk_level,
          // v5: передать септум-перфорации дальше в buildUnfold
          preserved_perforations: result.preserved_perforations || [],
          artifact_loops_filled:  result.artifact_loops_filled  || [],
          artifact_loops_cut:     result.artifact_loops_cut     || [],
          metrics: result.metrics, info: result.info,
        };
        const perfCount = (result.preserved_perforations || []).length;
        const perfTxt = perfCount > 0
          ? ` · обнаружено перфораций: ${perfCount}`
          : '';
        // Клинический тост: ушли термины L²/inverted/edge_err — они
        // теперь живут под DEV_MODE в правой панели.
        _toast(
          `✓ Развёртка готова${perfTxt}`,
          'ok'
        );
        if (DEV_MODE) {
          // В dev-режиме оставляем технические числа отдельным тостом.
          const riskTxt = (result.metrics && result.metrics.risk_n_high != null)
            ? ` · ⚠ ${result.metrics.risk_n_high} опасных (${result.metrics.risk_high_faces_pct.toFixed(1)}%)`
            : '';
          _toast(
            `dev · L² p95=${result.metrics.L2_p95.toFixed(3)} · inv=${result.metrics.inverted} · edge p95=${(100*result.metrics.edge_err_p95).toFixed(1)}%${riskTxt}`,
            'info'
          );
        }
      } catch (e) {
        console.error('[tab4] server unfold failed:', e.message, '→ fallback на client');
        _toast('Сервер: ' + e.message + '. Fallback на client.', 'warn');
      }
    } else {
      console.log('[tab4] → client mode (computeGeodesicUV, качество низкое)');
    }

    cache = {};
    cacheSourceV = M.V; cacheSourceF = M.F; cacheZoneLabels = M.zoneLabels;
    cache.V = M.V; cache.F = M.F; cache.nV = M.nV; cache.nF = M.nF;
    cache.zoneLabels = M.zoneLabels;
    cache.patches = [];
    cache.patchFaceMask = null;

    _setSpinnerText('Построение UV-карты…');
    computeFaceGeom();
    cache.vAdj = buildVertexAdj();
    cache.faceAdj = buildFaceAdj();
    cache.axes = estimateAxes();
    // Если серверный UV есть — используем его вместо client computeGeodesicUV.
    //
    // FIX: переменная `pre` ОБЪЯВЛЯЕТСЯ ЗДЕСЬ (outer scope) вместо `const pre`
    // внутри if-блока. Иначе ниже на строке `if (pre.face_overlap)` —
    // ReferenceError: pre is not defined, потому что block-scoped `const`
    // не виден извне. Этот баг ронял весь buildUnfold (init3D + upload3DMesh
    // не выполнялись → пустой 3D-канвас и UV).
    let pre = null;
    if (window.Tab4 && window.Tab4.__serverPrecomputed &&
        window.Tab4.__serverPrecomputed.uv &&
        window.Tab4.__serverPrecomputed.uv.length === cache.nV * 2) {
      pre = window.Tab4.__serverPrecomputed;
      cache.uv = pre.uv;
      cache.valid = pre.valid || (function () {
        const v = new Uint8Array(cache.nF); v.fill(1); return v;
      })();
      if (pre.face_areas_3d) cache.face_area = pre.face_areas_3d;
      // v4: подтянуть per-face массивы для UI-подсветки.
      if (pre.face_edge_err_max) cache.face_edge_err_max = pre.face_edge_err_max;
      if (pre.face_L2)           cache.L2_server          = pre.face_L2;
      if (pre.face_iso)          cache.iso_server         = pre.face_iso;
      if (pre.face_area_ratio)   cache.face_area_ratio    = pre.face_area_ratio;
      if (pre.face_risk_level)   cache.face_risk_level    = pre.face_risk_level;
      if (pre.metrics)           cache.metricsFromServer  = pre.metrics;
      if (pre.info)              cache.info               = pre.info;
      // v5: подготовить септум-перфорации для отрисовки красной обводкой
      // и клика-измерения. Вычисляем UV-centroid, Feret-диаметры, площадь
      // shoelace, compactness — всё на клиенте чтобы render и click были
      // моментальными.
      if (pre.preserved_perforations && pre.preserved_perforations.length) {
        cache.perforations = preparePerforations(pre.preserved_perforations,
                                                  cache.V, cache.uv);
        console.log('[tab4] v5: septum perforations =', cache.perforations.length,
                    cache.perforations.map(p =>
                      `L=${p.perimeter_mm.toFixed(1)}mm S=${(p.area_uv_mm2/100).toFixed(2)}cm²`));
        // Активируем тумблер в toptools (начальное состояние _perfVisible=true)
        setTimeout(() => {
          const btn = _$('t4-perf2');
          if (btn) btn.classList.toggle('active', _perfVisible);
        }, 100);
      } else {
        cache.perforations = [];
      }
      cache.fw = 0;
      for (let vi = 0; vi < cache.nV; vi++) if (cache.uv[vi*2+1] > cache.fw) cache.fw = cache.uv[vi*2+1];
      window.Tab4.__serverPrecomputed = null;
    } else {
      computeGeodesicUV();
    }
    _setSpinnerText('Расчёт метрик искажений…');
    computeDistortion();
    computeJacobianMetrics();
    computeSeamRings();
    computeGlobalMetricsSummary();
    // v6.2: если бэк прислал точный face_overlap (SAT-based) — используем его.
    // Иначе fallback на client-side raster computeOverlapMap (~0.5мм
    // resolution, может пропустить мелкие overlap'ы).
    // FIX: проверка pre на null — иначе крах при client-only пути выше.
    if (pre && pre.face_overlap) {
      cache.overlapMap = pre.face_overlap;
      console.log('[tab4] v6.2: overlap from backend, faces:',
                  pre.face_overlap.reduce((a, b) => a + b, 0));
    } else {
      computeOverlapMap();
    }

    _setSpinnerText('Подготовка 3D-сцены…');
    init3D();
    upload3DMesh();

    const stage4 = document.querySelector('.stage[data-stage="unfold"]');
    const emp = stage4 && stage4.querySelector('.empty-state');
    if (emp) emp.style.display = 'none';
    const split = document.getElementById('t4-split');
    if (split) split.style.display = 'grid';
    // toolbarEl (#t4-toolbar) — legacy floating-тулбар, полностью заменён
    // на .t4-toptools. Не показываем (CSS-правило ниже + не трогаем inline).
    glCanvas.style.display = 'block';
    uvCanvas.style.display = 'block';

    /* ═══ FOCUS MODE: скрываем левую панель → больше места для сплит-вью ═══
       Класс t4-focused:
         • схлопывает .panel.left в 0 ширины (через CSS-transition)
         • стрелка на язычке .t4-reopen разворачивается «открыть»
         • скрывает старый floating-тулбар в углу вьюпорта
       Класс t4-built включает язычки-переключатели с обеих сторон —
       теперь они доступны всегда, и правая панель по умолчанию открыта.
       Показываем новый top-тулбар над viewport.                           */
    if (stage4) {
      stage4.classList.add('t4-built');
      stage4.classList.add('t4-focused');
      // Правую панель раскрываем сразу — после билда там метрики, точность
      // по зонам, обнаруженные перфорации. Это первая полезная информация
      // для врача. Раньше тут сворачивали (t4-focused-r) и ждали первого
      // действия, но это пряталась критичная информация: «обнаружена 1
      // перфорация, площадь 2.11 см²».
      stage4.classList.remove('t4-focused-r');
    }
    const topTb = document.getElementById('t4-toptools');
    if (topTb) topTb.classList.add('show');

    setTimeout(() => {
      fit2D();
      render2D();
      updateDistortionPanel();
    }, 50);

    // После завершения CSS-transition схлопывания панели переразложим канвасы
    // (иначе 3D-канвас будет рендериться под старый прямоугольник и выглядеть
    // растянутым до первого вращения мышкой). Плюс повторяем fit3D — на
    // первом вызове upload3DMesh canvas ещё 0×0 (был display:none), теперь
    // у него финальный size и aspect, так что orbDist надо пересчитать.
    setTimeout(() => {
      if (!cache) return;
      fit2D(); render2D();
      if (threeInited && ren3) {
        const c = ren3.domElement;
        ren3.setSize(c.clientWidth, c.clientHeight, false);
        if (cam3) { cam3.aspect = c.clientWidth / Math.max(c.clientHeight, 1); cam3.updateProjectionMatrix(); }
        fit3D(/*keepAngle*/ false);
      }
    }, 350);

    setColorMode('zones');
    setTool('pointer');

    dispatchDataChange('unfold:built');
    _toast('Развёртка построена (' + M.nF + ' граней)', 'ok');

    } finally {
      // Гарантированно прячем спиннер: и на success, и на любом throw'е
      // после _showSpinner. Финальное «Развёртка построена» уже выше,
      // ошибка уйдёт в console + всплывёт исключение наверх.
      _hideSpinner();
    }
  }
  window.Tab4.build = buildUnfold;

  /* ═══ 3D SCENE ═══ */
  function init3D() {
    if (threeInited) return;
    if (typeof THREE === 'undefined') { console.warn('Tab4: THREE is not loaded'); return; }
    const isDk = !document.body.classList.contains('light-theme');
    scene3 = new THREE.Scene();
    // 3D-фон чуть темнее правого 2D-пейна — это разделяет окна без лишних
    // линий. В light: тёплый светло-серый (вместо почти-белого 0xfdfdfe),
    // в dark: чуть глубже синий (вместо 0x0b1220 → 0x070d18).
    scene3.background = new THREE.Color(isDk ? 0x070d18 : 0xe9eef4);
    cam3 = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
    cam3.up.set(0, 0, 1);
    ren3 = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, alpha: false });
    ren3.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // Освещение — чуть богаче: key + fill + rim + hemi. Даёт объём без
    // мультшейдерного усложнения, близко по ощущению к tab1-Viewer.
    scene3.add(new THREE.AmbientLight(0xffffff, 0.45));
    const d1 = new THREE.DirectionalLight(0xffffff, 0.65); d1.position.set(40, -60, 80); scene3.add(d1);
    const d2 = new THREE.DirectionalLight(0xaacfff, 0.35); d2.position.set(-30, 40, -20); scene3.add(d2);
    const d3 = new THREE.DirectionalLight(0xffe4b5, 0.18); d3.position.set(10, 80, -40); scene3.add(d3); // warm rim
    const hemi = new THREE.HemisphereLight(0xddeeff, 0x667788, 0.32); scene3.add(hemi);

    // Подсказка-сетка на уровне z=0. Даёт чувство масштаба и ориентации, не
    // мешая модели (депт-тест вкл., но сетка полупрозрачная). Размер и число
    // делений подберём в upload3DMesh() под фактический bbox.
    gridHelper3 = new THREE.GridHelper(100, 10,
      isDk ? 0x00a0c8 : 0x4F7CDB,
      isDk ? 0x203040 : 0xb8c4d4);
    gridHelper3.rotation.x = Math.PI / 2; // в XY, т.к. cam.up = Z
    gridHelper3.material.opacity = isDk ? 0.45 : 0.55;
    gridHelper3.material.transparent = true;
    scene3.add(gridHelper3);

    // Осиный «gizmo» (X-Y-Z) в мировом 0 убран — анатомия носа не
    // нуждается в декартовых ориентирах, а триколорная стрелка в углу
    // отвлекала и шумела на светлом фоне. Сетка-«пол» под моделью
    // даёт достаточный пространственный контекст.
    // Переменная axesHelper3 оставлена объявленной, чтобы блок-апдейтер
    // в upload3DMesh() (`if (axesHelper3) { ... }`) не падал — он
    // просто никогда не сработает.

    meshGroup = new THREE.Group(); scene3.add(meshGroup);
    annotGroup = new THREE.Group(); annotGroup.name = 't4-annot'; scene3.add(annotGroup);

    orbTarget = new THREE.Vector3();
    threeInited = true;

    // ── Обновление фона при переключении темы ─────────────────────────
    // theme.js диспатчит 'theme:change'. До этого scene3.background
    // запекался один раз в init3D и не реагировал на toggle.
    const onTheme3 = () => {
      const dk = !document.body.classList.contains('light-theme');
      if (scene3) scene3.background = new THREE.Color(dk ? 0x070d18 : 0xe9eef4);
    };
    window.addEventListener('theme:change', onTheme3);

    if (!rafId) rafLoop();
  }

  function rafLoop() {
    rafId = requestAnimationFrame(rafLoop);
    if (!ren3 || !scene3 || !cam3 || !glCanvas) return;
    const stage = document.querySelector('.stage[data-stage="unfold"]');
    if (!stage || !stage.classList.contains('active')) return;
    const r = glCanvas.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    const pr = ren3.getPixelRatio();
    if (glCanvas.width !== Math.round(r.width * pr) || glCanvas.height !== Math.round(r.height * pr)) {
      ren3.setSize(r.width, r.height, false);
      ren3.setSize(r.width, r.height, false);
      cam3.aspect = Math.max(0.1, r.width / r.height);
      cam3.updateProjectionMatrix();
    }
    ren3.render(scene3, cam3);
  }

  function updateCam3() {
    const x = orbDist * Math.sin(orb.phi) * Math.cos(orb.theta);
    const y = orbDist * Math.sin(orb.phi) * Math.sin(orb.theta);
    const z = orbDist * Math.cos(orb.phi);
    cam3.position.set(orbTarget.x + x, orbTarget.y + y, orbTarget.z + z);
    cam3.lookAt(orbTarget);
  }

  /* ═══ fit3D ═══
     Aspect-aware подгонка камеры под модель.
     Вписывает bbox в кадр ± небольшой запас (margin).
     Используется:
       • из upload3DMesh — после того как mesh загружен
       • из setTimeout(350) в buildUnfold — когда CSS-transition
         схлопывания левой панели завершилась и canvas получил
         финальный размер
       • из кнопки #t4-fit-3d
       • при resize окна и drag сплиттера
     Параметр keepAngle:
       false → полный reset (theta=-1.0, phi=π/3.2) — для initial open
       true  → сохранить текущий orbit-угол, только пересчитать расстояние.
  */
  function fit3D(keepAngle) {
    if (!threeInited || !cache || !meshGroup) return;
    const bb = new THREE.Box3();
    meshGroup.children.forEach(m => m.geometry && bb.expandByObject(m));
    if (bb.isEmpty()) return;
    orbTarget.copy(bb.getCenter(new THREE.Vector3()));
    const sz = bb.getSize(new THREE.Vector3());
    // Перед расчётом подтягиваем aspect камеры к фактическим размерам canvas —
    // rafLoop это делает непрерывно, но мы не можем ждать его тут.
    if (cam3 && glCanvas && glCanvas.clientWidth > 0 && glCanvas.clientHeight > 0) {
      cam3.aspect = glCanvas.clientWidth / glCanvas.clientHeight;
      cam3.updateProjectionMatrix();
    }
    // Радиус — половина МАКСИМАЛЬНОЙ стороны bbox (консервативно влезает при
    // любой ориентации orbit). Для "почти кубика" это ≈ радиусу описанной
    // сферы; для вытянутых моделей немного оптимистично, но margin 1.10
    // гарантирует что ничего не обрежется.
    const maxHalf = Math.max(sz.x, sz.y, sz.z) * 0.5;
    const fovRad = (cam3 ? cam3.fov : 50) * Math.PI / 180;
    const aspect = (cam3 && cam3.aspect > 0) ? cam3.aspect : 1;
    const halfV = Math.tan(fovRad / 2);
    const halfH = halfV * Math.max(aspect, 0.1);
    const distV = maxHalf / halfV;
    const distH = maxHalf / halfH;
    // 4% воздуха вокруг модели — меш занимает почти всё окно, как в препроцессоре.
    // Раньше было 1.10 (10% полей), при узком левом пейне модель казалась мелкой.
    orbDist = Math.max(distV, distH) * 1.04;
    if (!keepAngle) { orb.theta = -1.0; orb.phi = Math.PI / 2.2; }
    updateCam3();
  }

  function upload3DMesh() {
    if (!threeInited || !cache) return;
    meshGroup.clear(); annotGroup.clear();
    const V = cache.V, F = cache.F, nF = cache.nF;
    const labels = cache.zoneLabels;
    const patchMask = cache.patchFaceMask;
    const pos = new Float32Array(nF * 9), col = new Float32Array(nF * 9);
    const zoneCol = [[0, 0.7, 1], [0, 1, 0.53], [1, 0.53, 0.27]];
    // Заплатки — ярко-жёлтым, чтобы сразу визуально отличались.
    const patchCol = [1.0, 0.82, 0.22];
    for (let fi = 0; fi < nF; fi++) {
      const isPatch = patchMask && patchMask[fi];
      const c = isPatch ? patchCol : (zoneCol[labels[fi]] || zoneCol[0]);
      for (let j = 0; j < 3; j++) {
        const vi = F[fi * 3 + j];
        pos[fi * 9 + j * 3] = V[vi * 3]; pos[fi * 9 + j * 3 + 1] = V[vi * 3 + 1]; pos[fi * 9 + j * 3 + 2] = V[vi * 3 + 2];
        col[fi * 9 + j * 3] = c[0]; col[fi * 9 + j * 3 + 1] = c[1]; col[fi * 9 + j * 3 + 2] = c[2];
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshPhongMaterial({ vertexColors: true, side: THREE.DoubleSide, shininess: 12, flatShading: false });
    const mesh = new THREE.Mesh(geo, mat);
    meshGroup.add(mesh);
    geo.computeBoundingBox();
    orbTarget.copy(geo.boundingBox.getCenter(new THREE.Vector3()));
    const s = geo.boundingBox.getSize(new THREE.Vector3());
    // Расчёт orbDist вынесен в общую функцию fit3D() — чтобы и initial fit,
    // и пересчёт после CSS-transition (setTimeout 350ms в buildUnfold), и
    // кнопка #t4-fit-3d вели себя одинаково. Если canvas ещё не получил
    // финальный размер на этот момент, upload3DMesh вызывается один раз
    // сейчас (видит пустой/мелкий canvas → orbDist будет восстановлен
    // чуть позже через fit3D() в setTimeout).
    fit3D(/*keepAngle*/ false);

    // Подгоняем grid-helper под bbox модели: размер ≈ 1.8× крупнейшей стороны,
    // делений — «круглое» число (10/20). Позиционируем плоскость grid'а
    // на уровне минимального Z модели — чтобы был «пол», а не плавал в воздухе.
    if (gridHelper3) {
      const maxSide = Math.max(s.x, s.y, 1);
      const gridSize = Math.max(20, Math.ceil(maxSide * 1.8 / 10) * 10);
      const gridDiv  = gridSize >= 200 ? 20 : 10;
      // Пересоздаём GridHelper (проще, чем перестраивать BufferGeometry
      // у существующего — он рассчитан на создание один раз).
      const isDk = !document.body.classList.contains('light-theme');
      scene3.remove(gridHelper3);
      gridHelper3.geometry.dispose();
      gridHelper3.material.dispose();
      gridHelper3 = new THREE.GridHelper(gridSize, gridDiv,
        isDk ? 0x00a0c8 : 0x4F7CDB,
        isDk ? 0x203040 : 0xb8c4d4);
      gridHelper3.rotation.x = Math.PI / 2;
      gridHelper3.material.opacity = isDk ? 0.40 : 0.50;
      gridHelper3.material.transparent = true;
      // КЛЮЧЕВОЙ фикс: центр сетки — под центром модели по XY, а не в world
      // origin. Раньше сетка торчала в сторону, когда bbox.center был
      // далеко от (0,0), и модель выглядела «прижатой к углу».
      gridHelper3.position.x = orbTarget.x;
      gridHelper3.position.y = orbTarget.y;
      gridHelper3.position.z = geo.boundingBox.min.z - maxSide * 0.02;
      scene3.add(gridHelper3);
    }
    if (axesHelper3) {
      const axisLen = Math.max(s.x, s.y, s.z) * 0.22;
      axesHelper3.scale.setScalar(axisLen / 6);
      axesHelper3.position.copy(geo.boundingBox.min);
    }

    updateCam3();
  }

  function clearInspect3D() {
    if (hoverMesh3d && annotGroup) {
      annotGroup.remove(hoverMesh3d);
      hoverMesh3d.geometry.dispose(); hoverMesh3d.material.dispose();
      hoverMesh3d = null;
    }
  }

  function syncInspect3D(fi) {
    if (!threeInited || !cache || !cache.valid[fi]) { clearInspect3D(); return; }
    clearInspect3D();
    const F = cache.F, V = cache.V;
    const i0 = F[fi * 3], i1 = F[fi * 3 + 1], i2 = F[fi * 3 + 2];
    const nx = cache._fn[fi * 3], ny = cache._fn[fi * 3 + 1], nz = cache._fn[fi * 3 + 2];
    const pos = new Float32Array([
      V[i0 * 3] + nx * 0.6, V[i0 * 3 + 1] + ny * 0.6, V[i0 * 3 + 2] + nz * 0.6,
      V[i1 * 3] + nx * 0.6, V[i1 * 3 + 1] + ny * 0.6, V[i1 * 3 + 2] + nz * 0.6,
      V[i2 * 3] + nx * 0.6, V[i2 * 3 + 1] + ny * 0.6, V[i2 * 3 + 2] + nz * 0.6,
    ]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex([0, 1, 2]);
    const m = new THREE.MeshBasicMaterial({ color: 0xffcf66, transparent: true, opacity: 0.88, side: THREE.DoubleSide, depthTest: false });
    hoverMesh3d = new THREE.Mesh(g, m);
    hoverMesh3d.renderOrder = 1000;
    annotGroup.add(hoverMesh3d);
  }

  /* ═══════════════════════════════════════════════════════════ HOVER ═══
     Единая функция "под курсором сейчас грань #fi" — вызывается из обоих
     view'ов (UV и 3D). Синхронно подсвечивает грань в противоположном
     виде, обновляет tooltip у курсора и (при tool=inspect) — полную карту
     метрик в правой панели.
     ══════════════════════════════════════════════════════════════════════ */
  function setHoveredFace(fi) {
    if (fi === inspectedFace) return;
    inspectedFace = fi;
    if (fi >= 0) {
      syncInspect3D(fi);
      if (activeTool === 'inspect') showInspectForFace(fi);
    } else {
      clearInspect3D();
      if (activeTool === 'inspect') hideMeasFloat();
    }
    render2D();
  }

  /* ═══ Cursor tooltip (следует за курсором, показывает ID/зону/метрику) ═══ */
  function positionCursorTip(clientX, clientY, fi) {
    if (!cursorTipEl || !cache || fi < 0 || !cache.valid[fi]) { hideCursorTip(); return; }
    const stage = document.querySelector('.stage[data-stage="unfold"]');
    if (!stage) return;
    const viewport = stage.querySelector('.workarea .viewport');
    if (!viewport) return;
    const vr = viewport.getBoundingClientRect();
    const lab = cache.zoneLabels[fi];
    const isDk = !document.body.classList.contains('light-theme');
    const zc = isDk ? ['#00b4ff', '#00ff88', '#ff8844'] : ['#4F7CDB', '#34B86A', '#DD8844'];

    _$('t4-ctip-fi').textContent = '#' + fi;
    const zn = _$('t4-ctip-zn'); zn.style.background = zc[lab]; zn.style.color = zc[lab];
    _$('t4-ctip-zl').textContent = ZONE_NAMES[lab];

    // Активная метрика определяется colorMode.
    let metTxt = '';
    if (colorMode === 'risk' && cache.face_edge_err_max) {
      const v = cache.face_edge_err_max[fi];
      if (isFinite(v)) {
        const pct = (v * 100).toFixed(1) + '%';
        const tag = v >= 0.10 ? ' · НЕ ИЗМЕРЯТЬ' : v >= 0.05 ? ' · осторожно' : '';
        metTxt = 'err ' + pct + tag;
      }
    } else if (colorMode === 'L2' && cache.L2) {
      const v = cache.L2[fi]; metTxt = isFinite(v) ? ('L² ' + v.toFixed(3)) : '';
    } else if (colorMode === 'iso' && cache.iso) {
      const v = cache.iso[fi]; metTxt = isFinite(v) ? ('iso ' + v.toFixed(3)) : '';
    } else if (colorMode === 'ring' && cache.face_seam_ring) {
      const r = cache.face_seam_ring[fi]; metTxt = (r >= 0 ? 'ring ' + r : '');
    } else {
      // zones — показываем площадь грани.
      if (cache._fa) metTxt = cache._fa[fi].toFixed(2) + ' мм²';
    }
    _$('t4-ctip-met').textContent = metTxt;

    // Позиционируем относительно viewport (tooltip живёт в viewport).
    let x = clientX - vr.left + 14;
    let y = clientY - vr.top + 14;
    cursorTipEl.style.display = 'block';
    // Померим ширину/высоту после первого показа, чтобы не выехать за край.
    const tw = cursorTipEl.offsetWidth, th = cursorTipEl.offsetHeight;
    if (x + tw > vr.width - 4)  x = clientX - vr.left - tw - 12;
    if (y + th > vr.height - 4) y = clientY - vr.top - th - 12;
    if (x < 4) x = 4;
    if (y < 4) y = 4;
    cursorTipEl.style.transform = 'translate(' + x + 'px,' + y + 'px)';
  }
  function hideCursorTip() {
    if (cursorTipEl) cursorTipEl.style.display = 'none';
  }

  /* ═══ Focus 3D camera on face (dblclick fly-to) ═══ */
  function focus3DOnFace(fi) {
    if (!cache || !cache.valid[fi] || !threeInited || !cam3 || !orbTarget) return;
    const fc = cache._fc;
    const target = new THREE.Vector3(fc[fi * 3], fc[fi * 3 + 1], fc[fi * 3 + 2]);

    // Плавная интерполяция orbTarget → face centroid + немного приблизим.
    const start = orbTarget.clone();
    const startDist = orbDist;
    const targetDist = Math.max(orbDist * 0.45, 12);
    const t0 = performance.now();
    const dur = 420;
    function step() {
      const u = Math.min(1, (performance.now() - t0) / dur);
      const k = 1 - Math.pow(1 - u, 3); // easeOutCubic
      orbTarget.set(
        start.x + (target.x - start.x) * k,
        start.y + (target.y - start.y) * k,
        start.z + (target.z - start.z) * k,
      );
      orbDist = startDist + (targetDist - startDist) * k;
      updateCam3();
      if (u < 1) requestAnimationFrame(step);
      else {
        // Пульс-маркер у центра кадра.
        showFocusPulseOnCanvas(glCanvas);
        // И — пульс у грани в UV.
        if (uvCanvas && unfTx) {
          const u2 = cache.uv[window.M.F[fi * 3] * 2];
          const v2 = cache.uv[window.M.F[fi * 3] * 2 + 1];
          showFocusPulseAt(uvCanvas, unfTx.tx(u2), unfTx.ty(v2));
        }
      }
    }
    step();
    // Сразу hover-подсветка.
    setHoveredFace(fi);
  }

  function showFocusPulseOnCanvas(canv) {
    if (!canv) return;
    const r = canv.getBoundingClientRect();
    showFocusPulseAt(canv, r.width / 2, r.height / 2);
  }
  function showFocusPulseAt(canv, localX, localY) {
    if (!canv || !canv.parentElement) return;
    const pulse = document.createElement('div');
    pulse.className = 't4-focuspulse';
    pulse.style.width  = '46px';
    pulse.style.height = '46px';
    pulse.style.left   = localX + 'px';
    pulse.style.top    = localY + 'px';
    canv.parentElement.appendChild(pulse);
    setTimeout(() => pulse.remove(), 750);
  }

  function render3DAnnotations() {
    if (!threeInited || !annotGroup) return;
    const hover = hoverMesh3d; hoverMesh3d = null;
    annotGroup.clear();
    if (hover) { annotGroup.add(hover); hoverMesh3d = hover; }
    if (!cache) return;
    const V = cache.V, F = cache.F, nF = cache.nF;

    if (selectedFaces) {
      let cnt = 0; for (let i = 0; i < nF; i++) if (selectedFaces[i]) cnt++;
      if (cnt > 0) {
        const pos = new Float32Array(cnt * 9); let k = 0;
        for (let fi = 0; fi < nF; fi++) {
          if (!selectedFaces[fi]) continue;
          for (let j = 0; j < 3; j++) {
            const vi = F[fi * 3 + j];
            pos[k * 3] = V[vi * 3] + cache._fn[fi * 3] * 0.5;
            pos[k * 3 + 1] = V[vi * 3 + 1] + cache._fn[fi * 3 + 1] * 0.5;
            pos[k * 3 + 2] = V[vi * 3 + 2] + cache._fn[fi * 3 + 2] * 0.5;
            k++;
          }
        }
        const gg = new THREE.BufferGeometry();
        gg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const mm = new THREE.MeshBasicMaterial({ color: 0x00f0ff, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthTest: false });
        const sm = new THREE.Mesh(gg, mm); sm.renderOrder = 5; annotGroup.add(sm);
      }
    }
    if (polygonPts.length > 0) drawPoints3D(polygonPts, 0x00f0ff);
    if (rulerPts.length > 0) drawPoints3D(rulerPts, 0xff4466);
    if (rulerChainPts.length > 0) drawPoints3D(rulerChainPts, 0xffaa33);
    if (rulerPts.length === 2 && cache._rulerPath) drawPath3D(cache._rulerPath, 0xff4466);
    if (rulerChainPts.length >= 2) {
      for (let k = 0; k < rulerChainPts.length - 1; k++) {
        const r = dijkstraPath(rulerChainPts[k].vi, rulerChainPts[k + 1].vi);
        drawPath3D(r.path, 0xffaa33);
      }
    }
    if (polygonPts.length >= 2) {
      for (let i = 0; i < polygonPts.length; i++) {
        if (polygonPts.length < 3 && i === polygonPts.length - 1) break;
        const a = polygonPts[i].vi, b = polygonPts[(i + 1) % polygonPts.length].vi;
        if (a === b) continue;
        const r = dijkstraPath(a, b);
        drawPath3D(r.path, 0x00f0ff);
      }
    }
    // Мульти-замер: каждый отрезок — прямая 3D-хорда, своим цветом,
    // концы маркируем точками. Геодезику не используем — диаметры
    // перфораций должны идти «по воздуху» через дырку.
    for (let i = 0; i < measureLines.length; i++) {
      const L = measureLines[i];
      const col = MEASURE_COLORS_3D[i % MEASURE_COLORS_3D.length];
      drawSegment3D(L.a, L.b, col);
      drawPoints3D([L.a, L.b], col);
    }
    // Pending A — одиночная cyan-точка, чтоб видно было «жду B»
    if (measurePending) {
      drawPoints3D([measurePending], 0x00d0ff);
    }
  }

  /* ═══ Радиальная текстура для halo-спрайтов ═══════════════════════════
     Один canvas-градиент кешируется и переиспользуется для всех точек —
     создавать SpriteMaterial с собственной текстурой на каждый маркер
     было бы и медленно, и тяжко по памяти. */
  let _haloTex = null;
  function getHaloTexture() {
    if (_haloTex) return _haloTex;
    const sz = 128;
    const c = document.createElement('canvas');
    c.width = c.height = sz;
    const ctx = c.getContext('2d');
    const r = sz / 2;
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    // Белое ядро → к краю прозрачное. Цвет накладывается через .color
    // SpriteMaterial, поэтому здесь в RGB только альфа-профиль.
    g.addColorStop(0.00, 'rgba(255,255,255,1)');
    g.addColorStop(0.20, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.35)');
    g.addColorStop(0.75, 'rgba(255,255,255,0.10)');
    g.addColorStop(1.00, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, sz, sz);
    _haloTex = new THREE.CanvasTexture(c);
    _haloTex.minFilter = THREE.LinearFilter;
    _haloTex.magFilter = THREE.LinearFilter;
    return _haloTex;
  }

  /* ═══ Подбираем радиус маркера под масштаб модели ═══════════════════
     Слишком крупные точки скрывают анатомию, слишком мелкие — теряются.
     Привязываемся к диагонали bbox (один раз на cache, кэшируется). */
  function getMarkerScale() {
    if (!cache) return 1;
    if (cache._markerScale != null) return cache._markerScale;
    let mnx = 1e9, mny = 1e9, mnz = 1e9, mxx = -1e9, mxy = -1e9, mxz = -1e9;
    const V = cache.V, n = (V.length / 3) | 0;
    for (let i = 0; i < n; i++) {
      const x = V[i * 3], y = V[i * 3 + 1], z = V[i * 3 + 2];
      if (x < mnx) mnx = x; if (y < mny) mny = y; if (z < mnz) mnz = z;
      if (x > mxx) mxx = x; if (y > mxy) mxy = y; if (z > mxz) mxz = z;
    }
    const diag = Math.hypot(mxx - mnx, mxy - mny, mxz - mnz);
    // 0.45% диагонали ≈ ~0.45мм для модели носа в ~10см. Достаточно
    // заметно, не перекрывает мелкие складки.
    cache._markerScale = Math.max(0.5, diag * 0.0045);
    return cache._markerScale;
  }

  function drawPoints3D(pts, color) {
    if (!threeInited || !cache || !pts.length) return;
    const V = cache.V;
    const s = getMarkerScale();
    const haloTex = getHaloTexture();

    // Геометрии переиспользуем — одна на тип, одна на маркер.
    // Ядро — 16-сегментная сфера (читается как «жемчужина»).
    const coreGeo = new THREE.SphereGeometry(s * 0.55, 16, 12);
    // Кольцо вокруг ядра — тор очень малой толщины, всегда лицом к камере.
    const ringGeo = new THREE.TorusGeometry(s * 0.95, s * 0.10, 10, 28);

    // Материалы:
    //   core — сплошной цвет, depthTest off (всегда поверх меша)
    //   ring — обводка более яркого тона + лёгкая прозрачность
    //   halo — sprite с additive-glow, реагирует на глубину
    const coreMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.95,
      depthTest: false, depthWrite: false,
    });
    // Сделаем ring слегка светлее — выглядит «обведённым».
    const ringCol = new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.45);
    const ringMat = new THREE.MeshBasicMaterial({
      color: ringCol, transparent: true, opacity: 0.85,
      depthTest: false, depthWrite: false,
    });
    const haloMat = new THREE.SpriteMaterial({
      map: haloTex, color, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthTest: false, depthWrite: false,
    });

    for (const p of pts) {
      const px = V[p.vi * 3], py = V[p.vi * 3 + 1], pz = V[p.vi * 3 + 2];

      // Halo идёт первым, чтобы кольцо/ядро рисовались поверх его
      // additive-свечения и читались чётко.
      const halo = new THREE.Sprite(haloMat);
      halo.position.set(px, py, pz);
      halo.scale.set(s * 4.2, s * 4.2, 1);
      halo.renderOrder = 997;
      annotGroup.add(halo);

      // Кольцо. Лицом к камере: добавим в onBeforeRender lookAt(camera).
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.set(px, py, pz);
      ring.renderOrder = 998;
      ring.onBeforeRender = function (renderer, scene, camera) {
        this.quaternion.copy(camera.quaternion);
      };
      annotGroup.add(ring);

      // Ядро.
      const core = new THREE.Mesh(coreGeo, coreMat);
      core.position.set(px, py, pz);
      core.renderOrder = 999;
      annotGroup.add(core);
    }
  }
  function drawPath3D(path, color) {
    if (!threeInited || path.length < 2 || !cache) return;
    const V = cache.V;
    const pts = [];
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1];
      pts.push(V[a * 3], V[a * 3 + 1], V[a * 3 + 2]);
      pts.push(V[b * 3], V[b * 3 + 1], V[b * 3 + 2]);
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
    const lm = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
    const ls = new THREE.LineSegments(lg, lm); ls.renderOrder = 998; annotGroup.add(ls);
  }

  /* Прямая 3D-хорда между двумя точками (используется мульти-замером).
     Отличается от drawPath3D тем, что не идёт по сетке — это буквально
     отрезок «по воздуху», который может пересекать перфорацию. */
  function drawSegment3D(a, b, color) {
    if (!threeInited) return;
    const arr = new Float32Array([a.x, a.y, a.z, b.x, b.y, b.z]);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const lm = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
    const ls = new THREE.LineSegments(lg, lm);
    ls.renderOrder = 998;
    annotGroup.add(ls);
  }

  /* ═══ 3D-ЛАССО ═══════════════════════════════════════════════════════
     Свободное выделение фейсов прямо в 3D-вью.

     Алгоритм:
       1. Пользователь зажимает ЛКМ → lasso3DStart() рисует SVG-path
          в overlay, снимает текущее выделение.
       2. mousemove → lasso3DAppend() добавляет точку, перерисовывает.
       3. mouseup → lasso3DFinish() проецирует центроид каждой видимой
          (front-facing) грани в screen-space и проверяет point-in-poly.
          Bounding-box pre-filter + culling по нормали ускоряют ×3-5.
       4. Esc / mouseleave / лассо < 3 точек → lasso3DCancel(), без эффекта.

     Координаты лассо хранятся в client-space и потом переводятся в
     pane-space внутрь SVG (svg сидит на pane#t4-3d минус 34px header,
     это смещение учитывается в lasso3DUpdatePath()).
  ═════════════════════════════════════════════════════════════════════ */
  function lasso3DPaneCoords(e) {
    // Координаты в системе SVG: pane#t4-3d, минус 34px header-полоса.
    const pane = lasso3DSvg && lasso3DSvg.parentElement;
    if (!pane) return { x: 0, y: 0 };
    const r = pane.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top - 34 };
  }
  function lasso3DStart(e) {
    if (!cache || !lasso3DSvg) return;
    lasso3DDrawing = true;
    lasso3DPath = [lasso3DPaneCoords(e)];
    selectedFaces = null;
    hideMeasFloat();
    render3DAnnotations();
    lasso3DSvg.classList.add('active');
    lasso3DUpdatePath();
  }
  function lasso3DAppend(e) {
    if (!lasso3DDrawing) return;
    const p = lasso3DPaneCoords(e);
    const last = lasso3DPath[lasso3DPath.length - 1];
    // throttle: пропускаем точки ближе 2px к предыдущей — лишние узлы
    // ничего не дают и тормозят перерисовку SVG path.
    if (last) {
      const dx = p.x - last.x, dy = p.y - last.y;
      if (dx * dx + dy * dy < 4) return;
    }
    lasso3DPath.push(p);
    lasso3DUpdatePath();
  }
  function lasso3DUpdatePath() {
    if (!lasso3DPathEl || lasso3DPath.length < 1) return;
    let d = 'M ' + lasso3DPath[0].x.toFixed(1) + ' ' + lasso3DPath[0].y.toFixed(1);
    for (let i = 1; i < lasso3DPath.length; i++) {
      d += ' L ' + lasso3DPath[i].x.toFixed(1) + ' ' + lasso3DPath[i].y.toFixed(1);
    }
    if (lasso3DPath.length > 2) d += ' Z';
    lasso3DPathEl.shadow.setAttribute('d', d);
    lasso3DPathEl.line.setAttribute('d', d);
  }
  function lasso3DCancel() {
    lasso3DDrawing = false;
    lasso3DPath = [];
    if (lasso3DSvg) lasso3DSvg.classList.remove('active');
    if (lasso3DPathEl) {
      lasso3DPathEl.shadow.setAttribute('d', '');
      lasso3DPathEl.line.setAttribute('d', '');
    }
  }
  function lasso3DFinish(e) {
    if (!lasso3DDrawing) return;
    lasso3DDrawing = false;
    if (!cache || lasso3DPath.length < 3) {
      lasso3DCancel();
      return;
    }
    // Конвертируем pane-coords (с учётом 34px header) в client для удобства,
    // но проще считать в pane-coords и проецировать туда же.
    finalizeLasso3D();
    // Прячем оверлей через короткую паузу — пользователь успеет «зацепиться
    // взглядом», что выделение и петля совпадают.
    setTimeout(() => {
      if (lasso3DSvg) lasso3DSvg.classList.remove('active');
    }, 250);
  }
  function finalizeLasso3D() {
    if (!cache || !cam3 || !glCanvas) return;
    const F = cache.F, V = cache.V, nF = cache.nF;
    const valid = cache.valid, fn = cache._fn;
    const pane = lasso3DSvg.parentElement;
    const paneRect = pane.getBoundingClientRect();
    // Размер «активной» области SVG (== область канваса под лейблом)
    const W = paneRect.width, H = paneRect.height - 34;
    // Bounding-box петли — даёт быстрый отсев фейсов вне неё.
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const p of lasso3DPath) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    // Камера-направление для отсева фейсов, смотрящих от нас (back-face).
    const camDir = new THREE.Vector3();
    cam3.getWorldDirection(camDir);

    selectedFaces = new Uint8Array(nF);
    let cnt = 0;
    const v = new THREE.Vector3();
    for (let fi = 0; fi < nF; fi++) {
      if (!valid || !valid[fi]) continue;
      const i0 = F[fi * 3], i1 = F[fi * 3 + 1], i2 = F[fi * 3 + 2];
      // Центроид грани
      const cx = (V[i0 * 3] + V[i1 * 3] + V[i2 * 3]) / 3;
      const cy = (V[i0 * 3 + 1] + V[i1 * 3 + 1] + V[i2 * 3 + 1]) / 3;
      const cz = (V[i0 * 3 + 2] + V[i1 * 3 + 2] + V[i2 * 3 + 2]) / 3;
      // Back-face: нормаль грани смотрит «от нас» → пропускаем.
      if (fn) {
        const nx = fn[fi * 3], ny = fn[fi * 3 + 1], nz = fn[fi * 3 + 2];
        const dot = nx * camDir.x + ny * camDir.y + nz * camDir.z;
        if (dot > 0.05) continue;
      }
      v.set(cx, cy, cz).project(cam3);
      // NDC → pane-pixel (учёт 34px header не нужен: SVG сам сдвинут)
      const sx = (v.x * 0.5 + 0.5) * W;
      const sy = (1 - (v.y * 0.5 + 0.5)) * H;
      // Pre-filter по bbox
      if (sx < minX || sx > maxX || sy < minY || sy > maxY) continue;
      // Behind camera
      if (v.z > 1) continue;
      if (screenPointInPath(sx, sy, lasso3DPath)) {
        selectedFaces[fi] = 1;
        cnt++;
      }
    }
    if (cnt === 0) {
      selectedFaces = null;
      hideMeasFloat();
      render3DAnnotations();
      return;
    }
    showLassoReadout();
    if (cache) { render2D(); render3DAnnotations(); }
  }

  function raycast3D(clientX, clientY) {
    if (!threeInited || !meshGroup.children.length || !cache) return null;
    const rect = glCanvas.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((clientY - rect.top) / rect.height) * 2 + 1;
    if (!threeRaycaster) threeRaycaster = new THREE.Raycaster();
    threeRaycaster.setFromCamera({ x: nx, y: ny }, cam3);
    const hits = threeRaycaster.intersectObject(meshGroup.children[0], false);
    if (!hits.length) return null;
    const h = hits[0]; const fi = h.faceIndex;
    if (fi < 0 || fi >= cache.nF) return null;
    const pt = h.point;
    let best = -1, bestD = 1e30;
    for (let j = 0; j < 3; j++) {
      const vi = cache.F[fi * 3 + j];
      const dx = cache.V[vi * 3] - pt.x, dy = cache.V[vi * 3 + 1] - pt.y, dz = cache.V[vi * 3 + 2] - pt.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = vi; }
    }
    return { fi, vi: best, point: pt };
  }

  /* ═══ 3D MOUSE ═══ */
  function gl_onMouseDown(e) {
    downX = e.clientX; downY = e.clientY;
    lastMX = e.clientX; lastMY = e.clientY;

    // Лассо в 3D — отдельная ветка: ЛКМ начинает рисовать петлю, drag не вращает.
    if (activeTool === 'lasso' && e.button === 0 && !e.shiftKey) {
      isDrag = false;
      lasso3DStart(e);
      return;
    }

    // ВСЕГДА разрешаем ЛКМ вращать модель (даже в режиме измерения).
    // Различение «клик vs drag» происходит в gl_onMouseUp по hypot(dx,dy)<5.
    // Раньше тут стоял ранний return, и в режиме линейки/полигона/etc.
    // вращение работало только Shift+ЛКМ или ПКМ — это сбивало с толку.
    isDrag = true;
    isPan = (e.button === 2 || e.button === 1 || e.shiftKey);
  }
  function gl_onMouseMove(e) {
    // Лассо в 3D — рисуем петлю, hover/raycast не делаем.
    if (lasso3DDrawing) {
      lasso3DAppend(e);
      return;
    }
    // Пока пользователь орбитит/панирует — hover не обновляем, это отвлекает.
    if (!isDrag && cache) {
      const hit = raycast3D(e.clientX, e.clientY);
      const fi = hit ? hit.fi : -1;
      setHoveredFace(fi);
      if (fi >= 0) positionCursorTip(e.clientX, e.clientY, fi);
      else         hideCursorTip();
    }
    if (!isDrag) return;
    const dx = e.clientX - lastMX, dy = e.clientY - lastMY;
    lastMX = e.clientX; lastMY = e.clientY;
    if (isPan) {
      const right = new THREE.Vector3().crossVectors(cam3.up, new THREE.Vector3().subVectors(cam3.position, orbTarget)).normalize();
      orbTarget.add(right.multiplyScalar(dx * 0.12));
      orbTarget.add(cam3.up.clone().multiplyScalar(-dy * 0.12));
    } else {
      orb.theta -= dx * 0.005;
      orb.phi = Math.max(0.05, Math.min(Math.PI - 0.05, orb.phi - dy * 0.005));
    }
    updateCam3();
  }
  function gl_onMouseUp(e) {
    // Завершение 3D-лассо
    if (lasso3DDrawing) {
      lasso3DFinish(e);
      isDrag = false; isPan = false;
      return;
    }
    const dx = e.clientX - downX, dy = e.clientY - downY;
    if (Math.hypot(dx, dy) < 5 && activeTool !== 'pointer' && activeTool !== 'inspect' && activeTool !== 'lasso' && cache) {
      handle3DClick(e.clientX, e.clientY);
    }
    isDrag = false; isPan = false;
  }
  function gl_onMouseLeave(e) {
    if (lasso3DDrawing) lasso3DCancel();
    isDrag = false; isPan = false;
    setHoveredFace(-1);
    hideCursorTip();
  }
  function gl_onDblClick(e) {
    if (!cache) return;
    // Полигон в 3D-виде: завершить (существующее поведение).
    if (activeTool === 'polygon') { handle3DClick(e.clientX, e.clientY, true); return; }
    // Иначе: фокус камеры на грань.
    const hit = raycast3D(e.clientX, e.clientY);
    if (hit && hit.fi >= 0) focus3DOnFace(hit.fi);
  }
  function gl_onWheel(e) {
    e.preventDefault();
    if (!cam3) return;
    // Зум-к-курсору: вместо plain-dolly смещаем orbTarget по лучу через
    // cursor'овую точку. Это ощущается «как в Tab 1» — мир приближается
    // к тому месту, куда смотрит пользователь, а не к абстрактному центру.
    const r = glCanvas.getBoundingClientRect();
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ny = -((e.clientY - r.top) / r.height) * 2 + 1;
    const factor = 1 + e.deltaY * 0.0012;
    const nextDist = Math.max(3, Math.min(orbDist * 20, orbDist * factor));
    // Луч из камеры через cursor в мировое пространство
    const ndc = new THREE.Vector3(nx, ny, 0.5).unproject(cam3);
    const dir = ndc.sub(cam3.position).normalize();
    // Параметр t — чтобы ось «луч от камеры к target» спроецировать на луч
    // через cursor: подтягиваем target в направлении курсора пропорционально
    // тому, насколько мы приблизились.
    const curDistToTarget = cam3.position.distanceTo(orbTarget);
    const delta = curDistToTarget - nextDist;
    orbTarget.add(dir.multiplyScalar(delta * 0.35));
    orbDist = nextDist;
    updateCam3();
  }

  function handle3DClick(clientX, clientY) {
    if (!cache) return;
    const hit = raycast3D(clientX, clientY);
    if (!hit) return;
    const p = makePoint(hit.vi);
    if (activeTool === 'polygon') {
      polygonPts.push(p);
      if (polygonPts.length >= 3) { measurementResult = measurePolygonV2(polygonPts); selectedFaces = measurementResult.selected; showPolygonMeasurement(measurementResult); }
    } else if (activeTool === 'ruler') {
      // v6.2: блок измерения в overlap-зоне (UV-перекрытие → измерения недостоверны)
      if (cache.overlapMap && hit.fi >= 0 && cache.overlapMap[hit.fi]) {
        _toast('Здесь развёртка ненадёжна (UV-перекрытие). Измерения недостоверны.', 'warn');
        return;
      }
      if (rulerPts.length >= 2) { rulerPts = []; cache._rulerPath = null; cache._rulerDist = 0; }
      rulerPts.push({ vi: hit.vi, ux: cache.uv[hit.vi * 2], uy: cache.uv[hit.vi * 2 + 1] });
      if (rulerPts.length === 2) { const res = dijkstraPath(rulerPts[0].vi, rulerPts[1].vi); cache._rulerPath = res.path; cache._rulerDist = res.dist; showRulerReadout(); }
    } else if (activeTool === 'rulerchain') {
      // v6.2: блок измерения в overlap-зоне
      if (cache.overlapMap && hit.fi >= 0 && cache.overlapMap[hit.fi]) {
        _toast('Здесь развёртка ненадёжна (UV-перекрытие). Измерения недостоверны.', 'warn');
        return;
      }
      rulerChainPts.push({ vi: hit.vi, ux: cache.uv[hit.vi * 2], uy: cache.uv[hit.vi * 2 + 1] });
      if (rulerChainPts.length >= 2) showChainReadout();
    } else if (activeTool === 'measure') {
      // Для измерителя берём ТОЧНУЮ 3D-точку попадания луча, а не
      // ближайшую вершину. Это даёт субмиллиметровую точность вместо
      // ±0.5–1мм (среднее расстояние между соседними вершинами).
      const pp = pickPrecisePoint({ hit3D: hit });
      if (pp) handleMeasureClick(pp);
    }
    render3DAnnotations(); render2D();
  }
  function makePoint(vi) {
    return { vi, u: cache.uv[vi * 2], v: cache.uv[vi * 2 + 1], x: cache.V[vi * 3], y: cache.V[vi * 3 + 1], z: cache.V[vi * 3 + 2] };
  }

  /* ═══ 2D CANVAS ═══ */
  function fit2D() {
    if (!cache || !uvCanvas) return;
    const r = uvCanvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    // Внутренний buffer canvas — под фактические CSS-размеры × DPR.
    // canvas позиционируется через CSS `top:34px;left:0;right:0;bottom:0`
    // (полоса под лейбл «3D»/«2D» сверху pane), getBoundingClientRect
    // возвращает фактический ректанг — fit2D и render2D подхватят его
    // автоматически через ResizeObserver на pane.
    uvCanvas.width = Math.max(1, r.width * dpr);
    uvCanvas.height = Math.max(1, r.height * dpr);
    const F = cache.F, nF = cache.nF; const uv = cache.uv, valid = cache.valid;
    let mnx = 1e30, mny = 1e30, mxx = -1e30, mxy = -1e30;
    for (let fi = 0; fi < nF; fi++) {
      if (!valid[fi]) continue;
      for (let j = 0; j < 3; j++) {
        const vi = F[fi * 3 + j];
        const x = uv[vi * 2], y = uv[vi * 2 + 1];
        if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y;
      }
    }
    const W = r.width, H = r.height;
    // Уменьшенные поля: развёртка укрупнена, но оставляем отступ под шкалу (снизу/справа)
    // и под лейбл «2D · развёртка» сверху. Ruler-gutter слева/сверху = 22px (мм-линейка).
    const padL = 26, padT = 26, padR = 18, padB = 26;
    const sca = Math.min(
      (W - padL - padR) / Math.max(mxx - mnx, 1e-6),
      (H - padT - padB) / Math.max(mxy - mny, 1e-6)
    );
    view2.s = sca;
    // Центрируем точно по свободной области между линейками (а не по всему канвасу),
    // иначе развёртка визуально «съезжает» из-за того, что gutter слева/сверху шире.
    const cxCanvas = (padL + (W - padR)) / 2;
    const cyCanvas = (padT + (H - padB)) / 2;
    view2.tx = cxCanvas - ((mnx + mxx) / 2) * sca;
    view2.ty = cyCanvas + ((mny + mxy) / 2) * sca;
    rebuildUnfTx();
    unfTx.bbox = { mnx, mny, mxx, mxy };
    unfTx.gutter = { L: padL, T: padT, R: padR, B: padB };
    unfTx._fitScale = sca; // базовый «auto-fit» масштаб — для индикатора зума
  }
  function rebuildUnfTx() {
    const keep = unfTx || {};
    unfTx = {
      tx: u => u * view2.s + view2.tx,
      ty: v => -v * view2.s + view2.ty,
      inv_x: sx => (sx - view2.tx) / view2.s,
      inv_y: sy => -(sy - view2.ty) / view2.s,
      scale: view2.s,
      // Сохраняем служебные поля (bbox/gutter/_fitScale), чтобы drawGrid2D
      // после wheel-зума/пана не потерял их.
      bbox: keep.bbox,
      gutter: keep.gutter,
      _fitScale: keep._fitScale,
    };
  }

  /* ═══ Клампинг pan/zoom ═══════════════════════════════════════════════
   * Стратегия — как в обычных просмотрщиках изображений:
   *   • Если развёртка УМЕЩАЕТСЯ в окне (на нормальном/уменьшенном
   *     масштабе) — не даём ей выйти за края viewport'а: оба края фигуры
   *     остаются внутри видимой зоны.
   *   • Если развёртка БОЛЬШЕ окна (после зума) — наоборот, требуем чтобы
   *     фигура ПОЛНОСТЬЮ покрывала видимую зону: пустого фона по краям
   *     не должно быть. Хирург может панировать по большой развёртке,
   *     чтобы увидеть разные её части, но не может «оттащить» её и
   *     оставить пустоту между ней и краем окна.
   *
   * Математически оба случая — это одно ограничение «view2.tx между двумя
   * крайними значениями». Какое из них min, какое max — зависит от того,
   * шире фигура viewport'а или уже. Сортируем оба эндпоинта — получаем
   * универсальный кламп. Аналогично по Y. Вызывается из uv_onMouseMove
   * (пан) и uv_onWheel (зум), сразу после мутации view2.*, перед
   * rebuildUnfTx.
   * ════════════════════════════════════════════════════════════════════ */
  function clampView2() {
    if (!cache || !unfTx || !unfTx.bbox) return;
    const r = uvCanvas.getBoundingClientRect();
    const W = r.width, H = r.height;
    if (W < 1 || H < 1) return;
    const gut = unfTx.gutter || { L: 0, T: 0, R: 0, B: 0 };
    const b = unfTx.bbox;
    const s = view2.s;
    // Ось X. tx(u) = u·s + view2.tx.
    //   xA — позиция view2.tx, при которой левый край фигуры лежит ровно
    //        на левой границе видимой зоны (gut.L).
    //   xC — позиция view2.tx, при которой правый край фигуры лежит ровно
    //        на правой границе (W − gut.R).
    // Узкая фигура: xA < xC, диапазон [xA, xC] (фигура внутри окна).
    // Широкая фигура: xA > xC, диапазон [xC, xA] (фигура покрывает окно).
    const xA = gut.L - b.mnx * s;
    const xC = W - gut.R - b.mxx * s;
    const txMin = Math.min(xA, xC), txMax = Math.max(xA, xC);
    if (view2.tx < txMin) view2.tx = txMin;
    else if (view2.tx > txMax) view2.tx = txMax;
    // Ось Y (отражённая): ty(v) = −v·s + view2.ty.
    //   yA — view2.ty, при котором верх фигуры (mxy) лежит на gut.T.
    //   yC — view2.ty, при котором низ фигуры (mny) лежит на H − gut.B.
    const yA = gut.T + b.mxy * s;
    const yC = H - gut.B + b.mny * s;
    const tyMin = Math.min(yA, yC), tyMax = Math.max(yA, yC);
    if (view2.ty < tyMin) view2.ty = tyMin;
    else if (view2.ty > tyMax) view2.ty = tyMax;
  }

  function lerp(a, b, t) { return a + (b - a) * t; }
  function divergingRdBu(v, lo, hi) {
    const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
    if (t <= 0.5) { const u = t * 2; return 'rgba(' + (lerp(43,240,u)|0) + ',' + (lerp(90,240,u)|0) + ',' + (lerp(135,240,u)|0) + ',.85)'; }
    const u = (t - 0.5) * 2; return 'rgba(' + (lerp(240,178,u)|0) + ',' + (lerp(240,34,u)|0) + ',' + (lerp(240,34,u)|0) + ',.85)';
  }
  function plasmaR(v, lo, hi) {
    const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
    return 'rgba(' + (lerp(254,178,t)|0) + ',' + (lerp(248,34,t)|0) + ',' + (lerp(223,34,t)|0) + ',.85)';
  }
  function greenRing(r) {
    const t = Math.max(0, Math.min(1, r / 6));
    return 'rgba(' + (lerp(27,247,t)|0) + ',' + (lerp(120,252,t)|0) + ',' + (lerp(56,245,t)|0) + ',.82)';
  }
  function distortionColor(r) {
    if (isNaN(r)) return 'rgba(80,100,120,.3)';
    const v = Math.max(0, Math.min(2, r));
    if (v < 0.7)   { const t = (v - 0.3) / 0.4; return 'rgba(' + ((40+t*28)|0) + ',' + ((100+t*60)|0) + ',' + ((255-t*40)|0) + ',.85)'; }
    if (v <= 1.15) { const t = (v - 0.7) / 0.45; return 'rgba(0,' + ((200+t*55)|0) + ',' + ((136-t*8)|0) + ',.85)'; }
    if (v <= 1.5)  { const t = (v - 1.15) / 0.35; return 'rgba(' + ((t*255)|0) + ',' + ((255-t*70)|0) + ',' + ((128-t*94)|0) + ',.85)'; }
    const t = Math.min(1, (v - 1.5) / 0.5); return 'rgba(255,' + ((100-t*56)|0) + ',' + ((34+t*32)|0) + ',.85)';
  }

  function faceColor(fi) {
    // Патч-грани — яркий золотой базовый тон поверх zone-цвета.
    // Штриховка наложится отдельным проходом поверх в render2D.
    const isPatch = cache.patchFaceMask && cache.patchFaceMask[fi];
    if (colorMode === 'risk' && cache.face_edge_err_max) {
      // ГЛАВНЫЙ режим для измерений: зелёный <5%, жёлтый 5-10%, красный ≥10%.
      // Хирургу: в КРАСНЫХ зонах измерять нельзя — это окрестности разреза
      // перфорации и мелких граничных артефактов; алгоритм там искажает
      // arclength до 30-100%.
      if (isPatch) return 'rgba(255,207,102,.55)';
      const e = cache.face_edge_err_max[fi];
      if (isNaN(e) || !isFinite(e)) return 'rgba(80,100,120,.3)';
      return riskColor(e);
    }
    if (colorMode === 'L2' && cache.L2) {
      const v = cache.L2[fi];
      if (isPatch) return 'rgba(255,207,102,.55)';
      return isNaN(v) ? 'rgba(80,100,120,.3)' : divergingRdBu(v, 0.85, 1.15);
    }
    if (colorMode === 'iso' && cache.iso) {
      const v = cache.iso[fi];
      if (isPatch) return 'rgba(255,207,102,.55)';
      return isNaN(v) ? 'rgba(80,100,120,.3)' : plasmaR(v, 1.0, 1.5);
    }
    if (colorMode === 'ring' && cache.face_seam_ring) {
      if (isPatch) return 'rgba(255,207,102,.55)';
      return greenRing(cache.face_seam_ring[fi]);
    }
    if (showHeatmap && cache.distortion) return distortionColor(cache.distortion[fi]);
    const isDk = !document.body.classList.contains('light-theme');
    if (isPatch) return isDk ? 'rgba(255,207,102,.65)' : 'rgba(240,184,44,.75)';
    const zFill = isDk ? ['rgba(0,180,255,.75)', 'rgba(0,255,136,.7)', 'rgba(255,136,68,.75)']
                       : ['rgba(110,156,224,.85)', 'rgba(109,216,156,.85)', 'rgba(240,184,136,.85)'];
    return zFill[cache.zoneLabels[fi]];
  }

  /** Цветовая рампа для режима «риск измерения»:
   *    0%   — зелёный (надёжно)
   *    5%   — жёлтый (осторожно)
   *    10%+ — красный (не измерять)
   *  Между контрольными точками — плавная интерполяция в RGB.
   */
  function riskColor(err) {
    const isDk = !document.body.classList.contains('light-theme');
    const alpha = isDk ? 0.82 : 0.78;
    // точки рампы: [err, R, G, B]
    const stops = isDk
      ? [[0.00,  60, 200, 110],   // зелёный (надёжно)
         [0.05, 240, 210,  80],   // жёлтый (граница)
         [0.10, 240, 100,  60],   // оранжевый (опасно)
         [0.25, 210,  40,  60]]   // тёмно-красный (не измерять)
      : [[0.00, 110, 186, 130],
         [0.05, 228, 198,  90],
         [0.10, 228, 120,  80],
         [0.25, 190,  60,  80]];
    const e = Math.max(0, err);
    let i = 0;
    while (i < stops.length - 1 && e > stops[i + 1][0]) i++;
    const a = stops[i], b = stops[Math.min(i + 1, stops.length - 1)];
    const denom = Math.max(b[0] - a[0], 1e-9);
    const t = Math.max(0, Math.min(1, (e - a[0]) / denom));
    const R = Math.round(a[1] + (b[1] - a[1]) * t);
    const G = Math.round(a[2] + (b[2] - a[2]) * t);
    const B = Math.round(a[3] + (b[3] - a[3]) * t);
    return `rgba(${R},${G},${B},${alpha})`;
  }

  /** Адаптивная шкала-сетка (мм + см) поверх развёртки.
   *  — Шаг подбирается так, чтобы минорное деление на экране было ~8-14 px.
   *  — Рисуются три уровня: субминор (очень бледный), минор, мажор (жирный +
   *    подпись в мм или см).
   *  — По левому и верхнему краям — «линейка» с числами через каждое мажорное
   *    деление (как в графических редакторах).
   *  — В правом-нижнем углу — компактная подпись «1 дел = N мм» для быстрой
   *    визуальной калибровки при измерениях «на глаз».
   */
  function drawGrid2D(ctx, w, h) {
    if (!unfTx || !unfTx.scale) return;
    const isDk = !document.body.classList.contains('light-theme');
    const s = unfTx.scale; // px per mm
    const gut = unfTx.gutter || { L: 0, T: 0, R: 0, B: 0 };

    // ── Выбор адаптивного шага: ~10px на минорное деление ──────────────
    // Таблица «красивых» шагов в мм, с разметкой: subminor/minor/major.
    // major всегда кратен minor, minor всегда кратен subminor.
    //                subminor minor major  (все в мм)
    const steps = [
      [0.1,  0.5,  1],    // при очень крупном зуме: 0.1мм / 0.5мм / 1мм
      [0.2,  1,    5],    //                         0.2мм / 1мм   / 5мм
      [0.5,  1,    5],
      [1,    5,    10],
      [2,    10,   50],
      [5,    10,   50],
      [10,   50,   100],
      [20,   100,  500],
      [50,   100,  500],
      [100,  500,  1000],
    ];
    // Выбираем самый мелкий набор, у которого ОДНОВРЕМЕННО:
    //   • минорный шаг даёт ≥ 6 px (чтобы сетка не превращалась в заливку), и
    //   • мажорный шаг даёт ≥ 45 px (чтобы подписи на линейке не сливались).
    // Раньше было только первое условие — при zoom ×2 получали major=1мм
    // и подписи «35 36 37 38 …» шли почти вплотную, становясь нечитаемыми.
    let sub = 1, minor = 5, major = 10;
    if (_pngExporting) {
      // При экспорте PNG в реальном масштабе фиксируем классическую
      // миллиметровую сетку: 1мм-минор / 5мм-полу-мажор / 10мм-мажор.
      // Без этого drawGrid2D адаптивно подбирает шаги под высокий
      // pxPerMM и выбирает 0.5см-мажор — на распечатке это выглядит
      // как мелкая клетка, врачи отвыкли от такой разметки.
      sub = 1; minor = 5; major = 10;
    } else {
      for (const st of steps) {
        if (st[1] * s >= 6 && st[2] * s >= 45) {
          sub = st[0]; minor = st[1]; major = st[2]; break;
        }
        sub = st[0]; minor = st[1]; major = st[2];
      }
    }
    const subPx = sub * s;
    // Сохраняем выбранный major-шаг в unfTx, чтобы scale-bar использовал
    // ровно его (а не выбирал свой кандидат отдельно). Это гарантирует, что
    // длина бара = расстоянию между двумя соседними мажорными подписями
    // на сетке: бар и сетка ВСЕГДА совпадают пиксель-в-пиксель.
    unfTx.gridMajor = major;

    // ── Диапазон видимых мм-координат (по центру свободной зоны развёртки)
    const x0mm = unfTx.inv_x(gut.L);
    const x1mm = unfTx.inv_x(w - gut.R);
    const y0mm = unfTx.inv_y(gut.T);   // верх → большие y (ty отражает знак)
    const y1mm = unfTx.inv_y(h - gut.B);
    const xmin = Math.min(x0mm, x1mm), xmax = Math.max(x0mm, x1mm);
    const ymin = Math.min(y0mm, y1mm), ymax = Math.max(y0mm, y1mm);

    // Старт — ближайшее кратное subminor «влево-вниз»
    const startX = Math.floor(xmin / sub) * sub;
    const startY = Math.floor(ymin / sub) * sub;

    const tx = unfTx.tx, ty = unfTx.ty;

    // Цвета по теме
    const cSub    = isDk ? 'rgba(255,255,255,0.035)' : 'rgba(80,110,160,0.07)';
    const cMinor  = isDk ? 'rgba(120,200,240,0.09)'  : 'rgba(80,130,180,0.14)';
    const cMajor  = isDk ? 'rgba(140,220,255,0.22)'  : 'rgba(60,110,170,0.28)';
    const cLabel  = isDk ? 'rgba(160,220,240,0.85)'  : 'rgba(40,80,130,0.88)';
    const cRuler  = isDk ? 'rgba(0,10,20,0.55)'      : 'rgba(255,255,255,0.62)';
    const cRulerB = isDk ? 'rgba(0,240,255,0.22)'    : 'rgba(60,110,170,0.28)';

    ctx.save();
    // Скроем сетку только внутри содержимого-зоны (чтоб не лезла на линейки)
    ctx.beginPath();
    ctx.rect(gut.L, gut.T, Math.max(1, w - gut.L - gut.R), Math.max(1, h - gut.T - gut.B));
    ctx.clip();

    // ── Субминорные вертикали ──────────────────────────────────────────
    // Пропускаем субминор, если они «слипаются» (< 3 px)
    const drawSub = subPx >= 3;
    if (drawSub) {
      ctx.strokeStyle = cSub; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let v = startX; v <= xmax + 1e-6; v += sub) {
        const sx = Math.round(tx(v)) + 0.5;
        ctx.moveTo(sx, gut.T); ctx.lineTo(sx, h - gut.B);
      }
      for (let v = startY; v <= ymax + 1e-6; v += sub) {
        const sy = Math.round(ty(v)) + 0.5;
        ctx.moveTo(gut.L, sy); ctx.lineTo(w - gut.R, sy);
      }
      ctx.stroke();
    }

    // ── Минорные ──────────────────────────────────────────────────────
    ctx.strokeStyle = cMinor; ctx.lineWidth = 1;
    ctx.beginPath();
    const startXm = Math.floor(xmin / minor) * minor;
    const startYm = Math.floor(ymin / minor) * minor;
    for (let v = startXm; v <= xmax + 1e-6; v += minor) {
      const sx = Math.round(tx(v)) + 0.5;
      ctx.moveTo(sx, gut.T); ctx.lineTo(sx, h - gut.B);
    }
    for (let v = startYm; v <= ymax + 1e-6; v += minor) {
      const sy = Math.round(ty(v)) + 0.5;
      ctx.moveTo(gut.L, sy); ctx.lineTo(w - gut.R, sy);
    }
    ctx.stroke();

    // ── Мажорные ──────────────────────────────────────────────────────
    ctx.strokeStyle = cMajor; ctx.lineWidth = 1.1;
    ctx.beginPath();
    const startXM = Math.ceil(xmin / major) * major;
    const startYM = Math.ceil(ymin / major) * major;
    for (let v = startXM; v <= xmax + 1e-6; v += major) {
      const sx = Math.round(tx(v)) + 0.5;
      ctx.moveTo(sx, gut.T); ctx.lineTo(sx, h - gut.B);
    }
    for (let v = startYM; v <= ymax + 1e-6; v += major) {
      const sy = Math.round(ty(v)) + 0.5;
      ctx.moveTo(gut.L, sy); ctx.lineTo(w - gut.R, sy);
    }
    ctx.stroke();

    ctx.restore();

    // ── Линейки по краям (ruler-gutter): левая и верхняя полосы ─────────
    ctx.save();
    ctx.fillStyle = cRuler;
    ctx.fillRect(0, 0, w, gut.T);
    ctx.fillRect(0, 0, gut.L, h);
    // Лёгкая разделительная линия
    ctx.strokeStyle = cRulerB; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(gut.L + 0.5, 0); ctx.lineTo(gut.L + 0.5, h);
    ctx.moveTo(0, gut.T + 0.5); ctx.lineTo(w, gut.T + 0.5);
    ctx.stroke();

    // Риски и подписи на линейках. Подписываем каждый major, мелкие деления —
    // короткие (2-3 px), major — до края gutter'а.
    ctx.strokeStyle = cLabel; ctx.fillStyle = cLabel;
    ctx.font = '9px "Share Tech Mono", "Consolas", monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';

    // Верхняя линейка (X)
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let v = startXm; v <= xmax + 1e-6; v += minor) {
      const sx = Math.round(tx(v)) + 0.5;
      if (sx < gut.L || sx > w - gut.R) continue;
      ctx.moveTo(sx, gut.T - 3); ctx.lineTo(sx, gut.T);
    }
    ctx.stroke();
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let v = startXM; v <= xmax + 1e-6; v += major) {
      const sx = Math.round(tx(v)) + 0.5;
      if (sx < gut.L || sx > w - gut.R) continue;
      ctx.moveTo(sx, gut.T - 7); ctx.lineTo(sx, gut.T);
    }
    ctx.stroke();
    // Подписи на верхней линейке — ВСЕГДА в сантиметрах, независимо от зума.
    // При шаге сетки 10мм видим «1, 2, 3...», при шаге 5мм — «0.5, 1.0, 1.5...»,
    // при шаге 1мм (очень крупный зум) — «0.1, 0.2, 0.3...». Это убирает путаницу,
    // когда хирург видит «50» рядом с масштабной линейкой «1 см» и не понимает,
    // что это: 50 см или 50 мм. Теперь все цифры на сетке — сантиметры. Точка.
    const labelOf = (v) => {
      // v приходит в мм; переводим в см
      const cm = v / 10;
      // Снап до 0.001см, чтобы не вылезали float-артефакты типа 1.499999
      const snap = Math.round(cm * 1000) / 1000;
      if (Math.abs(snap) < 1e-9) return '0';
      // Целые сантиметры — без дробной части ("1", "−2", "5")
      if (Math.abs(snap - Math.round(snap)) < 1e-6) return Math.round(snap).toString();
      // Десятые ("0.5", "1.5", "−2.5") — основной случай при шаге сетки 5 мм
      if (Math.abs(snap * 10 - Math.round(snap * 10)) < 1e-6) return snap.toFixed(1);
      // Сотые ("0.05", "0.15") — только при очень крупном зуме (major=1мм)
      return snap.toFixed(2);
    };
    // Подписи на верхней линейке — центрируем точно над засечкой. Раньше
    // было textAlign='left' с offset'ом +2 — подпись начиналась справа от
    // засечки, и из-за этого визуально казалось, что вся шкала уехала
    // вправо (особенно для длинных меток вроде «−2.5»). Теперь центр
    // подписи всегда строго над центром тика.
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    for (let v = startXM; v <= xmax + 1e-6; v += major) {
      const sx = Math.round(tx(v));
      if (sx < gut.L + 10 || sx > w - gut.R - 10) continue;
      ctx.fillText(labelOf(v), sx, gut.T - 8);
    }

    // Левая линейка (Y) — по вертикали, подписи поворачиваем на 90°
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let v = startYm; v <= ymax + 1e-6; v += minor) {
      const sy = Math.round(ty(v)) + 0.5;
      if (sy < gut.T || sy > h - gut.B) continue;
      ctx.moveTo(gut.L - 3, sy); ctx.lineTo(gut.L, sy);
    }
    ctx.stroke();
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let v = startYM; v <= ymax + 1e-6; v += major) {
      const sy = Math.round(ty(v)) + 0.5;
      if (sy < gut.T || sy > h - gut.B) continue;
      ctx.moveTo(gut.L - 7, sy); ctx.lineTo(gut.L, sy);
    }
    ctx.stroke();
    for (let v = startYM; v <= ymax + 1e-6; v += major) {
      const sy = Math.round(ty(v));
      if (sy < gut.T + 10 || sy > h - gut.B - 4) continue;
      ctx.save();
      // Центр подписи точно на уровне засечки (sy), без сдвига вверх.
      // textAlign='center' после поворота даёт центр по вертикали экрана,
      // textBaseline='alphabetic' даёт правый край базовой линии у tick'а.
      ctx.translate(gut.L - 8, sy);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(labelOf(v), 0, 0);
      ctx.restore();
    }

    // Единица в левом-верхнем углу (пересечение линеек) — всегда «см»,
    // чтобы не было прыжков мм↔см при изменении зума.
    ctx.fillStyle = isDk ? 'rgba(0,240,255,0.75)' : 'rgba(79,124,219,0.85)';
    ctx.font = 'bold 8px "Share Tech Mono","Consolas",monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('см', gut.L / 2, gut.T / 2);
    ctx.textBaseline = 'alphabetic';

    // ── Скоба-эталон в нижнем gutter'е ─────────────────────────────────
    // Горизонтальная скоба между двумя соседними мажорными делениями
    // сетки. Концы скобы сидят РОВНО на этих линиях — это буквально
    // часть сетки, а не отдельный плавающий бар. Хирург видит «вот
    // конкретно эта пара делений = X см» и больше не нужно мысленно
    // прикладывать линейку из угла к фигуре.
    // Позиция: левый край бутом-гаттера (там нет ни фигуры, ни кнопок).
    // Длина: ровно один шаг major — то есть всегда визуально совпадает
    // с расстоянием между подписями на оси.
    if (major) {
      // Ищем первую пару соседних мажорных линий, обе в видимой зоне.
      let firstV = null;
      for (let v = startXM; v <= xmax + 1e-6; v += major) {
        const sxA = Math.round(tx(v)) + 0.5;
        const sxB = Math.round(tx(v + major)) + 0.5;
        if (sxA >= gut.L + 4 && sxB <= w - gut.R - 4) {
          firstV = v; break;
        }
      }
      if (firstV !== null) {
        const sxL = Math.round(tx(firstV)) + 0.5;
        const sxR = Math.round(tx(firstV + major)) + 0.5;
        // Только если получившаяся пара не уезжает под кнопку «Вписать»
        // (которая в правом-нижнем углу занимает ~110px). Если первая
        // пара ушла бы под кнопку — пропускаем (скоба не отрисуется).
        if (sxR < w - 130) {
          const yBar = h - 9;             // на 9px от низа канваса
          const yCap = 4;                  // высота торцевых чёрточек
          ctx.save();
          ctx.strokeStyle = isDk ? 'rgba(0,240,255,.85)' : 'rgba(15,102,128,.85)';
          ctx.fillStyle = ctx.strokeStyle;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          // Торцы (вертикальные чёрточки на самих линиях сетки)
          ctx.moveTo(sxL, yBar - yCap); ctx.lineTo(sxL, yBar + yCap);
          ctx.moveTo(sxR, yBar - yCap); ctx.lineTo(sxR, yBar + yCap);
          // Горизонтальная перекладина
          ctx.moveTo(sxL, yBar); ctx.lineTo(sxR, yBar);
          ctx.stroke();
          // Подпись над скобой (внутри gutter'а)
          const cmRef = major / 10;
          const lbl = (Math.abs(cmRef - Math.round(cmRef)) < 1e-6
                        ? Math.round(cmRef).toString()
                        : (Math.abs(cmRef * 10 - Math.round(cmRef * 10)) < 1e-6
                            ? cmRef.toFixed(1)
                            : cmRef.toFixed(2))) + ' см';
          ctx.font = 'bold 9px "Share Tech Mono", "Consolas", monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'alphabetic';
          ctx.fillText(lbl, (sxL + sxR) / 2, yBar - 6);
          ctx.restore();
        }
      }
    }

    ctx.restore();
  }

  /* ═══════════════════════════════════════════════════════════════════
     ЭКСПОРТ РАЗВЁРТКИ В PNG С ТОЧНЫМ МАСШТАБОМ.

     Проблема: на экране зум/пан меняется — соотношение «пиксели → мм»
     зависит от того, как пользователь сейчас вписал картинку. Для
     печати или вставки в карту пациента нужен фиксированный масштаб,
     иначе линейкой по распечатке размер не сверишь.

     Решение: рендерим в ОТДЕЛЬНЫЙ оффскрин-канвас с фиксированным
     pxPerMM (по умолчанию 300 DPI ≈ 11.81 px/мм — стандарт печати).
     Размер канваса считается по bbox развёртки + поля под сетку и
     scale-bar. На время рендера временно подменяем uvCanvas/uvCtx/
     unfTx/view2, чтобы переиспользовать существующий render2D без
     дублирования кода (рисование граней, сетки, перфораций, замеров,
     флапа — всё одинаково).

     Контракт: 1 мм на меше = pxPerMM пикселей в PNG. При печати на
     принтере с DPI = pxPerMM × 25.4 получится физическое 1:1.
  ═══════════════════════════════════════════════════════════════════ */
  function exportUVAsPNG(opts) {
    if (!cache || !cache.uv) {
      _toast('Развёртка ещё не построена.', 'warn');
      return;
    }
    opts = opts || {};
    const pxPerMM = opts.pxPerMM || (300 / 25.4);   // 300 DPI ≈ 11.81 px/мм

    // bbox UV в мм
    const uv = cache.uv, valid = cache.valid, F = cache.F, nF = cache.nF;
    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
    for (let fi = 0; fi < nF; fi++) {
      if (!valid[fi]) continue;
      for (let j = 0; j < 3; j++) {
        const vi = F[fi * 3 + j];
        const u = uv[vi * 2], v = uv[vi * 2 + 1];
        if (u < mnx) mnx = u; if (u > mxx) mxx = u;
        if (v < mny) mny = v; if (v > mxy) mxy = v;
      }
    }
    if (!isFinite(mnx)) {
      _toast('Не удалось определить размер развёртки.', 'warn');
      return;
    }

    // Поля под сетку/подписи. Те же значения, что fit2D использует
    // (padL/padT/padR/padB) — иначе scale-bar и подписи на осях
    // обрежутся.
    const padL = 56, padT = 36, padR = 24, padB = 36;
    const meshW_px = (mxx - mnx) * pxPerMM;
    const meshH_px = (mxy - mny) * pxPerMM;
    const W = Math.ceil(meshW_px + padL + padR);
    const H = Math.ceil(meshH_px + padT + padB);

    // Лимит — чтобы не словить out-of-memory на огромных мешах
    const MAX_PX = 8000;
    if (W > MAX_PX || H > MAX_PX) {
      _toast('Слишком крупная развёртка для PNG (>8000px). Попробуйте уменьшить DPI.', 'warn');
      return;
    }

    // Создаём оффскрин-канвас и его контекст
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    // Подменяем uvCanvas/uvCtx/unfTx/view2 на время рендера. После —
    // восстанавливаем, чтобы on-screen рендер не сломался.
    const saved = {
      canvas: uvCanvas, ctx: uvCtx,
      view2: { tx: view2.tx, ty: view2.ty, s: view2.s },
      unfTx,
    };
    uvCanvas = off;
    uvCtx = off.getContext('2d');
    // view2: при pxPerMM=11.81 и UV в мм, формулы tx(u)=u*s+tx_view
    // должны дать «mnx → padL» и «mxy → padT» (Y отражена).
    view2 = {
      tx: padL - mnx * pxPerMM,
      ty: padT + mxy * pxPerMM,
      s: pxPerMM,
    };
    unfTx = {
      tx: u => u * view2.s + view2.tx,
      ty: v => -v * view2.s + view2.ty,
      inv_x: sx => (sx - view2.tx) / view2.s,
      inv_y: sy => -(sy - view2.ty) / view2.s,
      scale: pxPerMM,
      bbox: { mnx, mny, mxx, mxy },
      gutter: { L: padL, T: padT, R: padR, B: padB },
      _fitScale: pxPerMM,
    };
    // render2D внутри делает setTransform(dpr, 0, 0, dpr, 0, 0). Если dpr ≠ 1,
    // наши формулы view2.s = pxPerMM (logical) дадут pxPerMM × dpr physical px
    // на мм — то есть PNG получится в dpr раз крупнее «реального масштаба».
    // Чтобы 1 мм меша = ровно pxPerMM пикселей в физическом буфере PNG,
    // подменяем dpr на 1 на время экспорта. После — восстанавливаем.
    const savedDPR = window.devicePixelRatio;
    let dprPatched = false;
    try {
      Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
      dprPatched = true;
    } catch (_) {
      // Не configurable — корректируем view2.s, чтобы logical/physical совпали.
      // pxPerMM physical = view2.s × savedDPR → view2.s = pxPerMM / savedDPR.
      view2.s = pxPerMM / savedDPR;
      view2.tx = padL - mnx * view2.s;
      view2.ty = padT + mxy * view2.s;
      unfTx = {
        tx: u => u * view2.s + view2.tx,
        ty: v => -v * view2.s + view2.ty,
        inv_x: sx => (sx - view2.tx) / view2.s,
        inv_y: sy => -(sy - view2.ty) / view2.s,
        scale: view2.s,
        bbox: { mnx, mny, mxx, mxy },
        gutter: { L: padL, T: padT, R: padR, B: padB },
        _fitScale: view2.s,
      };
    }
    // С dpr=1: rect.width × dpr = rect.width × 1 = W = canvas.width ✓
    off.getBoundingClientRect = () => ({
      width: W, height: H,
      left: 0, top: 0, right: W, bottom: H,
    });

    try {
      _pngExporting = true;
      render2D();
      // Штамп вынесен в нижний gutter (раньше был сверху, наезжал на
      // подписи оси Y). Теперь — лево-низ, рядом со скобой «1 см».
      drawExportStamp(uvCtx, W, H, pxPerMM);
      _pngExporting = false;

      const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      const fname = 'razvertka_' + ts + '.png';
      const successToast = 'PNG сохранён · ' + W + '×' + H + 'px · ' +
            pxPerMM.toFixed(1) + ' px/мм (1:1 при печати ' +
            Math.round(pxPerMM * 25.4) + ' DPI)';

      off.toBlob(async (blob) => {
        if (!blob) {
          _toast('Не удалось сгенерировать PNG.', 'warn');
          restore();
          return;
        }
        // Современный путь — File System Access API. Открывает системный
        // диалог «Сохранить как…», врач сам выбирает папку и имя.
        // Поддержан в Chrome/Edge/Opera/Brave; Firefox и Safari — нет,
        // там fallback через <a download>.
        if (typeof window.showSaveFilePicker === 'function') {
          try {
            const handle = await window.showSaveFilePicker({
              suggestedName: fname,
              types: [{
                description: 'PNG-изображение',
                accept: { 'image/png': ['.png'] },
              }],
            });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            _toast(successToast, 'ok', 4000);
          } catch (err) {
            // AbortError = пользователь отменил диалог. Это не ошибка,
            // тост не нужен. Все остальные исключения — реальный сбой.
            if (err && err.name !== 'AbortError') {
              console.warn('[tab4] showSaveFilePicker failed, fallback:', err);
              fallbackDownload(blob, fname, successToast);
            }
          }
          restore();
          return;
        }
        // Fallback: старый <a download> — Firefox/Safari/старые Chrome.
        // Файл попадает в папку «Загрузки» без диалога.
        fallbackDownload(blob, fname, successToast);
        restore();
      }, 'image/png');
    } catch (e) {
      console.error('[tab4] PNG export failed:', e);
      _toast('Ошибка экспорта: ' + e.message, 'warn');
      _pngExporting = false;
      restore();
    }

    function fallbackDownload(blob, fname, toastTxt) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fname;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      _toast(toastTxt, 'ok', 4000);
    }

    function restore() {
      _pngExporting = false;
      uvCanvas = saved.canvas;
      uvCtx = saved.ctx;
      view2 = saved.view2;
      unfTx = saved.unfTx;
      if (dprPatched) {
        try { Object.defineProperty(window, 'devicePixelRatio', { value: savedDPR, configurable: true }); } catch (_) {}
      }
      // Восстановить on-screen рендер
      render2D();
    }
  }

  /* Маленький штамп в нижнем-правом углу PNG: дата экспорта и реальный
     масштаб. Помогает врачу понять, что распечатка действительно 1:1
     и при сомнении приложить линейку к scale-bar'у. Раньше штамп стоял
     сверху и наезжал на подписи оси Y — теперь сидит в правом нижнем
     gutter'е, где обычно индикатор зума «×1.00». */
  function drawExportStamp(ctx, W, H, pxPerMM) {
    const dpi = Math.round(pxPerMM * 25.4);
    const ts = new Date().toLocaleString('ru-RU', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
    const isDk = !document.body.classList.contains('light-theme');
    ctx.save();
    ctx.font = '10px "Share Tech Mono","Consolas",monospace';
    ctx.fillStyle = isDk ? 'rgba(0,240,255,.55)' : 'rgba(15,102,128,.65)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    // Сразу две строки: верхняя — масштаб, нижняя — дата. Привязка
    // к нижнему gutter'у (Y близко к H), рядом с правым краем (X = W - 14).
    ctx.fillText('масштаб 1:1 при печати ' + dpi + ' DPI', W - 14, H - 26);
    ctx.fillText('NASAL UNWRAP · ' + ts, W - 14, H - 14);
    ctx.restore();
  }

  function render2D() {
    if (!cache || !uvCtx || !unfTx) return;
    // Safety net: если 2D pane поменял размер с момента последнего fit2D
    // (например, закрылась левая панель, дёрнули сплиттер, или ResizeObserver
    // пропустил event), внутренний buffer canvas'а устарел. Перефитим сейчас,
    // чтобы сетка/меш/scale-bar рисовались под правильную ширину.
    const _r = uvCanvas.getBoundingClientRect();
    const _dpr = window.devicePixelRatio || 1;
    const _wantW = Math.max(1, Math.round(_r.width * _dpr));
    const _wantH = Math.max(1, Math.round(_r.height * _dpr));
    if (Math.abs(uvCanvas.width - _wantW) > 2 || Math.abs(uvCanvas.height - _wantH) > 2) {
      fit2D();
    }
    const ctx = uvCtx; const W = uvCanvas.width, H = uvCanvas.height;
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = W / dpr, h = H / dpr;

    const isDk = !document.body.classList.contains('light-theme');
    ctx.fillStyle = isDk ? '#0b1220' : '#fdfdfe';
    ctx.fillRect(0, 0, w, h);

    // Сетка-линейка в мм/см рисуется ПОД гранями — чтобы не мешать цветам,
    // но всё равно помогала оценивать размеры на развёртке «на глаз».
    drawGrid2D(ctx, w, h);

    const F = cache.F, nF = cache.nF; const uv = cache.uv, valid = cache.valid;
    const tx = unfTx.tx, ty = unfTx.ty;

    for (let fi = 0; fi < nF; fi++) {
      if (!valid[fi]) continue;
      const i0 = F[fi * 3], i1 = F[fi * 3 + 1], i2 = F[fi * 3 + 2];
      const col = faceColor(fi);
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(tx(uv[i0 * 2]), ty(uv[i0 * 2 + 1]));
      ctx.lineTo(tx(uv[i1 * 2]), ty(uv[i1 * 2 + 1]));
      ctx.lineTo(tx(uv[i2 * 2]), ty(uv[i2 * 2 + 1]));
      ctx.closePath();
      ctx.fill();
      // При экспорте PNG обводим треугольник тем же цветом, что и заливка.
      // Это устраняет thin seams от anti-aliasing'а на стыках треугольников
      // одного цвета. На экране эффект незаметен (низкий dpr), но в PNG
      // 300 DPI видна паутина из тонких линий по всему мешу.
      if (_pngExporting) {
        ctx.strokeStyle = col;
        ctx.lineWidth = 0.6;
        ctx.stroke();
      }
    }

    // v5: красная обводка септум-перфораций поверх faces, ПОД measurement-
    // overlay'ями (ruler/polygon). Вызов drawPerforations определён ниже в
    // закрывающем блоке IIFE — видит closure-переменные cache/unfTx.
    drawPerforations(ctx);
    // v5: полупрозрачный эллипс/прямоугольник лоскута (если открыта симуляция)
    drawFlap(ctx);

    // Штриховка на патч-гранях — чтобы было видно, где "залатано".
    if (cache.patchFaceMask) {
      ctx.save();
      // Создаём паттерн из диагональных линий.
      const pc = document.createElement('canvas');
      pc.width = 10; pc.height = 10;
      const pcx = pc.getContext('2d');
      pcx.strokeStyle = isDk ? 'rgba(255,207,102,.55)' : 'rgba(180,120,0,.55)';
      pcx.lineWidth = 0.9;
      pcx.beginPath();
      pcx.moveTo(-2, 12); pcx.lineTo(12, -2);
      pcx.stroke();
      ctx.fillStyle = ctx.createPattern(pc, 'repeat');
      for (let fi = 0; fi < nF; fi++) {
        if (!valid[fi] || !cache.patchFaceMask[fi]) continue;
        const i0 = F[fi * 3], i1 = F[fi * 3 + 1], i2 = F[fi * 3 + 2];
        ctx.beginPath();
        ctx.moveTo(tx(uv[i0 * 2]), ty(uv[i0 * 2 + 1]));
        ctx.lineTo(tx(uv[i1 * 2]), ty(uv[i1 * 2 + 1]));
        ctx.lineTo(tx(uv[i2 * 2]), ty(uv[i2 * 2 + 1]));
        ctx.closePath(); ctx.fill();
      }
      // Яркий золотой контур вокруг патча.
      ctx.strokeStyle = isDk ? '#ffcf66' : '#c08200';
      ctx.lineWidth = 1.2;
      if (isDk) { ctx.shadowColor = '#ffcf66'; ctx.shadowBlur = 5; }
      for (let fi = 0; fi < nF; fi++) {
        if (!valid[fi] || !cache.patchFaceMask[fi]) continue;
        const i0 = F[fi * 3], i1 = F[fi * 3 + 1], i2 = F[fi * 3 + 2];
        ctx.beginPath();
        ctx.moveTo(tx(uv[i0 * 2]), ty(uv[i0 * 2 + 1]));
        ctx.lineTo(tx(uv[i1 * 2]), ty(uv[i1 * 2 + 1]));
        ctx.lineTo(tx(uv[i2 * 2]), ty(uv[i2 * 2 + 1]));
        ctx.closePath(); ctx.stroke();
      }
      ctx.shadowBlur = 0;
      ctx.restore();
    }

    if (cache.seam_edges) {
      ctx.lineWidth = 1.3;
      for (const [a, b, zlo, zhi] of cache.seam_edges) {
        if (zlo === 0 && zhi === 1) ctx.strokeStyle = isDk ? '#ff3b6b' : '#d63856';
        else if (zlo === 1 && zhi === 2) ctx.strokeStyle = isDk ? '#36c3ff' : '#0088cc';
        else ctx.strokeStyle = isDk ? '#ffcf66' : '#cc9933';
        ctx.beginPath();
        ctx.moveTo(tx(uv[a * 2]), ty(uv[a * 2 + 1]));
        ctx.lineTo(tx(uv[b * 2]), ty(uv[b * 2 + 1]));
        ctx.stroke();
      }
    }

    // Граничные рёбра меша — тонкая cyan-обводка по контуру открытых
    // граней. На экране даёт «чёткий силуэт». При PNG-экспорте — лишний
    // шум: все 5000+ граничных сегментов рисуются 1px, что выглядит как
    // зубчатый муар. Поэтому при экспорте пропускаем.
    if (!_pngExporting) {
      const ec = new Map(), ve = new Set();
      for (let fi = 0; fi < nF; fi++) {
        for (let j = 0; j < 3; j++) {
          let a = F[fi * 3 + j], b = F[fi * 3 + (j + 1) % 3];
          const k = a < b ? a + '_' + b : b + '_' + a;
          ec.set(k, (ec.get(k) || 0) + 1);
        }
        if (valid[fi]) for (let j = 0; j < 3; j++) {
          let a = F[fi * 3 + j], b = F[fi * 3 + (j + 1) % 3];
          ve.add(a < b ? a + '_' + b : b + '_' + a);
        }
      }
      ctx.strokeStyle = isDk ? 'rgba(0,240,255,.35)' : '#6B7280'; ctx.lineWidth = 1;
      for (const [k, cnt] of ec) {
        if (cnt !== 1 || !ve.has(k)) continue;
        const [a, b] = k.split('_').map(Number);
        ctx.beginPath();
        ctx.moveTo(tx(uv[a * 2]), ty(uv[a * 2 + 1]));
        ctx.lineTo(tx(uv[b * 2]), ty(uv[b * 2 + 1]));
        ctx.stroke();
      }
    }

    if (selectedFaces) {
      ctx.fillStyle = isDk ? 'rgba(0,240,255,.22)' : 'rgba(79,124,219,.22)';
      ctx.strokeStyle = isDk ? 'rgba(0,240,255,.55)' : 'rgba(79,124,219,.7)'; ctx.lineWidth = 0.5;
      for (let fi = 0; fi < nF; fi++) {
        if (!valid[fi] || !selectedFaces[fi]) continue;
        const i0 = F[fi * 3], i1 = F[fi * 3 + 1], i2 = F[fi * 3 + 2];
        ctx.beginPath();
        ctx.moveTo(tx(uv[i0 * 2]), ty(uv[i0 * 2 + 1]));
        ctx.lineTo(tx(uv[i1 * 2]), ty(uv[i1 * 2 + 1]));
        ctx.lineTo(tx(uv[i2 * 2]), ty(uv[i2 * 2 + 1]));
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
    }

    if (showOverlap && cache.overlapMap) {
      ctx.save(); ctx.globalAlpha = 0.35;
      ctx.fillStyle = isDk ? 'rgba(255,68,102,.18)' : 'rgba(255,0,50,.14)';
      for (let fi = 0; fi < nF; fi++) {
        if (!valid[fi] || !cache.overlapMap[fi]) continue;
        const i0 = F[fi * 3], i1 = F[fi * 3 + 1], i2 = F[fi * 3 + 2];
        ctx.beginPath();
        ctx.moveTo(tx(uv[i0 * 2]), ty(uv[i0 * 2 + 1]));
        ctx.lineTo(tx(uv[i1 * 2]), ty(uv[i1 * 2 + 1]));
        ctx.lineTo(tx(uv[i2 * 2]), ty(uv[i2 * 2 + 1]));
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }

    if (inspectedFace >= 0 && valid[inspectedFace] && !_pngExporting) {
      const i0 = F[inspectedFace * 3], i1 = F[inspectedFace * 3 + 1], i2 = F[inspectedFace * 3 + 2];
      ctx.fillStyle = isDk ? 'rgba(255,207,102,.6)' : 'rgba(255,180,44,.55)';
      ctx.strokeStyle = isDk ? '#ffcf66' : '#e69b00'; ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(tx(uv[i0 * 2]), ty(uv[i0 * 2 + 1]));
      ctx.lineTo(tx(uv[i1 * 2]), ty(uv[i1 * 2 + 1]));
      ctx.lineTo(tx(uv[i2 * 2]), ty(uv[i2 * 2 + 1]));
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }

    if (lassoDrawing && lassoPath.length > 1 && !_pngExporting) {
      ctx.strokeStyle = isDk ? 'rgba(0,240,255,.85)' : 'rgba(79,124,219,.85)'; ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]); ctx.beginPath();
      ctx.moveTo(lassoPath[0].x, lassoPath[0].y);
      for (let i = 1; i < lassoPath.length; i++) ctx.lineTo(lassoPath[i].x, lassoPath[i].y);
      ctx.stroke(); ctx.setLineDash([]);
    }

    if (polygonPts.length >= 1) {
      const polyColor = '#00f0ff';
      if (polygonPts.length >= 2) {
        ctx.strokeStyle = polyColor; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(tx(polygonPts[0].u), ty(polygonPts[0].v));
        for (let i = 1; i < polygonPts.length; i++) ctx.lineTo(tx(polygonPts[i].u), ty(polygonPts[i].v));
        if (polygonPts.length >= 3) ctx.lineTo(tx(polygonPts[0].u), ty(polygonPts[0].v));
        ctx.stroke();
        if (polygonPts.length >= 3) {
          ctx.fillStyle = 'rgba(0,240,255,.1)';
          ctx.beginPath(); ctx.moveTo(tx(polygonPts[0].u), ty(polygonPts[0].v));
          for (let i = 1; i < polygonPts.length; i++) ctx.lineTo(tx(polygonPts[i].u), ty(polygonPts[i].v));
          ctx.closePath(); ctx.fill();
        }
      }
      polygonPts.forEach((p, i) => {
        const sx = tx(p.u), sy = ty(p.v);
        ctx.fillStyle = polyColor;
        ctx.beginPath(); ctx.arc(sx, sy, 5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = isDk ? '#0b1220' : '#fff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(sx, sy, 5, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = isDk ? '#0b1220' : '#fff';
        ctx.font = 'bold 9px "Share Tech Mono", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText((i + 1).toString(), sx, sy + 1);
        ctx.textBaseline = 'alphabetic';
      });
    }

    if (rulerChainPts.length >= 1) {
      const rcColor = '#ffaa33';
      if (rulerChainPts.length >= 2) {
        for (let k = 0; k < rulerChainPts.length - 1; k++) {
          const a = rulerChainPts[k].vi, b = rulerChainPts[k + 1].vi;
          if (a === b) continue;
          const res = dijkstraPath(a, b);
          ctx.strokeStyle = rcColor; ctx.lineWidth = 2.2;
          ctx.beginPath(); ctx.moveTo(tx(uv[res.path[0] * 2]), ty(uv[res.path[0] * 2 + 1]));
          for (let i = 1; i < res.path.length; i++) ctx.lineTo(tx(uv[res.path[i] * 2]), ty(uv[res.path[i] * 2 + 1]));
          ctx.stroke();
          const mi = Math.floor(res.path.length / 2);
          const mx2 = tx(uv[res.path[mi] * 2]), my2 = ty(uv[res.path[mi] * 2 + 1]);
          const dText = res.dist.toFixed(1) + ' мм';
          ctx.font = 'bold 10px "Share Tech Mono", monospace';
          const tw = ctx.measureText(dText).width;
          ctx.fillStyle = 'rgba(255,170,51,.9)';
          ctx.fillRect(mx2 - tw / 2 - 4, my2 - 18, tw + 8, 16);
          ctx.fillStyle = '#0b1220'; ctx.textAlign = 'center'; ctx.fillText(dText, mx2, my2 - 6);
        }
      }
      rulerChainPts.forEach(p => {
        const sx = tx(p.ux), sy = ty(p.uy);
        ctx.fillStyle = rcColor;
        ctx.beginPath(); ctx.arc(sx, sy, 5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = isDk ? '#0b1220' : '#fff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(sx, sy, 5, 0, Math.PI * 2); ctx.stroke();
      });
    }

    if (rulerPts.length >= 1) {
      ctx.fillStyle = '#ff4466';
      for (const p of rulerPts) {
        ctx.beginPath(); ctx.arc(tx(p.ux), ty(p.uy), 5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = isDk ? '#0b1220' : '#fff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(tx(p.ux), ty(p.uy), 5, 0, Math.PI * 2); ctx.stroke();
      }
    }
    if (rulerPts.length === 2 && cache._rulerPath) {
      const rp = cache._rulerPath;
      ctx.strokeStyle = '#ff4466'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(tx(uv[rp[0] * 2]), ty(uv[rp[0] * 2 + 1]));
      for (let i = 1; i < rp.length; i++) ctx.lineTo(tx(uv[rp[i] * 2]), ty(uv[rp[i] * 2 + 1]));
      ctx.stroke();
      const mi = Math.floor(rp.length / 2);
      const mx2 = tx(uv[rp[mi] * 2]), my2 = ty(uv[rp[mi] * 2 + 1]);
      const dText = cache._rulerDist.toFixed(1) + ' мм';
      ctx.font = 'bold 11px "Share Tech Mono", monospace';
      const tw = ctx.measureText(dText).width;
      ctx.fillStyle = 'rgba(255,68,102,.9)';
      ctx.fillRect(mx2 - tw / 2 - 5, my2 - 20, tw + 10, 18);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(dText, mx2, my2 - 8);
    }

    // Мульти-замер: рисуем все накопленные отрезки + pending-точку,
    // если врач уже поставил A, но ещё не поставил B.
    drawMeasureLinesOnUV(ctx, tx, ty, isDk);

    if (unfTx.scale) {
      // Масштабный бар убран намеренно: сама сетка с подписанными
      // мажорными делениями («0, 1, 2, 3...» см) — это уже калибровочная
      // линейка. Скоба-эталон в нижнем gutter'е плюс подписи на сетке
      // дают полный масштабный контекст без отдельного плавающего бара.
      //
      // Оставляем только индикатор зума — он информирует о масштабе
      // («×1.00») и подсказывает клавишу F при отклонении от вписанного.
      const fit0 = unfTx.scale / (unfTx._fitScale || unfTx.scale);
      const atFit = Math.abs(fit0 - 1) < 0.02;
      ctx.textAlign = 'right';
      if (atFit) {
        ctx.font = 'bold 10px "Share Tech Mono", monospace';
        ctx.fillStyle = isDk ? 'rgba(0,240,255,.55)' : 'rgba(15,102,128,.65)';
        ctx.fillText('×' + fit0.toFixed(2), w - 14, h - 14);
      } else {
        ctx.font = 'bold 11px "Share Tech Mono", monospace';
        ctx.fillStyle = isDk ? '#ffaa33' : '#c2701c';
        ctx.fillText('×' + fit0.toFixed(2) + '  (F = вписать)', w - 14, h - 14);
      }
    }

    ctx.restore();
  }

  /* ═══════════════════════════════════════════════════════════ UV HANDLERS ═══ */
  function uvCanvasCoords(e) {
    const r = uvCanvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function uv_onMouseDown(e) {
    if (!cache || !unfTx) return;
    const p = uvCanvasCoords(e);

    // ── Пан развёртки: средняя кнопка ИЛИ Shift+ЛКМ ─────────────────────
    //   • инструменты измерения при этом НЕ активируются;
    //   • сетка-линейка перестраивается через render2D();
    //   • выходим до логики инструментов, чтобы клик не утёк в polygon/ruler.
    if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
      e.preventDefault();
      uvPanning = true;
      uvPanLX = e.clientX; uvPanLY = e.clientY;
      document.body.classList.add('t4-uv-panning');
      return;
    }

    // ПКМ — no-op
    if (e.button === 2) return;

    // v5: если открыта симуляция лоскута — клик по нему начинает drag.
    // Drag state хранится в _flapDrag для корректного onMouseMove.
    if (e.button === 0 && _flap && unfTx) {
      const ux_ = unfTx.inv_x(p.x), uy_ = unfTx.inv_y(p.y);
      if (flapHitTest(ux_, uy_)) {
        _flapDrag = { startUX: ux_, startUY: uy_, origCX: _flap.cx, origCY: _flap.cy };
        return;
      }
    }

    // v5: hit-test септум-перфорации. Работает В ЛЮБОМ режиме инструмента,
    // включая 'pointer' (навигация) — перфорация приоритетнее обычных
    // измерительных инструментов, т.к. это клинически значимая клик-зона.
    if (e.button === 0 && cache && cache.perforations && cache.perforations.length) {
      const ux_ = unfTx.inv_x(p.x), uy_ = unfTx.inv_y(p.y);
      const perfHit = hitTestPerforation(ux_, uy_);
      if (perfHit) {
        showPerforationReadout(perfHit);
        return;
      }
    }

    // Навигация — дальше никакого инструмента не активируем
    if (activeTool === 'pointer') return;
    if (activeTool === 'lasso') {
      lassoPath = [p]; lassoDrawing = true; selectedFaces = null;
      hideMeasFloat(); render2D();
      return;
    }
    if (activeTool === 'patch') {
      // Залатать дырку под кликом. Клик принимается ВНУТРИ пустой зоны
      // (не обязательно попадать в какую-то грань).
      const ux = unfTx.inv_x(p.x), uy = unfTx.inv_y(p.y);
      patchAtUVPoint(ux, uy);
      return;
    }
    const ux = unfTx.inv_x(p.x), uy = unfTx.inv_y(p.y);
    const vi = nearestVertexUV(ux, uy);
    if (vi < 0) return;

    // v6.2: для линейки — блок если клик попал в overlap-грань
    // (грань через одну из её 3 вершин, ИЛИ ближайшая overlap-грань рядом).
    if ((activeTool === 'ruler' || activeTool === 'rulerchain') && cache.overlapMap) {
      const F = cache.F, nF = cache.nF;
      let blocked = false;
      // быстрая проверка: любая overlap-грань, содержащая ближайшую вершину
      for (let fi = 0; fi < nF; fi++) {
        if (!cache.overlapMap[fi]) continue;
        if (F[fi*3] === vi || F[fi*3+1] === vi || F[fi*3+2] === vi) {
          blocked = true; break;
        }
      }
      if (blocked) {
        _toast('Здесь развёртка ненадёжна (UV-перекрытие). Измерения недостоверны.', 'warn');
        return;
      }
    }

    if (activeTool === 'polygon') {
      polygonPts.push(makePoint(vi));
      if (polygonPts.length >= 3) {
        measurementResult = measurePolygonV2(polygonPts);
        selectedFaces = measurementResult.selected;
        showPolygonMeasurement(measurementResult);
      }
      render3DAnnotations(); render2D();
    } else if (activeTool === 'ruler') {
      if (rulerPts.length >= 2) { rulerPts = []; cache._rulerPath = null; cache._rulerDist = 0; hideMeasFloat(); }
      rulerPts.push({ vi, ux: cache.uv[vi * 2], uy: cache.uv[vi * 2 + 1] });
      if (rulerPts.length === 2) {
        const res = dijkstraPath(rulerPts[0].vi, rulerPts[1].vi);
        cache._rulerPath = res.path; cache._rulerDist = res.dist;
        showRulerReadout();
      }
      render3DAnnotations(); render2D();
    } else if (activeTool === 'rulerchain') {
      rulerChainPts.push({ vi, ux: cache.uv[vi * 2], uy: cache.uv[vi * 2 + 1] });
      if (rulerChainPts.length >= 2) showChainReadout();
      render3DAnnotations(); render2D();
    } else if (activeTool === 'measure') {
      // Точная привязка: используем барицентрические координаты грани
      // под кликом, интерполируем 3D-точку. ux/uy уже посчитаны выше
      // (строка `const ux = unfTx.inv_x(p.x), uy = unfTx.inv_y(p.y)`).
      const pp = pickPrecisePoint({ uv: { ux, uy } });
      if (pp) handleMeasureClick(pp);
      render3DAnnotations(); render2D();
    }
  }

  function uv_onMouseMove(e) {
    if (!cache || !unfTx) return;
    // v5: перетаскивание флапа в симуляторе
    if (_flapDrag && _flap) {
      const p = uvCanvasCoords(e);
      const ux = unfTx.inv_x(p.x), uy = unfTx.inv_y(p.y);
      _flap.cx = _flapDrag.origCX + (ux - _flapDrag.startUX);
      _flap.cy = _flapDrag.origCY + (uy - _flapDrag.startUY);
      // renderFlapPanel() здесь не нужен: после удаления «покрытия»
      // ничего в панели НЕ зависит от cx/cy (только от rx/ry/shape).
      // Лишний рендер каждый пиксель драга вызывал моргание панели.
      render2D();
      return;
    }
    // Пан развёртки
    if (uvPanning) {
      const dx = e.clientX - uvPanLX, dy = e.clientY - uvPanLY;
      uvPanLX = e.clientX; uvPanLY = e.clientY;
      view2.tx += dx;
      view2.ty += dy;
      clampView2();        // мягко удержать фигуру в окне
      rebuildUnfTx();
      render2D();
      return;
    }
    if (activeTool === 'lasso' && lassoDrawing) {
      lassoPath.push(uvCanvasCoords(e));
      render2D();
      return;
    }
    // Биективный hover: всегда отслеживаем грань под курсором.
    const p = uvCanvasCoords(e);
    const ux = unfTx.inv_x(p.x), uy = unfTx.inv_y(p.y);
    const fi = findFaceAtUV(ux, uy);
    setHoveredFace(fi);
    if (fi >= 0) positionCursorTip(e.clientX, e.clientY, fi);
    else         hideCursorTip();
  }

  function uv_onMouseUp(e) {
    // v5: окончание drag'а флапа
    if (_flapDrag) { _flapDrag = null; return; }
    if (uvPanning) {
      uvPanning = false;
      document.body.classList.remove('t4-uv-panning');
      return;
    }
    if (activeTool === 'lasso' && lassoDrawing) {
      lassoDrawing = false;
      if (lassoPath.length < 3) { render2D(); return; }
      finalizeLasso();
    }
  }

  function uv_onMouseLeave(e) {
    if (uvPanning) {
      uvPanning = false;
      document.body.classList.remove('t4-uv-panning');
    }
    if (lassoDrawing) {
      lassoDrawing = false; lassoPath = []; render2D();
    }
    setHoveredFace(-1);
    hideCursorTip();
  }

  function uv_onDblClick(e) {
    if (!cache || !unfTx) return;
    // Завершить polygon, если он активен и его ≥3.
    if (activeTool === 'polygon' && polygonPts.length >= 3) {
      measurementResult = measurePolygonV2(polygonPts);
      selectedFaces = measurementResult.selected;
      showPolygonMeasurement(measurementResult);
      render2D(); render3DAnnotations();
      return;
    }
    const p = uvCanvasCoords(e);
    const ux = unfTx.inv_x(p.x), uy = unfTx.inv_y(p.y);
    const fi = findFaceAtUV(ux, uy);
    if (fi >= 0) {
      // Попали в грань — фокус 3D-камеры (старое поведение).
      focus3DOnFace(fi);
      return;
    }
    // Попали «мимо» — сбрасываем зум/пан к авто-fit.
    fit2D(); render2D();
  }

  function uv_onWheel(e) {
    // Зум 2D-развёртки к точке под курсором. Сетка-линейка автоматически
    // перестроится под новый масштаб. Колесо вверх — приблизить, вниз —
    // отдалить. Зажатый Ctrl — более тонкий шаг.
    //
    // ВЕРХНЯЯ ГРАНИЦА = fit×1.0 (вписанный масштаб). Это значит, что развёртка
    // ВСЕГДА умещается в окне целиком — её нельзя случайно «прокрутить» в
    // фигуру, которая больше viewport'а и обрезается по краям. Хирургу не
    // нужен глубокий зум для измерений: для них есть инструменты «Линейка»,
    // «Область» и подсказка под курсором с точными мм/см. Целая видимая
    // развёртка — важнее, чем возможность приблизить отдельный треугольник.
    //
    // НИЖНЯЯ ГРАНИЦА = fit×0.85 (можно чуть отдалить); при попытке уйти
    // дальше — авто-возврат к fit, чтобы развёртка не превратилась в точку
    // в углу.
    e.preventDefault();
    if (!cache || !unfTx) return;
    const p = uvCanvasCoords(e);
    const stepBase = e.ctrlKey ? 1.05 : 1.18;
    const factor = e.deltaY < 0 ? stepBase : 1 / stepBase;
    const uxBefore = unfTx.inv_x(p.x);
    const uyBefore = unfTx.inv_y(p.y);
    const fit = unfTx._fitScale || view2.s;
    const next = Math.max(fit * 0.85, Math.min(fit * 1.0, view2.s * factor));
    // Если упёрлись в нижнюю границу — автоматически возвращаемся к fit,
    // чтобы пользователь не видел «маленькую развёртку в углу».
    if (next <= fit * 0.86 && e.deltaY > 0) {
      fit2D(); render2D();
      return;
    }
    // Если уже на верхнем пределе и колесо «вверх» — wheel ничего не
    // меняет (next == текущий view2.s). Тихо выходим, не дёргаем render.
    if (Math.abs(next - view2.s) < 1e-6) return;
    view2.s = next;
    view2.tx = p.x - uxBefore * view2.s;
    view2.ty = p.y + uyBefore * view2.s;
    clampView2();          // удержать фигуру в окне после зума
    rebuildUnfTx();
    render2D();
  }

  /* ═══════════════════════════════════════════════════════════ UV GEOMETRY ═══ */
  function nearestVertexUV(ux, uy) {
    const F = cache.F, nF = cache.nF, nV = cache.nV;
    const uv = cache.uv, valid = cache.valid;
    let best = -1, bestD = 1e18;
    const checked = new Uint8Array(nV);
    for (let fi = 0; fi < nF; fi++) {
      if (!valid[fi]) continue;
      for (let j = 0; j < 3; j++) {
        const vi = F[fi * 3 + j];
        if (checked[vi]) continue; checked[vi] = 1;
        const dx = uv[vi * 2] - ux, dy = uv[vi * 2 + 1] - uy;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = vi; }
      }
    }
    return best;
  }

  function findFaceAtUV(ux, uy) {
    const F = cache.F, nF = cache.nF;
    const uv = cache.uv, valid = cache.valid;
    for (let fi = 0; fi < nF; fi++) {
      if (!valid[fi]) continue;
      const i0 = F[fi * 3], i1 = F[fi * 3 + 1], i2 = F[fi * 3 + 2];
      const ax = uv[i0 * 2], ay = uv[i0 * 2 + 1];
      const bx = uv[i1 * 2], by = uv[i1 * 2 + 1];
      const cx = uv[i2 * 2], cy = uv[i2 * 2 + 1];
      const v0x = cx - ax, v0y = cy - ay;
      const v1x = bx - ax, v1y = by - ay;
      const v2x = ux - ax, v2y = uy - ay;
      const d00 = v0x * v0x + v0y * v0y, d01 = v0x * v1x + v0y * v1y, d11 = v1x * v1x + v1y * v1y;
      const d20 = v2x * v0x + v2y * v0y, d21 = v2x * v1x + v2y * v1y;
      const denom = d00 * d11 - d01 * d01;
      if (Math.abs(denom) < 1e-20) continue;
      const u = (d11 * d20 - d01 * d21) / denom;
      const v = (d00 * d21 - d01 * d20) / denom;
      if (u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6) return fi;
    }
    return -1;
  }

  /* Найти грань под UV-точкой и вернуть её барицентрические координаты.
     Используется для точной привязки клика измерителя — позволяет
     посчитать настоящие 3D-координаты места клика, а не округлять до
     ближайшей вершины меша.
     Возвращает { fi, w0, w1, w2 } или null.
     Веса в порядке F[fi*3], F[fi*3+1], F[fi*3+2] (сумма = 1). */
  function findFaceAtUVBary(ux, uy) {
    const F = cache.F, nF = cache.nF;
    const uv = cache.uv, valid = cache.valid;
    for (let fi = 0; fi < nF; fi++) {
      if (!valid[fi]) continue;
      const i0 = F[fi * 3], i1 = F[fi * 3 + 1], i2 = F[fi * 3 + 2];
      const ax = uv[i0 * 2], ay = uv[i0 * 2 + 1];
      const bx = uv[i1 * 2], by = uv[i1 * 2 + 1];
      const cx = uv[i2 * 2], cy = uv[i2 * 2 + 1];
      // Стандартная схема: i0 — origin, edges = (i1-i0), (i2-i0).
      const e1x = bx - ax, e1y = by - ay;
      const e2x = cx - ax, e2y = cy - ay;
      const px = ux - ax, py = uy - ay;
      const d11 = e1x * e1x + e1y * e1y;
      const d12 = e1x * e2x + e1y * e2y;
      const d22 = e2x * e2x + e2y * e2y;
      const dp1 = px * e1x + py * e1y;
      const dp2 = px * e2x + py * e2y;
      const denom = d11 * d22 - d12 * d12;
      if (Math.abs(denom) < 1e-20) continue;
      const w1 = (d22 * dp1 - d12 * dp2) / denom;   // вес i1
      const w2 = (d11 * dp2 - d12 * dp1) / denom;   // вес i2
      const w0 = 1 - w1 - w2;                       // вес i0
      if (w0 >= -1e-6 && w1 >= -1e-6 && w2 >= -1e-6) {
        return { fi, w0, w1, w2 };
      }
    }
    return null;
  }

  /* Сделать точную «снэп-точку» для измерителя.
     Принимает hit от 3D-raycast'а ИЛИ {ux, uy} от 2D-клика, возвращает
     объект совместимый с makePoint(): { vi, u, v, x, y, z }.
       • На 3D: x/y/z — это точное место попадания луча в треугольник
         (h.point), интерполированный u/v — барицентрическая интерполяция
         UV-координат вершин. vi — ближайшая вершина (нужно для блокировки
         в overlap-зонах и для some legacy-кода, но к расчётам не имеет
         отношения).
       • На 2D: x/y/z — интерполяция 3D-координат вершин по барицентрическим
         весам клика; ux/uy — собственно клик.
     Так точность измерения ограничена не плотностью сетки, а разрешением
     клика — на ~0.1мм при разумном зуме. */
  function pickPrecisePoint(opts) {
    if (!cache) return null;
    if (opts.hit3D) {
      const h = opts.hit3D;
      const fi = h.fi, p = h.point;
      if (fi < 0 || !p) return null;
      const i0 = cache.F[fi * 3], i1 = cache.F[fi * 3 + 1], i2 = cache.F[fi * 3 + 2];
      // Барицентрические по 3D-точке внутри грани (для интерполяции UV).
      const V = cache.V;
      const ax = V[i0 * 3], ay = V[i0 * 3 + 1], az = V[i0 * 3 + 2];
      const bx = V[i1 * 3], by = V[i1 * 3 + 1], bz = V[i1 * 3 + 2];
      const cx = V[i2 * 3], cy = V[i2 * 3 + 1], cz = V[i2 * 3 + 2];
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      const px = p.x - ax, py = p.y - ay, pz = p.z - az;
      const d11 = e1x*e1x + e1y*e1y + e1z*e1z;
      const d12 = e1x*e2x + e1y*e2y + e1z*e2z;
      const d22 = e2x*e2x + e2y*e2y + e2z*e2z;
      const dp1 = px*e1x + py*e1y + pz*e1z;
      const dp2 = px*e2x + py*e2y + pz*e2z;
      const denom = d11 * d22 - d12 * d12;
      let w0 = 1, w1 = 0, w2 = 0;
      if (Math.abs(denom) > 1e-20) {
        w1 = (d22 * dp1 - d12 * dp2) / denom;
        w2 = (d11 * dp2 - d12 * dp1) / denom;
        w0 = 1 - w1 - w2;
      }
      const u = w0 * cache.uv[i0*2]   + w1 * cache.uv[i1*2]   + w2 * cache.uv[i2*2];
      const v = w0 * cache.uv[i0*2+1] + w1 * cache.uv[i1*2+1] + w2 * cache.uv[i2*2+1];
      return { vi: h.vi, fi, u, v, x: p.x, y: p.y, z: p.z };
    }
    if (opts.uv) {
      const bary = findFaceAtUVBary(opts.uv.ux, opts.uv.uy);
      if (!bary) return null;
      const { fi, w0, w1, w2 } = bary;
      const i0 = cache.F[fi*3], i1 = cache.F[fi*3+1], i2 = cache.F[fi*3+2];
      const V = cache.V;
      const x = w0*V[i0*3]   + w1*V[i1*3]   + w2*V[i2*3];
      const y = w0*V[i0*3+1] + w1*V[i1*3+1] + w2*V[i2*3+1];
      const z = w0*V[i0*3+2] + w1*V[i1*3+2] + w2*V[i2*3+2];
      // vi — ближайшая вершина, она нужна для legacy-вызовов, но для
      // самого расчёта расстояния не используется.
      const ws = [[w0, i0], [w1, i1], [w2, i2]];
      ws.sort((a,b) => b[0]-a[0]);
      return { vi: ws[0][1], fi, u: opts.uv.ux, v: opts.uv.uy, x, y, z };
    }
    return null;
  }

  function euclidDist(a, b) {
    const V = window.M.V;
    const dx = V[a * 3] - V[b * 3], dy = V[a * 3 + 1] - V[b * 3 + 1], dz = V[a * 3 + 2] - V[b * 3 + 2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  function pointInPolygonUV(px, py, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].u, yi = poly[i].v, xj = poly[j].u, yj = poly[j].v;
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi + 1e-30) + xi)) inside = !inside;
    }
    return inside;
  }

  function screenPointInPath(px, py, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  /* ═══ Region-growing select через UV polygon (экономит время vs bbox-scan) ═══ */
  function regionGrowingSelect(polygon) {
    const F = cache.F, nF = cache.nF;
    const uv = cache.uv, valid = cache.valid, faceAdj = cache.faceAdj;
    if (!polygon || polygon.length < 3) return null;
    let cx = 0, cy = 0;
    for (const p of polygon) { cx += p.u; cy += p.v; }
    cx /= polygon.length; cy /= polygon.length;
    let u_lo = 1e30, u_hi = -1e30, v_lo = 1e30, v_hi = -1e30;
    for (const p of polygon) {
      if (p.u < u_lo) u_lo = p.u; if (p.u > u_hi) u_hi = p.u;
      if (p.v < v_lo) v_lo = p.v; if (p.v > v_hi) v_hi = p.v;
    }
    let seed = -1, bestD = 1e30;
    for (let fi = 0; fi < nF; fi++) {
      if (!valid[fi]) continue;
      const i0 = F[fi * 3], i1 = F[fi * 3 + 1], i2 = F[fi * 3 + 2];
      const fx = (uv[i0 * 2] + uv[i1 * 2] + uv[i2 * 2]) / 3;
      const fy = (uv[i0 * 2 + 1] + uv[i1 * 2 + 1] + uv[i2 * 2 + 1]) / 3;
      if (fx < u_lo || fx > u_hi || fy < v_lo || fy > v_hi) continue;
      if (!pointInPolygonUV(fx, fy, polygon)) continue;
      const d = (fx - cx) * (fx - cx) + (fy - cy) * (fy - cy);
      if (d < bestD) { bestD = d; seed = fi; }
    }
    if (seed < 0) return null;
    const sel = new Uint8Array(nF);
    sel[seed] = 1;
    const queue = [seed]; let qi = 0;
    while (qi < queue.length) {
      const fi = queue[qi++];
      const neighbors = faceAdj[fi];
      for (const nb of neighbors) {
        if (sel[nb] || !valid[nb]) continue;
        const i0 = F[nb * 3], i1 = F[nb * 3 + 1], i2 = F[nb * 3 + 2];
        const fx = (uv[i0 * 2] + uv[i1 * 2] + uv[i2 * 2]) / 3;
        const fy = (uv[i0 * 2 + 1] + uv[i1 * 2 + 1] + uv[i2 * 2 + 1]) / 3;
        let inside = pointInPolygonUV(fx, fy, polygon);
        if (!inside) {
          for (let j = 0; j < 3; j++) {
            if (pointInPolygonUV(uv[F[nb * 3 + j] * 2], uv[F[nb * 3 + j] * 2 + 1], polygon)) { inside = true; break; }
          }
        }
        if (inside) { sel[nb] = 1; queue.push(nb); }
      }
    }
    return sel;
  }

  /* ═══ Главная функция измерения polygon'а (area 3D + perimeter через Dijkstra) ═══ */
  function measurePolygonV2(polygon) {
    const F = cache.F, nF = cache.nF;
    const uv = cache.uv, fa = cache._fa, labels = cache.zoneLabels, overlapMap = cache.overlapMap;
    const warnings = [];
    if (!polygon || polygon.length < 3) {
      warnings.push({ level: 'BLOCK', msg: 'Polygon: минимум 3 точки' });
      return { area3d: 0, perim3d: 0, zones: [0, 0, 0], selected: null, warnings, nFaces: 0, overlapFrac: 0 };
    }
    if (polygon.length < 4)       warnings.push({ level: 'WARN', msg: 'Только ' + polygon.length + ' точек — рекомендуется ≥ 8 для эллипсов' });
    else if (polygon.length < 8)  warnings.push({ level: 'INFO', msg: polygon.length + ' точек — погрешность ~10-20%, для точности нужно ≥ 12' });

    const sel = regionGrowingSelect(polygon);
    if (!sel) {
      warnings.push({ level: 'BLOCK', msg: 'Seed face не найден — polygon вне развёртки' });
      return { area3d: 0, perim3d: 0, zones: [0, 0, 0], selected: null, warnings, nFaces: 0, overlapFrac: 0 };
    }
    let area3d = 0, nFaces = 0, overlapArea = 0;
    const zones = [0, 0, 0];
    for (let fi = 0; fi < nF; fi++) {
      if (!sel[fi]) continue;
      area3d += fa[fi]; zones[labels[fi]] += fa[fi]; nFaces++;
      if (overlapMap && overlapMap[fi]) overlapArea += fa[fi];
    }
    if (nFaces < 3) {
      warnings.push({ level: 'BLOCK', msg: 'Выбрано ' + nFaces + ' faces — polygon слишком мал' });
      return { area3d, perim3d: 0, zones, selected: sel, warnings, nFaces, overlapFrac: 0 };
    }
    const overlapFrac = overlapArea / Math.max(area3d, 1e-9);
    if (overlapFrac > 0.4)       warnings.push({ level: 'WARN', msg: (overlapFrac * 100).toFixed(0) + '% в overlap-зоне — измерение ненадёжно' });
    else if (overlapFrac > 0.1)  warnings.push({ level: 'INFO', msg: (overlapFrac * 100).toFixed(0) + '% в overlap-зоне' });

    const zoneNames = ['перегородка', 'дно', 'лат. стенка'];
    const nonZero = [];
    for (let z = 0; z < 3; z++) if (zones[z] > 0.5) nonZero.push(zoneNames[z]);
    if (nonZero.length > 1) warnings.push({ level: 'WARN', msg: 'Polygon пересекает зоны: ' + nonZero.join(', ') });

    // Perimeter: Dijkstra между соседними точками polygon'а (замкнутый)
    let perim3d = 0;
    const chain = [];
    const usedV = new Set();
    for (let fi = 0; fi < nF; fi++) {
      if (!sel[fi]) continue;
      for (let j = 0; j < 3; j++) usedV.add(F[fi * 3 + j]);
    }
    const usedArr = Array.from(usedV);
    for (const p of polygon) {
      if (typeof p.vi === 'number' && p.vi >= 0) { chain.push(p.vi); continue; }
      let best = -1, bestD = 1e30;
      for (const vi of usedArr) {
        const du = uv[vi * 2] - p.u, dv = uv[vi * 2 + 1] - p.v;
        const d = du * du + dv * dv;
        if (d < bestD) { bestD = d; best = vi; }
      }
      chain.push(best);
    }
    for (let k = 0; k < chain.length; k++) {
      const a = chain[k], b = chain[(k + 1) % chain.length];
      if (a === b) continue;
      const res = dijkstraPath(a, b);
      perim3d += res.dist;
    }
    return { area3d, perim3d, zones, selected: sel, warnings, nFaces, overlapFrac, chain };
  }

  /* ═══ Цепочка измерений (H/V/Diag): Dijkstra между последовательными точками ═══ */
  function measureRulerChain(pts) {
    if (pts.length < 2) return { total: 0, segments: [] };
    const segments = []; let total = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = (typeof pts[i].vi === 'number' && pts[i].vi >= 0) ? pts[i].vi
                 : nearestVertexUV(pts[i].u || pts[i].ux, pts[i].v || pts[i].uy);
      const b = (typeof pts[i + 1].vi === 'number' && pts[i + 1].vi >= 0) ? pts[i + 1].vi
                 : nearestVertexUV(pts[i + 1].u || pts[i + 1].ux, pts[i + 1].v || pts[i + 1].uy);
      if (a < 0 || b < 0 || a === b) continue;
      const res = dijkstraPath(a, b);
      segments.push({ src: a, dst: b, dist: res.dist, path: res.path });
      total += res.dist;
    }
    return { total, segments };
  }

  /* ═══ Площадь + разбиение по зонам для произвольного face-селекта ═══ */
  function measureSelection(sel) {
    const nF = cache.nF;
    const fa = cache._fa, labels = cache.zoneLabels, valid = cache.valid;
    const zn = [0, 0, 0]; let total = 0, cnt = 0;
    for (let fi = 0; fi < nF; fi++) {
      if (!sel[fi] || !valid[fi]) continue;
      total += fa[fi]; zn[labels[fi]] += fa[fi]; cnt++;
    }
    return { total3d: total, zones: zn, count: cnt };
  }

  /* ═══ Завершение lasso: screen-space polygon → выборка faces ═══ */
  function finalizeLasso() {
    const F = cache.F, nF = cache.nF;
    const uv = cache.uv, valid = cache.valid;
    if (!unfTx) return;
    selectedFaces = new Uint8Array(nF);
    let cnt = 0;
    for (let fi = 0; fi < nF; fi++) {
      if (!valid[fi]) continue;
      const i0 = F[fi * 3], i1 = F[fi * 3 + 1], i2 = F[fi * 3 + 2];
      const cx = (uv[i0 * 2] + uv[i1 * 2] + uv[i2 * 2]) / 3;
      const cy = (uv[i0 * 2 + 1] + uv[i1 * 2 + 1] + uv[i2 * 2 + 1]) / 3;
      const sx = unfTx.tx(cx), sy = unfTx.ty(cy);
      if (screenPointInPath(sx, sy, lassoPath)) { selectedFaces[fi] = 1; cnt++; }
    }
    if (cnt === 0) { selectedFaces = null; hideMeasFloat(); render2D(); return; }
    showLassoReadout();
    render2D(); render3DAnnotations();
  }

  /* ═══════════════════════════════════════════════════════════ UI CARDS ═══ */
  // Измерения (линейка / цепочка / полигон / лассо / inspect) раньше жили в
  // плавающей карточке .t4-measfloat поверх развёртки — она перекрывала
  // критичные зоны меша. Теперь рендерятся в правом sidebar секцией
  // t4-meas-panel под .t4-distpanel. Имя функций оставлено прежним, чтобы
  // все старые вызовы продолжали работать без правок.
  /* Раскрыть правую панель, если она была свёрнута. Дёргается из всех
     функций, которые показывают полезный контент: измерение, легенда
     режима, флап-симулятор, клик по перфорации. Изначально (после
     билда развёртки) панель свёрнута, чтобы не отвлекать пустыми
     метриками — а как только появилось что-то для пациента, она
     автоматически раскрывается. Закрыть обратно можно язычком справа. */
  function ensurePanelOpen() {
    const stage = document.querySelector('.stage[data-stage="unfold"]');
    if (stage && stage.classList.contains('t4-focused-r')) {
      stage.classList.remove('t4-focused-r');
    }
  }

  function showMeasFloat(title, html) {
    if (!measPanelEl) return;
    // Заголовок теперь в .card-title карточки, а тело — внутри
    // measPanelEl, обёрнутое в .t4-meas-body (стили строк/hint/stat-row
    // привязаны к этому классу).
    const cardTitle = document.getElementById('t4-meas-card-title');
    if (cardTitle) cardTitle.textContent = title;
    measPanelEl.innerHTML = '<div class="t4-meas-body">' + html + '</div>';
    // Defensive: явно показать тело панели. Раньше updateWarningUI() мог
    // оставить measPanelEl.style.display='none' (баг исправлен, но
    // сохраняем подстраховку: показ карточки должен показывать обе её
    // части — и заголовок, и тело).
    measPanelEl.style.display = '';
    const measCard = document.getElementById('t4-meas-card');
    if (measCard) measCard.style.display = '';
    ensurePanelOpen();
  }
  function hideMeasFloat() {
    // Скрываем карточку активного инструмента целиком (включая card-title).
    // Карточку с деталями перфорации (t4-perf-card) НЕ трогаем — она живёт
    // независимо: hideMeasFloat вызывается из ~15 мест (Esc, смена тула,
    // очистка измерения и т.п.), и юзер не ожидает, что любая такая
    // операция закроет ему открытые детали перфорации.
    const measCard = document.getElementById('t4-meas-card');
    if (measCard) measCard.style.display = 'none';
    if (measPanelEl) measPanelEl.innerHTML = '';
    // НЕ сбрасываем _shownPerfIdx — это состояние t4-perf-card,
    // её состояние теперь управляется hidePerfFloat.

    // ═══ Синхронизация состояния FLAP-симулятора с видимостью карточки.
    //    Карточка лоскута живёт в той же meas-card, что и измерительные
    //    инструменты. Когда другой инструмент / Esc / clearMeasurementsState
    //    зовут hideMeasFloat — сам объект _flap раньше оставался truthy,
    //    а кнопка t4-flap2 — с классом .active. Из-за этого toggle-кнопка
    //    «Флап» работала через раз: один клик закрывал «фантом» (no-op),
    //    второй уже реально открывал. Теперь скрытие карточки = выход из
    //    режима лоскута, и тулбарная кнопка обязана это отразить.
    //    `_flap` объявлен через `let` ниже по файлу (line ~6491), но
    //    hideMeasFloat вызывается только из event-handler'ов после полной
    //    инициализации IIFE, так что TDZ здесь не страшна.
    if (_flap !== null) {
      _flap = null;
      const elFlap = _$('t4-flap2');
      if (elFlap) elFlap.classList.remove('active');
      // render2D здесь не зовём — вызывающая сторона
      // (clearMeasurementsState / setTool / closeFlapSimulator / Esc)
      // делает это сама, не плодим лишних кадров.
    }
  }

  /* ═══ Карточка деталей перфорации — отдельный канал от инструментов.
     Раньше детали перфорации писались в ту же meas-card (через
     showMeasFloat), и любое последующее измерение ИЛИ наоборот —
     открытие деталей перфорации поверх работающего инструмента —
     затирало предыдущий вывод. Теперь две независимые карточки:
     меняешь линейку → meas-card обновляется, perf-card не трогается;
     открываешь перфорацию → perf-card обновляется, meas-card живёт
     своей жизнью. Эти две функции — точная копия show/hideMeasFloat
     для perf-card. */
  function showPerfFloat(title, html) {
    if (!perfPanelEl) return;
    const cardTitle = document.getElementById('t4-perf-card-title');
    if (cardTitle) cardTitle.textContent = title;
    perfPanelEl.innerHTML = '<div class="t4-meas-body">' + html + '</div>';
    // Defensive: те же соображения, что и в showMeasFloat — явно показать
    // тело, чтобы остаточные display:none из любых прошлых вызовов не
    // ломали рендер.
    perfPanelEl.style.display = '';
    const perfCard = document.getElementById('t4-perf-card');
    if (perfCard) perfCard.style.display = '';
    ensurePanelOpen();
  }
  function hidePerfFloat() {
    const perfCard = document.getElementById('t4-perf-card');
    if (perfCard) perfCard.style.display = 'none';
    if (perfPanelEl) perfPanelEl.innerHTML = '';
    // Сбрасываем «открытую» перфорацию — иначе при следующем клике
    // на ту же строку toggle подумает, что она уже видна и закроет.
    _shownPerfIdx = -1;
  }

  function row(lab, val, color) {
    return '<div class="t4-row"><span class="t4-lab">' + lab + '</span>' +
           '<span class="t4-val"' + (color ? ' style="color:' + color + '"' : '') + '>' + val + '</span></div>';
  }
  function hint(txt) { return '<div class="t4-hint">' + txt + '</div>'; }
  function header(txt) {
    return '<div style="font-size:11px;color:var(--tx3);text-transform:uppercase;letter-spacing:.16em;' +
           'font-weight:700;margin:8px 0 4px">' + txt + '</div>';
  }
  function lvlColor(dev, th1, th2) {
    th1 = th1 == null ? 0.03 : th1; th2 = th2 == null ? 0.10 : th2;
    if (dev < th1) return 'var(--green,#00c070)';
    if (dev < th2) return '#ffaa33';
    return 'var(--red,#e04050)';
  }

  function showInspectForFace(fi) {
    if (!cache || !cache.valid[fi]) return;
    const F = cache.F, V = cache.V;
    const labels = cache.zoneLabels;
    const s1 = cache.sigma1 ? cache.sigma1[fi] : NaN;
    const s2 = cache.sigma2 ? cache.sigma2[fi] : NaN;
    const L2v = cache.L2 ? cache.L2[fi] : NaN;
    const iso = cache.iso ? cache.iso[fi] : NaN;
    const ring = cache.face_seam_ring ? cache.face_seam_ring[fi] : -1;
    const i0 = F[fi * 3], i1 = F[fi * 3 + 1], i2 = F[fi * 3 + 2];
    const uv = cache.uv;
    const edgeErr = [];
    for (const [a, b] of [[i0, i1], [i1, i2], [i2, i0]]) {
      const dx = V[a * 3] - V[b * 3], dy = V[a * 3 + 1] - V[b * 3 + 1], dz = V[a * 3 + 2] - V[b * 3 + 2];
      const L3 = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const du = uv[a * 2] - uv[b * 2], dv = uv[a * 2 + 1] - uv[b * 2 + 1];
      const L2e = Math.sqrt(du * du + dv * dv);
      if (L3 > 1e-9) edgeErr.push(Math.abs(L2e / L3 - 1));
    }
    const meanEdgeErr = edgeErr.reduce((s, v) => s + v, 0) / Math.max(edgeErr.length, 1);
    const lab = labels[fi];
    const isDk = !document.body.classList.contains('light-theme');
    const zc = isDk ? ['#00b4ff', '#00ff88', '#ff8844'] : ['#4F7CDB', '#34B86A', '#DD8844'];
    let html =
      '<div style="padding:4px 8px;background:rgba(255,207,102,.08);border-left:2px solid #ffcf66;margin-bottom:6px;border-radius:2px">' +
        '<div style="font-size:10px;color:#ffcf66;font-family:\'Share Tech Mono\',\'Consolas\',\'Menlo\',monospace;letter-spacing:.08em">FACE #' + fi +
        ' · <span style="color:' + zc[lab] + '">' + ZONE_NAMES[lab] + '</span></div>' +
      '</div>';
    html += row('σ₁ (растяжение)', fmtNum(s1, 3), lvlColor(Math.abs(s1 - 1)));
    html += row('σ₂ (сжатие)', fmtNum(s2, 3), lvlColor(Math.abs(s2 - 1)));
    html += row('L² stretch', fmtNum(L2v, 4), lvlColor(Math.abs(L2v - 1)));
    html += row('Iso deviation', fmtNum(iso, 3), lvlColor(iso - 1));
    html += row('Ошибка рёбер', fmtPct(meanEdgeErr), lvlColor(meanEdgeErr));
    html += row('Площадь 3D', cache._fa[fi].toFixed(3) + ' мм²');
    html += row('Кольцо до шва', (ring >= 0 ? String(ring) : '—'));
    html += hint('σ₁,σ₂ — сингулярные значения якобиана 3D→UV. Идеал σ₁=σ₂=1. Двигай мышь для осмотра другой грани.');
    showMeasFloat('Inspect · face ' + fi, html);
  }

  /* ═══ Мульти-замер диаметров перфорации — обработка кликов ═════════════
     Каждая пара кликов: клик 1 → measurePending = A, клик 2 → завершаем
     отрезок A–B. Измеряется ПРЯМОЕ 3D-расстояние по воздуху (евклидова
     хорда), а не геодезика по поверхности. Это критично для перфораций:
     поверхности в дырке нет, а Dijkstra бы обогнул её по контуру и дал
     длину обхода, а не диаметр.

     Принимает precise-точку {vi, fi, u, v, x, y, z} от pickPrecisePoint —
     это место КЛИКА, интерполированное барицентрически внутри грани, а
     не ближайшая вершина. Точность ограничена разрешением клика
     (~0.1мм при разумном зуме), а не плотностью сетки (~0.5–1мм).

     Между завершёнными отрезками нет связи — это независимые диаметры
     одной перфорации. Не сбрасываются между парами — копятся, пока
     врач не нажмёт «Очистить» или Esc. */
  function handleMeasureClick(pt) {
    if (!cache || !pt) return;
    if (!measurePending) {
      measurePending = pt;
      showMeasureReadout();
      return;
    }
    // Случайный двойной клик в очень близкое место — игнор (всё равно
    // покажет заведомо нулевой диаметр).
    const ddx = pt.x - measurePending.x;
    const ddy = pt.y - measurePending.y;
    const ddz = pt.z - measurePending.z;
    if (ddx*ddx + ddy*ddy + ddz*ddz < 0.0001) return;
    const dist_mm = Math.sqrt(ddx*ddx + ddy*ddy + ddz*ddz);
    measureLines.push({
      a: measurePending,
      b: pt,
      dist_mm: dist_mm,
    });
    measurePending = null;
    showMeasureReadout();
  }

  /* Отчёт по всем накопленным отрезкам — список с цифрами, статистика
     (max/min/средний), плюс summary-строка для копирования в карту
     пациента. Каждая строка списка имеет «×» для удаления. */
  function showMeasureReadout() {
    if (!measureLines.length && !measurePending) { hideMeasFloat(); return; }
    let html = '';
    if (measureLines.length === 0 && measurePending) {
      html += '<div class="t4-meas-pending">Точка <b>A</b> поставлена. Кликни на противоположный край перфорации для получения диаметра.</div>';
      html += '<div class="t4-hint">Измерение идёт прямой линией через воздух. Точки можно ставить и на 3D-меше, и на 2D-развёртке.</div>';
      showMeasFloat('Замер · точка B', html);
      return;
    }
    // Сводка крупно — то, что попадёт в карту:
    const summary = measureLines.map(L => L.dist_mm.toFixed(1)).join(' × ');
    html += '<div class="t4-meas-headline">' +
            '<span class="t4-meas-headline-v">' + summary + ' мм</span></div>';
    // Список замеров — компактные строки с цветным номером и крестиком
    html += '<div class="t4-meas-list">';
    for (let i = 0; i < measureLines.length; i++) {
      const L = measureLines[i];
      const col = MEASURE_COLORS[i % MEASURE_COLORS.length];
      html += '<div class="t4-meas-row" data-meas-idx="' + i + '">' +
              '<span class="t4-meas-num" style="background:' + col + '">' + (i + 1) + '</span>' +
              '<span class="t4-meas-len" style="color:' + col + '">' + L.dist_mm.toFixed(2) + ' мм</span>' +
              '<button class="t4-meas-del" title="Удалить">×</button>' +
              '</div>';
    }
    html += '</div>';
    // Статистика — только когда замеров ≥ 2
    if (measureLines.length >= 2) {
      const arr = measureLines.map(L => L.dist_mm);
      const mn = Math.min(...arr), mx = Math.max(...arr);
      const avg = arr.reduce((s, v) => s + v, 0) / arr.length;
      const ratio = mx / Math.max(mn, 1e-9);
      html += '<div class="t4-meas-stats">';
      html += '<div class="stat-row"><span class="stat-k">max</span>' +
              '<span class="stat-v" style="color:var(--green,#00c070)">' + mx.toFixed(2) + ' мм</span></div>';
      html += '<div class="stat-row"><span class="stat-k">min</span>' +
              '<span class="stat-v" style="color:var(--orange,#ff8844)">' + mn.toFixed(2) + ' мм</span></div>';
      html += '<div class="stat-row"><span class="stat-k">средний</span>' +
              '<span class="stat-v">' + avg.toFixed(2) + ' мм</span></div>';
      html += '</div>';
    }
    // Pending — точка A поставлена, ждём B
    if (measurePending) {
      html += '<div class="t4-meas-pending"><span class="t4-meas-pulse"></span>' +
              'Точка A поставлена — кликни B для нового отрезка</div>';
    }
    showMeasFloat('Замер диаметров', html);
    // Бинд кнопок «×»
    setTimeout(() => {
      if (!measPanelEl) return;
      measPanelEl.querySelectorAll('.t4-meas-del').forEach(btn => {
        btn.onclick = (ev) => {
          ev.stopPropagation();
          const item = btn.closest('.t4-meas-row');
          const idx = item ? parseInt(item.getAttribute('data-meas-idx'), 10) : -1;
          if (idx >= 0 && idx < measureLines.length) {
            measureLines.splice(idx, 1);
            showMeasureReadout();
            render2D(); render3DAnnotations();
          }
        };
      });
    }, 10);
  }

  function showRulerReadout() {
    if (!cache || rulerPts.length !== 2) return;
    const res = { dist: cache._rulerDist, path: cache._rulerPath };
    const uvdist = Math.hypot(rulerPts[0].ux - rulerPts[1].ux, rulerPts[0].uy - rulerPts[1].uy);
    const uvErr = Math.abs(uvdist / Math.max(res.dist, 1e-9) - 1);
    let html = '';
    html += '<div class="t4-row" style="background:rgba(0,255,136,.06);padding:6px 8px;border-radius:4px;margin-bottom:4px;border:1px solid rgba(0,255,136,.15)">' +
             '<span class="t4-lab" style="font-weight:700">РАССТОЯНИЕ</span>' +
             '<span class="t4-val" style="font-size:15px;color:var(--green,#00c070);font-weight:700">' +
             res.dist.toFixed(2) + ' мм</span></div>';
    // Если развёртка в этой точке заметно искажает — короткое предупреждение.
    // Меньше 3% — просто игнорируем (норма).
    if (uvErr > 0.03) {
      html += '<div style="font-size:10px;color:' + (uvErr > 0.10 ? 'var(--red,#e04050)' : 'var(--orange,#ff8844)') + ';' +
              'padding:4px 0">⚠ Здесь развёртка искажает на ' + (uvErr * 100).toFixed(0) + '%. ' +
              'Дублируйте измерение в 3D-вью.</div>';
    }
    html += hint('Длина по поверхности слизистой между двумя точками.');
    showMeasFloat('Линейка', html);
  }

  function showChainReadout() {
    if (rulerChainPts.length < 2) return;
    const chain = measureRulerChain(rulerChainPts);
    let html = '';
    html += '<div class="t4-row" style="background:rgba(0,255,136,.06);padding:6px 8px;border-radius:4px;margin-bottom:6px;border:1px solid rgba(0,255,136,.15)">' +
             '<span class="t4-lab" style="font-weight:700">ОБЩАЯ ДЛИНА</span>' +
             '<span class="t4-val" style="font-size:15px;color:var(--green,#00c070);font-weight:700">' +
             chain.total.toFixed(2) + ' мм</span></div>';
    chain.segments.forEach((s, i) => {
      html += '<div class="t4-row"><span class="t4-lab">Сегмент ' + (i + 1) +
              '</span><span class="t4-val">' + s.dist.toFixed(2) + ' мм</span></div>';
    });
    html += hint('Z — отменить последнюю точку.');
    showMeasFloat('Ломаная', html);
  }

  function showPolygonMeasurement(res) {
    if (!res) { hideMeasFloat(); return; }
    const { area3d, perim3d, zones, warnings } = res;
    const npts = polygonPts.length;
    let html = '';
    html += '<div class="t4-row" style="background:rgba(0,255,136,.06);padding:6px 8px;border-radius:4px;margin-bottom:4px;border:1px solid rgba(0,255,136,.15)">' +
             '<span class="t4-lab" style="font-weight:700">ПЛОЩАДЬ</span>' +
             '<span class="t4-val" style="font-size:15px;color:var(--green,#00c070);font-weight:700">' +
             (area3d / 100).toFixed(2) + ' см²</span></div>';
    html += '<div class="t4-row" style="background:rgba(0,240,255,.06);padding:6px 8px;border-radius:4px;margin-bottom:6px;border:1px solid rgba(0,240,255,.15)">' +
             '<span class="t4-lab" style="font-weight:700">ПЕРИМЕТР</span>' +
             '<span class="t4-val" style="font-size:15px;color:var(--cyan,#00d0ff);font-weight:700">' +
             perim3d.toFixed(1) + ' мм</span></div>';
    // По зонам — только если многозонная (показывает важную информацию,
    // что замер пересёк границу анатомических областей).
    const isDk = !document.body.classList.contains('light-theme');
    const zc = isDk ? ['#00b4ff', '#00ff88', '#ff8844'] : ['#4F7CDB', '#34B86A', '#DD8844'];
    const nzArr = [];
    for (let z = 0; z < 3; z++) if (zones[z] > 0.5) nzArr.push(z);
    if (nzArr.length > 1) {
      html += '<div style="margin-top:6px;font-size:10px;color:var(--tx3,#7a8b99);font-weight:600;font-family:inherit;letter-spacing:.1em">По зонам:</div>';
      for (const z of nzArr) {
        html += '<div class="t4-row"><span class="t4-lab"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' +
                 zc[z] + ';margin-right:4px;box-shadow:0 0 4px ' + zc[z] + '"></span>' + ZONE_NAMES[z] + '</span>' +
                 '<span class="t4-val">' + (zones[z] / 100).toFixed(2) + ' см²</span></div>';
      }
    }
    // Предупреждения (BLOCK/WARN) — только клинически значимые,
    // technical info-warnings глотаем.
    if (warnings && warnings.length > 0) {
      const clinical = warnings.filter(w => w.level === 'WARN' || w.level === 'BLOCK');
      if (clinical.length > 0) {
        html += '<div style="margin-top:8px;padding-top:6px;border-top:1px solid var(--brd,rgba(0,240,255,.2))">';
        for (const w of clinical) {
          const col = w.level === 'BLOCK' ? 'var(--red,#e04050)' : 'var(--orange,#ff8844)';
          const ic = w.level === 'BLOCK' ? '✕' : '⚠';
          html += '<div style="font-size:10px;color:' + col + ';padding:2px 0;display:flex;align-items:start;gap:4px">' +
                   '<span style="flex-shrink:0">' + ic + '</span><span>' + w.msg + '</span></div>';
        }
        html += '</div>';
      }
    }
    showMeasFloat('Область', html);
  }

  function showLassoReadout() {
    if (!selectedFaces) { hideMeasFloat(); return; }
    const m = measureSelection(selectedFaces);
    const isDk = !document.body.classList.contains('light-theme');
    const zc = isDk ? ['#00b4ff', '#00ff88', '#ff8844'] : ['#4F7CDB', '#34B86A', '#DD8844'];
    let html = '';
    html += '<div class="t4-row" style="background:rgba(0,255,136,.06);padding:6px 8px;border-radius:4px;margin-bottom:4px;border:1px solid rgba(0,255,136,.15)">' +
             '<span class="t4-lab" style="font-weight:700">ПЛОЩАДЬ</span>' +
             '<span class="t4-val" style="font-size:15px;color:var(--green,#00c070);font-weight:700">' +
             (m.total3d / 100).toFixed(2) + ' см²</span></div>';
    const nzArr = [];
    for (let z = 0; z < 3; z++) if (m.zones[z] > 0.01) nzArr.push(z);
    if (nzArr.length > 1) {
      html += '<div style="margin-top:6px;font-size:10px;color:var(--tx3,#7a8b99);font-weight:600;font-family:inherit;letter-spacing:.1em">По зонам:</div>';
      for (const z of nzArr) {
        html += '<div class="t4-row"><span class="t4-lab"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' +
                 zc[z] + ';margin-right:4px;box-shadow:0 0 4px ' + zc[z] + '"></span>' + ZONE_NAMES[z] + '</span>' +
                 '<span class="t4-val">' + (m.zones[z] / 100).toFixed(2) + ' см²</span></div>';
      }
    }
    showMeasFloat('Лассо — площадь', html);
  }

  function showColorModeLegend() {
    // Легенда цвет-режима теперь живёт в правом sidebar (legendPanelEl),
    // а не в плавающей карточке поверх развёртки. Плавающая остаётся
    // за реальными измерениями (polygon/ruler/lasso/inspect).
    if (!legendPanelEl) return;
    if (colorMode === 'zones') { legendPanelEl.style.display = 'none'; return; }
    if (!cache || !cache.metricsSummary) { legendPanelEl.style.display = 'none'; return; }
    const g = cache.metricsSummary.global;
    let title = '', html = '';
    if (colorMode === 'L2') {
      title = 'L² stretch (ideal = 1)';
      html  = row('Среднее', fmtNum(g.L2_mean), 'var(--green,#00c070)')
            + row('p95', fmtNum(g.L2_p95))
            + row('p99', fmtNum(g.L2_p99))
            + row('max', fmtNum(g.L2_max, 3))
            + '<div style="margin-top:8px;display:flex;align-items:center;gap:6px;font-size:10px;color:var(--tx3,#7a8b99)">' +
              '<span>0.85</span><div style="flex:1;height:8px;border-radius:2px;background:linear-gradient(90deg,#4488ff,#00ff88,#00ff88,#ffaa22,#ff4466)"></div><span>1.15</span></div>'
            + hint('σ₁,σ₂ — сингулярные значения якобиана 3D→UV. L² = √((σ₁²+σ₂²)/2). Зелёный ≈ изометрия.');
    } else if (colorMode === 'iso') {
      title = 'Isometric deviation max(σ₁, 1/σ₂)';
      html  = row('Среднее', fmtNum(g.iso_mean), 'var(--green,#00c070)')
            + row('p95', fmtNum(g.iso_p95))
            + row('max', fmtNum(g.iso_max, 3))
            + '<div style="margin-top:8px;display:flex;align-items:center;gap:6px;font-size:10px;color:var(--tx3,#7a8b99)">' +
              '<span>1.0</span><div style="flex:1;height:8px;border-radius:2px;background:linear-gradient(90deg,#fef8df,#f8b15a,#b22222)"></div><span>1.5</span></div>'
            + hint('1 = идеальная изометрия. Показывает худшее из растяжения и сжатия на каждой грани.');
    } else if (colorMode === 'ring') {
      title = 'Seam ring distance';
      const r = cache.metricsSummary.ringStats || {};
      let rows = '';
      for (const k of [0, 1, 2, 3, 5]) {
        if (!r[k] || !r[k].n) continue;
        rows += row('Ring ' + k + ' (n=' + r[k].n + ')', 'L²=' + fmtNum(r[k].L2_mean));
      }
      html = rows +
             '<div style="margin-top:8px;display:flex;align-items:center;gap:6px;font-size:10px;color:var(--tx3,#7a8b99)">' +
             '<span>на шве</span><div style="flex:1;height:8px;border-radius:2px;background:linear-gradient(90deg,#1b7838,#bfe5c0,#f7fcf5)"></div><span>далеко</span></div>' +
             hint('Кольцо = минимальное ребёрное расстояние грани до ближайшего шва между зонами.');
    } else if (colorMode === 'risk') {
      title = 'Где можно измерить';
      const m = cache.metricsFromServer || cache.metricsSummary.global || {};
      const nF = (cache && cache.nF) ? cache.nF : 0;
      const riskN  = (m.risk_n_high    != null) ? m.risk_n_high    : 0;
      const riskM  = (m.risk_n_medium  != null) ? m.risk_n_medium  : 0;
      const safeN  = nF > 0 ? Math.max(0, nF - riskN - riskM) : 0;
      const safePc = nF > 0 ? ((safeN / nF) * 100).toFixed(1) + '%' : '—';
      const medPc  = nF > 0 ? ((riskM / nF) * 100).toFixed(1) + '%' : '—';
      const highPc = (m.risk_high_faces_pct != null)
        ? m.risk_high_faces_pct.toFixed(1) + '%'
        : (nF > 0 ? ((riskN / nF) * 100).toFixed(1) + '%' : '—');

      html  = '<div class="t4-row"><span class="t4-lab">' +
                '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;' +
                'background:#3cc86e;margin-right:6px;box-shadow:0 0 4px #3cc86e"></span>' +
                'Безопасно</span>' +
              '<span class="t4-val" style="color:var(--green,#00c070)">' + safePc + '</span></div>'
            + '<div class="t4-row"><span class="t4-lab">' +
                '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;' +
                'background:#e8c83c;margin-right:6px;box-shadow:0 0 4px #e8c83c"></span>' +
                'Осторожно</span>' +
              '<span class="t4-val" style="color:#e8c83c">' + medPc + '</span></div>'
            + '<div class="t4-row"><span class="t4-lab">' +
                '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;' +
                'background:#ff6044;margin-right:6px;box-shadow:0 0 4px #ff6044"></span>' +
                'Не измерять</span>' +
              '<span class="t4-val" style="color:#ff6044">' + highPc + '</span></div>'
            + '<div style="margin-top:8px;display:flex;align-items:center;gap:6px;font-size:10px;color:var(--tx3,#7a8b99)">'
            +  '<span>надёжно</span>'
            +  '<div style="flex:1;height:8px;border-radius:2px;background:linear-gradient(90deg,#3cc86e 0%,#f0d250 25%,#f06438 50%,#d22828 100%)"></div>'
            +  '<span>нельзя</span>'
            + '</div>'
            + hint('В <b style="color:#d22828">красных</b> участках линейка некорректна — это окрестности разрезов вокруг перфораций, погрешность доходит до 30–100%. Измерьте либо <b>в 3D-вью</b>, либо вдали от красного.');

      // Dev-only: технические числа edge_err для отладки развёртки.
      if (DEV_MODE) {
        const p95 = (m.edge_err_p95 != null) ? (100 * m.edge_err_p95).toFixed(1) + '%' : '—';
        const p99 = (m.edge_err_p99 != null) ? (100 * m.edge_err_p99).toFixed(1) + '%' : '—';
        html += '<div style="margin-top:8px;padding-top:6px;border-top:1px dashed var(--brd);' +
                'font-size:10px;color:var(--tx3,#7a8b99)">dev · edge_err</div>' +
                row('p95', p95) + row('p99', p99);
      }
    }
    legendPanelEl.innerHTML =
      '<div class="t4-legend-title">' + title + '</div>' +
      '<div class="t4-legend-body">' + html + '</div>';
    legendPanelEl.style.display = '';
    ensurePanelOpen();
  }

  /* Единые цвета анатомических зон, синхронизированные с tab3-zones.js
     (Перегородка/Дно/Латеральная). Раньше tab4 рендерил свои оттенки
     (#00b4ff/#00ff88/#ff8844), не совпадающие с раскраской на этапе
     сегментации — врач видел разный цвет одной и той же зоны на двух
     соседних шагах. */
  const ZONE_COLORS = ['#4a9eff', '#ff9f3c', '#5ce1a0'];

  function updateDistortionPanel() {
    if (!distPanelEl) return;
    if (!cache || !cache.metricsSummary) {
      distPanelEl.innerHTML = '<div class="t4-hint">Нажмите «Построить развёртку».</div>';
      return;
    }
    const { global, perZone, seamStats } = cache.metricsSummary;
    let h = '';

    // === Точность по зонам — только в режиме раскраски «Зоны» ===
    // В режимах L²/Iso/Шов/Риск у каждого своя легенда (legend-panel
    // выше), а зональные L²p95 в этих режимах не имеют визуального
    // соответствия на меше — блок только запутывает.
    if (colorMode === 'zones') {
      h += '<div class="ep-section-title">Точность по зонам</div>';
      for (let z = 0; z < 3; z++) {
        const pz = perZone[z];
        const dev = Math.abs((pz.L2_p95 || 1) - 1);
        const acc = ((1 - dev) * 100);
        const accStr = acc.toFixed(1) + '%';
        let flag, cls;
        if (dev < 0.03)      { flag = '✓'; cls = 'good'; }
        else if (dev < 0.07) { flag = '⚠'; cls = 'warn'; }
        else                 { flag = '✗'; cls = 'bad'; }
        h += '<div class="zn-stat-row">' +
             '<span class="zn-swatch" style="background:' + ZONE_COLORS[z] + '"></span>' +
             '<span class="zn-stat-k">' + ZONE_NAMES[z] + '</span>' +
             '<span class="zn-stat-v ' + cls + '">' + flag + '\u00A0' + accStr + '</span>' +
             '</div>';
      }
      h += '<div class="ep-hint">Чем выше процент, тем надёжнее линейка и площади в этой зоне. ' +
           'Ниже 95% — лучше дублировать измерение в 3D-вью.</div>';
    }

    // === Заплатки (если врач что-то залатал) ===
    if (cache.patches && cache.patches.length > 0) {
      h += '<div class="ep-divider"></div>';
      h += '<div class="ep-section-title">Заплатки</div>';
      let totArea = 0;
      const zoneBreak = [0, 0, 0];
      for (const p of cache.patches) {
        totArea += p.area3d || 0;
        zoneBreak[p.zone] = (zoneBreak[p.zone] || 0) + (p.area3d || 0);
      }
      h += '<div class="stat-row"><span class="stat-k">количество</span>' +
           '<span class="stat-v">' + cache.patches.length + '</span></div>';
      h += '<div class="stat-row"><span class="stat-k">суммарная площадь</span>' +
           '<span class="stat-v">' + (totArea / 100).toFixed(2) + ' см²</span></div>';
      for (let z = 0; z < 3; z++) {
        if (zoneBreak[z] < 0.01) continue;
        h += '<div class="zn-stat-row">' +
             '<span class="zn-swatch" style="background:' + ZONE_COLORS[z] + '"></span>' +
             '<span class="zn-stat-k">' + ZONE_NAMES[z] + '</span>' +
             '<span class="zn-stat-v">' + (zoneBreak[z] / 100).toFixed(2) + ' см²</span>' +
             '</div>';
      }
      h += '<div class="ep-hint">Нажмите <b>U</b> для отката последней заплатки.</div>';
    }

    // === Перфорации перегородки — только когда тумблер «Перф.» включён ===
    // Если хирург выключил кнопку «Перф.» в верхнем тулбаре — контуры
    // скрыты на меше, дублировать список в правой панели бессмысленно
    // (пациент сам убрал их из вида).
    if (_perfVisible && cache.perforations && cache.perforations.length > 0) {
      h += '<div class="ep-divider"></div>';
      h += '<div class="ep-section-title">Перфорации перегородки</div>';
      h += '<div id="t4-perf-list" class="t4-perf-list">';
      for (let i = 0; i < cache.perforations.length; i++) {
        const p = cache.perforations[i];
        h += '<div class="t4-perf-item" data-perf-idx="' + i + '">' +
             '<span class="t4-perf-num">' + (i + 1) + '</span>' +
             '<div class="t4-perf-stats">' +
                '<div class="t4-perf-row">' +
                  '<span class="t4-perf-k">Периметр</span>' +
                  '<span class="t4-perf-v">' + p.perimeter_mm.toFixed(1) + ' мм</span>' +
                '</div>' +
                '<div class="t4-perf-row">' +
                  '<span class="t4-perf-k">Площадь</span>' +
                  '<span class="t4-perf-v">' + (p.area_uv_mm2 / 100).toFixed(2) + ' см²</span>' +
                '</div>' +
             '</div>' +
             '</div>';
      }
      h += '</div>';
    }

    // === Складка развёртки (UV-overlap) ===
    const ov = cache.info && cache.info.overlap;
    if (ov && ov.detected && ov.n_pairs > 0) {
      h += '<div class="ep-divider"></div>';
      h += '<div class="ep-section-title warn">⚠ Складка развёртки</div>';
      h += '<div class="stat-row"><span class="stat-k">площадь</span>' +
           '<span class="stat-v bad">' + ov.area_3d_mm2.toFixed(1) + ' мм² (' +
           ov.area_uv_pct.toFixed(2) + '%)</span></div>';
      if (DEV_MODE) {
        h += '<div class="stat-row"><span class="stat-k">граней</span>' +
             '<span class="stat-v bad">' + ov.n_faces_in_overlap + '</span></div>';
      }
      h += '<div class="ep-hint">В этих участках двум разным точкам на ткани ' +
           'соответствует одна точка развёртки. Линейка тут заблокирована — ' +
           'измеряйте в <b>3D-вью</b>.</div>';
    }

    // ── DEV-РЕЖИМ ─────────────────────────────────────────────────────
    if (DEV_MODE) {
      h += '<div class="ep-divider"></div>';
      h += '<div class="ep-section-title">Глобально (dev)</div>';
      h += '<div class="stat-row"><span class="stat-k">L² mean</span>' +
           '<span class="stat-v">' + fmtNum(global.L2_mean) + '</span></div>';
      h += '<div class="stat-row"><span class="stat-k">L² p95</span>' +
           '<span class="stat-v">' + fmtNum(global.L2_p95) + '</span></div>';
      h += '<div class="stat-row"><span class="stat-k">L² p99</span>' +
           '<span class="stat-v">' + fmtNum(global.L2_p99) + '</span></div>';
      h += '<div class="stat-row"><span class="stat-k">Iso dev p95</span>' +
           '<span class="stat-v">' + fmtNum(global.iso_p95) + '</span></div>';

      h += '<div class="ep-divider"></div>';
      h += '<div class="ep-section-title">Швы / переходы (dev)';
      h += '<div class="stat-row"><span class="stat-k">seam рёбер</span>' +
           '<span class="stat-v">' + seamStats.nSeamEdges + '</span></div>';
      h += '<div class="stat-row"><span class="stat-k">err mean</span>' +
           '<span class="stat-v">' + fmtPct(seamStats.mean_err) + '</span></div>';
      h += '<div class="stat-row"><span class="stat-k">err p95</span>' +
           '<span class="stat-v">' + fmtPct(seamStats.p95_err) + '</span></div>';
      h += '<div class="stat-row"><span class="stat-k">рёбер с err&gt;5%</span>' +
           '<span class="stat-v">' + seamStats.overThreshold + ' / ' + seamStats.nSeamEdges + '</span></div>';
    }

    distPanelEl.innerHTML = h;

    // Клики по строкам перфораций
    if (_perfVisible && cache.perforations && cache.perforations.length > 0) {
    const list = distPanelEl.querySelector('#t4-perf-list');
      if (list) {
        // Если до перерисовки была открыта какая-то перфорация — восстановим
        // визуальную подсветку её строки в новом списке.
        if (_shownPerfIdx >= 0) {
          const activeRow = list.querySelector('.t4-perf-item[data-perf-idx="' + _shownPerfIdx + '"]');
          if (activeRow) activeRow.classList.add('t4-perf-item-active');
        }
        list.querySelectorAll('.t4-perf-item').forEach(el => {
          el.addEventListener('click', () => {
            const idx = parseInt(el.getAttribute('data-perf-idx'), 10);
            if (isNaN(idx) || !cache.perforations[idx]) return;

            // Toggle: повторный клик по той же перфорации сворачивает детали.
            if (_shownPerfIdx === idx) {
              hidePerfFloat();   // hidePerfFloat сам обнулит _shownPerfIdx
              el.classList.remove('t4-perf-item-active');
              return;
            }

            // Иначе — открываем детали выбранной перфорации.
            _shownPerfIdx = idx;
            showPerforationReadout(cache.perforations[idx]);
            _highlightedPerfIdx = idx;
            render2D();
            setTimeout(() => { _highlightedPerfIdx = -1; render2D(); }, 2500);

            // Подсвечиваем активную строку, гасим остальные.
            list.querySelectorAll('.t4-perf-item').forEach(other =>
              other.classList.toggle('t4-perf-item-active', other === el));
          });
        });
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════ TOOL / COLOR ═══ */
  function setTool(t) {
    /* Toggle-поведение: клик по уже-активной кнопке возвращает в pointer
       (нейтральная навигация). Это стандартный UX-паттерн «выбран /
       не выбран» — без него инструменты ведут себя как радио-группа,
       и снять текущий инструмент можно только переключившись на другой
       или нажав Esc. Pointer сам по себе — фолбэк, на него этот toggle
       не распространяется (всегда подсвечен, когда нет другого тула). */
    if (t === activeTool && t !== 'pointer') t = 'pointer';
    activeTool = t;
    clearMeasurementsState();
    const map = { pointer: 't4-pointer', polygon: 't4-polygon', ruler: 't4-ruler', rulerchain: 't4-chain', lasso: 't4-lasso', inspect: 't4-inspect', patch: 't4-patch' };
    // Новые id из top-toolbar — суффикс '2'
    const map2 = { pointer: 't4-pointer2', polygon: 't4-polygon2', ruler: 't4-ruler2', rulerchain: 't4-chain2', lasso: 't4-lasso2', inspect: 't4-inspect2', patch: 't4-patch2' };
    for (const k in map) {
      const el = _$(map[k]);
      if (el) el.classList.toggle('active', k === t);
      const el2 = _$(map2[k]);
      if (el2) el2.classList.toggle('active', k === t);
    }
    // «Замер» (t4-measure2) — отдельная кнопка, своя active-логика.
    const elMeas = _$('t4-measure2');
    if (elMeas) elMeas.classList.toggle('active', t === 'measure');
    // Алиас «Область» (t4-area2) тоже подсвечиваем как активный, когда
    // выбран polygon — пользователь жмёт «Область», она светится.
    const elArea = _$('t4-area2');
    if (elArea) elArea.classList.toggle('active', t === 'polygon');
    // body class для курсора
    document.body.classList.remove('t4-tool-pointer','t4-tool-polygon','t4-tool-ruler','t4-tool-rulerchain','t4-tool-lasso','t4-tool-inspect','t4-tool-patch','t4-tool-measure');
    document.body.classList.add('t4-tool-' + t);
    inspectedFace = -1; clearInspect3D();
    if (cache) { render2D(); render3DAnnotations(); }
  }

  function setColorMode(m) {
    /* Toggle-поведение: клик по активной раскраске возвращает в 'zones'
       (анатомический вид по умолчанию). На сам 'zones' toggle не
       распространяется — он всегда подсвечен, когда нет heatmap'а. */
    if (m === colorMode && m !== 'zones') m = 'zones';
    colorMode = m;
    const map  = { zones: 't4-czones',  L2: 't4-cL2',  iso: 't4-ciso',  ring: 't4-cring',  risk: 't4-crisk'  };
    const map2 = { zones: 't4-czones2', L2: 't4-cL22', iso: 't4-ciso2', ring: 't4-cring2', risk: 't4-crisk2' };
    for (const k in map) {
      const el = _$(map[k]);
      if (el) el.classList.toggle('active', k === m);
      const el2 = _$(map2[k]);
      if (el2) el2.classList.toggle('active', k === m);
    }
    if (m !== 'zones') showHeatmap = false;
    if (cache) render2D();
    showColorModeLegend();
    updateDistortionPanel();
    // Перерисуем cursor tip если сейчас hover активен (метрика могла смениться).
    if (inspectedFace >= 0 && cursorTipEl && cursorTipEl.style.display !== 'none') {
      const rect = cursorTipEl.getBoundingClientRect();
      positionCursorTip(rect.left + 10, rect.top + 8, inspectedFace);
    }
  }

  function toggleOverlap() {
    showOverlap = !showOverlap;
    const el = _$('t4-overlap');  if (el)  el.classList.toggle('active', showOverlap);
    const el2 = _$('t4-overlap2'); if (el2) el2.classList.toggle('active', showOverlap);
    if (cache) render2D();
  }

  function togglePerfVisibility() {
  _perfVisible = !_perfVisible;
  const el2 = _$('t4-perf2'); if (el2) el2.classList.toggle('active', _perfVisible);
  if (cache) render2D();
  // Список перфораций в правой панели появляется/исчезает синхронно
  // с видимостью контуров на меше.
  // ВАЖНО: если перфорации скрываются, а сейчас в perf-card открыты их
  // детали — закрыть карточку. Иначе раньше получалось так: пользователь
  // нажал «Перфорация» → раскрыл строку перфорации (детали появились
  // в правой панели) → нажал «Перфорация» ещё раз чтобы выключить
  // инструмент → список исчез, но детали остались висеть.
  if (!_perfVisible && _shownPerfIdx >= 0) hidePerfFloat();
  updateDistortionPanel();
  _toast(_perfVisible ? 'Контуры перфораций показаны' : 'Контуры перфораций скрыты', 'info');
}

  function clearMeasurementsState() {
    lassoPath = []; lassoDrawing = false;
    // 3D-лассо: гасим overlay и path, иначе после Esc / смены инструмента
    // на канвасе остаётся призрачная пунктирная петля.
    lasso3DPath = []; lasso3DDrawing = false;
    if (lasso3DSvg) lasso3DSvg.classList.remove('active');
    if (lasso3DPathEl) {
      lasso3DPathEl.shadow.setAttribute('d', '');
      lasso3DPathEl.line.setAttribute('d', '');
    }
    rulerPts = []; rulerChainPts = [];
    polygonPts = []; selectedFaces = null;
    // Мульти-замер: сбрасываем накопленные отрезки и pending-точку.
    measureLines = []; measurePending = null;
    measurementResult = null;
    inspectedFace = -1;
    if (cache) { cache._rulerPath = null; cache._rulerDist = 0; }
    hideMeasFloat();
    clearInspect3D();
    hideCursorTip();
  }

  /* ═══════════════════════════════════════════════════════════ KEYBOARD ═══ */
  function onKey(e) {
    const stage = document.querySelector('.stage[data-stage="unfold"]');
    if (!stage || !stage.classList.contains('active')) return;
    if (!cache) return;
    // игнорировать если в поле ввода
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
    if (e.key === 'Escape') { clearMeasurementsState(); setTool('pointer'); render2D(); render3DAnnotations(); return; }
    if (e.key === '1') { setTool('pointer'); return; }
    if (e.key === '2') { setTool('polygon'); return; }
    if (e.key === '3') { setTool('ruler'); return; }
    if (e.key === '4') { setTool('rulerchain'); return; }
    if (e.key === '5') { setTool('lasso'); return; }
    if (e.key === '6') { setTool('inspect'); return; }
    if (e.key === '7') { setTool('patch'); return; }
    if (e.key === '9') { setTool('measure'); return; }
    if (e.key === 'u' || e.key === 'U') {
      if (cache && cache.patches && cache.patches.length > 0) {
        const p = undoLastPatch();
        upload3DMesh();
        fit2D(); render2D(); render3DAnnotations();
        updateDistortionPanel();
        _toast('Откат заплатки (зона ' + ZONE_NAMES[p.zone] + ')', 'ok');
        dispatchDataChange('unfold:patch-undone', { zone: p.zone });
      }
      return;
    }
    if (e.key === 'o' || e.key === 'O') { toggleOverlap(); return; }
    if (e.key === 'm' || e.key === 'M') { toggleChartsMode(); return; }
    // Fit (вписать развёртку в канвас): сбрасывает любой зум/пан 2D-вида.
    // F / Home / 0 — все три для удобства: F привычна по графическим
    // редакторам, Home — по «вернуться в начало», 0 — «сбросить уровень».
    if (e.key === 'f' || e.key === 'F' || e.key === 'Home' || e.key === '0') {
      fit2D(); render2D();
      return;
    }
    if (e.key === 'c' || e.key === 'C') {
      const modes = ['zones', 'L2', 'iso', 'ring'];
      const i = modes.indexOf(colorMode);
      setColorMode(modes[(i + 1) % modes.length]);
      return;
    }
    if (e.key === 'Enter' && activeTool === 'polygon' && polygonPts.length >= 3) {
      measurementResult = measurePolygonV2(polygonPts);
      selectedFaces = measurementResult.selected;
      showPolygonMeasurement(measurementResult);
      render2D(); render3DAnnotations();
      return;
    }
    if (e.key === 'z' || e.key === 'Z') {
      if (activeTool === 'polygon' && polygonPts.length > 0) {
        polygonPts.pop();
        if (polygonPts.length >= 3) {
          measurementResult = measurePolygonV2(polygonPts);
          selectedFaces = measurementResult.selected;
          showPolygonMeasurement(measurementResult);
        } else { selectedFaces = null; hideMeasFloat(); }
        render2D(); render3DAnnotations();
      } else if (activeTool === 'measure' && (measureLines.length > 0 || measurePending)) {
        // Undo для measure: сначала отменяем недозавершённую точку,
        // потом — последний целый замер.
        if (measurePending) measurePending = null;
        else measureLines.pop();
        showMeasureReadout();
        render2D(); render3DAnnotations();
      } else if (activeTool === 'rulerchain' && rulerChainPts.length > 0) {
        rulerChainPts.pop();
        if (rulerChainPts.length >= 2) showChainReadout(); else hideMeasFloat();
        render2D(); render3DAnnotations();
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════ ACTIVATE ═══ */
  //
  // Перекрываем заглушку onActivate: теперь при открытии вкладки мы:
  //   • если входные данные устарели → disposeCache (делал стаб)
  //   • обновляем предупреждение
  //   • если DOM построен и кэш есть — рендерим (на случай ресайза)
  //
  window.Tab4.onActivate = function () {
    const d = diagnoseState();
    // Сбрасываем кэш ТОЛЬКО при фатальных состояниях: меш/зоны пропали или
    // размеры не согласованы. 'cache-stale' — reference изменился, но
    // обычно это пересоздание typed-array в tab3 без реальных правок.
    // При cache-stale пользователь сам решит: Rebuild (перестроить) или
    // продолжить с старой картинкой. Автоматический disposeCache при
    // каждом переключении табов ломал UX — развёртка пропадала при просто
    // прогулке по табам.
    if (d.kind === 'no-mesh' || d.kind === 'no-zones' || d.kind === 'stale') {
      disposeCache();
    }
    updateWarningUI();
    if (cache) {
      ensureDOM();
      const split = _$('t4-split'); if (split) split.style.display = '';
      // legacy #t4-toolbar больше не показываем — его место занял .t4-toptools
      const stage = document.querySelector('.stage[data-stage="unfold"]');
      if (stage) {
        stage.classList.add('t4-built');
        stage.classList.add('t4-focused');
      }
      const topTb = document.getElementById('t4-toptools');
      if (topTb) topTb.classList.add('show');
      const empty = document.querySelector('.stage[data-stage="unfold"] .empty-state');
      if (empty) empty.style.display = 'none';
      // Двойной ресайз: сразу и через 250мс — покрывает CSS-transitions
      // у сплиттера/панелей, которые могут менять размер canvas'а.
      const resizeAll = () => {
        fit2D();
        render2D();
        render3DAnnotations();
        if (threeInited && ren3) {
          const c = ren3.domElement;
          ren3.setSize(c.clientWidth, c.clientHeight, false);
          if (cam3) { cam3.aspect = c.clientWidth / Math.max(c.clientHeight, 1); cam3.updateProjectionMatrix(); }
        }
      };
      requestAnimationFrame(resizeAll);
      setTimeout(resizeAll, 260);   // после CSS-transition
    }
  };

  window.Tab4.diagnoseState = diagnoseState;

  /* ═══════════════════════════════════════════════════════════ EVENTS ═══ */
  //
  // Реагируем на cascade событий от tab3 и других:
  //   zones:*  /  inner:*  /  mesh-replaced  /  reset  → disposeCache
  // Плюс свои: unfold:built, unfold:invalidated.
  //
  window.addEventListener('data:change', function (e) {
    const d = e.detail || {};
    // свои события не ломают наш же кэш
    if (d.kind === 'unfold:built' || d.kind === 'unfold:invalidated') { updateWarningUI(); return; }
    if (d.kind === 'zones:invalidated' ||
        d.kind === 'zones:done'        ||
        d.kind === 'zones:edit'        ||
        d.kind === 'inner:saved'       ||
        d.kind === 'inner:invalidated' ||
        d.kind === 'segment-done'      ||
        d.kind === 'mesh-replaced'     ||
        d.kind === 'reset') {
      if (cache) {
        disposeCache();
        window.dispatchEvent(new CustomEvent('data:change', { detail: { kind: 'unfold:invalidated' } }));
      }
    }
    updateWarningUI();
  });

  window.addEventListener('tab:change', function (e) {
    if (e.detail && e.detail.name === 'unfold') window.Tab4.onActivate();
  });

  // Делегированный клик по CTA — баннер и любые кнопки с data-t4-act.
  document.addEventListener('click', function (e) {
    const btn = e.target.closest('[data-t4-act]');
    if (!btn) return;
    const target = btn.dataset.t4Act;
    if (target === 'zones') {
      if (window.Tabs && typeof window.Tabs.switchTo === 'function') window.Tabs.switchTo('zones');
      return;
    }
    if (target === 'rebuild') { buildUnfold(); return; }
  });

  document.addEventListener('keydown', onKey);

  window.addEventListener('resize', function () {
    if (!cache) return;
    requestAnimationFrame(() => {
      fit2D(); render2D();
      if (threeInited && ren3) {
        const c = ren3.domElement;
        ren3.setSize(c.clientWidth, c.clientHeight, false);
        if (cam3) { cam3.aspect = c.clientWidth / Math.max(c.clientHeight, 1); cam3.updateProjectionMatrix(); }
      }
    });
  });

  document.addEventListener('DOMContentLoaded', function () {
    injectCSS();
    // DOM самого таба мы строим лениво — только когда пользователь жмёт CTA.
    updateWarningUI();
  });

  // Если скрипт загрузился после DOMContentLoaded — инициализируем немедленно.
  if (document.readyState === 'interactive' || document.readyState === 'complete') {
    injectCSS();
    updateWarningUI();
  }

  /* ═══════════════════════════════════════════════════════════════════════
   *  v5: SEPTUM PERFORATION TOOL
   *  ──────────────────────────
   *  Клинически значимые перфорации перегородки сохраняются сервером как
   *  inner boundary loops в UV (вместо разреза cut_open). Здесь мы:
   *    • готовим для каждой перфорации вычисленные на клиенте поля (Feret,
   *      площадь shoelace, compactness) — один раз в buildUnfold;
   *    • рисуем красную обводку поверх faces в render2D;
   *    • ловим клик внутри loop'а и показываем панель измерения с
   *      предложением размера лоскута.
   *  Функции определены ВНУТРИ IIFE — имеют доступ к cache, unfTx,
   *  showMeasFloat и другим closure-переменным.
   * ═══════════════════════════════════════════════════════════════════════ */

  function preparePerforations(perfListFromServer, V, uv) {
    /* Сервер даёт массив объектов с loop_idx, perimeter_mm, vertex_indices,
       septum_area_pct, ... Добавляем UV-специфичные поля для рисования. */
    return perfListFromServer.map(p => {
      const vi = p.vertex_indices;
      const n = vi.length;
      const pts2 = new Array(n);
      for (let k = 0; k < n; k++) {
        pts2[k] = [uv[vi[k] * 2], uv[vi[k] * 2 + 1]];
      }
      // shoelace 2D + centroid
      let A2 = 0, cx = 0, cy = 0;
      for (let k = 0; k < n; k++) {
        const a = pts2[k], b = pts2[(k + 1) % n];
        A2 += a[0] * b[1] - b[0] * a[1];
        cx += a[0]; cy += a[1];
      }
      A2 = Math.abs(A2) * 0.5;
      cx /= n; cy /= n;
      // Feret diameter (exhaustive O(n²), OK для n ≤ 300)
      let feret = 0, feretA = null, feretB = null;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const dx = pts2[i][0] - pts2[j][0], dy = pts2[i][1] - pts2[j][1];
          const d2 = dx * dx + dy * dy;
          if (d2 > feret * feret) {
            feret = Math.sqrt(d2); feretA = pts2[i]; feretB = pts2[j];
          }
        }
      }
      // Minor — перпендикулярно Feret-оси
      let minor = 0;
      if (feretA && feretB) {
        const ax = feretB[0] - feretA[0], ay = feretB[1] - feretA[1];
        const L = Math.max(Math.hypot(ax, ay), 1e-9);
        const nx = -ay / L, ny = ax / L;
        let mn = Infinity, mx = -Infinity;
        for (const pt of pts2) {
          const proj = (pt[0] - feretA[0]) * nx + (pt[1] - feretA[1]) * ny;
          if (proj < mn) mn = proj;
          if (proj > mx) mx = proj;
        }
        minor = mx - mn;
      }
      const compactness = (p.perimeter_mm > 0)
        ? (4 * Math.PI * A2) / (p.perimeter_mm * p.perimeter_mm) : 0;

      return Object.assign({}, p, {
        uv_poly: pts2,
        uv_centroid: [cx, cy],
        area_uv_mm2: A2,
        feret_uv_mm: feret,
        minor_uv_mm: minor,
        compactness: compactness,
      });
    });
  }

  function drawPerforations(ctx) {
    /* Компактная отрисовка v5: только тонкое кольцо + номер в кружке.
       Крупная метка P/S с canvas убрана — теперь она в правой панели в
       секции «Перфорации» (updateDistortionPanel). Видимость контролируется
       флагом _perfVisible (тумблер в toolbar "🔴 Перф."). При клике на
       строку перфорации в правой панели она подсвечивается жирнее на
       2.5 сек через _highlightedPerfIdx. */
    if (!_perfVisible) return;
    if (!cache || !cache.perforations || cache.perforations.length === 0) return;
    if (!unfTx || !unfTx.tx) return;
    const tx = unfTx.tx, ty = unfTx.ty;

    ctx.save();
    for (let i = 0; i < cache.perforations.length; i++) {
      const p = cache.perforations[i];
      const isHi = (i === _highlightedPerfIdx);
      const poly = p.uv_poly;

      // Контур — тонкий, без заливки (анатомию не заслоняет).
      // В режиме highlight — толще и с лёгким «пульсом».
      ctx.strokeStyle = isHi ? 'rgba(220, 40, 60, 1.0)' : 'rgba(220, 40, 60, 0.85)';
      ctx.lineWidth = isHi ? 3.0 : 1.5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(tx(poly[0][0]), ty(poly[0][1]));
      for (let k = 1; k < poly.length; k++) {
        ctx.lineTo(tx(poly[k][0]), ty(poly[k][1]));
      }
      ctx.closePath();
      ctx.stroke();

      // Маленький кружок с номером в центре — ненавязчивая метка,
      // соответствует нумерации в правой панели.
      const cx = tx(p.uv_centroid[0]);
      const cy = ty(p.uv_centroid[1]);
      const r = isHi ? 11 : 9;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(220, 40, 60, 0.9)';
      ctx.lineWidth = isHi ? 2.0 : 1.3;
      ctx.stroke();

      ctx.font = (isHi ? 'bold ' : '') + (isHi ? 11 : 10) + 'px Arial, sans-serif';
      ctx.fillStyle = 'rgba(180, 30, 50, 1)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), cx, cy + 0.5);
    }
    ctx.restore();
  }

  function hitTestPerforation(uvX, uvY) {
    /* Point-in-polygon для каждой перфорации.
       uvX, uvY — в миллиметрах (система cache.uv).
       Если контур скрыт (_perfVisible=false) — hit не срабатывает, чтобы
       не ловить невидимый клик. */
    if (!_perfVisible) return null;
    if (!cache || !cache.perforations) return null;
    for (const p of cache.perforations) {
      const poly = p.uv_poly;
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i][0], yi = poly[i][1];
        const xj = poly[j][0], yj = poly[j][1];
        if (((yi > uvY) !== (yj > uvY)) &&
            (uvX < (xj - xi) * (uvY - yi) / (yj - yi + 1e-12) + xi)) {
          inside = !inside;
        }
      }
      if (inside) return p;
    }
    return null;
  }

  function showPerforationReadout(perf) {
  // Раньше детали перфорации писались в meas-card через showMeasFloat —
  // это затирало работающий инструмент (линейка/область/замер). Теперь
  // у перфорации своя отдельная карточка t4-perf-card → showPerfFloat.
  // Параллельно вычисляем индекс перфорации в массиве: эта функция
  // вызывается из ДВУХ мест — клик по строке списка (там индекс уже
  // известен и устанавливается снаружи) и клик по контуру на 2D-канвасе
  // (там приходит только perf-объект). Чтобы оба варианта корректно
  // обновляли _shownPerfIdx, делаем это здесь, в одном месте.
  if (cache && cache.perforations) {
    const idx = cache.perforations.indexOf(perf);
    if (idx >= 0) _shownPerfIdx = idx;
  }

  const P = perf.perimeter_mm;
  const S_mm2 = perf.area_uv_mm2;
  const S_cm2 = S_mm2 / 100;
  const feret = perf.feret_uv_mm;
  const minor = perf.minor_uv_mm;
  const flapW = Math.ceil(feret * 1.2);
  const flapH = Math.ceil(minor * 1.2);
  const flapArea = (flapW * flapH) / 100;

  const row = (lab, val) => '<div class="t4-row"><span class="t4-lab">' + lab +
                            '</span><span class="t4-val">' + val + '</span></div>';

  let html = '';

  // Метрики дефекта — те же .t4-row 12.5px-cyan-monospace,
  // что и в Линейке/Области. Никаких inline-стилей.
  html += row('Периметр',  P.toFixed(1) + ' мм');
  html += row('Площадь',        S_cm2.toFixed(2) + ' см² (' + S_mm2.toFixed(0) + ' мм²)');
  html += row('Макс. диаметр',  feret.toFixed(1) + ' мм');
  html += row('Мин. диаметр',   minor.toFixed(1) + ' мм');

  // Перфорация может частично заходить в латералку или дно —
  // показываем долю в перегородке только если она НЕ 100%.
  // Если 100% — это очевидно из самого факта, что перфорация
  // в списке «перфорации перегородки», и строка лишняя.
  if (perf.septum_area_pct < 99.5) {
    html += row('В перегородке',  perf.septum_area_pct.toFixed(0) + '%');
  }


  showPerfFloat('Перфорация перегородки', html);
}

  /* ═══════════════════════════════════════════════════════════════════════
   *  v5: СИМУЛЯЦИЯ ЛОСКУТА (FLAP SIMULATOR)
   *  ─────────────────────────────────────
   *  Минимальная версия: врач выбирает перфорацию, получает предложение
   *  лоскута размером bbox × 1.2. Позиция / угол / форма настраиваются
   *  через параметры. Рендерится полупрозрачный эллипс/прямоугольник
   *  поверх UV со смещаемой позицией — видно покрывает ли он дефект.
   *
   *  Что считается:
   *   • Площадь флапа (эллипс: πab, прямоугольник: wh)
   *   • Покрытие дефекта (площадь пересечения / площадь дефекта × 100%)
   *   • Запас ткани по периметру (минимальное расстояние от края флапа
   *     до края перфорации)
   * ═══════════════════════════════════════════════════════════════════════ */

  let _flap = null;  // { perfIdx, shape, cx, cy, rx, ry, angle_deg }

  function openFlapSimulator() {
    if (!cache || !cache.perforations || cache.perforations.length === 0) {
      _toast('Нет перфораций для симуляции лоскута. Сначала постройте развёртку.', 'warn');
      return;
    }
    // Если несколько перфораций — взять первую (в будущем: диалог выбора).
    // Если одна — сразу её.
    const idx = (_highlightedPerfIdx >= 0 && _highlightedPerfIdx < cache.perforations.length)
                 ? _highlightedPerfIdx : 0;
    const p = cache.perforations[idx];
    // Инициализация: эллипс вокруг bbox перфорации, с запасом 20%
    const halfW = (p.feret_uv_mm || 10) * 0.6;   // = feret/2 * 1.2
    const halfH = (p.minor_uv_mm || 8)  * 0.6;
    _flap = {
      perfIdx: idx,
      shape: 'ellipse',      // 'ellipse' | 'rect'
      cx: p.uv_centroid[0],
      cy: p.uv_centroid[1],
      rx: halfW,
      ry: halfH,
      angle_deg: 0,
    };
    // Подсвечиваем кнопку Флап в тулбаре — пользователь видит «режим
    // активен», и тот же клик по кнопке закроет симуляцию.
    const elFlap = _$('t4-flap2');
    if (elFlap) elFlap.classList.add('active');
    renderFlapPanel();
    ensurePanelOpen();
    render2D();
  }

  function closeFlapSimulator() {
    _flap = null;
    hideMeasFloat();
    const elFlap = _$('t4-flap2');
    if (elFlap) elFlap.classList.remove('active');
    if (cache) render2D();
  }

  function toggleFlapSimulator() {
    if (_flap) closeFlapSimulator();
    else openFlapSimulator();
  }

  function renderFlapPanel() {
    if (!_flap) return;
    const p = cache.perforations[_flap.perfIdx];
    const area_mm2 = (_flap.shape === 'ellipse')
      ? Math.PI * _flap.rx * _flap.ry
      : (2 * _flap.rx) * (2 * _flap.ry);
    const perf_area = p.area_uv_mm2;

    const row = (k, v) => '<div class="t4-row"><span class="t4-lab">' + k +
                          '</span><span class="t4-val">' + v + '</span></div>';

    let html = '';

    // Главное число — площадь лоскута. id="flap-area-val" → потом
    // обновляем только textContent при движении ползунка, без
    // перестроения всего innerHTML.
    html += '<div class="t4-row" style="background:rgba(0,208,255,.08);padding:6px 8px;' +
            'border-radius:4px;margin-bottom:6px;border:1px solid rgba(0,208,255,.25)">' +
            '<span class="t4-lab" style="font-family:inherit;font-weight:700">ПЛОЩАДЬ ЛОСКУТА</span>' +
            '<span class="t4-val" id="flap-area-val" style="font-size:15px;color:#00d0ff;font-weight:700">' +
            (area_mm2/100).toFixed(2) + ' см²</span></div>';

    // Площадь дефекта — для сравнения, но без расчёта «покрытия»:
    // нынешняя формула (area_лоскута / area_дефекта) геометрически
    // некорректна, она не учитывает форму перекрытия и угол поворота.
    // Лучше показать «голые» площади и дать врачу сравнить глазами.
    html += row('Площадь дефекта', (perf_area/100).toFixed(2) + ' см²');

    // Форма — uppercase-заголовок в стиле остальных подсекций (11px серый).
    html += '<div style="margin-top:12px;font-size:11px;color:var(--tx3);font-weight:700;' +
            'font-family:inherit;letter-spacing:.16em;text-transform:uppercase;margin-bottom:6px">Форма</div>';

    // font-family:inherit на КНОПКАХ обязателен — иначе они наследуют
    // Share Tech Mono из родительского контейнера, у которого нет
    // кириллических глифов: «Эллипс» рендерится как «ЭллипC»,
    // «Прямоуг.» как «Прямоуg.» (см. предыдущий скриншот).
    html += '<div style="display:flex;gap:4px;margin-bottom:10px">' +
            '<button id="flap-shape-ellipse" ' +
            'style="flex:1;padding:7px 8px;font-family:inherit;font-size:12px;font-weight:600;' +
                'cursor:pointer;border-radius:3px;background:' +
                (_flap.shape==='ellipse' ? 'rgba(0,208,255,.85)' : 'transparent') +
                ';color:' + (_flap.shape==='ellipse' ? '#06090f' : 'var(--tx2)') +
                ';border:1px solid ' + (_flap.shape==='ellipse' ? '#00d0ff' : 'var(--brd)') +
                '">Эллипс</button>' +
            '<button id="flap-shape-rect" ' +
            'style="flex:1;padding:7px 8px;font-family:inherit;font-size:12px;font-weight:600;' +
                'cursor:pointer;border-radius:3px;background:' +
                (_flap.shape==='rect' ? 'rgba(0,208,255,.85)' : 'transparent') +
                ';color:' + (_flap.shape==='rect' ? '#06090f' : 'var(--tx2)') +
                ';border:1px solid ' + (_flap.shape==='rect' ? '#00d0ff' : 'var(--brd)') +
                '">Прямоуг.</button></div>';

    // Слайдеры. data-flap-val-for/data-flap-unit — атрибуты-маркеры
    // для адресной правки textContent при input-event без перестройки DOM.
    const mkSlider = (id, label, val, min, max, step, unit) => {
      const pct = ((val - min) / (max - min) * 100).toFixed(1);
      return '<div class="t4-flap-row">' +
        '<div class="t4-flap-row-head">' +
          '<span class="t4-flap-lab">' + label + '</span>' +
          '<span class="t4-flap-val" data-flap-val-for="' + id + '">' +
            val.toFixed(1) + ' ' + unit + '</span>' +
        '</div>' +
        '<input id="' + id + '" class="t4-flap-slider" type="range" ' +
          'min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '" ' +
          'data-flap-unit="' + unit + '" ' +
          'style="--ep-pct:' + pct + '%">' +
      '</div>';
    };
    html += mkSlider('flap-rx-full', 'Размер', _flap.rx * 2, 4, 80, 1, 'мм');
    html += mkSlider('flap-ry-full', 'Высота', _flap.ry * 2, 4, 80, 1, 'мм');
    html += mkSlider('flap-angle',   'Угол',   _flap.angle_deg, -90, 90, 5, '°');

    // Кнопка «Отменить» — выход из режима симуляции лоскута прямо из
    // панели, без поиска кнопки «Флап» в тулбаре. Раньше единственным
    // способом закрыть симулятор был toggle тулбарной кнопки, и из-за
    // десинхрона `_flap` ↔ карточка он работал через раз. Теперь
    // закрытие гарантировано: клик зовёт closeFlapSimulator(), который
    // сбрасывает _flap, гасит .active и вызывает hideMeasFloat.
    html += '<button id="flap-cancel-btn" type="button" ' +
            'style="margin-top:14px;width:100%;padding:8px 10px;' +
            'font-family:inherit;font-size:12px;font-weight:600;' +
            'cursor:pointer;border-radius:3px;background:transparent;' +
            'color:var(--tx2);border:1px solid var(--brd);' +
            'transition:background .12s ease,color .12s ease,border-color .12s ease" ' +
            'onmouseover="this.style.background=\'rgba(255,255,255,.04)\';' +
            'this.style.borderColor=\'var(--cyan)\';this.style.color=\'var(--cyan)\'" ' +
            'onmouseout="this.style.background=\'transparent\';' +
            'this.style.borderColor=\'var(--brd)\';this.style.color=\'var(--tx2)\'">' +
            'Отменить</button>';

    showMeasFloat('Лоскут · перф. #' + (_flap.perfIdx + 1), html);

    // Привязка event'ов. КЛЮЧЕВОЙ МОМЕНТ: на 'input' ползунка делаем
    // АДРЕСНОЕ обновление текста + CSS-переменной, БЕЗ renderFlapPanel().
    // Раньше каждое движение мышью вызывало showMeasFloat → innerHTML →
    // пересоздание DOM-узла слайдера → mouse capture терялся → drag ломался
    // с первого пикселя. Поэтому ползунок работал «не как ползунок».
    setTimeout(() => {
      const liveSlider = (id, applyState) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', e => {
          const v = parseFloat(e.target.value);
          applyState(v);
          const min = parseFloat(e.target.min), max = parseFloat(e.target.max);
          const pct = ((v - min) / (max - min) * 100).toFixed(1);
          e.target.style.setProperty('--ep-pct', pct + '%');
          const valEl = document.querySelector('[data-flap-val-for="' + id + '"]');
          const unit = e.target.getAttribute('data-flap-unit') || '';
          if (valEl) valEl.textContent = v.toFixed(1) + ' ' + unit;
          updateFlapAreaDisplay();
          render2D();
        });
      };
      liveSlider('flap-rx-full', v => { _flap.rx = v / 2; });
      liveSlider('flap-ry-full', v => { _flap.ry = v / 2; });
      liveSlider('flap-angle',   v => { _flap.angle_deg = v; });

      // Кнопки формы — здесь ПОЛНЫЙ ребилд оправдан: меняется визуальное
      // состояние нажатой кнопки (фон + цвет + рамка), это проще
      // перерисовать чем переключать классы вручную. Юзер не «тащит»
      // кнопку, поэтому потери mouse capture не страшны.
      const se = document.getElementById('flap-shape-ellipse');
      const sr = document.getElementById('flap-shape-rect');
      if (se) se.onclick = () => { _flap.shape = 'ellipse'; renderFlapPanel(); render2D(); };
      if (sr) sr.onclick = () => { _flap.shape = 'rect';    renderFlapPanel(); render2D(); };

      // Кнопка «Отменить» — закрывает симулятор. closeFlapSimulator
      // сам сбросит _flap, hideMeasFloat закроет карточку и снимет
      // .active с тулбарной кнопки t4-flap2.
      const cancelBtn = document.getElementById('flap-cancel-btn');
      if (cancelBtn) cancelBtn.onclick = closeFlapSimulator;
    }, 20);
  }

  /* Адресное обновление «ПЛОЩАДЬ ЛОСКУТА» при движении ползунка —
     без перестройки DOM. Вызывается из liveSlider'ов в renderFlapPanel. */
  function updateFlapAreaDisplay() {
    if (!_flap) return;
    const area_mm2 = (_flap.shape === 'ellipse')
      ? Math.PI * _flap.rx * _flap.ry
      : (2 * _flap.rx) * (2 * _flap.ry);
    const el = document.getElementById('flap-area-val');
    if (el) el.textContent = (area_mm2/100).toFixed(2) + ' см²';
  }

  /* Мульти-замер на 2D: каждый отрезок — ПРЯМАЯ хорда A↔B (а не путь по
     сетке), потому что измеряется 3D-расстояние «по воздуху». Линия может
     визуально пересекать перфорацию или область с искажением — это
     нормально и даже желательно: пользователь видит, что замер идёт
     напрямую через дырку, а не вокруг неё. */
  function drawMeasureLinesOnUV(ctx, tx, ty, isDk) {
    if (!cache || !cache.uv) return;
    if (measureLines.length === 0 && !measurePending) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 0; i < measureLines.length; i++) {
      const L = measureLines[i];
      const col = MEASURE_COLORS[i % MEASURE_COLORS.length];
      const ax = tx(L.a.u), ay = ty(L.a.v);
      const bx = tx(L.b.u), by = ty(L.b.v);
      // Прямая линия A→B (без обхода по сетке)
      ctx.strokeStyle = col;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      // Концевые точки — белый кружок с цветной обводкой
      for (const ep of [[ax, ay], [bx, by]]) {
        ctx.beginPath();
        ctx.arc(ep[0], ep[1], 4.5, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
      // Бейдж с длиной + номером посередине отрезка
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      const text = (i + 1) + ': ' + L.dist_mm.toFixed(1) + ' мм';
      ctx.font = 'bold 11px "Share Tech Mono", monospace';
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = col;
      ctx.fillRect(mx - tw / 2 - 6, my - 22, tw + 12, 18);
      ctx.fillStyle = '#06090f';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, mx, my - 13);
    }
    // Pending-точка A: ждём B.
    if (measurePending) {
      const cx = tx(measurePending.u), cy = ty(measurePending.v);
      ctx.beginPath();
      ctx.arc(cx, cy, 6, 0, Math.PI * 2);
      ctx.fillStyle = isDk ? '#0b1220' : '#fff';
      ctx.fill();
      ctx.strokeStyle = '#00d0ff';
      ctx.lineWidth = 2;
      ctx.stroke();
      // Пунктирный крестик-маркер «жду B»
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(cx - 14, cy); ctx.lineTo(cx - 8, cy);
      ctx.moveTo(cx + 8, cy);  ctx.lineTo(cx + 14, cy);
      ctx.moveTo(cx, cy - 14); ctx.lineTo(cx, cy - 8);
      ctx.moveTo(cx, cy + 8);  ctx.lineTo(cx, cy + 14);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  function drawFlap(ctx) {
    /* Рисует полупрозрачный флап на UV. Вызывается из render2D. */
    if (!_flap || !unfTx || !unfTx.tx) return;
    const tx = unfTx.tx, ty = unfTx.ty;
    const cx = tx(_flap.cx), cy = ty(_flap.cy);
    const rxPx = _flap.rx * unfTx.scale;
    const ryPx = _flap.ry * unfTx.scale;
    const ang = _flap.angle_deg * Math.PI / 180;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    ctx.fillStyle = 'rgba(0, 200, 255, 0.25)';
    ctx.strokeStyle = 'rgba(0, 208, 255, 0.9)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 3]);
    ctx.beginPath();
    if (_flap.shape === 'ellipse') {
      ctx.ellipse(0, 0, rxPx, ryPx, 0, 0, Math.PI * 2);
    } else {
      ctx.rect(-rxPx, -ryPx, rxPx * 2, ryPx * 2);
    }
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    // Крестик в центре
    ctx.strokeStyle = 'rgba(0, 208, 255, 1)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-6, 0); ctx.lineTo(6, 0);
    ctx.moveTo(0, -6); ctx.lineTo(0, 6);
    ctx.stroke();
    ctx.restore();
  }

  function flapHitTest(uvX, uvY) {
    if (!_flap) return false;
    // Перевод в локальные координаты флапа (инверсия поворота)
    const dx = uvX - _flap.cx, dy = uvY - _flap.cy;
    const ang = -_flap.angle_deg * Math.PI / 180;
    const lx = dx * Math.cos(ang) - dy * Math.sin(ang);
    const ly = dx * Math.sin(ang) + dy * Math.cos(ang);
    if (_flap.shape === 'ellipse') {
      return (lx*lx)/(_flap.rx*_flap.rx) + (ly*ly)/(_flap.ry*_flap.ry) <= 1.0;
    } else {
      return Math.abs(lx) <= _flap.rx && Math.abs(ly) <= _flap.ry;
    }
  }

  function showPlaceholderInfo(title, text) {
    /* Заглушка для ещё не реализованных слоёв (толщина, риск-зоны).
       Показываем информативное сообщение вместо тихого отказа. */
    let html = '<div style="color:#ffaa33;font-size:11px;margin-bottom:8px">' +
               '⏳ Не реализовано в текущей версии</div>';
    html += '<div style="font-size:12px;line-height:1.5;color:#bcd">' + text + '</div>';
    html += '<button onclick="document.querySelector(\'.t4-measfloat\').style.display=\'none\'" ' +
            'style="margin-top:10px;padding:4px 10px;background:#334;color:#ccc;' +
            'border:0;border-radius:3px;cursor:pointer">Понятно</button>';
    showMeasFloat(title, html);
  }

})();