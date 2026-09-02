/* ─── io/session-archive ───────────────────────────────────────
   Сохранение и открытие сессии одним файлом .nplan (это обычный ZIP).

   ЗАЧЕМ. Сессия живёт во временной папке, которую atexit стирает при
   выходе: закрыли приложение — потеряли всё, от КТ до раскраски.
   Предупреждения не было никакого.

   ДВА РЕЖИМА. Полный кладёт всё, включая исходное КТ; лёгкий его
   пропускает. КТ тяжелее остального вместе взятого, а с этапа 02 работа
   идёт по мешу — для пересылки коллеге снимки чаще всего не нужны.

   ЧАСТЬ СОСТОЯНИЯ ЖИВЁТ ТОЛЬКО В ПАМЯТИ ВКЛАДКИ: раскраска, линия реза,
   точки. На диск они не попадают сами, поэтому перед упаковкой мы
   спрашиваем у вкладок, что у них есть, и кладём в сессию; при открытии
   — раздаём обратно. Отсюда реестр: вкладка регистрирует пару
   collect/restore и больше ни о чём не заботится.

   Кнопки встраиваются в шапку сами, рядом с переключателем темы, — так
   не приходится править nasal-planner.html, который у вас мог уйти
   вперёд моей копии.
──────────────────────────────────────────────────────────────── */
(function (global) {
  'use strict';
  console.log('[версия] archive · 2026-08-15 · один режим сохранения');

  const providers = [];   // { key, collect(), restore(data) }

  /* Перезагрузка после открытия архива — наша собственная, не уход
     пользователя. Без этого флага beforeunload считает её потерей работы и
     показывает НАТИВНОЕ окно «Перезагрузить сайт?», которое нельзя ни
     оформить, ни убрать из разметки: его рисует движок, а не страница.
     Выглядит внутри приложения как сбой, хотя всё идёт по плану. */
  let reloading = false;

  /* Вкладка объявляет: «вот мой кусок состояния под таким ключом».
     collect() возвращает объект (или null, если сохранять нечего),
     restore(data) принимает его обратно. */
  function register(key, collect, restore) {
    const i = providers.findIndex(p => p.key === key);
    const rec = { key: key, collect: collect, restore: restore };
    if (i >= 0) providers[i] = rec; else providers.push(rec);
  }

  function toast(msg, kind) {
    if (global.toast) return global.toast(msg, kind);
    if (global.Utils && global.Utils.toast) return global.Utils.toast(msg, kind);
    console.log('[archive] ' + msg);
  }

  // ═══════════════════════════════════════════════════════════
  //  Сохранение
  // ═══════════════════════════════════════════════════════════

  /* Сначала сбрасываем состояние вкладок в сессию, потом просим сервер
     собрать архив. Порядок важен: собери сервер архив раньше — в нём не
     оказалось бы ни раскраски, ни линии реза. */
  async function pushState() {
    for (const p of providers) {
      let data = null;
      try { data = p.collect ? p.collect() : null; } catch (e) {
        console.warn('[archive] ' + p.key + ': collect не удался', e);
        continue;
      }
      if (data == null) continue;
      try {
        await fetch('/api/session/' + p.key, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
      } catch (e) {
        console.warn('[archive] ' + p.key + ': не сохранился', e);
      }
    }
  }

  /* Имя по умолчанию — та же схема, что у сервера (nasal-ГГГГММДД-ЧЧММ).
     Считаем его на клиенте, чтобы показать диалог выбора ДО сборки архива:
     архив с КТ весит сотни мегабайт, и собирать его ради нажатия «Отмена»
     незачем. */
  function defaultName() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return 'nasal-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
           '-' + p(d.getHours()) + p(d.getMinutes()) + '.nplan';
  }

  async function save() {
    const bt = document.getElementById('nplan-save');
    if (bt) bt.classList.add('busy');
    try {
      await pushState();

      /* Режим один — полный, вместе с исходным КТ.

         Раньше их было два. Разница между ними ровно одна: класть или не
         класть ct_raw. Но ct_raw читают только инференс и обрезка ROI,
         то есть он нужен, чтобы переобработать снимок другой моделью или
         перекроить область. Это редкое, но незаменимое право: обучающая
         пара и меш пересчитываются, а исходный том — нет. Два режима
         заставляли выбирать между тем, что почти никогда не выбирают
         осознанно, и цена ошибки была односторонней. */

      /* Путь выбирает врач — нативным диалогом «Сохранить как».
         Сессия привязана к пациенту, и раскладывать её по своим папкам
         должен тот, кто потом будет её искать. */
      let handle = null;
      if (global.showSaveFilePicker) {
        try {
          handle = await global.showSaveFilePicker({
            suggestedName: defaultName(),
            types: [{
              description: 'Сессия Nasal Unwrap',
              accept: { 'application/zip': ['.nplan'] },
            }],
          });
        } catch (e) {
          // Отмена — это не ошибка, молча выходим.
          if (e && e.name === 'AbortError') {
            toast('Сохранение отменено', 'warn');
            return;
          }
          handle = null;   // API есть, но не сработал — уходим на запасной путь
        }
      }

      if (!handle) { await saveViaServer(); return; }

      const r = await fetch('/api/session/archive');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const blob = await r.blob();

      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();

      toast('Сохранено (' + (blob.size / 1048576).toFixed(1) + ' МБ): ' +
            '<b>' + handle.name + '</b>', 'ok');
    } catch (e) {
      toast('Не удалось сохранить: ' + e.message, 'error');
    } finally {
      if (bt) bt.classList.remove('busy');
    }
  }

  /* Запасной путь №1: сервер кладёт архив в свою папку и возвращает путь.
     Нужен там, где нет showSaveFilePicker — старый движок WebView2,
     нестандартный браузер. Врач не выбирает место, зато видит, куда легло. */
  async function saveViaServer() {
    const r = await fetch('/api/session/save_to_disk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    // Старый сервер без этого маршрута — откатываемся на скачивание.
    // Фронт теперь обновляется отдельно от бандла, рассогласование реально.
    if (r.status === 404 || r.status === 405) return saveViaDownload();

    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));

    toast('Сохранено (' + (d.size / 1048576).toFixed(1) + ' МБ):' +
          '<br><small>' + d.path + '</small>', 'ok');
  }

  /* Запасной путь №2: браузерная загрузка. Куда именно ляжет файл, решает
     движок окна — приложение об этом не знает и путь показать не может.
     Ровно поэтому это последний вариант, а не первый. */
  async function saveViaDownload() {
    const r = await fetch('/api/session/archive');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const blob = await r.blob();
    const cd = r.headers.get('Content-Disposition') || '';
    const m = /filename="?([^"\';]+)"?/.exec(cd);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = m ? m[1] : 'session.nplan';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Сохранено в папку «Загрузки»: ' +
          (blob.size / 1048576).toFixed(1) + ' МБ', 'ok');
  }

  // ═══════════════════════════════════════════════════════════
  //  Открытие
  // ═══════════════════════════════════════════════════════════

  async function open(file) {
    if (!file) return;
    /* Открытие затирает текущую сессию — смешивать два случая нельзя,
       получится каша из двух пациентов. Спрашиваем явно.

       Диалог свой, а не системный: браузерное окно с заголовком
       «Подтвердите действие на 127.0.0.1:8765» выглядит внутри
       приложения как сбой, а не как вопрос. */
    const ask = (global.Dialog && global.Dialog.confirm)
      ? global.Dialog.confirm({
          title: 'Открыть архив',
          html: 'Текущая работа будет <b>заменена</b> содержимым архива. ' +
                'Несохранённое пропадёт.',
          ok: 'Открыть',
        })
      : Promise.resolve(window.confirm('Открыть архив? Текущая работа будет заменена.'));
    if (!(await ask)) return;

    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await fetch('/api/session/archive', { method: 'POST', body: fd });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));

      /* Раздаём вкладкам их куски — но только те, что в архиве
         действительно были. Сервер возвращает список загруженных ключей;
         раньше я опрашивал всех подряд, и отсутствие раскраски давало в
         журнале сервера строку «GET /api/session/paint_layer 404».
         Ошибкой это не было, но в логе выглядело как поломка, а мы уже
         не раз шли по ложному следу из журнала. */
      const loaded = new Set(j.loaded || []);
      for (const p of providers) {
        if (!p.restore || !loaded.has(p.key)) continue;
        try {
          const rr = await fetch('/api/session/' + p.key);
          if (!rr.ok) continue;
          p.restore(await rr.json());
        } catch (e) {
          console.warn('[archive] ' + p.key + ': restore не удался', e);
        }
      }

      if (j.warning) toast(j.warning, 'warn');
      toast('Открыт архив от ' + (j.created || 'неизвестной даты'), 'ok');

      /* Перезагрузка — честнее выборочного обновления. Этапы держат
         состояние в замыканиях, и восстановить его точечно значит
         угадывать, что именно сбрасывать; пропущенное всплывёт позже и
         объяснить это будет нечем. */
      reloading = true;
      setTimeout(() => global.location.reload(), 900);
    } catch (e) {
      toast('Не удалось открыть: ' + e.message, 'error');
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  Кнопки в шапке
  // ═══════════════════════════════════════════════════════════

  const ICON_SAVE =
    '<svg width="15" height="15" viewBox="0 0 18 18" fill="none">' +
    '<path d="M9 2v8m0 0 3-3M9 10 6 7" stroke="currentColor" stroke-width="1.4" ' +
    'stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M3 12v2a2 2 0 002 2h8a2 2 0 002-2v-2" stroke="currentColor" ' +
    'stroke-width="1.4" stroke-linecap="round"/></svg>';
  const ICON_OPEN =
    '<svg width="15" height="15" viewBox="0 0 18 18" fill="none">' +
    '<path d="M9 10V2m0 0L6 5m3-3 3 3" stroke="currentColor" stroke-width="1.4" ' +
    'stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M3 12v2a2 2 0 002 2h8a2 2 0 002-2v-2" stroke="currentColor" ' +
    'stroke-width="1.4" stroke-linecap="round"/></svg>';

  function css() {
    if (document.getElementById('nplan-css')) return;
    const st = document.createElement('style');
    st.id = 'nplan-css';
    st.textContent = [
      '.nplan-box{display:flex;align-items:center;gap:4px;margin-right:14px;position:relative}',
      '.nplan-btn{width:32px;height:32px;display:flex;align-items:center;',
      '  justify-content:center;border:1px solid var(--brd,#dfe4ec);border-radius:8px;',
      '  background:transparent;color:var(--tx2,#5b6b80);cursor:pointer;transition:.12s}',
      '.nplan-btn:hover{background:rgba(127,127,127,.09);color:var(--tx1,#1f2a37)}',
      '.nplan-btn.busy{opacity:.5;pointer-events:none}',
      '.nplan-btn[disabled]{opacity:.38;cursor:default;pointer-events:none}',
      '  padding:5px;border-radius:10px;background:var(--card,#fff);',
      '  border:1px solid var(--brd,#dfe4ec);box-shadow:0 8px 24px rgba(20,30,45,.16)}',
      '  border:0;border-radius:7px;background:transparent;color:var(--tx1,#1f2a37);',
      '  font:inherit;font-size:13px;cursor:pointer;line-height:1.35}',
    ].join('');
    document.head.appendChild(st);
  }

  /* Кнопка сохранения приглушена, пока в сессии пусто.

     Раньше она была активна всегда, включая первую секунду после
     запуска: нажатие отдавало почти пустой файл, и понять, что это не
     поломка, было неоткуда.

     Опрашиваем сессию только ПОКА кнопка выключена и прекращаем, как
     только появился первый артефакт. Обратный переход бывает лишь при
     явном сбросе сессии, и его ловим при следующем открытии меню —
     держать постоянный опрос ради редкого случая незачем. */
  let _pollTimer = null;

  async function sessionHasData() {
    try {
      const r = await fetch('/api/session');
      if (!r.ok) return false;
      const m = await r.json();
      return !!(m && Object.keys(m).length);
    } catch (_) {
      return false;   // сервер недоступен — сохранять всё равно нечем
    }
  }

  async function refreshSaveEnabled() {
    const bt = document.getElementById('nplan-save');
    if (!bt) return false;
    const has = await sessionHasData();
    bt.disabled = !has;
    bt.title = has ? 'Сохранить сессию в файл' : 'Сохранять пока нечего';
    if (has && _pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    return has;
  }

  function watchSession() {
    if (_pollTimer) return;
    _pollTimer = setInterval(refreshSaveEnabled, 1500);
  }

  function mount() {
    if (document.getElementById('nplan-save')) return true;
    const right = document.querySelector('.header-right');
    if (!right) return false;
    css();

    const box = document.createElement('div');
    box.className = 'nplan-box';
    box.innerHTML =
      '<button type="button" class="nplan-btn" id="nplan-save" ' +
              'title="Сохранить сессию в файл">' + ICON_SAVE + '</button>' +
      '<button type="button" class="nplan-btn" id="nplan-open" ' +
              'title="Открыть сессию из файла">' + ICON_OPEN + '</button>' +
      '<input type="file" id="nplan-file" accept=".nplan,.zip" hidden>';
    right.insertBefore(box, right.firstChild);

    const saveBt = box.querySelector('#nplan-save');
    saveBt.addEventListener('click', () => save());

    const fileEl = box.querySelector('#nplan-file');
    box.querySelector('#nplan-open').addEventListener('click', () => fileEl.click());
    fileEl.addEventListener('change', () => {
      const f = fileEl.files && fileEl.files[0];
      fileEl.value = '';
      open(f);
    });

    refreshSaveEnabled().then(has => { if (!has) watchSession(); });
    return true;
  }

  /* Шапка может собираться позже нас — пробуем, пока не встанет. */
  function boot() {
    if (mount()) return;
    let n = 0;
    const t = setInterval(() => {
      if (mount() || ++n > 40) clearInterval(t);
    }, 150);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* Предупреждение при закрытии, если есть несохранённая работа. Раньше
     вкладка закрывалась молча и уносила с собой всё. */
  global.addEventListener('beforeunload', e => {
    if (reloading) return;   // наша перезагрузка после открытия архива
    let dirty = false;
    for (const p of providers) {
      try { if (p.collect && p.collect() != null) { dirty = true; break; } }
      catch (_) { /* пусто */ }
    }
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });

  global.SessionArchive = { register, save, open, pushState, refreshSaveEnabled };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.SessionArchive;
})(typeof window !== 'undefined' ? window : globalThis);
