/* ─── core/tabs ────────────────────────────────────────────────
   Показ одной вкладки за раз (.stage.active).
   Gating: вкладки 02, 03, 04 заблокированы пока нет нужных данных.
──────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  window.Tabs = {};

  const TAB_INFO = {
    data:   { idx: '01', label: 'Данные' },
    inner:  { idx: '02', label: 'Поверхность' },
    zones:  { idx: '03', label: 'Сегментация' },
    unfold: { idx: '04', label: 'Развёртка' },
  };

  /* Вкладка доступна только если выполнен её gate */
  const gate = {
    data:   () => true,
    inner:  () => !!window.M.rawV,     // хотя бы сырой меш есть
    zones:  () => !!window.M.V,        // закоммичен активный под-меш
    unfold: () => !!window.M.zoneLabels,   // зоны посчитаны
  };

  window.Tabs.switchTo = function (name) {
    if (!TAB_INFO[name]) return;
    if (!gate[name]()) {
      toast('Вкладка «' + TAB_INFO[name].label + '» пока недоступна: выполните предыдущий этап.', 'warn');
      return;
    }
    window.M.currentTab = name;
    $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    $$('.stage').forEach(s => s.classList.toggle('active', s.dataset.stage === name));
    const info = TAB_INFO[name];
    const st = $('stStage'); if (st) st.textContent = info.idx + ' · ' + info.label;
    window.dispatchEvent(new CustomEvent('tab:change', { detail: { name } }));
  };

  /* Пересчёт доступности вкладок — вызывается, когда меняется M. */
  window.Tabs.refreshGates = function () {
    $$('.tab').forEach(b => {
      const name = b.dataset.tab;
      b.disabled = !gate[name]();
    });
  };

  document.addEventListener('DOMContentLoaded', function () {
    $$('.tab').forEach(b => {
      b.onclick = () => window.Tabs.switchTo(b.dataset.tab);
    });
    window.Tabs.refreshGates();
  });

  /* Любое изменение данных перепроверяет gates */
  window.addEventListener('data:change', window.Tabs.refreshGates);
})();
