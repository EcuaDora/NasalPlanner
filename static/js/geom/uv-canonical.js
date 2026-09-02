/* ─── geom/uv-canonical ────────────────────────────────────────
   Канонизация развёртки: приведение UV к фиксированной раскладке
       сверху  — перегородка (SEP)
       посреди — дно (FLR)
       снизу   — латеральная стенка (LAT)
   и к фиксированной стороне листа (вид со стороны просвета).

   ЗАЧЕМ. LSCM в nasal_unfold_v5.py пинится двумя вершинами, выбранными
   как геодезический диаметр границы (_pick_pins_geodesic). Какая пара
   выиграет — зависит от формы конкретного меша, поэтому поворот и
   зеркальность результата произвольны: каждый прогон кладёт лист на
   бумагу по-новому. Фронт (tab4-unfold.js) забирает uv как есть и не
   канонизирует. Отсюда «каждый раз другое расположение».

   ПОЧЕМУ НЕ ЧИНИМ СОЛВЕР. Заставить LSCM выдавать нужную ориентацию
   через выбор пинов можно, но пины ещё и определяют, где будет
   наименьшее искажение — трогать их значит менять качество развёртки
   ради косметики. Дешевле и безопаснее выровнять результат после.

   МЕТОД. Три шага, каждый решается в замкнутой форме:

     1. ЭТАЛОН. Строим опорную раскладку ref(v) = (x, y), где
        x = проекция на передне-заднюю ось, а y = ½(d→LAT − d→SEP) —
        стопка SEP↑ / FLR / LAT↓, посчитанная по ГЕОДЕЗИЧЕСКИМ
        расстояниям вдоль поверхности, а не по проекции на
        медиолатеральную ось: при выраженной девиации проекция
        вырождается (перегородка заходит латеральнее части стенки),
        а расстояние вдоль поверхности — нет.

     2. ХИРАЛЬНОСТЬ. Отражение — не косметика: оно меняет, с какой
        стороны листа смотрит хирург (со стороны просвета или «изнутри
        кости»). Определяем её не подгонкой, а по намотке треугольников:
        нормали inner_surface смотрят в просвет (segment.py делает
        fix_winding + invert по знаку объёма на замкнутом кармане, а
        inner_surface — его submesh), значит «видно слизистую»
        эквивалентно «знаковая площадь треугольника в UV положительна».
        Приводим и эталон, и uv к положительной ориентации независимо
        друг от друга — тогда сравнивать их хиральности не нужно.

     3. ПОВОРОТ. Взвешенный 2D-Прокруст uv → ref. Масштаб НЕ трогаем
        (uv в миллиметрах, по нему меряют линейкой), сдвиг —
        детерминированный: площадной центроид дна в (0,0).

   Веса везде — площадь, приходящаяся на вершину (Σ площадей инцидентных
   граней / 3). Иначе густая сетка у хоаны перетягивает поворот на себя.

   ЗАВИСИМОСТИ: SaddleSeg (estimateFrame) — опционально, но настоятельно;
   без него используется запасная оценка осей по тензору нормалей,
   встроенная ниже. THREE не нужен.

   ПРОВЕРЕНО на синтетическом U-канале — обобщённом цилиндре с профилем
   «подкова», который развёртывается точно, поэтому истинная развёртка
   известна аналитически (test-uv-canonical.js, test-uv-stress.js):

     · 256 случайных поворотов+отражений одной развёртки → одна и та же
       раскладка, расхождение 0.000000 мм, стопка верна 256/256;
     · искажение развёртки 30 % (вдвое хуже реального edge_err) —
       остаточный поворот ≤ 3.3°, стопка 64/64;
     · 10 % случайно испорченных меток зон — ≤ 5.9°, стопка 64/64;
     · защемление хода (перегородка касается стенки) 95 % — ≤ 1.1°;
     · сетка втрое гуще спереди — ≤ 1.1° (работает взвешивание);
     · 36 тыс. вершин / 72 тыс. граней — 160 мс.

   НЕ ПРОВЕРЕНО на реальных данных: у автора этого файла их не было.
   Первым делом посмотрите в консоли строку «[tab4] канонизация: …» —
   confidence ниже ~0.5 и любые warnings означают, что случай выбивается
   из модели и раскладку надо посмотреть глазами.
──────────────────────────────────────────────────────────────── */
(function (global) {
  'use strict';

  const SEP = 0, FLR = 1, LAT = 2;

  // ═══════════════════════════════════════════════════════════
  //  Геометрия граней
  // ═══════════════════════════════════════════════════════════

  function faceGeom(V, F, nF) {
    const fn = new Float64Array(nF * 3);
    const fa = new Float64Array(nF);
    for (let f = 0; f < nF; f++) {
      const i0 = F[f * 3], i1 = F[f * 3 + 1], i2 = F[f * 3 + 2];
      const ax = V[i0 * 3], ay = V[i0 * 3 + 1], az = V[i0 * 3 + 2];
      const e1x = V[i1 * 3] - ax, e1y = V[i1 * 3 + 1] - ay, e1z = V[i1 * 3 + 2] - az;
      const e2x = V[i2 * 3] - ax, e2y = V[i2 * 3 + 1] - ay, e2z = V[i2 * 3 + 2] - az;
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      const ln = Math.sqrt(nx * nx + ny * ny + nz * nz);
      fa[f] = ln * 0.5;
      const inv = ln > 1e-15 ? 1 / ln : 0;
      fn[f * 3] = nx * inv; fn[f * 3 + 1] = ny * inv; fn[f * 3 + 2] = nz * inv;
    }
    return { fn, fa };
  }

  /* Вес вершины = треть суммы площадей инцидентных граней. */
  function vertexWeights(F, nF, nV, fa) {
    const w = new Float64Array(nV);
    for (let f = 0; f < nF; f++) {
      const a = fa[f] / 3;
      w[F[f * 3]] += a; w[F[f * 3 + 1]] += a; w[F[f * 3 + 2]] += a;
    }
    // Изолированные вершины не должны занулять систему
    for (let i = 0; i < nV; i++) if (!(w[i] > 0)) w[i] = 1e-12;
    return w;
  }

  // ═══════════════════════════════════════════════════════════
  //  Анатомический базис
  // ═══════════════════════════════════════════════════════════

  /* Запасной вариант, если SaddleSeg не загружен. Та же идея:
     собственные векторы area-weighted тензора нормалей Σ aᵢnᵢnᵢᵀ.
     λ_max → ML (большинство нормалей смотрит медиально/латерально),
     средний → UP, λ_min → AP (вдоль хода нормалей почти нет). */
  function estimateFrameFallback(fn, fa) {
    const nF = fa.length;
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let f = 0; f < nF; f++) {
      const a = fa[f], x = fn[f * 3], y = fn[f * 3 + 1], z = fn[f * 3 + 2];
      M[0][0] += a * x * x; M[0][1] += a * x * y; M[0][2] += a * x * z;
      M[1][1] += a * y * y; M[1][2] += a * y * z; M[2][2] += a * z * z;
    }
    M[1][0] = M[0][1]; M[2][0] = M[0][2]; M[2][1] = M[1][2];

    // Якоби
    const A = [M[0].slice(), M[1].slice(), M[2].slice()];
    const Q = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let sweep = 0; sweep < 50; sweep++) {
      const off = Math.abs(A[0][1]) + Math.abs(A[0][2]) + Math.abs(A[1][2]);
      if (off < 1e-14) break;
      for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) {
        if (Math.abs(A[p][q]) < 1e-18) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = A[k][p], akq = A[k][q];
          A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = A[p][k], aqk = A[q][k];
          A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk;
          const qkp = Q[k][p], qkq = Q[k][q];
          Q[k][p] = c * qkp - s * qkq; Q[k][q] = s * qkp + c * qkq;
        }
      }
    }
    const ev = [
      { l: A[0][0], v: [Q[0][0], Q[1][0], Q[2][0]] },
      { l: A[1][1], v: [Q[0][1], Q[1][1], Q[2][1]] },
      { l: A[2][2], v: [Q[0][2], Q[1][2], Q[2][2]] },
    ].sort((a, b) => a.l - b.l);

    let eML = ev[2].v, eUP = ev[1].v;

    // знак ML: перегородка — крупнейшая зона, её нормали вдоль +eML
    let aPos = 0, aNeg = 0;
    for (let f = 0; f < nF; f++) {
      const d = fn[f * 3] * eML[0] + fn[f * 3 + 1] * eML[1] + fn[f * 3 + 2] * eML[2];
      if (d > 0) aPos += fa[f]; else aNeg += fa[f];
    }
    if (aPos < aNeg) eML = [-eML[0], -eML[1], -eML[2]];

    // знак UP: нормали дна смотрят вверх
    let flux = 0;
    for (let f = 0; f < nF; f++) {
      flux += fa[f] * (fn[f * 3] * eUP[0] + fn[f * 3 + 1] * eUP[1] + fn[f * 3 + 2] * eUP[2]);
    }
    if (flux < 0) eUP = [-eUP[0], -eUP[1], -eUP[2]];

    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const norm = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
    let eAP = cross(eML, eUP);
    eUP = cross(eAP, eML);
    return { eML: norm(eML), eUP: norm(eUP), eAP: norm(eAP) };
  }

  function getFrame(fn, fa) {
    if (global.SaddleSeg && typeof global.SaddleSeg.estimateFrame === 'function') {
      try { return global.SaddleSeg.estimateFrame(fn, fa); } catch (e) { /* вниз */ }
    }
    return estimateFrameFallback(fn, fa);
  }

  // ═══════════════════════════════════════════════════════════
  //  Метки вершин и границы зон
  // ═══════════════════════════════════════════════════════════

  /* Метка вершины = метка, набравшая больше всего инцидентных граней.
     Ничьи разрешаются в пользу меньшего индекса — детерминированно. */
  function vertexLabels(F, nF, nV, zoneLabels) {
    const cnt = new Int32Array(nV * 3);
    for (let f = 0; f < nF; f++) {
      const l = zoneLabels[f];
      if (l > LAT) continue;                 // DEL / мусор — не голосует
      for (let j = 0; j < 3; j++) cnt[F[f * 3 + j] * 3 + l]++;
    }
    const vl = new Int8Array(nV).fill(-1);
    for (let i = 0; i < nV; i++) {
      const a = cnt[i * 3], b = cnt[i * 3 + 1], c = cnt[i * 3 + 2];
      if (a === 0 && b === 0 && c === 0) continue;   // -1: вершина без зоны
      vl[i] = (a >= b && a >= c) ? SEP : (b >= c ? FLR : LAT);
    }
    return vl;
  }

  // ═══════════════════════════════════════════════════════════
  //  Граф вершин + Дейкстра из множества источников
  // ═══════════════════════════════════════════════════════════

  /* CSR без дедупликации рёбер: каждое ребро попадает дважды (по одному
     разу от каждой грани). Для Дейкстры дубликаты безвредны, а Set на
     миллион ключей — нет. */
  function buildCSR(V, F, nF, nV) {
    const deg = new Int32Array(nV + 1);
    for (let f = 0; f < nF; f++) {
      const a = F[f * 3], b = F[f * 3 + 1], c = F[f * 3 + 2];
      deg[a] += 2; deg[b] += 2; deg[c] += 2;
    }
    const off = new Int32Array(nV + 1);
    for (let i = 0; i < nV; i++) off[i + 1] = off[i] + deg[i];
    const idx = new Int32Array(off[nV]);
    const wgt = new Float64Array(off[nV]);
    const cur = off.slice(0, nV);
    const put = (a, b) => {
      const dx = V[a * 3] - V[b * 3];
      const dy = V[a * 3 + 1] - V[b * 3 + 1];
      const dz = V[a * 3 + 2] - V[b * 3 + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      idx[cur[a]] = b; wgt[cur[a]] = d; cur[a]++;
      idx[cur[b]] = a; wgt[cur[b]] = d; cur[b]++;
    };
    for (let f = 0; f < nF; f++) {
      const a = F[f * 3], b = F[f * 3 + 1], c = F[f * 3 + 2];
      put(a, b); put(b, c); put(c, a);
    }
    return { off, idx, wgt };
  }

  function multiSourceDijkstra(csr, nV, sources) {
    const d = new Float64Array(nV).fill(Infinity);
    // Бинарная куча на типизированных массивах
    const hk = new Float64Array(nV * 4);
    const hv = new Int32Array(nV * 4);
    let hn = 0;
    const push = (key, val) => {
      if (hn >= hk.length) return;           // защита от переполнения
      let i = hn++;
      hk[i] = key; hv[i] = val;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (hk[p] <= hk[i]) break;
        const tk = hk[p], tv = hv[p]; hk[p] = hk[i]; hv[p] = hv[i]; hk[i] = tk; hv[i] = tv;
        i = p;
      }
    };
    const pop = () => {
      const rk = hk[0], rv = hv[0];
      hn--;
      if (hn > 0) {
        hk[0] = hk[hn]; hv[0] = hv[hn];
        let i = 0;
        for (;;) {
          let s = i;
          const l = 2 * i + 1, r = 2 * i + 2;
          if (l < hn && hk[l] < hk[s]) s = l;
          if (r < hn && hk[r] < hk[s]) s = r;
          if (s === i) break;
          const tk = hk[s], tv = hv[s]; hk[s] = hk[i]; hv[s] = hv[i]; hk[i] = tk; hv[i] = tv;
          i = s;
        }
      }
      return [rk, rv];
    };

    for (let i = 0; i < sources.length; i++) { d[sources[i]] = 0; push(0, sources[i]); }
    while (hn > 0) {
      const [du, u] = pop();
      if (du > d[u]) continue;
      for (let k = csr.off[u]; k < csr.off[u + 1]; k++) {
        const v = csr.idx[k], nd = du + csr.wgt[k];
        if (nd < d[v]) { d[v] = nd; push(nd, v); }
      }
    }
    return d;
  }

  // ═══════════════════════════════════════════════════════════
  //  Эталонная раскладка
  // ═══════════════════════════════════════════════════════════

  /* ref(v) = (t_ap, y_stack), где

         y_stack(v) = ½ · ( d(v → LAT) − d(v → SEP) )

     d — геодезическое расстояние по рёбрам меша до БЛИЖАЙШЕЙ вершины
     соответствующей зоны (мультиисточниковая Дейкстра, два прогона).

     Почему так, а не по границам зон. Первая версия строила эталон от
     линий перегородка|дно и дно|латеральная, и разваливалась, как только
     одна из этих границ отсутствовала — а это не экзотика: врач может
     стереть дно «Ножницами», зоны могут не соприкасаться после правки
     ползунками. Формула выше не требует ни границ, ни наличия дна:
     достаточно, чтобы существовали хотя бы две разные зоны.

     Функция монотонна поперёк листа: на перегородке d(→SEP)=0 и y растёт
     по мере удаления от латеральной стенки, на стенке симметрично,
     на дне обе величины меняются навстречу друг другу. Масштаб по зонам
     чуть разный (в рукавах 0.5 мм на мм пути, на дне 1.0) — для подгонки
     ПОВОРОТА это безразлично, эталон не обязан быть метричным.

     Знак фиксирован метками зон, а не направлением оси: перегородка
     всегда наверху по построению. Это важно — знак ê_ML в estimateFrame
     выбирается по правилу «у перегородки больше площадь», и когда
     площади перегородки и стенки близки, он переворачивается. От этого
     не должно зависеть, что окажется сверху. */
  function buildReference(V, F, nF, nV, zoneLabels, frame, warnings) {
    const vl = vertexLabels(F, nF, nV, zoneLabels);

    const src = [[], [], []];
    for (let i = 0; i < nV; i++) if (vl[i] >= 0) src[vl[i]].push(i);

    const eAP = frame.eAP, eML = frame.eML;
    const ref = new Float64Array(nV * 2);
    for (let i = 0; i < nV; i++) {
      ref[i * 2] = V[i * 3] * eAP[0] + V[i * 3 + 1] * eAP[1] + V[i * 3 + 2] * eAP[2];
    }

    // «Верх» стопки: перегородка, при её отсутствии — дно.
    // «Низ»: латеральная стенка, при её отсутствии — дно.
    const top = src[SEP].length ? SEP : (src[FLR].length ? FLR : -1);
    const bot = src[LAT].length ? LAT : (src[FLR].length ? FLR : -1);

    if (top < 0 || bot < 0 || top === bot) {
      // Одна-единственная зона на весь меш — расположить стопку не от чего.
      warnings.push('в меше меньше двух различимых зон — вертикаль задана ' +
                    'проекцией на медиолатеральную ось, её знак не гарантирован');
      for (let i = 0; i < nV; i++) {
        ref[i * 2 + 1] = -(V[i * 3] * eML[0] + V[i * 3 + 1] * eML[1] + V[i * 3 + 2] * eML[2]);
      }
      return { ref, vl, degraded: true };
    }
    if (top !== SEP || bot !== LAT) {
      warnings.push('одна из крайних зон отсутствует — стопка построена по ' +
                    (top === SEP ? 'перегородке и дну' : 'дну и латеральной стенке'));
    }

    const csr = buildCSR(V, F, nF, nV);
    const dTop = multiSourceDijkstra(csr, nV, src[top]);
    const dBot = multiSourceDijkstra(csr, nV, src[bot]);

    // Недостижимые вершины (несвязная компонента) — приравниваем к самому
    // дальнему достижимому, чтобы Infinity не отравил подгонку.
    let mxT = 0, mxB = 0, unreachable = 0;
    for (let i = 0; i < nV; i++) {
      if (isFinite(dTop[i]) && dTop[i] > mxT) mxT = dTop[i];
      if (isFinite(dBot[i]) && dBot[i] > mxB) mxB = dBot[i];
    }
    for (let i = 0; i < nV; i++) {
      const a = isFinite(dTop[i]) ? dTop[i] : (unreachable++, mxT);
      const b = isFinite(dBot[i]) ? dBot[i] : mxB;
      ref[i * 2 + 1] = 0.5 * (b - a);
    }
    if (unreachable) {
      warnings.push('вершин вне связной компоненты: ' + unreachable);
    }
    return { ref, vl, degraded: false };
  }

  // ═══════════════════════════════════════════════════════════
  //  Хиральность
  // ═══════════════════════════════════════════════════════════

  /* Знаковая площадь треугольника в намотке F. Положительна, если
     развёртка ориентирована согласованно с 3D-нормалью — то есть если
     наблюдатель смотрит на ту сторону листа, куда смотрят нормали. */
  function orientationScore(uv, F, nF, fa) {
    let s = 0;
    for (let f = 0; f < nF; f++) {
      const i0 = F[f * 3], i1 = F[f * 3 + 1], i2 = F[f * 3 + 2];
      const x0 = uv[i0 * 2], y0 = uv[i0 * 2 + 1];
      const a2 = (uv[i1 * 2] - x0) * (uv[i2 * 2 + 1] - y0)
               - (uv[i2 * 2] - x0) * (uv[i1 * 2 + 1] - y0);
      if (a2 > 0) s += fa[f]; else if (a2 < 0) s -= fa[f];
    }
    return s;
  }

  function mirrorX(uv, nV) {
    for (let i = 0; i < nV; i++) uv[i * 2] = -uv[i * 2];
  }

  // ═══════════════════════════════════════════════════════════
  //  Взвешенный 2D-Прокруст (только поворот)
  // ═══════════════════════════════════════════════════════════

  /* min_θ Σ wᵢ |R(θ)·pᵢ − qᵢ|²  ⟹  θ = atan2(Σw(Yx−Xy), Σw(Xx+Yy)),
     где p — центрированный uv, q — центрированный эталон.
     confidence = |Σ w p·q| / Σ w |p||q| ∈ [0,1]: 1 — облака совпадают с
     точностью до поворота, ~0 — поворот не определён (например, лист
     вышел почти круглым и любая ориентация одинаково хороша). */
  function fitRotation(uv, ref, nV, w) {
    let W = 0, cx = 0, cy = 0, rx = 0, ry = 0;
    for (let i = 0; i < nV; i++) {
      const q = w[i]; W += q;
      cx += q * uv[i * 2]; cy += q * uv[i * 2 + 1];
      rx += q * ref[i * 2]; ry += q * ref[i * 2 + 1];
    }
    cx /= W; cy /= W; rx /= W; ry /= W;

    let a = 0, b = 0, nrm = 0;
    for (let i = 0; i < nV; i++) {
      const q = w[i];
      const x = uv[i * 2] - cx, y = uv[i * 2 + 1] - cy;
      const X = ref[i * 2] - rx, Y = ref[i * 2 + 1] - ry;
      a += q * (X * x + Y * y);
      b += q * (Y * x - X * y);
      nrm += q * Math.hypot(x, y) * Math.hypot(X, Y);
    }
    return {
      theta: Math.atan2(b, a),
      confidence: nrm > 1e-12 ? Math.hypot(a, b) / nrm : 0,
      cx, cy,
    };
  }

  // ═══════════════════════════════════════════════════════════
  //  Главная функция
  // ═══════════════════════════════════════════════════════════

  /* canonicalize({ V, F, nV, nF, uv, zoneLabels, faceAreas?, viewFromLumen? })

     uv правится НА МЕСТЕ (и возвращается). Масштаб не меняется:
     миллиметры остаются миллиметрами, линейка на развёртке не врёт.

     Возврат:
       uv            тот же массив
       theta         применённый поворот, градусы
       mirrored      было ли отражение
       confidence    насколько уверенно определён поворот, 0..1
       apDir         [dx,dy] — куда в канонических координатах смотрит
                     +eAP. Для подписи «передний/задний» на канвасе
       zoneMeanY     [SEP, FLR, LAT] — средние y зон после приведения.
                     Должно строго убывать; иначе что-то не так
       ok            true, если стопка получилась в нужном порядке
       warnings      список замечаний                                  */
  function canonicalize(opts) {
    const V = opts.V, F = opts.F, uv = opts.uv;
    const nV = opts.nV != null ? opts.nV : V.length / 3;
    const nF = opts.nF != null ? opts.nF : F.length / 3;
    const zoneLabels = opts.zoneLabels;
    const viewFromLumen = opts.viewFromLumen !== false;
    const warnings = [];

    if (!V || !F || !uv) throw new Error('canonicalize: нужны V, F, uv');
    if (uv.length !== nV * 2) throw new Error('canonicalize: uv не той длины');

    const geom = faceGeom(V, F, nF);
    const fa = opts.faceAreas && opts.faceAreas.length === nF ? opts.faceAreas : geom.fa;
    const w = vertexWeights(F, nF, nV, fa);

    // Без меток зон канонизировать не от чего
    if (!zoneLabels || zoneLabels.length !== nF) {
      warnings.push('нет меток зон — канонизация пропущена');
      return { uv, theta: 0, mirrored: false, confidence: 0, apDir: [1, 0],
               zoneMeanY: null, ok: false, warnings };
    }
    let seen = 0;
    for (let f = 0; f < nF; f++) if (zoneLabels[f] <= LAT) seen |= (1 << zoneLabels[f]);
    if (seen !== 0b111) {
      warnings.push('в меше присутствуют не все три зоны — раскладка может быть неполной');
    }

    const frame = getFrame(geom.fn, fa);
    const { ref } = buildReference(V, F, nF, nV, zoneLabels, frame, warnings);

    // ── Хиральность: обе раскладки приводим к положительной ориентации.
    if (orientationScore(ref, F, nF, fa) < 0) mirrorX(ref, nV);

    const sUV = orientationScore(uv, F, nF, fa);
    let mirrored = viewFromLumen ? (sUV < 0) : (sUV > 0);
    if (mirrored) mirrorX(uv, nV);
    if (!viewFromLumen) mirrorX(ref, nV);

    // ── Поворот
    const fit = fitRotation(uv, ref, nV, w);
    const c = Math.cos(fit.theta), s = Math.sin(fit.theta);
    for (let i = 0; i < nV; i++) {
      const x = uv[i * 2] - fit.cx, y = uv[i * 2 + 1] - fit.cy;
      uv[i * 2]     = c * x - s * y;
      uv[i * 2 + 1] = s * x + c * y;
    }
    if (fit.confidence < 0.5) {
      warnings.push('поворот определён неуверенно (confidence ' +
                    fit.confidence.toFixed(2) + ') — форма листа близка к ' +
                    'симметричной; проверьте раскладку глазами');
    }

    // ── Сдвиг: площадной центроид дна в (0,0). Дно — самая стабильная
    //    зона между визитами, привязка к нему делает вид воспроизводимым.
    const vl = vertexLabels(F, nF, nV, zoneLabels);
    let aw = 0, ax = 0, ay = 0;
    for (let i = 0; i < nV; i++) {
      if (vl[i] !== FLR) continue;
      aw += w[i]; ax += w[i] * uv[i * 2]; ay += w[i] * uv[i * 2 + 1];
    }
    if (aw <= 0) {                       // дна нет — центрируем по всему листу
      aw = 0; ax = 0; ay = 0;
      for (let i = 0; i < nV; i++) { aw += w[i]; ax += w[i] * uv[i * 2]; ay += w[i] * uv[i * 2 + 1]; }
    }
    const ox = ax / aw, oy = ay / aw;
    for (let i = 0; i < nV; i++) { uv[i * 2] -= ox; uv[i * 2 + 1] -= oy; }

    // ── Диагностика: направление +eAP в канонических координатах.
    //    Ищем 2D-вектор, наиболее скоррелированный с проекцией на eAP.
    let tw = 0, tm = 0, ux = 0, uy = 0;
    const tap = new Float64Array(nV);
    for (let i = 0; i < nV; i++) {
      tap[i] = V[i * 3] * frame.eAP[0] + V[i * 3 + 1] * frame.eAP[1] + V[i * 3 + 2] * frame.eAP[2];
      tw += w[i]; tm += w[i] * tap[i];
    }
    tm /= tw;
    for (let i = 0; i < nV; i++) {
      const t = tap[i] - tm;
      ux += w[i] * t * uv[i * 2]; uy += w[i] * t * uv[i * 2 + 1];
    }
    const ul = Math.hypot(ux, uy) || 1;
    const apDir = [ux / ul, uy / ul];

    // ── Самопроверка: стопка обязана идти SEP > FLR > LAT по y.
    const sum = [0, 0, 0], wt = [0, 0, 0];
    for (let i = 0; i < nV; i++) {
      const l = vl[i];
      if (l < 0) continue;
      sum[l] += w[i] * uv[i * 2 + 1]; wt[l] += w[i];
    }
    const zoneMeanY = [0, 1, 2].map(k => wt[k] > 0 ? sum[k] / wt[k] : NaN);
    /* Порядок проверяем только среди ПРИСУТСТВУЮЩИХ зон. Раньше здесь
       было одно выражение с NaN, и оно давало ok=true при отсутствующем
       дне — то есть молчало ровно в том случае, ради которого писалось.
       Сравнения с NaN всегда ложны, поэтому «не нарушено» ≠ «в порядке». */
    const present = [0, 1, 2].filter(k => wt[k] > 0);
    let ok = present.length >= 2;
    for (let i = 0; i + 1 < present.length; i++) {
      if (!(zoneMeanY[present[i]] > zoneMeanY[present[i + 1]])) ok = false;
    }
    if (!ok) {
      warnings.push('порядок зон по вертикали нарушен или зон меньше двух: ' +
        present.map(k => ['SEP', 'FLR', 'LAT'][k] + '=' + zoneMeanY[k].toFixed(1)).join(' ') +
        ' мм');
    }

    return {
      uv,
      theta: fit.theta * 180 / Math.PI,
      mirrored,
      confidence: fit.confidence,
      apDir,
      zoneMeanY,
      ok,
      warnings,
      frame,
    };
  }

  global.UVCanonical = {
    canonicalize,
    // экспорт внутренностей — для тестов и переиспользования
    buildReference, orientationScore, fitRotation, vertexLabels,
    multiSourceDijkstra, buildCSR, faceGeom,
    estimateFrameFallback,
    SEP, FLR, LAT,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.UVCanonical;

})(typeof window !== 'undefined' ? window : globalThis);
