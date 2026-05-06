/* ─── core/bootstrap ──────────────────────────────────────────────
   Первый скрипт после Three.js/pako. Готовит глобальные структуры,
   чтобы остальные модули могли спокойно делать window.X = ... .
─────────────────────────────────────────────────────────────────── */

/* Реестр модулей. Заполняется в core/modules.js после DOMContentLoaded
   путём сканирования DOM на <script data-module-id="..." src="...">.
   До этого момента — пустой массив. */
window.__modules = [];

/* Группы (для дерева в код-браузере). Порядок = порядок отображения. */
window.__moduleGroups = [
  { id: 'core',     label: 'Ядро',                 order: 0 },
  { id: 'io',       label: 'Ввод/вывод',           order: 1 },
  { id: 'geom',     label: 'Геометрия',            order: 2 },
  { id: 'anatomy',  label: 'Анатомия',             order: 3 },
  { id: 'unfold',   label: 'Развёртка',            order: 4 },
  { id: 'mpr',      label: 'MPR · срезы КТ',       order: 5 },
  { id: 'render3d', label: '3D рендер (Three.js)', order: 6 },
  { id: 'ui',       label: 'UI-компоненты',        order: 7 },
  { id: 'tabs',     label: 'Вкладки',              order: 8 },
];
