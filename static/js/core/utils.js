/* ─── core/utils ───────────────────────────────────────────────
   Мелкие помощники, которые нужны всюду. Никаких зависимостей.
──────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  window.$  = id => document.getElementById(id);
  window.$$ = sel => Array.from(document.querySelectorAll(sel));

  window.clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  window.lerp  = (a, b, t) => a + (b - a) * t;

  /* Форматтеры */
  window.fmtArea = function (mm2) {
    if (!isFinite(mm2)) return '—';
    return mm2 >= 100 ? (mm2 / 100).toFixed(2) + ' см²' : mm2.toFixed(1) + ' мм²';
  };
  window.fmtMM = function (mm) {
    return isFinite(mm) ? mm.toFixed(1) + ' мм' : '—';
  };
  window.fmtN = function (n) {
    return (n || 0).toLocaleString('ru-RU');
  };

  /* Toast-уведомления. Пишем все в #toastStack, сами гасим через dur мс. */
  window.toast = function (msg, kind = 'info', dur = 4000, opts) {
  const stack = $('toastStack');
  if (!stack) { console.log('[toast ' + kind + ']', msg); return; }
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  if (opts && opts.html) el.innerHTML = msg;
  else                   el.textContent = msg;
  stack.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(14px)';
    setTimeout(() => el.remove(), 260);
  }, dur);
};

  /* Spinner на .viewport внутри активной вкладки */
  window.showSpinner = function (text = 'Обработка…') {
    const sp = $('spinner');
    if (!sp) return;
    const txt = $('spinnerText');
    if (txt) txt.textContent = text;
    sp.classList.add('show');
  };
  window.hideSpinner = function () {
    const sp = $('spinner');
    if (sp) sp.classList.remove('show');
  };
  window.setSpinnerText = function (t) {
    const el = $('spinnerText');
    if (el) el.textContent = t;
  };

  /* Чтобы UI не фризил на долгих циклах */
  window.yieldUI = () => new Promise(r => setTimeout(r, 0));
  window.nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));
})();
