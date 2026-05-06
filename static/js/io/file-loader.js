/* ─── io/file-loader ──────────────────────────────────────────
   Единая точка входа для любого файла — через кнопку, multi-select
   или drag&drop. По расширению роутит:
     .obj          → свой пайплайн (upload → preprocess → render)


   Публичное API:
     window.FileLoader.load(file)        — роутинг по расширению
     window.FileLoader.loadMany(files)   — для drag&drop / multi-select
     window.FileLoader.loadObj(file)     — явно OBJ-пайплайн
     window.FileLoader.loadCt(file)      — явно CT-пайплайн (→ CtLoader)
     window.FileLoader.state             — { objReady, ctReady, objName, ctName }

   События (диспатчатся в window):
     'data:change'    { kind: 'obj-loaded' }  — OBJ готов к рендеру
     'ct:change'      { name, size }          — CT загружен (диспатчит CtLoader)
     'inputs:ready'   { obj, ct }             — оба есть, можно на таб 2
──────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  window.FileLoader = {};

  const state = {
    objReady: false,
    ctReady:  false,
    objName:  null,
    ctName:   null,
  };
  window.FileLoader.state = state;

  function renderInputsStatus() {
    const badge = document.getElementById('srcBadge');
    if (badge) {
      if (state.objReady && state.ctReady) {
        badge.textContent = 'OBJ + КТ';
      } else if (state.objReady) {
        badge.textContent = 'только OBJ';
      } else if (state.ctReady) {
        badge.textContent = 'только КТ';
      } else {
        badge.textContent = '—';
      }
    }

    // Карточка "Входные данные"
    const info = document.getElementById('inputsInfo');
    if (info) {
      const escape = (s) => String(s).replace(/[&<>"']/g, c => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
      }[c]));
      const row = (label, name, ok) => {
        const cls   = ok ? 'ok' : 'pending';
        const right = ok ? (name || 'загружено') : 'требуется';
        return '<div class="src-row ' + cls + '">' +
                 '<span class="src-dot"></span>' +
                 '<span class="src-lab">' + escape(label) + '</span>' +
                 '<span class="src-name" title="' + escape(right) + '">' +
                   escape(right) +
                 '</span>' +
               '</div>';
      };
      info.innerHTML =
        row('OBJ-меш',   state.objName, state.objReady)
    }

    // Оба на месте → сигнал tabs.js / tab1 о том что можно дальше
    if (state.objReady && state.ctReady) {
      window.dispatchEvent(new CustomEvent('inputs:ready', {
        detail: { obj: state.objName, ct: state.ctName },
      }));
    }
  }

  // Слушаем события от обоих лоадеров — единая точка обновления статуса
  window.addEventListener('data:change', (e) => {
    if (e.detail && e.detail.kind === 'obj-loaded') {
      state.objReady = true;
      if (window.M && window.M.source && window.M.source.name) {
        state.objName = window.M.source.name;
      }
      document.body.classList.add('obj-ready');
      renderInputsStatus();
    }
  });

  window.addEventListener('ct:change', (e) => {
    state.ctReady = true;
    if (e.detail && e.detail.name) state.ctName = e.detail.name;
    renderInputsStatus();
  });

  // ═══════════════════════════════════════════════════════════
  // Бэкенд-вызовы (OBJ-пайплайн)
  // ═══════════════════════════════════════════════════════════

  async function uploadToSession(file, key) {
    const fd = new FormData();
    fd.append('file', file, file.name || ('file.' + key));
    const r = await fetch('/api/upload/' + encodeURIComponent(key), {
      method: 'POST',
      body: fd,
    });
    if (!r.ok) throw new Error('upload(' + key + '): HTTP ' + r.status);
    return r.json();
  }

  async function runOperation(opName, params) {
    const r = await fetch('/api/' + encodeURIComponent(opName), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {}),
    });
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try { const j = await r.json(); if (j.error) msg = j.error; } catch (_) {}
      throw new Error(opName + ': ' + msg);
    }
    return r.json();
  }

  async function fetchArtifactText(key) {
    const r = await fetch('/api/session/' + encodeURIComponent(key));
    if (!r.ok) throw new Error('fetch(' + key + '): HTTP ' + r.status);
    return r.text();
  }

  function commitMesh(mesh, source) {
    window.M.reset();
    window.M.rawV   = mesh.V;
    window.M.rawF   = mesh.F;
    window.M.rawNV  = mesh.nV;
    window.M.rawNF  = mesh.nF;
    window.M.source = source;

    const g = window.Geom.compute(mesh.V, mesh.F, mesh.nF);
    window.M.fn = g.fn;
    window.M.fa = g.fa;
    window.M.fc = g.fc;

    window.dispatchEvent(new CustomEvent('data:change', {
      detail: { kind: 'obj-loaded' },
    }));
  }



  async function loadObj(file) {
    showSpinner('Загрузка OBJ на сервер…');
    try {
      await uploadToSession(file, 'mesh_raw');

      setSpinnerText('Препроцессинг…');
      await yieldUI();
      await runOperation('preprocess', {});   // {} = PARAMS-дефолты

      setSpinnerText('Получение результата…');
      await yieldUI();
      const cleanedText = await fetchArtifactText('mesh_clean');

      setSpinnerText('Парсинг OBJ…');
      await yieldUI();
      const mesh = window.IO.parseOBJ(cleanedText);
      if (!mesh.nV || !mesh.nF) {
        throw new Error('cleaned OBJ пустой (нет вершин или граней)');
      }

      commitMesh(mesh, {
        type: 'obj-cleaned',
        name: file.name,
        bytes: file.size,
        cleanedBytes: cleanedText.length,
      });

      hideSpinner();
      toast(
        '<strong>OBJ обработан</strong>: ' + mesh.nV.toLocaleString('ru') + ' вершин, ' +
                            mesh.nF.toLocaleString('ru') + ' граней',
        'ok', 4000, { html: true }
      );
    } catch (err) {
      // Fallback: бэкенд недоступен или preprocess упал → показать исходный меш
      console.error('[FileLoader] OBJ pipeline failed:', err);
      try {
        setSpinnerText('Бэкенд недоступен, парсю локально…');
        await yieldUI();
        const text = await file.text();
        const mesh = window.IO.parseOBJ(text);
        if (!mesh.nV || !mesh.nF) {
          throw new Error('В файле не найдено вершин или граней');
        }
        commitMesh(mesh, { type: 'obj-raw', name: file.name, bytes: file.size });
        hideSpinner();
        toast(
          '<strong>Препроцессинг не выполнен</strong> (' + err.message + '). ' +
          '<strong>Показан исходный меш:</strong> ' + mesh.nV.toLocaleString('ru') + ' вершин.',
          'err', 8000, { html: true }
        );
      } catch (fallbackErr) {
        hideSpinner();
        console.error('[FileLoader] OBJ fallback failed:', fallbackErr);
        toast('<strong>Ошибка загрузки OBJ:</strong> ' + fallbackErr.message, 'err', 7000, { html: true });
      }
    }
  }

  async function loadCt(file) {
    if (!window.CtLoader || !window.CtLoader.handle) {
      toast('CtLoader не готов — перезагрузите страницу', 'err', 6000);
      return;
    }
    await window.CtLoader.handle(file);
  }

  // ═══════════════════════════════════════════════════════════
  // Роутер
  // ═══════════════════════════════════════════════════════════

  function classify(file) {
    const n = (file.name || '').toLowerCase();
    if (n.endsWith('.obj'))  return 'obj';
    if (n.endsWith('.nrrd')) return 'ct';
    if (n.endsWith('.nhdr')) return 'ct';
    return null;
  }

  window.FileLoader.load = async function (file) {
    const kind = classify(file);
    if (kind === 'obj') return loadObj(file);
    if (kind === 'ct')  return loadCt(file);
    toast('<strong>Неподдерживаемый файл:</strong> ' + file.name +
          '. Ожидается .obj, .nrrd.', 'err', 6000, { html: true });
  };

  window.FileLoader.loadMany = async function (files) {
    // Сортировка: сначала OBJ (резетит obj-ветку на бэке и даёт 3D),
    // потом CT. В связке с reset_except(["ct_raw"]) на сервере это значит:
    // drag&drop "оба файла сразу" не теряет ни одного.
    const list = Array.from(files);
    const known   = list.filter(f => classify(f) !== null);
    const unknown = list.filter(f => classify(f) === null);

    known.sort((a, b) => {
      const pa = classify(a) === 'obj' ? 0 : 1;
      const pb = classify(b) === 'obj' ? 0 : 1;
      return pa - pb;
    });

    for (const u of unknown) {
      toast('<strong>Пропущено (неподдерживаемый формат):</strong> ' + u.name, 'err', 4000, { html: true });
    }

    // Последовательно — спиннер
    for (const f of known) {
      try {
        await window.FileLoader.load(f);
      } catch (e) {
        console.error('[FileLoader.loadMany]', f.name, e);
      }
    }
  };

  window.FileLoader.loadObj = loadObj;
  window.FileLoader.loadCt  = loadCt;

  // ═══════════════════════════════════════════════════════════
  // Drag & drop на весь документ
  // ═══════════════════════════════════════════════════════════

  let dragDepth = 0;  // вложенные enter/leave считаем глубиной

  function isDraggingFiles(e) {
    if (!e.dataTransfer) return false;
    const types = e.dataTransfer.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i++) {
      if (types[i] === 'Files' || types[i] === 'application/x-moz-file') return true;
    }
    return false;
  }

  function setDragActive(on) {
    document.body.classList.toggle('drag-active', on);
  }

  window.addEventListener('dragenter', (e) => {
    if (!isDraggingFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    setDragActive(true);
  });

  window.addEventListener('dragover', (e) => {
    if (!isDraggingFiles(e)) return;
    e.preventDefault();                             // ОБЯЗАТЕЛЬНО для drop
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', (e) => {
    if (!isDraggingFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDragActive(false);
  });

  window.addEventListener('drop', (e) => {
    if (!isDraggingFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    setDragActive(false);
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length > 0) {
      window.FileLoader.loadMany(files);
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Хук большой кнопки "Выбрать файлы" в empty-state.
  // Открываем мульти-селект для OBJ и NRRD сразу.
  // ═══════════════════════════════════════════════════════════

  window.addEventListener('DOMContentLoaded', () => {
    const bigBtn = document.getElementById('btnOpenBig');
    if (!bigBtn) return;

    // Свой скрытый инпут — чтобы не конфликтовать с #fileInput (он только .obj)
    let multiInput = document.getElementById('filesInputAll');
    if (!multiInput) {
      multiInput = document.createElement('input');
      multiInput.type = 'file';
      multiInput.id = 'filesInputAll';
      multiInput.accept = '.obj,.nrrd,.nhdr';
      multiInput.multiple = true;
      multiInput.style.display = 'none';
      document.body.appendChild(multiInput);
    }
    // Клонируем кнопку — сбрасываем возможные старые листенеры из file-dialog.js,
    // который раньше биндил её на открытие одиночного .obj.
    const fresh = bigBtn.cloneNode(true);
    bigBtn.parentNode.replaceChild(fresh, bigBtn);

    fresh.addEventListener('click', () => multiInput.click());
    multiInput.addEventListener('change', () => {
      const fs = multiInput.files;
      if (fs && fs.length) window.FileLoader.loadMany(fs);
      multiInput.value = '';
    });

    // Первичный рендер статуса "оба требуются"
    renderInputsStatus();
  });
})();
