/* ─── tabs/tab1-data ──────────────────────────────────────────
   Контроллер первой вкладки.
   Слушает data:change, обновляет панели и инициирует 3D-просмотр.

   Владеет: window.M.rawV / rawF / rawNV / rawNF / source.
   При смене исходного меша (новый OBJ) каскадно инвалидирует всё, что
   построено дальше (tab2 inner, tab3 zones, tab4 unfold), и блокирует
   соответствующие вкладки до полного перерасчёта.

   Также предоставляет кнопку «Сброс» — возвращает приложение к
   состоянию «файла нет», готовому принять новый OBJ.
──────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  console.log('[версия] tab1 · 2026-08-15 · этап 02 · достраивает просмотр при входе');
  window.Tab1 = {};

  let viewerInited = false;
  let resizeTimer  = null;

  function fmtBytes(n) {
    if (!n) return '—';
    if (n < 1024)             return n + ' Б';
    if (n < 1024 * 1024)      return (n / 1024).toFixed(1) + ' КБ';
    if (n < 1024 * 1024*1024) return (n / 1024 / 1024).toFixed(2) + ' МБ';
    return (n / 1073741824).toFixed(2) + ' ГБ';
  }

  function row(k, v) {
    return (
      '<div class="stat-row">' +
        '<span class="stat-k">' + k + '</span>' +
        '<span class="stat-v">' + v + '</span>' +
      '</div>'
    );
  }


  function updatePanels() {
    const M = window.M;
    const hasMesh = !!M.rawV;

    /* Бейдж «тип файла» */
    const srcBadge = $('srcBadge');
    if (srcBadge) srcBadge.textContent = hasMesh ? 'OBJ' : '—';

    /* Содержимое левой карточки «Исходный файл» */
    const srcInfo = $('srcInfo');
    if (srcInfo) {
      if (hasMesh) {
        srcInfo.innerHTML =
          '<div class="file-name">' + _escape(M.source.name || '—') + '</div>' +
          '<div class="hint-text dim">' +
            'размер: ' + fmtBytes(M.source.bytes || 0) +
          '</div>';
      } else {
        srcInfo.innerHTML =
          '<div class="hint-text dim" style="line-height:1.55">' +
            'Модели пока нет. Обычно она приходит с этапа 01 сама — после кнопки ' +
            '<span class="accent">«Продолжить»</span> там. Готовый OBJ можно ' +
            'открыть кнопкой в центре или перетащить в область просмотра.' +
          '</div>';
      }
    }

    /* Правая карточка «Статистика» */
    const stats = $('statsContent');
    const statsBadge = $('statsBadge');
    if (stats) {
      if (hasMesh) {
        const area = window.Geom.totalArea(M.fa, M.rawNF);
        const bb = window.Geom.bounds(M.rawV, M.rawNV);
        const dims = bb.size.map(v => Math.round(v)).join(' × ') + ' мм';

        /* Замкнутость: у исправной поверхности каждое ребро принадлежит
           ровно двум граням. Отклонения бывают ДВУХ разных видов, и
           раньше они складывались в одно число «открытых рёбер»:

             ровно 1 грань  — дыра, край поверхности;
             3 и больше     — грани сшиты лишний раз, поверхность сама
                              себя пересекает.

           Лечатся они по-разному, поэтому и считаем раздельно: врач,
           увидев «12 открытых рёбер», шёл затягивать дыры, которых нет.
           Считаем один раз при загрузке — на 200 тыс. граней доли секунды. */
        let openEdges = 0, gluedEdges = 0, edgeErr = false;
        try {
          const seen = new Map();
          const put = (a, b) => {
            const k = (a < b ? a : b) * 33554432 + (a < b ? b : a);
            seen.set(k, (seen.get(k) || 0) + 1);
          };
          for (let f = 0; f < M.rawNF; f++) {
            const a = M.rawF[f*3], b = M.rawF[f*3+1], c = M.rawF[f*3+2];
            put(a, b); put(b, c); put(c, a);
          }
          seen.forEach((n) => {
            if (n === 1) openEdges++;
            else if (n > 2) gluedEdges++;
          });
        } catch (e) { edgeErr = true; }   // не смогли посчитать — не врём врачу

        const clean = !edgeErr && openEdges === 0 && gluedEdges === 0;
        let closedTxt;
        if (edgeErr) closedTxt = '—';
        else if (clean) closedTxt = '<span style="color:#22c55e">замкнута ✓</span>';
        else if (openEdges) closedTxt = '<span style="color:#DD8844">разомкнута · ' +
                                        fmtN(openEdges) + '</span>';
        else closedTxt = '<span style="color:#DD8844">лишние сшивки · ' +
                         fmtN(gluedEdges) + '</span>';

        let html =
          row('габариты', dims) +
          row('площадь', fmtArea(area)) +
          row('поверхность', closedTxt) +
          row('граней', fmtN(M.rawNF));

        /* Если поверхность с дефектом — говорим, что с этим делать.
           Раньше карточка показывала число и замолкала. */
        if (!clean && !edgeErr) {
          html += '<div class="hint-text dim" style="margin-top:10px;font-size:11px;' +
                  'line-height:1.5;opacity:.75">' +
                  (openEdges
                    ? 'В поверхности есть незакрытые края. Вернитесь на этап 01 и ' +
                      'пройдитесь кнопками «Затянуть» и «Заполнить» — развёртке нужна ' +
                      'сплошная оболочка.'
                    : 'Часть граней сшита лишний раз — поверхность пересекает сама себя. ' +
                      'Обычно помогает «Сгладить» на этапе 01.') +
                  '</div>';
        }

        // бейдж «проверена» — только когда дефектов нет вовсе
        if (statsBadge) statsBadge.style.display = clean ? '' : 'none';
        stats.innerHTML = html;

      } else {
        if (statsBadge) statsBadge.style.display = 'none';
        stats.innerHTML =
          '<div class="hint-text dim">Габариты, площадь и проверка поверхности ' +
          'появятся, как только модель будет загружена.</div>';
      }
    }

    /* Блок заполнения #requirementsCard убран. Элемента с таким id нет
       ни в разметке, ни где-либо ещё — код не выполнялся никогда. Внутри
       было жёстко зашито «manifold ✓ замкнут» БЕЗ проверки openEdges:
       появись такая карточка, она уверяла бы, что поверхность замкнута,
       пока соседняя пишет «разомкнута · 12». Плюс «manifold» — слово не
       для врача. */

    // Кнопка перехода на этап «Поверхность» (появляется, как только есть меш).
    const nextCard = document.getElementById('dataNextCard');
    if (nextCard) nextCard.style.display = hasMesh ? 'block' : 'none';

    /* Рабочий процесс — подсветка текущего таба */


    /* Статус-бар снизу */
    const stMesh = $('stMesh');
    if (stMesh) stMesh.textContent = hasMesh ? (fmtN(M.rawNF) + ' F') : '—';
  }

  function ensureViewer() {
    if (viewerInited)   return true;
    if (!window.THREE)  return false;
    if (!window.Viewer) return false;
    const canvas = $('gl3d');
    if (!canvas) return false;
    if (window.Viewer.init(canvas)) {
      viewerInited = true;
      return true;
    }
    return false;
  }

  function showMeshInViewport() {
    const vp = document.querySelector('.stage[data-stage="data"] .viewport');
    if (vp) vp.classList.add('has-mesh');
    if (!ensureViewer()) return;
    window.Viewer.loadMesh(window.M);
    /* После toggle класса размер canvas мог поменяться */
    requestAnimationFrame(() => window.Viewer.resize());
  }

  function hideMeshFromViewport() {
    const vp = document.querySelector('.stage[data-stage="data"] .viewport');
    if (vp) vp.classList.remove('has-mesh');
    if (viewerInited) window.Viewer.clear();
  }

  window.Tab1.onActivate = function () {
    /* Меш мог прийти, пока вкладка была скрыта: так бывает при
       восстановлении сессии из архива. Холст тогда нулевого размера,
       ensureViewer() не проходит, и окно остаётся пустым — при том что
       панель справа показывает габариты и число граней, потому что они
       считаются из window.M, а не из картинки.

       Поэтому при входе не просто пересчитываем размер, а достраиваем
       просмотр, если его ещё нет. */
    if (!window.M.rawV) return;
    /* Строим просмотр заново при каждом входе, а не только если он ни
       разу не строился. Меш мог прийти при восстановлении из архива,
       пока вкладка была скрыта: ensureViewer() тогда отработал на холсте
       нулевого размера, viewerInited стал true, а картинки нет — и
       прежнее условие `if (!viewerInited)` больше никогда не срабатывало.
       loadMesh идемпотентен, лишний вызов стоит недорого. */
    showMeshInViewport();
    requestAnimationFrame(() => window.Viewer.resize());
  };

  window.addEventListener('inputs:ready', () => {
    const tab = document.querySelector('.tab[data-tab="inner"]');
    if (tab) tab.removeAttribute('disabled');
  });

  window.addEventListener('data:change', () => {
    updatePanels();
    if (window.M.rawV) showMeshInViewport();
    else               hideMeshFromViewport();
  });



  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (viewerInited) window.Viewer.resize();
    }, 100);
  });

  document.addEventListener('DOMContentLoaded', () => {
    updatePanels();
    /* Сброс живёт в шапке, у кнопок архива (io/session-archive.js):
       он чистит ещё и серверную сессию. */
    injectNextCard();
    injectResetCSS();
  });

  // ═════════════════════════════════════════════════════════════════════
  //  Инвалидация пайплайна и «Сброс»
  // ═════════════════════════════════════════════════════════════════════
  //
  //   • lockTab      — защёлкивает <button.tab> в state «disabled», чтобы
  //                    пользователь не мог перейти на неподготовленный шаг.
  //   • clearDerived — чистит всё, что построено поверх rawV/F: inner,
  //                    committed V/F, zone-состояние. НЕ трогает rawV/F.
  //   • cascadeInvalidate — вызывается, когда исходный меш сменился.
  //                    Блокирует 03/04 (02 остаётся доступной, т.к. под
  //                    новый rawV пользователь захочет сразу запустить
  //                    сегментацию). Диспатчит data:change «mesh-replaced».
  //   • resetAll     — полный откат к состоянию «файла нет». Блокирует
  //                    все 3 последующих таба, очищает rawV/F/source,
  //                    возвращает UI к empty-state.
  //
  function lockTab(name) {
    // Фактическая блокировка вкладок делается через
    // gate-функции в tabs.js + refreshGates() на data:change. Т.е.
    // `b.disabled` выставляется по результату gate[name](). Этот
    // setAttribute — только косметика на время между нашим delete
    // поля из window.M и следующим refreshGates: пусть кнопка
    // визуально станет disabled прямо сейчас, не дожидаясь события.
    const tab = document.querySelector('.tab[data-tab="' + name + '"]');
    if (!tab) return;
    tab.setAttribute('disabled', '');
    tab.setAttribute('aria-disabled', 'true');
    try { if ('disabled' in tab) tab.disabled = true; } catch (_) {}
  }

  function clearDerived() {
    const M = window.M;
    if (!M) return;
    // tab2 inner + закоммиченный активный меш
    delete M.V; delete M.F; delete M.nV; delete M.nF;
    delete M.innerV; delete M.innerF; delete M.innerNV; delete M.innerNF;
    // tab3 zones
    delete M.zoneLabels; delete M.zoneMeta;
    delete M.zoneFaces; delete M.zoneMeshes; delete M.zoneBoundaries;
  }

  function cascadeInvalidate() {
    clearDerived();
    // 02 не блокируем — под новый rawV inputs:ready уже выдал доступ
    // к сегментации, пользователь может сразу пройти её заново.
    lockTab('zones');
    lockTab('unfold');
    // Единый сигнал всем подписчикам — сбросить локальные кэши и
    // dispose'нуть редакторы, построенные на старых V/F.
    window.dispatchEvent(new CustomEvent('data:change', {
      detail: { kind: 'mesh-replaced' },
    }));
  }

  function resetAll() {
    const M = window.M;
    if (!M) return;
    // 1. Сброс всех производных + блокировка 02/03/04
    clearDerived();
    lockTab('inner');
    lockTab('zones');
    lockTab('unfold');
    // 2. Сброс исходника
    delete M.rawV; delete M.rawF; delete M.rawNV; delete M.rawNF;
    delete M.fa;
    if (M.source) {
      // Хранилище источника обнуляем, не удаляем — file-loader пишет сюда.
      M.source.name  = '';
      M.source.bytes = 0;
    }
    lastRawV = null;
    // 3. UI: выключаем obj-ready, чистим file-badge, возвращаем пустое
    //    состояние на stage 01.
    document.body.classList.remove('obj-ready');
    document.body.classList.remove('drag-active');
    const fn = document.getElementById('fileName');
    if (fn) fn.textContent = '';
    const fileInput = document.getElementById('fileInput');
    if (fileInput) fileInput.value = '';  // чтобы можно было выбрать тот же файл снова
    hideMeshFromViewport();
    // 4. Переключаемся на 01-ю вкладку (если пользователь нажал сброс
    //    из другой — он всё равно попадает сюда, т.к. остальные заперты).
    try {
      if (window.Tabs && typeof window.Tabs.switchTo === 'function') {
        window.Tabs.switchTo('data');
      }
    } catch (_) {}
    // 5. Единый сигнал — обновить все панели (updatePanels слушает этот
    //    же event) и дать всем контроллерам сбросить локальный кэш.
    window.dispatchEvent(new CustomEvent('data:change', {
      detail: { kind: 'reset' },
    }));
    // 6. Тост (если helper доступен)
    try {
      if (typeof toast === 'function') {
        toast('<strong>Данные сброшены.</strong> Можно открыть новый OBJ-файл.',
          'ok', 4000, { html: true });
      }
    } catch (_) {}
  }

  // Публикуем для возможного вызова из консоли / других мест
  window.Tab1.reset = resetAll;

  /* ─── Каскадная инвалидация при смене исходного меша ─────────────
     rawV-ссылка меняется при загрузке нового файла:
       - ПЕРВАЯ загрузка — каскад не нужен, производного ещё ничего нет;
       - ПОВТОРНАЯ       — инвалидируем всё, что построено ниже.

     АВТОПЕРЕХОДА ЗДЕСЬ БОЛЬШЕ НЕТ. Раньше на любой приход меша делался
     switchTo('inner'), то есть врача бросало сразу на этап 03. Написано
     это было, когда «Модель» была первой вкладкой и нумерация была
     другой; с появлением этапа «Разметка КТ» переход стал перескакивать
     через собственный этап.

     Событие obj-loaded шлют трое, и двое из них страдали:
       file-loader        — открыл OBJ кнопкой или перетаскиванием и сразу
                            оказался на «Слизистой», минуя проверку меша;
       bootstrap-from-session — открыл сохранённый .nplan и попал туда же,
                            где бы ни закончил в прошлый раз;
       goToData таба 01   — выживал случайно: он зовёт switchTo('data')
                            уже ПОСЛЕ dispatchEvent, и побеждал последний
                            вызов. Порядок двух строк держал весь сценарий.

     Ни шаг 3 инструкции («осмотрите поверхность и сверьтесь с карточкой
     Модель»), ни кнопка «Продолжить» при этом не были достижимы. Теперь
     этап переключает только явное действие врача. */
  let lastRawV = null;
  window.addEventListener('data:change', (e) => {
    const d = (e && e.detail) || {};
    // Событие-reset мы сами же отправили из resetAll — пропускаем,
    // чтобы не перезапустить каскад рекурсивно.
    if (d.kind === 'reset' || d.kind === 'mesh-replaced') return;
    const M = window.M;
    if (!M) return;
    if (M.rawV !== lastRawV) {
      const hadPrev = lastRawV !== null;
      lastRawV = M.rawV;
      if (hadPrev && M.rawV) cascadeInvalidate();
    }
  });

  // ═════════════════════════════════════════════════════════════════════
  //  Кнопка «Сброс» (инжектится в DOM)
  // ═════════════════════════════════════════════════════════════════════

  // Карточка «Далее: Поверхность» — переход на этап 02. Вставляется один раз,
  // показывается/скрывается из updatePanels() по наличию меша (см. #dataNextCard).
  function injectNextCard() {
    // Кнопка перехода живёт в ПРАВОЙ панели — как на табах 01, 03 и 04.
    const rightPanel = document.querySelector('.stage[data-stage="data"] .panel.right');
    if (!rightPanel) return;
    if (document.getElementById('dataNextCard')) return;  // уже вставлен

    const card = document.createElement('div');
    card.id = 'dataNextCard';            // без .card — кнопка идёт продолжением панели
    card.style.display = (window.M && window.M.rawV) ? 'block' : 'none';
    card.style.marginTop = '10px';
    card.innerHTML = [
      '<button type="button" class="btn-open-big data-next-btn" id="dataNextBtn">',
        '<span>Продолжить</span>',
        '<svg width="15" height="15" viewBox="0 0 18 18" fill="none">',
          '<path d="M5 3l7 6-7 6" stroke="currentColor" stroke-width="1.8" ',
                'stroke-linecap="round" stroke-linejoin="round"/></svg>',
      '</button>',
      '<div class="hint-text dim" style="margin-top:8px;font-size:11px;',
             'line-height:1.45;opacity:.6;text-align:center">',
        'Перейти к выделению слизистой',
      '</div>',
    ].join('');
    rightPanel.appendChild(card);

    const btn = document.getElementById('dataNextBtn');
    if (btn) btn.addEventListener('click', function () {
      if (window.Tabs && typeof window.Tabs.switchTo === 'function') window.Tabs.switchTo('inner');
    });
  }

  /* injectResetCard / onResetClick / appConfirm удалены.

     Карточка сброса не вставлялась (кнопка переехала в шапку, к архиву
     сессии, и чистит ещё и серверную сессию — чего эта не делала). Вслед
     за ней не вызывались ни обработчик, ни собственная модалка
     подтверждения: ~90 строк, до которых не доходило управление.

     CSS .app-modal-* из injectResetCSS ОСТАВЛЕН намеренно: этими же
     стилями рисует свою модалку segConfirm на этапе 01. */

  function injectResetCSS() {
    if (document.getElementById('tab1-reset-css')) return;
    const s = document.createElement('style');
    s.id = 'tab1-reset-css';
    s.textContent = [
      /* Карточка «Как это работает» нужна только пока модели нет: как только
         она загружена, её место занимает статистика, и держать рядом
         инструкцию по загрузке незачем. Тот же приём, что у #segHowCard на
         этапе 01. */
      'body.obj-ready .stage[data-stage="data"] #dataHowCard { display: none; }',

      /* ЗНАЧОК РАСКРЫТИЯ «Управления мышью» — шеврон, как на этапе 01.

         Правило живёт здесь, а НЕ в app.css. Базовое правило там
         (.stage[data-stage="data"] details#controlsCard > summary::after)
         остаётся нетронутым; наше перекрывает его тем же селектором, а
         выигрывает порядком — этот <style> добавляется в head после
         подключения app.css.

         Так сделано намеренно: правка общего файла один раз уже разъехалась
         по всем этапам сразу. Стиль одного этапа должен жить в файле этого
         этапа, тогда сломать можно только его.

         Исходный path смотрит ВЛЕВО: закрыто 180° → вправо, 270° → вниз. */
      '.stage[data-stage="data"] details#controlsCard > summary::after {',
      '  content: ""; flex: 0 0 auto; margin-right: 1px;',
      '  width: 10px; height: 14px;',
      '  background: currentColor; opacity: .55;',
      '  -webkit-mask: url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20width=%2710%27%20height=%2714%27%20viewBox=%270%200%2010%2014%27%20fill=%27none%27%3E%3Cpath%20d=%27M7%202l-4%205%204%205%27%20stroke=%27%23000%27%20stroke-width=%271.5%27%20stroke-linecap=%27round%27%20stroke-linejoin=%27round%27/%3E%3C/svg%3E") center / 10px 14px no-repeat;',
      '  mask: url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20width=%2710%27%20height=%2714%27%20viewBox=%270%200%2010%2014%27%20fill=%27none%27%3E%3Cpath%20d=%27M7%202l-4%205%204%205%27%20stroke=%27%23000%27%20stroke-width=%271.5%27%20stroke-linecap=%27round%27%20stroke-linejoin=%27round%27/%3E%3C/svg%3E") center / 10px 14px no-repeat;',
      '  transform: rotate(180deg);',
      '  transition: transform .15s ease;',
      '}',
      '.stage[data-stage="data"] details#controlsCard[open] > summary::after {',
      '  transform: rotate(270deg);',
      '}',

      /* ГЕОМЕТРИЯ СПИСКА ШАГОВ — КОПИЯ ЭТАПА 01.

         Общий класс .ep-steps-pre в app.css задаёт свои числа (отступ 28px,
         кружок 20px, шаг 10px), но ни один этап их не применяет: 01 правит их
         через .seg-steps, 03 — своим блоком, и оба ставят одно и то же.
         Список здесь взял базу напрямую и вышел заметно разреженнее соседних
         вкладок.

         Правим ТОЛЬКО этот этап. Общий класс не трогаем сознательно: его
         наследуют остальные экраны, и менять его ради одной вкладки значит
         вслепую двигать те, на которые сейчас никто не смотрит. */
      '.stage[data-stage="data"] .ep-steps-pre { font-size: 13px; line-height: 1.55; }',
      '.stage[data-stage="data"] .ep-steps-pre li {',
      '  padding-left: 26px; margin-bottom: 8px;',
      '}',
      '.stage[data-stage="data"] .ep-steps-pre li:last-child { margin-bottom: 0; }',
      '.stage[data-stage="data"] .ep-steps-pre li::before {',
      '  width: 18px; height: 18px; font-size: 10px;',
      '  background: rgba(0,240,255,0.10); border-color: var(--brd);',
      '}',
      '.light-theme .stage[data-stage="data"] .ep-steps-pre li::before {',
      '  background: rgba(79,124,219,0.08); border-color: rgba(79,124,219,0.3);',
      '  color: #4F7CDB;',
      '}',
      '.light-theme .stage[data-stage="data"] .ep-steps-pre b { color: #4F7CDB; }',

      /* ── empty-state: та же раскладка, что на этапе 01 ──
         Обёртка #dataLoadMode гасит gap:14px родителя между подписью,
         бейджем, кнопкой и подсказкой — внутри неё расстояния задают только
         их собственные margin-top (6 / 17 / 12), как в #segLoadMode. Без неё
         зазор складывался с margin и блок расползался. */
      '.stage[data-stage="data"] .empty-state { text-align: center; }',
      '.stage[data-stage="data"] #dataLoadMode {',
      '  display: flex; flex-direction: column; align-items: center;',
      '}',
      '.stage[data-stage="data"] .empty-formats {',
      '  display: flex; justify-content: center; width: 100%;',
      '}',
      '.stage[data-stage="data"] .empty-hint { width: 100%; text-align: center; }',
      '.stage[data-stage="data"] .btn-open-big {',
      '  display: inline-flex; align-items: center; justify-content: center; gap: 9px;',
      '}',
      '.stage[data-stage="data"] .btn-open-big svg { flex: 0 0 auto; display: block; }',

      /* кнопка перехода — синяя от .btn-open-big, как на табах 01, 03 и 04 */
      '.stage[data-stage="data"] #dataNextBtn {',
      '  width: 100%; margin-top: 0;',
      '  display: inline-flex; align-items: center; justify-content: center; gap: 8px;',
      '  padding: 12px 16px; font-size: 13px; letter-spacing: .06em;',
      '  white-space: nowrap; line-height: 1;',
      '}',
      '.stage[data-stage="data"] #dataNextBtn svg { flex: 0 0 auto; }',
      /* правая панель прокручивается, если содержимое не помещается */
      '.stage[data-stage="data"] .panel.right {',
      '  align-self: stretch; min-height: 0; height: 100%; max-height: none;',
      '  overflow-y: auto; padding-bottom: 14px;',
      '}',
      '.stage[data-stage="data"] .panel.right::-webkit-scrollbar { width: 9px; }',
      '.stage[data-stage="data"] .panel.right::-webkit-scrollbar-thumb {',
      '  background: var(--brd); border-radius: 5px;',
      '}',

      /* ═══ Общая тема приложения ═══ */
      '.app-modal-backdrop {',
      '  position: fixed; inset: 0; z-index: 10000;',
      '  display: flex; align-items: center; justify-content: center;',
      '  background: rgba(0, 5, 15, 0.72);',
      '  -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px);',
      '  animation: app-modal-fade 0.15s ease-out;',
      '}',
      '@keyframes app-modal-fade { from { opacity: 0; } to { opacity: 1; } }',
      '@keyframes app-modal-pop {',
      '  from { transform: translateY(6px) scale(0.985); opacity: 0; }',
      '  to   { transform: translateY(0) scale(1); opacity: 1; }',
      '}',
      '.app-modal {',
      '  min-width: 320px; max-width: 440px;',
      '  background: var(--card-solid, #0b1220);',
      '  border: 1px solid var(--brd-glow, rgba(0,240,255,.25));',
      '  border-radius: var(--rad, 8px);',
      '  box-shadow: 0 0 30px rgba(0,240,255,.06), 0 10px 40px rgba(0,0,0,.55);',
      '  padding: 20px 22px 16px;',
      '  position: relative;',
      '  animation: app-modal-pop 0.18s cubic-bezier(.2,.9,.3,1.2);',
      '}',
      /* тонкая неон-линия сверху — как у .card */
      '.app-modal::before {',
      '  content: ""; position: absolute;',
      '  top: 0; left: 16px; right: 16px; height: 1px;',
      '  background: linear-gradient(90deg, transparent, var(--cyan, #00f0ff), transparent);',
      '  opacity: 0.5;',
      '}',
      '.app-modal-title {',
      "  font-family: 'Orbitron','Segoe UI','Helvetica Neue',Roboto,sans-serif;",
      '  font-size: 12px; font-weight: 700;',
      '  letter-spacing: 0.14em; text-transform: uppercase;',
      '  color: var(--cyan, #00f0ff);',
      '  margin-bottom: 10px;',
      '  display: flex; align-items: center; gap: 8px;',
      '}',
      '.app-modal-title::before {',
      '  content: ""; width: 3px; height: 13px;',
      '  background: var(--cyan, #00f0ff);',
      '  box-shadow: 0 0 6px var(--cyan, #00f0ff);',
      '  border-radius: 1px; flex-shrink: 0;',
      '}',
      '.app-modal-body {',
      '  font-size: 13px; line-height: 1.55;',
      '  color: var(--tx, #c8e6ff);',
      '  margin-bottom: 18px;',
      '}',
      '.app-modal-actions {',
      '  display: flex; gap: 8px; justify-content: flex-end;',
      '}',
      '.app-modal-btn {',
      '  min-width: 96px; padding: 9px 16px;',
      '  border-radius: 4px; font: inherit; font-size: 12.5px;',
      '  font-weight: 600; letter-spacing: 0.02em;',
      '  cursor: pointer; background: transparent;',
      '  transition: background 0.14s ease, color 0.14s ease, ',
      '              border-color 0.14s ease, box-shadow 0.14s ease;',
      '}',
      '.app-modal-btn:focus-visible {',
      '  outline: 2px solid var(--brd-glow, rgba(0,240,255,.25));',
      '  outline-offset: 2px;',
      '}',
      '.app-modal-btn-ghost {',
      '  border: 1px solid var(--brd, rgba(0,240,255,.12));',
      '  color: var(--tx2, #6b8faa);',
      '}',
      '.app-modal-btn-ghost:hover {',
      '  border-color: var(--brd-glow, rgba(0,240,255,.25));',
      '  color: var(--tx, #c8e6ff);',
      '  background: rgba(0,240,255,0.04);',
      '}',
      '.app-modal-btn-warn {',
      '  border: 1px solid var(--warn, #ff9f3c);',
      '  color: var(--warn, #ff9f3c);',
      '  background: rgba(255,159,60,0.10);',
      '}',
      '.app-modal-btn-warn:hover {',
      '  background: rgba(255,159,60,0.20);',
      '  box-shadow: 0 0 12px rgba(255,159,60,0.25);',
      '}',

      /* ── light-theme ──────────────────────────────── */
      '.light-theme .app-modal-backdrop {',
      '  background: rgba(226,232,240,0.70);',
      '}',
      '.light-theme .app-modal {',
      '  background: #ffffff;',
      '  border-color: rgba(79,124,219,0.25);',
      '  box-shadow: 0 10px 40px rgba(30,60,120,0.15), 0 0 0 1px rgba(79,124,219,0.08);',
      '}',
      '.light-theme .app-modal::before {',
      '  background: linear-gradient(90deg, transparent, #4F7CDB, transparent);',
      '  opacity: 0.4;',
      '}',
      '.light-theme .app-modal-title { color: #4F7CDB; }',
      '.light-theme .app-modal-title::before { background: #4F7CDB; box-shadow: none; }',
      '.light-theme .app-modal-body { color: #1e293b; }',
      '.light-theme .app-modal-btn-ghost {',
      '  border-color: #dfe4ec; color: #475569;',
      '}',
      '.light-theme .app-modal-btn-ghost:hover {',
      '  border-color: rgba(79,124,219,0.4); color: #1e293b; background: #f8fafc;',
      '}',
      '.light-theme .app-modal-btn-warn {',
      '  border-color: #d97706; color: #d97706;',
      '  background: rgba(217,119,6,0.08);',
      '}',
      '.light-theme .app-modal-btn-warn:hover {',
      '  background: rgba(217,119,6,0.16);',
      '  box-shadow: 0 0 0 3px rgba(217,119,6,0.12);',
      '}',
    ].join('\n');
    document.head.appendChild(s);
  }

  /* ─── helpers ─── */
  function _escape(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
})();