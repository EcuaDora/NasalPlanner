/* ─── core/modules ──────────────────────────────────────────────
   API реестра модулей. Сканирует DOM на DOMContentLoaded, строит
   список по атрибутам <script data-module-id="..." src="...">.
   Исходники подгружаются лениво через fetch() (когда пользователь
   кликает модуль в код-браузере).
──────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const registry = window.__modules;

  function upsert(entry) {
    const idx = registry.findIndex(m => m.id === entry.id);
    if (idx >= 0) registry[idx] = { ...registry[idx], ...entry };
    else registry.push(entry);
  }

  function scanDOM() {
    const nodes = document.querySelectorAll('script[data-module-id]');
    nodes.forEach(el => {
      const id = el.dataset.moduleId;
      if (!id) return;
      upsert({
        id,
        title: el.dataset.moduleTitle || id,
        path: el.getAttribute('src') || null,
        source: null,
      });
    });
  }

  function all() { return registry.slice(); }

  function get(id) {
    for (const m of registry) if (m.id === id) return m;
    return null;
  }

  function byGroup() {
    const groups = new Map();
    for (const g of window.__moduleGroups) groups.set(g.id, { ...g, items: [] });
    groups.set('misc', { id: 'misc', label: 'Разное', order: 99, items: [] });
    for (const m of registry) {
      const grp = (m.id || '').split('/')[0];
      (groups.get(grp) || groups.get('misc')).items.push(m);
    }
    return [...groups.values()]
      .filter(g => g.items.length > 0)
      .sort((a, b) => a.order - b.order);
  }


  async function fetchSource(id) {
    const m = get(id);
    if (!m) throw new Error('Модуль не найден: ' + id);
    if (m.source != null) return m.source;
    if (!m.path) throw new Error('У модуля нет пути (инлайновый)');
    const r = await fetch(m.path);
    if (!r.ok) throw new Error('HTTP ' + r.status + ' при загрузке ' + m.path);
    m.source = await r.text();
    return m.source;
  }

  function updateSource(id, newSrc) {
    const m = get(id);
    if (m) m.source = newSrc;
  }

  window.Modules = { all, get, byGroup, fetchSource, updateSource, scanDOM };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanDOM);
  } else {
    scanDOM();
  }
})();
