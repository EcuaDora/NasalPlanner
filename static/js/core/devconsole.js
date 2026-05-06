/* ─── core/devconsole ─────────────────────────────────────────
   Встроенная панель-консоль прямо в окне приложения.
   v2: добавлена REPL-полоса для выполнения JS прямо в панели.

   Перехват:
     - все console.log/info/warn/error
     - window.error (синтаксические/runtime ошибки)
     - unhandledrejection (сбой promise без catch)

   Управление:
     • Hotkey Ctrl+`  (или Cmd+`) — toggle открытие/закрытие
     • Кнопка ✕ — свернуть панель (ghost-кнопка останется в углу)
     • Кнопка 📋 — скопировать ВСЕ логи в буфер
     • Кнопка 🗑 — очистить
     • Поле фильтра — показывать только строки содержащие текст
       (поддерживает /regex/flags синтаксис)
     • Чекбоксы log/info/warn/error — переключать видимость уровней

   REPL (нижняя полоса):
     • Просто пишешь JS и нажимаешь Enter — выполняется
     • Shift+Enter — перенос строки (multi-line ввод)
     • Стрелки ↑/↓ — навигация по истории (сохраняется в localStorage)
     • Ctrl+L — очистить input
     • Esc — очистить input + сбросить навигацию по истории
     • Промисы автоматически await'ятся
     • Результат показывается с префиксом ‹

   Все логи доступны программно: window.__devconsole.logs ──── */
