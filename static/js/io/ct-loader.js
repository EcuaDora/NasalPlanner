/* ─── io/ct-loader ──────────────────────────────────────────
   Загрузка NRRD/NHDR-файла КТ в session под ключом ct_raw.

   CtLoader.handle(file) — чтобы file-loader.js мог
   вызывать её с drag&drop или multi-select (без дублирования кода).

   Сам <input type="file"> и кнопка "Открыть КТ" продолжают работать —
   они зовут ту же CtLoader.handle.

   Публичное API:
     window.CtLoader.upload(file)   — raw POST /api/upload/ct_raw (без UI)
     window.CtLoader.handle(file)   — полный flow: валидация + upload + toast

   События:
     'ct:change' { name, size }     — диспатчится после успешного upload'а
──────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  async function uploadCt(file) {
    const fd = new FormData();
    fd.append('file', file, file.name || 'ct.nrrd');
    const r = await fetch('/api/upload/ct_raw', {
      method: 'POST',
      body: fd,
    });
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try { const j = await r.json(); if (j.error) msg = j.error; } catch (_) {}
      throw new Error(msg);
    }
    return r.json();
  }

  async function handle(file) {
    const name = (file.name || '').toLowerCase();
    if (!(name.endsWith('.nrrd') || name.endsWith('.nhdr'))) {
      toast('Ожидается .nrrd. Файл: ' + file.name, 'err', 5000);
      return;
    }

    showSpinner('Загрузка КТ…');
    try {
      await uploadCt(file);
      hideSpinner();
      toast('КТ загружен: ' + file.name +
            ' (' + (file.size / 1024 / 1024).toFixed(1) + ' МБ)',
            'ok', 4000);
      window.dispatchEvent(new CustomEvent('ct:change', {
        detail: { name: file.name, size: file.size },
      }));
    } catch (err) {
      hideSpinner();
      console.error('[ct-loader]', err);
      toast('Ошибка загрузки КТ: ' + err.message, 'err', 7000);
    }
  }

  // Кнопка в хедере "Открыть КТ"
  window.addEventListener('DOMContentLoaded', () => {
    const btn   = document.getElementById('btnOpenCt');
    const input = document.getElementById('ctInput');
    if (!btn || !input) {
      console.warn('[ct-loader] #btnOpenCt / #ctInput не найдены в HTML');
      return;
    }
    btn.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      if (f) handle(f);
      input.value = '';   // повторный выбор того же файла сработает
    });
  });

  window.CtLoader = {
    upload: uploadCt,
    handle: handle,
  };
})();
