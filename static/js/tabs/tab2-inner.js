/* ─── tabs/tab2-inner ──────────────────────────────────────────
   Этап 2: автосегментация + редактирование слизистой.

   Mouse-семантика (заложена внутри редактора):
     ЛКМ        — применить активный инструмент (Кисть / Стереть)
     ПКМ        — вращение меша         (ремаппится на LMB-orbit viewer'а)
     Shift+ЛКМ  — сдвиг (панорама)      (родной viewer pan)
     Колесо     — зум                   (родной viewer zoom)
     Esc        — снять инструмент (вернуть ЛКМ-orbit как на таб 1)

   КАК РАБОТАЕТ RMB→orbit ремап:
     Viewer по дефолту: LMB=orbit, RMB=pan. Нам нужно при активном
     инструменте сделать LMB=tool и RMB=orbit. Делаем так:
       - Editor слушает mousedown на WINDOW в capture-фазе.
         capture на window фаза идёт раньше, чем target-фаза на канвасе,
         где зарегистрированы viewer-листенеры. Только так stopPropagation
         действительно их подавляет.
       - На реальный RMB down: stopPropagation + dispatch синтетического
         LMB mousedown (с флагом _editorRemap=true). Viewer получает
         синтетик и входит в orbit.
       - На реальный LMB: применяем инструмент, stopPropagation.
       - Синтетические события с флагом пропускаются нами насквозь,
         чтобы достичь viewer.
──────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  let innerViewer = null;
  let editor = null;

  // ─── Локальный спиннер этапа 02 ──────────────────────────────────────
  // На stage[data-stage="inner"] лежит свой #spinnerInner с тем же
  // классом .spinner-overlay, что и у tab-1-spinner — стили из app.css
  // подхватываются как есть. Эти хелперы заменяют глобальные
  // showSpinner / hideSpinner / setSpinnerText, потому что глобальный
  // #spinner живёт ВНУТРИ stage[data-stage="data"] и при display:none
  // у неактивной вкладки он виден не был — слайдер «как на шаге 1»
  // фактически не появлялся.
  function _showSpinner(text) {
    const sp = document.getElementById('spinnerInner');
    const tx = document.getElementById('spinnerInnerText');
    if (tx) tx.textContent = text || 'Обработка…';
    if (sp) sp.classList.add('show');
  }
  function _setSpinnerText(text) {
    const tx = document.getElementById('spinnerInnerText');
    if (tx) tx.textContent = text || '';
  }
  function _hideSpinner() {
    const sp = document.getElementById('spinnerInner');
    if (sp) sp.classList.remove('show');
  }

  function ensureViewer() {
    if (innerViewer) return innerViewer;
    if (!window.Viewer || !window.Viewer.create) return null;
    const canvas = document.getElementById('gl3d-inner');
    if (!canvas) return null;
    innerViewer = window.Viewer.create(canvas);
    return innerViewer;
  }

  // ═══════════════════════════════════════════════════════════
  // Начальная раскладка DOM (один раз)
  // ═══════════════════════════════════════════════════════════

  function setupStaticUI() {
    const stage = document.querySelector('.stage[data-stage="inner"]');
    if (!stage) return;

    // Скрыть карточку «Запуск» (родная .btn-run жила в .panel.left)
    const leftPanel = stage.querySelector('.panel.left');
    if (leftPanel) {
      const runBtnInLeft = leftPanel.querySelector('.btn-run');
      if (runBtnInLeft) {
        const card = runBtnInLeft.closest('.card');
        if (card) { card.dataset.tab2Hidden = '1'; card.style.display = 'none'; }
      }
    }

    // Кнопка «Запустить сегментацию» в empty-state канваса
    const emptyState = document.getElementById('innerEmpty');
    if (emptyState) {
      emptyState.innerHTML = [
        '<div class="empty-icon" style="color:var(--cyan);opacity:.8">',
          '<svg width="150" height="150" viewBox="-1406 184 10118 10118" xmlns="http://www.w3.org/2000/svg">',
                '<g transform="translate(0,11380) scale(1,-1)" fill="currentColor" stroke="none" opacity="0.55">',
                  '<path d="M3486 10082 c-4 -8 -66 -162 -141 -357 -50 -129 -95 -309 -109 -440 -5 -47 12 -185 47 -370 49 -263 51 -500 6 -705 -6 -25 -17 -83 -25 -130 -8 -47 -28 -139 -44 -205 -61 -253 -80 -331 -85 -370 -4 -22 -12 -65 -20 -95 -61 -243 -89 -608 -64 -850 7 -69 13 -156 14 -195 3 -75 27 -280 50 -410 7 -44 19 -123 25 -175 6 -52 16 -117 21 -145 5 -27 11 -125 14 -216 2 -91 12 -213 21 -270 18 -117 30 -226 43 -409 5 -69 15 -199 21 -290 14 -184 8 -663 -10 -795 -13 -98 -27 -151 -78 -280 -88 -227 -195 -391 -330 -510 -163 -144 -397 -253 -666 -311 -82 -17 -346 -33 -471 -28 -124 5 -323 40 -425 76 -167 59 -190 61 -190 14 0 -30 42 -65 164 -134 84 -48 310 -148 386 -171 230 -68 380 -85 593 -65 274 25 341 34 457 59 139 30 251 53 474 95 156 30 188 33 380 34 272 1 329 -6 541 -69 166 -49 331 -92 390 -100 28 -4 77 -13 110 -21 33 -7 86 -15 118 -18 31 -3 61 -7 66 -10 5 -3 60 -10 123 -16 258 -22 575 42 848 171 322 153 503 270 487 312 -10 27 -47 20 -148 -29 -166 -81 -337 -142 -501 -180 -92 -21 -132 -24 -290 -24 -217 0 -319 14 -508 71 -173 52 -223 76 -390 194 -108 75 -179 149 -270 280 -41 59 -145 261 -170 330 -79 218 -126 378 -149 510 -25 142 -37 577 -22 756 36 412 60 599 131 1044 11 72 22 153 25 180 3 28 9 64 14 80 15 48 33 318 47 675 7 191 -10 544 -32 669 -23 133 -84 397 -115 499 -11 35 -24 95 -30 135 -17 119 -26 168 -42 247 -82 399 -86 444 -58 630 27 177 33 247 33 390 1 176 -14 284 -68 481 -34 127 -128 418 -146 452 -9 18 -43 23 -52 9z"/>',
                  '<path d="M4486 9589 c-93 -62 -318 -335 -409 -498 -74 -132 -135 -295 -163 -438 -22 -110 -25 -145 -20 -248 8 -148 25 -265 69 -465 38 -171 76 -311 112 -410 63 -172 86 -384 86 -795 1 -446 -30 -766 -105 -1102 -14 -62 -30 -152 -36 -200 -7 -48 -18 -113 -25 -143 -13 -54 -44 -251 -44 -280 1 -8 -2 -49 -5 -90 -7 -89 -7 -496 -1 -700 15 -485 85 -734 312 -1115 66 -109 128 -177 236 -256 96 -70 327 -174 442 -199 22 -4 78 -16 125 -26 136 -29 473 -18 649 22 110 25 369 121 447 165 102 59 108 63 249 182 254 213 351 435 300 687 -23 113 -92 290 -125 320 -3 3 -12 18 -20 34 -24 46 -243 269 -307 312 -32 21 -63 44 -70 50 -27 25 -182 93 -232 102 -103 18 -181 -34 -167 -112 7 -34 59 -109 135 -192 130 -144 221 -379 205 -534 -8 -83 -21 -113 -80 -189 -77 -99 -214 -181 -362 -217 -147 -35 -431 5 -583 81 -60 31 -187 125 -237 176 -60 61 -124 160 -138 212 -25 96 -55 348 -51 432 10 212 61 331 214 498 60 66 416 336 546 415 34 21 88 58 119 82 31 25 78 58 105 75 54 33 188 147 218 185 11 14 45 53 75 86 107 119 147 190 195 340 17 54 22 158 10 209 -11 43 -82 177 -118 221 -156 189 -474 325 -757 324 -156 -1 -251 -40 -249 -103 1 -66 51 -122 169 -191 32 -19 92 -62 133 -96 85 -70 118 -125 142 -242 38 -178 -4 -300 -140 -411 -88 -71 -157 -103 -250 -115 -99 -13 -177 -2 -249 33 -140 68 -190 157 -220 391 -20 149 -20 313 0 479 32 278 43 438 43 630 -1 286 -8 325 -125 645 -37 102 -82 226 -99 275 -93 258 -136 479 -135 709 0 268 42 413 224 776 84 166 93 193 72 225 -22 33 -53 32 -110 -6z"/>',
                  '<path d="M2356 9578 c-18 -25 -18 -25 66 -107 74 -72 97 -105 159 -226 79 -155 120 -281 144 -438 17 -113 20 -376 6 -457 -49 -272 -64 -335 -124 -500 -35 -98 -95 -225 -128 -272 -11 -14 -33 -59 -50 -100 -16 -40 -34 -82 -39 -93 -5 -11 -21 -63 -36 -115 -32 -112 -42 -235 -32 -382 9 -120 84 -512 122 -633 61 -193 72 -414 26 -509 -29 -61 -118 -142 -198 -179 -63 -30 -74 -32 -182 -32 -106 0 -120 2 -178 29 -76 35 -120 82 -171 183 -63 127 -85 212 -84 326 2 86 5 106 28 150 36 69 117 152 185 188 55 30 103 61 151 98 33 26 55 104 40 143 -15 40 -97 93 -173 112 -163 40 -392 -2 -538 -98 -101 -67 -221 -188 -257 -261 -81 -160 -96 -339 -42 -498 46 -138 80 -189 213 -321 132 -129 246 -223 472 -385 200 -144 281 -210 394 -323 174 -174 290 -351 324 -498 23 -98 31 -261 17 -365 -13 -89 -55 -250 -72 -271 -5 -6 -15 -29 -23 -50 -35 -101 -160 -257 -261 -328 -68 -47 -115 -71 -235 -118 -154 -60 -324 -48 -533 38 -138 56 -178 89 -222 179 -61 124 -61 250 0 489 18 71 95 231 128 266 40 43 133 173 156 217 27 54 28 122 1 150 -48 53 -174 56 -258 7 -84 -49 -257 -209 -312 -290 -8 -12 -45 -64 -82 -116 -66 -93 -154 -251 -177 -318 -20 -60 -31 -218 -20 -300 27 -197 59 -274 169 -412 107 -132 241 -229 441 -318 220 -98 386 -125 714 -117 191 5 234 9 325 32 220 54 461 208 580 370 129 176 184 279 241 455 80 245 99 479 74 910 -9 146 -20 353 -25 460 -6 107 -14 249 -20 315 -22 265 -30 350 -35 365 -2 8 -9 64 -15 124 -5 60 -14 134 -20 165 -39 220 -64 358 -80 436 -57 274 -71 395 -64 549 8 165 15 198 101 456 87 261 105 327 127 470 54 352 71 688 41 843 -21 113 -97 325 -160 452 -119 238 -283 403 -453 455 -85 27 -127 26 -146 -2z"/>',
                '</g>',
              '</svg>',
        '</div>',
        '<div class="empty-title">Выделение слизистой</div>',
        '<div class="empty-sub" style="max-width:380px;line-height:1.5">',
          'Автоматически отделим слизистую оболочку от наружной ткани. ',
          'Результат затем можно поправить кистью и ластиком.',
        '</div>',
        '<button type="button" class="btn-open-big btn-run" ',
        'style="display:inline-flex;align-items:center;gap:8px;',
                     'margin-top:20px;min-width:260px;justify-content:center">',
        '<svg width="14" height="14" viewBox="0 0 18 18" fill="none">',
          '<path d="M5 4l9 5-9 5V4z" fill="currentColor"/>',
        '</svg>',
        'Запустить сегментацию',
      '</button>',
      ].join('');
    }

    // Делегирование: любая .btn-run или data-act="rerun" внутри стейджа
    stage.addEventListener('click', e => {
      const rr = e.target.closest('[data-act="rerun"]');
      if (rr && !rr.disabled) {
        if (editor) resetMaskToInitial(editor);
        else        runSegment();  // редактора ещё нет — запуск с нуля
        return;
      }
      const run = e.target.closest('.btn-run');
      if (run && !run.disabled) runSegment();
    });

    // Стили для пре-сегментационного состояния — инжектим сразу,
    // чтобы ep-steps-pre / empty-hint / ep-grey работали до первого запуска
    injectPreRunCSS();
  }

  // CSS, нужный ДО установки редактора (empty-state, левая панель пре-сегментации)
  function injectPreRunCSS() {
    if (document.getElementById('editor-prerun-css')) return;
    const s = document.createElement('style');
    s.id = 'editor-prerun-css';
    s.textContent = [
      '.stage[data-stage="inner"] .empty-hint {',
      '  margin-top: 12px; font-size: 11px; color: var(--tx3);',
      '  letter-spacing: 0.12em; text-transform: uppercase;',
      '  font-family: \'Share Tech Mono\',\'Consolas\',\'Menlo\',monospace;',
      '  opacity: 0.7;',
      '}',

      /* Нумерованный список «Как это работает» в левой панели до запуска */
      '.stage[data-stage="inner"] .ep-steps-pre {',
      '  list-style: none; padding: 0; margin: 0;',
      '  font-size: 12.5px; line-height: 1.55;',
      '  counter-reset: ep-pre;',
      '}',
      '.stage[data-stage="inner"] .ep-steps-pre li {',
      '  position: relative; padding-left: 26px; margin-bottom: 8px;',
      '  counter-increment: ep-pre;',
      '  color: var(--tx2);',
      '}',
      '.stage[data-stage="inner"] .ep-steps-pre li:last-child { margin-bottom: 0; }',
      '.stage[data-stage="inner"] .ep-steps-pre li::before {',
      '  content: counter(ep-pre);',
      '  position: absolute; left: 0; top: -1px;',
      '  width: 18px; height: 18px;',
      '  display: flex; align-items: center; justify-content: center;',
      '  font-size: 10px; font-weight: 700;',
      '  color: var(--cyan);',
      '  background: rgba(0,240,255,0.08);',
      '  border: 1px solid var(--brd-glow);',
      '  border-radius: 50%;',
      '  font-family: \'Share Tech Mono\',\'Consolas\',monospace;',
      '}',
      '.stage[data-stage="inner"] .ep-steps-pre b { color: var(--cyan); font-weight: 600; }',
      '.stage[data-stage="inner"] .ep-grey { color: var(--tx3); font-weight: 500; }',

      /* light-theme — синий #4F7CDB */
      '.light-theme .stage[data-stage="inner"] .ep-steps-pre li::before {',
      '  background: rgba(79,124,219,0.08);',
      '  border-color: rgba(79,124,219,0.3);',
      '  color: #4F7CDB;',
      '}',
      '.light-theme .stage[data-stage="inner"] .ep-steps-pre b { color: #4F7CDB; }',
    ].join('\n');
    document.head.appendChild(s);
  }

  // ═══════════════════════════════════════════════════════════
  // SSE сегментация + установка редактора
  // ═══════════════════════════════════════════════════════════

  function resetMaskToInitial(ed) {
    if (!ed || !ed.state) return;
    const s = ed.state;
    if (!s.initialMask || !s.mask) return;

    let identical = s.initialMask.length === s.mask.length;
    if (identical) {
      for (let i = 0; i < s.mask.length; i++) {
        if (s.mask[i] !== s.initialMask[i]) { identical = false; break; }
      }
    }
    if (identical) {
      if (typeof toast === 'function') {
        toast('Маска уже совпадает с исходной автосегментацией', 'info', 2500);
      }
      return;
    }
    if (typeof ed.pushHistory === 'function') ed.pushHistory();
    s.mask.set(s.initialMask);
    if (typeof ed.refreshColors === 'function') ed.refreshColors();
    if (typeof toast === 'function') {
      toast('<strong>Выделение возвращено</strong> к исходной автосегментации ', 'ok', 3500, { html: true });
    }
  }

  async function runSegment() {
    if (editor) { editor.dispose(); editor = null; }

    // ─── Инвалидация вниз по пайплайну ──────────────────────────────
    // Перезапуск сегментации означает: старый inner и всё, что на нём
    // было построено (V/F для tab3, зоны, развёртка), становятся
    // неактуальны. Сбрасываем их до запуска — чтобы пока спиннер
    // крутится, гейт 03/04 был закрыт и поля в window.M не могли
    // случайно быть прочитаны как валидные.
    //
    // NB: сам editor.dispose() выше не трогает window.M — нужно вручную.
    //
    invalidateDownstreamFromInner();

    const stage = document.querySelector('.stage[data-stage="inner"]');
    const allRunBtns = stage
      ? stage.querySelectorAll('.btn-run, [data-act="rerun"]')
      : [];
    allRunBtns.forEach(b => b.disabled = true);

    showSpinner('Старт сегментации…');
    _showSpinner('Старт сегментации…');
    try {
      const r = await fetch('/api/segment/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
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
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = chunk.split('\n').find(s => s.startsWith('data:'));
          if (!line) continue;
          let payload;
          try { payload = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
          if      (payload.stage) { setSpinnerText(payload.stage); _setSpinnerText(payload.stage); }
          else if (payload.error) lastError = payload.error;
          else if (payload.ok)    finalMsg  = payload;
        }
      }

      if (lastError) throw new Error(lastError);
      if (!finalMsg) throw new Error('Поток оборвался без результата');

      setSpinnerText('Загрузка мешей…');
      _setSpinnerText('Загрузка мешей…');
      await yieldUI();

      const [cleanR, innerR] = await Promise.all([
        fetch('/api/session/mesh_clean'),
        fetch('/api/session/inner_surface'),
      ]);
      if (!cleanR.ok) throw new Error('mesh_clean: HTTP ' + cleanR.status);
      if (!innerR.ok) throw new Error('inner_surface: HTTP ' + innerR.status);
      const [cleanText, innerText] = await Promise.all(
        [cleanR.text(), innerR.text()]
      );

      setSpinnerText('Инициализация редактора…');
      _setSpinnerText('Инициализация редактора…');
      await yieldUI();

      const v = ensureViewer();
      if (!v) throw new Error('viewer init failed');

      editor = Editor.install(v, cleanText, innerText);

      window.M.innerV  = editor.full.V;
      window.M.innerF  = editor.full.F;
      window.M.innerNV = editor.full.V.length / 3;
      window.M.innerNF = editor.fd.nF;

      const canvas = document.getElementById('gl3d-inner');
      const emptyInner = document.getElementById('innerEmpty');
      const viewport = document.getElementById('viewportInner');
      if (canvas)     canvas.style.display = 'block';
      if (emptyInner) emptyInner.style.display = 'none';
      if (viewport)   viewport.classList.add('has-mesh');

      window.dispatchEvent(new CustomEvent('data:change', {
        detail: { kind: 'segment-done' },
      }));

      hideSpinner();
      _hideSpinner();
      toast(
          '<strong>Автосегментация готова:</strong> ' +
        editor.initialMatched.toLocaleString('ru') +
        ' фейсов. Поверните меш ПКМ, чтобы увидеть внутреннюю поверхность.',
        'ok', 6000, { html: true }
      );
    } catch (err) {
      hideSpinner();
      _hideSpinner();
      console.error('[tab2-inner]', err);
      toast('<strong>Ошибка сегментации:</strong> ' + err.message, 'err', 8000, { html: true });
    } finally {
      allRunBtns.forEach(b => b.disabled = false);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Активность viewer'ов
  // ═══════════════════════════════════════════════════════════

  function syncActiveStates() {
    const stageData  = document.querySelector('.stage[data-stage="data"]');
    const stageInner = document.querySelector('.stage[data-stage="inner"]');
    const p = window.Viewer && window.Viewer.primary && window.Viewer.primary();

    if (stageData && p && p.setActive) {
      p.setActive(stageData.classList.contains('active'));
    }
    if (stageInner && innerViewer) {
      innerViewer.setActive(stageInner.classList.contains('active'));
      if (stageInner.classList.contains('active')) innerViewer.resize();
    }
  }

  function installTabWatcher() {
    const stages = document.querySelectorAll('.stage');
    if (!stages.length) return;
    const mo = new MutationObserver(syncActiveStates);
    stages.forEach(s =>
      mo.observe(s, { attributes: true, attributeFilter: ['class'] })
    );
    syncActiveStates();
  }

  window.addEventListener('DOMContentLoaded', () => {
    setupStaticUI();
    installTabWatcher();
  });

  window.Tab2Inner = { run: runSegment };



  const Editor = (function () {

    function readAccentColor() {
      const raw = getComputedStyle(document.documentElement)
        .getPropertyValue('--accent').trim();
      try { return new THREE.Color(raw || '#4a9eff'); }
      catch (_) { return new THREE.Color(0x4a9eff); }
    }
    const COLOR_UNSEL = new THREE.Color(0x9aa2ae);

    const TOOL_LABELS = { paint: 'Кисть', erase: 'Стереть' };

    // ─── OBJ parse + FaceData + initial match + OBJ build ──────
    function parseOBJ(text) {
      const V = [], F = [];
      const lines = text.split(/\r?\n/);
      for (let li = 0; li < lines.length; li++) {
        const l = lines[li];
        if (l.length < 2) continue;
        const c0 = l.charCodeAt(0);
        if (c0 === 118 && l.charCodeAt(1) === 32) {
          const p = l.split(/\s+/);
          V.push(+p[1], +p[2], +p[3]);
        } else if (c0 === 102 && l.charCodeAt(1) === 32) {
          const p = l.trim().split(/\s+/);
          const n = p.length - 1;
          const ids = new Array(n);
          for (let k = 0; k < n; k++) {
            const t = p[k + 1];
            const s = t.indexOf('/');
            ids[k] = (s === -1 ? +t : +t.slice(0, s)) - 1;
          }
          for (let k = 1; k < n - 1; k++) F.push(ids[0], ids[k], ids[k + 1]);
        }
      }
      return { V: new Float32Array(V), F: new Uint32Array(F) };
    }

    function buildFaceData(V, F) {
      const nF = F.length / 3;
      const positions = new Float32Array(nF * 9);
      const normals   = new Float32Array(nF * 9);
      const colors    = new Float32Array(nF * 9);
      const fc = new Float32Array(nF * 3);
      const areas = new Float32Array(nF);
      let totalArea = 0;

      for (let f = 0; f < nF; f++) {
        const i0 = F[f*3]*3, i1 = F[f*3+1]*3, i2 = F[f*3+2]*3;
        const ax=V[i0], ay=V[i0+1], az=V[i0+2];
        const bx=V[i1], by=V[i1+1], bz=V[i1+2];
        const cx=V[i2], cy=V[i2+1], cz=V[i2+2];
        const o = f * 9;
        positions[o  ]=ax; positions[o+1]=ay; positions[o+2]=az;
        positions[o+3]=bx; positions[o+4]=by; positions[o+5]=bz;
        positions[o+6]=cx; positions[o+7]=cy; positions[o+8]=cz;

        let nx = (by-ay)*(cz-az) - (bz-az)*(cy-ay);
        let ny = (bz-az)*(cx-ax) - (bx-ax)*(cz-az);
        let nz = (bx-ax)*(cy-ay) - (by-ay)*(cx-ax);
        const crossLen = Math.hypot(nx, ny, nz);
        const L = crossLen || 1;
        nx/=L; ny/=L; nz/=L;
        for (let k=0; k<3; k++) {
          normals[o+k*3  ]=nx; normals[o+k*3+1]=ny; normals[o+k*3+2]=nz;
        }
        fc[f*3  ]=(ax+bx+cx)/3;
        fc[f*3+1]=(ay+by+cy)/3;
        fc[f*3+2]=(az+bz+cz)/3;
        const a = crossLen * 0.5;
        areas[f] = a;
        totalArea += a;
      }


      const edgeMap = new Map();
      const pushE = (a, b, f) => {
        const lo=a<b?a:b, hi=a<b?b:a;
        const key = lo * 16777216 + hi;
        let arr = edgeMap.get(key);
        if (!arr) { arr=[]; edgeMap.set(key, arr); }
        arr.push(f);
      };
      for (let f=0; f<nF; f++) {
        const a=F[f*3], b=F[f*3+1], c=F[f*3+2];
        pushE(a,b,f); pushE(b,c,f); pushE(c,a,f);
      }
      const nbrCnt = new Int32Array(nF);
      edgeMap.forEach(arr => {
        if (arr.length === 2) { nbrCnt[arr[0]]++; nbrCnt[arr[1]]++; }
      });
      const nbrOff = new Int32Array(nF + 1);
      for (let i=0; i<nF; i++) nbrOff[i+1] = nbrOff[i] + nbrCnt[i];
      const nbrIdx = new Int32Array(nbrOff[nF]);
      const cur = new Int32Array(nF);
      edgeMap.forEach(arr => {
        if (arr.length === 2) {
          const a=arr[0], b=arr[1];
          nbrIdx[nbrOff[a] + cur[a]++] = b;
          nbrIdx[nbrOff[b] + cur[b]++] = a;
        }
      });

      return { positions, normals, colors, fc, nbrOff, nbrIdx, nF,
               areas, totalArea };
    }

    function matchInitialSelection(fullFC, initialFC, nF) {
      let mn=[ Infinity, Infinity, Infinity];
      let mx=[-Infinity,-Infinity,-Infinity];
      for (let i=0; i<nF; i++) {
        for (let k=0; k<3; k++) {
          const x = fullFC[i*3+k];
          if (x < mn[k]) mn[k] = x;
          if (x > mx[k]) mx[k] = x;
        }
      }
      const diag = Math.hypot(mx[0]-mn[0], mx[1]-mn[1], mx[2]-mn[2]);
      const cell = Math.max(diag / 200, 1e-3);
      const key = (ix,iy,iz) =>
        (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791);

      const map = new Map();
      for (let f=0; f<nF; f++) {
        const ix = Math.floor(fullFC[f*3]   / cell);
        const iy = Math.floor(fullFC[f*3+1] / cell);
        const iz = Math.floor(fullFC[f*3+2] / cell);
        const k = key(ix,iy,iz);
        let arr = map.get(k);
        if (!arr) { arr=[]; map.set(k, arr); }
        arr.push(f);
      }

      const mask = new Uint8Array(nF);
      const tol  = Math.max(1e-3, diag * 1e-5);
      const tol2 = tol * tol;
      const n2   = initialFC.length / 3;
      let matched = 0;

      for (let j=0; j<n2; j++) {
        const x=initialFC[j*3], y=initialFC[j*3+1], z=initialFC[j*3+2];
        const ix=Math.floor(x/cell), iy=Math.floor(y/cell), iz=Math.floor(z/cell);
        let best=-1, bestD=tol2;
        for (let dx=-1; dx<=1; dx++)
        for (let dy=-1; dy<=1; dy++)
        for (let dz=-1; dz<=1; dz++) {
          const arr = map.get(key(ix+dx, iy+dy, iz+dz));
          if (!arr) continue;
          for (let i=0; i<arr.length; i++) {
            const f = arr[i];
            const xx=fullFC[f*3], yy=fullFC[f*3+1], zz=fullFC[f*3+2];
            const d2 = (xx-x)*(xx-x)+(yy-y)*(yy-y)+(zz-z)*(zz-z);
            if (d2 < bestD) { bestD = d2; best = f; }
          }
        }
        if (best >= 0 && !mask[best]) { mask[best] = 1; matched++; }
      }
      return { mask, matched, total: n2 };
    }

    function buildOBJ(fd, mask) {
      const pos = fd.positions;
      const lines = ['# inner_surface — edited in nasal-planner'];
      const vMap = new Map();
      const vList = [];
      const faceLines = [];
      for (let f=0; f<fd.nF; f++) {
        if (!mask[f]) continue;
        const idxs = [];
        for (let k=0; k<3; k++) {
          const x = pos[f*9+k*3];
          const y = pos[f*9+k*3+1];
          const z = pos[f*9+k*3+2];
          const key = x.toFixed(6)+','+y.toFixed(6)+','+z.toFixed(6);
          let idx = vMap.get(key);
          if (idx === undefined) {
            vList.push(x, y, z);
            idx = vList.length / 3;
            vMap.set(key, idx);
          }
          idxs.push(idx);
        }
        faceLines.push('f '+idxs[0]+' '+idxs[1]+' '+idxs[2]);
      }
      for (let i=0; i<vList.length; i+=3) {
        lines.push('v '+vList[i].toFixed(6)+' '+
                       vList[i+1].toFixed(6)+' '+
                       vList[i+2].toFixed(6));
      }
      lines.push(...faceLines);
      return lines.join('\n');
    }

    // ─── Операции ──────────────────────────────────────────────
    function refreshColors(s) {
      const c = s.fd.colors;
      for (let f=0; f<s.fd.nF; f++) {
        const col = s.mask[f] ? s.colorSel : COLOR_UNSEL;
        const o = f * 9;
        for (let k=0; k<3; k++) {
          c[o+k*3  ] = col.r;
          c[o+k*3+1] = col.g;
          c[o+k*3+2] = col.b;
        }
      }
      s.geom.attributes.color.needsUpdate = true;
      updateStats(s);
    }
    function pushHistory(s) {
      s.history.push(new Uint8Array(s.mask));
      if (s.history.length > 50) s.history.shift();
    }
    function undo(s) {
      if (!s.history.length) return;
      s.mask = s.history.pop();
      refreshColors(s);
    }
    function brushAt(s, seed, value) {
      const { nbrOff, nbrIdx, nF } = s.fd;
      const depth = new Int32Array(nF); depth.fill(-1);
      depth[seed] = 0;
      const q = [seed];
      let head = 0;
      while (head < q.length) {
        const f = q[head++];
        s.mask[f] = value;
        if (depth[f] >= s.radius) continue;
        const o0=nbrOff[f], o1=nbrOff[f+1];
        for (let k=o0; k<o1; k++) {
          const nb = nbrIdx[k];
          if (depth[nb] === -1) { depth[nb] = depth[f]+1; q.push(nb); }
        }
      }
    }

    const _ray = new THREE.Raycaster();
    const _m = new THREE.Vector2();
    function pickFace(s, cx, cy) {
      const canvas = s.viewer.canvas;
      const r = canvas.getBoundingClientRect();
      _m.x =  ((cx - r.left) / r.width)  * 2 - 1;
      _m.y = -((cy - r.top)  / r.height) * 2 + 1;
      _ray.setFromCamera(_m, s.viewer.camera);
      const hits = _ray.intersectObject(s.threeMesh, false);
      return hits.length ? hits[0].faceIndex : -1;
    }

    function applyTool(s, cx, cy, isDrag) {
      const f = pickFace(s, cx, cy);
      if (f < 0) return;
      if (!isDrag) pushHistory(s);
      brushAt(s, f, s.tool === 'paint' ? 1 : 0);
      refreshColors(s);
    }

    // ─── Мышь: window + capture → получаем РАНЬШЕ viewer'а ─────
    //
    // Viewer слушает mousedown на canvas (target-фаза). Наш editor
    // слушает mousedown на window в capture-фазе — это гарантированно
    // раньше любых target-listeners на canvas. Только так stopPropagation
    // реально подавит viewer.

    function installInput(s) {
      const canvas = s.viewer.canvas;
      const isOnCanvas = e => e.target === canvas || canvas.contains(e.target);

      const onDown = e => {
        // Синтетический event (наш же re-dispatch) — пропускаем насквозь
        if (e._editorRemap) return;
        if (!isOnCanvas(e)) return;

        // ПКМ с активным инструментом → перехват, синтетический LMB в viewer
        if (e.button === 2 && s.tool && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          const syn = new MouseEvent('mousedown', {
            bubbles: true, cancelable: true, view: window,
            button: 0, buttons: 1,
            clientX: e.clientX, clientY: e.clientY,
          });
          syn._editorRemap = true;
          canvas.dispatchEvent(syn);
          return;
        }

        // ЛКМ без инструмента / с модификатором → viewer (orbit/pan)
        if (e.button !== 0) return;
        if (!s.tool) return;
        if (e.shiftKey || e.altKey) return;

        // ЛКМ с инструментом → применяем
        s.dragging = true;
        applyTool(s, e.clientX, e.clientY, false);
        e.preventDefault();
        e.stopPropagation();
      };

      const onMove = e => {
        if (!s.dragging) return;
        applyTool(s, e.clientX, e.clientY, true);
        e.stopPropagation();
      };

      const onUp = e => {
        if (!s.dragging) return;
        s.dragging = false;
        e.stopPropagation();
      };

      const onKey = e => {
        if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
        if (e.ctrlKey || e.metaKey) {
          if (e.key === 'z' || e.key === 'Z') { undo(s); e.preventDefault(); }
          return;
        }
        if      (e.key === 'Escape')                 setTool(s, null);
        else if (e.key === 'b' || e.key === 'B')     setTool(s, 'paint');
        else if (e.key === 'e' || e.key === 'E')     setTool(s, 'erase');
      };

      window.addEventListener('mousedown', onDown, true);
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup',   onUp,   true);
      window.addEventListener('keydown',   onKey);

      const onTheme = () => {
        s.colorSel = readAccentColor();
        refreshColors(s);
      };
      window.addEventListener('theme:change', onTheme);

      return () => {
        window.removeEventListener('mousedown', onDown, true);
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('mouseup',   onUp,   true);
        window.removeEventListener('keydown',   onKey);
        window.removeEventListener('theme:change', onTheme);
      };
    }

    function setTool(s, name) {
      // toggle клик по активному = снять
      if (s.tool === name) name = null;
      s.tool = name;
      s.dragging = false;

      if (!s.uiLeft) return;
      s.uiLeft.querySelectorAll('[data-tool]').forEach(el => {
        el.classList.toggle('active', el.dataset.tool === name);
      });

      const hint = s.uiLeft.querySelector('[data-mode-hint]');
      if (hint) {
        hint.innerHTML = name
          ? '<b>' + TOOL_LABELS[name] + '.</b> ЛКМ — применить, ПКМ — повернуть меш.'
          : '<b>Навигация.</b> ЛКМ — вращать, ПКМ / Shift+ЛКМ — сдвиг.';
      }

      const canvas = s.viewer.canvas;
      if (canvas) canvas.style.cursor = name ? 'crosshair' : '';
    }

    function updateStats(s) {
      if (!s.uiRight) return;
      let selFaces = 0, selArea = 0;
      const areas = s.fd.areas;
      for (let f=0; f<s.fd.nF; f++) {
        if (!s.mask[f]) continue;
        selFaces++;
        selArea += areas[f];
      }
      const totalFaces = s.fd.nF;
      const totalArea  = s.fd.totalArea;
      const pct = (100 * selArea / Math.max(totalArea, 1e-9)).toFixed(1);

      const setTxt = (sel_, txt) => {
        const el = s.uiRight.querySelector(sel_);
        if (el) el.textContent = txt;
      };
      const ru = n => n.toLocaleString('ru');
      const ru0 = n => n.toLocaleString('ru', { maximumFractionDigits: 0 });
      setTxt('[data-stat="faces"]', ru(selFaces) + '  /  ' + ru(totalFaces));
      setTxt('[data-stat="area"]',  ru0(selArea) + '  /  ' + ru0(totalArea) + ' мм²');
      setTxt('[data-stat="pct"]',   pct + ' %');

      // Топология (обновляется только после successful finalize)
      if (s.lastReport) {
        setTxt('[data-stat="topology"]', s.lastReportLabel || '—');
        const el = s.uiRight.querySelector('[data-stat="topology"]');
        if (el) {
          el.classList.remove('ep-topo-ok', 'ep-topo-warn');
          if (s.lastReport.disk_ready) el.classList.add('ep-topo-ok');
          else                         el.classList.add('ep-topo-warn');
        }
      }
    }

    // ─── Экспорт: скачать текущую маску как .obj ──────────────
    // Использует buildOBJ (тот же что и для save). Файл отдаётся
    // клиенту через Blob + <a download>. Никаких серверных вызовов —
    // чисто локальная операция.
    function exportMaskAsOBJ(s) {
      let cnt = 0;
      for (let i = 0; i < s.fd.nF; i++) if (s.mask[i]) cnt++;
      if (cnt < 1) {
        if (typeof toast === 'function')
          toast('Нечего экспортировать — выделение пустое', 'err', 3000);
        return;
      }

      const objText = buildOBJ(s.fd, s.mask);
      const blob = new Blob([objText], { type: 'text/plain' });
      const filename = 'inner_surface.obj';

      const notifyOK = () => {
        if (typeof toast === 'function') {
          toast(
            '<strong>Экспорт</strong>: ' + cnt.toLocaleString('ru') +
            ' фейсов → ' + filename,
            'ok', 3000, { html: true }
          );
        }
      };
      const notifyErr = err => {
        if (typeof toast === 'function')
          toast('<strong>Ошибка экспорта</strong>: ' +
                (err && err.message ? err.message : err),
                'err', 5000, { html: true });
      };

      // Метод 1: File System Access API (нативный диалог «Сохранить как»)
      // Работает в pywebview на Chromium >= 86 и в современных браузерах.
      if (window.showSaveFilePicker) {
        (async () => {
          try {
            const handle = await window.showSaveFilePicker({
              suggestedName: filename,
              types: [{
                description: 'Wavefront OBJ',
                accept: { 'text/plain': ['.obj'] },
              }],
            });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            notifyOK();
          } catch (err) {
            // AbortError = пользователь закрыл диалог, не ошибка
            if (err && err.name === 'AbortError') return;
            notifyErr(err);
          }
        })();
        return;
      }

      // Метод 2: классический <a download> (не работает в pywebview без API)
      try {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1500);
        notifyOK();
      } catch (err) {
        notifyErr(err);
      }
    }

    // ─── Импорт: подгрузить .obj как новую маску ──────────────
    // Открывает диалог выбора файла, читает как текст, парсит OBJ,
    // сопоставляет фейсы по центроидам с mesh_clean. Работает только
    // если импортируемый .obj — submesh того же mesh_clean (координаты
    // вершин должны совпадать bit-exact). Для произвольного меша
    // сопоставление не удастся — сообщаем об этом.
    function importMaskFromFile(s) {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.obj,model/obj,text/plain';
      inp.style.display = 'none';
      document.body.appendChild(inp);
      inp.addEventListener('change', async e => {
        const file = e.target.files && e.target.files[0];
        document.body.removeChild(inp);
        if (!file) return;
        try {
          const text = await file.text();
          const parsed = parseOBJ(text);
          if (!parsed.F.length) {
            throw new Error('в файле нет треугольных фейсов');
          }
          // Centroid matching — тот же приём что при начальной загрузке
          const fdIn = buildFaceData(parsed.V, parsed.F);
          const { mask: newMask, matched, total } =
            matchInitialSelection(s.fd.fc, fdIn.fc, s.fd.nF);
          if (matched === 0) {
            throw new Error(
              'ни один фейс не совпал с mesh_clean — возможно, OBJ ' +
              'получен из другого исходного меша'
            );
          }
          pushHistory(s);
          s.mask = newMask;
          refreshColors(s);
          const pct = (100 * matched / total).toFixed(1);
          const kind = matched === total ? 'ok' : 'warn';
          const msg = matched === total
            ? 'Импорт: ' + matched.toLocaleString('ru') + ' фейсов (100%)'
            : 'Импорт: ' + matched.toLocaleString('ru') + ' из ' +
              total.toLocaleString('ru') + ' (' + pct + '%). ' +
              'Несопоставленные фейсы пропущены — OBJ не полностью ' +
              'соответствует текущему mesh_clean.';
          if (typeof toast === 'function') toast(msg, kind, 5000);
        } catch (err) {
          console.error('[tab2-inner] import', err);
          if (typeof toast === 'function')
            toast('Импорт не удался: ' + err.message, 'err', 5500);
        }
      });
      inp.click();
    }

    // ─── Сохранение с пост-обработкой под развёртку ───────────
    // Последовательно:
    //   1. PUT сырой маски в session  (страховка: не теряем работу
    //      если finalize упадёт)
    //   2. POST /api/segment_finalize (sync, быстро)
    //   3. GET обновлённого inner_surface + finalize_report
    //   4. Перестраиваем state.mask через тот же centroid-matching,
    //      что использует install(). pushHistory — чтобы Ctrl+Z
    //      откатил очистку, если врачу не понравилась.
    //   5. Показываем отчёт + ставим флажок disk-ready в «Выделение».
    async function saveAndFinalize(s, saveBtn, onSuccess) {
      // guard: совсем пустая маска
      let selCnt = 0;
      for (let i=0; i<s.fd.nF; i++) if (s.mask[i]) selCnt++;
      if (selCnt < 10) {
        if (typeof toast === 'function')
          toast('Выделите хотя бы 10 фейсов перед сохранением', 'err', 3500);
        return;
      }

      saveBtn.disabled = true;
      const origBtnHTML = saveBtn.innerHTML;
      const setBtn = txt =>
        saveBtn.innerHTML = '<span style="opacity:.85">' + txt + '</span>';

      try {
        // 1. PUT
        setBtn('Сохранение…');
        const obj = buildOBJ(s.fd, s.mask);
        const form = new FormData();
        form.append('file',
          new Blob([obj], { type: 'text/plain' }),
          'inner_surface.obj'
        );
        const putR = await fetch('/api/session/inner_surface', {
          method: 'PUT', body: form,
        });
        if (!putR.ok) throw new Error('сохранение: HTTP ' + putR.status);

        // 2. Finalize (постобработка под развёртку)
        setBtn('Проверка топологии…');
        const finR = await fetch('/api/segment_finalize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (!finR.ok) {
          const j = await finR.json().catch(() => ({}));
          throw new Error(j.error || 'finalize: HTTP ' + finR.status);
        }

        // 3. Забираем отчёт + очищенный меш параллельно
        const [reportR, meshR] = await Promise.all([
          fetch('/api/session/finalize_report'),
          fetch('/api/session/inner_surface'),
        ]);
        let report = {};
        try { report = await reportR.json(); } catch (_) {}
        const newMeshText = await meshR.text();

        // 4. Перестройка state.mask через centroid-matching
        const newParsed = parseOBJ(newMeshText);
        if (!newParsed.F.length) throw new Error('после finalize меш пустой');
        const newFD = buildFaceData(newParsed.V, newParsed.F);
        const { mask: newMask } =
          matchInitialSelection(s.fd.fc, newFD.fc, s.fd.nF);

        pushHistory(s);
        s.mask = newMask;
        s.lastReport = report;
        s.lastReportLabel = topologyLabel(report);
        refreshColors(s);          // refreshColors зовёт updateStats

        // 5. Прокинуть inner_surface дальше по пайплайну
        //    (a) обновляем глобальный window.M — снимок in-memory
        //        состояния, на который подписаны таб 3/4.
        //    (b) снимаем блокировку с вкладки «Зоны носа». Делаем это
        //        агрессивно, потому что в разных вариантах разметки
        //        "заблокированность" может быть реализована по-разному:
        //          · HTML-атрибут disabled
        //          · DOM-property .disabled (только для <button>)
        //          · aria-disabled
        //          · CSS-класс .disabled / .is-locked / .locked / ...
        //          · внутренний Set в tabs.js (API: Tabs.unlock(name))
        //        Снимаем все, какие знаем. В консоли оставляем диагностику,
        //        чтобы при необходимости можно было посмотреть что реально
        //        в разметке стоит.
        //    (c) dispatch data:change — пусть контроллеры обновятся.
        window.M.innerV  = newParsed.V;
        window.M.innerF  = newParsed.F;
        window.M.innerNV = newParsed.V.length / 3;
        window.M.innerNF = newParsed.F.length / 3;
        // ─── ВАЖНО: коммит активного меша (открывает гейт таба 3) ───
        // tabs.js gate: zones: () => !!window.M.V
        window.M.V  = newParsed.V;
        window.M.F  = newParsed.F;
        window.M.nV = newParsed.V.length / 3;
        window.M.nF = newParsed.F.length / 3;

        const zonesTab = document.querySelector('.tab[data-tab="zones"]');
        let zonesWasLocked = false;
        if (zonesTab) {
          zonesWasLocked =
            zonesTab.hasAttribute('disabled') ||
            zonesTab.getAttribute('aria-disabled') === 'true' ||
            zonesTab.classList.contains('disabled') ||
            zonesTab.classList.contains('is-disabled') ||
            zonesTab.classList.contains('is-locked') ||
            zonesTab.classList.contains('locked');

          // Диагностика (видно в DevTools Console)
          try {
            console.log(
              '[tab2-inner] zones tab BEFORE unlock:',
              zonesTab.outerHTML.slice(0, 300)
            );
          } catch (_) {}


          zonesTab.removeAttribute('disabled');
          zonesTab.removeAttribute('aria-disabled');
          // DOM property (для <button>)
          if ('disabled' in zonesTab) {
            try { zonesTab.disabled = false; } catch (_) {}
          }
          // Возможные классы блокировки
          ['disabled', 'is-disabled', 'is-locked', 'locked', 'tab-disabled']
            .forEach(c => zonesTab.classList.remove(c));
          // Попробовать API tabs.js, если такой есть
          try {
            if (window.Tabs && typeof window.Tabs.unlock === 'function') {
              window.Tabs.unlock('zones');
            } else if (window.Tabs && typeof window.Tabs.enable === 'function') {
              window.Tabs.enable('zones');
            }
          } catch (_) {}
          // Событие — на случай если tabs.js слушает свой custom-event
          zonesTab.dispatchEvent(new CustomEvent('tab:unlock', { bubbles: true }));
          window.dispatchEvent(new CustomEvent('tab:unlock', {
            detail: { name: 'zones', tab: zonesTab },
          }));

          try {
            console.log(
              '[tab2-inner] zones tab AFTER unlock:',
              zonesTab.outerHTML.slice(0, 300)
            );
          } catch (_) {}
        } else {
          console.warn(
            '[tab2-inner] не нашёл .tab[data-tab="zones"] — проверьте ',
            'разметку, возможно атрибут data-tab у вкладки зон называется ',
            'иначе. Текущие табы:',
            Array.from(document.querySelectorAll('.tab'))
              .map(t => t.getAttribute('data-tab'))
          );
        }

        window.dispatchEvent(new CustomEvent('data:change', {
          detail: {
            kind: 'inner:saved',
            disk_ready: !!report.disk_ready,
            faces: newParsed.F.length / 3,
          },
        }));

        // 6. Toast с результатом + подсказка о следующем шаге
        let summary = formatReportToast(report);
        if (zonesWasLocked) {
          summary += ' Вкладка «Зоны носа» разблокирована.';
        }
        const kind = report.disk_ready ? 'ok' : 'warn';
        if (typeof toast === 'function') toast(summary, kind, 7500, { html: true });

        // Явный вызов refreshGates на случай если data:change его не вытянет
        try {
          if (window.Tabs && typeof window.Tabs.refreshGates === 'function') {
            window.Tabs.refreshGates();
          }
        } catch (_) {}

        setBtn('✓ Готово');

        // Если задан onSuccess — вызываем
        if (typeof onSuccess === 'function') {
          try { onSuccess(); } catch (_) {}
        }
        setTimeout(() => {
          saveBtn.innerHTML = origBtnHTML;
          saveBtn.disabled = false;
        }, 1800);

      } catch (err) {
        saveBtn.innerHTML = origBtnHTML;
        saveBtn.disabled = false;
        console.error('[tab2-inner] save', err);
        if (typeof toast === 'function') {
          toast('Ошибка: ' + err.message, 'err', 6000);
        }
      }
    }

    // Короткий label для строки «Топология» в карточке «Выделение»
    function topologyLabel(r) {
      if (!r || !r.topology) return '—';
      if (r.topology === 'disk')   return '✓ диск (готово)';
      if (r.topology === 'closed') return '⚠ замкнута (нужен разрез)';
      if (r.boundary_loops >= 2 && r.topology.startsWith('genus0_'))
        return '⚠ ' + r.boundary_loops + ' границы';
      if (r.topology.startsWith('genus'))
        return '⚠ тоннель (genus>0)';
      return r.topology;
    }

    // Развёрнутый текст для toast
    function formatReportToast(r) {
      if (!r || !r.topology) return 'Сохранено.';
      const parts = [];

      // Что изменилось
      const changes = [];
      if (r.removed_small_components_faces > 0) {
        changes.push(
          'убрано ' + r.removed_small_components_faces +
          ' ф. мелких компонент'
        );
      }
      if (r.removed_hair_faces > 0) {
        changes.push('убрано ' + r.removed_hair_faces + ' «усиков»');
      }
      if (r.filled_hole_faces > 0) {
        changes.push('закрыто ' + r.filled_hole_faces + ' ф. дыр');
      }
      if (changes.length) {
        parts.push('Очистка: ' + changes.join(', ') + '.');
      } else {
        parts.push('Маска без правок.');
      }

      // Топология
      if (r.topology === 'disk') {
        parts.push('Топология: диск, 1 граница — готово к развёртке.');
      } else if (r.topology === 'closed') {
        parts.push(
          'Топология: замкнутая поверхность. Для развёртки нужен разрез ' +
          '(«Ластиком» вдоль анатомической линии).'
        );
      } else if (r.boundary_loops >= 2 && r.topology.startsWith('genus0_')) {
        parts.push(
          'Границ: ' + r.boundary_loops + '. Развёртка возможна, ' +
          'но возможны лёгкие искажения по краям.'
        );
      } else if (r.topology.startsWith('genus')) {
        parts.push(
          'Обнаружен тоннель. Для корректной развёртки нужен разрез — ' +
          '«Ластиком» поперёк узкого места.'
        );
      }

      return parts.join(' ');
    }

    // ─── UI панели ─────────────────────────────────────────────
    function installUI(s) {
      const stage = document.querySelector('.stage[data-stage="inner"]');
      if (!stage) return { dispose: () => {} };
      const left  = stage.querySelector('.panel.left');
      const right = stage.querySelector('.panel.right');
      if (!left || !right) return { dispose: () => {} };

      const origLeftHTML  = left.innerHTML;
      const origRightHTML = right.innerHTML;

      // ─── LEFT: инструменты, действия, пересчитать, сохранить ───
      left.innerHTML = [
        '<div class="card">',
          '<div class="card-title">Инструмент</div>',
          '<div class="ep-tools">',
            '<button type="button" class="ep-tool active" data-tool="paint" title="Кисть">',
              '<svg class="ep-tool-ico" width="16" height="16" viewBox="0 0 18 18" fill="none">',
                '<path d="M11.5 2.5l4 4-7 7H4.5v-4l7-7z" stroke="currentColor" ',
                       'stroke-width="1.4" stroke-linejoin="round" fill="currentColor" fill-opacity="0.18"/>',
                '<path d="M10 4l4 4" stroke="currentColor" stroke-width="1.4"/>',
              '</svg>',
              '<span class="ep-lab">Кисть</span>',
            '</button>',
            '<button type="button" class="ep-tool" data-tool="erase" title="Стереть">',
              '<svg class="ep-tool-ico" width="16" height="16" viewBox="0 0 18 18" fill="none">',
                '<path d="M11.8 2.5l3.7 3.7a1.4 1.4 0 010 2L8.6 15H5l-2.5-2.5a1.4 1.4 0 010-2L9.8 2.5a1.4 1.4 0 012 0z" ',
                       'stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" ',
                       'fill="currentColor" fill-opacity="0.18"/>',
                '<path d="M6.5 6.5l5 5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
              '</svg>',
              '<span class="ep-lab">Стереть</span>',
            '</button>',
          '</div>',
          '<div class="ep-row">',
            '<label>Радиус</label>',
            '<input type="range" min="1" max="10" value="8" data-input="radius">',
            '<span class="ep-val" data-val="radius">8</span>',
          '</div>',
          '<div class="ep-hint hint-text" data-mode-hint>',
            '<b>Кисть.</b> ЛКМ — применить, ПКМ — повернуть меш.',
          '</div>',
        '</div>',

        '<div class="card">',
          '<div class="card-title">Действия</div>',
          '<div class="ep-actions">',
            '<button type="button" class="ep-act" data-act="undo" title="Отменить">',
              '<svg class="ep-act-ico" width="14" height="14" viewBox="0 0 18 18" fill="none">',
                '<path d="M3 8h7a4 4 0 010 8H7" stroke="currentColor" stroke-width="1.4" ',
                       'stroke-linecap="round" stroke-linejoin="round"/>',
                '<path d="M5.5 5L3 8l2.5 3" stroke="currentColor" stroke-width="1.4" ',
                       'stroke-linecap="round" stroke-linejoin="round"/>',
              '</svg>',
              'Отмена',
            '</button>',
            '<button type="button" class="ep-act" data-act="invert" title="Инвертировать выделение">',
              '<svg class="ep-act-ico" width="14" height="14" viewBox="0 0 18 18" fill="none">',
                '<path d="M3 6h10M11 4l2 2-2 2" stroke="currentColor" stroke-width="1.4" ',
                       'stroke-linecap="round" stroke-linejoin="round"/>',
                '<path d="M15 12H5M7 14l-2-2 2-2" stroke="currentColor" stroke-width="1.4" ',
                       'stroke-linecap="round" stroke-linejoin="round"/>',
              '</svg>',
              'Инверсия',
            '</button>',
            '<button type="button" class="ep-act" data-act="all" title="Выделить всё">',
              '<svg class="ep-act-ico" width="14" height="14" viewBox="0 0 18 18" fill="none">',
                '<rect x="3.5" y="3.5" width="11" height="11" rx="1.5" stroke="currentColor" ',
                       'stroke-width="1.4" fill="currentColor" fill-opacity="0.18"/>',
                '<path d="M6 9l2 2 4-4" stroke="currentColor" stroke-width="1.4" ',
                       'stroke-linecap="round" stroke-linejoin="round"/>',
              '</svg>',
              'Всё',
            '</button>',
            '<button type="button" class="ep-act ep-act-danger" data-act="clear" title="Снять всё выделение">',
              '<svg class="ep-act-ico" width="14" height="14" viewBox="0 0 18 18" fill="none">',
                '<circle cx="9" cy="9" r="6.5" stroke="currentColor" stroke-width="1.4"/>',
                '<path d="M6 6l6 6M12 6l-6 6" stroke="currentColor" stroke-width="1.4" ',
                       'stroke-linecap="round"/>',
              '</svg>',
              'Очистить',
            '</button>',
          '</div>',
          '<button type="button" class="ep-rerun" data-act="rerun" ',
                  'title="Вернуть выделение к исходной автосегментации.">',
            '<svg class="ep-act-ico" width="14" height="14" viewBox="0 0 18 18" fill="none">',
              '<path d="M14.5 9a5.5 5.5 0 11-1.7-3.95M14.5 3v3.5h-3.5" ',
                    'stroke="currentColor" stroke-width="1.4" ',
                    'stroke-linecap="round" stroke-linejoin="round"/>',
            '</svg>',
            'Вернуть исходную маску',
          '</button>',
        '</div>',

        '<div class="card">',
          '<div class="card-title">Файл<span class="badge">.OBJ</span></div>',


            '<button type="button" class="btn-open ep-file-btn" data-act="export" ',
                    'title="Скачать текущее выделение как .obj">',
              '<svg width="14" height="14" viewBox="0 0 18 18" fill="none">',
                '<path d="M9 3v9M9 12l-4-4M9 12l4-4" stroke="currentColor" ',
                       'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
                '<path d="M3 13v2a1 1 0 001 1h10a1 1 0 001-1v-2" stroke="currentColor" ',
                       'stroke-width="1.4" stroke-linecap="round"/>',
              '</svg>',
              'Экспорт',
            '</button>',
        '</div>',



        '<button type="button" class="btn-open-big btn-next-stage" ',
                'style="display:inline-flex;align-items:center;gap:8px;',
                     'margin-top:20px;min-width:260px;justify-content:center"',
                '>',
          'Перейти к этапу 3',
          '<svg width="14" height="14" viewBox="0 0 18 18" fill="none" style="margin-left:6px">',
            '<path d="M5 9h8M9 5l4 4-4 4" stroke="currentColor" ',
                  'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
          '</svg>',
        '</button>',
      ].join('');

      // ─── RIGHT: выделение + инструкция ────────────────────────
      right.innerHTML = [
        '<div class="card">',
          '<div class="card-title">Выделение</div>',
          '<div class="stat-row">',
            '<span class="stat-k">фейсы</span>',
            '<span class="stat-v" data-stat="faces">—</span>',
          '</div>',
          '<div class="stat-row">',
            '<span class="stat-k">площадь</span>',
            '<span class="stat-v" data-stat="area">—</span>',
          '</div>',
          '<div class="stat-row">',
            '<span class="stat-k">доля площади</span>',
            '<span class="stat-v" data-stat="pct">—</span>',
          '</div>',
        '</div>',

        '<div class="card">',
          '<div class="card-title">Инструкция</div>',
          '<ol class="ep-steps">',
            '<li>Поверните меш <b>ПКМ</b> — увидите внутреннюю поверхность ',
                 '.</li>',
            '<li><span class="accent">Синим</span> отмечено то, что алгоритм ',
                 'принял за слизистую. <span class="ep-grey">Серое</span> — ',
                 'наружная (невыделенная) поверхность.</li>',
            '<li><b>Кистью</b> добавьте пропущенные участки.</li>',
            '<li><b>Ластиком</b> уберите лишнее.</li>',
            '<li><b>Перейти к этапу 3</b> — применит авточистку и разблокирует ',
                 'вкладку <b>«Сегментация»</b>. Геометрия фейсов не меняется.</li>',
          '</ol>',
          '<div class="ep-divider"></div>',
          '<div class="ep-ctrls-title">Управление</div>',
          '<div class="stat-row"><span class="stat-k">ЛКМ</span>',
            '<span class="stat-v">применить</span></div>',
          '<div class="stat-row"><span class="stat-k">ПКМ</span>',
            '<span class="stat-v">повернуть</span></div>',
          '<div class="stat-row"><span class="stat-k">Shift+ЛКМ</span>',
            '<span class="stat-v">сдвиг</span></div>',
          '<div class="stat-row"><span class="stat-k">Колесо</span>',
            '<span class="stat-v">зум</span></div>',
        '</div>',
      ].join('');

      injectCSS();

      s.uiLeft = left;
      s.uiRight = right;

      left.querySelectorAll('[data-tool]').forEach(btn => {
        btn.addEventListener('click', () => setTool(s, btn.dataset.tool));
      });
      const rad = left.querySelector('[data-input="radius"]');
      if (rad) {

        const updateRangeFill = () => {
          const min = +rad.min || 0, max = +rad.max || 100;
          const pct = ((+rad.value - min) / (max - min)) * 100;
          rad.style.setProperty('--ep-pct', pct + '%');
        };
        updateRangeFill();
        rad.addEventListener('input', e => {
          s.radius = +e.target.value;
          left.querySelector('[data-val="radius"]').textContent = s.radius;
          updateRangeFill();
        });
      }

      const bindAct = (name, fn) => {
        const el = left.querySelector('[data-act="' + name + '"]');
        if (el) el.addEventListener('click', fn);
      };
      bindAct('undo',   () => undo(s));
      bindAct('invert', () => {
        pushHistory(s);
        for (let i=0; i<s.fd.nF; i++) s.mask[i] = s.mask[i] ? 0 : 1;
        refreshColors(s);
      });
      bindAct('all',   () => { pushHistory(s); s.mask.fill(1); refreshColors(s); });
      bindAct('clear', () => { pushHistory(s); s.mask.fill(0); refreshColors(s); });
      bindAct('import', () => importMaskFromFile(s));
      bindAct('export', () => exportMaskAsOBJ(s));

      const nextBtn = left.querySelector('.btn-next-stage');
      if (nextBtn) nextBtn.addEventListener('click', () => {
        // Save+finalize, потом переключение на zones (если успех)
        saveAndFinalize(s, nextBtn, /*onSuccess*/ () => {
          if (window.Tabs && typeof window.Tabs.switchTo === 'function') {
            setTimeout(() => window.Tabs.switchTo('zones'), 700);
          }
        });
      });

      return {
        dispose: () => {
          left.innerHTML = origLeftHTML;
          right.innerHTML = origRightHTML;
        },
      };
    }


    function injectCSS() {
      if (document.getElementById('editor-ui-css')) return;
      const s = document.createElement('style');
      s.id = 'editor-ui-css';
      s.textContent = [
        /* ═══ Tool buttons (Кисть / Стереть) ═══ */
        '.stage[data-stage="inner"] .ep-tools {',
        '  display: flex; flex-direction: column; gap: 6px;',
        '  margin-bottom: 14px;',
        '}',
        '.stage[data-stage="inner"] .ep-tool {',
        '  display: flex; align-items: center; gap: 10px;',
        '  padding: 11px 12px; width: 100%;',
        '  font: inherit; font-size: 13px;',
        '  background: rgba(0,240,255,0.04);',
        '  border: 1px solid var(--brd);',
        '  color: var(--tx);',
        '  border-radius: 4px; cursor: pointer;',
        '  transition: all 0.15s ease;',
        '  text-align: left;',
        '}',
        '.stage[data-stage="inner"] .ep-tool:hover:not(.active) {',
        '  border-color: var(--brd-glow);',
        '  background: rgba(0,240,255,0.08);',
        '  color: var(--tx);',
        '}',
        '.stage[data-stage="inner"] .ep-tool.active {',
        '  background: rgba(0,240,255,0.14);',
        '  border-color: var(--cyan);',
        '  color: var(--cyan);',
        '  box-shadow: 0 0 14px rgba(0,240,255,0.18), inset 0 0 8px rgba(0,240,255,0.08);',
        '}',
        '.stage[data-stage="inner"] .ep-tool .ep-dot {',
        '  width: 11px; height: 11px; border-radius: 50%;',
        '  border: 1.5px solid currentColor;',
        '  flex-shrink: 0;',
        '}',
        '.stage[data-stage="inner"] .ep-tool .ep-dot.paint { background: currentColor; }',
        '.stage[data-stage="inner"] .ep-tool .ep-lab { flex: 1; }',
        '.stage[data-stage="inner"] .ep-tool .ep-tool-ico {',
        '  flex-shrink: 0; opacity: 0.85;',
        '  transition: opacity 0.15s ease;',
        '}',
        '.stage[data-stage="inner"] .ep-tool.active .ep-tool-ico { opacity: 1; }',
        '.stage[data-stage="inner"] .ep-tool .ep-hk {',
        '  font-size: 10.5px; opacity: 0.75; font-weight: 600;',
        '  padding: 2px 7px; border-radius: 3px;',
        '  background: rgba(0,240,255,0.08);',
        '  border: 1px solid var(--brd);',
        '  font-family: \'Share Tech Mono\',\'Consolas\',\'Menlo\',monospace;',
        '  min-width: 18px; text-align: center;',
        '}',
        '.stage[data-stage="inner"] .ep-tool.active .ep-hk {',
        '  background: rgba(0,240,255,0.2);',
        '  border-color: var(--brd-glow);',
        '  color: var(--cyan);',
        '}',

        /* ═══ Slider row ═══ */
        '.stage[data-stage="inner"] .ep-row {',
        '  display: grid; grid-template-columns: 62px 1fr 32px;',
        '  gap: 10px; align-items: center;',
        '  font: inherit; font-size: 13px;',
        '}',
        '.stage[data-stage="inner"] .ep-row label { color: var(--tx2); }',

        /* ═══ Custom slider ═══ */
        '.stage[data-stage="inner"] .ep-row input[type=range] {',
        '  -webkit-appearance: none; appearance: none;',
        '  width: 100%; height: 22px; margin: 0;',
        '  background: transparent; cursor: pointer; outline: none;',
        '}',
        /* WebKit track */
        '.stage[data-stage="inner"] .ep-row input[type=range]::-webkit-slider-runnable-track {',
        '  height: 4px; border-radius: 2px;',
        '  background: linear-gradient(to right,',
        '    var(--cyan) 0%, var(--cyan) var(--ep-pct,30%),',
        '    rgba(0,240,255,0.12) var(--ep-pct,30%), rgba(0,240,255,0.12) 100%);',
        '  box-shadow: 0 0 6px rgba(0,240,255,0.18);',
        '}',
        '.stage[data-stage="inner"] .ep-row input[type=range]::-webkit-slider-thumb {',
        '  -webkit-appearance: none; appearance: none;',
        '  width: 16px; height: 16px; border-radius: 50%;',
        '  background: var(--cyan);',
        '  border: 2px solid var(--bg2);',
        '  margin-top: -6px;',
        '  box-shadow: 0 0 0 1px var(--cyan), 0 0 12px rgba(0,240,255,0.6);',
        '  cursor: grab; transition: transform 0.12s ease, box-shadow 0.12s ease;',
        '}',
        '.stage[data-stage="inner"] .ep-row input[type=range]:hover::-webkit-slider-thumb {',
        '  transform: scale(1.15);',
        '  box-shadow: 0 0 0 1px var(--cyan), 0 0 18px rgba(0,240,255,0.8);',
        '}',
        '.stage[data-stage="inner"] .ep-row input[type=range]:active::-webkit-slider-thumb {',
        '  cursor: grabbing; transform: scale(1.05);',
        '}',
        /* Firefox */
        '.stage[data-stage="inner"] .ep-row input[type=range]::-moz-range-track {',
        '  height: 4px; border-radius: 2px;',
        '  background: rgba(0,240,255,0.12);',
        '}',
        '.stage[data-stage="inner"] .ep-row input[type=range]::-moz-range-progress {',
        '  height: 4px; border-radius: 2px; background: var(--cyan);',
        '  box-shadow: 0 0 6px rgba(0,240,255,0.4);',
        '}',
        '.stage[data-stage="inner"] .ep-row input[type=range]::-moz-range-thumb {',
        '  width: 16px; height: 16px; border-radius: 50%;',
        '  background: var(--cyan); border: 2px solid var(--bg2);',
        '  box-shadow: 0 0 0 1px var(--cyan), 0 0 12px rgba(0,240,255,0.6);',
        '  cursor: grab;',
        '}',
        '.stage[data-stage="inner"] .ep-row .ep-val {',
        '  text-align: right; font-weight: 600;',
        '  color: var(--cyan);',
        '  font-family: \'Share Tech Mono\',\'Consolas\',\'Menlo\',monospace;',
        '}',

        /* ═══ Hint под слайдером ═══ */
        '.stage[data-stage="inner"] .ep-hint {',
        '  margin-top: 14px; padding-top: 12px;',
        '  border-top: 1px solid var(--brd);',
        '  font-size: 12px; line-height: 1.5; color: var(--tx2);',
        '}',
        '.stage[data-stage="inner"] .ep-hint b { color: var(--cyan); font-weight: 600; }',

        /* ═══ Action buttons 2x2 (Отмена / Инверсия / Всё / Очистить) ═══ */
        '.stage[data-stage="inner"] .ep-actions {',
        '  display: grid; grid-template-columns: 1fr 1fr; gap: 6px;',
        '}',
        '.stage[data-stage="inner"] .ep-act {',
        '  display: flex; align-items: center; gap: 7px;',
        '  padding: 9px 11px; font: inherit; font-size: 12.5px;',
        '  background: rgba(0,240,255,0.04);',
        '  border: 1px solid var(--brd);',
        '  color: var(--tx);',
        '  border-radius: 4px; cursor: pointer;',
        '  transition: all 0.15s ease;',
        '  text-align: left;',
        '}',
        '.stage[data-stage="inner"] .ep-act:hover {',
        '  border-color: var(--cyan);',
        '  color: var(--cyan);',
        '  background: rgba(0,240,255,0.1);',
        '  box-shadow: 0 0 10px rgba(0,240,255,0.14);',
        '}',
        '.stage[data-stage="inner"] .ep-act-danger:hover {',
        '  border-color: #ef4444; color: #ef4444;',
        '  background: rgba(239,68,68,0.08);',
        '  box-shadow: 0 0 10px rgba(239,68,68,0.18);',
        '}',
        '.stage[data-stage="inner"] .ep-act .ep-act-ico {',
        '  width: 14px; height: 14px; flex-shrink: 0;',
        '  opacity: 0.85; transition: opacity 0.15s ease;',
        '}',
        '.stage[data-stage="inner"] .ep-act:hover .ep-act-ico { opacity: 1; }',

        /* ═══ Импорт/Экспорт — выделяются (используют .btn-open) ═══ */
        '.stage[data-stage="inner"] .ep-file-actions {',
        '  display: grid; grid-template-columns: 1fr 1fr; gap: 6px;',
        '}',
        '.stage[data-stage="inner"] .ep-file-btn {',
        '  width: 100%; justify-content: center;',
        '  font-size: 12.5px; padding: 9px 10px;',
        '}',

        /* ═══ Rerun — плоская, не отвлекает ═══ */
        '.stage[data-stage="inner"] .ep-rerun {',
        '  display: flex; align-items: center; justify-content: center;',
        '  gap: 8px; width: 100%; padding: 9px 12px;',
        '  margin: 8px 0 0;',  /* внутри карточки «Действия», под grid'ом */
        '  font: inherit; font-size: 12px;',
        '  background: transparent;',
        '  border: 1px dashed var(--brd);',
        '  color: var(--tx3);',
        '  border-radius: 4px; cursor: pointer;',
        '  transition: all 0.15s ease;',
        '}',
        '.stage[data-stage="inner"] .ep-rerun:hover:not(:disabled) {',
        '  border-color: var(--brd-glow); border-style: solid;',
        '  color: var(--cyan);',
        '  background: rgba(0,240,255,0.05);',
        '}',
        '.stage[data-stage="inner"] .ep-rerun:disabled {',
        '  opacity: 0.4; cursor: wait;',
        '}',
        '.stage[data-stage="inner"] .ep-rerun .ep-act-ico {',
        '  width: 14px; height: 14px; flex-shrink: 0; opacity: 0.85;',
        '}',

        /* ═══ Next-stage — использует базовые стили .btn-open-big из app.css ═══ */

        /* ═══ Stat rows (Выделение справа) — берут глобальные стили из app.css */
        /* Оставляем только мелкие правки под этот таб */
        '.stage[data-stage="inner"] [data-stat="topology"] {',
        '  /* топология — может содержать символы вроде ✓ ⚠, оставляем дефолт */',
        '}',


        '.stage[data-stage="inner"] .ep-steps {',
        '  list-style: none; padding: 0; margin: 0;',
        '  font-size: 12.5px; line-height: 1.55;',
        '  counter-reset: ep-step;',
        '}',
        '.stage[data-stage="inner"] .ep-steps li {',
        '  position: relative; padding-left: 28px; margin-bottom: 9px;',
        '  counter-increment: ep-step;',
        '  color: var(--tx2);',
        '}',
        '.stage[data-stage="inner"] .ep-steps li::before {',
        '  content: counter(ep-step);',
        '  position: absolute; left: 0; top: -1px;',
        '  width: 20px; height: 20px;',
        '  display: flex; align-items: center; justify-content: center;',
        '  font-size: 10.5px; font-weight: 700;',
        '  color: var(--cyan);',
        '  background: rgba(0,240,255,0.08);',
        '  border: 1px solid var(--brd-glow);',
        '  border-radius: 50%;',
        '  font-family: \'Share Tech Mono\',\'Consolas\',monospace;',
        '}',
        '.stage[data-stage="inner"] .ep-steps li:last-child { margin-bottom: 0; }',
        '.stage[data-stage="inner"] .ep-steps b { color: var(--cyan); font-weight: 600; }',
        '.stage[data-stage="inner"] .ep-grey {',
        '  color: var(--tx3); font-weight: 500;',
        '}',

        /* ═══ Divider + controls header ═══ */
        '.stage[data-stage="inner"] .ep-divider {',
        '  height: 1px; margin: 14px 0 10px;',
        '  background: linear-gradient(90deg, transparent, var(--brd-glow), transparent);',
        '}',
        '.stage[data-stage="inner"] .ep-ctrls-title {',
        '  font-size: 11px; letter-spacing: 0.16em;',
        '  text-transform: uppercase; color: var(--tx3);',
        '  margin-bottom: 8px;',
        '}',


        '.stage[data-stage="inner"] [data-stat="topology"].ep-topo-ok {',
        '  color: #22c55e; text-shadow: 0 0 8px rgba(34,197,94,0.4);',
        '}',
        '.stage[data-stage="inner"] [data-stat="topology"].ep-topo-warn {',
        '  color: #f59e0b; text-shadow: 0 0 8px rgba(245,158,11,0.35);',
        '}',

        /* ═══ Light theme overrides ═══ */
        '.light-theme .stage[data-stage="inner"] .ep-tool {',
        '  background: #fff; border-color: #dfe4ec; color: #475569;',
        '}',
        '.light-theme .stage[data-stage="inner"] .ep-tool:hover:not(.active) {',
        '  background: #f8fafc; border-color: rgba(79,124,219,0.25); color: #1e293b;',
        '}',
        '.light-theme .stage[data-stage="inner"] .ep-tool.active {',
        '  background: rgba(79,124,219,0.1); border-color: #4F7CDB; color: #4F7CDB;',
        '  box-shadow: 0 0 12px rgba(79,124,219,0.18);',
        '}',
        '.light-theme .stage[data-stage="inner"] .ep-tool .ep-hk {',
        '  background: #f8fafc; border-color: #dfe4ec; color: #94a3b8;',
        '}',
        '.light-theme .stage[data-stage="inner"] .ep-tool.active .ep-hk {',
        '  background: rgba(79,124,219,0.15); border-color: rgba(79,124,219,0.3); color: #4F7CDB;',
        '}',
        '.light-theme .stage[data-stage="inner"] .ep-act {',
        '  background: #fff; border-color: #dfe4ec; color: #475569;',
        '}',
        '.light-theme .stage[data-stage="inner"] .ep-act:hover {',
        '  background: rgba(79,124,219,0.08); border-color: #4F7CDB; color: #4F7CDB;',
        '  box-shadow: 0 0 8px rgba(79,124,219,0.15);',
        '}',
        '.light-theme .stage[data-stage="inner"] .ep-rerun {',
        '  border-color: #dfe4ec; color: #94a3b8;',
        '}',
        '.light-theme .stage[data-stage="inner"] .ep-rerun:hover:not(:disabled) {',
        '  border-color: #4F7CDB; color: #4F7CDB; background: rgba(79,124,219,0.06);',
        '}',
        '.light-theme .stage[data-stage="inner"] .stat-row {',
        '  border-bottom-color: rgba(79,124,219,0.1);',
        '}',
        '.light-theme .stage[data-stage="inner"] .ep-steps li::before {',
        '  background: rgba(79,124,219,0.08); border-color: rgba(79,124,219,0.3); color: #4F7CDB;',
        '}',
        '.light-theme .stage[data-stage="inner"] .ep-steps b { color: #4F7CDB; }',
        '.light-theme .stage[data-stage="inner"] .ep-hint b { color: #4F7CDB; }',
        '.light-theme .stage[data-stage="inner"] .ep-row .ep-val { color: #4F7CDB; }',

        /* Slider light-theme */
        '.light-theme .stage[data-stage="inner"] .ep-row input[type=range]::-webkit-slider-runnable-track {',
        '  background: linear-gradient(to right,',
        '    #4F7CDB 0%, #4F7CDB var(--ep-pct,30%),',
        '    rgba(79,124,219,0.18) var(--ep-pct,30%), rgba(79,124,219,0.18) 100%);',
        '  box-shadow: 0 0 4px rgba(79,124,219,0.18);',
        '}',
        '.light-theme .stage[data-stage="inner"] .ep-row input[type=range]::-webkit-slider-thumb {',
        '  background: #4F7CDB; border-color: #fff;',
        '  box-shadow: 0 0 0 1px #4F7CDB, 0 0 10px rgba(79,124,219,0.45);',
        '}',
        '.light-theme .stage[data-stage="inner"] .ep-row input[type=range]:hover::-webkit-slider-thumb {',
        '  box-shadow: 0 0 0 1px #4F7CDB, 0 0 14px rgba(79,124,219,0.6);',
        '}',
        '.light-theme .stage[data-stage="inner"] .ep-row input[type=range]::-moz-range-track {',
        '  background: rgba(79,124,219,0.18);',
        '}',
        '.light-theme .stage[data-stage="inner"] .ep-row input[type=range]::-moz-range-progress {',
        '  background: #4F7CDB; box-shadow: 0 0 4px rgba(79,124,219,0.35);',
        '}',
        '.light-theme .stage[data-stage="inner"] .ep-row input[type=range]::-moz-range-thumb {',
        '  background: #4F7CDB; border-color: #fff;',
        '  box-shadow: 0 0 0 1px #4F7CDB, 0 0 10px rgba(79,124,219,0.45);',
        '}',
        '.light-theme .stage[data-stage="inner"] [data-stat="topology"].ep-topo-warn {',
        '  color: #d97706;',
        '}',
      ].join('\n');
      document.head.appendChild(s);
    }

    function install(viewer, fullMeshText, initialSelectionText) {
      const full = parseOBJ(fullMeshText);
      const init = parseOBJ(initialSelectionText);

      // Грузим через viewer → установятся bbox, orbit.target, theta/phi,
      // near/far, подгонится grid. Затем убираем дефолтный меш.
      viewer.loadMesh({
        rawV:  full.V, rawF:  full.F,
        rawNV: full.V.length / 3,
        rawNF: full.F.length / 3,
      });
      viewer.clear();

      // Подтягиваем камеру ближе
      const bb = viewer.getBBox && viewer.getBBox();
      if (bb) {
        const size = bb.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z, 1);
        if (viewer.setOrbitDistance) viewer.setOrbitDistance(maxDim * 1.35);
      }

      const fd     = buildFaceData(full.V, full.F);
      const initFD = buildFaceData(init.V, init.F);
      const { mask, matched, total } =
        matchInitialSelection(fd.fc, initFD.fc, fd.nF);

      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(fd.positions, 3));
      geom.setAttribute('normal',   new THREE.BufferAttribute(fd.normals, 3));
      geom.setAttribute('color',    new THREE.BufferAttribute(fd.colors, 3));
      geom.computeBoundingBox();
      const mat = new THREE.MeshPhongMaterial({
        vertexColors: true,
        specular: 0x0c1218, shininess: 14,
        flatShading: true,
        side: THREE.DoubleSide,
      });
      const threeMesh = new THREE.Mesh(geom, mat);
      viewer.scene.add(threeMesh);

      const state = {
        viewer, full, fd, mask, geom, threeMesh,
        history: [],
        tool: 'paint',         // стартуем с активной кистью
        radius: 8,
        dragging: false,
        initialMatched: matched,
        initialMask: new Uint8Array(mask),
        colorSel: readAccentColor(),
        uiLeft: null, uiRight: null,
        lastReport: null,
        lastReportLabel: null,
      };

      refreshColors(state);

      const ui = installUI(state);
      // повторно после installUI, чтобы updateStats нашёл DOM-элементы
      // [data-stat="faces"], [data-stat="area"] и т.д. — их раньше не было.
      refreshColors(state);
      const inputCleanup = installInput(state);

      // После установки UI — обновим hint под активную кисть
      setTool(state, 'paint');

      if (matched < total) {
        console.warn(
          '[Tab2 Editor] Начальная маска смэтчилась не полностью: ' +
          matched + '/' + total
        );
      }

      return {
        full, fd,
        get state() { return state; },
        initialMatched: matched,
        pushHistory:   () => pushHistory(state),
        refreshColors: () => refreshColors(state),
        dispose() {
          inputCleanup();
          ui.dispose();
          viewer.scene.remove(threeMesh);
          geom.dispose();
          mat.dispose();
          if (viewer.canvas) viewer.canvas.style.cursor = '';
          const canvas = document.getElementById('gl3d-inner');
          const emptyInner = document.getElementById('innerEmpty');
          const viewport = document.getElementById('viewportInner');
          if (canvas)     canvas.style.display = 'none';
          if (emptyInner) emptyInner.style.display = '';
          if (viewport)   viewport.classList.remove('has-mesh');
        },
      };
    }

    return { install };
  })();

  // ═════════════════════════════════════════════════════════════════════
  //  Реакция на смену исходного меша / сброс
  // ═════════════════════════════════════════════════════════════════════
  //
  // Tab2 владеет innerV/innerF и закоммиченным активным мешем (V/F).
  // При изменении rawV (tab1 → cascadeInvalidate) или полном сбросе
  // (tab1 → resetAll) наш локальный editor и visual state устарели —
  // нужно атомарно их выбросить.
  //
  // Отдельно: при перезапуске сегментации ВНУТРИ tab2 (runSegment)
  // вызываем invalidateDownstreamFromInner — это срезает
  // tab3 и tab4 ещё до того, как спиннер закрутился.
  //
  function lockTab(name) {
    // Источник истины — gate-функции в tabs.js + refreshGates() на
    // data:change. b.disabled всегда перезаписывается по результату
    // gate[name](). Здесь мы только задаём «сразу visually disabled»,
    // а refreshGates (срабатывает по data:change ниже) подтвердит это
    // уже через проверку window.M.V и т.п.
    const tab = document.querySelector('.tab[data-tab="' + name + '"]');
    if (!tab) return;
    tab.setAttribute('disabled', '');
    tab.setAttribute('aria-disabled', 'true');
    try { if ('disabled' in tab) tab.disabled = true; } catch (_) {}
  }

  function resetInnerUI() {
    const canvas     = document.getElementById('gl3d-inner');
    const emptyInner = document.getElementById('innerEmpty');
    const viewport   = document.getElementById('viewportInner');
    if (canvas)     canvas.style.display = 'none';
    if (emptyInner) emptyInner.style.display = '';
    if (viewport)   viewport.classList.remove('has-mesh');
  }

  // Очищает поля в window.M, которые являются продуктом этапа 2 или 3,
  // и перезапирает вкладки 03/04. НЕ трогает raw*.
  function invalidateDownstreamFromInner() {
    const M = window.M;
    if (!M) return;
    delete M.innerV; delete M.innerF; delete M.innerNV; delete M.innerNF;
    delete M.V;      delete M.F;      delete M.nV;      delete M.nF;
    delete M.zoneLabels; delete M.zoneMeta;
    delete M.zoneFaces;  delete M.zoneMeshes;  delete M.zoneBoundaries;
    lockTab('zones');
    lockTab('unfold');
    // Сигнал подписчикам (tab3/tab4): сбросить кэш и редакторы.
    window.dispatchEvent(new CustomEvent('data:change', {
      detail: { kind: 'inner:invalidated' },
    }));
  }

  // Сброс по событию от tab1: mesh-replaced (новый OBJ) или reset
  // (полный откат к empty). Оба случая —  editor строился на старых
  // данных, надо его убить и вернуть empty-state, чтобы при следующем
  // визите пользователь увидел «Запустить сегментацию».
  window.addEventListener('data:change', function (e) {
    const d = (e && e.detail) || {};
    if (d.kind !== 'mesh-replaced' && d.kind !== 'reset') return;
    if (editor) {
      try { editor.dispose(); } catch (_) {}
      editor = null;
    }
    resetInnerUI();
  });

})();