(function () {
  'use strict';

  if (window.__devconsole) return;

  const MAX_LINES = 2000;
  const HIST_KEY = 'devconsole.history';
  const HIST_MAX = 50;
  const logs = [];
  let panel, body, filterIn, copyBtn, replIn;
  let visible = true;
  const filters = { log: true, info: true, warn: true, error: true };
  let textFilter = '';
  let history = [];
  let histIdx = -1;
  let histDraft = '';

  try { history = JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); }
  catch (_) { history = []; }


  const orig = {
    log:   console.log.bind(console),
    info:  console.info.bind(console),
    warn:  console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug ? console.debug.bind(console) : console.log.bind(console),
  };

  function fmtArg(a) {
    if (a === null) return 'null';
    if (a === undefined) return 'undefined';
    if (typeof a === 'string') return a;
    if (typeof a === 'number' || typeof a === 'boolean') return String(a);
    if (typeof a === 'function') return '[Function ' + (a.name || 'anonymous') + ']';
    if (a instanceof Error) return (a.stack || a.message || String(a));
    if (a instanceof HTMLElement) {
      const id = a.id ? '#' + a.id : '';
      const cls = a.className ? '.' + String(a.className).split(/\s+/).filter(Boolean).join('.') : '';
      return '<' + a.tagName.toLowerCase() + id + cls + '>';
    }
    if (ArrayBuffer.isView(a)) {
      const len = a.length;
      const head = Array.from(a.slice(0, 6)).join(', ');
      return `${a.constructor.name}(${len})[${head}${len > 6 ? ', …' : ''}]`;
    }
    try {
      const s = JSON.stringify(a, (k, v) => {
        if (ArrayBuffer.isView(v)) return `${v.constructor.name}(${v.length})`;
        if (v instanceof Map) return Object.fromEntries(v.entries());
        if (v instanceof Set) return Array.from(v);
        if (v instanceof HTMLElement) return '<' + v.tagName.toLowerCase()
                                           + (v.id ? '#' + v.id : '') + '>';
        return v;
      }, 2);
      return s.length > 800 ? s.slice(0, 800) + '… ['+s.length+' chars]' : s;
    } catch (_) {
      return String(a);
    }
  }

  function record(level, args) {
    const ts = new Date();
    const text = Array.from(args).map(fmtArg).join(' ');
    const entry = { ts, level, text };
    logs.push(entry);
    if (logs.length > MAX_LINES) logs.splice(0, logs.length - MAX_LINES);
    appendLine(entry);
    orig[level] ? orig[level].apply(console, args) : orig.log.apply(console, args);
  }

  console.log   = function (...a) { record('log',   a); };
  console.info  = function (...a) { record('info',  a); };
  console.warn  = function (...a) { record('warn',  a); };
  console.error = function (...a) { record('error', a); };
  console.debug = function (...a) { record('log',   a); };


  window.addEventListener('error', (e) => {
    const msg = e.error && e.error.stack
      ? e.error.stack
      : (e.message + '  @ ' + (e.filename || '?') + ':' + (e.lineno || '?'));
    record('error', ['[window.error]', msg]);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    const msg = r && r.stack ? r.stack : (r && r.message) ? r.message : String(r);
    record('error', ['[unhandledRejection]', msg]);
  });


  async function execute(code) {
    code = String(code || '').trim();
    if (!code) return;
    if (history[history.length - 1] !== code) {
      history.push(code);
      if (history.length > HIST_MAX) history.splice(0, history.length - HIST_MAX);
      try { localStorage.setItem(HIST_KEY, JSON.stringify(history)); } catch (_) {}
    }
    histIdx = -1; histDraft = '';

    record('log', ['› ' + code]);

    let result;
    try {
      try {
        result = (new Function('return (' + code + ')'))();
      } catch (e1) {
        if (e1 instanceof SyntaxError) {
          result = (new Function(code))();
        } else {
          throw e1;
        }
      }
      if (result && typeof result.then === 'function') {
        record('info', ['‹ <Promise pending…>']);
        try {
          const r = await result;
          record('log', ['‹', r]);
        } catch (perr) {
          record('error', ['‹ Promise rejected:', perr]);
        }
      } else {
        record('log', ['‹', result]);
      }
    } catch (err) {
      record('error', ['‹', err && err.stack ? err.stack : String(err)]);
    }
  }


  const css = `
    #devconsole{position:fixed;right:8px;bottom:8px;width:560px;max-width:calc(100vw - 16px);
      height:380px;max-height:65vh;background:#0c1017;color:#d8dee9;border:1px solid #2a3140;
      border-radius:8px;font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
      box-shadow:0 12px 40px rgba(0,0,0,.45);z-index:99999;display:flex;flex-direction:column;
      backdrop-filter:blur(4px)}
    #devconsole.collapsed{height:auto;width:auto}
    #devconsole.collapsed > .dc-body,
    #devconsole.collapsed > .dc-toolbar,
    #devconsole.collapsed > .dc-repl{display:none}
    #devconsole .dc-head{display:flex;align-items:center;gap:8px;padding:6px 8px;
      background:#161c26;border-bottom:1px solid #2a3140;border-radius:8px 8px 0 0;
      cursor:default;user-select:none;flex-shrink:0}
    #devconsole.collapsed .dc-head{border-radius:8px;border-bottom:0}
    #devconsole .dc-title{font-weight:600;color:#9bbcff;letter-spacing:.5px}
    #devconsole .dc-stat{font-size:10.5px;opacity:.6;margin-left:6px}
    #devconsole .dc-spacer{flex:1}
    #devconsole button{background:#222a38;color:#d8dee9;border:1px solid #2a3140;border-radius:4px;
      cursor:pointer;font:inherit;padding:3px 8px;line-height:1.2}
    #devconsole button:hover{background:#2c364a}
    #devconsole .dc-toolbar{display:flex;align-items:center;gap:6px;padding:5px 8px;
      background:#11151d;border-bottom:1px solid #2a3140;font-size:10.5px;flex-shrink:0}
    #devconsole .dc-toolbar input[type=text]{flex:1;min-width:60px;background:#0c1017;color:#d8dee9;
      border:1px solid #2a3140;border-radius:3px;padding:3px 6px;font:inherit;outline:none}
    #devconsole .dc-toolbar input[type=text]:focus{border-color:#5b8cff}
    #devconsole .dc-toolbar label{display:flex;align-items:center;gap:3px;cursor:pointer;
      padding:1px 5px;border-radius:3px;opacity:.85}
    #devconsole .dc-toolbar label:hover{background:#1a2030}
    #devconsole .dc-toolbar input[type=checkbox]{margin:0;cursor:pointer}
    #devconsole .dc-body{flex:1;overflow:auto;padding:4px 8px;background:#0c1017;
      scrollbar-width:thin;scrollbar-color:#2a3140 transparent;min-height:60px}
    #devconsole .dc-body::-webkit-scrollbar{width:8px}
    #devconsole .dc-body::-webkit-scrollbar-thumb{background:#2a3140;border-radius:4px}
    #devconsole .dc-line{padding:1px 0;white-space:pre-wrap;word-break:break-word;
      border-bottom:1px solid #131820}
    #devconsole .dc-line.lvl-info{color:#9ad8ff}
    #devconsole .dc-line.lvl-warn{color:#ffce6b;background:#231a06}
    #devconsole .dc-line.lvl-error{color:#ff7a8a;background:#2a1218}
    #devconsole .dc-line.lvl-log{color:#d8dee9}
    #devconsole .dc-time{color:#5d6878;margin-right:6px}
    #devconsole .dc-tag{display:inline-block;width:42px;color:#7da0d8;text-align:right;
      margin-right:8px;font-size:10px;opacity:.7;text-transform:uppercase}
    /* REPL bar */
    #devconsole .dc-repl{display:flex;align-items:flex-start;gap:6px;padding:5px 8px;
      background:#0a0d13;border-top:1px solid #2a3140;flex-shrink:0}
    #devconsole .dc-repl-prompt{color:#5b8cff;font-weight:700;line-height:1.6;flex-shrink:0}
    #devconsole .dc-repl textarea{flex:1;background:#0c1017;color:#e6ecf5;border:1px solid #2a3140;
      border-radius:3px;padding:3px 6px;font:inherit;outline:none;resize:none;
      min-height:22px;max-height:120px;line-height:1.5}
    #devconsole .dc-repl textarea:focus{border-color:#5b8cff}
    /* Ghost button when collapsed */
    #dc-toggle-ghost{position:fixed;right:8px;bottom:8px;background:#161c26;color:#9bbcff;
      border:1px solid #2a3140;border-radius:18px;padding:6px 12px;cursor:pointer;
      font:11px ui-monospace,monospace;z-index:99998;box-shadow:0 4px 12px rgba(0,0,0,.4);
      display:none}
    #dc-toggle-ghost.show{display:block}
    #dc-toggle-ghost:hover{background:#1f2735;color:#fff}
    #devconsole .dc-flash{animation:dc-flash 1s ease-out}
    @keyframes dc-flash{0%{background:#1c4a2a}100%{background:transparent}}
  `;
  const style = document.createElement('style');
  style.id = 'devconsole-css';
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);

  /* ── DOM ─────────────────────────────────────────────────────── */
  function build() {
    panel = document.createElement('div');
    panel.id = 'devconsole';
    panel.innerHTML = `
      <div class="dc-head">
        <span class="dc-title">DEV CONSOLE</span>
        <span class="dc-stat" id="dc-stat">0</span>
        <span class="dc-spacer"></span>
        <button id="dc-copy"  title="Скопировать все логи в буфер">📋 копировать</button>
        <button id="dc-clear" title="Очистить">🗑</button>
        <button id="dc-close" title="Свернуть (Ctrl+\`)">✕</button>
      </div>
      <div class="dc-toolbar">
        <input type="text" id="dc-filter" placeholder="фильтр по тексту (regex через /…/ )">
        <label><input type="checkbox" id="dc-flt-log"   checked>log</label>
        <label><input type="checkbox" id="dc-flt-info"  checked>info</label>
        <label><input type="checkbox" id="dc-flt-warn"  checked>warn</label>
        <label><input type="checkbox" id="dc-flt-error" checked>error</label>
      </div>
      <div class="dc-body" id="dc-body"></div>
      <div class="dc-repl">
        <span class="dc-repl-prompt">›</span>
        <textarea id="dc-repl-in" rows="1" autocomplete="off" autocorrect="off"
          spellcheck="false" placeholder="JS-выражение (Enter — выполнить, Shift+Enter — перенос, ↑/↓ — история)"></textarea>
      </div>
    `;
    document.body.appendChild(panel);

    body     = panel.querySelector('#dc-body');
    filterIn = panel.querySelector('#dc-filter');
    copyBtn  = panel.querySelector('#dc-copy');
    replIn   = panel.querySelector('#dc-repl-in');

    panel.querySelector('#dc-close').onclick = () => setVisible(false);
    panel.querySelector('#dc-clear').onclick = () => {
      logs.length = 0; body.innerHTML = ''; updateStat();
    };
    copyBtn.onclick = copyAll;
    filterIn.oninput = () => { textFilter = filterIn.value; rerender(); };
    ['log','info','warn','error'].forEach(lv => {
      const cb = panel.querySelector('#dc-flt-' + lv);
      cb.onchange = () => { filters[lv] = cb.checked; rerender(); };
    });

    replIn.addEventListener('keydown', onReplKey);
    replIn.addEventListener('input', autosize);

    const ghost = document.createElement('button');
    ghost.id = 'dc-toggle-ghost';
    ghost.textContent = 'console ▴';
    ghost.onclick = () => setVisible(true);
    document.body.appendChild(ghost);

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '`') {
        setVisible(!visible);
        e.preventDefault();
      }
    });

    if (logs.length) rerender();
  }

  function autosize() {
    if (!replIn) return;
    replIn.style.height = '22px';
    replIn.style.height = Math.min(120, replIn.scrollHeight) + 'px';
  }

  function onReplKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const code = replIn.value;
      replIn.value = '';
      autosize();
      execute(code);
      return;
    }
    if (e.key === 'ArrowUp' && !e.shiftKey) {
      const before = replIn.value.slice(0, replIn.selectionStart);
      if (before.indexOf('\n') !== -1) return;
      e.preventDefault();
      if (history.length === 0) return;
      if (histIdx === -1) { histDraft = replIn.value; histIdx = history.length; }
      histIdx = Math.max(0, histIdx - 1);
      replIn.value = history[histIdx];
      autosize();
      replIn.setSelectionRange(replIn.value.length, replIn.value.length);
      return;
    }
    if (e.key === 'ArrowDown' && !e.shiftKey) {
      const after = replIn.value.slice(replIn.selectionStart);
      if (after.indexOf('\n') !== -1) return;
      e.preventDefault();
      if (histIdx === -1) return;
      histIdx++;
      if (histIdx >= history.length) {
        histIdx = -1;
        replIn.value = histDraft;
      } else {
        replIn.value = history[histIdx];
      }
      autosize();
      replIn.setSelectionRange(replIn.value.length, replIn.value.length);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      replIn.value = '';
      autosize();
      return;
    }
    if (e.key === 'Escape') {
      replIn.value = '';
      autosize();
      histIdx = -1;
      return;
    }
  }

  function setVisible(v) {
    visible = !!v;
    panel.style.display = visible ? 'flex' : 'none';
    document.getElementById('dc-toggle-ghost').classList.toggle('show', !visible);
    if (visible && replIn) setTimeout(() => replIn.focus(), 50);
  }

  function fmtTime(d) {
    const pad = n => n < 10 ? '0' + n : n;
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
         + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  function passesFilter(e) {
    if (!filters[e.level]) return false;
    if (!textFilter) return true;
    if (textFilter.length > 2 && textFilter.startsWith('/') &&
        textFilter.lastIndexOf('/') > 0) {
      const last = textFilter.lastIndexOf('/');
      const pat = textFilter.slice(1, last);
      const flags = textFilter.slice(last + 1);
      try { return new RegExp(pat, flags).test(e.text); }
      catch (_) {}
    }
    return e.text.toLowerCase().includes(textFilter.toLowerCase());
  }

  function lineEl(e) {
    const d = document.createElement('div');
    d.className = 'dc-line lvl-' + e.level;
    d.innerHTML =
      '<span class="dc-time">'  + fmtTime(e.ts)         + '</span>' +
      '<span class="dc-tag">[' + e.level + ']</span>' +
      escapeHTML(e.text);
    return d;
  }

  function escapeHTML(s) {
    return s.replace(/[&<>]/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[ch]));
  }

  function appendLine(e) {
    if (!body) return;
    if (!passesFilter(e)) { updateStat(); return; }
    const stuckToBottom = (body.scrollTop + body.clientHeight + 4 >= body.scrollHeight);
    body.appendChild(lineEl(e));
    while (body.childNodes.length > MAX_LINES) body.removeChild(body.firstChild);
    if (stuckToBottom) body.scrollTop = body.scrollHeight;
    updateStat();
  }

  function rerender() {
    if (!body) return;
    body.innerHTML = '';
    for (const e of logs) if (passesFilter(e)) body.appendChild(lineEl(e));
    body.scrollTop = body.scrollHeight;
    updateStat();
  }

  function updateStat() {
    const stat = panel && panel.querySelector('#dc-stat');
    if (!stat) return;
    const visibleN = logs.filter(passesFilter).length;
    const errN = logs.filter(e => e.level === 'error').length;
    const warnN = logs.filter(e => e.level === 'warn').length;
    stat.textContent = visibleN + '/' + logs.length +
      (errN  ? ' · ❌' + errN  : '') +
      (warnN ? ' · ⚠'  + warnN : '');
  }

  function copyAll() {
    const dump = logs.map(e =>
      fmtTime(e.ts) + ' [' + e.level + '] ' + e.text).join('\n');
    const ok = () => {
      const o = copyBtn.textContent;
      copyBtn.textContent = '✓ скопировано';
      copyBtn.classList.add('dc-flash');
      setTimeout(() => {
        copyBtn.textContent = o;
        copyBtn.classList.remove('dc-flash');
      }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(dump).then(ok, fallback);
    } else fallback();
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = dump;
      ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); ok(); }
      catch (_) { orig.error('[devconsole] copy failed'); }
      finally { ta.remove(); }
    }
  }

  window.__devconsole = {
    logs,
    show:    () => setVisible(true),
    hide:    () => setVisible(false),
    toggle:  () => setVisible(!visible),
    clear:   () => { logs.length = 0; if (body) body.innerHTML = ''; updateStat(); },
    copy:    copyAll,
    dump:    () => logs.map(e => fmtTime(e.ts) + ' [' + e.level + '] ' + e.text).join('\n'),
    exec:    execute,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }

  record('info', ['[devconsole] v2 готова. Ctrl+` toggle. Команды — в нижнем поле, Enter.']);
})();
