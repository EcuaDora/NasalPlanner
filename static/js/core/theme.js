/* ─── core/theme ───────────────────────────────────────────────
   По умолчанию — light. Класс .light-theme на <body> включает
   светлую палитру (переменные :root в CSS).
──────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  window.Theme = {};

  const apply = function (mode) {
    window.M.theme = mode;
    document.body.classList.toggle('light-theme', mode === 'light');
    $('labelLight').classList.toggle('active', mode === 'light');
    $('labelDark').classList.toggle('active', mode === 'dark');
    /* Пусть другие модули (render3d, unfold/render-2d) подстроят цвета */
    window.dispatchEvent(new CustomEvent('theme:change', { detail: { mode } }));
  };

  window.Theme.set = apply;
  window.Theme.toggle = function () {
    apply(window.M.theme === 'light' ? 'dark' : 'light');
  };
  window.Theme.get = function () { return window.M.theme; };

  /* Инициализация при старте.
     body уже имеет class="light-theme" из HTML. Здесь только синхронизируем M.theme с
     реальным классом body и вешаем обработчик переключателя. */
  document.addEventListener('DOMContentLoaded', function () {
    window.M.theme = document.body.classList.contains('light-theme') ? 'light' : 'dark';
    $('labelLight').classList.toggle('active', window.M.theme === 'light');
    $('labelDark').classList.toggle('active', window.M.theme === 'dark');
    const toggle = $('themeToggle');
    if (toggle) toggle.onclick = window.Theme.toggle;
  });
})();
