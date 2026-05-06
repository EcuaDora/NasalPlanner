/* ─── tabs/tab1-data ──────────────────────────────────────────
   Контроллер первой вкладки.
   Слушает data:change, обновляет панели и инициирует 3D-просмотр.

   Владеет: window.M.rawV / rawF / rawNV / rawNF / source.
   При смене исходного меша (новый OBJ) каскадно инвалидирует всё, что
   построено дальше (tab2 inner, tab3 zones, tab4 unfold), и блокирует
   соответствующие вкладки до полного перерасчёта.

   Также предоставляет кнопку «Сброс» — возвращает приложение к
   состоянию «файла нет», готовому принять новый OBJ.
──────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  window.Tab1 = {};

  let viewerInited = false;
  let resizeTimer  = null;

  function fmtBytes(n) {
    if (!n) return '—';
    if (n < 1024)             return n + ' Б';
    if (n < 1024 * 1024)      return (n / 1024).toFixed(1) + ' КБ';
    if (n < 1024 * 1024*1024) return (n / 1024 / 1024).toFixed(2) + ' МБ';
    return (n / 1073741824).toFixed(2) + ' ГБ';
  }

  function row(k, v) {
    return (
      '<div class="stat-row">' +
        '<span class="stat-k">' + k + '</span>' +
        '<span class="stat-v">' + v + '</span>' +
      '</div>'
    );
  }

  /* Подсветка активного шага в «Рабочем процессе» слева.
     Синхронизуется с window.M.currentTab, который меняет core/tabs.js. */
  function updateWorkflowActive() {
    const list = $('workflowSteps');
    if (!list) return;
    const cur = window.M && window.M.currentTab;
    list.querySelectorAll('li').forEach(li => {
      li.classList.toggle('wf-active', li.dataset.step === cur);
    });
  }

  function updatePanels() {
    const M = window.M;
    const hasMesh = !!M.rawV;

    /* Бейдж «тип файла» */
    const srcBadge = $('srcBadge');
    if (srcBadge) srcBadge.textContent = hasMesh ? 'OBJ' : '—';

    /* Содержимое левой карточки «Исходный файл» */
    const srcInfo = $('srcInfo');
    if (srcInfo) {
      if (hasMesh) {
        srcInfo.innerHTML =
          '<div class="file-name">' + _escape(M.source.name || '—') + '</div>' +
          '<div class="hint-text dim">' +
            'размер: ' + fmtBytes(M.source.bytes || 0) +
          '</div>';
      } else {
        srcInfo.innerHTML =
          '<div class="hint-text dim" style="line-height:1.55">' +
            'Файл не загружен. Нажмите <span class="accent">«Открыть файл»</span> ' +
            'в центре окна или перетащите OBJ в область просмотра.' +
          '</div>';
      }
    }

    /* Правая карточка «Статистика» */
    const stats = $('statsContent');
    if (stats) {
      if (hasMesh) {
        const area = window.Geom.totalArea(M.fa, M.rawNF);
        const meanFace = M.rawNF > 0 ? (area / M.rawNF) : 0;
        let html =
          row('вершин', fmtN(M.rawNV)) +
          row('граней', fmtN(M.rawNF)) +
          row('площадь', fmtArea(area));

        /* bbox-размеры — если Geom.bounds доступен и отдаёт что-то
           осмысленное. Аккуратно: формат bounds может отличаться в
           разных версиях geom-утилит — поэтому в try/catch. */


        stats.innerHTML = html;
      } else {
        stats.innerHTML =
          '<div class="hint-text dim">Данные появятся после загрузки файла.</div>';
      }
    }

    /* Требования → после загрузки превращаем в статус-чеклист */
    const req = $('requirementsCard');
    if (req && hasMesh) {
      req.innerHTML =
        '<div class="card-title">Файл принят</div>' +
        row('формат',   '<span style="color:#22c55e">✓ OBJ</span>') +
        row('manifold', '<span style="color:#22c55e">✓ замкнут</span>') +
        row('препроцессинг',
            '<span style="color:#22c55e">✓ выполнен</span>') +
        '<div class="hint-text dim" style="margin-top:10px;font-size:11px;' +
             'line-height:1.5;opacity:.75">' +
          'Меш готов к следующему этапу. Откройте вкладку ' +
          '<span class="accent">02 · Поверхность</span>, чтобы ' +
          'выделить слизистую оболочку.' +
        '</div>';
    }

    /* Рабочий процесс — подсветка текущего таба */
    updateWorkflowActive();

    /* Статус-бар снизу */
    const stMesh = $('stMesh');
    if (stMesh) stMesh.textContent = hasMesh ? (fmtN(M.rawNF) + ' F') : '—';
  }

  function ensureViewer() {
    if (viewerInited)   return true;
    if (!window.THREE)  return false;
    if (!window.Viewer) return false;
    const canvas = $('gl3d');
    if (!canvas) return false;
    if (window.Viewer.init(canvas)) {
      viewerInited = true;
      return true;
    }
    return false;
  }

  function showMeshInViewport() {
    const vp = document.querySelector('.stage[data-stage="data"] .viewport');
    if (vp) vp.classList.add('has-mesh');
    if (!ensureViewer()) return;
    window.Viewer.loadMesh(window.M);
    /* После toggle класса размер canvas мог поменяться */
    requestAnimationFrame(() => window.Viewer.resize());
  }

  function hideMeshFromViewport() {
    const vp = document.querySelector('.stage[data-stage="data"] .viewport');
    if (vp) vp.classList.remove('has-mesh');
    if (viewerInited) window.Viewer.clear();
  }

  window.Tab1.onActivate = function () {
    if (viewerInited && window.M.rawV) {
      requestAnimationFrame(() => window.Viewer.resize());
    }
  };

  window.addEventListener('inputs:ready', () => {
    const tab = document.querySelector('.tab[data-tab="inner"]');
    if (tab) tab.removeAttribute('disabled');
  });

  window.addEventListener('data:change', () => {
    updatePanels();
    if (window.M.rawV) showMeshInViewport();
    else               hideMeshFromViewport();
  });

  /* Переключение вкладок — перерисовать подсветку в workflow */
  window.addEventListener('tab:change', updateWorkflowActive);

  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (viewerInited) window.Viewer.resize();
    }, 100);
  });

  document.addEventListener('DOMContentLoaded', () => {
    updatePanels();
    injectResetCard();
    injectResetCSS();
  });

  // ═════════════════════════════════════════════════════════════════════
  //  Инвалидация пайплайна и «Сброс»
  // ═════════════════════════════════════════════════════════════════════
  //
  //   • lockTab      — защёлкивает <button.tab> в state «disabled», чтобы
  //                    пользователь не мог перейти на неподготовленный шаг.
  //   • clearDerived — чистит всё, что построено поверх rawV/F: inner,
  //                    committed V/F, zone-состояние. НЕ трогает rawV/F.
  //   • cascadeInvalidate — вызывается, когда исходный меш сменился.
  //                    Блокирует 03/04 (02 остаётся доступной, т.к. под
  //                    новый rawV пользователь захочет сразу запустить
  //                    сегментацию). Диспатчит data:change «mesh-replaced».
  //   • resetAll     — полный откат к состоянию «файла нет». Блокирует
  //                    все 3 последующих таба, очищает rawV/F/source,
  //                    возвращает UI к empty-state.
  //
  function lockTab(name) {
    // Фактическая блокировка вкладок делается через
    // gate-функции в tabs.js + refreshGates() на data:change. Т.е.
    // `b.disabled` выставляется по результату gate[name](). Этот
    // setAttribute — только косметика на время между нашим delete
    // поля из window.M и следующим refreshGates: пусть кнопка
    // визуально станет disabled прямо сейчас, не дожидаясь события.
    const tab = document.querySelector('.tab[data-tab="' + name + '"]');
    if (!tab) return;
    tab.setAttribute('disabled', '');
    tab.setAttribute('aria-disabled', 'true');
    try { if ('disabled' in tab) tab.disabled = true; } catch (_) {}
  }

  function clearDerived() {
    const M = window.M;
    if (!M) return;
    // tab2 inner + закоммиченный активный меш
    delete M.V; delete M.F; delete M.nV; delete M.nF;
    delete M.innerV; delete M.innerF; delete M.innerNV; delete M.innerNF;
    // tab3 zones
    delete M.zoneLabels; delete M.zoneMeta;
    delete M.zoneFaces; delete M.zoneMeshes; delete M.zoneBoundaries;
  }

  function cascadeInvalidate() {
    clearDerived();
    // 02 не блокируем — под новый rawV inputs:ready уже выдал доступ
    // к сегментации, пользователь может сразу пройти её заново.
    lockTab('zones');
    lockTab('unfold');
    // Единый сигнал всем подписчикам — сбросить локальные кэши и
    // dispose'нуть редакторы, построенные на старых V/F.
    window.dispatchEvent(new CustomEvent('data:change', {
      detail: { kind: 'mesh-replaced' },
    }));
  }

  function resetAll() {
    const M = window.M;
    if (!M) return;
    // 1. Сброс всех производных + блокировка 02/03/04
    clearDerived();
    lockTab('inner');
    lockTab('zones');
    lockTab('unfold');
    // 2. Сброс исходника
    delete M.rawV; delete M.rawF; delete M.rawNV; delete M.rawNF;
    delete M.fa;
    if (M.source) {
      // Хранилище источника обнуляем, не удаляем — file-loader пишет сюда.
      M.source.name  = '';
      M.source.bytes = 0;
    }
    lastRawV = null;
    // 3. UI: выключаем obj-ready, чистим file-badge, возвращаем пустое
    //    состояние на stage 01.
    document.body.classList.remove('obj-ready');
    document.body.classList.remove('drag-active');
    const fn = document.getElementById('fileName');
    if (fn) fn.textContent = '';
    const fileInput = document.getElementById('fileInput');
    if (fileInput) fileInput.value = '';  // чтобы можно было выбрать тот же файл снова
    hideMeshFromViewport();
    // 4. Переключаемся на 01-ю вкладку (если пользователь нажал сброс
    //    из другой — он всё равно попадает сюда, т.к. остальные заперты).
    try {
      if (window.Tabs && typeof window.Tabs.switchTo === 'function') {
        window.Tabs.switchTo('data');
      }
    } catch (_) {}
    // 5. Единый сигнал — обновить все панели (updatePanels слушает этот
    //    же event) и дать всем контроллерам сбросить локальный кэш.
    window.dispatchEvent(new CustomEvent('data:change', {
      detail: { kind: 'reset' },
    }));
    // 6. Тост (если helper доступен)
    try {
      if (typeof toast === 'function') {
        toast('<strong>Данные сброшены.</strong> Можно открыть новый OBJ-файл.',
          'ok', 4000, { html: true });
      }
    } catch (_) {}
  }

  // Публикуем для возможного вызова из консоли / других мест
  window.Tab1.reset = resetAll;

  // ─── Каскадная инвалидация + автопереход на tab2 при загрузке меша ──
  //
  // rawV-ссылка меняется при загрузке нового файла. Два случая:
  //   - ПЕРВАЯ загрузка (lastRawV === null):  каскад не нужен (ничего
  //     производного ещё не было), но надо автоматически открыть tab2,
  //     чтобы пользователь сразу начал сегментацию.
  //   - ПОВТОРНАЯ загрузка:                   инвалидируем всё снизу
  //     по цепочке (cascadeInvalidate), затем тоже переключаемся на tab2.
  //
  // Переключение делаем ПОСЛЕ того как tabs.js отработал свой собственный
  // data:change-listener (он зарегистрирован раньше нас, т.к. tabs.js
  // подключён в HTML первым — refreshGates уже пересчитал гейт inner).
  //
  let lastRawV = null;
  window.addEventListener('data:change', (e) => {
    const d = (e && e.detail) || {};
    // Событие-reset мы сами же отправили из resetAll — пропускаем,
    // чтобы не перезапустить каскад рекурсивно.
    if (d.kind === 'reset' || d.kind === 'mesh-replaced') return;
    const M = window.M;
    if (!M) return;
    if (M.rawV !== lastRawV) {
      const hadPrev = lastRawV !== null;
      lastRawV = M.rawV;
      if (hadPrev && M.rawV) cascadeInvalidate();
      if (M.rawV && window.Tabs && typeof window.Tabs.switchTo === 'function') {
        // Гейт 'inner' — !!M.rawV, уже true. switchTo сработает без
        // отсрочек, поскольку refreshGates только что обновил b.disabled.
        window.Tabs.switchTo('inner');
      }
    }
  });

  // ═════════════════════════════════════════════════════════════════════
  //  Кнопка «Сброс» (инжектится в DOM)
  // ═════════════════════════════════════════════════════════════════════

  function injectResetCard() {
    const leftPanel = document.querySelector('.stage[data-stage="data"] .panel.left');
    if (!leftPanel) return;
    if (document.getElementById('resetCard')) return;  // уже вставлен

    const card = document.createElement('div');
    card.className = 'card';
    card.id = 'resetCard';
    card.innerHTML = [
      '<div class="card-title">Сброс</div>',
      '<button type="button" class="btn-reset" id="btnResetAll" ',
              'style="display:flex;align-items:center;gap:8px;margin-top:8px;',
                     'width:100%;justify-content:center;padding:10px 14px;',
                     'border-radius:6px;cursor:pointer;font:inherit;font-size:13px">',
        '<svg width="14" height="14" viewBox="0 0 18 18" fill="none" aria-hidden="true">',
          '<path d="M14.5 9a5.5 5.5 0 11-1.7-3.95M14.5 3v3.5h-3.5" ',
                    'stroke="currentColor" stroke-width="1.4" ',
                    'stroke-linecap="round" stroke-linejoin="round"/>',
        '</svg>',

        'Начать заново',
      '</button>',
      '<div class="hint-text dim" style="margin-top:10px;font-size:11px;',
             'line-height:1.5;opacity:.75">',
        'Удалить текущий OBJ и все производные (слизистую, зоны, развёртку). ',
        'После сброса можно загрузить другой файл.',
      '</div>',
    ].join('');
    leftPanel.appendChild(card);

    const btn = document.getElementById('btnResetAll');
    if (btn) btn.addEventListener('click', onResetClick);
  }

  function onResetClick() {
    if (!window.M || !window.M.rawV) return;       // нечего сбрасывать
    // Подтверждение, чтобы случайный клик не убил работу пользователя.
    const hasDerived = !!(window.M.V || window.M.innerV || window.M.zoneLabels);
    const msg = hasDerived
      ? 'Сбросить текущий сеанс? Все результаты сегментации, ' +
        'разметки зон и развёртки будут удалены.'
      : 'Сбросить текущий OBJ-файл?';
    appConfirm(msg, {
      title: 'Начать заново?',
      okLabel: 'Сбросить',
      cancelLabel: 'Отмена',
      variant: 'warn',
    }).then(ok => { if (ok) resetAll(); });
  }

  // ═════════════════════════════════════════════════════════════════════
  //  Themed confirm modal
  // ═════════════════════════════════════════════════════════════════════
  //
  //   appConfirm(msg, opts) -> Promise<boolean>
  //     opts.title       — заголовок модалки
  //     opts.okLabel     — текст основной кнопки
  //     opts.cancelLabel — текст кнопки отмены
  //     opts.variant     — 'warn' (оранжевая, default) | 'ghost'
  //
  //   UX: Esc / клик по подложке — отмена; Enter — подтверждение;
  //       фокус автоматом улетает на OK-кнопку; backdrop блокирует scroll.
  //
  function appConfirm(msg, opts) {
    opts = opts || {};
    const title       = opts.title       || 'Подтверждение';
    const okLabel     = opts.okLabel     || 'OK';
    const cancelLabel = opts.cancelLabel || 'Отмена';
    const variant     = opts.variant     || 'warn';
    const okClass     = variant === 'ghost' ? 'app-modal-btn-ghost'
                                            : 'app-modal-btn-warn';

    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'app-modal-backdrop';
      backdrop.setAttribute('role', 'dialog');
      backdrop.setAttribute('aria-modal', 'true');
      backdrop.innerHTML = [
        '<div class="app-modal">',
          '<div class="app-modal-title">', _escape(title), '</div>',
          '<div class="app-modal-body">',  _escape(msg),   '</div>',
          '<div class="app-modal-actions">',
            '<button type="button" class="app-modal-btn app-modal-btn-ghost" ',
                    'data-act="cancel">', _escape(cancelLabel), '</button>',
            '<button type="button" class="app-modal-btn ', okClass, '" ',
                    'data-act="ok">', _escape(okLabel), '</button>',
          '</div>',
        '</div>',
      ].join('');

      const prevOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';

      function close(result) {
        document.removeEventListener('keydown', onKey, true);
        document.body.style.overflow = prevOverflow;
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        resolve(result);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
        else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(true); }
      }

      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) close(false);   // клик по подложке
      });
      backdrop.querySelector('[data-act="cancel"]')
              .addEventListener('click', () => close(false));
      backdrop.querySelector('[data-act="ok"]')
              .addEventListener('click', () => close(true));
      document.addEventListener('keydown', onKey, true);

      document.body.appendChild(backdrop);

      // Autofocus на OK — Enter сразу сработает, Tab уйдёт на Cancel.
      requestAnimationFrame(() => {
        const okBtn = backdrop.querySelector('[data-act="ok"]');
        if (okBtn) okBtn.focus();
      });
    });
  }

  function injectResetCSS() {
    if (document.getElementById('tab1-reset-css')) return;
    const s = document.createElement('style');
    s.id = 'tab1-reset-css';
    s.textContent = [
      /* Карточка «Сброс» показывается только когда OBJ загружен. */
      '#resetCard { display: none; }',
      'body.obj-ready #resetCard { display: block; }',
      /* Акцентная кнопка сброса — подсвечиваемся мягким оранжевым, */
      /* чтобы не спутать со штатным «Далее» на следующий этап.     */
      '.btn-reset {',
      '  background: rgba(255, 159, 60, 0.10);',
      '  color: var(--warn, #ff9f3c);',
      '  border: 1px solid var(--warn, #ff9f3c);',
      '  transition: background 0.14s ease, color 0.14s ease, box-shadow 0.14s ease;',
      '}',
      '.btn-reset:hover  { background: rgba(255, 159, 60, 0.18); box-shadow: 0 0 10px rgba(255, 159, 60, 0.18); }',
      '.btn-reset:active { background: rgba(255, 159, 60, 0.28); }',

      /* ═══ Общая тема приложения ═══ */
      '.app-modal-backdrop {',
      '  position: fixed; inset: 0; z-index: 10000;',
      '  display: flex; align-items: center; justify-content: center;',
      '  background: rgba(0, 5, 15, 0.72);',
      '  -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px);',
      '  animation: app-modal-fade 0.15s ease-out;',
      '}',
      '@keyframes app-modal-fade { from { opacity: 0; } to { opacity: 1; } }',
      '@keyframes app-modal-pop {',
      '  from { transform: translateY(6px) scale(0.985); opacity: 0; }',
      '  to   { transform: translateY(0) scale(1); opacity: 1; }',
      '}',
      '.app-modal {',
      '  min-width: 320px; max-width: 440px;',
      '  background: var(--card-solid, #0b1220);',
      '  border: 1px solid var(--brd-glow, rgba(0,240,255,.25));',
      '  border-radius: var(--rad, 8px);',
      '  box-shadow: 0 0 30px rgba(0,240,255,.06), 0 10px 40px rgba(0,0,0,.55);',
      '  padding: 20px 22px 16px;',
      '  position: relative;',
      '  animation: app-modal-pop 0.18s cubic-bezier(.2,.9,.3,1.2);',
      '}',
      /* тонкая неон-линия сверху — как у .card */
      '.app-modal::before {',
      '  content: ""; position: absolute;',
      '  top: 0; left: 16px; right: 16px; height: 1px;',
      '  background: linear-gradient(90deg, transparent, var(--cyan, #00f0ff), transparent);',
      '  opacity: 0.5;',
      '}',
      '.app-modal-title {',
      "  font-family: 'Orbitron','Segoe UI','Helvetica Neue',Roboto,sans-serif;",
      '  font-size: 12px; font-weight: 700;',
      '  letter-spacing: 0.14em; text-transform: uppercase;',
      '  color: var(--cyan, #00f0ff);',
      '  margin-bottom: 10px;',
      '  display: flex; align-items: center; gap: 8px;',
      '}',
      '.app-modal-title::before {',
      '  content: ""; width: 3px; height: 13px;',
      '  background: var(--cyan, #00f0ff);',
      '  box-shadow: 0 0 6px var(--cyan, #00f0ff);',
      '  border-radius: 1px; flex-shrink: 0;',
      '}',
      '.app-modal-body {',
      '  font-size: 13px; line-height: 1.55;',
      '  color: var(--tx, #c8e6ff);',
      '  margin-bottom: 18px;',
      '}',
      '.app-modal-actions {',
      '  display: flex; gap: 8px; justify-content: flex-end;',
      '}',
      '.app-modal-btn {',
      '  min-width: 96px; padding: 9px 16px;',
      '  border-radius: 4px; font: inherit; font-size: 12.5px;',
      '  font-weight: 600; letter-spacing: 0.02em;',
      '  cursor: pointer; background: transparent;',
      '  transition: background 0.14s ease, color 0.14s ease, ',
      '              border-color 0.14s ease, box-shadow 0.14s ease;',
      '}',
      '.app-modal-btn:focus-visible {',
      '  outline: 2px solid var(--brd-glow, rgba(0,240,255,.25));',
      '  outline-offset: 2px;',
      '}',
      '.app-modal-btn-ghost {',
      '  border: 1px solid var(--brd, rgba(0,240,255,.12));',
      '  color: var(--tx2, #6b8faa);',
      '}',
      '.app-modal-btn-ghost:hover {',
      '  border-color: var(--brd-glow, rgba(0,240,255,.25));',
      '  color: var(--tx, #c8e6ff);',
      '  background: rgba(0,240,255,0.04);',
      '}',
      '.app-modal-btn-warn {',
      '  border: 1px solid var(--warn, #ff9f3c);',
      '  color: var(--warn, #ff9f3c);',
      '  background: rgba(255,159,60,0.10);',
      '}',
      '.app-modal-btn-warn:hover {',
      '  background: rgba(255,159,60,0.20);',
      '  box-shadow: 0 0 12px rgba(255,159,60,0.25);',
      '}',

      /* ── light-theme ──────────────────────────────── */
      '.light-theme .app-modal-backdrop {',
      '  background: rgba(226,232,240,0.70);',
      '}',
      '.light-theme .app-modal {',
      '  background: #ffffff;',
      '  border-color: rgba(79,124,219,0.25);',
      '  box-shadow: 0 10px 40px rgba(30,60,120,0.15), 0 0 0 1px rgba(79,124,219,0.08);',
      '}',
      '.light-theme .app-modal::before {',
      '  background: linear-gradient(90deg, transparent, #4F7CDB, transparent);',
      '  opacity: 0.4;',
      '}',
      '.light-theme .app-modal-title { color: #4F7CDB; }',
      '.light-theme .app-modal-title::before { background: #4F7CDB; box-shadow: none; }',
      '.light-theme .app-modal-body { color: #1e293b; }',
      '.light-theme .app-modal-btn-ghost {',
      '  border-color: #dfe4ec; color: #475569;',
      '}',
      '.light-theme .app-modal-btn-ghost:hover {',
      '  border-color: rgba(79,124,219,0.4); color: #1e293b; background: #f8fafc;',
      '}',
      '.light-theme .app-modal-btn-warn {',
      '  border-color: #d97706; color: #d97706;',
      '  background: rgba(217,119,6,0.08);',
      '}',
      '.light-theme .app-modal-btn-warn:hover {',
      '  background: rgba(217,119,6,0.16);',
      '  box-shadow: 0 0 0 3px rgba(217,119,6,0.12);',
      '}',
    ].join('\n');
    document.head.appendChild(s);
  }

  /* ─── helpers ─── */
  function _escape(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
})();