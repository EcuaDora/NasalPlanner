/* ─── tabs/tab3-zones ──────────────────────────────────────────
   Этап 3: Автоматическая сегментация «седла» носового хода на 3 зоны
   (septum / floor / lateral) + ручная правка двумя ползунками,
   сдвигающими границы `sep↔flr` и `flr↔lat` морфологически на графе
   смежности граней. Ползунок = количество шагов дилатации одной
   зоны в сторону другой (одна итерация захватывает все грани,
   касающиеся «растущей» зоны на одном ребре).

   ВХОД (в window.M, коммитится табом 2 после finalize):
       window.M.V   — Float32Array вершин  [x,y,z, ...]
       window.M.F   — Uint32Array индексов [a,b,c, ...]
       window.M.nV, window.M.nF

   ВЫХОД (кладём в window.M после вычисления / правки):
       window.M.zoneLabels     — Uint8Array длины nF, значения 0/1/2

       window.M.zoneMeta       — { eML, eUP, eAP, areas:[sep,flr,lat], totalArea }

       window.M.zoneFaces      — { sep, flr, lat }: Int32Array индексов граней
                                  каждой зоны в window.M.F.

       window.M.zoneMeshes     — { sep, flr, lat }: каждая зона — автономный
                                  submesh со своими ремапированными индексами.
                                  Подходит для независимой UV-развёртки.
             Поля каждой зоны:
                 V        — Float32Array координат вершин submesh'а, [x,y,z,...]
                 F        — Uint32Array граней submesh'а (новые индексы)
                 nV, nF   — счётчики
                 origV[i] — индекс i-й вершины submesh'а в window.M.V
                 origF[i] — индекс i-й грани  submesh'а в window.M.F

       window.M.zoneBoundaries — { sep_flr, flr_lat, sep_lat }: Int32Array
                                  плоских 4-уплетов [faceA, faceB, vA, vB, ...],
                                  где (vA, vB) — общее ребро двух разнозонных
                                  соседних граней. Это «семы» для развёртки.
                                  sep_lat всегда пуст после enforceTopology.

   События на window:
       data:change { kind:'zones:done',        faces, areas }  — после автосегментации
       data:change { kind:'zones:edit',        faces, areas }  — после коммита ползунка
       data:change { kind:'zones:invalidated' }                — после изменения V/F в
                                                                 tab2 (или пересегментации):
                                                                 все zone*-поля в
                                                                 window.M удалены,
                                                                 tab4 обязан сбросить
                                                                 свой кэш.

   ЗАВИСИМОСТИ:
       - three.min.js            (global THREE)
       - js/core/viewer.js       (window.Viewer.create — общий viewer)
       - js/lib/saddle-seg.js    (window.SaddleSeg)
       - toast(), showSpinner(), hideSpinner(), setSpinnerText(), yieldUI()

   Mouse-семантика:
       ЛКМ / ПКМ  — orbit (стандартный viewer)
       Shift+ЛКМ  — pan
       Колесо     — зум
──────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  console.log('[версия] tab3 · 2026-08-15 · этап 04 · зоны регистрируются в архиве при загрузке');

  const LABEL_NAMES = ['Перегородка', 'Дно', 'Латеральная стенка'];
  const LABEL_KEYS  = ['septum', 'floor', 'lateral'];
  const SEP = 0, FLR = 1, LAT = 2;
  // DEL — «виртуальная» 4-я метка для граней, отрезанных «Ножницами».
  // Они исчезают из всех экспортов (zoneFaces / zoneMeshes / zoneBoundaries),
  // не участвуют в applyShifts (dilateLabel игнорирует чужие метки), и
  // визуально коллапсируются в degenerate-треугольник в положениях positions.
  // Это позволяет резать меш без переиндексации window.M.V / window.M.F —
  // индексы граней остаются стабильными для всех остальных модулей.
  const DEL = 3;

  // Палитра
  // HEX конвертируется в THREE.Color ниже.
  const COLOR_HEX = {
    [SEP]: 0x4a9eff,  // синий  — перегородка
    [FLR]: 0xff9f3c,  // амбер  — дно
    [LAT]: 0x5ce1a0,  // мята   — латеральная стенка
  };

  // ─────────────────────────────── состояние ───────────────────────────
  let zonesViewer = null;   // собственный Viewer для канваса gl3d-zones
  let editor = null;        // объект с геометрией, mask и UI — как в tab2


  const _toast = (msg, kind, ttl, opts) => {
    if (typeof toast === 'function') toast(msg, kind, ttl, opts);
    else console.log('[tab3-zones toast]', kind, msg);
  };
  // Локальный спиннер этапа 03 (#spinnerZones внутри stage[data-stage="zones"]).
  // Глобальные showSpinner/hideSpinner остаются вызванными «для совместимости» —
  // они оперируют #spinner внутри stage 1, который при display:none у неактивной
  // вкладки не виден. Локальный фолбэк лежит на той же вьюпорт-плоскости,
  // которую видит пользователь на этом табе, и появляется именно там.
  const _showSpinner = (t) => {
    if (typeof showSpinner === 'function') showSpinner(t);
    const sp = document.getElementById('spinnerZones');
    const tx = document.getElementById('spinnerZonesText');
    if (tx) tx.textContent = t || 'Обработка…';
    if (sp) sp.classList.add('show');
  };
  const _hideSpinner = ()  => {
    if (typeof hideSpinner === 'function') hideSpinner();
    const sp = document.getElementById('spinnerZones');
    if (sp) sp.classList.remove('show');
  };
  const _setSpinnerText = (t) => {
    if (typeof setSpinnerText === 'function') setSpinnerText(t);
    const tx = document.getElementById('spinnerZonesText');
    if (tx) tx.textContent = t || '';
  };
  const _yieldUI = ()  => (typeof yieldUI === 'function'
                           ? yieldUI()
                           : new Promise(r => setTimeout(r, 0)));

  // ─────────────── Транзакционные хелперы инвалидации ──────────────────
  //
  // Инвариант: всё, что tab3 кладёт в window.M (zoneLabels, zoneMeta,
  // zoneFaces, zoneMeshes, zoneBoundaries), должно быть согласовано с
  // window.M.V / window.M.F. Если V/F меняются в tab2 — все zone*
  // инвалидируются атомарно (одним коммитом), и tab4 получает сигнал
  // zones:invalidated, чтобы сбросить свой кэш.
  //
  // disposeEditor():      снимает UI и рендер текущего tab3.
  // invalidateZoneState():стирает все zone*-поля в window.M и диспатчит
  //                       событие zones:invalidated. Не трогает V/F —
  //                       ими владеет tab2.
  //
  function disposeEditor() {
    if (editor) {
      try { editor.dispose(); } catch (_) {}
      editor = null;
    }
  }
  function invalidateZoneState() {
    if (!window.M) return;
    const hadSomething = !!(window.M.zoneLabels || window.M.zoneMeta ||
                            window.M.zoneFaces  || window.M.zoneMeshes ||
                            window.M.zoneBoundaries);
    delete window.M.zoneLabels;
    delete window.M.zoneMeta;
    delete window.M.zoneFaces;
    delete window.M.zoneMeshes;
    delete window.M.zoneBoundaries;
    // блокировкой tab4 занимается ВНЕШНИЙ слушатель data:change
    // Сюда её класть нельзя: invalidateZoneState
    // также вызывается в начале runZoneSeg — там перед стартом пересчёта
    // tab4 уже заперт upstream-событием и lock+unlock пара могла бы
    // сбить внутренний state tabs.js.
    if (hadSomething) {
      window.dispatchEvent(new CustomEvent('data:change', {
        detail: { kind: 'zones:invalidated' },
      }));
    }
  }

  function lockUnfoldTab() {
    const tab = document.querySelector('.tab[data-tab="unfold"]');
    if (!tab) return;
    tab.setAttribute('disabled', '');
    tab.setAttribute('aria-disabled', 'true');
    try { if ('disabled' in tab) tab.disabled = true; } catch (_) {}
    // намеренно НЕ зовём window.Tabs.lock/disable. Источник истины
    // для «доступна ли вкладка» в tabs.js — gate-функция, которая
    // проверяет window.M.zoneLabels (и что там ещё). Поля мы уже
    // почистили в invalidateZoneState — refreshGates на следующем
    // data:change сам выставит вкладке disabled по-настоящему.
    // setAttribute — лишь косметика, чтобы пользователь не успел
    // кликнуть в промежутке между dispatch и refreshGates.
  }

  // ═════════════════════════════════════════════════════════════════════
  //  Инициализация разметки: вставляем канвас + empty-state с кнопкой Run
  //  Делается один раз при DOMContentLoaded. HTML менять не нужно.
  // ═════════════════════════════════════════════════════════════════════

  function setupStaticUI() {
    const stage = document.querySelector('.stage[data-stage="zones"]');
    if (!stage) return;

    const viewport = stage.querySelector('.viewport');
    if (!viewport) return;

    // 1. Канвас
    if (!document.getElementById('gl3d-zones')) {
      const canvas = document.createElement('canvas');
      canvas.id = 'gl3d-zones';
      canvas.style.cssText = 'display:none;width:100%;height:100%;';
      // Вставляем перед первым .empty-state, если он есть; иначе просто append.
      const empty = viewport.querySelector('.empty-state');
      if (empty) viewport.insertBefore(canvas, empty);
      else       viewport.appendChild(canvas);
    }

    // 2. Empty-state: подменяем содержимое на «Этап 3 — запуск автоматической сегментации»
    const empty = viewport.querySelector('.empty-state');
    if (empty) {
      empty.id = empty.id || 'zonesEmpty';
      empty.innerHTML = [
        '<div class="empty-title">Разметка зон</div>',
        '<div class="empty-sub" style="max-width:400px;line-height:1.5">',
          'Автоматически разделим слизистую на три зоны: ',
          '<span style="color:#4a9eff">перегородку</span>, ',
          '<span style="color:#ff9f3c">дно</span> и ',
          '<span style="color:#5ce1a0">латеральную стенку</span>. ',
          'Границы — кривые по поверхности, без пересечений и прямых стыков ',
          'перегородки с латералью.',
        '</div>',
        '<button type="button" class="btn-open-big btn-run-zones" ',
                'style="display:inline-flex;align-items:center;gap:8px;',
                       'margin-top:20px;min-width:260px;justify-content:center">',
          '<svg width="14" height="14" viewBox="0 0 18 18" fill="none">',
            '<path d="M5 4l9 5-9 5V4z" fill="currentColor"/>',
          '</svg>',
          'Запустить сегментацию',
        '</button>',
      ].join('');
    }

    // Делегированный клик по Run (только для empty-state — пока зон нет).
    // Кнопки внутри installUI имеют свои привязки (включая «Ножницы»).
    stage.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-run-zones');
      if (btn && !btn.disabled) runZoneSeg();
    });

    injectCSS();
  }



  async function runZoneSeg() {
    // Сбрасываем scheduled-gate. Поднимаем in-flight,
    // чтобы любой параллельный вызов (например, прямой Tab3.run() из
    // другого места) увидел занятость и тихо вышел.
    _segScheduled = false;
    if (_segInFlight) return;
    _segInFlight = true;

    // Валидация входа
    if (!window.SaddleSeg || typeof window.SaddleSeg.computeLabels !== 'function') {
      _toast('<strong>SaddleSeg не загружен.</strong> Добавьте ' +
             '<code>&lt;script defer src="js/lib/saddle-seg.js"&gt;</code> ' +
             'в HTML перед tab3-zones.js.', 'err', 10000, { html: true });
      _segInFlight = false;
      return;
    }
    if (!window.M || !window.M.V || !window.M.F || !window.M.nF) {
      _toast('Меш ещё не готов — сначала завершите этап 3.', 'err', 4000);
      _segInFlight = false;
      return;
    }

    // Транзакционный старт: снимаем старый редактор, обнуляем zone*-кэш
    // в window.M. Пользователи, подписанные на данные (tab4), получат
    // zones:invalidated прямо сейчас, а в конце runZoneSeg — zones:done
    // с новыми значениями.
    disposeEditor();
    invalidateZoneState();

    const stage = document.querySelector('.stage[data-stage="zones"]');
    const btns = stage
      ? stage.querySelectorAll('.btn-run-zones')
      : [];
    btns.forEach(b => b.disabled = true);

    _showSpinner('Оценка анатомических осей…');
    try {
      await _yieldUI();

      const V = window.M.V;
      const F = window.M.F;
      const nF = window.M.nF | 0;

      _setSpinnerText('Вычисление меток…');
      await _yieldUI();

      const t0 = performance.now();
      const out = window.SaddleSeg.computeLabels(
        { vertices: V, faces: F },
        { /* используем дефолты: floorBand=0.30, floorNormalWeight=0.70, wallNormalWeight=0.60 */ }
      );
      const dt = ((performance.now() - t0) / 1000).toFixed(2);

      _setSpinnerText('Рендер…');
      await _yieldUI();

      // Инициализируем viewer и редактор
      const v = ensureViewer();
      if (!v) throw new Error('viewer init failed');

      editor = Editor.install(v, V, F, out);

      // Коммит состояния в общий window.M
      commitZoneLabels(out, editor.state.fd.areas);

      // Показать канвас, спрятать empty-state
      const canvas = document.getElementById('gl3d-zones');
      const empty  = document.getElementById('zonesEmpty') ||
                     stage.querySelector('.empty-state');
      if (canvas) canvas.style.display = 'block';
      if (empty)  empty.style.display  = 'none';

      // Разблокируем таб «Развёртка»
      unlockUnfoldTab();

      _hideSpinner();

      // Сводка для тоста
      const s = editor.state;
      const areas = s.zoneAreas;
      const pct = k => (100 * areas[k] / Math.max(s.fd.totalArea, 1e-9)).toFixed(1);
      _toast(
        '<strong>Зоны готовы</strong> за ' + dt + ' с. ' +
        'Перегородка ' + pct(SEP) + ' % · ' +
        'дно ' + pct(FLR) + ' % · '  +
        'латер. ' + pct(LAT) + ' %.',
        'ok', 6000, { html: true }
      );
    } catch (err) {
      _hideSpinner();
      console.error('[tab3-zones]', err);
      _toast('<strong>Ошибка сегментации:</strong> ' + (err.message || err),
             'err', 8000, { html: true });
    } finally {
      btns.forEach(b => b.disabled = false);
      _segInFlight = false;
    }
  }

  function commitZoneLabels(out, areas) {
    const labels = out.labels;
    const nF = labels.length;
    const za = [0, 0, 0];
    let total = 0;
    for (let f = 0; f < nF; f++) {
      const a = areas[f];
      za[labels[f]] += a;
      total += a;
    }

    const zoneMeta = {
      eML: out.eML.slice(), eUP: out.eUP.slice(), eAP: out.eAP.slice(),
      areas: za, totalArea: total,
    };
    const exp = buildZoneExports(labels, window.M.V, window.M.F);
    window.M.zoneLabels = labels;
    window.M.zoneMeta       = zoneMeta;

    // Полный экспорт геометрии зон (submesh + границы) — для этапа 4.

    window.M.zoneFaces      = exp.zoneFaces;
    window.M.zoneMeshes     = exp.zoneMeshes;
    window.M.zoneBoundaries = exp.zoneBoundaries;

    // Сохраняем «канонический» snapshot tab3 — это то, что потом
    // восстанавливается при возврате с tab4 (server build перезаписывает
    // M.*, и без snapshot reinstall показал бы server'скую сегментацию,
    // а не нашу).
    _saveTab3Snapshot();

    window.dispatchEvent(new CustomEvent('data:change', {
      detail: { kind: 'zones:done', faces: nF, areas: za },
    }));
  }

  // ═════════════════════════════════════════════════════════════════════
  //  Экспорт геометрии зон для следующих этапов
  //
  //  Заполняет:
  //    zoneFaces     — { sep, flr, lat }: Int32Array индексов граней в window.M.F
  //    zoneMeshes    — { sep, flr, lat }: каждая зона — автономный submesh с
  //                    ремапированными индексами вершин (готов для UV-развёртки
  //                    или иной независимой обработки). Поля каждой зоны:
  //                      V        — Float32Array координат вершин, [x,y,z, ...]
  //                      F        — Uint32Array граней с новыми индексами
  //                      nV, nF   — счётчики
  //                      origV[i] — индекс i-й вершины submesh'a в window.M.V
  //                      origF[i] — индекс i-й грани  submesh'a в window.M.F
  //    zoneBoundaries — { sep_flr, flr_lat, sep_lat }: Int32Array плоских 4-уплетов
  //                     [faceA, faceB, vA, vB, ...], где (vA, vB) — общее ребро
  //                     двух разнозонных соседних граней. sep_lat должно быть
  //                     пустым после enforceTopology. Границы — "семы" для
  //                     развёртки.
  //
  //  Считается O(nV + nF), вызывается один раз при runZoneSeg и при каждом
  //  отпускании ползунка (`change`-событие), не при протаскивании.
  // ═════════════════════════════════════════════════════════════════════

  function buildZoneExports(labels, V, F) {
    const nF = labels.length;
    const nV = V.length / 3;

    // 1) zoneFaces — индексы граней каждой метки.
    //    DEL-грани (отрезаны «Ножницами») пропускаются полностью —
    //    в counts/zoneFacesArr они никогда не попадут.
    const counts = [0, 0, 0];
    for (let f = 0; f < nF; f++) {
      const k = labels[f];
      if (k > LAT) continue;          // DEL и любые мусорные метки — мимо
      counts[k]++;
    }
    const zoneFacesArr = [new Int32Array(counts[0]),
                          new Int32Array(counts[1]),
                          new Int32Array(counts[2])];
    const cur = [0, 0, 0];
    for (let f = 0; f < nF; f++) {
      const k = labels[f];
      if (k > LAT) continue;
      zoneFacesArr[k][cur[k]++] = f;
    }
    const zoneFaces = {
      sep: zoneFacesArr[SEP], flr: zoneFacesArr[FLR], lat: zoneFacesArr[LAT],
    };

    // 2) zoneMeshes — автономный submesh каждой зоны с ремапированными индексами.
    const zoneMeshes = { sep: null, flr: null, lat: null };
    const zoneKeys = ['sep', 'flr', 'lat'];
    for (let k = 0; k < 3; k++) {
      const facesK = zoneFacesArr[k];
      const nFk = facesK.length;
      if (nFk === 0) {
        zoneMeshes[zoneKeys[k]] = {
          V: new Float32Array(0), F: new Uint32Array(0),
          nV: 0, nF: 0,
          origV: new Int32Array(0), origF: facesK,
        };
        continue;
      }
      // Сбор уникальных вершин через oldToNew (-1 = не встречалась)
      const oldToNew = new Int32Array(nV);
      for (let i = 0; i < nV; i++) oldToNew[i] = -1;
      let nVk = 0;
      for (let i = 0; i < nFk; i++) {
        const f = facesK[i];
        for (let j = 0; j < 3; j++) {
          const oi = F[f*3 + j];
          if (oldToNew[oi] === -1) oldToNew[oi] = nVk++;
        }
      }
      const origV = new Int32Array(nVk);
      for (let oi = 0; oi < nV; oi++) {
        const ni = oldToNew[oi];
        if (ni !== -1) origV[ni] = oi;
      }
      const Vk = new Float32Array(nVk * 3);
      for (let ni = 0; ni < nVk; ni++) {
        const oi = origV[ni];
        Vk[ni*3]   = V[oi*3];
        Vk[ni*3+1] = V[oi*3+1];
        Vk[ni*3+2] = V[oi*3+2];
      }
      const Fk = new Uint32Array(nFk * 3);
      for (let i = 0; i < nFk; i++) {
        const f = facesK[i];
        Fk[i*3]   = oldToNew[F[f*3]];
        Fk[i*3+1] = oldToNew[F[f*3+1]];
        Fk[i*3+2] = oldToNew[F[f*3+2]];
      }
      zoneMeshes[zoneKeys[k]] = {
        V: Vk, F: Fk, nV: nVk, nF: nFk,
        origV: origV, origF: facesK,
      };
    }

    // 3) zoneBoundaries — рёбра, разделяющие грани разных меток.
    //    Собираем все manifold-рёбра с обеими гранями, проверяем их метки,
    //    кладём 4-уплеты (faceA, faceB, vA, vB).
    const edgeMap = new Map();
    for (let f = 0; f < nF; f++) {
      const a = F[f*3], b = F[f*3+1], c = F[f*3+2];
      const edges = [[a,b], [b,c], [c,a]];
      for (let e = 0; e < 3; e++) {
        const u = edges[e][0], v = edges[e][1];
        const lo = u < v ? u : v, hi = u < v ? v : u;
        const key = lo * 16777216 + hi;
        let arr = edgeMap.get(key);
        if (!arr) { arr = [lo, hi, -1, -1]; edgeMap.set(key, arr); }
        if (arr[2] === -1) arr[2] = f;
        else               arr[3] = f;
      }
    }
    const bSF = [], bFL = [], bSL = [];
    edgeMap.forEach(e => {
      const vA = e[0], vB = e[1], fA = e[2], fB = e[3];
      if (fB === -1) return;   // открытый край меша — пропуск
      const lA = labels[fA], lB = labels[fB];
      // Если хоть одна грань ребра отрезана «Ножницами» — не считаем это
      // ребро границей зоны. Иначе на этап 4 уйдут «семы», прижатые
      // к пустоте, и развёртка попытается шить вдоль исчезнувшей грани.
      if (lA > LAT || lB > LAT) return;
      if (lA === lB) return;
      const lo = lA < lB ? lA : lB;
      const hi = lA < lB ? lB : lA;
      if      (lo === SEP && hi === FLR) bSF.push(fA, fB, vA, vB);
      else if (lo === FLR && hi === LAT) bFL.push(fA, fB, vA, vB);
      else if (lo === SEP && hi === LAT) bSL.push(fA, fB, vA, vB);
    });
    const zoneBoundaries = {
      sep_flr: new Int32Array(bSF),
      flr_lat: new Int32Array(bFL),
      sep_lat: new Int32Array(bSL),    // обычно 0 после enforceTopology
    };

    return { zoneFaces, zoneMeshes, zoneBoundaries };
  }

  function unlockUnfoldTab() {
    const tab = document.querySelector('.tab[data-tab="unfold"]');
    if (!tab) return;
    tab.removeAttribute('disabled');
    tab.removeAttribute('aria-disabled');
    if ('disabled' in tab) { try { tab.disabled = false; } catch (_) {} }
    ['disabled', 'is-disabled', 'is-locked', 'locked', 'tab-disabled']
      .forEach(c => tab.classList.remove(c));
    try {
      if (window.Tabs && typeof window.Tabs.unlock === 'function')       window.Tabs.unlock('unfold');
      else if (window.Tabs && typeof window.Tabs.enable === 'function')  window.Tabs.enable('unfold');
    } catch (_) {}
    tab.dispatchEvent(new CustomEvent('tab:unlock', { bubbles: true }));
    window.dispatchEvent(new CustomEvent('tab:unlock', {
      detail: { name: 'unfold', tab: tab },
    }));
    // Явный refreshGates: в tabs.js есть gate-функция для 'unfold',
    // которая смотрит на поля window.M. После commitZoneLabels все
    // нужные поля уже выставлены — пересчитаем гейты, чтобы switchTo
    // не упал на «выполните предыдущий этап».
    // Тот же трюк использует tab2-inner после inner:saved (см. ~строку 1038).
    try {
      if (window.Tabs && typeof window.Tabs.refreshGates === 'function') {
        window.Tabs.refreshGates();
      }
    } catch (_) {}
  }



  function ensureViewer() {
    if (zonesViewer) return zonesViewer;
    if (!window.Viewer || !window.Viewer.create) return null;
    const canvas = document.getElementById('gl3d-zones');
    if (!canvas) return null;
    zonesViewer = window.Viewer.create(canvas);
    return zonesViewer;
  }


  function _saveTab3Snapshot() {
    if (!window.M || !window.M.V || !window.M.F || !window.M.zoneLabels) return;
    if (window.M.zoneLabels.length !== (window.M.F.length / 3)) return;
    window.M.__tab3Snapshot = {
      V: window.M.V,                    // typed-array, не мутируется снаружи
      F: window.M.F,
      nV: window.M.nV,
      nF: window.M.nF,
      zoneLabels: new Uint8Array(window.M.zoneLabels),  // копия — labels могут переписываться
      zoneMeta: window.M.zoneMeta ? {
        eML: window.M.zoneMeta.eML && window.M.zoneMeta.eML.slice(),
        eUP: window.M.zoneMeta.eUP && window.M.zoneMeta.eUP.slice(),
        eAP: window.M.zoneMeta.eAP && window.M.zoneMeta.eAP.slice(),
        areas: window.M.zoneMeta.areas && window.M.zoneMeta.areas.slice(),
        totalArea: window.M.zoneMeta.totalArea,
      } : null,
      zoneFaces:      window.M.zoneFaces,
      zoneMeshes:     window.M.zoneMeshes,
      zoneBoundaries: window.M.zoneBoundaries,
    };
  }

  // ───────────────────────────────────────────────────────────────────
  // Remap labels: snapshot.zoneLabels (для snapshot.V/F) → newLabels
  // (для newV/newF) через ближайший face-centroid.
  //
  // Зачем: server unfold возвращает result.V/F НОВОЙ геометрии (после
  // hole-fill / sanitize) и result.zoneLabels с ПЕРЕРАЗМЕТКОЙ — labels
  // распространены/перестроены на новые/изменённые грани по правилам
  // server'а (например, enforce sep↔lat → пустая граница). Это ломает
  // визуальную консистентность tab3 ↔ tab4 — на 4-м табе виден совсем
  // не тот раскрас, что на 3-м.
  //
  // Эта функция позволяет в патченном tab4 buildUnfold заменить
  // result.zoneLabels на наши snapshot-labels, переброшенные на server-mesh
  // через nearest-neighbor по центроидам. Сложность — O(nF_new × nF_old);
  // для типичных 8k граней это ~ 70M операций, ~ 150-300мс. Достаточно
  // быстро, чтобы не мешать UX.
  //
  // Экспортируется как window.__tab3RemapLabels(newV, newF, newNF).
  // Возвращает Uint8Array длины newNF, или null если snapshot отсутствует.
  // ───────────────────────────────────────────────────────────────────
  window.__tab3RemapLabels = function (newV, newF, newNF) {
    const snap = window.M && window.M.__tab3Snapshot;
    if (!snap || !snap.V || !snap.F || !snap.zoneLabels) return null;

    const oldV  = snap.V;
    const oldF  = snap.F;
    const oldL  = snap.zoneLabels;
    const oldNF = oldF.length / 3;


    const oldC = new Float64Array(oldNF * 3);
    for (let f = 0; f < oldNF; f++) {
      const a = oldF[f*3], b = oldF[f*3+1], c = oldF[f*3+2];
      oldC[f*3]   = (oldV[a*3]   + oldV[b*3]   + oldV[c*3])   / 3;
      oldC[f*3+1] = (oldV[a*3+1] + oldV[b*3+1] + oldV[c*3+1]) / 3;
      oldC[f*3+2] = (oldV[a*3+2] + oldV[b*3+2] + oldV[c*3+2]) / 3;
    }

    const newL = new Uint8Array(newNF);
    // Для каждого нового face — ближайший старый face → его label.
    for (let nf = 0; nf < newNF; nf++) {
      const a = newF[nf*3], b = newF[nf*3+1], c = newF[nf*3+2];
      const cx = (newV[a*3]   + newV[b*3]   + newV[c*3])   / 3;
      const cy = (newV[a*3+1] + newV[b*3+1] + newV[c*3+1]) / 3;
      const cz = (newV[a*3+2] + newV[b*3+2] + newV[c*3+2]) / 3;
      let bestD = Infinity, bestI = 0;
      for (let of = 0; of < oldNF; of++) {
        const dx = oldC[of*3]   - cx;
        const dy = oldC[of*3+1] - cy;
        const dz = oldC[of*3+2] - cz;
        const d2 = dx*dx + dy*dy + dz*dz;
        if (d2 < bestD) { bestD = d2; bestI = of; }
      }
      newL[nf] = oldL[bestI];
    }
    return newL;
  };

  // ───────────────────────────────────────────────────────────────────
  // Tabs.switchTo делает forEach по 4 stages и toggle'ит class 'active'.
  // MutationObserver слушает класс на ВСЕХ stages → syncActiveStates
  // дёргается до 4 раз в одном тике event-loop. Без дедупликации каждый
  // вызов планировал свой setTimeout(runZoneSeg, 40) — через 40мс
  // стартовали 3-4 параллельных runZoneSeg, каждый со своим disposeEditor /
  // commitZoneLabels / data:change('zones:done').
  //
  // _segScheduled — есть ли отложенный setTimeout (gate для повторных
  //                 setTimeout'ов в течение того же тика).
  // _segInFlight  — выполняется ли runZoneSeg прямо сейчас (защита на
  //                 случай если scheduling-gate как-то проскочил).
  let _segScheduled = false;
  let _segInFlight  = false;

  // ───────────────────────────────────────────────────────────────────
  //   Sampling-based сравнение: одинаковая длина + N контрольных точек.
  //   Тот же приём, что в tab4.diagnoseState (_labelsEqual).
  //
  //   ИСТОРИЯ. Заводилось это под этап 05: он писал результат сервера в
  //   window.M, ссылки на массивы менялись, и `editor.state.sourceV !==
  //   window.M.V` срабатывало как ложно-положительное — редактор сносился
  //   и зоны пересегментировались на ровном месте, при простом возврате
  //   без единой правки. Теперь этап 05 общее состояние не трогает, и
  //   ложных срабатываний от него нет.
  //
  //   Проверку оставляем: массивы пересоздаёт ещё и этап 03 при повторной
  //   сегментации, и там она по-прежнему нужна. Стоит она сотню сравнений.
  //
  //   Возвращает true, если массивы одинаковой длины и совпадают в нескольких
  //   контрольных позициях (начало, конец, псевдослучайные — этого достаточно,
  //   чтобы отличить «новый ref с тем же содержимым» от «реально другая
  //   геометрия после правки»).
  function _meshContentEqual(oldV, newV, oldF, newF) {
    if (!oldV || !newV || !oldF || !newF) return false;
    if (oldV === newV && oldF === newF) return true;
    if (oldV.length !== newV.length || oldF.length !== newF.length) return false;
    const checkAt = (a, b) => {
      const n = a.length;
      const idx = [0, 1, 2, 3, n-1, n-2, n-3, n-4];
      for (let k = 0; k < 24; k++) idx.push((k * 2654435761) % n);
      for (const i of idx) if (a[i] !== b[i]) return false;
      return true;
    };
    return checkAt(oldV, newV) && checkAt(oldF, newF);
  }

  function syncActiveStates() {
    const stage = document.querySelector('.stage[data-stage="zones"]');
    if (!stage) return;
    const active = stage.classList.contains('active');
    if (zonesViewer) {
      zonesViewer.setActive && zonesViewer.setActive(active);
      if (active && zonesViewer.resize) zonesViewer.resize();
    }
    if (!active) return;
    if (!window.M || !window.M.V || !window.M.F || !window.M.nF) return;

    // Сверка «editor всё ещё актуален».
    //
    // Случаи и реакции:
    //   A) sourceV/F совпадают по identity с M.V/F → editor актуален, ничего не делаем.
    //   B) identity разошлась, но содержимое то же → tab2/tab4 пересоздали typed-array
    //      с теми же значениями. Просто синхронизируем ссылки.
    //   C) identity разошлась, содержимое разное, но в M.zoneLabels лежат валидные
    //      labels (длина === M.nF) — меш пересобрал этап 03, а метки к нему уже
    //      подходят. SaddleSeg запускать НЕ надо: переустанавливаем editor
    //      на готовых labels через _reinstallEditorFromCache().
    //      (Прежде сюда же попадал возврат с этапа 05 — он подменял меш своим
    //      серверным. Больше не подменяет.)
    //   D) identity разошлась, содержимое разное, M.zoneLabels отсутствует или
    //      рассинхронизирован — нужна полная пересегментация SaddleSeg'ом.
    //
    // Случай (C) ключевой для проблемы «пустых экранов tab4 после пересегментации»:
    // раньше мы всегда диспатчили zones:done через commitZoneLabels, и tab4
    // дисозил свой cache, отдавая пустые экраны. Теперь при reinstall'е cache
    // tab4 не трогается — он остаётся валидным.
    if (editor && (editor.state.sourceV !== window.M.V ||
                   editor.state.sourceF !== window.M.F)) {
      if (_meshContentEqual(editor.state.sourceV, window.M.V,
                            editor.state.sourceF, window.M.F)) {
        // (B) — содержимое то же, синхронизируем ссылки editor'а.
        editor.state.sourceV = window.M.V;
        editor.state.sourceF = window.M.F;
      } else {
        // (C) или (D) — реально другая геометрия. Editor устарел, но не
        // обязательно нужен SaddleSeg. Решение принимается ниже — после
        // disposeEditor() — в блоке `if (!editor)`.
        disposeEditor();
        // ВАЖНО: не зовём invalidateZoneState() здесь. Если M.zoneLabels
        // согласованы с M.F (случай C), они нам нужны. Очистка их в
        // M будет помехой, и заодно диспатчит zones:invalidated → tab4
        // ненужно дисозит cache.
      }
    }

    if (!editor && !_segScheduled && !_segInFlight) {
      // Решаем: можно ли переустановить editor с готовыми labels (C),
      // или нужна полная пересегментация SaddleSeg'ом (D).
      const labelsValid = !!(window.M.zoneLabels &&
                             window.M.zoneLabels.length === window.M.nF &&
                             window.M.zoneMeta &&
                             window.M.zoneMeta.eML);
      if (labelsValid) {
        // (C) Тонкий путь — переустанавливаем editor с готовыми данными.
        // Без SaddleSeg, без commitZoneLabels, без zones:done. Tab4 cache
        // не страдает.
        try {
          _reinstallEditorFromCache();
        } catch (err) {
          console.warn('[tab3] reinstall from cache failed, falling back to full segmentation:', err);
          _segScheduled = true;
          setTimeout(runZoneSeg, 40);
        }
      } else {
        // (D) Полная пересегментация — labels отсутствуют или несогласованы.
        _segScheduled = true;
        setTimeout(runZoneSeg, 40);
      }
    }
  }

  // _reinstallEditorFromCache: пересоздать editor под текущие window.M.V/F/zoneLabels
  // БЕЗ запуска SaddleSeg.computeLabels и БЕЗ commitZoneLabels.
  //
  // КЛЮЧЕВОЙ МОМЕНТ: ДО Editor.install мы диспатчим data:change kind:'zones:edit'.
  // Это заставляет tab4 вызвать disposeCache, который сбрасывает не только
  // cache, но и `_origInput` — snapshot геометрии, который tab4 хранит для
  // повторных build'ов.
  function _reinstallEditorFromCache() {
    // Note: НЕ диспатчим zones:edit и НЕ делаем restore М.* из snapshot.
    //
    // Раньше делали — это вызывало tab4.disposeCache на каждый возврат
    // tab4→tab3 и затем auto-build на каждый tab3→tab4 (~3с server-call),
    // даже когда пользователь ничего не правил.
    //
    // Теперь:
    //   · Если правка на tab3 БЫЛА (ползунок, ножницы) — emitChange /
    //     compactMeshFromDeletions сами диспатчат zones:edit → tab4
    //     инвалидирует cache → при заходе на tab4 запустится build.
    //   · Если правки НЕ БЫЛО — ничего не диспатчится, tab4 cache живой,
    //     возврат на tab4 моментальный.
    //
    // editor пересоздаём всегда (geometry изменилась после server build —
    // это надо для корректной кисти/ползунков на новом mesh). Но это
    // только UI-операция в tab3, на tab4 она не отражается.
    //
    // tab3 cache (window.M.zoneLabels) после server build уже содержит
    // remapped-labels (см. __tab3RemapLabels)

    const v = ensureViewer();
    if (!v) throw new Error('viewer init failed in reinstall');
    const meta = window.M.zoneMeta;
    const out = {
      labels: window.M.zoneLabels,
      eML: meta.eML, eUP: meta.eUP, eAP: meta.eAP,
    };
    editor = Editor.install(v, window.M.V, window.M.F, out);
    unlockUnfoldTab();

    const stage = document.querySelector('.stage[data-stage="zones"]');
    const canvas = document.getElementById('gl3d-zones');
    const empty  = document.getElementById('zonesEmpty') ||
                   (stage && stage.querySelector('.empty-state'));
    if (canvas) canvas.style.display = 'block';
    if (empty)  empty.style.display  = 'none';
  }

  function installTabWatcher() {
    const stages = document.querySelectorAll('.stage');
    if (!stages.length) return;
    const mo = new MutationObserver(syncActiveStates);
    stages.forEach(s => mo.observe(s, { attributes: true, attributeFilter: ['class'] }));
    syncActiveStates();
  }


  /* Вход на этап 04: если метки есть, а редактора нет — открываем из
     них. Ставить редактор во время фоновой загрузки нельзя: холст тогда
     скрыт и нулевого размера, картинка не строится, а сам объект
     редактора уже существует — и вкладка потом считает, что показывать
     нечего.

     Прежняя версия этой правки стояла в обработчике ниже, у которого
     первой строкой `if (name !== 'unfold') return` — то есть вызывалась
     при переходе на этап 05 и на этап зон не попадала никогда. */
  window.addEventListener('tab:change', (e) => {
    if (!e.detail || e.detail.name !== 'zones') return;
    if (editor || !window.M || !window.M.zoneLabels) return;
    if (!window.Tab3 || !window.Tab3.restoreFromSession) return;
    setTimeout(() => {
      try { window.Tab3.restoreFromSession(); }
      catch (err) { console.warn('[tab3] восстановление:', err); }
    }, 60);      // даём вкладке отрисоваться, чтобы холст получил размер
  });

  window.addEventListener('tab:change', (e) => {
    const name = e.detail && e.detail.name;
    if (name !== 'unfold') return;

    /* Авто-построение развёртки отсюда УБРАНО — им занимается сам этап
       05 в Tab4.onActivate.

       Здесь оно и появилось-то по случайности: нужно было покрыть все
       пути, на которых кэш tab4 сброшен (reinstall редактора, ножницы,
       ползунки, первый заход), а событие перехода ловилось уже здесь.
       Цена — tab3 читал класс t4-built чужой стадии, то есть опирался
       на оформление этапа 05 и на порядок, в котором тот выставляет
       свои классы. Кто сбросил кэш, тот и знает об этом лучше всех:
       решение переехало туда, где живёт сам кэш.

       Ниже остаётся то, что действительно наше: доуплотнение меша,
       если врач удалил грани и ушёл на этап 05 мимо кнопки «Далее». */

    // Compact safeguard для случая, когда editor имеет deletedFaces
    // (например, переход на tab4 по клику на сам таб, минуя nextBtn).
    if (!editor || !editor.state) return;
    const s = editor.state;
    if (!s.deletedFaces) return;

    // Guard: editor.state.sourceV/F должны указывать на ТЕКУЩИЕ window.M.V/F.
    // Иначе deletedFaces проиндексированы под старую геометрию — compact
    // даст мусор. Этап 05 меш больше не подменяет, так что расхождение
    // означает правку на этапе 03; проверку держим ради неё.
    // Если ссылки разошлись, но содержимое то же — это нормально, но deletedFaces всё равно валидны (индексы граней
    // совпадают). Поэтому проверяем по содержимому, как там же.
    if (s.sourceV !== window.M.V || s.sourceF !== window.M.F) {
      if (!_meshContentEqual(s.sourceV, window.M.V, s.sourceF, window.M.F)) {
        // Реально другая геометрия — compact небезопасен. Молча выходим:
        // на следующий заход в tab3 syncActiveStates сделает пересчёт.
        return;
      }
      // Тот же контент — синхронизируем ссылки на лету.
      s.sourceV = window.M.V;
      s.sourceF = window.M.F;
    }

    let any = 0;
    for (let f = 0; f < s.fd.nF; f++) if (s.deletedFaces[f]) { any = 1; break; }
    if (!any) return;
    // Та же compact-функция, что и nextBtn. Здесь editor.compact —
    // тонкий wrapper, его прокидываем в Editor.install
    if (typeof editor.compact === 'function') {
      try { editor.compact(); } catch (err) { console.warn('[tab3] compact', err); }
    }
  });

  // ═════════════════════════════════════════════════════════════════════
  //   Внутренний неймспейс: строит геометрию, красит грани по меткам,
  //   даёт кисть для правки + UI панелей.
  // ═════════════════════════════════════════════════════════════════════

  const Editor = (function () {

    const COLOR_OBJ = {
      [SEP]: new THREE.Color(COLOR_HEX[SEP]),
      [FLR]: new THREE.Color(COLOR_HEX[FLR]),
      [LAT]: new THREE.Color(COLOR_HEX[LAT]),
    };

    // ─── Локальная геометрия (не переиспользуем SaddleSeg-внутренности,
    //      чтобы иметь собственный CSR и площади независимо от алгоритма).
    function buildFaceData(V, F) {
      const nF = F.length / 3;
      const positions = new Float32Array(nF * 9);
      const normals   = new Float32Array(nF * 9);
      const colors    = new Float32Array(nF * 9);
      const fc        = new Float32Array(nF * 3);
      const areas     = new Float32Array(nF);
      let totalArea = 0;

      for (let f = 0; f < nF; f++) {
        const i0 = F[f*3]*3, i1 = F[f*3+1]*3, i2 = F[f*3+2]*3;
        const ax=V[i0], ay=V[i0+1], az=V[i0+2];
        const bx=V[i1], by=V[i1+1], bz=V[i1+2];
        const cx=V[i2], cy=V[i2+1], cz=V[i2+2];
        const o = f * 9;
        positions[o  ]=ax; positions[o+1]=ay; positions[o+2]=az;
        positions[o+3]=bx; positions[o+4]=by; positions[o+5]=bz;
        positions[o+6]=cx; positions[o+7]=cy; positions[o+8]=cz;

        let nx = (by-ay)*(cz-az) - (bz-az)*(cy-ay);
        let ny = (bz-az)*(cx-ax) - (bx-ax)*(cz-az);
        let nz = (bx-ax)*(cy-ay) - (by-ay)*(cx-ax);
        const crossLen = Math.hypot(nx, ny, nz);
        const L = crossLen || 1;
        nx/=L; ny/=L; nz/=L;
        for (let k=0; k<3; k++) {
          normals[o+k*3  ]=nx; normals[o+k*3+1]=ny; normals[o+k*3+2]=nz;
        }
        fc[f*3  ]=(ax+bx+cx)/3;
        fc[f*3+1]=(ay+by+cy)/3;
        fc[f*3+2]=(az+bz+cz)/3;
        const a = crossLen * 0.5;
        areas[f] = a;
        totalArea += a;
      }

      // CSR-смежность по рёбрам (2 общих фейса на ребро)
      const edgeMap = new Map();
      const pushE = (a, b, f) => {
        const lo=a<b?a:b, hi=a<b?b:a;
        const key = lo * 16777216 + hi;
        let arr = edgeMap.get(key);
        if (!arr) { arr=[]; edgeMap.set(key, arr); }
        arr.push(f);
      };
      for (let f=0; f<nF; f++) {
        const a=F[f*3], b=F[f*3+1], c=F[f*3+2];
        pushE(a,b,f); pushE(b,c,f); pushE(c,a,f);
      }
      const nbrCnt = new Int32Array(nF);
      edgeMap.forEach(arr => {
        if (arr.length === 2) { nbrCnt[arr[0]]++; nbrCnt[arr[1]]++; }
      });
      const nbrOff = new Int32Array(nF + 1);
      for (let i=0; i<nF; i++) nbrOff[i+1] = nbrOff[i] + nbrCnt[i];
      const nbrIdx = new Int32Array(nbrOff[nF]);
      const cur = new Int32Array(nF);
      edgeMap.forEach(arr => {
        if (arr.length === 2) {
          const a=arr[0], b=arr[1];
          nbrIdx[nbrOff[a] + cur[a]++] = b;
          nbrIdx[nbrOff[b] + cur[b]++] = a;
        }
      });

      // Маска «рёбер-гребней»: 1, если угол между нормалями этой пары
      // граней превышает порог (по умолчанию 25°). Ползунок `applyShifts`
      // НЕ захватывает грани через такие рёбра — граница упирается в
      // анатомический излом. На гладких мешах (как в наших данных, где
      // у большинства пограничных рёбер угол 3-11°) эта маска почти
      // везде 0, и ползунок работает обычно. На мешах с выраженными
      // гребнями — anchor к ним.
      const creaseDeg = 25.0;
      const cosThr = Math.cos(creaseDeg * Math.PI / 180);
      const nbrBlock = new Uint8Array(nbrIdx.length);
      for (let f=0; f<nF; f++) {
        // нормали грани в non-indexed геометрии лежат по 3 подряд в каждой
        // из 3 вершин, т.е. все одинаковы — берём первую (offset f*9)
        const nxF = normals[f*9], nyF = normals[f*9+1], nzF = normals[f*9+2];
        const o0 = nbrOff[f], o1 = nbrOff[f+1];
        for (let k = o0; k < o1; k++) {
          const g = nbrIdx[k];
          const dot = nxF*normals[g*9] + nyF*normals[g*9+1] + nzF*normals[g*9+2];
          if (dot < cosThr) nbrBlock[k] = 1;
        }
      }

      return { positions, normals, colors, fc, nbrOff, nbrIdx, nbrBlock, nF,
               areas, totalArea,
               // Резерв оригинальных positions: ножницы коллапсируют
               // треугольники в degenerate; для отката (Восстановить)
               // нам нужен исходник. Делается ОДИН раз, занимает столько
               // же, сколько positions. Для типичного меша 30k граней —
               // ~1 МБ, незаметно.
               origPositions: new Float32Array(positions),
             };
    }

    function refreshColors(s) {
      const c = s.fd.colors;
      const labels = s.labels;
      const za = [0, 0, 0];
      for (let f=0; f<s.fd.nF; f++) {
        const lbl = labels[f];
        const o = f * 9;
        if (lbl > LAT) {
          // DEL — невидимый цвет (на всякий случай: positions у этой
          // грани уже коллапсированы в setDeletedFlags, рендерить
          // нечего, но чтобы не было «мусорного» цвета — обнуляем).
          for (let k=0; k<9; k++) c[o+k] = 0;
          continue;
        }
        const col = COLOR_OBJ[lbl];
        for (let k=0; k<3; k++) {
          c[o+k*3  ] = col.r;
          c[o+k*3+1] = col.g;
          c[o+k*3+2] = col.b;
        }
        za[lbl] += s.fd.areas[f];
      }
      s.zoneAreas = za;
      s.geom.attributes.color.needsUpdate = true;
      updateStats(s);
    }

    function emitChange(s) {
      // После любой ручной правки — переписать window.M и диспатчить событие.
      window.M.zoneLabels = s.labels;
      const za = s.zoneAreas;
      window.M.zoneMeta = Object.assign({}, window.M.zoneMeta || {}, {
        areas: [za[SEP], za[FLR], za[LAT]],
        totalArea: s.fd.totalArea,
      });
      // Пересобрать геометрию зон под новые метки. Вызывается только
      // на `change` (отпускание ползунка или reset), не на каждый кадр
      // протаскивания — тяжёлое не делаем впустую.
      const exp = buildZoneExports(s.labels, window.M.V, window.M.F);
      window.M.zoneFaces      = exp.zoneFaces;
      window.M.zoneMeshes     = exp.zoneMeshes;
      window.M.zoneBoundaries = exp.zoneBoundaries;

      // Snapshot для restore'а после server-build (см. _saveTab3Snapshot).
      _saveTab3Snapshot();

      window.dispatchEvent(new CustomEvent('data:change', {
        detail: { kind: 'zones:edit', faces: s.fd.nF, areas: za },
      }));
    }

    // ─── Морфологический сдвиг границы ────────────────────────────────
    //
    // dilateLabel(labels, srcLabel, dstLabel, steps): за `steps` итераций
    // зона srcLabel «съедает» прилегающие грани зоны dstLabel. На каждой
    // итерации все dstLabel-грани, у которых есть хотя бы один
    // srcLabel-сосед по ребру, становятся srcLabel. Другие зоны
    // остаются неизменными — граница не перепрыгивает через третью зону.
    //
    // Если fd.nbrBlock[k] === 1 — это ребро-гребень (высокий диэдральный
    // угол), и дилатация через него НЕ происходит: граница упирается в
    // анатомический излом.
    //
    function dilateLabel(labels, fd, srcLabel, dstLabel, steps) {
      if (steps <= 0) return;
      const { nbrOff, nbrIdx, nbrBlock, nF } = fd;
      const flip = new Uint8Array(nF);
      const useBlock = !!nbrBlock;
      for (let s = 0; s < steps; s++) {
        flip.fill(0);
        let any = false;
        for (let f = 0; f < nF; f++) {
          if (labels[f] !== dstLabel) continue;
          const o0 = nbrOff[f], o1 = nbrOff[f + 1];
          for (let k = o0; k < o1; k++) {
            if (useBlock && nbrBlock[k]) continue;   // ребро-гребень — пропуск
            if (labels[nbrIdx[k]] === srcLabel) { flip[f] = 1; any = true; break; }
          }
        }
        if (!any) break;                  // нечего больше двигать
        for (let f = 0; f < nF; f++) if (flip[f]) labels[f] = srcLabel;
      }
    }

    // applyShifts(s): берёт s.baseLabels, применяет два сдвига, пишет в s.labels.
    //   sepShift < 0  — перегородка растёт в дно;  > 0  — дно растёт в перегородку.
    //   flrShift < 0  — дно растёт в латераль;     > 0  — латераль растёт в дно.
    // Детерминированно: результат зависит только от (baseLabels, sepShift, flrShift).
    function applyShifts(s) {
      const labels = new Uint8Array(s.baseLabels);
      if (s.sepShift < 0)      dilateLabel(labels, s.fd, SEP, FLR, -s.sepShift);
      else if (s.sepShift > 0) dilateLabel(labels, s.fd, FLR, SEP,  s.sepShift);
      if (s.flrShift < 0)      dilateLabel(labels, s.fd, FLR, LAT, -s.flrShift);
      else if (s.flrShift > 0) dilateLabel(labels, s.fd, LAT, FLR,  s.flrShift);
      s.labels = labels;
      refreshColors(s);
    }

    // ─── UI панелей ────────────────────────────────────────────────
    function installUI(s) {
      const stage = document.querySelector('.stage[data-stage="zones"]');
      if (!stage) return { dispose: () => {} };
      const left  = stage.querySelector('.panel.left');
      const right = stage.querySelector('.panel.right');
      if (!left || !right) return { dispose: () => {} };

      const origLeftHTML  = left.innerHTML;
      const origRightHTML = right.innerHTML;

      // ─── LEFT: два ползунка-границы + действия + next ─────────
      left.innerHTML = [
        '<div class="card">',
          '<div class="card-title">Площади</div>',
          '<div class="zn-stat-row">',
            '<span class="zn-swatch" style="background:#4a9eff"></span>',
            '<span class="zn-stat-k">Перегородка</span>',
            '<span class="zn-stat-v" data-zn-stat="sep">—</span>',
          '</div>',
          '<div class="zn-stat-row">',
            '<span class="zn-swatch" style="background:#ff9f3c"></span>',
            '<span class="zn-stat-k">Дно</span>',
            '<span class="zn-stat-v" data-zn-stat="flr">—</span>',
          '</div>',
          '<div class="zn-stat-row">',
            '<span class="zn-swatch" style="background:#5ce1a0"></span>',
            '<span class="zn-stat-k">Латераль</span>',
            '<span class="zn-stat-v" data-zn-stat="lat">—</span>',
          '</div>',
          '<div class="ep-divider"></div>',
          '<div class="stat-row">',
            '<span class="stat-k">всего</span>',
            '<span class="stat-v" data-zn-stat="total">—</span>',
          '</div>',
        '</div>',

        '<div class="card">',
          '<div class="card-title">Границы зон</div>',

          '<div class="zn-slider-block">',
            '<div class="zn-slider-head">',
              '<span class="zn-swatch" style="background:#4a9eff"></span>',
              '<span class="zn-slider-lab">Перегородка</span>',
              '<span class="zn-slider-arrow">↔</span>',
              '<span class="zn-slider-lab">Дно</span>',
              '<span class="zn-swatch" style="background:#ff9f3c"></span>',
              '<button type="button" class="zn-pencil" data-zone-line="sep-flr" ',
                      'title="Провести границу мышкой">',
                '<svg width="13" height="13" viewBox="0 0 16 16" fill="none">',
                  '<path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5z" stroke="currentColor" ',
                        'stroke-width="1.4" stroke-linejoin="round"/></svg>',
              '</button>',
            '</div>',
            '<div class="zn-slider-row">',
              '<input type="range" min="-30" max="30" value="0" step="1" data-slider="sep-flr">',
              '<span class="ep-val" data-val="sep-flr">0</span>',
            '</div>',
          '</div>',

          '<div class="zn-slider-block">',
            '<div class="zn-slider-head">',
              '<span class="zn-swatch" style="background:#ff9f3c"></span>',
              '<span class="zn-slider-lab">Дно</span>',
              '<span class="zn-slider-arrow">↔</span>',
              '<span class="zn-slider-lab">Латераль</span>',
              '<span class="zn-swatch" style="background:#5ce1a0"></span>',
              '<button type="button" class="zn-pencil" data-zone-line="flr-lat" ',
                      'title="Провести границу мышкой">',
                '<svg width="13" height="13" viewBox="0 0 16 16" fill="none">',
                  '<path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5z" stroke="currentColor" ',
                        'stroke-width="1.4" stroke-linejoin="round"/></svg>',
              '</button>',
            '</div>',
            '<div class="zn-slider-row">',
              '<input type="range" min="-30" max="30" value="0" step="1" data-slider="flr-lat">',
              '<span class="ep-val" data-val="flr-lat">0</span>',
            '</div>',
          '</div>',
        '</div>',

        '<div class="card">',
          '<div class="card-title">Действия</div>',
          '<button type="button" class="ep-act zn-reset-btn" data-act="reset">',
              '<svg class="ep-act-ico" width="14" height="14" viewBox="0 0 18 18" fill="none">',
                '<path d="M3 8h7a4 4 0 010 8H7" stroke="currentColor" stroke-width="1.4" ',
                       'stroke-linecap="round" stroke-linejoin="round"/>',
                '<path d="M5.5 5L3 8l2.5 3" stroke="currentColor" stroke-width="1.4" ',
                       'stroke-linecap="round" stroke-linejoin="round"/>',
              '</svg>',
            'Сбросить границы',
          '</button>',

          '<div class="zn-act-sep"></div>',

          '<div class="ep-actions">',
            '<button type="button" class="ep-act ep-act-danger" data-act="scissors" ',
                    'title="Обвести лассо область → отрезать всё, что внутри.">',
              /* Иконка ножниц */
              '<svg class="ep-act-ico" width="14" height="14" viewBox="0 0 18 18" fill="none">',
                '<circle cx="4.2" cy="4.2" r="2" stroke="currentColor" stroke-width="1.4"/>',
                '<circle cx="4.2" cy="13.8" r="2" stroke="currentColor" stroke-width="1.4"/>',
                '<path d="M5.7 5.7L15 13M5.7 12.3L15 5" stroke="currentColor" ',
                       'stroke-width="1.4" stroke-linecap="round"/>',
              '</svg>',
              'Отрезать',
            '</button>',
            '<button type="button" class="ep-act ep-act-sm" data-act="scissors-restore" ',
                    'title="Вернуть все отрезанные грани">',
            '<svg class="ep-act-ico" width="14" height="14" viewBox="0 0 18 18" fill="none">',
              '<path d="M14.5 9a5.5 5.5 0 11-1.7-3.95M14.5 3v3.5h-3.5" ',
                    'stroke="currentColor" stroke-width="1.4" ',
                    'stroke-linecap="round" stroke-linejoin="round"/>',
            '</svg>',
              'Вернуть',
            '</button>',
          '</div>',
          '<div class="hint-text dim" style="margin-top:9px;font-size:11px;',
                 'line-height:1.45;opacity:.65">',
            'Обведите лассо часть меша — эти грани не уйдут на развёртку.',
          '</div>',
        '</div>',

      ].join('');

      // ─── RIGHT: статистика зон + легенда + управление ──────────
      right.innerHTML = [
        '<details class="card" id="zonesGuideCard" open>',
          '<summary class="card-title">Инструкция</summary>',
          '<ol class="ep-steps">',
            '<li>Алгоритм разметил слизистую по трём зонам. Поверните меш ',
                 '<b>ПКМ</b>, чтобы осмотреть границы.</li>',
            '<li>Если граница проходит не там — двигайте ползунки. ',
                 '<b>Сбросить границы</b> вернёт разметку алгоритма.</li>',
            '<li><b>Отрезать</b> — обведите лассо ненужную часть меша: ',
                 'эти грани не уйдут на развёртку.</li>',
            '<li><b>Продолжить</b> — построить интерактивную развёртку.</li>',
          '</ol>',
        '</details>',

        /* Кнопка «Экспорт (.obj + .json)» убрана: меш и зоны входят в
           архив сессии, отдельная выгрузка его дублировала. */

        '<div style="margin-top:11px">',
          '<button type="button" class="btn-open-big btn-next-stage">',
            '<span>Продолжить</span>',
            '<svg width="15" height="15" viewBox="0 0 18 18" fill="none">',
              '<path d="M5 3l7 6-7 6" stroke="currentColor" stroke-width="1.8" ',
                    'stroke-linecap="round" stroke-linejoin="round"/></svg>',
          '</button>',
          '<div class="hint-text dim" style="margin-top:8px;font-size:11px;',
                 'line-height:1.45;opacity:.6;text-align:center">',
            'Построить интерактивную развёртку',
          '</div>',
        '</div>',
      ].join('');

      s.uiLeft  = left;
      s.uiRight = right;

      // ─── Два ползунка ────────────────────────────────────────────────
      // Используем requestAnimationFrame-трoтлинг: при быстром протаскивании
      // пересчёт происходит один раз на кадр, UI остаётся отзывчивым.
      let raf = 0;
      let dirty = false;
      const scheduleApply = () => {
        dirty = true;
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (!dirty) return;
          dirty = false;
          applyShifts(s);
        });
      };
      const wireSlider = (kind, onVal) => {
        const el = left.querySelector('[data-slider="' + kind + '"]');
        const lab = left.querySelector('[data-val="' + kind + '"]');
        if (!el) return null;
        const updateFill = () => {
          const min = +el.min, max = +el.max;
          const pct = ((+el.value - min) / (max - min)) * 100;
          el.style.setProperty('--ep-pct', pct + '%');
        };
        const updateLab = () => {
          const v = +el.value;
          lab.textContent = v > 0 ? '+' + v : ('' + v);
        };
        updateFill(); updateLab();
        el.addEventListener('input', (e) => {
          onVal(+e.target.value);
          updateFill(); updateLab();
          scheduleApply();
        });
        el.addEventListener('change', () => emitChange(s));
        return el;
      };
      const sepSlider = wireSlider('sep-flr', v => s.sepShift = v);
      const flrSlider = wireSlider('flr-lat', v => s.flrShift = v);

      // ─── Действия ───────────────────────────────────────────────────
      const bindAct = (name, fn) => {
        // экспорт живёт в правой панели, остальные действия — в левой
        const el = left.querySelector('[data-act="' + name + '"]')
                || right.querySelector('[data-act="' + name + '"]');
        if (el) el.addEventListener('click', fn);
      };
      bindAct('reset', () => {
        s.sepShift = 0; s.flrShift = 0;
        if (sepSlider) { sepSlider.value = 0; sepSlider.dispatchEvent(new Event('input')); }
        if (flrSlider) { flrSlider.value = 0; flrSlider.dispatchEvent(new Event('input')); }
        // input handler сам вызовет applyShifts и обновит лейблы
        emitChange(s);
      });
      // Ножницы: тогл-режим. Пока активны — ЛКМ рисует лассо (не вращает),
      // ПКМ остаётся за орбитой. Опции (внутри/снаружи, только видимые)
      // читаются из радио/чекбокса в момент завершения лассо.
      bindAct('scissors', (ev) => {
        const btn = ev.currentTarget;
        if (s.scissorsActive) Scissors.disable(s, btn);
        else                  Scissors.enable(s, btn);
      });
      // Карандаши: по одному на каждую границу
      left.querySelectorAll('[data-zone-line]').forEach(btn => {
        btn.addEventListener('click', () => {
          const on = btn.classList.contains('zn-act-on');
          ZoneLine.disable(s);
          if (on) return;                       // повторный клик — выключить
          if (s.scissorsActive) Scissors.disable(s);   // инструменты не совмещаем
          const pair = btn.dataset.zoneLine === 'sep-flr' ? [SEP, FLR] : [FLR, LAT];
          ZoneLine.enable(s, btn, pair[0], pair[1]);
        });
      });

      bindAct('scissors-restore', () => {
        Scissors.restoreAll(s);
        emitChange(s);                 // tab4 получит «полный» меш обратно
      });

      bindAct('export', () => exportZonedOBJ(s));

      // nextBtn click: переход на этап 4 с корректным управлением tab4-кэшем.
      //
      // Цели:
      //   (a) Если на tab3 БЫЛИ правки (ножницы или сдвиг ползунков) — tab4 cache
      //       должен быть инвалидирован, и развёртка пересобирается на новых
      //       данных.
      //   (b) Если на tab3 НИЧЕГО не правили (пользователь зашёл посмотреть
      //       и идёт обратно) — tab4 cache НЕ трогаем, на tab4 моментально
      //       появляется уже построенная развёртка без пересборки.
      //
      // Логика:
      //   1. Считаем «грязное» состояние:
      //        - cut > 0   — ножницы что-то отрезали
      //        - sepShift != 0 || flrShift != 0 — двигали ползунки
      //   2. Если dirty:
      //        - cut > 0 → compactMeshFromDeletions сам диспатчит zones:edit
      //          (tab4 → disposeCache)
      //        - иначе → emitChange (тоже диспатчит zones:edit)
      //   3. switchTo('unfold').
      //   4. Перестройкой развёртки, если кэш был сброшен, занимается сам
      //      этап 05 при открытии (Tab4.onActivate). Отсюда её не зовём и
      //      состояние этапа 05 не выясняем: наше дело — зафиксировать
      //      правки и передать управление.

      const nextBtn = right.querySelector('.btn-next-stage');
      if (nextBtn) nextBtn.addEventListener('click', () => {
        const cut = compactMeshFromDeletions(s);   // 0 если резов не было
        const slidersTouched = (s.sepShift !== 0 || s.flrShift !== 0);

        if (cut === 0 && slidersTouched) {
          // Только ползунки — фиксируем labels. compact уже эмитит сам.
          emitChange(s);
        }


        unlockUnfoldTab();
        if (window.Tabs && typeof window.Tabs.switchTo === 'function') {
          window.Tabs.switchTo('unfold');

        } else {
          _toast('Таб «Развёртка» разблокирован', 'info', 4000);
        }
      });

      updateStats(s);

      return {
        dispose: () => {
          left.innerHTML  = origLeftHTML;
          right.innerHTML = origRightHTML;
        },
      };
    }

    function updateStats(s) {
      if (!s.uiRight) return;
      const za = s.zoneAreas || [0, 0, 0];
      const total = s.fd.totalArea;
      const ru0 = n => n.toLocaleString('ru', { maximumFractionDigits: 0 });
      const fmt = (a) => {
        const pct = (100 * a / Math.max(total, 1e-9)).toFixed(1);
        return ru0(a) + ' мм² · ' + pct + ' %';
      };
      const setTxt = (sel_, txt) => {
        // «Площади» живут в левой панели, остальная статистика — в правой
        const el = (s.uiLeft && s.uiLeft.querySelector(sel_))
                || (s.uiRight && s.uiRight.querySelector(sel_));
        if (el) el.textContent = txt;
      };
      setTxt('[data-zn-stat="sep"]', fmt(za[SEP]));
      setTxt('[data-zn-stat="flr"]', fmt(za[FLR]));
      setTxt('[data-zn-stat="lat"]', fmt(za[LAT]));
      setTxt('[data-zn-stat="total"]', ru0(total) + ' мм²');
    }


    // Инструмент «Ножницы» как в 3D Slicer Segment Editor:



    /* ═══ КАРАНДАШ: правка границы зон линией ══════════════════════
       Ползунок двигает границу равномерно по всей длине — этого мало,
       когда алгоритм ошибся на одном участке. Карандаш даёт провести
       границу вручную именно там, где нужно.

       Как работает. Врач ведёт линию мышкой по мешу. Центроиды граней
       проецируются на экран (тем же приёмом, что в Scissors), и для
       каждой грани ДВУХ смежных зон определяется, с какой стороны
       линии она лежит — по знаку векторного произведения относительно
       БЛИЖАЙШЕГО сегмента ломаной. Линия конечна, поэтому для точек за
       её концами берётся крайний сегмент, продлённый мысленно в обе
       стороны: так вся длина меша делится однозначно.

       Какая сторона какой зоне достаётся, врачу указывать не нужно:
       считаем, каких граней на каждой стороне сейчас больше, и
       назначаем по большинству. Провёл линию — граница легла по ней,
       с какой стороны ни рисуй.

       Трогаются ТОЛЬКО две выбранные зоны. Третья не меняется, даже
       если линия прошла по ней: иначе одна правка ломала бы всё сразу.

       Результат пишется и в labels, и в baseLabels — иначе следующее
       движение ползунка стёрло бы ручную правку, ведь applyShifts()
       всегда пересчитывает от базы.                                  */
    const ZoneLine = (function () {

      function getCanvas(s) {
        return (s.viewer && s.viewer.canvas) ||
               document.querySelector('.stage[data-stage="zones"] canvas');
      }
      function getCamera(s) {
        return (s.viewer && s.viewer.camera) || null;
      }
      function pxFromEvent(canvas, ev) {
        const r = canvas.getBoundingClientRect();
        return [ev.clientX - r.left, ev.clientY - r.top];
      }

      function buildOverlay(canvas) {
        const parent = canvas.parentElement || document.body;
        if (getComputedStyle(parent).position === 'static') {
          parent.style.position = 'relative';
        }
        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('style',
          'position:absolute;inset:0;pointer-events:none;z-index:6');
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', '#ff9f3c');
        path.setAttribute('stroke-width', '2.5');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        svg.appendChild(path);
        parent.appendChild(svg);
        return { svg, path };
      }

      /* Сторона точки относительно ломаной: знак z-компоненты
         векторного произведения (сегмент × вектор к точке) у ближайшего
         сегмента. */
      function sideOf(px, py, poly) {
        let best = Infinity, sign = 1;
        for (let i = 0; i + 3 < poly.length; i += 2) {
          const ax = poly[i], ay = poly[i+1];
          const bx = poly[i+2], by = poly[i+3];
          const dx = bx - ax, dy = by - ay;
          const len2 = dx*dx + dy*dy;
          if (len2 < 1e-9) continue;
          let tt = ((px - ax) * dx + (py - ay) * dy) / len2;
          // Крайние сегменты продлеваем: точка за концом линии всё равно
          // получает сторону, иначе половина меша осталась бы без ответа.
          if (i === 0)                 tt = Math.min(1, tt);
          else if (i + 4 >= poly.length) tt = Math.max(0, tt);
          else                         tt = Math.max(0, Math.min(1, tt));
          const qx = ax + dx * tt, qy = ay + dy * tt;
          const d2 = (px - qx) * (px - qx) + (py - qy) * (py - qy);
          if (d2 < best) {
            best = d2;
            sign = (dx * (py - ay) - dy * (px - ax)) >= 0 ? 1 : -1;
          }
        }
        return sign;
      }

      function applyLine(s, poly, zoneA, zoneB) {
        const canvas = getCanvas(s), camera = getCamera(s);
        if (!canvas || !camera || poly.length < 4) return 0;
        const W = canvas.clientWidth  || canvas.width;
        const H = canvas.clientHeight || canvas.height;
        const { fc, nF } = s.fd;
        const labels = s.labels, del = s.deletedFaces;
        const v = new THREE.Vector3();

        // 1. Сторона каждой грани двух зон + чего на стороне больше
        const side = new Int8Array(nF);
        const cnt = { '1': [0, 0], '-1': [0, 0] };   // [зонаA, зонаB]
        for (let f = 0; f < nF; f++) {
          if (del && del[f]) continue;
          const lb = labels[f];
          if (lb !== zoneA && lb !== zoneB) continue;
          v.set(fc[f*3], fc[f*3+1], fc[f*3+2]).project(camera);
          if (v.z < -1 || v.z > 1) continue;
          const px = (v.x * 0.5 + 0.5) * W;
          const py = (-v.y * 0.5 + 0.5) * H;
          const sg = sideOf(px, py, poly);
          side[f] = sg;
          cnt[String(sg)][lb === zoneA ? 0 : 1]++;
        }

        // 2. Ориентация по большинству — врачу не нужно думать,
        //    с какой стороны вести линию.
        const plusIsA = (cnt['1'][0] - cnt['1'][1]) >= (cnt['-1'][0] - cnt['-1'][1]);
        let moved = 0;
        for (let f = 0; f < nF; f++) {
          if (!side[f]) continue;
          const want = (side[f] === 1) === plusIsA ? zoneA : zoneB;
          if (labels[f] !== want) { labels[f] = want; moved++; }
        }
        // 3. Правка становится новой базой — иначе ползунок её сотрёт
        if (moved) s.baseLabels = new Uint8Array(labels);
        return moved;
      }

      function enable(s, btnEl, zoneA, zoneB) {
        const canvas = getCanvas(s);
        if (!canvas) return;
        disable(s);                       // один карандаш за раз
        s.zoneLineActive = true;
        if (btnEl) btnEl.classList.add('zn-act-on');

        const overlay = buildOverlay(canvas);
        const pts = [];
        let dragging = false, lastX = 0, lastY = 0;
        const MIN_STEP = 3;
        const prevCursor = canvas.style.cursor;
        canvas.style.cursor = 'crosshair';

        const toPath = (a) => {
          if (a.length < 4) return '';
          let d = 'M ' + a[0].toFixed(1) + ' ' + a[1].toFixed(1);
          for (let i = 2; i < a.length; i += 2) {
            d += ' L ' + a[i].toFixed(1) + ' ' + a[i+1].toFixed(1);
          }
          return d;
        };

        const onDown = (ev) => {
          if (ev.button !== 0) return;
          dragging = true;
          pts.length = 0;
          const [x, y] = pxFromEvent(canvas, ev);
          pts.push(x, y); lastX = x; lastY = y;
          ev.preventDefault(); ev.stopPropagation();
        };
        const onMove = (ev) => {
          if (!dragging) return;
          const [x, y] = pxFromEvent(canvas, ev);
          if (Math.hypot(x - lastX, y - lastY) < MIN_STEP) return;
          pts.push(x, y); lastX = x; lastY = y;
          overlay.path.setAttribute('d', toPath(pts));
          ev.preventDefault(); ev.stopPropagation();
        };
        const onUp = (ev) => {
          if (!dragging) return;
          dragging = false;
          ev.preventDefault(); ev.stopPropagation();
          if (pts.length < 6) { overlay.path.setAttribute('d', ''); return; }
          const moved = applyLine(s, pts.slice(), zoneA, zoneB);
          overlay.path.setAttribute('d', '');
          if (moved) {
            refreshColors(s);
            emitChange(s);
            console.log('[zones] граница проведена: ' + moved + ' граней');
          }
        };

        canvas.addEventListener('mousedown', onDown, true);
        window.addEventListener('mousemove', onMove, true);
        window.addEventListener('mouseup',   onUp,   true);

        s.zoneLineCtx = {
          btn: btnEl,
          detach() {
            canvas.removeEventListener('mousedown', onDown, true);
            window.removeEventListener('mousemove', onMove, true);
            window.removeEventListener('mouseup',   onUp,   true);
            try { overlay.svg.remove(); } catch (_) {}
            canvas.style.cursor = prevCursor || '';
          },
        };
      }

      function disable(s) {
        if (!s.zoneLineActive) return;
        s.zoneLineActive = false;
        if (s.zoneLineCtx) {
          try { s.zoneLineCtx.detach(); } catch (_) {}
          if (s.zoneLineCtx.btn) s.zoneLineCtx.btn.classList.remove('zn-act-on');
          s.zoneLineCtx = null;
        }
        const stage = document.querySelector('.stage[data-stage="zones"]');
        if (stage) {
          stage.querySelectorAll('[data-zone-line]')
               .forEach(b => b.classList.remove('zn-act-on'));
        }
      }

      return { enable, disable };
    })();

    const Scissors = (function () {

      function getCanvas(s) {
        return (s.viewer && s.viewer.canvas) ||
               document.getElementById('gl3d-zones');
      }

      function getCamera(s) {
        // Ищем активную камеру в сцене viewer'а.
        if (s.viewer && s.viewer.camera) return s.viewer.camera;
        if (s.viewer && s.viewer.scene) {
          let cam = null;
          s.viewer.scene.traverse(o => { if (o.isCamera && !cam) cam = o; });
          return cam;
        }
        return null;
      }

      // Создаём SVG-оверлей строго над canvas — точно совпадает по размеру
      // и position. Если у canvas есть offsetParent — крепим туда; иначе
      // body. pointer-events:none, чтобы клики уходили в canvas.
      function buildOverlay(canvas) {
        const parent = canvas.parentElement || document.body;
        const cs = getComputedStyle(parent);
        if (cs.position === 'static') {
          // Не трогаем — у viewport стиль .viewport должен быть relative;
          // если по какой-то причине нет, добавляем чтоб SVG позиционировался.
          parent.style.position = 'relative';
        }
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        svg.style.cssText = [
          'position:absolute',
          'left:0', 'top:0',
          'width:100%', 'height:100%',
          'pointer-events:none',
          'z-index:5',
        ].join(';');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('fill', 'rgba(0,240,255,0.10)');
        path.setAttribute('stroke', '#00f0ff');
        path.setAttribute('stroke-width', '1.5');
        path.setAttribute('stroke-dasharray', '5 3');
        path.setAttribute('stroke-linejoin', 'round');
        path.setAttribute('vector-effect', 'non-scaling-stroke');
        svg.appendChild(path);
        parent.appendChild(svg);
        return { svg, path };
      }

      // Преобразуем pageX/Y -> локальные пиксели canvas. Учитываем
      // scroll и transform-цепочку через getBoundingClientRect.
      function pxFromEvent(canvas, ev) {
        const r = canvas.getBoundingClientRect();
        return [ev.clientX - r.left, ev.clientY - r.top];
      }

      // Point-in-polygon (ray-casting)
      function pip(px, py, poly) {
        let inside = false;
        const n = poly.length >> 1;
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const xi = poly[i*2],     yi = poly[i*2 + 1];
          const xj = poly[j*2],     yj = poly[j*2 + 1];
          if (((yi > py) !== (yj > py)) &&
              (px < (xj - xi) * (py - yi) / ((yj - yi) || 1e-12) + xi)) {
            inside = !inside;
          }
        }
        return inside;
      }

      // Bounding box лассо
      function polyBBox(poly) {
        let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
        for (let i = 0; i < poly.length; i += 2) {
          const x = poly[i], y = poly[i+1];
          if (x < xmin) xmin = x; if (x > xmax) xmax = x;
          if (y < ymin) ymin = y; if (y > ymax) ymax = y;
        }
        return [xmin, ymin, xmax, ymax];
      }

      // Главный шаг резки. Проецируем все центроиды ОДИН раз через
      // camera.project(); это самое дорогое (O(nF)), но сравнимо с
      // одним кадром рендера. На 100k фейсов — ~10 мс.
      function applyCut(s, polyPx, opts) {
        const { mode, visibleOnly } = opts;
        const canvas = getCanvas(s);
        const camera = getCamera(s);
        if (!canvas || !camera) {
          console.warn('[scissors] no camera/canvas, skipping');
          return 0;
        }
        const W = canvas.clientWidth  || canvas.width;
        const H = canvas.clientHeight || canvas.height;
        const fc      = s.fd.fc;
        const labels  = s.labels;
        const base    = s.baseLabels;
        const del     = s.deletedFaces;
        const nF      = s.fd.nF;

        // Bbox лассо — отсекаем 90+% граней без point-in-polygon.
        const [bx0, by0, bx1, by1] = polyBBox(polyPx);

        // Camera direction (для visibleOnly). В world-space.
        const camDir = new THREE.Vector3();
        camera.getWorldDirection(camDir);
        const normals = s.fd.normals;

        const v = new THREE.Vector3();
        let cut = 0;
        for (let f = 0; f < nF; f++) {
          if (del[f]) continue;       // уже отрезана
          v.set(fc[f*3], fc[f*3+1], fc[f*3+2]).project(camera);
          // proj вне [-1,1] по любому из x/y => вне фрустума, считаем «снаружи»
          if (v.z < -1 || v.z > 1) {
            // За-камерой / за-far — для inside-mode пропускаем,
            // для outside-mode тоже не режем (нет смысла резать невидимое).
            continue;
          }
          const px = (v.x * 0.5 + 0.5) * W;
          const py = (-v.y * 0.5 + 0.5) * H;

          // Быстрый bbox-пред-чек (только для inside; для outside — bbox не помогает).
          let inside;
          if (px < bx0 || px > bx1 || py < by0 || py > by1) {
            inside = false;
          } else {
            inside = pip(px, py, polyPx);
          }
          const cutThis = (mode === 'outside') ? !inside : inside;
          if (!cutThis) continue;

          if (visibleOnly) {
            // n·viewDir < 0 => грань смотрит на камеру
            // Нормаль грани одинакова в 3 vertex-копиях, берём первую.
            const o = f * 9;
            const dot = normals[o]   * camDir.x +
                        normals[o+1] * camDir.y +
                        normals[o+2] * camDir.z;
            if (dot >= 0) continue;
          }

          // Помечаем как отрезанную. Меняем И labels, И baseLabels,
          // чтобы reset ползунков НЕ возродил отрезанное.
          del[f]    = 1;
          labels[f] = DEL;
          base[f]   = DEL;
          // Коллапсируем positions в первую вершину фейса — degenerate
          // треугольник не растеризуется (площадь 0). Visualisation
          // мгновенно скрывается.
          const o = f * 9;
          const ax = s.fd.positions[o];
          const ay = s.fd.positions[o+1];
          const az = s.fd.positions[o+2];
          s.fd.positions[o+3] = ax; s.fd.positions[o+4] = ay; s.fd.positions[o+5] = az;
          s.fd.positions[o+6] = ax; s.fd.positions[o+7] = ay; s.fd.positions[o+8] = az;
          cut++;
        }
        if (cut > 0) {
          s.geom.attributes.position.needsUpdate = true;
          s.geom.computeBoundingSphere();
          refreshColors(s);
        }
        return cut;
      }

      function restoreAll(s) {
        const del = s.deletedFaces;
        const orig = s.fd.origPositions;
        const pos  = s.fd.positions;
        let restored = 0;
        for (let f = 0; f < s.fd.nF; f++) {
          if (!del[f]) continue;
          del[f] = 0;
          // Восстанавливаем positions из бэкапа
          const o = f * 9;
          for (let k = 0; k < 9; k++) pos[o+k] = orig[o+k];
          // Возвращаем метку — берём её из original SaddleSeg-разметки.
          // Но baseLabels уже перезаписана DEL'ами. Восстановить
          // «по уму» — пересчитать SaddleSeg, что дорого. Проще
          // запомнить исходную метку на момент install и хранить её.
          const lbl = s.algLabels ? s.algLabels[f] : SEP;
          s.baseLabels[f] = lbl;
          s.labels[f]     = lbl;
          restored++;
        }
        if (restored > 0) {
          s.geom.attributes.position.needsUpdate = true;
          s.geom.computeBoundingSphere();
          // После restore ползунки могут давать новые границы —
          // переприменяем сдвиги, чтобы labels пришли в актуальное.
          applyShifts(s);
        }
        return restored;
      }

      function enable(s, btnEl) {
        if (s.scissorsActive) return;
        const canvas = getCanvas(s);
        if (!canvas) return;
        s.scissorsActive = true;
        if (btnEl) btnEl.classList.add('zn-act-on');

        const overlay = buildOverlay(canvas);
        const points = [];                 // [x,y,x,y,...] в px canvas
        let dragging = false;
        const minStep = 3;                 // px между точками лассо
        let lastX = 0, lastY = 0;

        // Сохраняем прежний cursor для отката
        const prevCursor = canvas.style.cursor;
        canvas.style.cursor = 'crosshair';

        const polyToPath = (pts, closed) => {
          if (pts.length < 2) return '';
          let d = 'M ' + pts[0].toFixed(1) + ' ' + pts[1].toFixed(1);
          for (let i = 2; i < pts.length; i += 2) {
            d += ' L ' + pts[i].toFixed(1) + ' ' + pts[i+1].toFixed(1);
          }
          if (closed) d += ' Z';
          return d;
        };

        const onDown = (ev) => {
          if (ev.button !== 0) return;     // только ЛКМ
          dragging = true;
          points.length = 0;
          const [x, y] = pxFromEvent(canvas, ev);
          points.push(x, y);
          lastX = x; lastY = y;
          overlay.path.setAttribute('d', polyToPath(points, false));
          // Глушим orbit-control'у viewer'а его ЛКМ-обработку.
          ev.preventDefault();
          ev.stopPropagation();
        };

        const onMove = (ev) => {
          if (!dragging) return;
          const [x, y] = pxFromEvent(canvas, ev);
          // Прореживание — иначе на быстром motion мы получим тысячи точек
          if (Math.hypot(x - lastX, y - lastY) < minStep) return;
          points.push(x, y);
          lastX = x; lastY = y;
          overlay.path.setAttribute('d', polyToPath(points, false));
          ev.preventDefault();
          ev.stopPropagation();
        };

        const onUp = (ev) => {
          if (!dragging) return;
          dragging = false;
          ev.preventDefault();
          ev.stopPropagation();

          // Минимум 3 точки + замкнутый контур
          if (points.length < 6) {
            overlay.path.setAttribute('d', '');
            return;
          }
          // Замыкаем визуально
          overlay.path.setAttribute('d', polyToPath(points, true));

          // Параметры реза — фиксированы (UI с радио/чекбоксом убран):
          //   mode='inside'        — режем всё, что обведено
          //   visibleOnly=false    — не фильтруем по нормали;
          const polyArr = new Float32Array(points);
          const cut = applyCut(s, polyArr, { mode: 'inside', visibleOnly: false });

          // Гасим лассо — ножницы остаются включёнными для следующего реза.
          setTimeout(() => {
            overlay.path.setAttribute('d', '');
          }, 250);

          if (cut > 0) {
            // Коммит на этап 4 — обрезанный меш уходит в zoneMeshes.
            emitChange(s);
            if (typeof toast === 'function') {
              toast('Отрезано ' + cut + ' гран' +
                    (cut % 10 === 1 && cut % 100 !== 11 ? 'ь' :
                     (cut % 10 >= 2 && cut % 10 <= 4 && (cut % 100 < 12 || cut % 100 > 14) ? 'и' : 'ей')) +
                    '.', 'ok', 2500);
            }
          }
        };

        // Слушаем на canvas с capture-true, чтобы перехватить РАНЬШЕ,
        // чем viewer'ская orbit-логика. Mouseup ловим на window — палец
        // мог уйти за пределы canvas.
        canvas.addEventListener('mousedown', onDown, true);
        window.addEventListener('mousemove', onMove, true);
        window.addEventListener('mouseup',   onUp,   true);

        s.scissorsCtx = {
          overlay, prevCursor,
          detach() {
            canvas.removeEventListener('mousedown', onDown, true);
            window.removeEventListener('mousemove', onMove, true);
            window.removeEventListener('mouseup',   onUp,   true);
            try { overlay.svg.remove(); } catch (_) {}
            canvas.style.cursor = prevCursor || '';
          },
        };
      }

      function disable(s, btnEl) {
        if (!s.scissorsActive) return;
        s.scissorsActive = false;
        if (s.scissorsCtx) {
          try { s.scissorsCtx.detach(); } catch (_) {}
          s.scissorsCtx = null;
        }
        if (btnEl) btnEl.classList.remove('zn-act-on');
        else {
          const stage = document.querySelector('.stage[data-stage="zones"]');
          const b = stage && stage.querySelector('[data-act="scissors"]');
          if (b) b.classList.remove('zn-act-on');
        }
      }

      return { enable, disable, restoreAll };
    })();


    function exportZonedOBJ(s) {
      const oldNF  = s.fd.nF;
      const oldV   = window.M && window.M.V;
      const oldF   = window.M && window.M.F;
      if (!oldV || !oldF) {
        _toast('Меш не загружен — нечего экспортировать', 'err', 3000);
        return;
      }
      const oldNV  = oldV.length / 3;
      const labels = s.labels;
      const areas  = s.fd.areas;

      let activeNF = 0;
      for (let f = 0; f < oldNF; f++) if (labels[f] <= LAT) activeNF++;
      if (activeNF === 0) {
        _toast('Нечего экспортировать — все грани отрезаны', 'err', 3000);
        return;
      }

      // Шаг 1: compact F (со старыми индексами вершин) + новые labels
      const tmpF      = new Uint32Array(activeNF * 3);
      const newLabels = new Uint8Array(activeNF);
      let ni = 0;
      for (let f = 0; f < oldNF; f++) {
        if (labels[f] > LAT) continue;
        tmpF[ni*3]     = oldF[f*3];
        tmpF[ni*3 + 1] = oldF[f*3 + 1];
        tmpF[ni*3 + 2] = oldF[f*3 + 2];
        newLabels[ni]  = labels[f];
        ni++;
      }

      // Шаг 2: переиндексировать вершины (выкинуть неиспользуемые)
      const oldToNew = new Int32Array(oldNV);
      oldToNew.fill(-1);
      let newNV = 0;
      for (let i = 0; i < tmpF.length; i++) {
        const oi = tmpF[i];
        if (oldToNew[oi] === -1) oldToNew[oi] = newNV++;
      }
      const newV = new Float32Array(newNV * 3);
      for (let oi = 0; oi < oldNV; oi++) {
        const ni2 = oldToNew[oi];
        if (ni2 === -1) continue;
        newV[ni2*3]     = oldV[oi*3];
        newV[ni2*3 + 1] = oldV[oi*3 + 1];
        newV[ni2*3 + 2] = oldV[oi*3 + 2];
      }
      const newF = new Uint32Array(activeNF * 3);
      for (let i = 0; i < tmpF.length; i++) newF[i] = oldToNew[tmpF[i]];

      // Шаг 3: построить OBJ-текст. Грани идут в том же порядке, что
      // и newLabels — это контракт между OBJ и JSON.
      const objLines = [
        '# nasal-planner — изменённый меш после правки зон (tab3)',
        '# vertices: ' + newNV + ', faces: ' + activeNF,
        '# faces order matches inner_zoned_segmentation.json (0-based)',
      ];
      for (let i = 0; i < newNV; i++) {
        objLines.push('v ' + newV[i*3].toFixed(6) + ' ' +
                            newV[i*3 + 1].toFixed(6) + ' ' +
                            newV[i*3 + 2].toFixed(6));
      }
      for (let i = 0; i < activeNF; i++) {
        // OBJ — индексы вершин 1-based
        objLines.push('f ' + (newF[i*3]     + 1) + ' ' +
                             (newF[i*3 + 1] + 1) + ' ' +
                             (newF[i*3 + 2] + 1));
      }
      const objText = objLines.join('\n');

      // Шаг 4: сводка площадей по зонам (под фактически экспортируемые грани)
      const za = [0, 0, 0];
      let total = 0;
      for (let f = 0; f < oldNF; f++) {
        if (labels[f] > LAT) continue;
        const a = areas[f] || 0;
        za[labels[f]] += a;
        total += a;
      }

      // Шаг 5: JSON-сегментация. Содержит:
      //   · labels — массив длины activeNF, значения 0/1/2 (порядок
      //     совпадает с порядком f-строк в OBJ);
      //   · areas  — площади зон в мм²;
      //   · edits  — sepShift / flrShift на момент экспорта, чтобы
      //     можно было воспроизвести правку.
      const segmentation = {
        schema: 'nasal-planner/zone-segmentation@1',
        description:
          'Сегментация на зоны для inner_zoned.obj. Поле labels[i] — ' +
          'метка i-й грани (порядок совпадает с порядком f-строк в OBJ).',
        nV: newNV,
        nF: activeNF,
        labelNames:   { 0: 'septum',      1: 'floor', 2: 'lateral'            },
        labelNamesRu: { 0: 'Перегородка', 1: 'Дно',   2: 'Латеральная стенка' },
        areas: {
          septum:  za[SEP],
          floor:   za[FLR],
          lateral: za[LAT],
          total:   total,
          unit:    'mm^2',
        },
        edits: {
          sepShift: s.sepShift | 0,
          flrShift: s.flrShift | 0,
        },
        labels: Array.from(newLabels),
      };
      const jsonText = JSON.stringify(segmentation, null, 2);

      const objBlob  = new Blob([objText],  { type: 'text/plain' });
      const jsonBlob = new Blob([jsonText], { type: 'application/json' });
      const objName  = 'inner_zoned.obj';
      const jsonName = 'inner_zoned_segmentation.json';

      const notifyOK = () => {
        _toast(
          '<strong>Экспорт</strong>: ' + activeNF.toLocaleString('ru') +
          ' граней → ' + objName + ' + ' + jsonName,
          'ok', 3500, { html: true }
        );
      };
      const notifyErr = (err) => {
        _toast(
          '<strong>Ошибка экспорта</strong>: ' +
          (err && err.message ? err.message : err),
          'err', 5000, { html: true }
        );
      };


      if (window.showSaveFilePicker) {
        (async () => {
          try {
            // OBJ
            const objHandle = await window.showSaveFilePicker({
              suggestedName: objName,
              types: [{
                description: 'Wavefront OBJ',
                accept: { 'text/plain': ['.obj'] },
              }],
            });
            const objW = await objHandle.createWritable();
            await objW.write(objBlob);
            await objW.close();


            const jsonHandle = await window.showSaveFilePicker({
              suggestedName: jsonName,
              types: [{
                description: 'JSON-сегментация на зоны',
                accept: { 'application/json': ['.json'] },
              }],
            });
            const jsonW = await jsonHandle.createWritable();
            await jsonW.write(jsonBlob);
            await jsonW.close();

            notifyOK();
          } catch (err) {
            if (err && err.name === 'AbortError') return;
            notifyErr(err);
          }
        })();
        return;
      }


      try {
        const trig = (blob, name) => {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = name;
          a.rel = 'noopener';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 1500);
        };
        trig(objBlob, objName);
        setTimeout(() => trig(jsonBlob, jsonName), 250);
        notifyOK();
      } catch (err) {
        notifyErr(err);
      }
    }

    // compactMeshFromDeletions(s) — финальный «коммит ножниц» в window.M.

    function compactMeshFromDeletions(s) {
      const del = s.deletedFaces;
      if (!del) return 0;
      const oldNF = s.fd.nF;
      let nDel = 0;
      for (let f = 0; f < oldNF; f++) if (del[f]) nDel++;
      if (nDel === 0) return 0;

      const oldV = window.M.V, oldF = window.M.F;
      const oldNV = oldV.length / 3;
      const oldLabels = s.labels;
      const oldAreas  = s.fd.areas;

      const newNF = oldNF - nDel;

      // Шаг 1: построить новый F (старые индексы вершин), новые labels, areas
      const tmpF = new Uint32Array(newNF * 3);
      const newLabels = new Uint8Array(newNF);
      const newAreas  = new Float32Array(newNF);
      let ni = 0;
      for (let f = 0; f < oldNF; f++) {
        if (del[f]) continue;
        tmpF[ni*3]   = oldF[f*3];
        tmpF[ni*3+1] = oldF[f*3+1];
        tmpF[ni*3+2] = oldF[f*3+2];
        newLabels[ni] = oldLabels[f];
        newAreas[ni]  = oldAreas[f];
        ni++;
      }

      // Шаг 2: переиндексировать вершины. -1 = не используется.
      const oldToNew = new Int32Array(oldNV);
      oldToNew.fill(-1);
      let newNV = 0;
      for (let i = 0; i < tmpF.length; i++) {
        const oi = tmpF[i];
        if (oldToNew[oi] === -1) oldToNew[oi] = newNV++;
      }

      // Шаг 3: новый V, новый F с переиндексированными вершинами.
      // Используем тот же тип, что был в M (обычно Float32Array — но может
      // быть Float64Array; копируем сохраняя точность исходника).
      const VCtor = oldV.constructor || Float32Array;
      const newV = new VCtor(newNV * 3);
      for (let oi = 0; oi < oldNV; oi++) {
        const ni2 = oldToNew[oi];
        if (ni2 === -1) continue;
        newV[ni2*3]   = oldV[oi*3];
        newV[ni2*3+1] = oldV[oi*3+1];
        newV[ni2*3+2] = oldV[oi*3+2];
      }
      const FCtor = oldF.constructor || Uint32Array;
      const newF = new FCtor(newNF * 3);
      for (let i = 0; i < tmpF.length; i++) newF[i] = oldToNew[tmpF[i]];

      // Шаг 4: коммит в window.M
      window.M.V  = newV;
      window.M.F  = newF;
      window.M.nV = newNV;
      window.M.nF = newNF;
      window.M.zoneLabels = newLabels;

      // Шаг 5: пересобрать zoneFaces / zoneMeshes / zoneBoundaries
      // (теперь labels не содержит DEL — фильтр в buildZoneExports
      // не сработает, что корректно).
      const exp = buildZoneExports(newLabels, newV, newF);
      window.M.zoneFaces      = exp.zoneFaces;
      window.M.zoneMeshes     = exp.zoneMeshes;
      window.M.zoneBoundaries = exp.zoneBoundaries;

      // Шаг 6: новая zoneMeta
      const za = [0, 0, 0]; let total = 0;
      for (let f = 0; f < newNF; f++) {
        const a = newAreas[f];
        za[newLabels[f]] += a;
        total += a;
      }
      window.M.zoneMeta = Object.assign({}, window.M.zoneMeta || {}, {
        areas: za, totalArea: total,
      });

      // Snapshot для restore'а после server-build.
      _saveTab3Snapshot();

      // Шаг 7: эмитим событие. tab4 сравнит cacheSourceV/F/zoneLabels по
      // identity, увидит !== и пересчитает.
      window.dispatchEvent(new CustomEvent('data:change', {
        detail: { kind: 'zones:edit', faces: newNF, areas: za, cut: nDel },
      }));

      return nDel;
    }

    function install(viewer, V, F, out) {
      // Грузим меш в viewer (bbox/orbit/target/near-far)
      viewer.loadMesh({
        rawV: V, rawF: F,
        rawNV: V.length / 3,
        rawNF: F.length / 3,
      });
      viewer.clear();

      const bb = viewer.getBBox && viewer.getBBox();
      if (bb) {
        const size = bb.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z, 1);
        if (viewer.setOrbitDistance) viewer.setOrbitDistance(maxDim * 1.35);
      }

      const fd = buildFaceData(V, F);
      // Базовая разметка от SaddleSeg. Храним её отдельно, чтобы ползунки
      // всегда стартовали от неё (детерминированная правка, без накопления).
      // algLabels — «золотой» backup для Scissors.restoreAll: baseLabels
      // мутирует при каждом резе (туда пишется DEL), а algLabels — нет.
      const algLabels  = new Uint8Array(out.labels);
      const baseLabels = new Uint8Array(algLabels);
      const labels     = new Uint8Array(baseLabels);

      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(fd.positions, 3));
      geom.setAttribute('normal',   new THREE.BufferAttribute(fd.normals, 3));
      geom.setAttribute('color',    new THREE.BufferAttribute(fd.colors, 3));
      geom.computeBoundingBox();
      const mat = new THREE.MeshPhongMaterial({
        vertexColors: true,
        specular: 0x0c1218, shininess: 14,
        flatShading: true,
        side: THREE.DoubleSide,
      });
      const threeMesh = new THREE.Mesh(geom, mat);
      viewer.scene.add(threeMesh);

      const state = {
        viewer, fd, labels, baseLabels, algLabels, geom, threeMesh, mat,
        sourceV: V, sourceF: F,
        sepShift: 0,
        flrShift: 0,
        zoneAreas: [0, 0, 0],
        uiLeft: null, uiRight: null,
        deletedFaces: new Uint8Array(fd.nF),
        scissorsActive: false,
        scissorsCtx: null,
      };

      refreshColors(state);

      const ui = installUI(state);
      refreshColors(state);

      return {
        get state() { return state; },
        refreshColors: () => refreshColors(state),
        // compact() — публичный wrapper для compactMeshFromDeletions(state).
        // Нужен tab:change-слушателю, который не имеет прямого доступа к
        // приватному state, но знает про editor.
        compact: () => compactMeshFromDeletions(state),
        dispose() {
          if (state.scissorsActive) {
            try { Scissors.disable(state, null); } catch (_) {}
          }
          ui.dispose();
          viewer.scene.remove(threeMesh);
          geom.dispose();
          mat.dispose();
          if (viewer.canvas) viewer.canvas.style.cursor = '';
          const canvas = document.getElementById('gl3d-zones');
          const empty  = document.getElementById('zonesEmpty') ||
                         document.querySelector('.stage[data-stage="zones"] .empty-state');
          if (canvas) canvas.style.display = 'none';
          if (empty)  empty.style.display  = '';
        },
      };
    }

    return { install };
  })();



  function injectCSS() {
    if (document.getElementById('tab3-zones-css')) return;
    const s = document.createElement('style');
    s.id = 'tab3-zones-css';
    s.textContent = [

        /* ═══════════════════════════════════════════════════════════
       ПРАВАЯ ПАНЕЛЬ — скролл при переполнении.
       ═══════════════════════════════════════════════════════════ */
      '.stage[data-stage="zones"] .panel.right {',
      '  overflow-y: auto; overflow-x: hidden;',
      '  scrollbar-width: thin;',
      '  scrollbar-color: rgba(0,240,255,0.35) transparent;',
      '}',
      '.stage[data-stage="zones"] .panel.right::-webkit-scrollbar { width: 6px; }',
      '.stage[data-stage="zones"] .panel.right::-webkit-scrollbar-track { background: transparent; }',
      '.stage[data-stage="zones"] .panel.right::-webkit-scrollbar-thumb {',
      '  background: rgba(0,240,255,0.35); border-radius: 3px;',
      '}',
      '.stage[data-stage="zones"] .panel.right::-webkit-scrollbar-thumb:hover {',
      '  background: rgba(0,240,255,0.6);',
      '}',
      '.light-theme .stage[data-stage="zones"] .panel.right {',
      '  scrollbar-color: rgba(79,124,219,0.45) transparent;',
      '}',
      '.light-theme .stage[data-stage="zones"] .panel.right::-webkit-scrollbar-thumb {',
      '  background: rgba(79,124,219,0.45);',
      '}',

      /* ═══════════════════════════════════════════════════════════
         КАРТОЧКИ В БОКОВЫХ ПАНЕЛЯХ — фиксируем естественную высоту.
         ═══════════════════════════════════════════════════════════ */
      '.stage[data-stage="zones"] .panel.right > .card,',
      '.stage[data-stage="zones"] .panel.left  > .card {',
      '  flex: 0 0 auto;',
      '  overflow: visible;',
      '}',

      /* Левая панель — тоже скроллим, на случай длинных подсказок и
         будущих новых блоков. Сейчас помещается, но запас не помешает. */
      '.stage[data-stage="zones"] .panel.left {',
      '  overflow-y: auto; overflow-x: hidden;',
      '  scrollbar-width: thin;',
      '  scrollbar-color: rgba(0,240,255,0.35) transparent;',
      '}',
      '.stage[data-stage="zones"] .panel.left::-webkit-scrollbar { width: 6px; }',
      '.stage[data-stage="zones"] .panel.left::-webkit-scrollbar-track { background: transparent; }',
      '.stage[data-stage="zones"] .panel.left::-webkit-scrollbar-thumb {',
      '  background: rgba(0,240,255,0.35); border-radius: 3px;',
      '}',
      '.stage[data-stage="zones"] .panel.left::-webkit-scrollbar-thumb:hover {',
      '  background: rgba(0,240,255,0.6);',
      '}',
      '.light-theme .stage[data-stage="zones"] .panel.left {',
      '  scrollbar-color: rgba(79,124,219,0.45) transparent;',
      '}',
      '.light-theme .stage[data-stage="zones"] .panel.left::-webkit-scrollbar-thumb {',
      '  background: rgba(79,124,219,0.45);',
      '}',

      '.stage[data-stage="zones"] .zn-slider-block {',
      '  margin: 10px 0 14px;',
      '}',
      '.stage[data-stage="zones"] .zn-slider-block:last-child { margin-bottom: 2px; }',
      '.stage[data-stage="zones"] .zn-slider-head {',
      '  display: flex; align-items: center; gap: 6px;',
      '  font-size: 12px; color: var(--tx2, #555);',
      '  margin-bottom: 6px;',
      '}',
      '.stage[data-stage="zones"] .zn-slider-arrow {',
      '  color: var(--tx3, #888); font-size: 15px; padding: 0 2px; font-weight: 500;',
      '}',
      '.stage[data-stage="zones"] .zn-slider-lab { font-weight: 500; }',
      '.stage[data-stage="zones"] .zn-slider-row {',
      '  display: grid; grid-template-columns: 1fr 32px;',
      '  align-items: center; gap: 10px;',
      '}',

      /* ═══ Custom slider ═══ */
      /* Применяем к ползункам в zn-slider-row (основные) и к ep-row */
      /* (fallback), чтобы tab3 не зависел от CSS tab2. */
      '.stage[data-stage="zones"] .zn-slider-row input[type=range],',
      '.stage[data-stage="zones"] .ep-row input[type=range] {',
      '  -webkit-appearance: none; appearance: none;',
      '  width: 100%; height: 22px; margin: 0;',
      '  background: transparent; cursor: pointer; outline: none;',
      '}',

       /* ═══ Divider + controls header ═══ */
      '.stage[data-stage="inner"] .ep-divider {',
      '  height: 1px; margin: 14px 0 10px;',
      '  background: linear-gradient(90deg, transparent, var(--brd-glow), transparent);',
      '}',
      '.stage[data-stage="inner"] .ep-ctrls-title {',
      '  font-size: 11px; letter-spacing: 0.16em;',
      '  text-transform: uppercase; color: var(--tx3);',
      '  margin-bottom: 8px;',
      '}',

      /* WebKit track */
      '.stage[data-stage="zones"] .zn-slider-row input[type=range]::-webkit-slider-runnable-track,',
      '.stage[data-stage="zones"] .ep-row input[type=range]::-webkit-slider-runnable-track {',
      '  height: 6px; border-radius: 999px;',
      '  background: linear-gradient(to right,',
      '    var(--cyan) var(--ep-pct,50%), rgba(120,140,170,.28) var(--ep-pct,50%));',
      '}',
      '.stage[data-stage="zones"] .zn-slider-row input[type=range]::-webkit-slider-thumb,',
      '.stage[data-stage="zones"] .ep-row input[type=range]::-webkit-slider-thumb {',
      '  -webkit-appearance: none; appearance: none;',
      '  width: 16px; height: 16px; border-radius: 50%;',
      '  background: var(--cyan); border: none;',
      '  margin-top: -5px; cursor: pointer;',
      '}',
      '.stage[data-stage="zones"] .zn-slider-row input[type=range]:hover,',
      '.stage[data-stage="zones"] .ep-row input[type=range]:hover { filter: brightness(1.08); }',
      '.stage[data-stage="zones"] .zn-slider-row input[type=range]:active,',
      '.stage[data-stage="zones"] .ep-row input[type=range]:active { filter: brightness(1.14); }',
      /* Firefox */
      '.stage[data-stage="zones"] .zn-slider-row input[type=range]::-moz-range-track,',
      '.stage[data-stage="zones"] .ep-row input[type=range]::-moz-range-track {',
      '  height: 6px; border-radius: 999px; background: rgba(120,140,170,.28);',
      '}',
      '.stage[data-stage="zones"] .zn-slider-row input[type=range]::-moz-range-progress,',
      '.stage[data-stage="zones"] .ep-row input[type=range]::-moz-range-progress {',
      '  height: 6px; border-radius: 999px; background: var(--cyan);',
      '}',
      '.stage[data-stage="zones"] .zn-slider-row input[type=range]::-moz-range-thumb,',
      '.stage[data-stage="zones"] .ep-row input[type=range]::-moz-range-thumb {',
      '  width: 16px; height: 16px; border-radius: 50%;',
      '  background: var(--cyan); border: none; cursor: pointer;',
      '}',
      '.stage[data-stage="zones"] .zn-slider-row .ep-val,',
      '.stage[data-stage="zones"] .ep-row .ep-val {',
      '  text-align: right; font-weight: 600;',
      '  color: var(--cyan);',
      "  font-family: 'Share Tech Mono','Consolas','Menlo',monospace;",
      '}',

      '.stage[data-stage="zones"] .zn-swatch {',
      '  width: 14px; height: 14px; border-radius: 3px; flex-shrink: 0;',
      '  border: 0px solid rgba(0,0,0,0.15);',
      '}',

      '.stage[data-stage="zones"] .zn-stat-row {',
      '  display: flex; align-items: center; gap: 10px;',
      '  padding: 6px 0; font-size: 12.5px;',
      '}',
      '.stage[data-stage="zones"] .zn-stat-k {',
      '  flex: 1; color: var(--tx2, #555);',
      '}',
      '.stage[data-stage="zones"] .zn-stat-v {',
      '  font-variant-numeric: tabular-nums; font-weight: 500;',
      '  color: var(--tx, #222);',
      '}',


      '.stage[data-stage="zones"] .ep-row {',
      '  display: grid; grid-template-columns: auto 1fr auto;',
      '  align-items: center; gap: 8px; margin: 4px 0;',
      '  font-size: 12px;',
      '}',
      '.stage[data-stage="zones"] .ep-hint {',
      '  margin-top: 8px; font-size: 12px; line-height: 1.5;',
      '  color: var(--tx2, #555);',
      '}',
      '.stage[data-stage="zones"] .ep-actions {',
      '  display: grid; grid-template-columns: 1fr 1fr; gap: 10px;',
      '}',
      '.stage[data-stage="zones"] .ep-act {',
      '  display: inline-flex; align-items: center; justify-content: center; gap: 7px;',
      '  padding: 10px 10px; background: transparent;',
      '  border: 1px solid var(--brd, rgba(0,0,0,0.12));',
      '  color: var(--tx2, #6b8faa);',
      '  border-radius: 8px; cursor: pointer; font: inherit; font-size: 12.5px; font-weight: 500;',
      '  transition: all 0.15s ease;',
      '}',
      '.stage[data-stage="zones"] .ep-act:hover {',
      '  border-color: var(--brd-glow); color: var(--tx); background: rgba(0,240,255,0.04);',
      '}',
      '.stage[data-stage="zones"] .ep-divider {',
      '  height: 1px; background: var(--brd, rgba(0,0,0,0.1)); margin: 10px 0;',
      '}',

      /* ═══ Кнопка «Экспорт» (карточка «Файл») ═══ */
      '.stage[data-stage="zones"] .ep-file-btn {',
      '  width: 100%; justify-content: center; display: inline-flex; align-items: center;',
      '  font-size: 12px; padding: 8px 10px; border-radius: 7px;',
      '  background: transparent; border: 1px solid var(--cyan); color: var(--cyan);',
      '  text-transform: none; letter-spacing: 0; font-weight: 500;',
      '  cursor: pointer; font-family: inherit;',
      '  transition: background .12s ease, border-color .12s ease;',
      '}',
      '.stage[data-stage="zones"] .ep-file-btn:hover {',
      '  background: var(--cyan-dim, rgba(79,124,219,.12));',
      '  border-color: var(--cyan);',
      '}',

      /* ═══ Ножницы — мелкая кнопка «Восстановить» + активное состояние ═══ */
      '.stage[data-stage="zones"] .ep-act.ep-act-sm {',
      '  font-size: 12px; padding: 10px 12px;',
      '  border-style: dashed; color: var(--tx3, #93a2b6);',
      '}',
      '.stage[data-stage="zones"] .ep-act.zn-act-on {',
      '  background: rgba(0,240,255,0.10);',
      '  border-color: var(--cyan, #00f0ff);',
      '  color: var(--cyan, #00f0ff);',
      '}',
      '.light-theme .stage[data-stage="zones"] .ep-act.zn-act-on {',
      '  background: rgba(74,158,255,0.12);',
      '  border-color: #4F7CDB; color: #4F7CDB;',
      '}',
      /* кнопка перехода — как на табах 01–03 */
      '.stage[data-stage="zones"] .btn-next-stage {',
      '  width: 100%; margin-top: 0;',
      '  display: inline-flex; align-items: center; justify-content: center; gap: 8px;',
      '  padding: 12px 16px; font-size: 13px; letter-spacing: .06em;',
      '  white-space: nowrap; line-height: 1;',
      '}',
      '.stage[data-stage="zones"] .btn-next-stage svg { flex: 0 0 auto; }',

      /* сворачиваемая инструкция — как #segGuideCard и #innerGuideCard */
      /* заголовок прижат влево, стрелка уходит вправо через margin-left:auto —
         space-between растягивал текстовый блок и уводил надпись в центр */
      '.stage[data-stage="zones"] details#zonesGuideCard > summary {',
      '  list-style: none; cursor: pointer; display: flex; align-items: center;',
      '  justify-content: flex-start; text-align: left; margin-bottom: 0;',
      '}',
      '.stage[data-stage="zones"] details#zonesGuideCard > summary::-webkit-details-marker { display: none; }',
      '.stage[data-stage="zones"] details#zonesGuideCard > summary::after {',
      '  content: "\\25B8"; opacity: .55; font-size: 13px; margin-left: auto;',
      '  transition: transform .15s ease;',
      '}',
      '.stage[data-stage="zones"] details#zonesGuideCard[open] > summary::after { transform: rotate(90deg); }',
      '.stage[data-stage="zones"] details#zonesGuideCard[open] > summary { margin-bottom: 9px; }',

      /* обе панели прокручиваются, если содержимое не помещается */
      /* Прокрутка панелей.
         Ширину и flex НЕ трогаем: в app.css у .panel задано
         width:280px + flex-shrink:0, а overflow-y там уже есть.
         Нужен только min-height:0, чтобы флекс-элемент разрешил
         себя сжать и прокрутка включилась. */
      '.stage[data-stage="zones"] .panel.left,',
      '.stage[data-stage="zones"] .panel.right {',
      '  min-height: 0; padding-bottom: 14px;',
      '}',
      '.stage[data-stage="zones"] .panel::-webkit-scrollbar { width: 9px; }',
      '.stage[data-stage="zones"] .panel::-webkit-scrollbar-thumb {',
      '  background: var(--brd); border-radius: 5px;',
      '}',

      /* «Сбросить границы» на всю ширину + разделитель перед обрезкой */
      '.stage[data-stage="zones"] .zn-reset-btn { width: 100%; justify-content: center; }',
      /* Карандаш у границы: маленькая кнопка в строке заголовка */
      '.stage[data-stage="zones"] .zn-pencil {',
      '  margin-left: auto; display: inline-flex; align-items: center;',
      '  justify-content: center; width: 24px; height: 24px; padding: 0;',
      '  border: 1px solid var(--brd); border-radius: 6px;',
      '  background: transparent; color: var(--tx2); cursor: pointer;',
      '  transition: color .12s ease, border-color .12s ease, background .12s ease;',
      '}',
      '.stage[data-stage="zones"] .zn-pencil:hover {',
      '  border-color: var(--cyan); color: var(--cyan);',
      '}',
      '.stage[data-stage="zones"] .zn-pencil.zn-act-on {',
      '  border-color: var(--cyan); color: var(--cyan);',
      '  background: var(--cyan-dim, rgba(79,124,219,.12));',
      '}',
      '.stage[data-stage="zones"] .zn-act-sep {',
      '  height: 1px; background: var(--brd); margin: 12px 0 11px;',
      '}',
      '.stage[data-stage="zones"] .ep-ctrls-title {',
      '  font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em;',
      '  color: var(--tx3, #888); margin-bottom: 6px;',
      '}',
      '.stage[data-stage="zones"] .ep-steps {',
      '  list-style: none; padding: 0; margin: 0;',
      '  font-size: 12.5px; line-height: 1.55;',
      '  counter-reset: ep-step;',
      '}',
      '.stage[data-stage="zones"] .ep-steps li {',
      '  position: relative; padding-left: 28px; margin-bottom: 9px;',
      '  counter-increment: ep-step;',
      '  color: var(--tx2);',
      '}',
      '.stage[data-stage="zones"] .ep-steps li::before {',
      '  content: counter(ep-step);',
      '  position: absolute; left: 0; top: -1px;',
      '  width: 20px; height: 20px;',
      '  display: flex; align-items: center; justify-content: center;',
      '  font-size: 10.5px; font-weight: 700;',
      '  color: var(--cyan);',
      '  background: rgba(0,240,255,0.08);',
      '  border: 1px solid var(--brd-glow);',
      '  border-radius: 50%;',
      "  font-family: 'Share Tech Mono','Consolas',monospace;",
      '}',
      '.stage[data-stage="zones"] .ep-steps li:last-child { margin-bottom: 0; }',
      '.stage[data-stage="zones"] .ep-steps b { color: var(--cyan); font-weight: 600; }',

      /* light-theme — синий #4F7CDB  */
      '.light-theme .stage[data-stage="zones"] .ep-steps li::before {',
      '  background: rgba(79,124,219,0.08); border-color: rgba(79,124,219,0.3); color: #4F7CDB;',
      '}',
      '.light-theme .stage[data-stage="zones"] .ep-steps b { color: #4F7CDB; }',
    ].join('\n');
    document.head.appendChild(s);
  }

  // ═════════════════════════════════════════════════════════════════════
  //                          Публичный API + bootstrap
  // ═════════════════════════════════════════════════════════════════════

  /* Регистрация в архиве — ОДИН РАЗ при загрузке модуля.

     Сначала вызов стоял внутри emitChange, то есть срабатывал только
     после ручной правки зон. Если врач принял автоматическую разметку
     как есть, провайдер не регистрировался, зоны в архив не попадали, и
     после его открытия этап 05 оставался закрытым. В серверном логе это
     выглядело как отсутствие запроса GET /api/session/zones — при том
     что остальное восстанавливалось. */
  (function registerZonesInArchive() {
    const reg = () => {
      if (!window.SessionArchive) return false;
      window.SessionArchive.register('zones',
        function () {
          const L = window.M && window.M.zoneLabels;
          return (L && L.length) ? { labels: Array.from(L) } : null;
        },
        function (data) {
          const arr = data && (data.labels || data.zone_labels);
          if (!arr || !window.M || !window.M.nF) return;
          if (arr.length !== window.M.nF) {
            console.warn('[tab3] метки зон из архива не подходят к мешу ' +
                         '(' + arr.length + ' против ' + window.M.nF + ') — пропущены');
            return;
          }
          window.M.zoneLabels = new Uint8Array(arr);
        });
      return true;
    };
    if (reg()) return;
    // модуль архива может грузиться позже — подождём его
    let n = 0;
    const t = setInterval(() => { if (reg() || ++n > 40) clearInterval(t); }, 150);
  })();

  /* Открыть этап из восстановленных меток, без пересчёта.

     После загрузки архива метки зон лежат в window.M.zoneLabels, но
     редактор этапа пуст — и вкладка показывает пустой экран с кнопкой
     «Запустить сегментацию». Врач нажимает, и зоны считаются заново
     поверх уже готовых: результат тот же, время потеряно, а любые
     ручные правки границ, сделанные раньше, пропадают.

     Редактору нужны всего четыре поля: labels и тройка векторов системы
     координат eML/eUP/eAP. Метки берём восстановленные, векторы
     пересчитываем — это тензор нормалей по площадям, доли секунды,
     несопоставимо с полной сегментацией. */
  /* Восстановление зон должно оставлять window.M в ТОМ ЖЕ виде, что и
     обычная сегментация. Иначе штатный путь переустановки редактора
     (_reinstallEditorFromCache) отказывается работать.

     Он требует условия labelsValid: метки, их длина по числу граней И
     заполненный zoneMeta.eML. Моё восстановление клало только метки —
     zoneMeta оставался пустым, условие не проходило, и вкладка уходила
     в ветку (D) «полная пересегментация SaddleSeg'ом». Она пересчитывала
     зоны с нуля и через commitZoneLabels рассылала zones:done, а следом
     сбрасывалась и развёртка. Это и выглядело как «зоны и развёртка
     стёрлись и перерисовались».

     Поэтому ниже вместе с метками заполняем zoneMeta целиком: систему
     координат, площади зон и суммарную площадь — ровно те поля, что
     кладёт commitZoneLabels. */
  window.Tab3 = window.Tab3 || {};

  /* ДАННЫЕ отдельно от редактора.

     Заполнять zoneMeta при входе на вкладку поздно: наблюдатель за
     классами вкладок (MutationObserver) срабатывает микрозадачей, то
     есть РАНЬШЕ обработчика tab:change, и успевает проверить labelsValid
     на ещё пустом zoneMeta — после чего уходит в полную
     пересегментацию. Поэтому данные восстанавливаем сразу при загрузке
     сессии, до любого показа, а редактор ставим потом. */
  window.Tab3.restoreDataFromSession = function () {
    const M = window.M;
    if (!M || !M.V || !M.F || !M.zoneLabels) return false;
    if (M.zoneLabels.length !== M.nF) {
      console.warn('[tab3] метки не подходят к мешу — данные зон не восстановлены');
      return false;
    }
    if (M.zoneMeta && M.zoneMeta.eML) return true;   // уже заполнено

    const fd = window.FaceGeom ? window.FaceGeom.build(M.V, M.F, M.nF) : null;
    let frame = null;
    if (window.SaddleSeg && window.SaddleSeg.estimateFrame && fd) {
      try { frame = window.SaddleSeg.estimateFrame(fd.normals || fd.fn, fd.areas || fd.fa); }
      catch (e) { console.warn('[tab3] система координат:', e.message); }
    }
    const eML = (frame && frame.eML) || [1, 0, 0];
    const eUP = (frame && frame.eUP) || [0, 0, 1];
    const eAP = (frame && frame.eAP) || [0, 1, 0];

    const areas = (fd && (fd.areas || fd.fa)) || null;
    const za = [0, 0, 0];
    let total = 0;
    if (areas) {
      for (let f = 0; f < M.nF; f++) {
        const a = areas[f] || 0;
        za[M.zoneLabels[f]] += a;
        total += a;
      }
    }
    M.zoneMeta = { eML: eML.slice(), eUP: eUP.slice(), eAP: eAP.slice(),
                   areas: za, totalArea: total };

    try {
      const exp = buildZoneExports(M.zoneLabels, M.V, M.F);
      M.zoneFaces = exp.zoneFaces;
      M.zoneMeshes = exp.zoneMeshes;
      M.zoneBoundaries = exp.zoneBoundaries;
    } catch (err) {
      console.warn('[tab3] экспорт зон при восстановлении:', err);
    }
    return true;
  };

  window.Tab3.restoreFromSession = function () {
    if (editor) return true;
    const M = window.M;
    if (!window.Tab3.restoreDataFromSession()) return false;
    const v = ensureViewer();
    if (!v) return false;                 // холст ещё не готов — позже

    const fd = window.FaceGeom
      ? window.FaceGeom.build(M.V, M.F, M.nF)
      : null;
    let frame = null;
    if (window.SaddleSeg && window.SaddleSeg.estimateFrame && fd) {
      try { frame = window.SaddleSeg.estimateFrame(fd.normals || fd.fn, fd.areas || fd.fa); }
      catch (e) { console.warn('[tab3] система координат:', e.message); }
    }
    const out = {
      labels: M.zoneLabels,
      eML: (frame && frame.eML) || [1, 0, 0],
      eUP: (frame && frame.eUP) || [0, 0, 1],
      eAP: (frame && frame.eAP) || [0, 1, 0],
    };

    /* Установка редактора рассылает 'zones:edit' — сигнал «врач правил
       зоны», по которому этап 05 сбрасывает кэш и пересчитывает
       развёртку. При восстановлении это ложь: зоны не менялись, их
       только что подняли из архива. Гасим сигнал на время установки. */
    const _dispatch = window.dispatchEvent.bind(window);
    window.dispatchEvent = function (ev) {
      const k = ev && ev.detail && ev.detail.kind;
      if (k === 'zones:edit') return true;      // молча глотаем
      return _dispatch(ev);
    };
    try {
      editor = Editor.install(v, M.V, M.F, out);
    } finally {
      window.dispatchEvent = _dispatch;
    }

    const canvas = document.getElementById('gl3d-zones');
    const empty  = document.getElementById('zonesEmpty');
    if (canvas) canvas.style.display = 'block';
    if (empty)  empty.style.display = 'none';
    return true;
  };

  window.Tab3 = window.Tab3 || {};
  window.Tab3.run         = runZoneSeg;
  window.Tab3.getLabels   = () => (editor && editor.state.labels) || window.M.zoneLabels || null;
  window.Tab3.onActivate  = function () { /* noop — используется MutationObserver */ };

  window.addEventListener('DOMContentLoaded', () => {
    setupStaticUI();
    installTabWatcher();
  });

  // Если пользователь возвращается в таб 2 и пересохраняет inner,
  // перезапускает автосегментацию, загружает новый OBJ в таб 1 или
  // делает полный сброс — транзакционно сбрасываем ВСЁ zone-состояние:
  // editor, метки в window.M, кэш экспорта — и запираем tab4, чтобы
  // нельзя было перейти к развёртке без пересчёта зон.
  // При следующем визите tab3 (syncActiveStates) зоны пересчитаются
  // с нуля под новые V/F, и runZoneSeg в конце разблокирует tab4.
  window.addEventListener('data:change', (e) => {
    const d = e.detail || {};
    const destructive =
      d.kind === 'inner:invalidated' ||
      d.kind === 'segment-done'      ||
      d.kind === 'mesh-replaced'     ||
      d.kind === 'reset'             ||
      /* inner:saved приходит и когда врач просто нажал «Продолжить»,
         ничего не поправив, — в частности после восстановления из
         архива. Стирать зоны в этом случае незачем: геометрия та же.
         Этап 03 теперь сообщает, менялась ли маска; при отсутствии
         признака считаем, что менялась, — так безопаснее. */
      (d.kind === 'inner:saved' && d.changed !== false);
    if (!destructive) return;
    disposeEditor();
    invalidateZoneState();
    lockUnfoldTab();
  });

})();
