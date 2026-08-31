/* ─── tabs/tab0-segment ─────────────────────────────────────────
   Этап 00: автосегментация КТ моделью + ручная правка маски.

   Пайплайн вкладки:
     1) врач грузит КТ (.nrrd) — ct-loader.js кладёт его в session/ct_raw;
     2) «Запустить сегментацию» → SSE /api/infer/stream (внешний torch);
     3) /api/roi_pair режет КТ+маску в выровненный ROI;
     4) грузим roi_ct + roi_mask, открываем 2D-редактор срезов;
     5) правка: Кисть / Ластик (на срезе КТ) + Ножницы (удалить 3D-кусок);
     6) «Скачать пару» → правка коммитится в session/roi_mask,
        /api/export_pair собирает zip (images/<id>_img.nrrd +
        labels/<id>_seg.nrrd) для дообучения.

   Стиль и поведение скопированы с tab2-inner.js: локальный спиннер этапа,
   empty-state с кнопкой запуска, делегирование кликов, SSE-парсинг.
──────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  console.log('[версия] tab0 · 2026-08-15 · этап 01 · без кнопки «Сохранить пару», есть restoreFromSession');

  let editor = null;     // экземпляр SliceEditor
  let ctReady = false;   // загружен ли ct_raw
  let segPatient = '';   // ФИО пациента из DICOM (для имени пары)

  // ─── Локальный спиннер этапа (как _showSpinner в tab2) ──────────────
  function _spin(text) {
    const sp = document.getElementById('spinnerSegment');
    const tx = document.getElementById('spinnerSegmentText');
    if (tx) tx.textContent = text || 'Обработка…';
    if (sp) sp.classList.add('show');
  }
  function _spinText(text) {
    const tx = document.getElementById('spinnerSegmentText');
    if (tx) tx.textContent = text || '';
  }
  function _spinHide() {
    const sp = document.getElementById('spinnerSegment');
    if (sp) sp.classList.remove('show');
  }
  function _toast(msg, kind, ms, opt) {
    if (typeof toast === 'function') toast(msg, kind, ms, opt);
    else console.log('[seg]', msg);
  }

  /* ─── Конфиг модели (пути) ────────────────────────────────────────
     Хранится ТОЛЬКО на сервере, в .nasal_infer_cfg.json рядом с проектом.

     Раньше было два хранилища — localStorage и серверный файл, — и они
     расходились: при заполнении полей приоритет отдавался localStorage,
     а сервер применял свой _prefer(). Плюс автопоиск после каждого
     запуска перезаписывал оба, затирая путь, введённый врачом вручную.
     Теперь одна точка истины: persistCfg() пишет, серверный infer_config
     при чтении сам подставляет сохранённое.

     Побочный плюс: конфиг стал общим для машины, а не для профиля
     браузера, и его можно просто открыть и посмотреть. */
  function persistCfg() {
    const c = readCfg();
    try {
      fetch('/api/infer_config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ save: true, python: c.python, script: c.script, ckpt: c.ckpt }),
      }).catch(() => {});
    } catch (_) {}
  }

  function setupStaticUI() {
    const stage = document.querySelector('.stage[data-stage="segment"]');
    if (!stage) return;
    injectCSS();
    buildLeftPanel(stage);
    buildEmptyState(stage);
    buildRightPanel(stage);
    installDicomDrop(stage);
    loadDefaults();   // авто-поиск путей после построения полей


    ['segPyPath', 'segScriptPath', 'segCkptPath'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const commit = () => { updateCfgBadge(); persistCfg(); };
      el.addEventListener('change', commit);
      el.addEventListener('blur', commit);
    });

    // Делегирование кликов по всему стейджу
    stage.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="seg-open-dicom"]')) { openDicom(); return; }
      if (e.target.closest('.btn-run-seg')) { runInfer(); return; }
      const t = e.target.closest('[data-segtool]');
      if (t && editor) { editor.setTool(t.dataset.segtool); return; }
      if (e.target.closest('[data-act="seg-undo"]')   && editor) { editor.undo(); return; }
      if (e.target.closest('[data-act="seg-redo"]')   && editor) { editor.redo(); return; }
      const shapeBtn = e.target.closest('[data-segshape]');
      if (shapeBtn && editor) {
        editor.setBrush3D(shapeBtn.dataset.segshape === 'ball');
        document.querySelectorAll('[data-segshape]').forEach(b => b.classList.toggle('active', b === shapeBtn));
        return;
      }
      if (e.target.closest('[data-act="seg-clean"]')  && editor) { editor.clean(); return; }
      if (e.target.closest('[data-act="seg-patch"]')  && editor) { editor.patch(); return; }
      if (e.target.closest('[data-act="seg-close"]')  && editor) { editor.closeFill(); return; }
      if (e.target.closest('[data-act="seg-interp"]') && editor) { editor.runInterp(); return; }
      if (e.target.closest('[data-act="seg-smooth"]') && editor) { editor.smooth(); return; }
      if (e.target.closest('[data-act="seg-reset"]')  && editor) {
        segConfirm('Сбросить все ваши правки и вернуть область, которую предложила программа?', {
          title: 'Вернуть как было?', okLabel: 'Сбросить', cancelLabel: 'Отмена', variant: 'warn',
        }).then((ok) => { if (ok && editor) editor.resetToAuto(); });
        return;
      }
      if (e.target.closest('[data-act="seg-download"]')) { downloadPair(); return; }
      if (e.target.closest('[data-act="seg-obj"]')) { downloadOBJ(); return; }
      if (e.target.closest('[data-act="seg-next"]')) { goToData(); return; }
    });
  }

  function buildLeftPanel(stage) {
    const left = stage.querySelector('.panel.left');
    if (!left) return;
    left.innerHTML = [
      '<div class="card">',
        '<div class="card-title">Этап 01<span class="badge">Разметка КТ</span></div>',
        '<div class="hint-text dim" style="line-height:1.55">',
          'Загрузите <span class="accent">КТ из папки DICOM</span> и запустите модель — ',
          'она выделит целевую область. Затем поправьте маску прямо на срезах ',
          'и выгрузите пару для дообучения.',
        '</div>',
      '</div>',

      '<details class="card seg-settings" id="segModelCard">',
        '<summary class="card-title seg-set-summary"><span class="seg-set-name">Настройки модели</span><span class="badge" id="segCfgBadge">…</span></summary>',
        '<div class="hint-text dim seg-set-note">',
          'Пути определяются автоматически. Если поле <span class="seg-warn-t">оранжевое</span> — выберите файл вручную.',
        '</div>',
        _cfgField('Python окружения', 'segPyPath'),
        _cfgField('Скрипт инференса', 'segScriptPath'),
        _cfgField('Файл модели (.ckpt)', 'segCkptPath'),
      '</details>',
    ].join('');

    // делегирование действий по полям настроек
    const seg = document.getElementById('segModelCard');
    if (seg) {
      seg.addEventListener('click', (e) => {
        // клик по полю пути ИЛИ по кнопке папки → открыть проводник
        const b = e.target.closest('[data-browse]');
        if (b) { e.preventDefault(); openCfgBrowse(b.dataset.browse); }
      });
    }
  }

  // аккуратная иконка папки (наследует цвет через currentColor → акцентный синий)
  function _folderSvg() {
    return '<svg class="seg-folder-ic" viewBox="0 0 20 20" width="16" height="16" ' +
      'fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<path d="M2.5 5.2c0-.66.54-1.2 1.2-1.2h3.05c.32 0 .62.13.85.35l1 .98c.22.22.53.34.84.34H16.3' +
      'c.66 0 1.2.54 1.2 1.2v8.1c0 .66-.54 1.2-1.2 1.2H3.7c-.66 0-1.2-.54-1.2-1.2V5.2z" ' +
      'fill="currentColor" fill-opacity="0.18" stroke="currentColor" stroke-width="1.4" ' +
      'stroke-linejoin="round"/></svg>';
  }

  // одно поле-настройка: текущий путь (только для чтения) + кнопка обзора
  function _cfgField(label, id) {
    const isPy = (id === 'segPyPath');
    const ttl = isPy ? 'Выбрать папку окружения или python' : 'Выбрать файл';
    return [
      '<div class="seg-field">',
        '<label>', label, '</label>',
        '<div class="seg-field-row">',
          '<div id="', id, '" class="seg-cfg-val" data-browse="', id, '" data-path="" data-ok="0" ',
            'title="нажмите, чтобы выбрать">',
            '<span class="seg-cfg-txt"><bdi class="seg-cfg-bdi" dir="ltr">поиск…</bdi></span>',
          '</div>',
          '<button type="button" class="seg-browse-btn" data-browse="', id, '" title="', ttl, '">', _folderSvg(), '</button>',
        '</div>',
      '</div>',
    ].join('');
  }

  // значение поля
  function fieldVal(id) {
    const el = document.getElementById(id);
    return (el && el.dataset.path) || '';
  }

  // путь для показа: нормализуем слэши, показываем целиком —
  // CSS обрезает поле слева, поэтому конец (имя файла) всегда виден
  function prettyPath(p) {
    return String(p || '').replace(/\\/g, '/');
  }

  // показать путь в поле + проставить статус
  function _setVal(id, path, ok) {
    const el = document.getElementById(id);
    if (!el) return;
    el.dataset.path = path || '';
    el.dataset.ok = ok ? '1' : '0';
    el.title = path || 'нажмите, чтобы выбрать';
    const txt = el.querySelector('.seg-cfg-bdi') || el;
    txt.textContent = path ? prettyPath(path) : '— не выбрано —';
    colorField(id);
  }

  // первичное заполнение из автопоиска/сохранённого
  function fillCandidates(id, cands, chosen, chosenOk) {
    const el = document.getElementById(id);
    if (!el) return;
    const list = (cands || []).filter((c) => c && c.path);
    let ok = !!chosenOk;
    const hit = list.find((c) => c.path === chosen);
    if (hit) ok = hit.ok !== false;
    _setVal(id, chosen || '', ok);
  }

  // выбранный путь — записать в поле + сохранить
  function setFieldPath(id, path, ok) {
    if (!path) return;
    _setVal(id, path, !!ok);
    updateCfgBadge();
    persistCfg();
  }

  function colorField(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const ok = el.dataset.ok === '1';
    el.classList.toggle('seg-cfg-ok', ok);
    el.classList.toggle('seg-cfg-warn', !ok);
  }

  function updateCfgBadge() {
    const badge = document.getElementById('segCfgBadge');
    if (!badge) return;
    const ids = ['segPyPath', 'segScriptPath', 'segCkptPath'];
    let okCount = 0;
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el && el.dataset.ok === '1') okCount++;
    });
    const all = okCount === ids.length;
    badge.textContent = all ? 'готово' : (okCount + ' из 3');
    badge.classList.toggle('seg-cfg-ok', all);
    badge.classList.toggle('seg-cfg-warn', !all);
  }

  function _selOk(id) {
    const el = document.getElementById(id);
    return !!(el && el.dataset.ok === '1');
  }

  function readCfg() {
    return {
      python: fieldVal('segPyPath'),
      script: fieldVal('segScriptPath'),
      ckpt:   fieldVal('segCkptPath'),
      device: 'auto',
      ok: { python: _selOk('segPyPath'), script: _selOk('segScriptPath'), ckpt: _selOk('segCkptPath') },
    };
  }

  // все ли пути модели валидны — для решения об автозапуске сегментации
  function modelCfgReady() {
    return _selOk('segPyPath') && _selOk('segScriptPath') && _selOk('segCkptPath');
  }

  // ─── Файловый проводник для выбора python / скрипта / ckpt ───────────
  const _cfgKind = { segPyPath: 'python', segScriptPath: 'py', segCkptPath: 'ckpt' };
  const _cfgTitle = {
    segPyPath: 'Выберите Python окружения инференса',
    segScriptPath: 'Выберите скрипт инференса (.py)',
    segCkptPath: 'Выберите файл модели (.ckpt)',
  };

  function _fileVisible(name, kind) {
    const n = name.toLowerCase();
    if (kind === 'dir') return false;   // выбор папки DICOM — файлы не показываем
    if (kind === 'py') return n.endsWith('.py');
    if (kind === 'ckpt') return n.endsWith('.ckpt');
    if (kind === 'python') {
      return /python/i.test(name) || n.endsWith('.exe') || !name.includes('.');
    }
    return true;
  }

  function openCfgBrowse(id) {
    const kind = _cfgKind[id] || 'any';
    const isPy = (id === 'segPyPath');
    const cur = fieldVal(id);
    const startDir = (cur && /^([A-Za-z]:|\/)/.test(cur)) ? cur.replace(/[\\/][^\\/]*$/, '') : '';
    openFsPicker({
      title: _cfgTitle[id] || 'Выберите файл',
      kind: kind,
      start: startDir,
      allowDir: isPy,
      dirHint: isPy ? 'Зайдите в папку окружения и нажмите «Выбрать эту папку» (или выберите python.exe).' : '',
      onPick: async (p) => {
        if (isPy) { await resolveAndSetPython(id, p); }
        else { setFieldPath(id, p, true); }
      },
    });
  }

  // папка/файл окружения → сервер находит интерпретатор и проверяет пакеты
  async function resolveAndSetPython(id, p) {
    _spin('Проверка Python-окружения…');
    try {
      const r = await fetch('/api/resolve_python?dir=' + encodeURIComponent(p)).then((x) => {
        if (!x.ok) throw new Error('HTTP ' + x.status);
        return x.json();
      });
      _spinHide();
      if (r && r.python) {
        setFieldPath(id, r.python, !!r.ok);
        if (!r.ok) _toast('В окружении не найдены torch / monai / SimpleITK', 'warn', 5000);
      } else {
        setFieldPath(id, p, false);
        _toast('Python не найден в выбранной папке', 'warn', 5000);
      }
    } catch (err) {
      _spinHide();
      setFieldPath(id, p, false);
      _toast('Не удалось проверить окружение: ' + err.message, 'err', 6000);
    }
  }

  let _fsState = null;
  function openFsPicker(opts) {
    const stage = document.querySelector('.stage[data-stage="segment"]');
    const vp = stage && stage.querySelector('.viewport');
    if (!vp) return;
    closeFsPicker();
    _fsState = opts;
    const ov = document.createElement('div');
    ov.className = 'seg-picker';
    ov.id = 'segFsPicker';
    ov.innerHTML = [
      '<div class="seg-picker-box">',
        '<div class="seg-picker-title">', esc(opts.title || 'Выбор файла'), '</div>',
        (opts.dirHint ? '<div class="seg-picker-hint">' + esc(opts.dirHint) + '</div>' : ''),
        '<div class="seg-picker-hint" id="fsPath">…</div>',
        '<div class="seg-picker-list" id="fsList"></div>',
        '<div class="seg-picker-actions">',
          '<button type="button" class="seg-mini" data-fs="drives">Диски / корень</button>',
          (opts.allowDir ? '<button type="button" class="seg-mini" data-fs="pickdir">' + _folderSvg() + ' Выбрать эту папку</button>' : ''),
          '<button type="button" class="seg-mini" data-fs="cancel">Отмена</button>',
        '</div>',
      '</div>',
    ].join('');
    vp.appendChild(ov);
    ov.addEventListener('click', (e) => {
      const b = e.target.closest('[data-fs]');
      if (b) {
        if (b.dataset.fs === 'cancel') closeFsPicker();
        else if (b.dataset.fs === 'drives') fsLoad('@drives');
        else if (b.dataset.fs === 'pickdir') {
          const cur = _fsState && _fsState.cur;
          if (cur && cur !== '@drives') { closeFsPicker(); if (opts.onPick) opts.onPick(cur); }
          else _toast('Зайдите в нужную папку', 'warn');
        }
        return;
      }
      const dir = e.target.closest('[data-fsdir]');
      if (dir) { fsLoad(dir.dataset.fsdir); return; }
      const file = e.target.closest('[data-fsfile]');
      if (file) {
        const p = file.dataset.fsfile;
        closeFsPicker();
        if (_fsState && _fsState.onPick) _fsState.onPick(p);
      }
    });
    fsLoad(opts.start || '');
  }
  function closeFsPicker() {
    const ov = document.getElementById('segFsPicker');
    if (ov) ov.remove();
    _fsState = null;
  }
  async function fsLoad(path) {
    const listEl = document.getElementById('fsList');
    const pathEl = document.getElementById('fsPath');
    if (!listEl) return;
    listEl.innerHTML = '<div class="seg-picker-hint">Загрузка…</div>';
    let d;
    try {
      d = await fetch('/api/fs_list?path=' + encodeURIComponent(path || '')).then((r) => {
        if (r.status === 404) throw new Error('обзор ФС недоступен (404) — откройте приложение через Flask');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
    } catch (err) {
      listEl.innerHTML = '<div class="seg-picker-hint" style="color:#e0a64a">' + esc(err.message) + '</div>';
      return;
    }
    if (pathEl) pathEl.textContent = (d.path === '@drives') ? 'Диски' : d.path;
    if (_fsState) _fsState.cur = d.path;
    const kind = (_fsState && _fsState.kind) || 'any';
    const rows = [];
    if (d.parent) {
      rows.push('<button type="button" class="seg-series-row" data-fsdir="' + esc(d.parent) + '">' +
        '<span class="seg-series-main"><span class="seg-series-desc">⤴ ..</span></span></button>');
    }
    (d.dirs || []).forEach((dir) => {
      rows.push('<button type="button" class="seg-series-row" data-fsdir="' + esc(dir.path) + '">' +
        '<span class="seg-series-main"><span class="seg-series-desc">' + _folderSvg() + ' ' + esc(dir.name) + '</span></span></button>');
    });
    (d.files || []).forEach((f) => {
      if (!_fileVisible(f.name, kind)) return;
      rows.push('<button type="button" class="seg-series-row seg-fs-file" data-fsfile="' + esc(f.path) + '">' +
        '<span class="seg-series-main"><span class="seg-series-desc">📄 ' + esc(f.name) + '</span></span>' +
        '<span class="seg-series-meta">выбрать</span></button>');
    });
    if (!rows.length) rows.push('<div class="seg-picker-hint">Подходящих файлов нет — зайдите в нужную папку.</div>');
    listEl.innerHTML = rows.join('');
  }

  function buildEmptyState(stage) {
    const empty = stage.querySelector('.empty-state');
    if (!empty) return;
    empty.innerHTML = [
      // ── Тот же логотип, что в empty-state вкладки «Данные» ──
      '<div class="empty-icon">',
        '<svg width="150" height="150" viewBox="-1406 184 10118 10118" xmlns="http://www.w3.org/2000/svg">',
          '<g transform="translate(0,11380) scale(1,-1)" fill="currentColor" stroke="none" opacity="0.55">',
            '<path d="M3486 10082 c-4 -8 -66 -162 -141 -357 -50 -129 -95 -309 -109 -440 -5 -47 12 -185 47 -370 49 -263 51 -500 6 -705 -6 -25 -17 -83 -25 -130 -8 -47 -28 -139 -44 -205 -61 -253 -80 -331 -85 -370 -4 -22 -12 -65 -20 -95 -61 -243 -89 -608 -64 -850 7 -69 13 -156 14 -195 3 -75 27 -280 50 -410 7 -44 19 -123 25 -175 6 -52 16 -117 21 -145 5 -27 11 -125 14 -216 2 -91 12 -213 21 -270 18 -117 30 -226 43 -409 5 -69 15 -199 21 -290 14 -184 8 -663 -10 -795 -13 -98 -27 -151 -78 -280 -88 -227 -195 -391 -330 -510 -163 -144 -397 -253 -666 -311 -82 -17 -346 -33 -471 -28 -124 5 -323 40 -425 76 -167 59 -190 61 -190 14 0 -30 42 -65 164 -134 84 -48 310 -148 386 -171 230 -68 380 -85 593 -65 274 25 341 34 457 59 139 30 251 53 474 95 156 30 188 33 380 34 272 1 329 -6 541 -69 166 -49 331 -92 390 -100 28 -4 77 -13 110 -21 33 -7 86 -15 118 -18 31 -3 61 -7 66 -10 5 -3 60 -10 123 -16 258 -22 575 42 848 171 322 153 503 270 487 312 -10 27 -47 20 -148 -29 -166 -81 -337 -142 -501 -180 -92 -21 -132 -24 -290 -24 -217 0 -319 14 -508 71 -173 52 -223 76 -390 194 -108 75 -179 149 -270 280 -41 59 -145 261 -170 330 -79 218 -126 378 -149 510 -25 142 -37 577 -22 756 36 412 60 599 131 1044 11 72 22 153 25 180 3 28 9 64 14 80 15 48 33 318 47 675 7 191 -10 544 -32 669 -23 133 -84 397 -115 499 -11 35 -24 95 -30 135 -17 119 -26 168 -42 247 -82 399 -86 444 -58 630 27 177 33 247 33 390 1 176 -14 284 -68 481 -34 127 -128 418 -146 452 -9 18 -43 23 -52 9z"/>',
            '<path d="M4486 9589 c-93 -62 -318 -335 -409 -498 -74 -132 -135 -295 -163 -438 -22 -110 -25 -145 -20 -248 8 -148 25 -265 69 -465 38 -171 76 -311 112 -410 63 -172 86 -384 86 -795 1 -446 -30 -766 -105 -1102 -14 -62 -30 -152 -36 -200 -7 -48 -18 -113 -25 -143 -13 -54 -44 -251 -44 -280 1 -8 -2 -49 -5 -90 -7 -89 -7 -496 -1 -700 15 -485 85 -734 312 -1115 66 -109 128 -177 236 -256 96 -70 327 -174 442 -199 22 -4 78 -16 125 -26 136 -29 473 -18 649 22 110 25 369 121 447 165 102 59 108 63 249 182 254 213 351 435 300 687 -23 113 -92 290 -125 320 -3 3 -12 18 -20 34 -24 46 -243 269 -307 312 -32 21 -63 44 -70 50 -27 25 -182 93 -232 102 -103 18 -181 -34 -167 -112 7 -34 59 -109 135 -192 130 -144 221 -379 205 -534 -8 -83 -21 -113 -80 -189 -77 -99 -214 -181 -362 -217 -147 -35 -431 5 -583 81 -60 31 -187 125 -237 176 -60 61 -124 160 -138 212 -25 96 -55 348 -51 432 10 212 61 331 214 498 60 66 416 336 546 415 34 21 88 58 119 82 31 25 78 58 105 75 54 33 188 147 218 185 11 14 45 53 75 86 107 119 147 190 195 340 17 54 22 158 10 209 -11 43 -82 177 -118 221 -156 189 -474 325 -757 324 -156 -1 -251 -40 -249 -103 1 -66 51 -122 169 -191 32 -19 92 -62 133 -96 85 -70 118 -125 142 -242 38 -178 -4 -300 -140 -411 -88 -71 -157 -103 -250 -115 -99 -13 -177 -2 -249 33 -140 68 -190 157 -220 391 -20 149 -20 313 0 479 32 278 43 438 43 630 -1 286 -8 325 -125 645 -37 102 -82 226 -99 275 -93 258 -136 479 -135 709 0 268 42 413 224 776 84 166 93 193 72 225 -22 33 -53 32 -110 -6z"/>',
            '<path d="M2356 9578 c-18 -25 -18 -25 66 -107 74 -72 97 -105 159 -226 79 -155 120 -281 144 -438 17 -113 20 -376 6 -457 -49 -272 -64 -335 -124 -500 -35 -98 -95 -225 -128 -272 -11 -14 -33 -59 -50 -100 -16 -40 -34 -82 -39 -93 -5 -11 -21 -63 -36 -115 -32 -112 -42 -235 -32 -382 9 -120 84 -512 122 -633 61 -193 72 -414 26 -509 -29 -61 -118 -142 -198 -179 -63 -30 -74 -32 -182 -32 -106 0 -120 2 -178 29 -76 35 -120 82 -171 183 -63 127 -85 212 -84 326 2 86 5 106 28 150 36 69 117 152 185 188 55 30 103 61 151 98 33 26 55 104 40 143 -15 40 -97 93 -173 112 -163 40 -392 -2 -538 -98 -101 -67 -221 -188 -257 -261 -81 -160 -96 -339 -42 -498 46 -138 80 -189 213 -321 132 -129 246 -223 472 -385 200 -144 281 -210 394 -323 174 -174 290 -351 324 -498 23 -98 31 -261 17 -365 -13 -89 -55 -250 -72 -271 -5 -6 -15 -29 -23 -50 -35 -101 -160 -257 -261 -328 -68 -47 -115 -71 -235 -118 -154 -60 -324 -48 -533 38 -138 56 -178 89 -222 179 -61 124 -61 250 0 489 18 71 95 231 128 266 40 43 133 173 156 217 27 54 28 122 1 150 -48 53 -174 56 -258 7 -84 -49 -257 -209 -312 -290 -8 -12 -45 -64 -82 -116 -66 -93 -154 -251 -177 -318 -20 -60 -31 -218 -20 -300 27 -197 59 -274 169 -412 107 -132 241 -229 441 -318 220 -98 386 -125 714 -117 191 5 234 9 325 32 220 54 461 208 580 370 129 176 184 279 241 455 80 245 99 479 74 910 -9 146 -20 353 -25 460 -6 107 -14 249 -20 315 -22 265 -30 350 -35 365 -2 8 -9 64 -15 124 -5 60 -14 134 -20 165 -39 220 -64 358 -80 436 -57 274 -71 395 -64 549 8 165 15 198 101 456 87 261 105 327 127 470 54 352 71 688 41 843 -21 113 -97 325 -160 452 -119 238 -283 403 -453 455 -85 27 -127 26 -146 -2z"/>',
          '</g>',
        '</svg>',
      '</div>',
      '<div class="empty-title">КТ-сегментация</div>',

      // ── Режим A: загрузка КТ (по умолчанию) ──
      '<div id="segLoadMode">',
        '<div class="empty-sub">',
          'Модель выделит <span class="accent">полость носа</span> на КТ. ',
        '</div>',
        '<div class="empty-formats"><span class="fm">DICOM</span></div>',
        '<button type="button" class="btn-open-big" data-act="seg-open-dicom" style="margin-top:17px">',
          '<svg width="14" height="14" viewBox="0 0 18 18" fill="none">',
            '<path d="M2 5V14a1.5 1.5 0 001.5 1.5h11A1.5 1.5 0 0016 14V7.5A1.5 1.5 0 0014.5 6H9L7.5 4H3.5A1.5 1.5 0 002 5z" stroke="currentColor" stroke-width="1.3"/>',
            '<path d="M7 10.5l2-2 2 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
            '<line x1="9" y1="8.5" x2="9" y2="13" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
          'Загрузить КТ (папку DICOM)',
        '</button>',
        '<div class="empty-hint">или перетащите папку DICOM сюда</div>',
      '</div>',

      // ── Режим B: КТ загружен — запуск ──
      '<div id="segRunMode" style="display:none">',
        '<div class="empty-sub" id="segEmptySub">',
          'КТ загружен. Нажмите кнопку, чтобы запустить модель.',
        '</div>',
        '<button type="button" class="btn-open-big btn-run-seg" id="segRunBtn" style="margin-top:20px">',
          '<svg width="14" height="14" viewBox="0 0 18 18" fill="none">',
            '<path d="M5 4l9 5-9 5V4z" fill="currentColor"/></svg>',
          'Запустить сегментацию',
        '</button>',
      '</div>',
    ].join('');
    refreshRunAvailability();
  }

  function buildRightPanel(stage) {
    const right = stage.querySelector('.panel.right');
    if (!right) return;
    right.innerHTML = [
      '<div class="card" id="segHowCard">',
        '<div class="card-title">Как это работает</div>',
        '<ol class="ep-steps-pre seg-steps">',
          '<li>Загрузите <b>папку DICOM</b> и выберите <b>том</b>.</li>',
          '<li>Модель сама выделит область — проверьте маску на срезах: <b>Кисть</b> добавляет, <b>Ластик</b> стирает.</li>',
          '<li><b>«Далее»</b> сгладит поверхность и откроет следующий шаг.</li>',
          '<li>Поправленная маска сохраняется в архив сессии — кнопкой в шапке. ',
             'Оттуда же берётся обучающая пара для дообучения модели.</li>',
        '</ol>',
      '</div>',
      '<details class="card" id="segGuideCard" style="display:none">',
        '<summary class="card-title">Как проверить и поправить</summary>',
        '<ol class="seg-steps">',
          '<li>Листайте срезы <b>колесом</b> в трёх окнах — проверьте границу маски. Ползунок внизу листает то окно, чей счётчик подсвечен; кликните по счётчику <b>АКС</b>, <b>КОР</b> или <b>САГ</b>, чтобы переключить.</li>',
          '<li><b>Двойной щелчок</b> по окну разворачивает его на всю область — удобно для точной правки.</li>',
          '<li><b>Кисть</b> добавляет, <b>Ластик</b> стирает. Инструменты и автоправки — в панели ниже, у каждой кнопки подсказка при наведении.</li>',
          '<li>Пропуск на нескольких срезах? Закрасьте на 2–3 и нажмите <b>«Протянуть между срезами»</b>.</li>',
        '</ol>',
      '</details>',
      '<div class="card" id="segToolsCard" style="display:none">',
        '<div class="card-title">Правка области</div>',

        '<div class="seg-tgroup-lbl">Инструменты</div>',
        '<div class="seg-tools seg-tools-2">',
          toolBtn('mucosa', 'Кисть',  'brush'),
          toolBtn('eraser', 'Ластик', 'eraser'),
        '</div>',
        '<div class="hint-text dim" id="segToolHint" style="font-size:12px;margin-top:12px;line-height:1.55;opacity:.9;min-height:34px"></div>',

        // настройки кисти/ластика — активны только для них
        '<div class="seg-adv-block" id="segBrushBlock">',
          '<div class="seg-field" id="segRadiusField" style="margin-top:8px">',
            '<label>Размер кисти: <span id="segRadiusVal">2</span></label>',
            '<input type="range" id="segRadius" class="seg-range" min="1" max="7" value="2" style="--p:16.7%">',
          '</div>',
          '<div class="seg-tools seg-tools-2" style="margin-top:10px">',
            '<button type="button" class="seg-mini active" data-segshape="ball" title="Кисть-шар: захватывает соседние срезы">\u25CF Шар</button>',
            '<button type="button" class="seg-mini" data-segshape="flat" title="Плоская кисть: только видимый срез">\u25CB Плоско</button>',
          '</div>',
          '<label class="seg-check" style="margin-top:14px">',
            '<input type="checkbox" id="segAir" checked> не красить воздух (порог из КТ)',
          '</label>',
        '</div>',

        '<div class="seg-tgroup-lbl">Обработка маски</div>',
        '<div class="seg-actions">',
          '<button type="button" class="seg-mini" data-act="seg-clean" title="Оставить один кусок + закрыть дырки (и убрать воздух, если включено)">' + _miniIco('clean') + 'Убрать</button>',
          '<button type="button" class="seg-mini" data-act="seg-patch" title="Закрыть замкнутые дырки: 3D-полости и мелкие проколы. Сквозное окно в плёнке — кнопкой «Затянуть окна».">' + _miniIco('fill') + 'Заполнить</button>',
        '</div>',
        '<div class="seg-actions" style="margin-top:10px">',
          '<button type="button" class="seg-mini" data-act="seg-close" title="Закрыть сквозные ОКНА и вмятины в плёнке (морфозамыкание). Радиус = размер кисти — для крупного окна увеличьте его. Отменяемо.">' + _miniIco('close') + 'Затянуть</button>',
          '<button type="button" class="seg-mini" data-act="seg-smooth" title="Сгладить «лесенку» на границе (3D-голосование 3×3×3)">' + _miniIco('smooth') + 'Сгладить</button>',
        '</div>',
        '<button type="button" class="seg-mini" data-act="seg-interp" title="Протяжка: закрасьте область кистью на 2–3 срезах в любом окне (аксиальном/корональном/сагиттальном), листая колесом, затем нажмите — промежуточные срезы заполнятся плавным переходом формы." style="width:100%;margin-top:10px">' + _miniIco('interp') + 'Протянуть между срезами</button>',

        '<div class="seg-tgroup-lbl">История</div>',
        '<div class="seg-actions">',
          '<button type="button" class="seg-mini" data-act="seg-undo" title="Отменить (Ctrl+Z)">' + _miniIco('undo') + 'Отменить</button>',
          '<button type="button" class="seg-mini" data-act="seg-redo" title="Повторить (Ctrl+Y)">' + _miniIco('redo') + 'Повторить</button>',
        '</div>',
        '<button type="button" class="seg-mini seg-danger" data-act="seg-reset" title="Вернуть маску модели как была" style="width:100%;margin-top:10px">' + _miniIco('reset') + 'Вернуть как было</button>',

        '<div class="seg-tgroup-lbl">Отображение</div>',
        '<div class="seg-field"><label>Прозрачность маски: <span id="segAlphaVal">55</span>%</label>',
          '<input type="range" id="segAlpha" class="seg-range" min="0" max="100" value="55" style="--p:55%"></div>',
      '</div>',

      '<div id="segNextCard" style="display:none;margin-top:10px">',
        '<button type="button" class="btn-open-big seg-next-btn" data-act="seg-next">',
          '<span>Продолжить</span>',
          '<svg width="15" height="15" viewBox="0 0 18 18" fill="none">',
            '<path d="M5 3l7 6-7 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        '</button>',
        '<div class="hint-text dim" style="font-size:11px;margin-top:8px;line-height:1.45;opacity:.6;text-align:center">',
          'Сгладит меш и откроет вкладку «Модель»',
        '</div>',
      '</div>',
    ].join('');

    // wheel/level/alpha/radius wiring (элементы появятся; слушаем через делегирование)
    right.addEventListener('input', (e) => {
      if (e.target.classList && e.target.classList.contains('seg-range')) {
        const t = e.target, span = (+t.max - +t.min) || 1;
        t.style.setProperty('--p', ((+t.value - +t.min) / span * 100) + '%');
      }
      if (!editor) return;
      if (e.target.id === 'segRadius') {
        editor.setRadius(+e.target.value);
        const v = document.getElementById('segRadiusVal'); if (v) v.textContent = e.target.value;
      }
      if (e.target.id === 'segAir' && editor) editor.setUseAir(e.target.checked);
      if (e.target.id === 'segAlpha') {
        editor.setAlpha(+e.target.value / 100);
        const v = document.getElementById('segAlphaVal'); if (v) v.textContent = e.target.value;
      }
    });
    right.addEventListener('click', (e) => {
      const wl = e.target.closest('[data-wl]');
      if (wl && editor) {
        editor.setWindowPreset(wl.dataset.wl);
        document.querySelectorAll('[data-wl]').forEach((b) => b.classList.toggle('active', b === wl));
      }
    });
    right.addEventListener('change', (e) => {
      if (!editor) return;
      if (e.target.id === 'segContour') editor.setContour(e.target.checked);
    });
  }

  // ─── Переключение режимов центра: загрузка ↔ запуск ──────────────────
  function refreshRunAvailability() {
    const loadMode = document.getElementById('segLoadMode');
    const runMode = document.getElementById('segRunMode');
    if (loadMode) loadMode.style.display = ctReady ? 'none' : '';
    if (runMode) runMode.style.display = ctReady ? '' : 'none';
  }

  // КТ загружен (ct-loader.js или DICOM-конвертация диспатчат 'ct:change')
  window.addEventListener('ct:change', () => { ctReady = true; refreshRunAvailability(); });
  // На старте проверим session — вдруг КТ уже лежит (bootstrap-from-session)
  document.addEventListener('DOMContentLoaded', () => {
    fetch('/api/session').then((r) => r.json()).then((m) => {
      if (m && m.ct_raw) { ctReady = true; refreshRunAvailability(); }
    }).catch(() => {});
  });

  // ─── Авто-поиск путей модели (кандидаты + подсветка) ────────────────
  async function loadDefaults(deep) {
    const badge = document.getElementById('segCfgBadge');
    if (badge) {
      badge.textContent = 'поиск…';
      badge.classList.remove('seg-cfg-ok', 'seg-cfg-warn');
    }
    /* Сохранённое подставляет сам сервер (infer_config._prefer),
       локального хранилища больше нет. */
    try {
      const resp = await fetch('/api/infer_config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deep: !!deep }),
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const d = await fetch('/api/session/infer_config_json').then((r) => r.json());
      const cnd = d.candidates || {};
      fillCandidates('segPyPath', cnd.python, d.python);
      fillCandidates('segScriptPath', cnd.script, d.script);
      fillCandidates('segCkptPath', cnd.ckpt, d.ckpt);
      updateCfgBadge();
      /* Результат автопоиска НЕ сохраняем. Сервер уже вернул сохранённое,
         если оно было; перезапись затирала бы ручной ввод врача.
         Пишем только по явному действию — выбор в диалоге или ввод. */
    } catch (err) {
      // API недоступен (открыто не через Flask / server.py не обновлён).
      // Брать пути неоткуда — конфиг живёт на сервере.
      fillCandidates('segPyPath', [], '');
      fillCandidates('segScriptPath', [], '');
      fillCandidates('segCkptPath', [], '');
      updateCfgBadge();
      if (badge) {
        badge.textContent = 'API?';
        badge.classList.add('seg-cfg-warn');
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Источник КТ: только папка DICOM, выбор тома как в Slicer
  // ═══════════════════════════════════════════════════════════

  // Кнопка «Загрузить КТ» открывает ТОТ ЖЕ встроенный проводник, что и
  // синяя кнопка-папка в настройках — единый вид для врача.
  function openDicom() {
    openFsPicker({
      title: 'Выберите папку DICOM',
      kind: 'dir',                 // показываем только папки
      start: '',
      allowDir: true,
      dirHint: 'Зайдите в папку с DICOM-файлами пациента и нажмите «Выбрать эту папку».',
      onPick: function (p) { ingestDicomDir(p); },
    });
  }

  // папка выбрана во встроенном проводнике (серверный путь) — сервер сам
  // копирует её в сессию, без выгрузки тысяч файлов по HTTP
  async function ingestDicomDir(dir) {
    try {
      _spin('Чтение папки DICOM…');
      const r = await fetch('/api/dicom_pick_dir', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: dir }),
      });
      if (r.status === 404) {
        throw new Error('эндпоинт /api/dicom_pick_dir не найден (404). ' +
          'Обновите server.py и перезапустите приложение.');
      }
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
      if (!j.saved) { _spinHide(); _toast('В выбранной папке нет файлов', 'warn'); return; }
      await runSeriesFlow();
    } catch (err) {
      _spinHide();
      _toast('DICOM: ' + err.message, 'err', 6000);
    }
  }

  // drag&drop отдаёт File-объекты (без пути на диске) — их грузим батчами;
  // дальше тот же общий хвост, что и при выборе папки в проводнике
  async function onDicomPicked(files) {
    try {
      // батч-загрузка сырых файлов — без гигантского архива (обход HTTP 413)
      const BATCH = 40;
      const total = files.length;
      let sent = 0;
      for (let i = 0; i < total; i += BATCH) {
        const fd = new FormData();
        const slice = files.slice(i, i + BATCH);
        for (const f of slice) {
          const rel = (f.webkitRelativePath || f.name || 'dcm').replace(/\\/g, '/');
          fd.append('files', f, rel);
        }
        const url = '/api/dicom_upload' + (i === 0 ? '?reset=1' : '');
        const up = await fetch(url, { method: 'POST', body: fd });
        if (up.status === 404) {
          throw new Error('эндпоинт /api/dicom_upload не найден (404). ' +
            'Откройте приложение через Flask (entry.py), а не превью IDE, и обновите server.py.');
        }
        if (!up.ok) throw new Error('загрузка HTTP ' + up.status);
        sent += slice.length;
        _spin('Загрузка DICOM… ' + sent + ' / ' + total);
      }
      await runSeriesFlow();
    } catch (err) {
      _spinHide();
      _toast('DICOM: ' + err.message, 'err', 6000);
    }
  }

  // общий хвост: прочитать серии → подготовить тома → открыть окно выбора
  async function runSeriesFlow() {
    _spinText('Чтение серий…');
    await sse('/api/dicom_series/stream', { python: val('segPyPath') }, _spinText);

    const data = await fetch('/api/session/dicom_series_json').then((r) => r.json());
    const list = (data && data.series) || [];
    if (!list.length) { _spinHide(); _toast('DICOM-серии не найдены', 'warn'); return; }

    // Готовим объёмы ВСЕХ подходящих серий сразу — врач ждёт один раз,
    // дальше переключение в окне выбора мгновенное.
    const volSeries = list.filter((s) => s.volumetric !== false && s.count >= 10);
    _spin('Подготовка томов… 0 / ' + volSeries.length);
    await new Promise((resolve) => {
      preloadSeries(volSeries.map((s) => s.uid), (done, tot) => {
        _spinText('Подготовка томов… ' + done + ' / ' + tot);
        if (done >= tot) resolve();
      });
      if (!volSeries.length) resolve();
    });

    _spinHide();
    showSeriesPicker(list);
  }

  // ─── Окно выбора тома (как диалог серий в 3D Slicer) ─────────────────
  let _previewSeq = 0;

  function _fmtMM(v) {
    const n = parseFloat(String(v == null ? '' : v).replace(',', '.'));
    if (!isFinite(n) || n <= 0) return '';
    return (Math.round(n * 100) / 100).toString().replace('.', ',');
  }

  // различающие параметры серии: толщина среза · ядро · размер пикселя.
  function _seriesParams(s) {
    const parts = [];
    const th = _fmtMM(s.thickness);
    if (th) parts.push('<b>' + th + '\u00A0мм</b>');
    const k = String(s.kernel || '').replace(/[\\^]/g, ' ').trim().split(/\s+/)[0];
    if (k) parts.push('ядро\u00A0<b>' + esc(k) + '</b>');
    const pv = String(s.pixel || '').replace(/[\\^]/g, ' ').trim().split(/\s+/).map(_fmtMM).filter(Boolean);
    if (pv.length) {
      const px = (pv.length >= 2 && pv[0] !== pv[1]) ? (pv[0] + '×' + pv[1]) : pv[0];
      parts.push(px + '\u00A0мм/пиксель');
    }
    return parts.join('  ·  ');
  }

  // лучшая серия для входа в модель: тонкие срезы → покрытие → осевая → размер пикселя.
  // Сеть ресемплит к 0.5×0.5×1.0 мм, поэтому грубые по Z серии (2–3 мм) проигрывают.
  function _recommendUid(list) {
    const cand = list.filter((s) => !_isPreviewErr(_previewCache[s.uid]));
    if (!cand.length) return null;
    const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(',', '.')); return (isFinite(n) && n > 0) ? n : null; };
    const orient = (s) => {
      const d = String(s.description || '').toLowerCase();
      if (/\bcor\b|коронал/.test(d)) return 'cor';
      if (/\bsag\b|сагит/.test(d)) return 'sag';
      return 'ax';   // явный ax или без суффикса считаем осевой (родная реконструкция)
    };
    const score = (s) => {
      const th = num(s.thickness), px = num(s.pixel), cnt = s.count || 0;
      let v = 0;
      v += (th != null) ? -th * 100 : -120;        // тонкие срезы — главный вес
      v += Math.min(cnt, 400) * 0.5;               // больше срезов = полнее покрытие
      if (px != null) v -= Math.max(0, px - 0.5) * 40;  // грубее 0.5 мм/пикс — штраф
      v += (orient(s) === 'ax') ? 30 : -10;        // осевая предпочтительнее переформатов
      return v;
    };
    let best = cand[0], bs = score(cand[0]);
    for (let i = 1; i < cand.length; i++) { const v = score(cand[i]); if (v > bs) { bs = v; best = cand[i]; } }
    return best.uid;
  }

  function showSeriesPicker(allList) {
    const stage = document.querySelector('.stage[data-stage="segment"]');
    const vp = stage && stage.querySelector('.viewport');
    if (!vp) return;
    closeSeriesPicker();
    // только объёмные серии (одиночные topogram/protocol и т.п. не показываем)
    const list = allList.filter((s) => s.volumetric !== false && s.count >= 10);
    const hidden = allList.length - list.length;
    if (!list.length) { _toast('Объёмных серий не найдено', 'warn', 5000); return; }
    const _byUid = {};
    list.forEach((s) => { _byUid[s.uid] = s; });
    const _bad = (uid) => _isPreviewErr(_previewCache[uid]);   // не собралась в объём
    const recUid = _recommendUid(list);                        // лучшая для модели
    // по умолчанию выбираем рекомендуемую (или первую пригодную)
    const firstGood = list.find((s) => !_bad(s.uid));
    let selUid = recUid || (firstGood || list[0]).uid;

    const rows = list.map((s) => {
      const dims = (s.rows && s.cols) ? (s.rows + '×' + s.cols) : '—';
      const mod = s.modality || 'IMG';
      const desc = s.description || '(без описания)';
      const bad = _bad(s.uid);
      const rec = (s.uid === recUid) && !bad;
      const meta = bad
        ? '<span class="seg-series-meta seg-series-bad-t">не собирается в объём</span>'
        : ('<span class="seg-series-meta">' + esc(mod) + ' · <b>' + s.count + '</b> срезов · ' + dims + '</span>');
      const recTag = rec
        ? '<span class="seg-rec-tag" title="Тонкие срезы, полное покрытие, осевая реконструкция — лучше всего подходит для модели">★</span>'
        : '';
      return [
        '<button type="button" class="seg-series-row' +
          (s.uid === selUid ? ' active' : '') + (bad ? ' seg-series-bad' : '') + (rec ? ' seg-series-rec' : '') +
          '" data-uid="', esc(s.uid), '" data-bad="', (bad ? '1' : '0'), '">',
          '<span class="seg-series-main">',
            '<span class="seg-series-desc">', esc(desc), '</span>',
            meta,
          '</span>',
          '<span class="seg-series-right">', recTag, '</span>',
        '</button>',
      ].join('');
    }).join('');

    // пациент/исследование одинаковы для всех серий папки — показываем один раз в шапке
    const pinfo = list.find((s) => s.patient || s.study) || {};
    const patientLine = (pinfo.patient || pinfo.study)
      ? ('Пациент: ' + esc(pinfo.patient || '—') +
         (pinfo.study ? '<br>Исследование: ' + esc(pinfo.study) : ''))
      : '';
    segPatient = String(pinfo.patient || '');   // запоминаем ФИО для имени обучающей пары

    const ov = document.createElement('div');
    ov.className = 'seg-picker';
    ov.id = 'segSeriesPicker';
    ov.innerHTML = [
      '<div class="seg-picker-box seg-picker-wide">',
        '<button type="button" class="seg-picker-close" data-pick="cancel" title="Закрыть" aria-label="Закрыть">&times;</button>',
        '<div class="seg-picker-title">Выбор тома</div>',
        (patientLine ? '<div class="seg-picker-sub">' + patientLine + '</div>' : ''),
        '<div class="seg-picker-hint">' +
          '<b style="color:inherit">Найдено объёмных серий:</b> <b>' + list.length + '</b>' +
          (hidden > 0 ? ' · скрыто необъёмных: ' + hidden : '') + '.' +
          '<br>' +
          'Выберите серию в списке слева — справа покажутся её срезы.' +
          (recUid ? '  <span class="seg-hint-star">★</span>&nbsp;— рекомендуемая для модели (тонкие срезы, полное покрытие).' : '') +
        '</div>',
        '<div class="seg-picker-cols">',
          '<div class="seg-picker-list">', rows, '</div>',
          '<div class="seg-preview" id="segPreview">',
            '<div class="seg-preview-hint">Загрузка объёма…</div>',
          '</div>',
        '</div>',
        '<div class="seg-picker-actions">',
          '<button type="button" class="btn-open-big" data-pick="use" id="segUseBtn" style="min-width:240px;justify-content:center">Загрузить том</button>',
        '</div>',
      '</div>',
    ].join('');
    vp.appendChild(ov);
    stage.classList.add('seg-picking');   // прячем боковые панели — окно на всю ширину
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));

    // кнопку «Загрузить том» гасим, если выбрана несобираемая серия
    const useBtn = ov.querySelector('#segUseBtn');
    const syncUseBtn = () => { if (useBtn) useBtn.classList.toggle('is-disabled', _bad(selUid)); };
    syncUseBtn();

    ov.addEventListener('click', (e) => {
      if (e.target === ov) { closeSeriesPicker(); return; }   // клик по фону — закрыть
      const row = e.target.closest('.seg-series-row');
      if (row) {
        selUid = row.dataset.uid;
        ov.querySelectorAll('.seg-series-row').forEach((r) => r.classList.toggle('active', r === row));
        syncUseBtn();
        loadSeriesPreview(selUid, _byUid[selUid]);
        return;
      }
      const pick = e.target.closest('[data-pick]');
      if (!pick) return;
      if (pick.dataset.pick === 'cancel') { closeSeriesPicker(); return; }
      if (pick.dataset.pick === 'use') {
        if (_bad(selUid)) { _toast('Эта серия не собирается в объём — выберите другую', 'warn', 4000); return; }
        closeSeriesPicker(); useSeries(selUid);
      }
    });

    // тома уже подготовлены при загрузке папки — превью открывается мгновенно
    if (selUid) loadSeriesPreview(selUid, _byUid[selUid]);
  }

  const _previewCache = {};   // uid -> {vol,dims,spacing} | {__err:'сообщение'}
  let _preloadQueue = [];
  let _previewChain = Promise.resolve();   // сериализация запросов превью

  function _isPreviewErr(v) { return !!(v && v.__err); }

  // короткая, понятная врачу формулировка причины
  function _previewErrMsg(err) {
    let why = String((err && err.message) || err || '');
    if (/собирается в об|не объ|неподдерж|geometry|No Series|GDCM|radial/i.test(why)) {
      return 'Эта серия не собирается в объём (нестандартная геометрия — ' +
             'например radial или одиночный topogram). Выберите осевую (ax) ' +
             'реконструкцию с наибольшим числом срезов.';
    }
    return why.slice(0, 200) || 'Серия не отображается.';
  }

  // запрос превью одной серии — строго по очереди (общий ключ json не перетирается)
  function fetchPreviewVolume(uid) {
    const c = _previewCache[uid];
    if (c) return _isPreviewErr(c) ? Promise.reject(new Error(c.__err)) : Promise.resolve(c);
    // ставим в очередь: следующий стартует только после предыдущего
    _previewChain = _previewChain.then(() => _doFetchPreview(uid), () => _doFetchPreview(uid));
    return _previewChain;
  }

  async function _doFetchPreview(uid) {
    const c = _previewCache[uid];
    if (c) { if (_isPreviewErr(c)) throw new Error(c.__err); return c; }
    try {
      await sse('/api/dicom_preview/stream', { python: val('segPyPath'), series_uid: uid }, () => {});
      const d = await fetch('/api/session/dicom_preview_json').then((r) => r.json());
      if (!d || !d.volume) throw new Error('том превью недоступен');
      const buf = await fetch('/api/session/' + encodeURIComponent(d.volume)).then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer();
      });
      const rec = { vol: new Uint8Array(buf), dims: d.dims, spacing: d.spacing };
      _previewCache[uid] = rec;
      return rec;
    } catch (err) {
      // КЕШИРУЕМ ошибку — несобираемую серию больше не пересчитываем
      const msg = _previewErrMsg(err);
      _previewCache[uid] = { __err: msg };
      throw new Error(msg);
    }
  }

  // фоновая предзагрузка ВСЕХ серий по очереди — врач ждёт один раз.
  // onProgress(done, total); onResult(uid, ok) — отметить статус серии в списке.
  function preloadSeries(uids, onProgress, onResult) {
    _preloadQueue = uids.filter((u) => !_previewCache[u]);
    let done = 0; const total = _preloadQueue.length;
    const step = () => {
      if (!_preloadQueue.length) { if (onProgress) onProgress(total, total); return; }
      const u = _preloadQueue.shift();
      fetchPreviewVolume(u).then(
        () => { if (onResult) onResult(u, true); },
        () => { if (onResult) onResult(u, false); }
      ).then(() => {
        done++; if (onProgress) onProgress(done, total);
        step();
      });
    };
    step();
  }

  async function loadSeriesPreview(uid, meta) {
    const pane = document.getElementById('segPreview');
    if (!pane) return;
    const seq = ++_previewSeq;
    // ошибочную серию показываем мгновенно из кеша, без «Загрузка…»
    const cached = _previewCache[uid];
    if (_isPreviewErr(cached)) { _showPreviewError(pane, cached.__err); return; }
    pane.innerHTML = '<div class="seg-preview-hint">Загрузка объёма…</div>';
    try {
      const rec = await fetchPreviewVolume(uid);
      if (seq !== _previewSeq) return;
      mountVolumeViewer(pane, rec, meta);
    } catch (err) {
      if (seq !== _previewSeq) return;
      _showPreviewError(pane, _previewErrMsg(err));
    }
  }

  function _showPreviewError(pane, why) {
    pane.innerHTML =
      '<div class="seg-preview-hint seg-preview-err">' +
        '<div class="seg-preview-err-t">Эта серия не собирается в объём</div>' +
        '<div>' + esc(why) + '</div>' +
      '</div>';
  }

  // три ортогональных среза из объёма, листание мышью/колесом (как в Slicer)
  function mountVolumeViewer(pane, rec, meta) {
    const [X, Y, Z] = rec.dims, sp = rec.spacing || [1, 1, 1], vol = rec.vol, XY = X * Y;
    const st = { z: Z >> 1, cy: Y >> 1, cx: X >> 1 };
    pane.innerHTML = [
      '<div class="seg-vv-wrap">',
        '<div class="seg-vv seg-vv-c">',
          '<div class="seg-vv-cell c-ax"><span class="seg-vv-lbl">Аксиальный</span><canvas data-pl="ax"></canvas></div>',
          '<div class="seg-vv-cell c-sag"><span class="seg-vv-lbl">Сагиттальный</span><canvas data-pl="sag"></canvas></div>',
          '<div class="seg-vv-cell c-cor"><span class="seg-vv-lbl">Корональный</span><canvas data-pl="cor"></canvas></div>',
        '</div>',
        '<div class="seg-cap">',
          '<span class="seg-cap-t">', esc((meta && meta.description) || ''), '</span>',
          '<span class="seg-cap-m">', esc((meta && meta.modality) || 'CT'), ' · ', ((meta && meta.count) || Z), ' срезов',
            (meta && meta.rows && meta.cols ? ' · ' + meta.rows + '×' + meta.cols : ''), '</span>',
          '<span class="seg-cap-h">↕\u00A0Колесо или перетаскивание — листать</span>',
        '</div>',
      '</div>',
    ].join('');

    const planes = {
      ax:  { w: X, h: Y, sp: [sp[0], sp[1]] },   // (x,y)
      cor: { w: X, h: Z, sp: [sp[0], sp[2]] },   // (x,z) голову вверх
      sag: { w: Y, h: Z, sp: [sp[1], sp[2]] },   // (y,z) голову вверх
    };

    function sample(pl, c, r) {
      if (pl === 'ax')  return vol[c + X * r + XY * st.z];
      if (pl === 'cor') return vol[c + X * st.cy + XY * (Z - 1 - r)];
      return vol[st.cx + X * c + XY * (Z - 1 - r)];   // sag
    }

    // границы «не воздуха» для плоскости — считаем по СРЕДНЕМУ срезу один раз
    // и кешируем, чтобы кадр не «дышал» при листании. Берём щедрые границы.
    const _bounds = {};
    function planeBounds(pl) {
      if (_bounds[pl]) return _bounds[pl];
      const P = planes[pl], thr = 28;
      const step = Math.max(1, Math.floor(Math.min(P.w, P.h) / 120));
      // сохраняем текущий срез, временно сканируем несколько срезов по глубине
      const save = { z: st.z, cy: st.cy, cx: st.cx };
      const depth = (pl === 'ax') ? Z : (pl === 'cor') ? Y : X;
      const setDepth = (d) => { if (pl === 'ax') st.z = d; else if (pl === 'cor') st.cy = d; else st.cx = d; };
      let x0 = P.w, y0 = P.h, x1 = -1, y1 = -1;
      for (let k = 1; k <= 5; k++) {                 // 5 срезов по глубине → объединяем
        setDepth(Math.floor(depth * k / 6));
        for (let r = 0; r < P.h; r += step) {
          for (let c = 0; c < P.w; c += step) {
            if (sample(pl, c, r) > thr) {
              if (c < x0) x0 = c; if (c > x1) x1 = c;
              if (r < y0) y0 = r; if (r > y1) y1 = r;
            }
          }
        }
      }
      st.z = save.z; st.cy = save.cy; st.cx = save.cx;
      if (x1 < 0) { _bounds[pl] = { x0: 0, y0: 0, x1: P.w - 1, y1: P.h - 1 }; return _bounds[pl]; }
      const mx = Math.max(2, Math.round((x1 - x0) * 0.04));
      const my = Math.max(2, Math.round((y1 - y0) * 0.04));
      _bounds[pl] = {
        x0: Math.max(0, x0 - mx), y0: Math.max(0, y0 - my),
        x1: Math.min(P.w - 1, x1 + mx), y1: Math.min(P.h - 1, y1 + my),
      };
      return _bounds[pl];
    }

    function drawPlane(cv, pl) {
      const P = planes[pl];
      const buf = new ImageData(P.w, P.h), px = buf.data;
      for (let r = 0; r < P.h; r++) {
        for (let c = 0; c < P.w; c++) {
          const g = sample(pl, c, r), o = (r * P.w + c) * 4;
          px[o] = px[o + 1] = px[o + 2] = g; px[o + 3] = 255;
        }
      }
      const tmp = document.createElement('canvas'); tmp.width = P.w; tmp.height = P.h;
      tmp.getContext('2d').putImageData(buf, 0, 0);
      const dpr = window.devicePixelRatio || 1;
      const rc = cv.parentElement.getBoundingClientRect();
      const W = Math.max(2, Math.floor(rc.width * dpr)), H = Math.max(2, Math.floor(rc.height * dpr));
      if (cv.width !== W) cv.width = W; if (cv.height !== H) cv.height = H;
      cv.style.width = rc.width + 'px'; cv.style.height = rc.height + 'px';
      const cx = cv.getContext('2d'); cx.clearRect(0, 0, W, H);
      // обрезаем по содержимому → голова заполняет кадр (без больших чёрных полей)
      const b = planeBounds(pl);
      const cw = b.x1 - b.x0 + 1, ch = b.y1 - b.y0 + 1;
      // физические пропорции обрезанной области
      const phys_w = cw * P.sp[0], phys_h = ch * P.sp[1];
      const sc = Math.min(W / phys_w, H / phys_h);
      const dw = phys_w * sc, dh = phys_h * sc;
      cx.imageSmoothingEnabled = true;
      cx.imageSmoothingQuality = 'high';
      // источник = обрезанный прямоугольник tmp, назначение = по центру кадра
      cx.drawImage(tmp, b.x0, b.y0, cw, ch, (W - dw) / 2, (H - dh) / 2, dw, dh);
    }

    const cvs = {};
    pane.querySelectorAll('canvas[data-pl]').forEach((cv) => {
      const pl = cv.dataset.pl; cvs[pl] = cv;
      const redraw = () => drawPlane(cv, pl);
      const scrub = (dir) => {
        if (pl === 'ax')  st.z  = Math.max(0, Math.min(Z - 1, st.z + dir));
        else if (pl === 'cor') st.cy = Math.max(0, Math.min(Y - 1, st.cy + dir));
        else st.cx = Math.max(0, Math.min(X - 1, st.cx + dir));
        drawAll();
      };
      cv.addEventListener('wheel', (e) => { e.preventDefault(); scrub(e.deltaY > 0 ? 1 : -1); }, { passive: false });
      let dragY = null;
      cv.addEventListener('mousedown', (e) => { dragY = e.clientY; e.preventDefault(); });
      window.addEventListener('mousemove', (e) => {
        if (dragY === null) return;
        const dd = Math.round((e.clientY - dragY) / 4);
        if (dd !== 0) { scrub(dd > 0 ? 1 : -1); dragY = e.clientY; }
      });
      window.addEventListener('mouseup', () => { dragY = null; });
    });
    function drawAll() { Object.keys(cvs).forEach((pl) => drawPlane(cvs[pl], pl)); }
    _previewSeq;            // зафиксировать текущую серию
    requestAnimationFrame(drawAll);
    const ro = new ResizeObserver(() => drawAll()); ro.observe(pane);
  }

  function closeSeriesPicker() {
    _previewSeq++;
    const ov = document.getElementById('segSeriesPicker');
    if (ov) ov.remove();
    const stage = document.querySelector('.stage[data-stage="segment"]');
    if (stage) stage.classList.remove('seg-picking');
  }

  async function useSeries(uid) {
    if (!uid) { _toast('Сначала выберите серию', 'warn'); return; }
    try {
      _spin('Конвертация серии в том…');
      await sse('/api/dicom_convert/stream',
                { python: val('segPyPath'), series_uid: uid }, _spinText);
      // том готов — ведём себя так же, как ct-loader.js при загрузке .nrrd
      ctReady = true;
      window.dispatchEvent(new CustomEvent('ct:change', { detail: { name: 'DICOM серия', size: 0 } }));

      // ── Автозапуск сегментации сразу после загрузки тома ──
      // Спиннер уже показан — плавно перетекаем из «Конвертация…» в инференс,
      // без промежуточного экрана с кнопкой «Запустить».
      if (modelCfgReady()) {
        await runInfer();              // сам держит спиннер и ловит ошибки — без мигания экрана
      } else {
        // путей модели не хватает — не запускаем вслепую, а показываем
        // кнопку запуска и разворачиваем настройки, чтобы их дозаполнили
        _spinHide();
        refreshRunAvailability();
        const card = document.getElementById('segModelCard');
        if (card) card.open = true;    // развернуть «Настройки модели»
        _toast('КТ-том собран. Проверьте пути к модели и нажмите «Запустить сегментацию».', 'warn', 6000);
      }
    } catch (err) {
      _spinHide();
      _toast('Конвертация: ' + err.message, 'err', 6000);
    }
  }

  // ─── Drag&drop папки DICOM на окно вкладки ───────────────────────────
  // .nrrd-файлы обрабатывает глобальный file-loader.js; здесь перехватываем
  // только папки (entry.isDirectory) и не отдаём их в глобальный обработчик.
  function installDicomDrop(stage) {
    const vp = stage.querySelector('.viewport');
    if (!vp) return;
    vp.addEventListener('drop', async (e) => {
      const dt = e.dataTransfer;
      if (!dt || !dt.items) return;
      let hasDir = false;
      const entries = [];
      for (let i = 0; i < dt.items.length; i++) {
        const it = dt.items[i];
        const entry = it.webkitGetAsEntry && it.webkitGetAsEntry();
        if (entry) { entries.push(entry); if (entry.isDirectory) hasDir = true; }
      }
      if (!hasDir) return;             // не папка → пусть обрабатывает .nrrd-логика
      e.preventDefault();
      e.stopImmediatePropagation();    // не пускаем в глобальный file-loader
      document.body.classList.remove('drag-active');
      try {
        _spin('Чтение папки…');
        const files = [];
        for (const en of entries) await walkEntry(en, files);
        _spinHide();
        if (!files.length) { _toast('В папке нет файлов', 'warn'); return; }
        onDicomPicked(files);
      } catch (err) {
        _spinHide();
        _toast('Чтение папки: ' + err.message, 'err', 6000);
      }
    }, true); // capture — раньше глобального обработчика на window
  }

  function walkEntry(entry, out) {
    return new Promise((resolve) => {
      if (entry.isFile) {
        entry.file((f) => {
          try { Object.defineProperty(f, 'webkitRelativePath', { value: entry.fullPath.replace(/^\//, '') }); } catch (_) {}
          out.push(f); resolve();
        }, () => resolve());
      } else if (entry.isDirectory) {
        const rd = entry.createReader();
        const all = [];
        const readBatch = () => rd.readEntries(async (batch) => {
          if (!batch.length) {
            for (const en of all) await walkEntry(en, out);
            resolve();
          } else { all.push.apply(all, batch); readBatch(); }
        }, () => resolve());
        readBatch();
      } else resolve();
    });
  }

  // ═══════════════════════════════════════════════════════════
  // Запуск инференса + загрузка ROI + редактор
  // ═══════════════════════════════════════════════════════════
  async function runInfer() {
    if (!ctReady) { _toast('Сначала загрузите КТ (папку DICOM)', 'warn', 4000); return; }
    const cfg = readCfg();

    if (editor) { editor.dispose(); editor = null; }
    const runBtn = document.getElementById('segRunBtn');
    if (runBtn) runBtn.disabled = true;

    _spin('Старт инференса…');
    // «пульс»: тикающее время, чтобы было видно, что процесс идёт, даже до %
    let lastStage = 'Старт инференса…';
    const t0 = Date.now();
    const fmtElapsed = () => {
      const s = Math.floor((Date.now() - t0) / 1000);
      return (Math.floor(s / 60)) + ':' + String(s % 60).padStart(2, '0');
    };
    const heartbeat = setInterval(() => {
      // если в статусе уже есть %, не дописываем время (там свой счётчик)
      const base = lastStage || 'Выполняется…';
      _spinText(base.indexOf('%') >= 0 ? base : (base + '   ⏱ ' + fmtElapsed()));
    }, 1000);
    try {
      // 1) Инференс (SSE-прогресс: этапы + проценты с прогресс-баром)
      await sse('/api/infer/stream', cfg, (stage) => {
        lastStage = stage;
        _spinText(stage.indexOf('%') >= 0 ? stage : (stage + '   ⏱ ' + fmtElapsed()));
      });
      clearInterval(heartbeat);

      // 2) Кроп в выровненный ROI
      _spinText('Подготовка области интереса…');
      await postJSON('/api/roi_pair', {});

      // 3) Грузим ROI КТ + маску
      _spinText('Загрузка результата…');
      const [ctBuf, maskBuf] = await Promise.all([
        fetch('/api/session/roi_ct').then(okBuf('roi_ct')),
        fetch('/api/session/roi_mask').then(okBuf('roi_mask')),
      ]);

      _spinText('Чтение объёмов…');
      const ctVol = await window.NRRD.parse(ctBuf);
      const maskVol = await window.NRRD.parse(maskBuf);
      if (String(ctVol.sizes) !== String(maskVol.sizes)) {
        throw new Error('Размеры КТ и маски ROI не совпали');
      }

      _spinText('Инициализация редактора…');
      editor = SliceEditor.install(ctVol, maskVol);
      showEditorChrome(true);

      _spinHide();
      _toast('<strong>Готово.</strong> Программа выделила область красным. ' +
             'Пролистайте срезы колесом мыши и проверьте границы: кистью добавьте, ластиком уберите.', 'ok', 7000, { html: true });
    } catch (err) {
      clearInterval(heartbeat);
      _spinHide();
      console.error('[tab0-segment]', err);
      _toast('<strong>Ошибка сегментации:</strong> ' + err.message, 'err', 9000, { html: true });
    } finally {
      clearInterval(heartbeat);
      if (runBtn) runBtn.disabled = false;
    }
  }

  /* Восстановление этапа из сессии.

     Редактор срезов живёт внутри этого замыкания, и снаружи его никак не
     открыть. Из-за этого после загрузки архива этап 01 оставался пустым:
     файлы roi_ct и roi_mask лежали в сессии, а поставить их в редактор
     было некому.

     Точка входа повторяет хвост runInfer — тот же разбор томов и та же
     установка редактора, — но без инференса: результат уже есть. */
  window.Tab0 = window.Tab0 || {};

  /* Вход на этап 01: если восстановление отложено (вкладка была скрыта,
     холст нулевой) — открываем сейчас. */
  window.addEventListener('tab:change', (e) => {
    if (!e.detail || e.detail.name !== 'segment') return;
    if (!window.Tab0.__pendingRestore || editor) return;
    setTimeout(() => {
      window.Tab0.__pendingRestore = false;
      window.Tab0.restoreFromSession()
        .catch(err => console.warn('[tab0] восстановление:', err));
    }, 60);
  });

  window.Tab0.restoreFromSession = async function () {
    if (editor) return true;                     // уже открыт
    if (!window.NRRD || !window.NRRD.parse) return false;
    const okBuf = (k) => (r) => {
      if (!r.ok) throw new Error(k + ': HTTP ' + r.status);
      return r.arrayBuffer();
    };
    const [ctBuf, maskBuf] = await Promise.all([
      fetch('/api/session/roi_ct').then(okBuf('roi_ct')),
      fetch('/api/session/roi_mask').then(okBuf('roi_mask')),
    ]);
    const ctVol = await window.NRRD.parse(ctBuf);
    const maskVol = await window.NRRD.parse(maskBuf);
    if (String(ctVol.sizes) !== String(maskVol.sizes)) {
      throw new Error('размеры КТ и маски не совпали');
    }
    editor = SliceEditor.install(ctVol, maskVol);
    showEditorChrome(true);
    ctReady = true;
    window.dispatchEvent(new CustomEvent('ct:change',
      { detail: { name: 'из архива', size: 0 } }));
    return true;
  };

  function showEditorChrome(on) {
    const how = document.getElementById('segHowCard');
    if (how) how.style.display = on ? 'none' : 'block';
    ['segGuideCard', 'segToolsCard', 'segNextCard'].forEach((id) => {
      const el = document.getElementById(id); if (el) el.style.display = on ? 'block' : 'none';
    });
    const empty = document.querySelector('.stage[data-stage="segment"] .empty-state');
    const root = document.getElementById('segEditorRoot');
    if (empty) empty.style.display = on ? 'none' : '';
    if (root) root.style.display = on ? 'block' : 'none';
    const stage = document.querySelector('.stage[data-stage="segment"]');
    const vp = stage && stage.querySelector('.viewport');
    if (vp) vp.classList.toggle('has-mesh', on);
    // правая панель фиксирована — переключателя скрытия нет

    // ── Левая панель не нужна после инференса: убираем её целиком.
    //    Настройки модели нужны только ДО сегментации, поэтому язычок для
    //    повторного открытия не создаём (используем display:none, как seg-picking). ──
    const left = stage && stage.querySelector('.panel.left');
    if (left) left.style.display = on ? 'none' : '';
    if (stage) stage.classList.remove('seg-left-collapsed');   // снять режим прошлых версий
    const ltgl = document.getElementById('segLeftToggle');
    if (ltgl) ltgl.remove();                                   // язычок-треугольник больше не нужен

    if (on) window.dispatchEvent(new Event('resize'));         // холсты перерисуются под новую ширину
  }

  // ─── Коммит маски + выгрузка обучающей пары ─────────────────────────
  async function commitMask() {
    if (!editor) throw new Error('нет редактора');
    // Маску всегда пересобираем из редактора.
    const buf = editor.encodeMask();
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'application/octet-stream' }), 'roi_mask.nrrd');
    const r = await fetch('/api/session/roi_mask', { method: 'PUT', body: fd });
    if (!r.ok) throw new Error('сохранение маски: HTTP ' + r.status);

    // roi_ct — серверный артефакт из roi_pair. Мог пропасть между инференсом и
    // сохранением (рестарт сервера, переконвертация DICOM, reset_except при
    // загрузке OBJ в другой вкладке). Редактор держит КТ в памяти — если на
    // сервере его нет, восстанавливаем из редактора, иначе export_pair падает
    // на ['roi_ct']. Геометрия та же (s.geom), что и у маски.
    let hasCt = false;
    try {
      const man = await fetch('/api/session').then((x) => (x.ok ? x.json() : {}));
      hasCt = !!(man && man.roi_ct);
    } catch (_) { hasCt = false; }
    if (!hasCt && editor.encodeCT) {
      const ctBuf = editor.encodeCT();
      const fd2 = new FormData();
      fd2.append('file', new Blob([ctBuf], { type: 'application/octet-stream' }), 'roi_ct.nrrd');
      const r2 = await fetch('/api/session/roi_ct', { method: 'PUT', body: fd2 });
      if (!r2.ok) throw new Error('восстановление roi_ct: HTTP ' + r2.status);
    }
  }

  // ───────────────────────────────────────────────────────────────
  // Экспорт снапшота .nseg для прототипа nasal-seg-editor.html.
  // Формат: ["NSEG1" | uint32 LE длина JSON | JSON{sizes,spacing,name}
  //          | CT int16 LE (X*Y*Z) | mask uint8 (X*Y*Z)].
  // Порядок вокселей: x быстрее всего (i = x + X*y + X*Y*z) —
  // совпадает с s.mask / s.ctVol.data, пишем как есть, без перестановки.
  // ───────────────────────────────────────────────────────────────
  function exportNseg() {
    if (!editor || !editor.exportData) { _toast('Сначала запустите сегментацию', 'warn', 3500); return; }
    const d = editor.exportData();              // { sizes, spacing, ct, mask }
    const [X, Y, Z] = d.sizes;
    const N = X * Y * Z;
    if (!d.ct || d.ct.length !== N || !d.mask || d.mask.length !== N) {
      _toast('Экспорт: размеры КТ и маски не совпали', 'err', 5000); return;
    }
    const name = sanitize(val('segCaseId') || 'case');
    const enc = new TextEncoder();
    const magic = enc.encode('NSEG1');
    const hb = enc.encode(JSON.stringify({ sizes: [X, Y, Z], spacing: d.spacing, name }));
    const out = new Uint8Array(magic.length + 4 + hb.length + N * 2 + N);
    const dv = new DataView(out.buffer);
    let o = 0;
    out.set(magic, o); o += magic.length;
    dv.setUint32(o, hb.length, true); o += 4;
    out.set(hb, o); o += hb.length;
    for (let i = 0; i < N; i++) { dv.setInt16(o, Math.round(d.ct[i]) || 0, true); o += 2; }
    out.set(d.mask, o);                          // mask уже 0/1 uint8
    triggerDownload(out, name + '.nseg', 'application/octet-stream');
    _toast('Снапшот <strong>' + name + '.nseg</strong> сохранён в папку «Загрузки» (как и пара). ' +
           'Откройте его в прототипе — без повторной сегментации.', 'ok', 6000, { html: true });
  }

  async function downloadPair() {
    if (!editor) { _toast('Сначала запустите сегментацию', 'warn', 3500); return; }
    if (editor.foregroundCount() === 0) { _toast('Маска пустая — нечего выгружать', 'warn', 4000); return; }
    _spin('Сохранение маски…');
    try {
      await commitMask();
      _spinText('Сборка пары…');
      const cid = buildCaseId();                       // Иванов_АП_YYYYMMDD_HHMM
      await postJSON('/api/export_pair', { case_id: cid });

      _spinText('Сохранение рядом с КТ…');
      try {
        const r = await postJSON('/api/save_pair_beside_ct', { name: cid + '_pair.zip' });
        _spinHide();
        _toast('<strong>Пара сохранена:</strong><br>' + esc(r.path), 'ok', 8000, { html: true });
      } catch (e) {
        // папку КТ не знаем (DICOM залили по HTTP) или она только для чтения —
        // не теряем работу врача, отдаём файл обычной загрузкой
        _spinText('Скачивание…');
        const buf = await fetch('/api/session/train_pair').then(okBuf('train_pair'));
        triggerDownload(buf, cid + '_pair.zip', 'application/zip');
        _spinHide();
        _toast('<strong>Пара выгружена в загрузки:</strong> ' + esc(cid) + '_pair.zip.<br>' +
               esc(e.message), 'warn', 8000, { html: true });
      }
    } catch (err) {
      _spinHide();
      console.error('[tab0-segment]', err);
      _toast('<strong>Ошибка выгрузки:</strong> ' + err.message, 'err', 8000, { html: true });
    }
  }

  // Сериализация меша {V,F} в текст OBJ (1-based индексы).
  function meshToOBJ(m) {
    const V = m.V, F = m.F, out = ['# nasal-unwrap · tab00 export'];
    for (let i = 0; i < V.length; i += 3) out.push('v ' + V[i].toFixed(4) + ' ' + V[i + 1].toFixed(4) + ' ' + V[i + 2].toFixed(4));
    for (let i = 0; i < F.length; i += 3) out.push('f ' + (F[i] + 1) + ' ' + (F[i + 1] + 1) + ' ' + (F[i + 2] + 1));
    return out.join('\n') + '\n';
  }

  // Скачать поверхность в OBJ (сырой меш из маски, до серверного сглаживания).
  // Нужен для проверки/пересылки: показывает исходную геометрию (есть ли террасы уже здесь).
  function downloadOBJ() {
    if (!editor) { _toast('Сначала загрузите КТ', 'warn'); return; }
    try {
      const m = editor.meshForPipeline();
      if (!m || !m.nF) { _toast('Пустая маска — нечего экспортировать', 'warn'); return; }
      const base = (typeof segPatient === 'string' && segPatient) ? segPatient.replace(/[^\w\-.]+/g, '_') : 'case';
      triggerDownload(meshToOBJ(m), base + '_mesh_raw.obj', 'text/plain');
      _toast('OBJ сохранён', 'ok', 2500);
    } catch (e) {
      console.error('[tab0-segment] downloadOBJ:', e);
      _toast('Не удалось собрать OBJ', 'err');
    }
  }

  // Передача результата дальше. Заливаем поверхность на сервер и прогоняем preprocess —
  // ровно как загрузка OBJ на вкладке 1: это создаёт mesh_clean в сессии (без него вкладка
  // «Поверхность» падает с "session missing required inputs: ['mesh_clean']") и сглаживает
  // поверхность (Taubin+децимация, как экспорт из Slicer). Затем открываем вкладку «Данные».
  async function goToData() {
    if (!editor) { _toast('Сначала запустите сегментацию', 'warn', 3500); return; }
    if (!window.M || !window.Geom || !window.Tabs) {
      _toast('Не удалось перейти: пайплайн не загружен', 'err', 5000); return;
    }
    _spin('Строю поверхность…');
    try {
      await new Promise((r) => setTimeout(r, 30));   // дать спиннеру отрисоваться
      const mesh = editor.meshForPipeline();
      if (!mesh || !mesh.nV || !mesh.nF) {
        _spinHide(); _toast('Отмеченная область пуста — нечего передавать дальше', 'warn', 4500); return;
      }
      const cid = sanitize(val('segCaseId')) || 'segmentation';

      let committed = false, cleanedText = null;
      try {
        _spin('Загрузка поверхности на сервер…');
        const objText = meshToOBJ(mesh);
        const fd = new FormData();
        fd.append('file', new Blob([objText], { type: 'text/plain' }), cid + '.obj');
        let r = await fetch('/api/upload/mesh_raw', { method: 'POST', body: fd });
        if (!r.ok) throw new Error('upload mesh_raw: HTTP ' + r.status);

        _spin('Препроцессинг…');
        r = await fetch('/api/preprocess', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        if (!r.ok) {
          let msg = 'HTTP ' + r.status;
          try { const j = await r.json(); if (j.error) msg = j.error; } catch (_) {}
          throw new Error('preprocess: ' + msg);
        }

        _spin('Получение результата…');
        const cr = await fetch('/api/session/mesh_clean');
        if (!cr.ok) throw new Error('mesh_clean: HTTP ' + cr.status);
        cleanedText = await cr.text();
        const cleaned = (window.IO && window.IO.parseOBJ) ? window.IO.parseOBJ(cleanedText) : null;
        if (!cleaned || !cleaned.nV || !cleaned.nF) throw new Error('очищенный OBJ пустой');

        window.M.reset();
        window.M.rawV = cleaned.V; window.M.rawF = cleaned.F;
        window.M.rawNV = cleaned.nV; window.M.rawNF = cleaned.nF;
        window.M.source = { type: 'obj-cleaned', name: cid + '.obj', bytes: objText.length, cleanedBytes: cleanedText.length };
        const gc = window.Geom.compute(cleaned.V, cleaned.F, cleaned.nF);
        window.M.fn = gc.fn; window.M.fa = gc.fa; window.M.fc = gc.fc;
        committed = true;
      } catch (srvErr) {
        console.warn('[tab0-segment] серверный препроцесс недоступен, кладу меш локально:', srvErr);
      }

      if (!committed) {
        // Фолбэк: бэкенд недоступен. Кладём меш в память — вкладка «Данные» покажет его,
        // но «Поверхность» без mesh_clean может не запуститься (нужен работающий сервер).
        window.M.reset();
        window.M.rawV = mesh.V; window.M.rawF = mesh.F; window.M.rawNV = mesh.nV; window.M.rawNF = mesh.nF;
        window.M.source = { type: 'mesh', name: cid + '.obj', bytes: 0 };
        const gg = window.Geom.compute(mesh.V, mesh.F, mesh.nF);
        window.M.fn = gg.fn; window.M.fa = gg.fa; window.M.fc = gg.fc;
      }

      commitMask().catch(() => {});   // сохранить маску в сессию (не блокируя переход)
      window.dispatchEvent(new CustomEvent('data:change', { detail: { kind: 'obj-loaded' } }));
      _spinHide();
      window.Tabs.switchTo('data');
      if (committed) {
        _toast('<strong>Поверхность обработана и передана на вкладку «Модель».</strong>', 'ok', 4500, { html: true });
      } else {
        _toast('<strong>Поверхность передана (локально).</strong> Бэкенд недоступен — этап «Слизистая» ' +
               'может потребовать повторной загрузки OBJ.', 'warn', 7000, { html: true });
      }
    } catch (err) {
      _spinHide();
      console.error('[tab0-segment] goToData:', err);
      _toast('Ошибка перехода к данным: ' + (err && err.message || err), 'err', 6000);
    }
  }

  // ─── Движок выстилки (валидирован офлайн на КТ; JS↔Python воксель-в-воксель) ───
  const LC = (function () {
'use strict';
/* Pure voxel algorithms for the lining editor. No DOM. (Z,Y,X) flat arrays,
   index i = x + X*y + X*Y*z. sp = [spZ,spY,spX] in mm. */

function airMask(ct, thr) { const n=ct.length, a=new Uint8Array(n); for(let i=0;i<n;i++) a[i]=ct[i]<thr?1:0; return a; }

// Exact squared anisotropic EDT to nearest air voxel (mm^2). Felzenszwalb–Huttenlocher, separable.
function sqDistToAir(air, Z,Y,X, sp){
  const n=Z*Y*X, INF=1e20, D=new Float64Array(n);
  for(let i=0;i<n;i++) D[i]=air[i]?0:INF;
  const dt1=(f,n,a)=>{ // 1D DT, metric a*(q-p)^2, in place on f (length n)
    const v=new Int32Array(n), z=new Float64Array(n+1), out=new Float64Array(n);
    let k=0; v[0]=0; z[0]=-INF; z[1]=INF;
    for(let q=1;q<n;q++){
      let s;
      while(true){ const p=v[k];
        s=((f[q]+a*q*q)-(f[p]+a*p*p))/(2*a*q-2*a*p);
        if(s<=z[k]) k--; else break; }
      k++; v[k]=q; z[k]=s; z[k+1]=INF;
    }
    k=0;
    for(let q=0;q<n;q++){ while(z[k+1]<q) k++; const p=v[k]; out[q]=a*(q-p)*(q-p)+f[p]; }
    return out;
  };
  // along X (a=spX^2)
  { const aX=sp[2]*sp[2], f=new Float64Array(X);
    for(let z=0;z<Z;z++)for(let y=0;y<Y;y++){ const o=(z*Y+y)*X;
      for(let x=0;x<X;x++) f[x]=D[o+x]; const r=dt1(f,X,aX); for(let x=0;x<X;x++) D[o+x]=r[x]; } }
  // along Y
  { const aY=sp[1]*sp[1], f=new Float64Array(Y);
    for(let z=0;z<Z;z++)for(let x=0;x<X;x++){
      for(let y=0;y<Y;y++) f[y]=D[(z*Y+y)*X+x]; const r=dt1(f,Y,aY); for(let y=0;y<Y;y++) D[(z*Y+y)*X+x]=r[y]; } }
  // along Z
  { const aZ=sp[0]*sp[0], f=new Float64Array(Z);
    for(let y=0;y<Y;y++)for(let x=0;x<X;x++){
      for(let z=0;z<Z;z++) f[z]=D[(z*Y+y)*X+x]; const r=dt1(f,Z,aZ); for(let z=0;z<Z;z++) D[(z*Y+y)*X+x]=r[z]; } }
  return D; // mm^2
}

const NB26=(()=>{const a=[];for(let dz=-1;dz<=1;dz++)for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(dz||dy||dx)a.push([dz,dy,dx]);return a;})();

function keepLargest(m, Z,Y,X){
  const n=Z*Y*X, lab=new Int32Array(n), st=new Int32Array(n); let cur=0, best=0, bestSz=0, bestId=0;
  for(let s=0;s<n;s++){ if(!m[s]||lab[s])continue; cur++; let sp_=0, sz=0; st[sp_++]=s; lab[s]=cur;
    while(sp_){ const i=st[--sp_]; sz++; const x=i%X, y=((i/X)|0)%Y, z=(i/(X*Y))|0;
      for(const[dz,dy,dx]of NB26){ const nx=x+dx,ny=y+dy,nz=z+dz; if(nx<0||ny<0||nz<0||nx>=X||ny>=Y||nz>=Z)continue;
        const j=nx+X*ny+X*Y*nz; if(m[j]&&!lab[j]){lab[j]=cur;st[sp_++]=j;} } }
    if(sz>bestSz){bestSz=sz;bestId=cur;} }
  const out=new Uint8Array(n); for(let i=0;i<n;i++) out[i]=(lab[i]===bestId)?1:0; return out;
}

function fillHoles3D(m, Z,Y,X){
  const n=Z*Y*X, outside=new Uint8Array(n), st=new Int32Array(n); let sp_=0;
  const push=(i)=>{ if(!m[i]&&!outside[i]){outside[i]=1;st[sp_++]=i;} };
  for(let z=0;z<Z;z++)for(let y=0;y<Y;y++){ push((z*Y+y)*X+0); push((z*Y+y)*X+(X-1)); }
  for(let z=0;z<Z;z++)for(let x=0;x<X;x++){ push((z*Y+0)*X+x); push((z*Y+(Y-1))*X+x); }
  for(let y=0;y<Y;y++)for(let x=0;x<X;x++){ push((0*Y+y)*X+x); push(((Z-1)*Y+y)*X+x); }
  while(sp_){ const i=st[--sp_]; const x=i%X, y=((i/X)|0)%Y, z=(i/(X*Y))|0;
    for(const[dz,dy,dx]of NB6){ const nx=x+dx,ny=y+dy,nz=z+dz; if(nx<0||ny<0||nz<0||nx>=X||ny>=Y||nz>=Z)continue;
      push(nx+X*ny+X*Y*nz); } }
  const out=new Uint8Array(n); for(let i=0;i<n;i++) out[i]=(m[i]||!outside[i])?1:0; return out;
}

const NB6=[[-1,0,0],[1,0,0],[0,-1,0],[0,1,0],[0,0,-1],[0,0,1]];
function dilate(m, Z,Y,X, iters){ // 6-connectivity (matches scipy default structure)
  let a=Uint8Array.from(m);
  for(let it=0;it<iters;it++){ const b=new Uint8Array(a.length);
    for(let z=0;z<Z;z++)for(let y=0;y<Y;y++)for(let x=0;x<X;x++){ const i=x+X*y+X*Y*z; if(a[i]){b[i]=1;continue;}
      let hit=0; for(const[dz,dy,dx]of NB6){const nx=x+dx,ny=y+dy,nz=z+dz; if(nx<0||ny<0||nz<0||nx>=X||ny>=Y||nz>=Z)continue; if(a[nx+X*ny+X*Y*nz]){hit=1;break;}} b[i]=hit; }
    a=b; }
  return a;
}

function cleanup(mask, ct, Z,Y,X, airThr){
  const n=Z*Y*X, air=airMask(ct,airThr), m=new Uint8Array(n);
  for(let i=0;i<n;i++) m[i]=(mask[i]&&!air[i])?1:0;
  return fillHoles3D(keepLargest(m,Z,Y,X),Z,Y,X);
}

function shaveToLining(region, ct, Z,Y,X, sp, tMM, airThr){
  const n=Z*Y*X, air=airMask(ct,airThr), d2=sqDistToAir(air,Z,Y,X,sp), t2=tMM*tMM;
  const near=dilate(region,Z,Y,X,2), lin=new Uint8Array(n);
  for(let i=0;i<n;i++) lin[i]=(near[i]&&!air[i]&&d2[i]<=t2)?1:0;
  return keepLargest(lin,Z,Y,X);
}

function eraserBall(mask, Z,Y,X, sp, c, Rmm, axis, throughR){
  const R2=Rmm*Rmm, out=[]; if(axis===undefined)axis=-1; if(throughR===undefined)throughR=1;
  const fixed=(axis===0)?c[0]:(axis===1)?c[1]:(axis===2)?c[2]:0;
  const rz=(Rmm/sp[0]|0)+1, ry=(Rmm/sp[1]|0)+1, rx=(Rmm/sp[2]|0)+1;
  for(let z=Math.max(0,c[0]-rz);z<=Math.min(Z-1,c[0]+rz);z++)
   for(let y=Math.max(0,c[1]-ry);y<=Math.min(Y-1,c[1]+ry);y++)
    for(let x=Math.max(0,c[2]-rx);x<=Math.min(X-1,c[2]+rx);x++){
      if(axis>=0){ const cc=(axis===0)?z:(axis===1)?y:x; if(Math.abs(cc-fixed)>throughR) continue; }
      const dz=(z-c[0])*sp[0], dy=(y-c[1])*sp[1], dx=(x-c[2])*sp[2];
      if(dz*dz+dy*dy+dx*dx<=R2){ const i=x+X*y+X*Y*z; if(mask[i]) out.push(i); } }
  return {idx:out};
}

// brush: add lining under ball, only component connected to cursor through tissue (one wall)
function brushLining(mask, ct, Z,Y,X, sp, cursor, Rmm, tMM, airThr, d2, axis, throughR){
  // axis: 0=z,1=y,2=x — нормаль видимой плоскости; throughR — на сколько срезов вглубь можно (мал).
  // axis<0 -> полный 3D-шар (для офлайн-проверки паритета). Возвращает {idx:[...]} — только локально, O(ball).
  if(!d2) d2 = sqDistToAir(airMask(ct,airThr),Z,Y,X,sp);
  if(axis===undefined) axis=-1; if(throughR===undefined) throughR=1;
  const t2=tMM*tMM, R2=Rmm*Rmm; let [cz,cy,cx]=cursor;
  const idx=(z,y,x)=>x+X*y+X*Y*z;
  const isAir=(i)=>d2[i]===0;
  const fixed = (axis===0)?cz:(axis===1)?cy:(axis===2)?cx:0;
  const inThrough=(z,y,x)=>{ if(axis<0) return true; const c=(axis===0)?z:(axis===1)?y:x; return Math.abs(c-fixed)<=throughR; };
  if(isAir(idx(cz,cy,cx))){
    let best=-1,bd=1e9; const r=2;
    for(let z=Math.max(0,cz-r);z<=Math.min(Z-1,cz+r);z++)for(let y=Math.max(0,cy-r);y<=Math.min(Y-1,cy+r);y++)for(let x=Math.max(0,cx-r);x<=Math.min(X-1,cx+r);x++){
      if(axis>=0){ const cc=(axis===0)?z:(axis===1)?y:x; if(cc!==fixed) continue; }   // привязка не уходит со среза
      const i=idx(z,y,x); if(!isAir(i)){const dz=(z-cz)*sp[0],dy=(y-cy)*sp[1],dx=(x-cx)*sp[2],dd=dz*dz+dy*dy+dx*dx; if(dd<bd){bd=dd;best=i;}}}
    if(best<0) return {idx:[]}; cz=(best/(X*Y))|0; cy=((best/X)|0)%Y; cx=best%X;
  }
  const start=idx(cz,cy,cx); const seen=new Set([start]); const stack=[start]; const comp=[start];
  const cand=(z,y,x,i)=>{ const dz=(z-cz)*sp[0],dy=(y-cy)*sp[1],dx=(x-cx)*sp[2];
    return (dz*dz+dy*dy+dx*dx<=R2) && inThrough(z,y,x) && !isAir(i) && d2[i]<=t2; };
  while(stack.length){ const i=stack.pop(); const x=i%X,y=((i/X)|0)%Y,z=(i/(X*Y))|0;
    for(const[dz,dy,dx]of NB26){ const nx=x+dx,ny=y+dy,nz=z+dz; if(nx<0||ny<0||nz<0||nx>=X||ny>=Y||nz>=Z)continue;
      const j=nx+X*ny+X*Y*nz; if(!seen.has(j)&&cand(nz,ny,nx,j)){seen.add(j);stack.push(j);comp.push(j);} } }
  return {idx:comp};
}


// Шар/диск под курсором (для разметки). axis<0 — 3D-шар; иначе плоско на срезе ±throughR.
// gateAir=true — не красить воздух (ct[i]>airThr). Возвращает {idx:[...]}.
function paintBall(ct, Z,Y,X, sp, c, Rmm, axis, throughR, airThr, gateAir){
  const R2=Rmm*Rmm, out=[]; if(axis===undefined)axis=-1; if(throughR===undefined)throughR=0;
  const fixed=(axis===0)?c[0]:(axis===1)?c[1]:(axis===2)?c[2]:0;
  const rz=(Rmm/sp[0]|0)+1, ry=(Rmm/sp[1]|0)+1, rx=(Rmm/sp[2]|0)+1;
  for(let z=Math.max(0,c[0]-rz);z<=Math.min(Z-1,c[0]+rz);z++)
   for(let y=Math.max(0,c[1]-ry);y<=Math.min(Y-1,c[1]+ry);y++)
    for(let x=Math.max(0,c[2]-rx);x<=Math.min(X-1,c[2]+rx);x++){
      if(axis>=0){ const cc=(axis===0)?z:(axis===1)?y:x; if(Math.abs(cc-fixed)>throughR) continue; }
      const dz=(z-c[0])*sp[0], dy=(y-c[1])*sp[1], dx=(x-c[2])*sp[2];
      if(dz*dz+dy*dy+dx*dx<=R2){ const i=x+X*y+X*Y*z; if(!gateAir || ct[i]>airThr) out.push(i); } }
  return {idx:out};
}
// Порог воздуха из самого КТ: пик воздуха (самый населённый бин ниже -200) + запас, ограничен.
function airThreshold(ct){
  const lo=-1100, hi=-200, nb=hi-lo, h=new Int32Array(nb+1);
  for(let i=0;i<ct.length;i++){ const v=ct[i]; if(v>=lo&&v<=hi) h[v-lo]++; }
  let peak=lo, best=-1; for(let b=0;b<=nb;b++) if(h[b]>best){ best=h[b]; peak=lo+b; }
  let thr=peak+250; if(thr<-600)thr=-600; if(thr>-250)thr=-250; return thr;
}


// Эрозия 6-связности, R проходов. За пределами объёма — фон (граница эродируется).
function erode(mask, Z,Y,X, R){
  let cur=Uint8Array.from(mask);
  for(let it=0; it<R; it++){
    const out=new Uint8Array(cur.length);
    for(let z=0;z<Z;z++)for(let y=0;y<Y;y++)for(let x=0;x<X;x++){
      const i=x+X*y+X*Y*z; if(!cur[i]) continue;
      if(x===0||!cur[i-1])continue; if(x===X-1||!cur[i+1])continue;
      if(y===0||!cur[i-X])continue; if(y===Y-1||!cur[i+X])continue;
      if(z===0||!cur[i-X*Y])continue; if(z===Z-1||!cur[i+X*Y])continue;
      out[i]=1;
    }
    cur=out;
  }
  return cur;
}
// Морфологическое замыкание с паддингом (R вокс) — без краевых артефактов.
// Заполняет дыры/окна/вмятины <=~2R вокс, не растит границу ROI.
function close(mask, Z,Y,X, R){
  const PZ=Z+2*R, PY=Y+2*R, PX=X+2*R, PXY=PX*PY;
  const pad=new Uint8Array(PZ*PY*PX);
  for(let z=0;z<Z;z++)for(let y=0;y<Y;y++)for(let x=0;x<X;x++)
    if(mask[x+X*y+X*Y*z]) pad[(x+R)+PX*(y+R)+PXY*(z+R)]=1;
  const d=dilate(pad, PZ,PY,PX, R);
  const e=erode(d, PZ,PY,PX, R);
  const out=new Uint8Array(Z*Y*X);
  for(let z=0;z<Z;z++)for(let y=0;y<Y;y++)for(let x=0;x<X;x++)
    out[x+X*y+X*Y*z]=e[(x+R)+PX*(y+R)+PXY*(z+R)];
  return out;
}
// ── 2D signed-distance слайс-морфинг (для «Протянуть между срезами») ──
// index конвенция как везде: i = x + X*y + X*Y*z; срез длиной X*Y индексируется x + X*y.
function _edt1(f, n){ // 1D квадратичный EDT (Felzenszwalb–Huttenlocher)
  const v=new Int32Array(n), z=new Float64Array(n+1), d=new Float64Array(n);
  let k=0; v[0]=0; z[0]=-1e20; z[1]=1e20;
  for(let q=1;q<n;q++){ let s; while(true){ const p=v[k]; s=((f[q]+q*q)-(f[p]+p*p))/(2*q-2*p); if(s<=z[k])k--; else break; } k++; v[k]=q; z[k]=s; z[k+1]=1e20; }
  k=0; for(let q=0;q<n;q++){ while(z[k+1]<q)k++; const p=v[k]; d[q]=(q-p)*(q-p)+f[p]; }
  return d;
}
function _edt2(seed, W, H){ // квадратичный 2D EDT: расстояние до ближайшего seed=1
  const D=new Float64Array(W*H); for(let i=0;i<W*H;i++) D[i]=seed[i]?0:1e20;
  const col=new Float64Array(H), row=new Float64Array(W);
  for(let x=0;x<W;x++){ for(let y=0;y<H;y++) col[y]=D[x+W*y]; const r=_edt1(col,H); for(let y=0;y<H;y++) D[x+W*y]=r[y]; }
  for(let y=0;y<H;y++){ for(let x=0;x<W;x++) row[x]=D[x+W*y]; const r=_edt1(row,W); for(let x=0;x<W;x++) D[x+W*y]=r[x]; }
  return D;
}
function _sdf(fg, W, H){ // знаковое расстояние: + внутри, − снаружи; null если пусто
  const bg=new Uint8Array(W*H); let any=0; for(let i=0;i<W*H;i++){ bg[i]=fg[i]?0:1; if(fg[i])any=1; }
  if(!any) return null;
  const dIn=_edt2(bg,W,H), dOut=_edt2(fg,W,H), phi=new Float64Array(W*H);
  for(let i=0;i<W*H;i++) phi[i]=fg[i]?Math.sqrt(dIn[i]):-Math.sqrt(dOut[i]);
  return phi;
}
function _centroid(fg, W, H){ let sx=0,sy=0,n=0; for(let y=0;y<H;y++)for(let x=0;x<W;x++) if(fg[x+W*y]){ sx+=x; sy+=y; n++; } return n?[sx/n,sy/n,n]:null; }
function _samp(phi, W, H, x, y){ x=Math.round(x); y=Math.round(y); if(x<0||y<0||x>=W||y>=H) return -1e9; return phi[x+W*y]; }
// Залить промежуточные срезы между k0 и k1 морфингом форм по оси axis (0=z/акс, 1=y/кор, 2=x/саг).
function _slice2D(mask, X,Y,Z, axis, k){
  let W,H; if(axis===0){W=X;H=Y;} else if(axis===1){W=X;H=Z;} else {W=Y;H=Z;}
  const buf=new Uint8Array(W*H);
  if(axis===0){ const base=k*X*Y; for(let i=0;i<W*H;i++) buf[i]=mask[base+i]?1:0; }
  else if(axis===1){ for(let h=0;h<H;h++)for(let w=0;w<W;w++) buf[w+W*h]=mask[w + X*k + X*Y*h]?1:0; }
  else { for(let h=0;h<H;h++)for(let w=0;w<W;w++) buf[w+W*h]=mask[k + X*w + X*Y*h]?1:0; }
  return {buf,W,H};
}
function _giWrite(X,Y,Z, axis, k, w, h){
  if(axis===0) return w + X*h + X*Y*k;
  if(axis===1) return w + X*k + X*Y*h;
  return k + X*w + X*Y*h;
}
function sliceMorphAxis(mask, Z,Y,X, axis, k0, k1){
  const S0=_slice2D(mask,X,Y,Z,axis,k0), S1=_slice2D(mask,X,Y,Z,axis,k1);
  const W=S0.W, H=S0.H;
  const p0=_sdf(S0.buf,W,H), p1=_sdf(S1.buf,W,H); if(!p0||!p1) return 0;
  const c0=_centroid(S0.buf,W,H), c1=_centroid(S1.buf,W,H);
  let filled=0;
  for(let k=k0+1; k<k1; k++){
    const t=(k-k0)/(k1-k0);
    const ctx=(1-t)*c0[0]+t*c1[0], cty=(1-t)*c0[1]+t*c1[1];
    const o0x=ctx-c0[0], o0y=cty-c0[1], o1x=ctx-c1[0], o1y=cty-c1[1];
    for(let h=0;h<H;h++)for(let w=0;w<W;w++){
      const v=(1-t)*_samp(p0,W,H,w-o0x,h-o0y)+t*_samp(p1,W,H,w-o1x,h-o1y);
      if(v>=0){ const gi=_giWrite(X,Y,Z,axis,k,w,h); if(!mask[gi]){ mask[gi]=1; filled++; } }
    }
  }
  return filled;
}
// Залить замкнутые 2D-дырки на аксиальных срезах площадью <= cap (проколы; просвет не трогаем).
function fill2DHolesAxial(mask, Z,Y,X, cap){
  const XY=X*Y; let filled=0;
  for(let z=0;z<Z;z++){
    const base=z*XY, seen=new Uint8Array(XY);
    for(let p0=0;p0<XY;p0++){
      if(mask[base+p0]||seen[p0]) continue;
      const comp=[]; let touch=false; const st=[p0]; seen[p0]=1;
      while(st.length){ const p=st.pop(); comp.push(p); const x=p%X, y=(p/X)|0;
        if(x===0||y===0||x===X-1||y===Y-1) touch=true;
        if(x>0    && !mask[base+p-1] && !seen[p-1]){ seen[p-1]=1; st.push(p-1); }
        if(x<X-1  && !mask[base+p+1] && !seen[p+1]){ seen[p+1]=1; st.push(p+1); }
        if(y>0    && !mask[base+p-X] && !seen[p-X]){ seen[p-X]=1; st.push(p-X); }
        if(y<Y-1  && !mask[base+p+X] && !seen[p+X]){ seen[p+X]=1; st.push(p+X); }
      }
      if(!touch && comp.length<=cap){ for(const p of comp){ mask[base+p]=1; filled++; } }
    }
  }
  return filled;
}
return {airMask,sqDistToAir,keepLargest,fillHoles3D,dilate,cleanup,shaveToLining,eraserBall,brushLining,paintBall,airThreshold,erode,close,sliceMorphAxis,fill2DHolesAxial};
})();

  // Маска (0/1) → гладкий треугольный меш: Surface Nets + лапласово сглаживание.
  // Возвращает { V:Float32Array(xyz), F:Int32Array(idx), nV, nF } или null (пусто).
  function segMaskToMesh(mask, sizes, spacing, maxDim, opts) {
    const smooth = (opts && opts.smooth) || 'laplace';
    const [X, Y, Z] = sizes, XY = X * Y;
    const sp = (spacing && spacing.length === 3) ? spacing : [1, 1, 1];
    const st = Math.max(1, Math.floor(Math.max(X, Y, Z) / (maxDim || 110)));
    const nx = Math.floor((X - 1) / st) + 1, ny = Math.floor((Y - 1) / st) + 1, nz = Math.floor((Z - 1) / st) + 1;
    if (nx < 2 || ny < 2 || nz < 2) return null;
    const CORNERS = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
    const EDGES = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
    const NN = nx * ny * nz;
    const fi = (x, y, z) => x + nx * y + nx * ny * z;

    // 1) бинарное поле в разрешении семплинга (0/1)
    let f = new Float32Array(NN);
    for (let gz = 0; gz < nz; gz++)
      for (let gy = 0; gy < ny; gy++)
        for (let gx = 0; gx < nx; gx++)
          f[fi(gx, gy, gz)] = mask[(gx * st) + X * (gy * st) + XY * (gz * st)] ? 1 : 0;

    // 2) сглаживание поля (сепарабельное 1-2-1 по трём осям) — гауссов антиалиасинг маски,
    //    как в 3D Slicer ПЕРЕД полигонизацией. Убирает «лесенку» на уровне данных, а не меша.
    const BLUR = (opts && opts.blur != null) ? opts.blur : ((smooth === 'taubin') ? 2 : 1);
    let tmp = new Float32Array(NN);
    function blurAxis(src, dst, ax) {
      for (let z = 0; z < nz; z++)
        for (let y = 0; y < ny; y++)
          for (let x = 0; x < nx; x++) {
            const c = src[fi(x, y, z)];
            let a, b;
            if (ax === 0) { a = src[fi(x > 0 ? x-1 : 0, y, z)]; b = src[fi(x < nx-1 ? x+1 : nx-1, y, z)]; }
            else if (ax === 1) { a = src[fi(x, y > 0 ? y-1 : 0, z)]; b = src[fi(x, y < ny-1 ? y+1 : ny-1, z)]; }
            else { a = src[fi(x, y, z > 0 ? z-1 : 0)]; b = src[fi(x, y, z < nz-1 ? z+1 : nz-1)]; }
            dst[fi(x, y, z)] = (a + 2 * c + b) * 0.25;
          }
    }
    for (let p = 0; p < BLUR; p++) {
      blurAxis(f, tmp, 0); let sw = f; f = tmp; tmp = sw;
      blurAxis(f, tmp, 1); sw = f; f = tmp; tmp = sw;
      blurAxis(f, tmp, 2); sw = f; f = tmp; tmp = sw;
    }

    // 2b) анизотропный доводочный blur вдоль «толстой» оси — убирает «полосы срезов»
    //     от крупного шага КТ (Slicer гладит с учётом реального шага вокселя).
    //     Число доп. проходов на ось = во сколько раз её шаг крупнее минимального.
    //     opts.anisoBlur:false — выключить (для превью, чтобы не «мылило»).
    const minSp = Math.min(sp[0], sp[1], sp[2]) || 1;
    if (!(opts && opts.anisoBlur === false))
    for (let ax = 0; ax < 3; ax++) {
      let extra = Math.round(sp[ax] / minSp) - 1;
      if (opts && opts.sliceBlur != null && opts.sliceAxis === ax) extra = Math.max(extra, opts.sliceBlur);
      extra = Math.max(0, Math.min(extra, 4));
      for (let p = 0; p < extra; p++) { blurAxis(f, tmp, ax); const sw2 = f; f = tmp; tmp = sw2; }
    }

    // 3) полигонизация. Топология зависит от opts.topology:
    //    • 'binary' (по умолчанию, для пайплайна) — строго по бинарной маске: связность/genus
    //      не меняются, вкладка «Поверхность» не ломается. Позиции вершин берём из сглаженного поля.
    //    • 'smooth' (только для превью) — по сглаженному полю (как marching cubes в Slicer):
    //      красиво и гладко, но топология может отличаться — в пайплайн такой меш НЕ идёт.
    const ISO = 0.5;
    const smoothTopo = opts && opts.topology === 'smooth';
    const g = smoothTopo
      ? (x, y, z) => (f[fi(x, y, z)] >= ISO ? 1 : 0)
      : (x, y, z) => (mask[(x * st) + X * (y * st) + XY * (z * st)] ? 1 : 0);
    const cnx = nx - 1, cny = ny - 1, cnz = nz - 1;
    const cellV = new Int32Array(cnx * cny * cnz).fill(-1);
    const verts = []; const bval = new Array(8), fv = new Array(8);
    for (let cz = 0; cz < cnz; cz++)
      for (let cy = 0; cy < cny; cy++)
        for (let cx = 0; cx < cnx; cx++) {
          let inside = 0;
          for (let i = 0; i < 8; i++) {
            const c = CORNERS[i];
            const bv = g(cx + c[0], cy + c[1], cz + c[2]); bval[i] = bv; if (bv) inside++;
            fv[i] = f[fi(cx + c[0], cy + c[1], cz + c[2])];
          }
          if (inside === 0 || inside === 8) continue;                  // классификация — по бинарной маске
          let ex = 0, ey = 0, ez = 0, en = 0;
          for (let e = 0; e < 12; e++) {
            const a = EDGES[e][0], b = EDGES[e][1];
            if (bval[a] === bval[b]) continue;                         // ребро пересекает границу маски
            const fa = fv[a], fb = fv[b];
            let t = ((fa >= ISO) !== (fb >= ISO) && fb !== fa) ? (ISO - fa) / (fb - fa) : 0.5;  // крестик по полю, иначе середина
            if (t < 0) t = 0; else if (t > 1) t = 1;
            const ca = CORNERS[a], cb = CORNERS[b];
            ex += ca[0] + (cb[0] - ca[0]) * t;
            ey += ca[1] + (cb[1] - ca[1]) * t;
            ez += ca[2] + (cb[2] - ca[2]) * t; en++;
          }
          if (!en) continue;
          ex /= en; ey /= en; ez /= en;
          cellV[cx + cnx*cy + cnx*cny*cz] = verts.length / 3;
          verts.push((cx + ex) * st * sp[0], (cy + ey) * st * sp[1], (cz + ez) * st * sp[2]);
        }
    if (!verts.length) return null;

    const cAt = (cx, cy, cz) => (cx<0||cy<0||cz<0||cx>=cnx||cy>=cny||cz>=cnz) ? -1 : cellV[cx + cnx*cy + cnx*cny*cz];
    const idx = [];
    /* Порядок вершин квада зависит от того, с какой стороны материал.
     *
     * Раньше он был фиксированным: idx.push(a,b,c, a,c,d) независимо от
     * знака перехода. Для граней, где заполнена «дальняя» ячейка, обход
     * получался зеркальным, нормаль смотрела внутрь — и поверхность
     * выходила НЕОРИЕНТИРУЕМОЙ.
     *
     * Что это ломало дальше (замерено на реальной маске):
     *   mesh_raw    — 10 142 ребра, пройденных дважды в одном направлении
     *   mesh_clean  — 604 после препроцесса; pymeshlab чинит не всё,
     *                 в его логе «Orientability requires manifoldness»
     *   формула Эйлера давала НЕЦЕЛЫЙ род 7.5, чего не бывает
     *   cut_handles искал несуществующие ручки и не доходил до диска
     *   ARAP        падал: «Factor is exactly singular»
     *
     * Для сравнения: эталонный marching_cubes из scikit-image на той же
     * маске даёт 0 несогласованных рёбер. Дело было не в данных.
     *
     * flip переворачивает обход, когда материал с другой стороны грани. */
    const quad = (a, b, c, d, flip) => {
      if (a < 0 || b < 0 || c < 0 || d < 0) return;
      if (flip) idx.push(a, c, b, a, d, c);
      else      idx.push(a, b, c, a, c, d);
    };
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const s0 = g(i, j, k);                                       // квады — тоже по бинарной маске
          if (i+1 < nx && s0 !== g(i+1, j, k))
            quad(cAt(i, j-1, k-1), cAt(i, j, k-1), cAt(i, j, k), cAt(i, j-1, k), !s0);
          if (j+1 < ny && s0 !== g(i, j+1, k))
            quad(cAt(i-1, j, k-1), cAt(i, j, k-1), cAt(i, j, k), cAt(i-1, j, k), s0);
          if (k+1 < nz && s0 !== g(i, j, k+1))
            quad(cAt(i-1, j-1, k), cAt(i, j-1, k), cAt(i, j, k), cAt(i-1, j, k), !s0);
        }
    if (!idx.length) return null;

    /* 3.5) Согласование обхода граней (ориентация нормалей).
     *
     * Правка порядка вершин выше убирает основную массу расхождений
     * (10 142 -> 46 на реальной маске), но неоднозначные конфигурации
     * ячеек — где грань касается диагонально — дают локальные развороты.
     * Этот проход добивает остаток.
     *
     * Обход в ширину по графу смежности: у согласованных соседей общее
     * ребро проходится в ПРОТИВОПОЛОЖНЫХ направлениях. Совпало —
     * треугольник переворачиваем.
     *
     * Геометрия не меняется, только порядок индексов в треугольнике. */
    (function orientCoherently() {
      const nT = idx.length / 3;
      const e2f = new Map();
      const key = (x, y) => (x < y ? x + ':' + y : y + ':' + x);
      for (let t = 0; t < nT; t++) {
        const a = idx[t*3], b = idx[t*3+1], c = idx[t*3+2];
        for (const [x, y] of [[a,b],[b,c],[c,a]]) {
          const k = key(x, y);
          const l = e2f.get(k);
          if (l) l.push(t); else e2f.set(k, [t]);
        }
      }
      const seen = new Uint8Array(nT);
      const stack = new Int32Array(nT);
      let flipped = 0;
      for (let root = 0; root < nT; root++) {
        if (seen[root]) continue;
        seen[root] = 1;
        let sp = 0; stack[sp++] = root;
        while (sp > 0) {
          const t = stack[--sp];
          const a = idx[t*3], b = idx[t*3+1], c = idx[t*3+2];
          for (const [x, y] of [[a,b],[b,c],[c,a]]) {
            const l = e2f.get(key(x, y));
            if (!l || l.length !== 2) continue;   // граница или non-manifold
            const u = (l[0] === t) ? l[1] : l[0];
            if (seen[u]) continue;
            seen[u] = 1;
            const p = idx[u*3], q = idx[u*3+1], r = idx[u*3+2];
            if ((p === x && q === y) || (q === x && r === y) || (r === x && p === y)) {
              idx[u*3+1] = r; idx[u*3+2] = q;
              flipped++;
            }
            stack[sp++] = u;
          }
        }
      }
      if (flipped) console.log('[segMaskToMesh] согласовано граней:', flipped, 'из', nT);
    })();

    // 4) лёгкое Taubin-сглаживание меша: поле уже сгладило, много не нужно (иначе «мутно»)
    const n = verts.length / 3;
    const nbr = []; for (let v = 0; v < n; v++) nbr.push(new Set());
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t+1], c = idx[t+2];
      nbr[a].add(b); nbr[a].add(c); nbr[b].add(a); nbr[b].add(c); nbr[c].add(a); nbr[c].add(b);
    }
    let cur = Float32Array.from(verts);
    function step(c, ff) {
      const out = new Float32Array(c.length);
      for (let v = 0; v < n; v++) {
        const ns = nbr[v];
        if (!ns.size) { out[v*3]=c[v*3]; out[v*3+1]=c[v*3+1]; out[v*3+2]=c[v*3+2]; continue; }
        let sx = 0, sy = 0, sz = 0; ns.forEach((j) => { sx += c[j*3]; sy += c[j*3+1]; sz += c[j*3+2]; });
        const kk = ns.size;
        out[v*3]   = c[v*3]   + ff*((sx/kk) - c[v*3]);
        out[v*3+1] = c[v*3+1] + ff*((sy/kk) - c[v*3+1]);
        out[v*3+2] = c[v*3+2] + ff*((sz/kk) - c[v*3+2]);
      }
      return out;
    }
    const L = 0.5, M = -0.53;
    const NT = (opts && opts.taubin != null) ? opts.taubin : ((smooth === 'taubin') ? (smoothTopo ? 10 : 6) : 2);   // Taubin λ|μ, без усадки
    for (let i = 0; i < NT; i++) { cur = step(cur, L); cur = step(cur, M); }
    return { V: cur, F: Int32Array.from(idx), nV: cur.length / 3, nF: idx.length / 3 };
  }

  // ═══════════════════════════════════════════════════════════
  // 3D-рендер маски. Если доступен three.js (window.Viewer) — строим
  // гладкий меш (Surface Nets + лапласово сглаживание) и показываем
  // через общий Viewer (свет/орбита/темы, как на «Развёртке»).
  // Иначе — запасной софт-рендер (точки-воксели, без библиотек).
  // ═══════════════════════════════════════════════════════════
  // 3D-превью маски для вкладки сегментации.
  // Используем НАДЁЖНЫЙ программный рендер на 2D-канвасе (без WebGL): он
  // гарантированно рисует и поддерживает навигацию/лепку. (three.js-путь
  // в этом окружении давал чёрный экран, поэтому здесь на него не опираемся.)
  // 3D-превью маски. Основной путь — настоящий WebGL-меш (three.js уже
  // подключён и работает на вкладке «Развёртка»): гладкая освещённая
  // поверхность, орбита, зум, клик-переход. Если THREE недоступен — падаем
  // на программный канвас-рендер (никогда не оставляем окно пустым).
  function makeRender3D(canvas, sizes, getMask, spacing, onEdit, onNavigate) {
    if (window.THREE) {
      try { return makeRender3DWebGL(canvas, sizes, getMask, spacing, onNavigate); }
      catch (e) { console.warn('[seg] WebGL 3D недоступен, запасной рендер:', e); }
    }
    return makeRender3DCanvas(canvas, sizes, getMask, spacing, onEdit, onNavigate);
  }

  // ═══════════════════════════════════════════════════════════
  // WebGL-рендер маски (three.js). Строит гладкий меш из маски
  // (Surface Nets + Taubin), тонирует «тканево», освещает и даёт
  // орбиту/зум/клик-переход. Клик по поверхности → перекрестье.
  // ═══════════════════════════════════════════════════════════
  function makeRender3DWebGL(canvas, sizes, getMask, spacing, onNavigate) {
    const THREE = window.THREE;
    const [X, Y, Z] = sizes;
    const sp = (spacing && spacing.length === 3) ? spacing : [1, 1, 1];

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(42, 1, 0.1, 100000);
    cam.up.set(0, 0, 1);   // z — вверх (superior), как в анатомии

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const d1 = new THREE.DirectionalLight(0xffffff, 0.75); d1.position.set(0.4, 0.9, 0.8); scene.add(d1);
    const d2 = new THREE.DirectionalLight(0xbfe0ff, 0.30); d2.position.set(-0.7, -0.5, 0.3); scene.add(d2);
    const d3 = new THREE.DirectionalLight(0xffe6c8, 0.16); d3.position.set(0.2, -0.6, -0.7); scene.add(d3); // тёплый ободок
    scene.add(new THREE.HemisphereLight(0xdaeaff, 0x2c3540, 0.45));

    // «Blue Bonnet» — благородный барвинково-васильковый синий вместо кораллового.
    // 3D-ячейка всегда на белом фоне (см. .seg-cell-3d), поэтому в обеих темах
    // берём достаточно насыщенный синий, чтобы он читался на белом.
    function meshColor() {
      const light = document.body.classList.contains('light-theme');
      return light ? 0x4a6fc0 : 0x5f82cf;
    }
    // цвет сеточки (wireframe поверх модели) — как на вкладке 1: глубже фона поверхности
    function wireColor() {
      const light = document.body.classList.contains('light-theme');
      return light ? 0x24407e : 0x2c4a92;
    }
    const mat = new THREE.MeshPhongMaterial({
      color: meshColor(), specular: 0x33405a, shininess: 20,
      side: THREE.DoubleSide, flatShading: false,
    });
    // тонкая «сеточка» по граням меша — помогает читать форму и ориентировать модель
    const wireMat = new THREE.LineBasicMaterial({ color: wireColor(), transparent: true, opacity: 0.08 });

    const group = new THREE.Group(); scene.add(group);
    let mesh = null, wire = null, grid = null, fitted = false;
    const orbTarget = new THREE.Vector3();
    const fitOffset = new THREE.Vector3();   // разовая поправка центрирования; применяется при каждой пересборке
    let orbDist = 100, theta = Math.PI * 0.35 - Math.PI / 2, phi = Math.PI * 0.40;   // ориентация как на вкладке 1

    function updateCam() {
      const x = orbDist * Math.sin(phi) * Math.cos(theta);
      const y = orbDist * Math.sin(phi) * Math.sin(theta);
      const z = orbDist * Math.cos(phi);
      cam.position.set(orbTarget.x + x, orbTarget.y + y, orbTarget.z + z);
      cam.lookAt(orbTarget);
    }
    function _render() { try { renderer.render(scene, cam); } catch (_) {} }

    function resize() {
      const host = canvas.parentElement; if (!host) return;
      const r = host.getBoundingClientRect();
      const w = Math.max(2, Math.round(r.width)), h = Math.max(2, Math.round(r.height));
      renderer.setSize(w, h);
      cam.aspect = w / h; cam.updateProjectionMatrix();
      _render();
    }

    // Единое разрешение превью — всегда гладко, без «скачков» между кадрами.
    // Полное разрешение = максимально гладко; для скорости уменьшите PREVIEW_MAXDIM (напр. 110 → st=2).
    const PREVIEW_MAXDIM = Math.max(X, Y, Z);
    function buildGeom() {
      const m = getMask();
      const g = segMaskToMesh(m, [X, Y, Z], sp, PREVIEW_MAXDIM, { smooth: 'taubin', topology: 'smooth', anisoBlur: false, taubin: 3 });
      if (mesh) { group.remove(mesh); mesh.geometry.dispose(); mesh = null; }
      if (wire) { group.remove(wire); wire.geometry.dispose(); wire = null; }
      if (grid) { scene.remove(grid); try { grid.geometry.dispose(); } catch (_) {}
        try { Array.isArray(grid.material) ? grid.material.forEach((x) => x.dispose()) : grid.material.dispose(); } catch (_) {} grid = null; }
      if (!g || !g.nF) { _render(); return; }
      const geom = new THREE.BufferGeometry();
      const pos = new Float32Array(g.V.length); pos.set(g.V);
      const idx = new Uint32Array(g.F.length); idx.set(g.F);
      geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geom.setIndex(new THREE.BufferAttribute(idx, 1));
      geom.computeVertexNormals(); geom.computeBoundingBox();
      mesh = new THREE.Mesh(geom, mat); group.add(mesh);
      // сеточка по граням меша отключена для гладкого вида (чтобы вернуть — раскомментируйте)
      // wire = new THREE.LineSegments(new THREE.WireframeGeometry(geom), wireMat); group.add(wire);
      const bb = geom.boundingBox, c = bb.getCenter(new THREE.Vector3()), sz = bb.getSize(new THREE.Vector3());
      const maxDim = Math.max(sz.x, sz.y, sz.z, 1);
      // напольная сетка под моделью — задаёт «пол» и помогает понять наклон (как на вкладке 1)
      const light = document.body.classList.contains('light-theme');
      const gSize = Math.max(maxDim * 1.6, 20);
      grid = new THREE.GridHelper(gSize, 16, light ? 0x8fa3c0 : 0x9fb2cc, light ? 0xc2d0e2 : 0xd0dcec);
      grid.rotation.x = Math.PI / 2;                    // в плоскость XY (z — вверх)
      grid.position.set(c.x, c.y, bb.min.z - maxDim * 0.04);
      grid.material.opacity = 0.26; grid.material.transparent = true;
      scene.add(grid);
      orbTarget.copy(c);
      if (!fitted) {
        orbDist = maxDim * 0.8;
        cam.near = Math.max(maxDim * 0.001, 0.05); cam.far = maxDim * 200;
        cam.updateProjectionMatrix();
        // Точное центрирование силуэта в окне (без «магических» коэффициентов):
        // проецируем вершины текущей камерой, берём центр их экранного разброса
        // и запоминаем сдвиг цели камеры в fitOffset (применяется при каждой пересборке).
        const _hr = canvas.parentElement && canvas.parentElement.getBoundingClientRect();
        if (_hr && _hr.width && _hr.height) { cam.aspect = _hr.width / _hr.height; cam.updateProjectionMatrix(); }
        updateCam(); _render();                       // обновить матрицы камеры перед проекцией
        const _p = new THREE.Vector3();
        let nx0 = Infinity, nx1 = -Infinity, ny0 = Infinity, ny1 = -Infinity;
        for (let i = 0; i < pos.length; i += 3) {
          _p.set(pos[i], pos[i + 1], pos[i + 2]).project(cam);
          if (_p.x < nx0) nx0 = _p.x; if (_p.x > nx1) nx1 = _p.x;
          if (_p.y < ny0) ny0 = _p.y; if (_p.y > ny1) ny1 = _p.y;
        }
        const ndcCx = (nx0 + nx1) / 2, ndcCy = (ny0 + ny1) / 2;
        const halfH = orbDist * Math.tan(cam.fov * Math.PI / 360), halfW = halfH * cam.aspect;
        _fwd.subVectors(orbTarget, cam.position).normalize();
        _right.crossVectors(_fwd, cam.up).normalize();
        _up.crossVectors(_right, _fwd).normalize();
        fitOffset.set(0, 0, 0);
        fitOffset.addScaledVector(_right, ndcCx * halfW);
        fitOffset.addScaledVector(_up,    ndcCy * halfH);   // и по вертикали заодно
        fitted = true;
      }
      orbTarget.add(fitOffset);   // держим кадрирование стабильным и после пересборки меша
      updateCam(); _render();
    }

    // ── орбита / сдвиг (ПКМ или Shift) / зум / клик ──
    let mode = null, moved = false, downX = 0, downY = 0, lastX = 0, lastY = 0;
    let raycaster = null;
    const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _up = new THREE.Vector3();
    function onCtx(e) { e.preventDefault(); }   // не показывать меню по ПКМ — им двигаем модель
    function onDown(e) {
      if (e.button === 0 && !e.shiftKey) mode = 'orbit';
      else if (e.button === 2 || e.shiftKey) mode = 'pan';
      else return;
      moved = false; downX = lastX = e.clientX; downY = lastY = e.clientY; e.preventDefault();
    }
    function onMove(e) {
      if (!mode) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY; lastX = e.clientX; lastY = e.clientY;
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) moved = true;
      if (mode === 'orbit') {
        theta -= dx * 0.007;
        phi = Math.max(0.05, Math.min(Math.PI - 0.05, phi - dy * 0.007));
      } else {   // pan: тянем цель камеры в её экранной плоскости (как на вкладке 1)
        const r = canvas.getBoundingClientRect();
        const worldPerPx = (2 * orbDist * Math.tan(cam.fov * Math.PI / 360)) / Math.max(1, r.height);
        _fwd.subVectors(orbTarget, cam.position).normalize();
        _right.crossVectors(_fwd, cam.up).normalize();
        _up.crossVectors(_right, _fwd).normalize();
        orbTarget.addScaledVector(_right, -dx * worldPerPx);
        orbTarget.addScaledVector(_up,     dy * worldPerPx);
      }
      updateCam(); _render();
    }
    function onUp(e) { if (mode === 'orbit' && !moved) navigateAt(e.clientX, e.clientY); mode = null; }
    function onWheel(e) {
      e.preventDefault();
      const f = 1 + e.deltaY * 0.0012;
      orbDist = Math.max(1, Math.min(orbDist * 25, orbDist * f));
      updateCam(); _render();
    }
    function navigateAt(cx, cy) {
      if (!mesh || !onNavigate) return;
      const r = canvas.getBoundingClientRect();
      const nx = ((cx - r.left) / r.width) * 2 - 1, ny = -((cy - r.top) / r.height) * 2 + 1;
      if (!raycaster) raycaster = new THREE.Raycaster();
      raycaster.setFromCamera({ x: nx, y: ny }, cam);
      const hits = raycaster.intersectObject(mesh, false);
      if (!hits.length) return;
      const p = hits[0].point;
      const vx = Math.round(p.x / sp[0]), vy = Math.round(p.y / sp[1]), vz = Math.round(p.z / sp[2]);
      onNavigate({ x: Math.max(0, Math.min(X-1, vx)), y: Math.max(0, Math.min(Y-1, vy)), z: Math.max(0, Math.min(Z-1, vz)) });
    }

    canvas.addEventListener('mousedown', onDown);
    canvas.addEventListener('contextmenu', onCtx);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    // тема сменилась → перекрасить меш
    const themeObs = new MutationObserver(() => { mat.color.set(meshColor()); wireMat.color.set(wireColor()); _render(); });
    themeObs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    const ro = new ResizeObserver(() => resize());
    if (canvas.parentElement) ro.observe(canvas.parentElement);

    let rebTimer = null;
    function markDirty() { if (rebTimer) clearTimeout(rebTimer); rebTimer = setTimeout(buildGeom, 180); }

    buildGeom();
    resize();

    return {
      markDirty,
      onShow: resize,
      refresh: buildGeom,
      dispose() {
        if (rebTimer) clearTimeout(rebTimer);
        canvas.removeEventListener('mousedown', onDown);
        canvas.removeEventListener('contextmenu', onCtx);
        canvas.removeEventListener('wheel', onWheel);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        themeObs.disconnect(); ro.disconnect();
        if (mesh) { try { mesh.geometry.dispose(); } catch (_) {} }
        if (wire) { try { wire.geometry.dispose(); } catch (_) {} }
        if (grid) { try { grid.geometry.dispose(); } catch (_) {}
          try { Array.isArray(grid.material) ? grid.material.forEach((x) => x.dispose()) : grid.material.dispose(); } catch (_) {} }
        try { mat.dispose(); } catch (_) {}
        try { wireMat.dispose(); } catch (_) {}
        try { renderer.dispose(); } catch (_) {}
      },
    };
  }

  // ═══════════════════════════════════════════════════════════
  // 3D-рендер маски без WebGL: проекция поверхностных вокселей
  // круглыми перекрывающимися «каплями» с гладкими нормалями,
  // Z-буфером и бликом → гладкая поверхность. Надёжно рисует в любом
  // браузере; поддерживает вращение, клик-навигацию и лепку.
  // ═══════════════════════════════════════════════════════════
  function makeRender3DCanvas(canvas, sizes, getMask, spacing, onEdit, onNavigate) {
    const [X, Y, Z] = sizes, XY = X * Y;
    const sp = (spacing && spacing.length === 3) ? spacing : [1, 1, 1];
    const RES = 460;          // чёткий кадр
    const DRAG_RES = 300;     // во время вращения — мельче (быстрее)
    const ctx = canvas.getContext('2d');

    let yaw = 0.7 + Math.PI / 2, pitch = -0.35;   // +90° в плоскости XY (по часовой, вид со стороны +Z)
    let surf = null, center = [X / 2, Y / 2, Z / 2], fitScale = 1, stStep = 1;
    let dragging = false, editing = false, lx = 0, ly = 0, downX = 0, downY = 0, movedFar = false;
    let refreshTimer = null;
    let img = null, zbuf = null, pickbuf = null, curRES = 0;
    let lastFit = { scale: 1, ox: 0, oy: 0, dpr: 1, res: 0 };

    function ensureBuffers(res) {
      if (curRES === res && img) return;
      curRES = res;
      img = ctx.createImageData(res, res);
      zbuf = new Float32Array(res * res);
      pickbuf = new Int32Array(res * res);
    }

    function extractSurface() {
      const m = getMask();
      // ПОЛНОЕ разрешение (st=1): тонкая плёнка 1–2 вокселя не должна прореживаться,
      // иначе модель рвётся и появляются ложные «окна» (см. баг с обрезанной моделью).
      const mesh = segMaskToMesh(m, [X, Y, Z], sp, Math.max(X, Y, Z), { smooth: 'taubin' });   // превью: Taubin (без усадки, глаже)
      if (!mesh || !mesh.nF) { surf = null; return; }
      const V = mesh.V, F = mesh.F, nV = mesh.nV, nF = mesh.nF;
      let minx = 1e9, miny = 1e9, minz = 1e9, maxx = -1e9, maxy = -1e9, maxz = -1e9;
      for (let i = 0; i < nV; i++) { const x = V[3*i], y = V[3*i+1], z = V[3*i+2];
        if (x<minx)minx=x; if (y<miny)miny=y; if (z<minz)minz=z; if (x>maxx)maxx=x; if (y>maxy)maxy=y; if (z>maxz)maxz=z; }
      center = [(minx+maxx)/2, (miny+maxy)/2, (minz+maxz)/2];   // центр в мм
      const ex = maxx-minx, ey = maxy-miny, ez = maxz-minz;
      fitScale = (RES * 1.06) / Math.max(1e-3, ex, ey, ez);
      // нормали по вершинам (среднее нормалей примыкающих граней) → гладкое затенение
      const Nrm = new Float32Array(nV*3);
      for (let t = 0; t < nF; t++) { const a=F[3*t],b=F[3*t+1],c=F[3*t+2];
        const ax=V[3*a],ay=V[3*a+1],az=V[3*a+2],bx=V[3*b],by=V[3*b+1],bz=V[3*b+2],cx=V[3*c],cy=V[3*c+1],cz=V[3*c+2];
        const ux=bx-ax,uy=by-ay,uz=bz-az,vx=cx-ax,vy=cy-ay,vz=cz-az;
        const nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx;
        Nrm[3*a]+=nx;Nrm[3*a+1]+=ny;Nrm[3*a+2]+=nz; Nrm[3*b]+=nx;Nrm[3*b+1]+=ny;Nrm[3*b+2]+=nz; Nrm[3*c]+=nx;Nrm[3*c+1]+=ny;Nrm[3*c+2]+=nz; }
      for (let i = 0; i < nV; i++) { const l=Math.hypot(Nrm[3*i],Nrm[3*i+1],Nrm[3*i+2])||1; Nrm[3*i]/=l; Nrm[3*i+1]/=l; Nrm[3*i+2]/=l; }
      // воксель для клик-перехода (по центроиду треугольника)
      const triVi = new Int32Array(nF);
      for (let t = 0; t < nF; t++) { const a=F[3*t],b=F[3*t+1],c=F[3*t+2];
        const mx=(V[3*a]+V[3*b]+V[3*c])/3, my=(V[3*a+1]+V[3*b+1]+V[3*c+1])/3, mz=(V[3*a+2]+V[3*b+2]+V[3*c+2])/3;
        let vx=Math.round(mx/sp[0]), vy=Math.round(my/sp[1]), vz=Math.round(mz/sp[2]);
        vx=vx<0?0:vx>=X?X-1:vx; vy=vy<0?0:vy>=Y?Y-1:vy; vz=vz<0?0:vz>=Z?Z-1:vz;
        triVi[t]=vx+X*vy+XY*vz; }
      stStep = 1;
      surf = { V, F, nV, nF, Nrm, triVi, n: nF };
    }

    // world: up = +Z, поворот yaw затем pitch (как у срезов)
    function project(wx, wy, wz, cyaw, syaw, cpit, spit) {
      const x1 = wx * cyaw + wz * syaw;
      const z1 = -wx * syaw + wz * cyaw;
      const y1 = wy;
      return [x1, y1 * cpit - z1 * spit, y1 * spit + z1 * cpit];
    }

    function draw(res, ss) {
      ss = ss && ss > 1 ? (ss | 0) : 1;
      ensureBuffers(res);
      const data = img.data; data.fill(0); pickbuf.fill(-1);
      if (!surf || !surf.n) { zbuf.fill(-1e9); return; }
      const cyaw = Math.cos(yaw), syaw = Math.sin(yaw), cpit = Math.cos(pitch), spit = Math.sin(pitch);
      let Lx = -0.4, Ly = 0.5, Lz = 0.78; const Ll = Math.hypot(Lx, Ly, Lz); Lx/=Ll; Ly/=Ll; Lz/=Ll;
      const V = surf.V, nV = surf.nV, nF = surf.nF, F = surf.F, Nrm = surf.Nrm, triVi = surf.triVi;
      // освещение по нормали (диффуз + мягкий блик) — единая функция для пикселя
      function shade(nx, ny, nz, out, o) {
        let d = nx*Lx + ny*Ly + nz*Lz; if (d<0) d=-d; const lit = 0.30 + 0.70*d;
        let spc = 2*d*nz - Lz; if (spc<0) spc=0; const spec = Math.pow(spc,24)*0.35;
        out[o]   = Math.min(255, 70*lit  + 255*spec)|0;
        out[o+1] = Math.min(255, 130*lit + 255*spec)|0;
        out[o+2] = Math.min(255, 245*lit + 255*spec)|0;
        out[o+3] = 255;
      }
      // растеризация в разрешении R = res*ss; цвет — Phong (нормаль интерполируется по пикселю)
      const R = res * ss;
      const useScratch = ss > 1;
      const cbuf = useScratch ? new Uint8ClampedArray(R*R*4) : data;
      const zb   = useScratch ? new Float32Array(R*R).fill(-1e9) : (zbuf.fill(-1e9), zbuf);
      const pb   = useScratch ? new Int32Array(R*R).fill(-1)     : pickbuf;
      const scale = fitScale * (R / RES);
      const cxs = R/2, cys = R/2;
      const SX = new Float32Array(nV), SY = new Float32Array(nV), DP = new Float32Array(nV), VN = new Float32Array(nV*3);
      for (let i = 0; i < nV; i++) {
        const wx = (V[3*i]   - center[0]) * scale;
        const wy = (V[3*i+2] - center[2]) * scale;   // up
        const wz = (V[3*i+1] - center[1]) * scale;
        const p = project(wx, wy, wz, cyaw, syaw, cpit, spit);
        SX[i] = cxs + p[0]; SY[i] = cys - p[1]; DP[i] = p[2];
        const np = project(Nrm[3*i], Nrm[3*i+2], Nrm[3*i+1], cyaw, syaw, cpit, spit);
        const nl = Math.hypot(np[0], np[1], np[2]) || 1; VN[3*i]=np[0]/nl; VN[3*i+1]=np[1]/nl; VN[3*i+2]=np[2]/nl;
      }
      for (let t = 0; t < nF; t++) {
        const a=F[3*t],b=F[3*t+1],c=F[3*t+2];
        const ax=SX[a],ay=SY[a],bx=SX[b],by=SY[b],cx=SX[c],cy=SY[c];
        let minX=Math.floor(Math.min(ax,bx,cx)), maxX=Math.ceil(Math.max(ax,bx,cx));
        let minY=Math.floor(Math.min(ay,by,cy)), maxY=Math.ceil(Math.max(ay,by,cy));
        if (minX<0)minX=0; if (minY<0)minY=0; if (maxX>=R)maxX=R-1; if (maxY>=R)maxY=R-1;
        if (maxX<minX || maxY<minY) continue;
        const den=((by-cy)*(ax-cx)+(cx-bx)*(ay-cy)); if (Math.abs(den)<1e-9) continue;
        const na0=VN[3*a],na1=VN[3*a+1],na2=VN[3*a+2];
        const nb0=VN[3*b],nb1=VN[3*b+1],nb2=VN[3*b+2];
        const nc0=VN[3*c],nc1=VN[3*c+1],nc2=VN[3*c+2];
        const vi=triVi[t];
        for (let yy=minY; yy<=maxY; yy++) for (let xx=minX; xx<=maxX; xx++) {
          const w0=((by-cy)*(xx-cx)+(cx-bx)*(yy-cy))/den;
          const w1=((cy-ay)*(xx-cx)+(ax-cx)*(yy-cy))/den;
          const w2=1-w0-w1; if (w0<-0.001||w1<-0.001||w2<-0.001) continue;
          const depth=w0*DP[a]+w1*DP[b]+w2*DP[c]; const zi=yy*R+xx;
          if (depth<=zb[zi]) continue; zb[zi]=depth; pb[zi]=vi;
          // Phong: интерполируем нормаль по пикселю и нормируем
          let nx=w0*na0+w1*nb0+w2*nc0, ny=w0*na1+w1*nb1+w2*nc1, nz=w0*na2+w1*nb2+w2*nc2;
          const l=Math.hypot(nx,ny,nz)||1; nx/=l; ny/=l; nz/=l;
          shade(nx,ny,nz,cbuf,zi*4);
        }
      }
      if (useScratch) {
        // box-даунскейл цвета R→res; pickbuf — берём центральный субпиксель
        const k = ss*ss, half = (ss>>1);
        for (let y=0; y<res; y++) for (let x=0; x<res; x++) {
          let sr=0,sg=0,sb=0,sa=0;
          for (let dy=0; dy<ss; dy++) for (let dx=0; dx<ss; dx++) {
            const so=((y*ss+dy)*R + (x*ss+dx))*4; sr+=cbuf[so]; sg+=cbuf[so+1]; sb+=cbuf[so+2]; sa+=cbuf[so+3];
          }
          const o=(y*res+x)*4; data[o]=sr/k|0; data[o+1]=sg/k|0; data[o+2]=sb/k|0; data[o+3]=sa/k|0;
          pickbuf[y*res+x] = pb[(y*ss+half)*R + (x*ss+half)];
        }
      }
    }

    function render() {
      const r = canvas.parentElement.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(2, Math.floor(r.width * dpr)), h = Math.max(2, Math.floor(r.height * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      canvas.style.width = r.width + 'px'; canvas.style.height = r.height + 'px';
      const c = canvas.getContext('2d'); c.clearRect(0, 0, w, h);
      if (img && curRES) {
        const tmp = document.createElement('canvas'); tmp.width = curRES; tmp.height = curRES;
        tmp.getContext('2d').putImageData(img, 0, 0);
        const sc = Math.min(w / curRES, h / curRES), dw = curRES * sc, dh = curRES * sc;
        const ox = (w - dw) / 2, oy = (h - dh) / 2;
        lastFit = { scale: sc, ox, oy, dpr, res: curRES };
        c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
        c.drawImage(tmp, ox, oy, dw, dh);
      }
      if (!surf || !surf.n) {
        c.fillStyle = 'rgba(70,90,120,.75)';
        c.font = (14 * dpr) + "px 'Segoe UI', system-ui, sans-serif";
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText('Модель области появится здесь', w / 2, h / 2 - 10 * dpr);
        c.fillText('после загрузки/правки маски', w / 2, h / 2 + 12 * dpr);
      }
    }

    function pickVoxel(clientX, clientY) {
      if (!pickbuf || !curRES) return null;
      const r = canvas.getBoundingClientRect();
      const dpr = lastFit.dpr || (window.devicePixelRatio || 1);
      const cx = (clientX - r.left) * dpr, cy = (clientY - r.top) * dpr;
      const bx = Math.round((cx - lastFit.ox) / lastFit.scale), by = Math.round((cy - lastFit.oy) / lastFit.scale);
      for (let rad = 0; rad <= 5; rad++)
        for (let dy = -rad; dy <= rad; dy++)
          for (let dx = -rad; dx <= rad; dx++) {
            const xx = bx + dx, yy = by + dy;
            if (xx < 0 || yy < 0 || xx >= curRES || yy >= curRES) continue;
            const vi = pickbuf[yy * curRES + xx];
            if (vi >= 0) {
              const z = (vi / XY) | 0, rem = vi - z * XY, y = (rem / X) | 0, x = rem - y * X;
              return { x, y, z, vi };
            }
          }
      return null;
    }

    function refresh() { extractSurface(); draw(RES, 2); render(); }
    function redraw(res, ss) { draw(res || RES, ss); render(); }
    function markDirty() { if (refreshTimer) clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 160); }

    function onDown(e) {
      if ((e.shiftKey || e.button === 2) && onEdit) {
        editing = true; e.preventDefault();
        const v = pickVoxel(e.clientX, e.clientY); if (v) onEdit(v);
        return;
      }
      dragging = true; lx = e.clientX; ly = e.clientY;
      downX = e.clientX; downY = e.clientY; movedFar = false; e.preventDefault();
    }
    function onMove(e) {
      if (editing && onEdit) { const v = pickVoxel(e.clientX, e.clientY); if (v) onEdit(v); return; }
      if (!dragging) return;
      if (Math.abs(e.clientX - downX) > 3 || Math.abs(e.clientY - downY) > 3) movedFar = true;
      yaw += (e.clientX - lx) * 0.012;
      pitch += (e.clientY - ly) * 0.012;
      pitch = Math.max(-1.4, Math.min(1.4, pitch));
      lx = e.clientX; ly = e.clientY;
      redraw(DRAG_RES);
    }
    function onUp(e) {
      if (editing && onEdit) { onEdit(null); editing = false; dragging = false; return; }
      if (dragging && !movedFar && onNavigate && e) {
        const v = pickVoxel(e.clientX, e.clientY); if (v) onNavigate(v);
      }
      const wasRot = dragging && movedFar;
      dragging = false; editing = false;
      if (wasRot) redraw(RES, 2);
    }
    function onCtx(e) { e.preventDefault(); }

    canvas.addEventListener('mousedown', onDown);
    canvas.addEventListener('contextmenu', onCtx);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    const ro = new ResizeObserver(() => render());
    ro.observe(canvas.parentElement);

    refresh();

    return {
      markDirty, refresh, redraw,
      dispose() {
        if (refreshTimer) clearTimeout(refreshTimer);
        canvas.removeEventListener('mousedown', onDown);
        canvas.removeEventListener('contextmenu', onCtx);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        ro.disconnect();
      },
    };
  }

  const SliceEditor = (function () {

    function install(ctVol, maskVol) {
      const [X, Y, Z] = ctVol.sizes;
      const XY = X * Y;
      const mask = Uint8Array.from(maskVol.data); // копия (редактируемая)
      const initialMask = Uint8Array.from(mask);  // для «сброс к авто»

      const root = document.getElementById('segEditorRoot');
      root.innerHTML = [
        '<div class="seg-grid">',
          // верх-лево: аксиальный (редактируемый)
          '<div class="seg-cell seg-cell-ax">',
            '<span class="seg-cell-lbl">Аксиальный · <span class="seg-cell-hint">↕ колесо листает</span></span>',
            '<canvas id="segCanvas" class="seg-canvas"></canvas>',
          '</div>',
          // верх-право: сагиттальный (редактируемый)
          '<div class="seg-cell">',
            '<span class="seg-cell-lbl">Сагиттальный · <span class="seg-cell-hint">↕ колесо листает</span></span>',
            '<canvas id="segCanvasSag" class="seg-canvas"></canvas>',
          '</div>',
          // низ-лево: корональный (редактируемый)
          '<div class="seg-cell">',
            '<span class="seg-cell-lbl">Корональный · <span class="seg-cell-hint">↕ колесо листает</span></span>',
            '<canvas id="segCanvasCor" class="seg-canvas"></canvas>',
          '</div>',
          // низ-право: 3D-модель маски (авто-обновление при правке)
          '<div class="seg-cell seg-cell-3d" id="segCell3d">',
            '<span class="seg-cell-lbl">3D-модель · <span class="seg-cell-hint">тяните — поворот · ПКМ — сдвиг · колесо — зум · клик — место</span></span>',
            '<canvas id="seg3dCanvas" class="seg-3d-canvas"></canvas>',
          '</div>',
        '</div>',
        '<div class="seg-slicectl">',
          '<button type="button" class="seg-mini seg-nav" id="segPrev">◀</button>',
          '<input type="range" id="segSlice" class="seg-range" min="0" max="', (Z - 1), '" value="', (Z >> 1), '" style="--p:50%">',
          '<button type="button" class="seg-mini seg-nav" id="segNext">▶</button>',
          '<span class="seg-sliceidx" id="segSliceIdx"></span>',
          '<span class="seg-slicectl-right">',
            /* Кнопка «Сохранить пару (NRRD)» убрана: roi_ct и roi_mask
               входят в архив сессии, то есть обучающая пара сохраняется
               вместе со случаем и отдельной выгрузки не требует. */
          '</span>',
        '</div>',
      ].join('');

      const canvas = document.getElementById('segCanvas');
      const ctx = canvas.getContext('2d');
      const back = document.createElement('canvas'); // native-res срез
      back.width = X; back.height = Y;
      const bctx = back.getContext('2d');
      const imgData = bctx.createImageData(X, Y);
      // ортогональные обзорные холсты
      const sagCanvas = document.getElementById('segCanvasSag');
      const corCanvas = document.getElementById('segCanvasCor');

      const s = {
        ctVol, mask, initialMask, sizes: [X, Y, Z], XY,
        z: Z >> 1, cx: X >> 1, cy: Y >> 1,
        axis: 'axial',// позиция для корон./сагитт. срезов
        tool: 'mucosa', radius: 2, alpha: 0.55,
        interpAxes: [[], [], []],            // размеченные срезы по осям [акс(z), кор(y), саг(x)] для «Протянуть»
        spacing: (function () {
          const sd = ctVol.spaceDirections;
          const nrm = (v) => Array.isArray(v) ? (Math.hypot(v[0] || 0, v[1] || 0, v[2] || 0) || 1) : 1;
          return (Array.isArray(sd) && sd.length === 3) ? [nrm(sd[0]), nrm(sd[1]), nrm(sd[2])] : [1, 1, 1];
        })(),
        win: 1200, lvl: 350,                // окно КТ по умолчанию: контрастное (воздух чёрный, кость белая), мягкие ткани видны
        history: [], redo: [], dragging: false, lastPx: null, mode: null,
        // новые: привязка к ткани, скрибл-сиды, превью GrowCut, контур, лассо
        tissue: { on: false, lo: -350, hi: 500 },
        sFg: new Uint8Array(X * Y * Z), sBg: new Uint8Array(X * Y * Z),
        growPrev: null, growBox: null,
        contour: false, pencil: 'fg', lasso: null, pipetteArmed: false,
        fit: { scale: 1, ox: 0, oy: 0 },
        geom: { spaceDirections: ctVol.spaceDirections, spaceOrigin: ctVol.spaceOrigin, space: ctVol.space },
        canvas, ctx, back, bctx, imgData, sagCanvas, corCanvas,
      };

      // ── плоскости (как в Slicer): каждая редактируема ──
      // axial: фикс z, оси (x=col, y=row); coronal: фикс y, (x=col, z=row, голову вверх);
      // sagittal: фикс x, (y=col, z=row, голову вверх).
      s.planes = [
        { key: 'axial',    canvas: canvas,    fit: null },
        { key: 'coronal',  canvas: corCanvas, fit: null },
        { key: 'sagittal', canvas: sagCanvas, fit: null },
      ];

      // ─── разметка: кисть в ВОКСЕЛЬНОМ пространстве — след одинаков на любом окне ───
      // radius задаётся в вокселях; шар = сфера r вокселей (по всем осям),
      // плоско = диск r вокселей в текущей плоскости на её срезе.
      function planeAxis(key){ return key==='axial'?0 : key==='coronal'?1 : 2; }
      function markInterp(axis, idx){ const arr = s.interpAxes[axis]; if (arr.indexOf(idx) < 0) arr.push(idx); }
      function _paintVoxel(v, key, force3d, value){
        const [X, Y, Z] = s.sizes, XY = s.XY, d = s.ctVol.data, r = Math.max(1, s.radius|0);
        const ball = force3d || s.brush3d;
        const gateAir = s.useAir && value === 1;   // «не красить воздух» — только при добавлении
        const r2 = r * r;
        if (!ball) {
          // плоский диск r вокселей в плоскости key, на её текущем срезе
          const [w2d, h2d] = planeDims(key);
          const pp = voxelToPlane(key, v.x, v.y, v.z);
          for (let dr = -r; dr <= r; dr++) { const rr = pp.pr + dr; if (rr < 0 || rr >= h2d) continue;
            for (let dc = -r; dc <= r; dc++) { if (dc*dc + dr*dr > r2) continue; const cc = pp.pc + dc; if (cc < 0 || cc >= w2d) continue;
              const vv = planeToVoxel(key, cc, rr); const i = vv.x + X*vv.y + XY*vv.z;
              if (gateAir && d[i] <= s.airThr) continue; s.mask[i] = value; } }
          return;
        }
        // воксельная сфера радиусом r
        for (let dz = -r; dz <= r; dz++) { const z = v.z + dz; if (z < 0 || z >= Z) continue;
          for (let dy = -r; dy <= r; dy++) { const y = v.y + dy; if (y < 0 || y >= Y) continue;
            for (let dx = -r; dx <= r; dx++) { if (dx*dx + dy*dy + dz*dz > r2) continue; const x = v.x + dx; if (x < 0 || x >= X) continue;
              const i = x + X*y + XY*z; if (gateAir && d[i] <= s.airThr) continue; s.mask[i] = value; } } }
      }
      function applyMucosaAtVoxel(v, key, force3d){ _paintVoxel(v, key || 'axial', force3d, 1); }
      function applyEraserAtVoxel(v, key, force3d){ _paintVoxel(v, key || 'axial', force3d, 0); }
      // Убрать воздух из маски, если включена защита «не красить воздух». Возвращает число убранных вокселей.
      function stripAir(){
        if (!s.useAir) return 0;
        const a = LC.airMask(s.ctVol.data, s.airThr); let n = 0;
        for (let i = 0; i < s.mask.length; i++) if (a[i] && s.mask[i]) { s.mask[i] = 0; n++; }
        // reseal: снятие воздуха прокалывает тонкие стенки НАСКВОЗЬ → дыры-тоннели
        // (genus растёт, хотя поверхность остаётся watertight, и open_edges=0 их
        // не ловит). Морфозамыкание r=1 заращивает 1–2-воксельные проколы,
        // крупный просвет/полости при этом не трогает.
        if (n) s.mask.set(LC.close(s.mask, s._dims[0], s._dims[1], s._dims[2], 1));
        return n;
      }
      function closeFill(){ pushHistory();
        const orig = s.mask; const R = Math.max(1, s.radius|0);   // радиус = размер кисти (1–7)
        const m = LC.close(orig, s._dims[0],s._dims[1],s._dims[2], R);   // без защиты воздуха: окна бывают воздушные
        let added=0; for(let i=0;i<m.length;i++) if(m[i]&&!orig[i]) added++;
        s.mask.set(m);                                   // мост через воздушное окно СОХРАНЯЕМ (без stripAir)
        render(); if(s.r3d) s.r3d.markDirty(); updateVol();
        _toast(added ? ('Закрыто объёмно (R=' + R + '): +' + added + ' вокс')
                     : 'Закрывать нечего — область сплошная', added?'ok':'info', 3500); }
      function patchHoles(){ pushHistory();
        const orig = s.mask;
        // 1) замкнутые 3D-полости + один связный кусок
        const m2 = LC.fillHoles3D(LC.keepLargest(orig, s._dims[0],s._dims[1],s._dims[2]), s._dims[0],s._dims[1],s._dims[2]);
        // 2) мелкие замкнутые 2D-дырки на срезах (проколы), с лимитом площади — просвет не трогаем
        const m3 = Uint8Array.from(m2);
        LC.fill2DHolesAxial(m3, s._dims[0],s._dims[1],s._dims[2], 150);
        let added=0, removed=0; for(let i=0;i<m3.length;i++){ if(m3[i]&&!orig[i])added++; else if(!m3[i]&&orig[i])removed++; }
        s.mask.set(m3);
        const air = stripAir();                          // авто-очистка воздуха в конце
        render(); if(s.r3d) s.r3d.markDirty(); updateVol();
        if (added || removed || air) _toast('Залатано: закрыто ' + added + ' вокс, убрано кусков ' + removed + (air ? (', воздух \u2212' + air) : ''), 'ok', 3000);
        else _toast('Замкнутых дырок нет. Если это сквозное окно в плёнке — нажмите «Закрыть дыры» (для крупного окна увеличьте размер кисти).', 'info', 5500); }
      function cleanupNow(){ pushHistory();
        const orig = s.mask; let m = Uint8Array.from(orig); let air = 0;
        if (s.useAir){ const a = LC.airMask(s.ctVol.data, s.airThr); for(let i=0;i<m.length;i++) if(a[i]&&m[i]){ m[i]=0; air++; }
          m = LC.close(m, s._dims[0],s._dims[1],s._dims[2], 1);   // reseal проколов от снятого воздуха (см. stripAir)
        }
        m = LC.fillHoles3D(LC.keepLargest(m, s._dims[0],s._dims[1],s._dims[2]), s._dims[0],s._dims[1],s._dims[2]);
        let removed=0, added=0; for(let i=0;i<m.length;i++){ if(orig[i]&&!m[i])removed++; else if(!orig[i]&&m[i])added++; }
        s.mask.set(m); render(); if(s.r3d) s.r3d.markDirty(); updateVol();
        _toast((removed||added) ? ('Подчищено: убрано ' + removed + ' вокс (воздух ' + air + '), закрыто дырок ' + added)
                                : 'Уже чисто — убирать нечего', (removed||added)?'ok':'info', 3000); }
      (function initAnnot(){
        const ct=s.ctVol.data, Zd=s.sizes[2], Yd=s.sizes[1], Xd=s.sizes[0];
        s._dims=[Zd,Yd,Xd]; s._spE=[s.spacing[2],s.spacing[1],s.spacing[0]];
        s.useAir = true;            // защита от воздуха (по умолчанию вкл)
        s.brush3d = true;           // шар по умолчанию
        s.airThr = LC.airThreshold(ct);   // порог воздуха из самого КТ
        s.autoInitial = Uint8Array.from(s.mask);   // «вернуть как было» = маска модели как есть (без обстругивания)
      })();

      function planeDims(key) {
        const [X, Y, Z] = s.sizes;
        if (key === 'axial') return [X, Y];
        if (key === 'coronal') return [X, Z];
        return [Y, Z];                       // sagittal
      }
      function planeToVoxel(key, pc, pr) {
        const Z = s.sizes[2];
        if (key === 'axial')   return { x: pc, y: pr, z: s.z };
        if (key === 'coronal') return { x: pc, y: s.cy, z: (Z - 1 - pr) };
        return { x: s.cx, y: pc, z: (Z - 1 - pr) };   // sagittal
      }
      function voxelToPlane(key, x, y, z) {
        const Z = s.sizes[2];
        if (key === 'axial')   return { pc: x, pr: y };
        if (key === 'coronal') return { pc: x, pr: (Z - 1 - z) };
        return { pc: y, pr: (Z - 1 - z) };            // sagittal
      }

      function _grayMask(hu, isMask) {
        const lo = s.lvl - s.win / 2, span = s.win || 1;
        let g = ((hu - lo) / span) * 255; g = g < 0 ? 0 : g > 255 ? 255 : g;
        return isMask
          ? [Math.round(g * (1 - s.alpha) + 255 * s.alpha), Math.round(g * (1 - s.alpha)), Math.round(g * (1 - s.alpha))]
          : [g, g, g];
      }

      function renderPane(pane) {
        const cv = pane.canvas; if (!cv) return;
        const [X, Y, Z] = s.sizes, XY = s.XY, d = s.ctVol.data, m = s.mask;
        const [w2d, h2d] = planeDims(pane.key);
        const buf = new ImageData(w2d, h2d), p = buf.data;
        const lo = s.lvl - s.win / 2, span = s.win || 1, a = s.alpha;
        const sFg = s.sFg, sBg = s.sBg, prev = s.growPrev, contour = s.contour;
        const key = pane.key;
        for (let pr = 0; pr < h2d; pr++) {
          for (let pc = 0; pc < w2d; pc++) {
            const v = planeToVoxel(key, pc, pr);
            const vi = v.x + X * v.y + XY * v.z;
            let g = ((d[vi] - lo) / span) * 255; g = g < 0 ? 0 : g > 255 ? 255 : g;
            let R, G, B;
            if (sFg[vi]) { R = 60; G = 230; B = 90; }                 // 🟢 сид «слизистая»
            else if (sBg[vi]) { R = 70; G = 150; B = 255; }           // 🔵 сид «фон»
            else if (prev && prev[vi]) {                              // оранжевое превью GrowCut
              R = Math.round(g * .4 + 255 * .6); G = Math.round(g * .4 + 150 * .6); B = Math.round(g * .4);
            } else if (m[vi]) {
              let show = true;
              if (contour) {                                          // только обводка
                show = false;
                if (pc === 0 || pr === 0 || pc === w2d - 1 || pr === h2d - 1) show = true;
                else {
                  const n0 = planeToVoxel(key, pc + 1, pr), n1 = planeToVoxel(key, pc - 1, pr);
                  const n2 = planeToVoxel(key, pc, pr + 1), n3 = planeToVoxel(key, pc, pr - 1);
                  if (!m[n0.x + X * n0.y + XY * n0.z] || !m[n1.x + X * n1.y + XY * n1.z] ||
                      !m[n2.x + X * n2.y + XY * n2.z] || !m[n3.x + X * n3.y + XY * n3.z]) show = true;
                }
              }
              if (show) { R = Math.round(g * (1 - a) + 255 * a); G = Math.round(g * (1 - a)); B = Math.round(g * (1 - a)); }
              else { R = g; G = g; B = g; }
            } else { R = g; G = g; B = g; }
            const o = (pr * w2d + pc) * 4;
            p[o] = R; p[o + 1] = G; p[o + 2] = B; p[o + 3] = 255;
          }
        }
        // подгоняем размер холста под ячейку
        const dpr = window.devicePixelRatio || 1;
        const r = cv.parentElement.getBoundingClientRect();
        const w = Math.max(2, Math.floor(r.width * dpr));
        const h = Math.max(2, Math.floor(r.height * dpr));
        if (cv.width !== w) cv.width = w;
        if (cv.height !== h) cv.height = h;
        cv.style.width = r.width + 'px'; cv.style.height = r.height + 'px';
        const cx = cv.getContext('2d');
        const tmp = document.createElement('canvas'); tmp.width = w2d; tmp.height = h2d;
        tmp.getContext('2d').putImageData(buf, 0, 0);
        cx.clearRect(0, 0, w, h);
        const sc = Math.min(w / w2d, h / h2d);
        const dw = w2d * sc, dh = h2d * sc, ox = (w - dw) / 2, oy = (h - dh) / 2;
        cx.imageSmoothingEnabled = false;
        cx.drawImage(tmp, ox, oy, dw, dh);
        pane.fit = { scale: sc, ox, oy, w2d, h2d };
        // перекрестье текущей позиции — ярче и с тёмной подложкой для контраста
        const cur = voxelToPlane(pane.key, s.cx, s.cy, s.z);
        const lx = ox + (cur.pc + 0.5) * sc, ly = oy + (cur.pr + 0.5) * sc;
        const drawCross = (color, w) => {
          cx.strokeStyle = color; cx.lineWidth = w;
          cx.beginPath();
          cx.moveTo(lx, oy); cx.lineTo(lx, oy + dh);
          cx.moveTo(ox, ly); cx.lineTo(ox + dw, ly);
          cx.stroke();
        };
        drawCross('rgba(0,0,0,.55)', 3.5);          // тёмная окантовка
        drawCross('rgba(120,220,255,.95)', 1.5);    // яркая линия
        // петля лассо (на той плоскости, где её ведут)
        if (s.lasso && s.lasso.key === pane.key && s.lasso.pts.length) {
          cx.strokeStyle = 'rgba(255,210,90,.95)'; cx.lineWidth = 1.6;
          cx.setLineDash([5, 3]); cx.beginPath();
          s.lasso.pts.forEach((pt, i) => {
            const X0 = ox + (pt[0] + 0.5) * sc, Y0 = oy + (pt[1] + 0.5) * sc;
            if (i === 0) cx.moveTo(X0, Y0); else cx.lineTo(X0, Y0);
          });
          cx.stroke(); cx.setLineDash([]);
        }
      }

      function render() {
        s.planes.forEach(renderPane);
        const idx = document.getElementById('segSliceIdx');
        if (idx) idx.innerHTML = [
          ['axial',    'АКС', s.z  + 1, s.sizes[2]],
          ['coronal',  'КОР', s.cy + 1, s.sizes[1]],
          ['sagittal', 'САГ', s.cx + 1, s.sizes[0]],
        ].map(function (c) {
          return '<button type="button" class="seg-chip' + (s.axis === c[0] ? ' is-active' : '') +
            '" data-axis="' + c[0] + '" title="Листать этот срез ползунком">' +
            '<span class="seg-chip-l">' + c[1] + '</span>' +
            '<span class="seg-chip-v"><b>' + c[2] + '</b><i>/' + c[3] + '</i></span></button>';
        }).join('');
      }
      function resize() { render(); }

      // событие мыши в окне → плоскостные коорд. (pc,pr) или null.
      // Геометрию letterbox считаем заново из текущего размера канваса,
      // чтобы клик всегда попадал точно (даже если панель/окно изменили размер).
      function eventToPlane(pane, clientX, clientY) {
        const cv = pane.canvas; if (!cv) return null;
        const r = cv.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return null;
        const [w2d, h2d] = planeDims(pane.key);
        const sc = Math.min(r.width / w2d, r.height / h2d);   // как в renderPane, но в CSS-px
        const ox = (r.width - w2d * sc) / 2, oy = (r.height - h2d * sc) / 2;
        const pc = Math.floor((clientX - r.left - ox) / sc);
        const pr = Math.floor((clientY - r.top - oy) / sc);
        if (pc < 0 || pr < 0 || pc >= w2d || pr >= h2d) return null;
        return { pc, pr };
      }

      function pushHistory() {
        s.history.push(Uint8Array.from(s.mask));
        if (s.history.length > 30) s.history.shift();
        s.redo.length = 0;   // новое действие отменяет возможность «Повторить»
      }

      // мазок: 2D-диск на текущем срезе ИЛИ 3D-сфера (затрагивает соседние срезы)
      // воксель попадает в окно плотности слизистой (для добавления кистью/заливкой)
      function inTissue(hu) { return !s.tissue.on || (hu >= s.tissue.lo && hu <= s.tissue.hi); }

      // пипетка: окно плотности ткани = HU под курсором ± допуск
      function pipette(v) {
        const hu = s.ctVol.data[v.x + s.sizes[0] * v.y + s.XY * v.z];
        const tol = 120;
        s.tissue.lo = Math.round(hu - tol); s.tissue.hi = Math.round(hu + tol);
        const lo = document.getElementById('segTissueLo'), hi = document.getElementById('segTissueHi');
        if (lo) lo.textContent = s.tissue.lo; if (hi) hi.textContent = s.tissue.hi;
        if (!s.tissue.on) { s.tissue.on = true; const c = document.getElementById('segTissueOn'); if (c) c.checked = true; }
        _toast('Диапазон ткани: ' + s.tissue.lo + '…' + s.tissue.hi + ' HU', 'ok', 2200);
      }

      // авто-подбор диапазона плотности ткани по уже размеченным вокселям
      // (чтобы кисть «понимала» слизистую без ручного ввода HU доктором)
      function calibrateTissue() {
        const d = s.ctVol.data, m = s.initialMask, vals = [];
        for (let i = 0; i < m.length; i++) if (m[i]) { const h = d[i]; if (h > -700 && h < 900) vals.push(h); }
        if (vals.length >= 50) {
          vals.sort((a, b) => a - b);
          const q = (p) => vals[Math.min(vals.length - 1, Math.max(0, Math.round(p * (vals.length - 1))))];
          // широкий запас, чтобы кисть рисовала на границе слизистая/воздух,
          // но не лезла в глубокий воздух и плотную кость
          let lo = q(0.02) - 150, hi = q(0.98) + 200;
          if (lo > -250) lo = -250; if (lo < -450) lo = -450;
          if (hi < 300)  hi = 300;  if (hi > 600)  hi = 600;
          s.tissue.lo = Math.round(lo); s.tissue.hi = Math.round(hi);
        } else { s.tissue.lo = -350; s.tissue.hi = 500; }
        const lo = document.getElementById('segTissueLo'), hi = document.getElementById('segTissueHi');
        if (lo) lo.textContent = s.tissue.lo; if (hi) hi.textContent = s.tissue.hi;
      }

      // «Залить по порогу»: от воксели-семени растим связную область, где КТ
      // близко по плотности (как Grow from seeds в Slicer). Ограничено радиусом.
      function fillThresholdAt(vx, vy, vz) {
        const [X, Y, Z] = s.sizes, XY = s.XY, d = s.ctVol.data, m = s.mask;
        const seed = vx + X * vy + XY * vz;
        const v0 = d[seed];
        const tol = 220;                                 // допуск HU (мягко)
        const maxR = Math.max(6, s.radius * 3);          // ограничение радиуса роста (вокс.)
        const maxR2 = maxR * maxR;
        pushHistory();
        const stack = [seed]; const seen = new Set([seed]); let added = 0;
        while (stack.length) {
          const i = stack.pop();
          const z = (i / XY) | 0, rem = i - z * XY, y = (rem / X) | 0, x = rem - y * X;
          const ddx = x - vx, ddy = y - vy, ddz = z - vz;
          if (ddx * ddx + ddy * ddy + ddz * ddz > maxR2) continue;
          if (Math.abs(d[i] - v0) > tol) continue;
          if (!m[i]) { m[i] = 1; added++; }
          const nb = [i + 1, i - 1, i + X, i - X, i + XY, i - XY];
          const ok = [x + 1 < X, x - 1 >= 0, y + 1 < Y, y - 1 >= 0, z + 1 < Z, z - 1 >= 0];
          for (let k = 0; k < 6; k++) {
            if (ok[k] && !seen.has(nb[k])) { seen.add(nb[k]); stack.push(nb[k]); }
          }
        }
        _toast('Залито по порогу: ' + added.toLocaleString('ru') + ' вокселей', 'ok', 2800);
        return added > 0;
      }

      // «Протянуть между срезами»: по каждой оси, где врач закрасил ≥2 среза,
      // морфим форму между ними (SDF + выравнивание по центроиду). Работает по
      // любому окну — аксиальному (z), корональному (y), сагиттальному (x).
      function runInterp() {
        const [X, Y, Z] = s.sizes, XY = s.XY, m = s.mask;
        const hasAx  = (k) => { for (let i = k*XY, e = i+XY; i < e; i++) if (m[i]) return true; return false; };
        const hasCor = (k) => { for (let z = 0; z < Z; z++){ const b = X*k + XY*z; for (let x = 0; x < X; x++) if (m[x+b]) return true; } return false; };
        const hasSag = (k) => { for (let z = 0; z < Z; z++){ const b = k + XY*z; for (let y = 0; y < Y; y++) if (m[b + X*y]) return true; } return false; };
        const uniq = (a) => [...new Set(a)];
        const plan = [
          [0, uniq(s.interpAxes[0]).filter(hasAx ).sort((a,b)=>a-b)],
          [1, uniq(s.interpAxes[1]).filter(hasCor).sort((a,b)=>a-b)],
          [2, uniq(s.interpAxes[2]).filter(hasSag).sort((a,b)=>a-b)],
        ].filter(([, ks]) => ks.length >= 2);
        if (!plan.length) {
          _toast('Закрасьте область кистью хотя бы на 2 срезах в ОДНОМ окне (листайте колесом), затем «Протянуть». Работает по любому окну — аксиальному, корональному, сагиттальному.', 'info', 6500);
          return;
        }
        pushHistory();
        let filled = 0, gaps = 0;
        plan.forEach(([axis, ks]) => {
          for (let i = 0; i < ks.length - 1; i++) {
            if (ks[i+1] - ks[i] <= 1) continue;
            gaps++;
            filled += LC.sliceMorphAxis(m, s._dims[0], s._dims[1], s._dims[2], axis, ks[i], ks[i+1]);
          }
        });
        s.interpAxes = [[], [], []];
        const air = stripAir();                          // авто-очистка воздуха в конце
        render(); if (s.r3d) s.r3d.markDirty(); updateVol();
        _toast(gaps ? ('Протянуто через ' + gaps + ' промежут.: +' + filled.toLocaleString('ru') + ' вокс' + (air ? (', воздух \u2212' + air) : ''))
                    : 'Между размеченными срезами нет пропусков — заполнять нечего', gaps ? 'ok' : 'info', 3800);
      }

      // ── Скрибл-достройка (Fast GrowCut на боксе вокруг штрихов) ──
      function _boxOfSeeds(margin) {
        const [X, Y, Z] = s.sizes, XY = s.XY;
        let any = false, x0 = X, y0 = Y, z0 = Z, x1 = -1, y1 = -1, z1 = -1;
        const scan = (arr) => {
          for (let i = 0; i < arr.length; i++) {
            if (!arr[i]) continue;
            any = true;
            const z = (i / XY) | 0, rem = i - z * XY, y = (rem / X) | 0, x = rem - y * X;
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
            if (z < z0) z0 = z; if (z > z1) z1 = z;
          }
        };
        scan(s.sFg); scan(s.sBg);
        if (!any) return null;
        const m = margin | 0;
        return {
          x0: Math.max(0, x0 - m), y0: Math.max(0, y0 - m), z0: Math.max(0, z0 - m),
          x1: Math.min(X - 1, x1 + m), y1: Math.min(Y - 1, y1 + m), z1: Math.min(Z - 1, z1 + m),
        };
      }

      function runGrowCut() {
        const box = _boxOfSeeds(12);
        if (!box) { _toast('Сначала проведите штрихи 🟢 «слизистая» и 🔵 «фон»', 'info', 3800); return; }
        let hasFg = false; for (let i = 0; i < s.sFg.length; i++) if (s.sFg[i]) { hasFg = true; break; }
        if (!hasFg) { _toast('Нужны штрихи 🟢 «слизистая»', 'info', 3500); return; }
        const [X, Y, Z] = s.sizes, XY = s.XY, d = s.ctVol.data;
        const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1, bd = box.z1 - box.z0 + 1;
        const n = bw * bh * bd;
        const lbl = new Uint8Array(n), str = new Float32Array(n), feat = new Float32Array(n);
        const at = (x, y, z) => (x - box.x0) + bw * (y - box.y0) + bw * bh * (z - box.z0);
        let huLo = Infinity, huHi = -Infinity;
        for (let z = box.z0; z <= box.z1; z++)
          for (let y = box.y0; y <= box.y1; y++)
            for (let x = box.x0; x <= box.x1; x++) {
              const gi = x + X * y + XY * z, bi = at(x, y, z), hu = d[gi];
              feat[bi] = hu; if (hu < huLo) huLo = hu; if (hu > huHi) huHi = hu;
              if (s.sFg[gi]) { lbl[bi] = 1; str[bi] = 1; }
              else if (s.sBg[gi]) { lbl[bi] = 2; str[bi] = 1; }
              else if (s.tissue.on && !inTissue(hu)) { lbl[bi] = 2; str[bi] = 0.6; }  // кость/воздух = барьер
            }
        const SC = 1 / Math.max(1, huHi - huLo);
        const NB = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
        const lbl2 = Uint8Array.from(lbl), str2 = Float32Array.from(str);
        const maxIt = Math.min(28, bw + bh + bd);
        for (let it = 0; it < maxIt; it++) {
          let changed = false;
          for (let z = box.z0; z <= box.z1; z++)
            for (let y = box.y0; y <= box.y1; y++)
              for (let x = box.x0; x <= box.x1; x++) {
                const bi = at(x, y, z);
                let bestL = lbl[bi], bestS = str[bi];
                for (let k = 0; k < 6; k++) {
                  const nx = x + NB[k][0], ny = y + NB[k][1], nz = z + NB[k][2];
                  if (nx < box.x0 || nx > box.x1 || ny < box.y0 || ny > box.y1 || nz < box.z0 || nz > box.z1) continue;
                  const ni = at(nx, ny, nz);
                  if (!lbl[ni]) continue;
                  const g = 1 - Math.min(1, Math.abs(feat[bi] - feat[ni]) * SC);   // схожесть плотности
                  const attack = str[ni] * g;
                  if (attack > bestS) { bestS = attack; bestL = lbl[ni]; }
                }
                if (bestL !== lbl[bi] || bestS !== str[bi]) changed = true;
                lbl2[bi] = bestL; str2[bi] = bestS;
              }
          lbl.set(lbl2); str.set(str2);
          if (!changed) break;
        }
        if (!s.growPrev) s.growPrev = new Uint8Array(s.mask.length); else s.growPrev.fill(0);
        let cnt = 0;
        for (let z = box.z0; z <= box.z1; z++)
          for (let y = box.y0; y <= box.y1; y++)
            for (let x = box.x0; x <= box.x1; x++)
              if (lbl[at(x, y, z)] === 1) { s.growPrev[x + X * y + XY * z] = 1; cnt++; }
        s.growBox = box;
        render();
        const row = document.getElementById('segGrowApplyRow'); if (row) row.style.display = 'flex';
        _toast('Предпросмотр (оранжевым). «Применить» — записать, либо добавьте штрихи и «Достроить» снова.', 'ok', 5000);
      }

      function growApply() {
        if (!s.growPrev || !s.growBox) { _toast('Сначала «Достроить»', 'info', 2500); return; }
        pushHistory();
        const b = s.growBox, [X, Y, Z] = s.sizes, XY = s.XY;
        for (let z = b.z0; z <= b.z1; z++)
          for (let y = b.y0; y <= b.y1; y++)
            for (let x = b.x0; x <= b.x1; x++) {
              const i = x + X * y + XY * z; s.mask[i] = s.growPrev[i] ? 1 : 0;
            }
        growCancel(true); growClear(true);
        render(); if (s.r3d) s.r3d.markDirty(); updateVol();
        _toast('Область перестроена по подсказкам.', 'ok', 2600);
      }
      function growCancel(silent) {
        s.growPrev = null; s.growBox = null;
        const row = document.getElementById('segGrowApplyRow'); if (row) row.style.display = 'none';
        if (!silent) render();
      }
      function growClear(silent) {
        if (s.sFg) s.sFg.fill(0); if (s.sBg) s.sBg.fill(0);
        if (!silent) render();
      }

      // ── Сглаживание маски: 3D-голосование 3×3×3 (убирает «лесенку») ──
      function smoothMask() {
        let nz = 0; for (let i = 0; i < s.mask.length; i++) if (s.mask[i]) { nz = 1; break; }
        if (!nz) { _toast('Маска пустая — нечего сглаживать', 'info', 2500); return; }
        pushHistory();
        const [X, Y, Z] = s.sizes, XY = s.XY, m = s.mask, out = new Uint8Array(m.length);
        for (let z = 0; z < Z; z++)
          for (let y = 0; y < Y; y++)
            for (let x = 0; x < X; x++) {
              let c = 0, t = 0;
              for (let dz = -1; dz <= 1; dz++) { const zz = z + dz; if (zz < 0 || zz >= Z) continue;
                for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= Y) continue;
                  for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= X) continue;
                    t++; if (m[xx + X * yy + XY * zz]) c++; } } }
              out[x + X * y + XY * z] = (c * 2 > t) ? 1 : 0;
            }
        s.mask = out;
        render(); if (s.r3d) s.r3d.markDirty(); updateVol();
        _toast('Маска сглажена.', 'ok', 2200);
      }

      // ── Лассо: обвёл петлю на срезе → вырезает насквозь по оси этой плоскости ──
      function applyLasso() {
        const L = s.lasso; s.lasso = null;
        if (!L || L.pts.length < 3) { render(); return; }
        pushHistory();
        const key = L.key, [X, Y, Z] = s.sizes, XY = s.XY;
        const [w2d, h2d] = planeDims(key);
        const depth = key === 'axial' ? Z : key === 'coronal' ? Y : X;
        const pts = L.pts;
        const inside = (px, py) => {
          let c = false;
          for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
            if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / ((yj - yi) || 1e-9) + xi)) c = !c;
          }
          return c;
        };
        let pc0 = w2d, pr0 = h2d, pc1 = 0, pr1 = 0;
        pts.forEach((pt) => { if (pt[0] < pc0) pc0 = pt[0]; if (pt[0] > pc1) pc1 = pt[0]; if (pt[1] < pr0) pr0 = pt[1]; if (pt[1] > pr1) pr1 = pt[1]; });
        pc0 = Math.max(0, pc0 | 0); pr0 = Math.max(0, pr0 | 0);
        pc1 = Math.min(w2d - 1, pc1 | 0); pr1 = Math.min(h2d - 1, pr1 | 0);
        let removed = 0;
        for (let pr = pr0; pr <= pr1; pr++)
          for (let pc = pc0; pc <= pc1; pc++) {
            if (!inside(pc + 0.5, pr + 0.5)) continue;
            for (let dpt = 0; dpt < depth; dpt++) {
              let xi, yi, zi;
              if (key === 'axial') { xi = pc; yi = pr; zi = dpt; }
              else if (key === 'coronal') { xi = pc; yi = dpt; zi = Z - 1 - pr; }
              else { xi = dpt; yi = pc; zi = Z - 1 - pr; }
              const i = xi + X * yi + XY * zi;
              if (s.mask[i]) { s.mask[i] = 0; removed++; }
            }
          }
        render(); if (s.r3d) s.r3d.markDirty(); updateVol();
        _toast(removed ? ('Лассо: вырезано насквозь ' + removed.toLocaleString('ru') + ' вокс.') : 'Внутри петли красного не было', removed ? 'ok' : 'info', 3000);
      }

      // 3D flood-remove связного куска (6-связность) от воксели-семени
      // «Оставить только» — щелчок по нужной полости: убираем все прочие
      // несвязанные с ней красные куски, оставляем выбранную область.
      function keepOnlyAt(vx, vy, vz) {
        const [X, Y, Z] = s.sizes, XY = s.XY, m = s.mask;
        const idx0 = vx + X * vy + XY * vz;
        if (!m[idx0]) { _toast('Щёлкните по красной области, которую нужно оставить', 'info', 2800); return false; }
        pushHistory();
        const keep = new Uint8Array(m.length);
        const stack = [idx0]; keep[idx0] = 1;
        while (stack.length) {
          const i = stack.pop();
          const z = (i / XY) | 0, rem = i - z * XY, y = (rem / X) | 0, x = rem - y * X;
          if (x + 1 < X && m[i + 1]   && !keep[i + 1])  { keep[i + 1] = 1;  stack.push(i + 1); }
          if (x - 1 >= 0 && m[i - 1]   && !keep[i - 1])  { keep[i - 1] = 1;  stack.push(i - 1); }
          if (y + 1 < Y && m[i + X]   && !keep[i + X])  { keep[i + X] = 1;  stack.push(i + X); }
          if (y - 1 >= 0 && m[i - X]   && !keep[i - X])  { keep[i - X] = 1;  stack.push(i - X); }
          if (z + 1 < Z && m[i + XY]  && !keep[i + XY]) { keep[i + XY] = 1; stack.push(i + XY); }
          if (z - 1 >= 0 && m[i - XY]  && !keep[i - XY]) { keep[i - XY] = 1; stack.push(i - XY); }
        }
        let removed = 0;
        for (let i = 0; i < m.length; i++) { if (m[i] && !keep[i]) { m[i] = 0; removed++; } }
        _toast(removed ? ('Оставлена выбранная область, убрано лишнего: ' + removed.toLocaleString('ru') + ' вокс.')
                       : 'Здесь всё уже единым куском — убирать нечего', removed ? 'ok' : 'info', 3000);
        return true;
      }

      function scissorsAt(vx, vy, vz) {
        const [X, Y, Z] = s.sizes, XY = s.XY, m = s.mask;
        const idx0 = vx + X * vy + XY * vz;
        if (!m[idx0]) { _toast('Здесь нет красной области — кликните по лишнему пятну', 'info', 2500); return false; }
        // сначала измеряем размер связного куска и всей маски, не трогая её
        let total = 0; for (let i = 0; i < m.length; i++) if (m[i]) total++;
        const seen = new Uint8Array(m.length);
        let comp = 1; seen[idx0] = 1; const cstack = [idx0];
        while (cstack.length) {
          const i = cstack.pop();
          const z = (i / XY) | 0, rem = i - z * XY, y = (rem / X) | 0, x = rem - y * X;
          const nb = [];
          if (x + 1 < X) nb.push(i + 1); if (x - 1 >= 0) nb.push(i - 1);
          if (y + 1 < Y) nb.push(i + X); if (y - 1 >= 0) nb.push(i - X);
          if (z + 1 < Z) nb.push(i + XY); if (z - 1 >= 0) nb.push(i - XY);
          for (const j of nb) if (m[j] && !seen[j]) { seen[j] = 1; comp++; cstack.push(j); }
        }
        if (total > 200 && comp >= 0.85 * total) {
          _toast('Это основная область, а не отдельный кусок. Чтобы убрать край — Ластиком.', 'info', 4000);
          return false;
        }
        pushHistory();
        for (let i = 0; i < m.length; i++) if (seen[i]) m[i] = 0;
        _toast('Убран кусок: ' + comp.toLocaleString('ru') + ' вокс.', 'ok', 2600);
        return true;
      }

      // интерполяция мазка между точками в плоскостных коорд.
      function strokeTo(key, pc, pr) {
        const painting = (s.tool !== 'eraser');
        const apply = (vx)=>{ if (s.tool==='eraser') applyEraserAtVoxel(vx, key); else applyMucosaAtVoxel(vx, key); };
        if (s.lastPx && s.lastPx.key === key) {
          const dc = pc - s.lastPx.pc, dr = pr - s.lastPx.pr;
          const steps = Math.max(1, Math.ceil(Math.hypot(dc, dr) / Math.max(1, s.radius / 2)));
          for (let t = 1; t <= steps; t++)
            apply(planeToVoxel(key, Math.round(s.lastPx.pc + dc*t/steps), Math.round(s.lastPx.pr + dr*t/steps)));
        } else { apply(planeToVoxel(key, pc, pr)); }
        s.lastPx = { key, pc, pr };
        // «Протянуть» запоминает срезы, закрашенные кистью, по оси активного окна.
        if (painting) {
          if (key === 'axial') markInterp(0, s.z);
          else if (key === 'coronal') markInterp(1, s.cy);
          else markInterp(2, s.cx);
        }
      }

      // синхронизировать перекрестье по воксели
      function setCrosshairVoxel(v) {
        const [X, Y, Z] = s.sizes;
        s.cx = Math.max(0, Math.min(X - 1, v.x));
        s.cy = Math.max(0, Math.min(Y - 1, v.y));
        s.z  = Math.max(0, Math.min(Z - 1, v.z));
        syncSlider();
      }


      // ─── обработчики ввода (на каждое окно) — кисть/ластик ───
      function onDown(pane, e) {
        if (e.button !== 0) return;
        const pp = eventToPlane(pane, e.clientX, e.clientY); if (!pp) return;
        e.preventDefault();
        const v = planeToVoxel(pane.key, pp.pc, pp.pr);
        setCrosshairVoxel(v);
        pushHistory();
        s.dragging = pane.key; s.lastPx = null; s.mode = 'paint';
        strokeTo(pane.key, pp.pc, pp.pr); render();
      }
      function onMove(e) {
        if (!s.dragging) return;
        const pane = s.planes.find((p) => p.key === s.dragging); if (!pane) return;
        const pp = eventToPlane(pane, e.clientX, e.clientY); if (!pp) return;
        strokeTo(pane.key, pp.pc, pp.pr);
        const v = planeToVoxel(pane.key, pp.pc, pp.pr); setCrosshairVoxel(v);
        render();
        if (s.r3d) s.r3d.markDirty();
      }
      function onUp() {
        s.dragging = false; s.lastPx = null; s.mode = null;
        if (s.r3d) s.r3d.markDirty(); updateVol();
      }
      function onWheel(pane, e) {
        e.preventDefault();
        const dir = e.deltaY > 0 ? 1 : -1;
        const [X, Y, Z] = s.sizes;
        if (pane.key === 'axial')   s.z  = Math.max(0, Math.min(Z - 1, s.z + dir));
        else if (pane.key === 'coronal') s.cy = Math.max(0, Math.min(Y - 1, s.cy + dir));
        else s.cx = Math.max(0, Math.min(X - 1, s.cx + dir));
        s.axis = pane.key;   // прокрутили окно — оно стало активным
        syncSlider();
        render();
      }

      function onKey(e) {
        const k = e.key.toLowerCase();
        if ((e.ctrlKey || e.metaKey) && k === 'z' && e.shiftKey) { e.preventDefault(); redo(); return; }
        if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); undo(); return; }
        if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
        if (e.key === '[') { setSlice(AXIS[s.axis].get() - 1); return; }
        if (e.key === ']') { setSlice(AXIS[s.axis].get() + 1); return; }
        // быстрый выбор инструмента (если не печатают в поле)
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const ae = document.activeElement;
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
        const map = { b: 'mucosa', e: 'eraser' };
        if (map[k]) { setActiveTool(map[k]); }
      }

      const AXIS = {
        axial:    { dim: 2, get: () => s.z,  set: (v) => { s.z  = v; } },
        coronal:  { dim: 1, get: () => s.cy, set: (v) => { s.cy = v; } },
        sagittal: { dim: 0, get: () => s.cx, set: (v) => { s.cx = v; } },
      };
      const axLen = () => s.sizes[AXIS[s.axis].dim];

      function syncSlider() {
        const sl = document.getElementById('segSlice');
        if (!sl) return;
        const n = axLen(), v = AXIS[s.axis].get();
        sl.max = n - 1;
        sl.value = v;
        sl.style.setProperty('--p', (n > 1 ? v / (n - 1) * 100 : 0) + '%');
      }

      function setAxis(axis) {
        if (!AXIS[axis] || s.axis === axis) return;
        s.axis = axis;
        syncSlider();
        render();
      }

      function setSlice(v) {
        const n = axLen();
        AXIS[s.axis].set(v < 0 ? 0 : v >= n ? n - 1 : v);
        syncSlider();
        render();
      }


      function undo() {
        if (!s.history.length) { _toast('Нечего отменять', 'info', 1800); return; }
        s.redo.push(Uint8Array.from(s.mask));
        if (s.redo.length > 30) s.redo.shift();
        s.mask = s.history.pop(); render(); if (s.r3d) s.r3d.markDirty(); updateVol();
      }
      function redo() {
        if (!s.redo.length) { _toast('Нечего повторять', 'info', 1800); return; }
        s.history.push(Uint8Array.from(s.mask));
        if (s.history.length > 30) s.history.shift();
        s.mask = s.redo.pop(); render(); if (s.r3d) s.r3d.markDirty(); updateVol();
      }

      // wiring слайдера (активная ось) + кнопок
      const sl = document.getElementById('segSlice');
      const prev = document.getElementById('segPrev');
      const next = document.getElementById('segNext');
      if (sl) sl.addEventListener('input', () => setSlice(+sl.value));
      if (prev) prev.addEventListener('click', () => setSlice(AXIS[s.axis].get() - 1));
      if (next) next.addEventListener('click', () => setSlice(AXIS[s.axis].get() + 1));

      // счётчики перерисовываются каждым render(), поэтому слушаем родителя
      const idxBar = document.getElementById('segSliceIdx');
      if (idxBar) idxBar.addEventListener('click', (e) => {
        const b = e.target.closest('[data-axis]');
        if (b) setAxis(b.dataset.axis);
      });
      syncSlider();

      // навешиваем мышь/колесо на каждое из трёх окон
      const _downHandlers = [];
      // кружок-предпросмотр кисти под курсором (точность: видно, что закрасит)
      const brushCur = document.createElement('div');
      brushCur.className = 'seg-brush-cursor';
      brushCur.style.display = 'none';
      document.body.appendChild(brushCur);
      s._brushCur = brushCur;
      function showBrushCursor(pane, e) {
        if (s.tool !== 'mucosa' && s.tool !== 'eraser') { brushCur.style.display = 'none'; return; }
        const cv = pane.canvas, r = cv.getBoundingClientRect();
        const [w2d, h2d] = planeDims(pane.key);
        const sc = Math.min(r.width / w2d, r.height / h2d);
        const dia = Math.max(4, 2 * s.radius * sc);
        brushCur.style.width = dia + 'px'; brushCur.style.height = dia + 'px';
        brushCur.style.left = e.clientX + 'px'; brushCur.style.top = e.clientY + 'px';
        brushCur.style.borderColor = (s.tool === 'eraser') ? 'rgba(255,120,120,.9)' : 'rgba(120,220,255,.9)';
        brushCur.style.display = 'block';
      }

      s.planes.forEach((pane) => {
        if (!pane.canvas) return;
        const dh = (e) => onDown(pane, e);
        const wh = (e) => onWheel(pane, e);
        const mh = (e) => showBrushCursor(pane, e);
        const lv = () => { brushCur.style.display = 'none'; };
        pane.canvas.addEventListener('mousedown', dh);
        pane.canvas.addEventListener('wheel', wh, { passive: false });
        pane.canvas.addEventListener('mousemove', mh);
        pane.canvas.addEventListener('mouseleave', lv);
        _downHandlers.push([pane.canvas, dh, wh, mh, lv]);
      });
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      window.addEventListener('keydown', onKey);
      const ro = new ResizeObserver(() => resize());
      ro.observe(root.parentElement);

      // двойной щелчок по окну — развернуть его на всю область (и обратно)
      const segGrid = root.querySelector('.seg-grid');
      if (segGrid) {
        segGrid.addEventListener('dblclick', (e) => {
          const cell = e.target.closest('.seg-cell'); if (!cell) return;
          const wasMax = cell.classList.contains('is-max');
          segGrid.querySelectorAll('.seg-cell').forEach((c) => c.classList.remove('is-max'));
          segGrid.classList.toggle('seg-maxed', !wasMax);
          if (!wasMax) cell.classList.add('is-max');
          setTimeout(() => { resize(); if (s.r3d && s.r3d.markDirty) s.r3d.markDirty(); }, 60);
        });
      }

      const _toolHints = {
        brush:    'Зажмите и ведите по срезу — добавляете красное ровно под кистью. Размер — ползунком ниже.',
        eraser:   'Зажмите и ведите — стираете красное под кистью.',
        fill:     'Клик по тканевому пятну, которое программа пропустила — зальётся по похожей плотности.',
        scribble: 'Отметьте 🟢 «слизистую» и 🔵 «фон», затем «Дорисовать» — область заполнится по плотности ткани.',
        keep:     'Клик по нужной области — все прочие отдельные куски удалятся, останется только она.',
        scissors: 'Клик по лишнему отдельному пятну — оно удалится целиком, во всём объёме.',
        lasso:    'Обведите петлю на срезе — всё внутри вырежется насквозь.',
        interp:   'Обведите область на 2–3 срезах (листая колесом), затем нажмите ещё раз — промежуточные заполнятся.',
      };
      const _toolMeta = {
        mucosa: { cursor: 'crosshair', hint: 'Кисть: зажмите и ведите по срезу — добавляете красное ровно под кистью. Размер и форма (шар/плоско) — ниже.' },
        eraser: { cursor: 'crosshair', hint: 'Ластик: зажмите и ведите — стираете красное под кистью.' },
      };
      function setActiveTool(t) {
        if (!_toolMeta[t]) t = 'mucosa';
        s.tool = t;
        s.lasso = null;
        document.querySelectorAll('[data-segtool]').forEach((b) =>
          b.classList.toggle('active', b.dataset.segtool === t));
        const meta = _toolMeta[t];
        s.planes.forEach((p) => { if (p.canvas) p.canvas.style.cursor = meta.cursor; });
        const hint = document.getElementById('segToolHint');
        if (hint) hint.textContent = meta.hint;
        // блок «размер/форма/воздух» подсвечиваем только для кисти/ластика
        const bb = document.getElementById('segBrushBlock');
        if (bb) bb.classList.toggle('seg-dim', t !== 'mucosa' && t !== 'eraser');
      }

      // объём выделенного в мл (доверие: видно, что результат осмысленный)
      function updateVol() {
        const el = document.getElementById('segVolMl');
        if (!el) return;
        let n = 0; const m = s.mask; for (let i = 0; i < m.length; i++) if (m[i]) n++;
        const sp = s.spacing || [1, 1, 1];
        const ml = n * (sp[0] * sp[1] * sp[2]) / 1000;   // мм³ → мл
        el.textContent = n ? ((ml < 10 ? ml.toFixed(2) : ml.toFixed(1)) + ' мл') : '—';
      }

      setActiveTool('mucosa');
      calibrateTissue();
      updateVol();

      // 3D-рендер маски в 4-м окне; спейсинг — из геометрии NRRD (длины строк)
      function _spacingFromGeom() {
        const sd = ctVol.spaceDirections;
        const norm = (v) => Array.isArray(v) ? Math.hypot(v[0] || 0, v[1] || 0, v[2] || 0) || 1 : 1;
        if (Array.isArray(sd) && sd.length === 3) return [norm(sd[0]), norm(sd[1]), norm(sd[2])];
        return [1, 1, 1];
      }
      // правка прямо по 3D-модели: применяем текущий инструмент к воксели,
      // которую вернул пикинг (v=null → штрих окончен, перестроить меш)
      let _edit3dPushed = false;
      function onEdit3D(v) {
        if (s.tool !== 'mucosa' && s.tool !== 'eraser') return;   // лепка по 3D — только кисть/ластик
        if (!v) { if (_edit3dPushed) { render(); if (s.r3d) s.r3d.markDirty(); } _edit3dPushed = false; s.lastPx = null; return; }
        if (!_edit3dPushed) { pushHistory(); _edit3dPushed = true; }
        if (s.tool === 'eraser') applyEraserAtVoxel(v, null, true);   // SHIFT/ПКМ по 3D — стереть шаром
        else applyMucosaAtVoxel(v, null, true);                       // SHIFT/ПКМ по 3D — залить дыру шаром
        render();
      }

      // клик по 3D-поверхности → перекрестье и все срезы прыгают в эту точку
      function onNavigate3D(v) {
        if (!v) return;
        setCrosshairVoxel({ x: v.x, y: v.y, z: v.z });
        render();
      }

      const r3dCanvas = document.getElementById('seg3dCanvas');
      if (r3dCanvas) {
        s.r3d = makeRender3D(r3dCanvas, s.sizes, () => s.mask, _spacingFromGeom(), onEdit3D, onNavigate3D);
      }
      resize();

      // ── авто-подчистка при загрузке: только безопасное (keepLargest + fillHoles),
      //    БЕЗ удаления воздуха и БЕЗ объёмного «закрытия» — те могут стереть
      //    реальную анатомию складок (см. CLAUDE.md §6). Один отменяемый шаг:
      //    «Отменить» или «Вернуть как было» возвращают сырую маску модели.
      function autoTidy() {
        const orig = s.mask;
        const m = LC.fillHoles3D(
          LC.keepLargest(orig, s._dims[0], s._dims[1], s._dims[2]),
          s._dims[0], s._dims[1], s._dims[2]);
        let removed = 0, added = 0;
        for (let i = 0; i < m.length; i++) {
          if (orig[i] && !m[i]) removed++; else if (!orig[i] && m[i]) added++;
        }
        if (!removed && !added) { _toast('Маска модели уже чистая', 'info', 2200); return; }
        pushHistory();
        s.mask.set(m); render(); if (s.r3d) s.r3d.markDirty(); updateVol();
        _toast('Авто-подчистка: убрано ' + removed + ' вокс, закрыто дырок ' + added +
               ' · «Отменить», чтобы вернуть как у модели', 'ok', 4200);
      }
      autoTidy();

      return {
        setTool: setActiveTool,
        runInterp,
        setRadius: (r) => { s.radius = r; },
        setAlpha:  (a) => { s.alpha = a; render(); },
        setWindowPreset: (p) => {
          if (p === 'bone') { s.win = 2000; s.lvl = 400; }
          else { s.win = 350; s.lvl = 40; }   // мягкие ткани
          render();
        },
        undo, redo, resetToAuto() {
          pushHistory(); s.mask.set(s.autoInitial); render();
          if (s.r3d) s.r3d.markDirty(); updateVol();
          _toast('Возвращено к авто-выстилке', 'ok', 2500);
        },
        clean: cleanupNow,
        patch: patchHoles,
        closeFill,
        setUseAir(on){ s.useAir = !!on; },
        setBrush3D(on){ s.brush3d = !!on; },
        smooth: smoothMask,
        setContour: (on) => { s.contour = !!on; render(); },
        foregroundCount() { let n = 0; for (let i = 0; i < s.mask.length; i++) if (s.mask[i]) n++; return n; },
        encodeMask() { return window.NRRD.encodeMaskU8(s.sizes, s.mask, s.geom); },
        encodeCT() { return window.NRRD.encodeCTInt16(s.sizes, s.ctVol.data, s.geom); },
        // Финальная поверхность для конвейера: сглаживание Taubin (не усаживает форму),
        // как экспорт из 3D Slicer со сглаживанием. Разрешение как у пайплайна (maxDim 150).
        // topology:'binary' — классификация по СЫРОЙ маске: топология (genus) как
        // у маски, тонкие стенки НЕ исчезают. 'smooth' размывал маску и по порогу
        // 0.5 срезал стенки 1–2 вокселя → сквозные тоннели-дыры (genus 1→5 на
        // реальных данных). Гладкость всё равно есть: позиции вершин берутся из
        // размытого поля (blur:3), а террасы добивает препроцесс (pre-smooth).
        meshForPipeline() { return segMaskToMesh(s.mask, s.sizes, s.spacing, 150, { smooth: 'taubin', topology: 'binary', blur: 3 }); },
        exportData() { return { sizes: s.sizes, spacing: s.spacing, ct: s.ctVol.data, mask: s.mask }; },
        dispose() {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          window.removeEventListener('keydown', onKey);
          _downHandlers.forEach(([cv, dh, wh, mh, lv]) => {
            cv.removeEventListener('mousedown', dh);
            cv.removeEventListener('wheel', wh);
            if (mh) cv.removeEventListener('mousemove', mh);
            if (lv) cv.removeEventListener('mouseleave', lv);
          });
          if (s._brushCur && s._brushCur.parentNode) s._brushCur.parentNode.removeChild(s._brushCur);
          if (s.r3d) s.r3d.dispose();
          ro.disconnect();
          if (root) root.innerHTML = '';
        },
      };
    }

    return { install };
  })();

  // ═══════════════════════════════════════════════════════════
  // Хелперы запроса
  // ═══════════════════════════════════════════════════════════
  async function sse(url, body, onStage) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || 'HTTP ' + r.status);
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', finalMsg = null, lastError = null;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const line = chunk.split('\n').find((x) => x.startsWith('data:'));
        if (!line) continue;
        let p; try { p = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
        if (p.stage) onStage && onStage(p.stage);
        else if (p.error) lastError = p.error;
        else if (p.ok) finalMsg = p;
      }
    }
    if (lastError) throw new Error(lastError);
    if (!finalMsg) throw new Error('Поток оборвался без результата');
    return finalMsg;
  }

  async function postJSON(url, body) {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || 'HTTP ' + r.status);
    }
    return r.json();
  }

  const okBuf = (label) => async (r) => {
    if (!r.ok) throw new Error(label + ': HTTP ' + r.status);
    return r.arrayBuffer();
  };

  function triggerDownload(buf, name, mime) {
    const blob = new Blob([buf], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  // ─── мелкие утилиты ───
  function val(id) {
    const el = document.getElementById(id);
    if (!el) return '';
    // поля конфигурации — это div с data-path (не input), у них нет .value
    if (el.dataset && typeof el.dataset.path === 'string') return el.dataset.path.trim();
    if (typeof el.value === 'string') return el.value.trim();
    return (el.textContent || '').trim();
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function sanitize(s) { return (s || 'case').replace(/[^0-9A-Za-zА-Яа-яЁё_\-]+/g, '_').replace(/^_+|_+$/g, '') || 'case'; }

  // ФИО из DICOM PatientName → «Фамилия_ИО» (Иванов^Андрей^Петрович → Иванов_АП).
  function fioName(raw) {
    let s = String(raw || '').trim();
    if (!s) return '';
    // DICOM PN разделяет компоненты '^'; бывает и по пробелам/запятым
    const parts = s.split(/[\^,]/).map((p) => p.trim()).filter(Boolean);
    let toks = parts.length > 1 ? parts : s.split(/\s+/).filter(Boolean);
    if (!toks.length) return '';
    const family = toks[0];
    const initials = toks.slice(1).map((t) => t[0] || '').join('').toUpperCase();
    return sanitize(initials ? (family + '_' + initials) : family);
  }
  // уникальный штамп времени YYYYMMDD_HHMM
  function _stamp() {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return '' + d.getFullYear() + p(d.getMonth()+1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
  }

  function buildCaseId() {
    const fio = fioName(segPatient) || sanitize(val('segCaseId') || '') || 'case';
    // ФИО не должно уезжать в обучающий датасет — берём устойчивый хэш.
    // Один пациент → один и тот же префикс, но имя не восстановимо.
    let h = 0;
    for (let i = 0; i < fio.length; i++) h = (h * 31 + fio.charCodeAt(i)) >>> 0;
    return 'case_' + h.toString(36) + '_' + _stamp();
  }
  function opt(v, label, cur) {
    return '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + label + '</option>';
  }


  // ── Оформленное окно подтверждения (автономная копия app-modal со вкладки
  //    «Данные»: без завязки на неё; свой CSS с guard'ом по id) ──────────────
  function _segCfEsc(t) {
    return String(t).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function _segCfCSS() {
    if (document.getElementById('seg-modal-css')) return;
    const s = document.createElement('style');
    s.id = 'seg-modal-css';
    s.textContent = [
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
      '  padding: 20px 22px 16px; position: relative;',
      '  animation: app-modal-pop 0.18s cubic-bezier(.2,.9,.3,1.2);',
      '}',
      '.app-modal::before {',
      '  content: ""; position: absolute; top: 0; left: 16px; right: 16px; height: 1px;',
      '  background: linear-gradient(90deg, transparent, var(--cyan, #00f0ff), transparent);',
      '  opacity: 0.5;',
      '}',
      '.app-modal-title {',
      "  font-family: 'Orbitron','Segoe UI','Helvetica Neue',Roboto,sans-serif;",
      '  font-size: 12px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase;',
      '  color: var(--cyan, #00f0ff); margin-bottom: 10px;',
      '  display: flex; align-items: center; gap: 8px;',
      '}',
      '.app-modal-title::before {',
      '  content: ""; width: 3px; height: 13px; background: var(--cyan, #00f0ff);',
      '  box-shadow: 0 0 6px var(--cyan, #00f0ff); border-radius: 1px; flex-shrink: 0;',
      '}',
      '.app-modal-body {',
      '  font-size: 13px; line-height: 1.55; color: var(--tx, #c8e6ff); margin-bottom: 18px;',
      '}',
      '.app-modal-actions { display: flex; gap: 8px; justify-content: flex-end; }',
      '.app-modal-btn {',
      '  min-width: 96px; padding: 9px 16px; border-radius: 4px; font: inherit;',
      '  font-size: 12.5px; font-weight: 600; letter-spacing: 0.02em; cursor: pointer;',
      '  background: transparent;',
      '  transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease, box-shadow 0.14s ease;',
      '}',
      '.app-modal-btn:focus-visible { outline: 2px solid var(--brd-glow, rgba(0,240,255,.25)); outline-offset: 2px; }',
      '.app-modal-btn-ghost { border: 1px solid var(--brd, rgba(0,240,255,.12)); color: var(--tx2, #6b8faa); }',
      '.app-modal-btn-ghost:hover { border-color: var(--brd-glow, rgba(0,240,255,.25)); color: var(--tx, #c8e6ff); background: rgba(0,240,255,0.04); }',
      '.app-modal-btn-warn { border: 1px solid var(--warn, #ff9f3c); color: var(--warn, #ff9f3c); background: rgba(255,159,60,0.10); }',
      '.app-modal-btn-warn:hover { background: rgba(255,159,60,0.20); box-shadow: 0 0 12px rgba(255,159,60,0.25); }',
      '.light-theme .app-modal-backdrop { background: rgba(226,232,240,0.70); }',
      '.light-theme .app-modal { background: #ffffff; border-color: rgba(79,124,219,0.25); box-shadow: 0 10px 40px rgba(30,60,120,0.15), 0 0 0 1px rgba(79,124,219,0.08); }',
      '.light-theme .app-modal::before { background: linear-gradient(90deg, transparent, #4F7CDB, transparent); opacity: 0.4; }',
      '.light-theme .app-modal-title { color: #4F7CDB; }',
      '.light-theme .app-modal-title::before { background: #4F7CDB; box-shadow: none; }',
      '.light-theme .app-modal-body { color: #1e293b; }',
      '.light-theme .app-modal-btn-ghost { border-color: #dfe4ec; color: #475569; }',
      '.light-theme .app-modal-btn-ghost:hover { border-color: rgba(79,124,219,0.4); color: #1e293b; background: #f8fafc; }',
      '.light-theme .app-modal-btn-warn { border-color: #d97706; color: #d97706; background: rgba(217,119,6,0.08); }',
      '.light-theme .app-modal-btn-warn:hover { background: rgba(217,119,6,0.16); box-shadow: 0 0 0 3px rgba(217,119,6,0.12); }',
    ].join('\n');
    document.head.appendChild(s);
  }
  // segConfirm(msg, opts) -> Promise<boolean>. opts: title, okLabel, cancelLabel, variant ('warn'|'ghost')
  function segConfirm(msg, opts) {
    opts = opts || {};
    _segCfCSS();
    const title = opts.title || 'Подтверждение';
    const okLabel = opts.okLabel || 'OK';
    const cancelLabel = opts.cancelLabel || 'Отмена';
    const okClass = (opts.variant === 'ghost') ? 'app-modal-btn-ghost' : 'app-modal-btn-warn';
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'app-modal-backdrop';
      backdrop.setAttribute('role', 'dialog');
      backdrop.setAttribute('aria-modal', 'true');
      backdrop.innerHTML = [
        '<div class="app-modal">',
          '<div class="app-modal-title">', _segCfEsc(title), '</div>',
          '<div class="app-modal-body">', _segCfEsc(msg), '</div>',
          '<div class="app-modal-actions">',
            '<button type="button" class="app-modal-btn app-modal-btn-ghost" data-act="cancel">', _segCfEsc(cancelLabel), '</button>',
            '<button type="button" class="app-modal-btn ', okClass, '" data-act="ok">', _segCfEsc(okLabel), '</button>',
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
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(false); });
      backdrop.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
      backdrop.querySelector('[data-act="ok"]').addEventListener('click', () => close(true));
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(backdrop);
      requestAnimationFrame(() => { const b = backdrop.querySelector('[data-act="ok"]'); if (b) b.focus(); });
    });
  }
  // Реестр иконок этапа. Каждая — массив [d, filled]. Заливка использует
  // currentColor, поэтому иконка тонируется цветом кнопки (как обводка).
  // Единый набор иконок в одном стиле: сетка 18×18, штрих 1.3, лёгкие заливки.
  const SEG_ICONS = {
    // Кисть — оригинал (не трогаем)
    brush: [
      ['M15 3.2l-.4 2.6-6.2 6.2-2.2-2.2 6.2-6.2 2.6-.4z', false],
      ['M8.4 11.8l-2.2-2.2-2.6 2.1c-.9.7-1.1 2.2-1.1 3.6 1.4 0 2.9-.2 3.6-1.1l2.3-2.4z', true],
    ],
    // Ластик — оригинал (не трогаем)
    eraser: [
      ['M3.2 11.8l5.5-5.5c.4-.4 1-.4 1.4 0l3.1 3.1c.4.4.4 1 0 1.4l-3.4 3.4H5.1l-1.9-1.9c-.4-.4-.4-1 0-1.4z', true],
      ['M8.2 7.0l3.6 3.6', false],
      ['M2.5 14.7h11', false],
    ],
    // Убрать лишнее — искры (в том же стиле)
    clean: [
      ['M8 3 L9 6.6 L12.6 7.6 L9 8.6 L8 12.2 L7 8.6 L3.4 7.6 L7 6.6 Z', true],
      ['M13 11 L13.5 12.5 L15 13 L13.5 13.5 L13 15 L12.5 13.5 L11 13 L12.5 12.5 Z', true],
    ],
    // Заполнить полости — капля
    fill: [
      ['M9 2.8c2.7 3.1 4.1 5 4.1 7.2a4.1 4.1 0 0 1-8.2 0c0-2.2 1.4-4.1 4.1-7.2z', true],
    ],
    // Затянуть окна — стрелки к центру
    close: [
      ['M3.8 3.8l2.7 2.7M3.8 3.8v2.6M3.8 3.8h2.6', false],
      ['M14.2 3.8l-2.7 2.7M14.2 3.8v2.6M14.2 3.8h-2.6', false],
      ['M3.8 14.2l2.7-2.7M3.8 14.2v-2.6M3.8 14.2h2.6', false],
      ['M14.2 14.2l-2.7-2.7M14.2 14.2v-2.6M14.2 14.2h-2.6', false],
    ],
    // Сгладить — волна
    smooth: [
      ['M2.6 10.5c1.6 0 1.6-3 3.2-3s1.6 3 3.2 3 1.6-3 3.2-3 1.6 3 3.2 3', false],
    ],
    // Протянуть между срезами — два среза + двусторонняя растяжка
    interp: [
      ['M4 4.5h10M4 13.5h10', false],
      ['M9 6v6M7.6 7.4l1.4-1.4 1.4 1.4M7.6 10.6l1.4 1.4 1.4-1.4', false],
    ],
    // Отменить / Повторить / Вернуть — принятые эскизы, вписанные в сетку 18
    undo: [
      ['M6.8 10.5l-3-3 3-3', false],
      ['M3.8 7.5h7.1a3.75 3.75 0 0 1 0 7.5H9', false],
    ],
    redo: [
      ['M11.2 10.5l3-3-3-3', false],
      ['M14.2 7.5H7.1a3.75 3.75 0 0 0 0 7.5H9', false],
    ],
    reset: [
      ['M15.4 9a6.4 6.4 0 1 1-2-4.6', false],
      ['M15.4 4.1v2.6h-2.6', false],
    ],
  };
  // Собрать inline-SVG иконку из реестра. style — доп. инлайн-стиль (для mini-кнопок).
  function _segIco(name, size, style) {
    const paths = SEG_ICONS[name]; if (!paths) return '';
    const body = paths.map(([d, fill]) =>
      '<path d="' + d + '" ' +
      (fill ? 'fill="currentColor" fill-opacity="0.16"' : 'fill="none"') +
      ' stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'
    ).join('');
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 18 18" ' +
           'aria-hidden="true"' + (style ? ' style="' + style + '"' : '') + '>' + body + '</svg>';
  }
  // Иконка для mini-кнопки: 14px, как flex-элемент рядом с текстом
  function _miniIco(name) { return _segIco(name, 14, 'flex:0 0 auto'); }

  function toolBtn(id, label, iconName) {
    return [
      '<button type="button" class="seg-tool" data-segtool="', id, '" title="', label, '">',
        _segIco(iconName, 18),
        '<span>', label, '</span>',
      '</button>',
    ].join('');
  }

  // ═══════════════════════════════════════════════════════════
  // CSS вкладки (scoped в stage[data-stage="segment"])
  // ═══════════════════════════════════════════════════════════
  function injectCSS() {
    if (document.getElementById('tab0-seg-css')) return;
    const st = document.createElement('style');
    st.id = 'tab0-seg-css';
    st.textContent = `
      .stage[data-stage="segment"] .empty-sub {
        font-family: inherit;
      }
      .stage[data-stage="segment"] #segEditorRoot { display:none; position:absolute; inset:0; }
      /* Slicer-подобная сетка 2×2 — в общей гамме приложения */
      .stage[data-stage="segment"] .seg-grid {
        position:absolute; top:0; left:0; right:0; bottom:52px;
        display:grid; grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr; gap:3px;
        background:var(--brd,rgba(0,240,255,.12));
      }
      .stage[data-stage="segment"] .seg-cell {
        position:relative; overflow:hidden; background:#05080d; min-width:0; min-height:0;
        border-radius:6px;
      }
      /* нижний ряд без скруглённых нижних углов — чтобы над подвалом не проступала цветная подложка сетки */
      .stage[data-stage="segment"] .seg-cell:nth-child(3),
      .stage[data-stage="segment"] .seg-cell:nth-child(4) {
        border-bottom-left-radius:0; border-bottom-right-radius:0;
      }
      .light-theme .stage[data-stage="segment"] .seg-cell { background:#0a0e14; }
      .stage[data-stage="segment"] .seg-cell-lbl {
        position:absolute; left:8px; top:7px; z-index:3; font-size:10.5px; letter-spacing:.6px;
        max-width:calc(100% - 16px); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
        text-transform:uppercase; color:var(--cyan,#00f0ff); background:rgba(5,8,13,.9);
        padding:3px 9px; border-radius:5px; font-family:'Share Tech Mono','Consolas',monospace;
        pointer-events:none; border:1px solid rgba(120,200,255,.35); box-shadow:0 1px 4px rgba(0,0,0,.35);
      }
      /* 3D-ячейка на белом фоне: светлая подложка + тёмно-синий текст, чтобы подпись
         сочеталась с белым и синей моделью (раньше было синее на чёрном — спорило с фото). */
      .stage[data-stage="segment"] .seg-cell-3d .seg-cell-lbl {
        color:#1f3d78; background:rgba(255,255,255,.82);
        border-color:rgba(60,110,200,.45); box-shadow:0 1px 5px rgba(30,60,120,.18);
      }
      .stage[data-stage="segment"] .seg-canvas {
        position:absolute; inset:0; width:100%; height:100%; display:block;
        background:transparent; touch-action:none;
        image-rendering:pixelated; image-rendering:crisp-edges;   /* без сглаживания при масштабе — резко, как в Slicer */
      }
      .stage[data-stage="segment"] .seg-cell-3d,
      .light-theme .stage[data-stage="segment"] .seg-cell-3d { background:#ffffff !important; }
      /* развёрнутое окно по двойному щелчку */
      .stage[data-stage="segment"] .seg-grid.seg-maxed > .seg-cell { display:none; }
      .stage[data-stage="segment"] .seg-grid.seg-maxed > .seg-cell.is-max {
        display:block; grid-column:1 / 3; grid-row:1 / 3;
      }
      .stage[data-stage="segment"] .seg-cell-hint {
        text-transform:none; letter-spacing:0; opacity:.7; font-size:9.5px;
      }
      .stage[data-stage="segment"] .seg-3d-canvas {
        position:absolute; inset:0; width:100%; height:100%; display:block;
        cursor:grab; touch-action:none;
      }
      .stage[data-stage="segment"] .seg-3d-canvas:active { cursor:grabbing; }
      .stage[data-stage="segment"] .seg-slicectl {
        position:absolute; left:0; right:0; bottom:0; min-height:52px;
        display:flex; align-items:center; gap:12px; padding:8px 18px;
        background:var(--card,rgba(10,16,28,.72)); border-top:1px solid var(--brd,rgba(0,240,255,.12));
        backdrop-filter:blur(6px);
      }
      .light-theme .stage[data-stage="segment"] .seg-slicectl { background:rgba(240,246,252,.9); }
      .stage[data-stage="segment"] .seg-slicectl-lbl {
        font-size:11.5px; font-weight:700; color:var(--tx,#c8e6ff); white-space:nowrap;
        font-family:'Share Tech Mono','Consolas',monospace; letter-spacing:.8px; text-transform:uppercase; opacity:.9;
      }
      .stage[data-stage="segment"] .seg-slicectl input[type=range] {
        flex:0 1 300px; min-width:110px; accent-color:var(--cyan,#00f0ff);
      }
      .stage[data-stage="segment"] .seg-nav { flex:0 0 auto; }
      .stage[data-stage="segment"] .seg-slice-sep {
        flex:0 0 auto; width:1px; height:24px; background:var(--brd,rgba(120,140,170,.35));
      }
      .stage[data-stage="segment"] .seg-sliceidx { display:flex; align-items:center; gap:8px; white-space:nowrap; }
      .stage[data-stage="segment"] .seg-chip {
        display:inline-flex; align-items:baseline; gap:6px; padding:4px 10px; border-radius:8px;
        background:rgba(120,140,170,.12); border:1px solid var(--brd,rgba(120,140,170,.22));
        font-family:inherit; cursor:pointer; opacity:.45;
        transition:opacity .12s ease, border-color .12s ease, background .12s ease;
      }
      .stage[data-stage="segment"] .seg-chip:hover { opacity:.85; }
      .stage[data-stage="segment"] .seg-chip.is-active {
        opacity:1; border-color:var(--cyan,#00f0ff);
        background:var(--cyan-dim,rgba(0,240,255,.15));
      }
      .stage[data-stage="segment"] .seg-chip-l {
        font-family:'Share Tech Mono','Consolas',monospace; font-size:10px; font-weight:800;
        letter-spacing:1.4px; color:var(--cyan,#00f0ff);
      }
      .stage[data-stage="segment"] .seg-chip-v {
        font-family:'Share Tech Mono','Consolas',monospace; font-size:13.5px; color:var(--tx,#c8e6ff);
      }
      .stage[data-stage="segment"] .seg-chip-v b { font-weight:800; }
      .stage[data-stage="segment"] .seg-chip-v i { font-style:normal; font-weight:600; opacity:.5; }
      .stage[data-stage="segment"] .seg-slicectl-right { display:flex; align-items:center; gap:12px; margin-left:auto; }
      .stage[data-stage="segment"] .seg-slicectl-tip { font-size:11px; opacity:.5; white-space:nowrap; line-height:1.25; }
      .stage[data-stage="segment"] .seg-snap-btn {
        flex:0 0 auto; white-space:nowrap; border-color:var(--cyan,#00f0ff);
        color:var(--cyan,#00f0ff); background:rgba(0,240,255,.10); font-weight:700; padding:8px 14px;
      }
      .stage[data-stage="segment"] .seg-snap-btn:hover { background:rgba(0,240,255,.20); }
      /* правая панель на этапе правки — прокручивается, чтобы карточки не обрезались.
         max-height привязан к окну (а не к родителю), иначе 100% не срабатывает
         и нижние карточки уходят под обрез вместо прокрутки. */
         
        
      /* карточки НЕ сжимать: иначе flex-колонка «съедает» их по высоте и
         режет содержимое вместо того, чтобы дать панели прокрутиться */
      .stage[data-stage="segment"] .panel.right > * { flex:0 0 auto; }
      /* метрики карточек НЕ переопределяем — наследуем глобальные .card /
         .card-title / .hint-text из app.css, как на табах 1–3 (единый вид). */
      .stage[data-stage="segment"] .panel.right .seg-steps { margin:0; }
      /* сворачиваемая подсказка-гайд — экономит место */
      .stage[data-stage="segment"] details#segGuideCard > summary {
        list-style:none; cursor:pointer; display:flex; align-items:center;
        justify-content:space-between; margin-bottom:0;
      }
      .stage[data-stage="segment"] details#segGuideCard > summary::-webkit-details-marker { display:none; }
      .stage[data-stage="segment"] details#segGuideCard > summary::after {
        content:'▸'; opacity:.55; font-size:13px; transition:transform .15s ease;
      }
      .stage[data-stage="segment"] details#segGuideCard[open] > summary::after { transform:rotate(90deg); }
      .stage[data-stage="segment"] details#segGuideCard[open] > summary { margin-bottom:8px; }
      .stage[data-stage="segment"] .seg-next-btn { background:#1f6fd6; }
      .stage[data-stage="segment"] .seg-next-btn:hover { background:#1a5fc0; }
      .stage[data-stage="segment"] .seg-next-btn {
        width:100%; margin-top:0;
        display:inline-flex; align-items:center; justify-content:center; gap:8px;
        padding:12px 16px; font-size:13px; letter-spacing:.06em;
        white-space:nowrap; line-height:1;
      }
      .stage[data-stage="segment"] .seg-next-btn svg { flex:0 0 auto; }
      .seg-field { margin-top:10px; }
      .seg-field label { display:block; font-size:11px; opacity:.7; margin-bottom:4px; }
      /* ползунки правой панели — в тот же цвет, что и слайдер срезов под КТ */
      .stage[data-stage="segment"] .seg-field input[type=range] {
        width:100%; box-sizing:border-box; accent-color:var(--cyan,#00f0ff);
      }
      .seg-field input[type=text], .seg-field select {
        width:100%; box-sizing:border-box; padding:7px 9px; font-size:12px;
        border-radius:5px; border:1px solid var(--brd,rgba(0,240,255,.18));
        background:var(--card-solid,#0b1220); color:var(--tx,#c8e6ff);
      }
      .light-theme .seg-field input[type=text], .light-theme .seg-field select {
        background:#fff; color:#1a2b3c; border-color:#d0dde8;
      }
      .seg-field input:focus, .seg-field select:focus { outline:none; border-color:var(--cyan,#00f0ff); }
      .seg-tools { display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; }
      .seg-tools-5 { grid-template-columns:1fr 1fr 1fr; }
      .seg-wl [data-bmode].active { border-color:var(--cyan,#00f0ff); color:var(--cyan,#00f0ff); background:rgba(0,240,255,.12); }
      .seg-tool {
        display:flex; flex-direction:column; align-items:center; gap:6px;
        padding:13px 4px; border-radius:9px; cursor:pointer; font-size:13px;
        font-family:inherit; font-weight:600;
        border:1px solid var(--brd,rgba(0,240,255,.12)); background:transparent;
        color:var(--tx2,#6b8faa); transition:all .14s ease;
      }
      .seg-tool:hover { border-color:var(--brd-glow,rgba(0,240,255,.25)); color:var(--tx,#c8e6ff); background:rgba(0,240,255,.04); }
      .seg-tool.active {
        border-color:var(--cyan,#00f0ff); color:var(--cyan,#00f0ff);
        background:rgba(0,240,255,.10);
      }
      .seg-actions { display:flex; gap:10px; margin-top:10px; }
      /* блок настроек кисти тускнеет, когда активен не-кистевой инструмент */
      .seg-adv-block { transition:opacity .14s ease; }
      .seg-adv-block.seg-dim { opacity:.4; }
      .seg-wl [data-wl].active { border-color:var(--cyan,#00f0ff); color:var(--cyan,#00f0ff); background:rgba(0,240,255,.12); }
      .seg-mini {
        flex:1; display:inline-flex; align-items:center; justify-content:center; gap:7px;
        padding:10px 10px; font-size:12.5px; line-height:1.3; border-radius:8px; cursor:pointer;
        font-family:inherit; font-weight:500;
        border:1px solid var(--brd,rgba(0,240,255,.12)); background:transparent;
        color:var(--tx2,#6b8faa); transition:all .14s ease;
      }
      .seg-mini:hover { border-color:var(--brd-glow,rgba(0,240,255,.25)); color:var(--tx,#c8e6ff); background:rgba(0,240,255,.04); }
      .seg-mini.active { border-color:var(--cyan,#00f0ff); color:var(--cyan,#00f0ff); background:rgba(0,240,255,.12); }
      /* правая панель: выровнять по высоте и дать прокрутку, если не вмещается */
      .stage[data-stage="segment"] .panel.right {
        align-self:stretch; min-height:0; height:100%; max-height:none;
        overflow-y:auto; padding-bottom:14px;
      }
      /* ── видимый, аккуратный скроллбар правой панели (обе темы) ── */
      .stage[data-stage="segment"] .panel.right {
        scrollbar-width:thin; scrollbar-color:var(--brd-glow,rgba(0,240,255,.25)) rgba(0,240,255,.05);
      }
      .stage[data-stage="segment"] .panel.right::-webkit-scrollbar { width:9px; }
      .stage[data-stage="segment"] .panel.right::-webkit-scrollbar-track {
        background:rgba(0,240,255,.05); border-radius:6px; margin:4px 0;
      }
      .stage[data-stage="segment"] .panel.right::-webkit-scrollbar-thumb {
        background:var(--brd-glow,rgba(0,240,255,.25)); border-radius:6px;
        border:2px solid transparent; background-clip:content-box;
      }
      .stage[data-stage="segment"] .panel.right::-webkit-scrollbar-thumb:hover {
        background:var(--cyan,#00f0ff); background-clip:content-box;
      }
      .light-theme .stage[data-stage="segment"] .panel.right {
        scrollbar-color:rgba(79,124,219,.45) rgba(79,124,219,.10);
      }
      .light-theme .stage[data-stage="segment"] .panel.right::-webkit-scrollbar-track {
        background:rgba(79,124,219,.10);
      }
      .light-theme .stage[data-stage="segment"] .panel.right::-webkit-scrollbar-thumb {
        background:rgba(79,124,219,.45); background-clip:content-box;
      }
      .light-theme .stage[data-stage="segment"] .panel.right::-webkit-scrollbar-thumb:hover {
        background:#4F7CDB; background-clip:content-box;
      }
      /* «Сброс к авто» — отдельный, заметно осторожный вид (не путать с «Отменить») */
      .seg-mini.seg-danger { color:var(--orange,#ff8844); border-color:rgba(208,138,44,.4); }
      .seg-mini.seg-danger:hover { color:#fff; background:var(--orange,#ff8844); border-color:var(--orange,#ff8844); }
      /* пояснение про режим «в объёме (3D)» */
      .seg-bmode-note { font-size:10.5px; line-height:1.45; opacity:.7; margin-top:6px; }
      /* в легенде подписи переносятся, а не обрезаются */
      .seg-wl { display:flex; gap:6px; }
      .stage[data-stage="segment"] .seg-steps { list-style:none; padding:0; margin:0; counter-reset:segpre; font-size:13px; line-height:1.55; }
      .stage[data-stage="segment"] .seg-steps li { position:relative; padding-left:26px; margin-bottom:8px; counter-increment:segpre; color:var(--tx2,#6b8faa); }
      .stage[data-stage="segment"] .seg-steps li::before {
        content:counter(segpre); position:absolute; left:0; top:-1px; width:18px; height:18px;
        display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:700;
        color:var(--cyan,#00f0ff); background:rgba(0,240,255,.10);
        border:1px solid var(--brd,rgba(0,240,255,.3)); border-radius:50%;
      }
      .stage[data-stage="segment"] .seg-steps b { color:var(--cyan,#00f0ff); font-weight:600; }
      /* light-theme — тот же синий #4F7CDB, что и в списках остальных вкладок */
      .light-theme .stage[data-stage="segment"] .seg-steps li::before {
        background:rgba(79,124,219,0.08); border-color:rgba(79,124,219,0.3); color:#4F7CDB;
      }
      .light-theme .stage[data-stage="segment"] .seg-steps b { color:#4F7CDB; }
      /* light-theme: единый синий #4F7CDB вместо циана для всех выделений этапа */
      .light-theme .stage[data-stage="segment"] { --cyan:#4F7CDB; --brd-glow:rgba(79,124,219,.35); }

      /* заливки активных/hover состояний (там жёстко зашит циан, за переменной не идут) */
      .light-theme .stage[data-stage="segment"] .seg-tool.active,
      .light-theme .stage[data-stage="segment"] .seg-mini.active,
      .light-theme .stage[data-stage="segment"] .seg-mini.seg-accent { background:rgba(79,124,219,.12); }
      .light-theme .stage[data-stage="segment"] .seg-tool:hover,
      .light-theme .stage[data-stage="segment"] .seg-mini:hover { background:rgba(79,124,219,.05); }
      .light-theme .stage[data-stage="segment"] .seg-mini.seg-accent:hover { background:rgba(79,124,219,.22); }
      .light-theme .stage[data-stage="segment"] .seg-snap-btn { background:rgba(79,124,219,.10); }
      .light-theme .stage[data-stage="segment"] .seg-snap-btn:hover { background:rgba(79,124,219,.20); }
      .light-theme .stage[data-stage="segment"] .seg-mini.seg-danger:hover {
        background:var(--orange,#ff8844); color:#fff; border-color:var(--orange,#ff8844);
      }
      .stage[data-stage="segment"] code { font-size:11px; background:rgba(127,127,127,.12); padding:1px 4px; border-radius:3px; }

      /* текстовая кнопка-ссылка под основной */
      .seg-textbtn {
        background:none; border:none; cursor:pointer; font:inherit; font-size:12.5px;
        color:var(--cyan,#00f0ff); opacity:.85; text-decoration:underline;
        text-underline-offset:3px; padding:2px 4px;
      }
      .seg-textbtn:hover { opacity:1; }

      /* ── empty-state: всё по центру, иконка кнопки не наезжает на текст ── */
      .stage[data-stage="segment"] .empty-state { text-align:center; }
      .stage[data-stage="segment"] #segLoadMode,
      .stage[data-stage="segment"] #segRunMode {
        display:flex; flex-direction:column; align-items:center;
      }
      .stage[data-stage="segment"] .empty-formats {
        display:flex; justify-content:center; width:100%;
      }
      .stage[data-stage="segment"] .empty-hint { width:100%; text-align:center; }
      .stage[data-stage="segment"] .btn-open-big {
        display:inline-flex; align-items:center; justify-content:center; gap:9px;
      }
      .stage[data-stage="segment"] .btn-open-big svg { flex:0 0 auto; display:block; }

      /* свёрнутые настройки модели */
      .seg-settings { padding-top:12px; padding-bottom:12px; }
      .seg-settings > summary {
        cursor:pointer; list-style:none; display:flex; align-items:center; gap:8px; margin:0;
      }
      .seg-settings > summary::-webkit-details-marker { display:none; }
      .seg-set-name { flex:1; min-width:0; }
      .seg-settings > summary .badge { flex:0 0 auto; }
      .seg-settings > summary::after {
        content:'▾'; flex:0 0 auto; font-size:11px; opacity:.55; transition:transform .15s ease;
      }
      .seg-settings[open] > summary::after { transform:rotate(180deg); }
      .seg-settings[open] > summary { margin-bottom:10px; }
      .seg-set-note { line-height:1.55; margin:-2px 0 14px; }
      .seg-ok-t   { color:#3aa981; font-weight:600; }
      .seg-warn-t { color:var(--orange,#ff8844); font-weight:600; }
      .seg-settings .seg-field { margin-top:11px; }
      .seg-settings .seg-field:first-of-type { margin-top:0; }
      .seg-field-row { display:flex; gap:6px; align-items:stretch; }
      .seg-field-row .seg-cfg-val { flex:1; min-width:0; }
      .seg-browse-btn {
        flex:0 0 auto; width:38px; border-radius:8px; cursor:pointer;
        display:flex; align-items:center; justify-content:center;
        border:1px solid rgba(120,140,170,.28); background:rgba(127,140,160,.05);
        color:var(--cyan,#00f0ff); transition:background .15s ease, border-color .15s ease;
      }
      .seg-browse-btn:hover { border-color:var(--cyan,#00f0ff); background:rgba(0,240,255,.12); }
      .seg-folder-ic { display:inline-block; vertical-align:-3px; color:var(--cyan,#00f0ff); }
      .seg-series-desc .seg-folder-ic { margin-right:4px; }
      /* поля настроек — единый вид с остальным окружением */
      .stage[data-stage="segment"] .seg-field label {
        font-size:11px; opacity:.7; display:block; margin:0 0 5px; letter-spacing:.2px;
      }
      /* в карточке настроек подписи и пути — крупнее, как основной текст, читаемо доктору */
      .stage[data-stage="segment"] .seg-settings .seg-field label {
        font-size:13px; opacity:.8; margin-bottom:6px; letter-spacing:.2px;
      }
      /* путь — только для чтения; клик открывает проводник */
      .stage[data-stage="segment"] .seg-cfg-val {
        display:flex; align-items:center; padding:10px 13px; border-radius:8px;
        font:inherit; font-size:13px; color:inherit; cursor:pointer; min-height:20px;
        overflow:hidden;
        border:1px solid rgba(120,140,170,.28); background:rgba(127,140,160,.05);
        border-left:3px solid rgba(120,140,170,.28);
        transition:border-color .15s ease, background .15s ease;
      }
      /* текст пути обрезается СЛЕВА — конец (имя файла) всегда виден */
      .stage[data-stage="segment"] .seg-cfg-txt {
        flex:1; min-width:0; overflow:hidden; white-space:nowrap;
        text-overflow:ellipsis; direction:rtl; text-align:left;
      }
      .stage[data-stage="segment"] .seg-cfg-bdi { direction:ltr; unicode-bidi:isolate; }
      .stage[data-stage="segment"] .seg-cfg-val:hover {
        border-color:var(--cyan,#00f0ff); background:rgba(0,240,255,.06);
      }
      /* статус поля — тонкая цветная полоса слева */
      .seg-cfg-ok   { border-left-color:#3aa981 !important; }
      .seg-cfg-warn { border-left-color:var(--orange,#ff8844) !important; }
      .badge.seg-cfg-ok   { color:#3aa981 !important; border-color:rgba(58,169,129,.5) !important; }
      .badge.seg-cfg-warn { color:var(--orange,#ff8844) !important; border-color:rgba(208,138,44,.5) !important; }

      /* окно выбора тома (DICOM) — как диалог серий в Slicer */
      .stage[data-stage="segment"] .seg-picker {
        position:fixed; inset:0; z-index:60; display:flex; align-items:center; justify-content:center;
        background:rgba(8,12,20,.55); backdrop-filter:blur(3px); padding:2vh 2vw; box-sizing:border-box;
      }
      .light-theme .stage[data-stage="segment"] .seg-picker { background:rgba(230,238,247,.6); }
      .seg-picker-box {
        position:relative;
        width:min(560px,92%); max-height:96vh; display:flex; flex-direction:column;
        background:var(--card-solid,#0b1220); color:var(--tx,#c8e6ff);
        border:1px solid var(--brd,rgba(0,240,255,.18)); border-radius:12px;
        box-shadow:0 18px 60px rgba(0,0,0,.4); padding:24px 26px; box-sizing:border-box;
      }
      .light-theme .seg-picker-box { background:#fff; color:#1a2b3c; border-color:#d0dde8; }
      .seg-picker-close {
        position:absolute; top:16px; right:18px; z-index:4;
        width:38px; height:38px; border-radius:9px; cursor:pointer;
        display:flex; align-items:center; justify-content:center;
        font-size:26px; line-height:1; font-family:inherit;
        border:1px solid var(--brd,rgba(120,140,170,.28)); background:transparent;
        color:inherit; opacity:.55; transition:opacity .15s ease, border-color .15s ease, background .15s ease;
      }
      .seg-picker-close:hover { opacity:1; border-color:var(--cyan,#00f0ff); background:rgba(0,240,255,.10); }
      .seg-picker-title { font-weight:700; font-size:22px; margin-bottom:6px; padding-right:46px; }
      .seg-picker-hint { font-size:15px; opacity:.85; margin-top:12px; margin-bottom:16px; line-height:1.5; }
      .seg-picker-hint b { color:var(--cyan,#00f0ff); font-weight:700; }
      .seg-picker-list { overflow:auto; display:flex; flex-direction:column; gap:8px; }
      .seg-series-row {
        display:flex; align-items:center; gap:16px; text-align:left; cursor:pointer;
        padding:14px 16px; border-radius:9px; background:transparent;
        border:1px solid var(--brd,rgba(0,240,255,.15)); color:inherit; font:inherit;
      }
      .seg-series-row:hover { border-color:var(--cyan,#00f0ff); }
      .seg-series-row:focus { outline:none; }
      .seg-series-row:focus-visible { outline:2px solid var(--cyan,#00f0ff); outline-offset:2px; }
      .seg-series-row.active { border-color:var(--cyan,#00f0ff); background:rgba(0,240,255,.12); }
      .seg-series-main { flex:1; min-width:0; display:flex; flex-direction:column; gap:3px; }
      .seg-series-desc { font-size:17px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .seg-series-sub { font-size:13px; opacity:.62; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .seg-series-params {
        font-size:14px; opacity:.78; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
        font-family:'Share Tech Mono','Consolas',monospace; letter-spacing:.2px;
      }
      .seg-series-params b { color:var(--cyan,#00f0ff); font-weight:700; }
      .seg-series-row.seg-series-bad .seg-series-params { opacity:.5; }
      .seg-picker-sub { font-size:14.5px; opacity:.85; font-weight:500; margin:-2px 0 12px; }
      .seg-series-meta { font-size:14.5px; opacity:.85; white-space:nowrap; font-family:'Share Tech Mono','Consolas',monospace; }
      .seg-series-meta b { color:var(--cyan,#00f0ff); }
      /* правая колонка строки: бейдж ★ над метаданными */
      .seg-series-right { flex:0 0 auto; display:flex; flex-direction:column; align-items:flex-end; gap:6px; }
      .seg-rec-tag { font-size:19px; line-height:1; color:var(--cyan,#00f0ff); cursor:default; }
      .seg-series-row.seg-series-rec:not(.active) { border-color:rgba(0,240,255,.45); }
      /* light-theme — выделение серии синим #4F7CDB (вместо циана) */
      .light-theme .seg-series-row.active { border-color:#4F7CDB; background:rgba(79,124,219,.12); }
      .light-theme .seg-series-row:hover { border-color:#4F7CDB; }
      .light-theme .seg-series-row.seg-series-rec:not(.active) { border-color:rgba(79,124,219,.45); }
      .light-theme .seg-rec-tag { color:#4F7CDB; }
      .light-theme .seg-series-meta b { color:#4F7CDB; }
      .seg-hint-star { color:var(--cyan,#00f0ff); font-weight:700; }
      /* серия не собирается в объём — приглушаем строку и помечаем */
      .seg-series-row.seg-series-bad { opacity:.6; }
      .seg-series-row.seg-series-bad:hover { border-color:var(--orange,#ff8844); }
      .seg-series-row.seg-series-bad.active { border-color:var(--orange,#ff8844); background:rgba(208,138,44,.10); }
      .seg-series-bad-t { color:var(--orange,#ff8844) !important; font-family:inherit !important; font-weight:600; }
      /* «Загрузить том» недоступна для несобираемой серии */
      .btn-open-big.is-disabled { opacity:.45; pointer-events:none; filter:grayscale(.3); }
      .seg-preview-err { color:var(--orange,#ff8844); max-width:460px; }
      .seg-preview-err-t { font-weight:700; font-size:17px; margin-bottom:8px; color:inherit; }
      .seg-picker-actions { display:flex; gap:10px; justify-content:flex-end; align-items:center; margin-top:18px; }
      .seg-picker-actions .seg-mini { flex:0 0 auto; }
      /* при выборе тома — прячем боковые панели (как на 4 вкладке), окно на всю ширину */
      .stage[data-stage="segment"].seg-picking .panel.left,
      .stage[data-stage="segment"].seg-picking .panel.right { display:none; }

      /* двухколоночный пикер серий + прокрутка срезов (как в Slicer) */
      .seg-picker-wide { width:96vw; max-width:1700px; height:auto; max-height:96vh; }
      .seg-picker-wide .seg-picker-cols { flex:1 1 auto; min-height:0; }
      .seg-picker-wide .seg-picker-actions { flex:0 0 auto; }
      .seg-picker-wide .seg-picker-list { flex:0 0 33%; max-height:none; }
      .seg-picker-wide .seg-preview { flex:1 1 67%; }      /* срезы на 2/3 окна */
      .seg-picker-cols { display:flex; gap:16px; min-height:0; flex:1; overflow:hidden; }
      .seg-picker-cols .seg-picker-list { flex:0 0 33%; min-height:0; max-height:none; overflow-y:auto; }
      .seg-preview {
        flex:1; display:flex; overflow:hidden;
        border:1px solid var(--brd,rgba(0,240,255,.15)); border-radius:10px; padding:8px;
        background:rgba(8,12,20,.25); align-items:stretch; justify-content:center;
      }
      .light-theme .seg-preview { background:rgba(20,30,45,.04); }
      /* колонка: сетка срезов сверху (тянется) + подпись-подвал снизу */
      .seg-vv-wrap { display:flex; flex-direction:column; gap:8px; width:100%; height:100%; min-height:0; }
      /* раскладка C: крупный аксиальный слева, сагиттальный/корональный стопкой справа */
      .seg-vv {
        flex:1; min-height:0; display:grid;
        grid-template-columns:1.6fr 1fr; grid-template-rows:1fr 1fr; gap:8px;
      }
      .seg-vv .c-ax  { grid-area:1 / 1 / 3 / 2; }
      .seg-vv .c-sag { grid-area:1 / 2 / 2 / 3; }
      .seg-vv .c-cor { grid-area:2 / 2 / 3 / 3; }
      .seg-vv-cell {
        position:relative; background:#05080d; border-radius:8px; overflow:hidden;
        display:flex; align-items:center; justify-content:center; min-width:0; min-height:0;
      }
      .seg-vv-cell canvas { display:block; cursor:ns-resize; }
      .seg-vv-lbl {
        position:absolute; left:9px; top:8px; z-index:2; font-size:12.5px; letter-spacing:.5px;
        text-transform:uppercase; color:var(--cyan,#00f0ff); background:rgba(5,8,13,.62);
        padding:4px 10px; border-radius:6px;
        font-family:'Share Tech Mono','Consolas',monospace; pointer-events:none; backdrop-filter:blur(3px);
      }
      /* подпись выбранного тома под срезами — отдельный подвал */
      .seg-cap {
        flex:0 0 auto; display:flex; align-items:baseline; gap:14px; flex-wrap:wrap; row-gap:3px;
        padding:9px 4px 1px; border-top:1px solid rgba(120,140,170,.22);
      }
      .seg-cap-t { font-size:18px; font-weight:700; white-space:nowrap; }
      .seg-cap-m { font-size:14px; opacity:.78; white-space:nowrap; font-family:'Share Tech Mono','Consolas',monospace; }
      .seg-cap-h { font-size:12.5px; opacity:.55; margin-left:auto; white-space:nowrap; }
      .seg-preview-hint { font-size:16px; opacity:.65; text-align:center; padding:24px 10px; margin:auto; line-height:1.5; }
      #spinnerSegmentText { font-family:'Share Tech Mono','Consolas',monospace; white-space:nowrap; letter-spacing:.3px; }
      
      .seg-tgroup-lbl {
        font-size:11px; letter-spacing:1.1px; text-transform:uppercase; font-weight:700;
        color:var(--cyan,#00f0ff); opacity:.9; margin:22px 0 10px;
        display:flex; align-items:center; gap:8px;
      }
      .seg-tgroup-lbl::after {
        content:""; flex:1; height:1px; background:var(--brd,rgba(0,240,255,.12));
      }
      .seg-tgroup-lbl:first-of-type { margin-top:6px; }
      .seg-tools-2 { grid-template-columns:1fr 1fr; }
      .seg-tools-3 { grid-template-columns:1fr 1fr 1fr; }
      .seg-check {
        display:flex; align-items:center; gap:8px; cursor:pointer;
        font-size:11px; line-height:1.45; opacity:.7; margin-top:12px;
      }
      .seg-check input { accent-color:var(--cyan,#00f0ff); flex:0 0 auto; }
      /* единый шрифт всей панели правки (кнопки/инпуты не наследуют шрифт сами) */
      .stage[data-stage="segment"] #segToolsCard,
      .stage[data-stage="segment"] #segToolsCard button,
      .stage[data-stage="segment"] #segToolsCard input,
      .stage[data-stage="segment"] #segToolsCard label,
      .stage[data-stage="segment"] #segToolsCard .hint-text {
        font-family:ui-sans-serif,system-ui,'Segoe UI',Roboto,Arial,sans-serif;
      }
      /* ползунок: линия и круг одного цвета; реакция на наведение — общим filter (синхронно) */
      .stage[data-stage="segment"] .seg-range {
        -webkit-appearance:none; appearance:none; width:100%; box-sizing:border-box;
        height:18px; background:transparent; cursor:pointer; --p:0%;
        --sl-fill:var(--cyan,#4F7CDB); --sl-track:rgba(120,140,170,.28);
      }
      .light-theme .stage[data-stage="segment"] .seg-range { --sl-fill:#4F7CDB; }
      .stage[data-stage="segment"] .seg-range::-webkit-slider-runnable-track {
        height:6px; border-radius:999px;
        background:linear-gradient(90deg, var(--sl-fill) var(--p), var(--sl-track) var(--p));
      }
      .stage[data-stage="segment"] .seg-range::-webkit-slider-thumb {
        -webkit-appearance:none; appearance:none; width:16px; height:16px; margin-top:-5px;
        border-radius:50%; background:var(--sl-fill); border:none; box-shadow:none;
      }
      .stage[data-stage="segment"] .seg-range::-moz-range-track { height:6px; border-radius:999px; background:var(--sl-track); }
      .stage[data-stage="segment"] .seg-range::-moz-range-progress { height:6px; border-radius:999px; background:var(--sl-fill); }
      .stage[data-stage="segment"] .seg-range::-moz-range-thumb { width:16px; height:16px; border:none; border-radius:50%; background:var(--sl-fill); }
      .stage[data-stage="segment"] .seg-range:hover { filter:brightness(1.08); }
      .stage[data-stage="segment"] .seg-range:active { filter:brightness(1.14); }
      .stage[data-stage="segment"] .seg-range:focus-visible { outline:none; }
      .seg-tissue-row { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:6px; }
      .seg-tissue-rng { font-family:'Share Tech Mono','Consolas',monospace; font-size:12.5px; opacity:.85; }
      .seg-tissue-rng b { color:var(--cyan,#00f0ff); }
      .seg-scribble { margin-top:12px; padding:12px; border:1px solid var(--brd,rgba(0,240,255,.18)); border-radius:10px; background:rgba(0,240,255,.05); }
      .seg-scribble .seg-actions { margin-top:8px; }
      .seg-mini.seg-accent { border-color:var(--cyan,#00f0ff); color:var(--cyan,#00f0ff); background:rgba(0,240,255,.12); font-weight:600; }
      .seg-mini.seg-accent:hover { background:rgba(0,240,255,.22); color:#fff; }
      .seg-howto { font-size:12.5px; line-height:1.5; opacity:.85; margin-top:4px; }
      .seg-brush-cursor { position:fixed; z-index:9999; border:1.5px solid rgba(120,220,255,.9);
        border-radius:50%; transform:translate(-50%,-50%); pointer-events:none;
        box-shadow:0 0 0 1px rgba(0,0,0,.4); mix-blend-mode:screen; }
      .seg-adv { margin-top:14px; border-top:1px solid var(--brd,rgba(0,240,255,.14)); padding-top:6px; }
      .seg-adv > summary { cursor:pointer; font-size:12px; letter-spacing:.4px; text-transform:uppercase; opacity:.6; font-weight:700; padding:6px 0; list-style:none; user-select:none; }
      .seg-adv > summary::-webkit-details-marker { display:none; }
      .seg-adv > summary::before { content:'▸ '; }
      .seg-adv[open] > summary::before { content:'▾ '; }
    `;
    document.head.appendChild(st);
  }

  // ═══════════════════════════════════════════════════════════
  // Активность вкладки (resize редактора при показе)
  // ═══════════════════════════════════════════════════════════
  function installTabWatcher() {
    const stages = document.querySelectorAll('.stage');
    if (!stages.length) return;
    const mo = new MutationObserver(() => {
      const seg = document.querySelector('.stage[data-stage="segment"]');
      if (seg && seg.classList.contains('active') && editor && editor.onShow) editor.onShow();
    });
    stages.forEach((s) => mo.observe(s, { attributes: true, attributeFilter: ['class'] }));
  }

  window.addEventListener('DOMContentLoaded', () => {
    setupStaticUI();
    installTabWatcher();
  });

  window.Tab0Segment = { run: runInfer, exportNseg };
})();
