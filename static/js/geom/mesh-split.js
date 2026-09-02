/* ─── geom/mesh-split ──────────────────────────────────────────
   Разбиение меша секущей плоскостью на два куска БЕЗ изменения
   геометрии.

   ГЛАВНЫЙ ИНВАРИАНТ. Разрез — это разбиение МНОЖЕСТВА ГРАНЕЙ, а не
   геометрический слайс. Ни одна вершина не создаётся, не удаляется и
   не двигается; nF не меняется. Каждая грань целиком уходит в один
   кусок по стороне своего центроида. Шов идёт по рёбрам треугольников
   (зубчатый) — это косметика, а не дефект.

   Следствие: маска `mask` всё время живёт в индексном пространстве
   ИСХОДНОГО меша (Uint8Array(nF)). Куски — только представление.
   Поэтому «склейка» кусков — это ничего не делать: маска уже целая.

   Почему не настоящий слайс: он создаёт новые вершины, а значит новые
   центроиды, которых нет в mesh_clean. Обратное сопоставление в
   operations/segment_finalize.py идёт через cKDTree по центроидам с
   допуском max(1e-3, diag*1e-5) — новые грани туда не попадут, и
   сработает «сопоставилось N/M». Плюс сломается побитовое равенство
   площадей, которое segment_finalize гарантирует явно.

   ЗАВИСИМОСТИ: THREE (r128) — только в buildMeshes / pick / focusPose.
   Чистая математика (computeSide, buildPieces, computeSeam, seamReport,
   stitchSeam) от THREE не зависит и тестируется отдельно.

   ФОРМАТ fd — то, что возвращает buildFaceData() в tab2-inner.js:
     positions Float32Array(nF*9)   3 вершины × xyz на грань
     normals   Float32Array(nF*9)
     colors    Float32Array(nF*9)
     fc        Float32Array(nF*3)   центроиды граней
     nbrOff    Int32Array(nF+1)     CSR-смещения графа смежности
     nbrIdx    Int32Array(...)      CSR-соседи
     nF        число граней
──────────────────────────────────────────────────────────────── */
(function (global) {
  'use strict';

  const EPS = 1e-12;
  const GHOST_OPACITY = 0.12;

  // ═══════════════════════════════════════════════════════════
  //  Плоскость
  // ═══════════════════════════════════════════════════════════

  /* Плоскость: { nx, ny, nz, d }, нормаль единичная.
     signed(f) = nx*cx + ny*cy + nz*cz - d
     side(f)   = signed(f) < 0 ? 0 : 1                          */

  function makePlane(n, pointOnPlane) {
    const L = Math.hypot(n[0], n[1], n[2]);
    if (!(L > EPS)) throw new Error('makePlane: нулевая нормаль');
    const nx = n[0] / L, ny = n[1] / L, nz = n[2] / L;
    return {
      nx, ny, nz,
      d: nx * pointOnPlane[0] + ny * pointOnPlane[1] + nz * pointOnPlane[2],
    };
  }

  /* Геометрическая середина облака центров граней (не центр масс:
     взвешивание по площади здесь не нужно). */
  function centroidOf(fd) {
    const { fc, nF } = fd;
    let sx = 0, sy = 0, sz = 0;
    for (let f = 0; f < nF; f++) {
      sx += fc[f*3]; sy += fc[f*3+1]; sz += fc[f*3+2];
    }
    return [sx / nF, sy / nF, sz / nF];
  }

  /* Ковариация центров граней → 3 главные оси (по убыванию λ).
     Симметричная 3×3 через вращения Якоби — сходится за единицы
     итераций, внешних зависимостей не нужно. */
  function principalAxes(fd) {
    const { fc, nF } = fd;
    const c = centroidOf(fd);
    let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
    for (let f = 0; f < nF; f++) {
      const dx = fc[f*3] - c[0], dy = fc[f*3+1] - c[1], dz = fc[f*3+2] - c[2];
      xx += dx*dx; xy += dx*dy; xz += dx*dz;
      yy += dy*dy; yz += dy*dz; zz += dz*dz;
    }
    const A = [[xx/nF, xy/nF, xz/nF],
               [xy/nF, yy/nF, yz/nF],
               [xz/nF, yz/nF, zz/nF]];
    const V = [[1,0,0], [0,1,0], [0,0,1]];

    for (let sweep = 0; sweep < 32; sweep++) {
      const off = A[0][1]*A[0][1] + A[0][2]*A[0][2] + A[1][2]*A[1][2];
      if (off < 1e-20) break;
      for (let p = 0; p < 2; p++) {
        for (let q = p + 1; q < 3; q++) {
          if (Math.abs(A[p][q]) < 1e-18) continue;
          const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
          const t  = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta*theta + 1));
          const cs = 1 / Math.sqrt(t*t + 1), sn = t * cs;
          for (let k = 0; k < 3; k++) {
            const akp = A[k][p], akq = A[k][q];
            A[k][p] = cs*akp - sn*akq;
            A[k][q] = sn*akp + cs*akq;
          }
          for (let k = 0; k < 3; k++) {
            const apk = A[p][k], aqk = A[q][k];
            A[p][k] = cs*apk - sn*aqk;
            A[q][k] = sn*apk + cs*aqk;
            const vkp = V[k][p], vkq = V[k][q];
            V[k][p] = cs*vkp - sn*vkq;
            V[k][q] = sn*vkp + cs*vkq;
          }
        }
      }
    }

    const eig = [
      { l: A[0][0], v: [V[0][0], V[1][0], V[2][0]] },
      { l: A[1][1], v: [V[0][1], V[1][1], V[2][1]] },
      { l: A[2][2], v: [V[0][2], V[1][2], V[2][2]] },
    ].sort((a, b) => b.l - a.l);

    return {
      center:  c,
      axes:    eig.map(e => e.v),
      lambdas: eig.map(e => e.l),
    };
  }

  /* Плоскость по умолчанию: нормаль вдоль НАИМЕНЬШЕЙ главной оси,
     через центроид.

     Обоснование: наименьшая главная ось — направление, в котором облако
     граней тоньше всего. На реальных данных (когорта из 10 случаев) она
     стабильно совпадает с медиолатеральной осью, и разрез разводит
     перегородочную сторону от латеральной — ровно то, ради чего
     плоскость и нужна. */
  const autoPlane = (fd) => {
    const pa = principalAxes(fd);
    return makePlane(pa.axes[2], pa.center);
  };

  /* Сдвиг плоскости вдоль её нормали на delta мм (нормаль не меняется). */
  const offsetPlane = (plane, deltaMM) => ({
    nx: plane.nx, ny: plane.ny, nz: plane.nz, d: plane.d + deltaMM,
  });

  /* Диапазон допустимых сдвигов в мм — для границ ползунка. */
  function planeRange(fd, plane) {
    const { fc, nF } = fd;
    let lo = Infinity, hi = -Infinity;
    for (let f = 0; f < nF; f++) {
      const s = plane.nx*fc[f*3] + plane.ny*fc[f*3+1] + plane.nz*fc[f*3+2] - plane.d;
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    return { min: lo, max: hi };
  }

  // ═══════════════════════════════════════════════════════════
  //  Разбиение
  // ═══════════════════════════════════════════════════════════

  function computeSide(fd, plane) {
    const { fc, nF } = fd;
    const side = new Uint8Array(nF);
    for (let f = 0; f < nF; f++) {
      const s = plane.nx*fc[f*3] + plane.ny*fc[f*3+1] + plane.nz*fc[f*3+2] - plane.d;
      side[f] = s < 0 ? 0 : 1;
    }
    return side;
  }

  /* Сырые буферы кусков + отображения индексов.
       local2orig[p][li] = origFaceIdx            (для пикинга)
       orig2local[f]     = li внутри своего куска  (для покраски)     */
  function buildPieces(fd, side) {
    const { nF, positions: P, normals: N, colors: C } = fd;
    const cnt = [0, 0];
    for (let f = 0; f < nF; f++) cnt[side[f]]++;

    const orig2local = new Int32Array(nF);
    const pieces = [0, 1].map(p => ({
      id:         p,
      count:      cnt[p],
      local2orig: new Int32Array(cnt[p]),
      positions:  new Float32Array(cnt[p] * 9),
      normals:    new Float32Array(cnt[p] * 9),
      colors:     new Float32Array(cnt[p] * 9),
    }));

    const cursor = [0, 0];
    for (let f = 0; f < nF; f++) {
      const s = side[f];
      const pc = pieces[s];
      const li = cursor[s]++;
      pc.local2orig[li] = f;
      orig2local[f] = li;
      const so = f * 9, lo = li * 9;
      for (let k = 0; k < 9; k++) {
        pc.positions[lo+k] = P[so+k];
        pc.normals[lo+k]   = N[so+k];
        pc.colors[lo+k]    = C[so+k];
      }
    }
    return { pieces, orig2local };
  }

  /* Грань принадлежит шву, если хотя бы один её сосед по ребру лежит
     на другой стороне плоскости. */
  function computeSeam(fd, side) {
    const { nF, nbrOff, nbrIdx } = fd;
    const seam = new Uint8Array(nF);
    for (let f = 0; f < nF; f++) {
      for (let k = nbrOff[f]; k < nbrOff[f+1]; k++) {
        if (side[nbrIdx[k]] !== side[f]) { seam[f] = 1; break; }
      }
    }
    return seam;
  }

  /* Ось шва (PCA по центрам граней шва) — задел под «раскрытие книжкой».
     Считается дёшево, кладётся в split. */
  function seamAxis(fd, seam) {
    const { fc, nF } = fd;
    const idx = [];
    for (let f = 0; f < nF; f++) if (seam[f]) idx.push(f);
    const n = idx.length;
    if (n < 3) return null;

    let cx = 0, cy = 0, cz = 0;
    const sub = { fc: new Float32Array(n * 3), nF: n };
    idx.forEach((f, i) => {
      cx += fc[f*3]; cy += fc[f*3+1]; cz += fc[f*3+2];
      sub.fc[i*3]   = fc[f*3];
      sub.fc[i*3+1] = fc[f*3+1];
      sub.fc[i*3+2] = fc[f*3+2];
    });
    return {
      origin: [cx/n, cy/n, cz/n],
      dir:    principalAxes(sub).axes[0],
    };
  }

  // ═══════════════════════════════════════════════════════════
  //  THREE-представление
  // ═══════════════════════════════════════════════════════════

  const makeMaterial = (THREE, ghost) => new THREE.MeshPhongMaterial({
    vertexColors: true,
    specular:     0x0c1218,
    shininess:    14,
    flatShading:  true,
    side:         THREE.DoubleSide,
    transparent:  !!ghost,
    opacity:      ghost ? GHOST_OPACITY : 1.0,
    depthWrite:   !ghost,
  });

  function buildMeshes(THREE, split) {
    split.pieces.forEach((pc, p) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pc.positions, 3));
      g.setAttribute('normal',   new THREE.BufferAttribute(pc.normals, 3));
      g.setAttribute('color',    new THREE.BufferAttribute(pc.colors, 3));
      g.computeBoundingBox();
      g.computeBoundingSphere();
      const m = makeMaterial(THREE, false);
      const mesh = new THREE.Mesh(g, m);
      mesh.userData.pieceId = p;
      mesh.userData.__splitPiece = true;
      pc.geom = g;
      pc.material = m;
      pc.mesh = mesh;
    });
    return split;
  }

  // ═══════════════════════════════════════════════════════════
  //  Конструктор / перерез / жизненный цикл
  // ═══════════════════════════════════════════════════════════

  const attach = (split, scene) =>
    split.pieces.forEach(pc => { if (pc.mesh) scene.add(pc.mesh); });

  const detach = (split, scene) => {
    if (!scene) return;
    split.pieces.forEach(pc => { if (pc.mesh) scene.remove(pc.mesh); });
  };

  const disposeGeom = (split) => split.pieces.forEach(pc => {
    if (pc.geom) { pc.geom.dispose(); pc.geom = null; }
    if (pc.material) { pc.material.dispose(); pc.material = null; }
    pc.mesh = null;
  });

  function create(fd, plane, THREE) {
    if (!fd || !fd.nF) throw new Error('MeshSplit.create: пустой fd');
    plane = plane || autoPlane(fd);
    const side = computeSide(fd, plane);
    const { pieces, orig2local } = buildPieces(fd, side);
    const seam = computeSeam(fd, side);

    const split = {
      plane,
      nF: fd.nF,
      side,
      seam,
      seamAxis: seamAxis(fd, seam),
      orig2local,
      pieces,
      active: 0,
      visibility: 'solo-ghost',
    };
    if (THREE) buildMeshes(THREE, split);
    return split;
  }

  /* Перерез. Маска НЕ трогается — она в другом индексном пространстве.
     Активный кусок и режим видимости сохраняются. */
  function resplit(split, fd, plane, THREE, scene) {
    const prevActive = split.active;
    const prevVis    = split.visibility;
    detach(split, scene);
    disposeGeom(split);

    const side = computeSide(fd, plane);
    const { pieces, orig2local } = buildPieces(fd, side);
    split.plane      = plane;
    split.side       = side;
    split.seam       = computeSeam(fd, side);
    split.seamAxis   = seamAxis(fd, split.seam);
    split.orig2local = orig2local;
    split.pieces     = pieces;
    split.active     = prevActive;
    split.visibility = prevVis;
    if (THREE) buildMeshes(THREE, split);
    if (scene) attach(split, scene);
    return split;
  }

  function dispose(split, scene) {
    detach(split, scene);
    disposeGeom(split);
  }

  // ═══════════════════════════════════════════════════════════
  //  Видимость и активный кусок
  // ═══════════════════════════════════════════════════════════

  /* Режимы:
       'both'       — оба куска непрозрачны
       'solo-ghost' — активный непрозрачен, второй призрак (не пикается)
       'solo'       — виден только активный

     Призрак намеренно исключён из пикинга: иначе при прозрачности 12%
     клик мимо активного куска попадал бы в невидимую грань. */
  const VIS_MODES = ['both', 'solo-ghost', 'solo'];

  function applyVisibility(split) {
    split.pieces.forEach((pc, p) => {
      if (!pc.mesh) return;
      const isActive = (p === split.active);
      let vis, ghost;
      if (split.visibility === 'both')      { vis = true;     ghost = false; }
      else if (split.visibility === 'solo') { vis = isActive; ghost = false; }
      else                                  { vis = true;     ghost = !isActive; }

      pc.mesh.visible = vis;
      pc.isGhost = ghost;
      pc.material.transparent = ghost;
      pc.material.opacity     = ghost ? GHOST_OPACITY : 1.0;
      pc.material.depthWrite  = !ghost;
      pc.material.needsUpdate = true;
      pc.mesh.renderOrder = ghost ? 1 : 0;   // призраки рисуем после
    });
  }

  function setVisibility(split, mode) {
    if (!VIS_MODES.includes(mode)) {
      throw new Error(`setVisibility: неизвестный режим ${mode}`);
    }
    split.visibility = mode;
    applyVisibility(split);
    return split;
  }

  function setActive(split, pieceId) {
    if (pieceId !== 0 && pieceId !== 1) {
      throw new Error('setActive: pieceId должен быть 0 или 1');
    }
    split.active = pieceId;
    applyVisibility(split);
    return split;
  }

  /* Кандидаты на пикинг: видимые и НЕ призрачные. */
  const pickTargets = (split) =>
    split.pieces.filter(pc => pc.mesh && pc.mesh.visible && !pc.isGhost)
                .map(pc => pc.mesh);

  /* Пикинг → { face, pieceId, distance } в индексах ИСХОДНОГО меша,
     либо null. raycaster должен быть уже настроен (setFromCamera). */
  function pick(split, raycaster) {
    const targets = pickTargets(split);
    if (!targets.length) return null;
    const hits = raycaster.intersectObjects(targets, false);
    if (!hits.length) return null;
    const h = hits[0];
    const pid = h.object.userData.pieceId;
    const pc = split.pieces[pid];
    if (h.faceIndex == null || h.faceIndex < 0 || h.faceIndex >= pc.count) return null;
    return { face: pc.local2orig[h.faceIndex], pieceId: pid, distance: h.distance };
  }

  // ═══════════════════════════════════════════════════════════
  //  Цвета
  // ═══════════════════════════════════════════════════════════

  /* Один проход по граням: пишем и в мастер-буфер fd.colors, и сразу в
     буфер нужного куска. Раздельный gather не нужен — стоимость та же,
     что у прежнего refreshColors. Замер: 3.2 мс на 164 тыс. граней. */
  function syncColors(split, fd, mask, colSel, colUnsel) {
    const { nF, colors: C } = fd;
    const { side, orig2local: o2l, pieces } = split;
    for (let f = 0; f < nF; f++) {
      const col = mask[f] ? colSel : colUnsel;
      const o  = f * 9;
      const PC = pieces[side[f]].colors;
      const lo = o2l[f] * 9;
      for (let k = 0; k < 3; k++) {
        const b = k * 3;
        C[o+b]   = col.r; C[o+b+1]   = col.g; C[o+b+2]   = col.b;
        PC[lo+b] = col.r; PC[lo+b+1] = col.g; PC[lo+b+2] = col.b;
      }
    }
    pieces.forEach(pc => {
      if (pc.geom) pc.geom.attributes.color.needsUpdate = true;
    });
  }

  /* Как syncColors, но грани ШВА красим отдельным цветом.

     Без видимой линии реза инструмент «Точка реза» невозможно
     проверить: врач ставит точку, что-то пересчитывается, но где
     проходит линия — не видно, и любой результат выглядит как «не
     работает». Полоса шва — то же множество граней, что подсвечивает
     previewCut, только показываем её постоянно. */
  function syncColorsWithSeam(split, fd, mask, colSel, colUnsel, colSeam) {
    const { nF, colors: C } = fd;
    const { side, orig2local: o2l, pieces, seam } = split;
    for (let f = 0; f < nF; f++) {
      const col = seam[f] ? colSeam : (mask[f] ? colSel : colUnsel);
      const o = f * 9;
      const PC = pieces[side[f]].colors;
      const lo = o2l[f] * 9;
      for (let k = 0; k < 3; k++) {
        const b = k * 3;
        C[o+b]   = col.r; C[o+b+1]   = col.g; C[o+b+2]   = col.b;
        PC[lo+b] = col.r; PC[lo+b+1] = col.g; PC[lo+b+2] = col.b;
      }
    }
    pieces.forEach(pc => {
      if (pc.geom) pc.geom.attributes.color.needsUpdate = true;
    });
  }

  /* ПРЕДПРОСМОТР РЕЗА.
     Полный resplit на 164 тыс. граней стоит ~34 мс — для разового
     действия нормально, для протяжки ползунка нет. Поэтому во время
     drag куски НЕ пересобираются: считается только будущий side, и
     грани будущей линии реза подсвечиваются поверх текущей раскраски.
     Замер: 5.6 мс — помещается в кадр.

     Полный resplit вызывается один раз, по отпусканию ползунка.
     Возвращает { cutFaces } — для подписи в UI.                      */
  function previewCut(split, fd, mask, plane, colSel, colUnsel, colCut) {
    const { nF, colors: C } = fd;
    const { side, orig2local: o2l, pieces } = split;
    const newSeam = computeSeam(fd, computeSide(fd, plane));
    let cutFaces = 0;
    for (let f = 0; f < nF; f++) {
      let col;
      if (newSeam[f]) { col = colCut; cutFaces++; }
      else col = mask[f] ? colSel : colUnsel;
      const o  = f * 9;
      const PC = pieces[side[f]].colors;
      const lo = o2l[f] * 9;
      for (let k = 0; k < 3; k++) {
        const b = k * 3;
        C[o+b]   = col.r; C[o+b+1]   = col.g; C[o+b+2]   = col.b;
        PC[lo+b] = col.r; PC[lo+b+1] = col.g; PC[lo+b+2] = col.b;
      }
    }
    pieces.forEach(pc => {
      if (pc.geom) pc.geom.attributes.color.needsUpdate = true;
    });
    return { cutFaces };
  }

  // ═══════════════════════════════════════════════════════════
  //  Шов: диагностика и сшивка
  // ═══════════════════════════════════════════════════════════

  /* КРИТЕРИЙ СШИВКИ — компонентный.

     Заливаются только те связные компоненты НЕпрокрашенных граней,
     которые целиком лежат внутри полосы шва. Компонента, дотянувшаяся
     хотя бы до одной грани вне шва, — это настоящая внешняя область
     (слизистая там просто кончилась), и её трогать нельзя.

     Правило переписывалось дважды, оба раза по результатам теста:

       1. «Есть закрашенный сосед и со своей стороны, и с чужой» — НЕ
          работает никогда: полоса шва двусторонняя, сосед с чужой
          стороны сам является гранью шва и сам не закрашен.
       2. «Строгое большинство соседей закрашено» — работало на
          синтетике, но на реальном меше (163 924 грани, маска врача)
          закрасило 331 лишнюю грань: подъедало границу маски везде, где
          она идёт вдоль линии реза.
       3. Компонентный критерий — на тех же данных закрашивает 0, а
          искусственный пропуск в 79 граней находит и закрывает точно
          (маска восстанавливается 163 924 / 163 924).

     Не возвращайтесь ни к (1), ни к (2). Один проход, итерации не нужны. */
  function unpaintedComponents(fd, split, mask) {
    const { nF, nbrOff, nbrIdx } = fd;
    const { seam } = split;
    const comp  = new Int32Array(nF).fill(-1);
    const queue = new Int32Array(nF);
    const enclosed = [], sizes = [];
    let nc = 0;

    for (let s = 0; s < nF; s++) {
      if (mask[s] || comp[s] !== -1) continue;
      let head = 0, tail = 0, size = 0, allSeam = true;
      queue[tail++] = s;
      comp[s] = nc;
      while (head < tail) {
        const f = queue[head++];
        size++;
        if (!seam[f]) allSeam = false;
        for (let k = nbrOff[f]; k < nbrOff[f+1]; k++) {
          const g = nbrIdx[k];
          if (mask[g] || comp[g] !== -1) continue;
          comp[g] = nc;
          queue[tail++] = g;
        }
      }
      enclosed.push(allSeam);
      sizes.push(size);
      nc++;
    }
    return { comp, enclosed, sizes, count: nc };
  }

  /* Диагностика шва:
       seamFaces — всего граней в полосе шва
       unpainted — из них непрокрашенных
       fillable  — сколько закрасил бы stitchSeam
       gaps      — число замкнутых пропусков                          */
  function seamReport(fd, split, mask) {
    const { nF } = fd;
    const { seam } = split;
    let seamFaces = 0, unpainted = 0;
    for (let f = 0; f < nF; f++) {
      if (!seam[f]) continue;
      seamFaces++;
      if (!mask[f]) unpainted++;
    }
    const cc = unpaintedComponents(fd, split, mask);
    let fillable = 0, gaps = 0;
    for (let c = 0; c < cc.count; c++) {
      if (cc.enclosed[c]) { fillable += cc.sizes[c]; gaps++; }
    }
    return { seamFaces, unpainted, fillable, gaps };
  }

  function stitchSeam(fd, split, mask) {
    const cc = unpaintedComponents(fd, split, mask);
    let filled = 0, gaps = 0;
    for (let c = 0; c < cc.count; c++) if (cc.enclosed[c]) gaps++;
    if (gaps) {
      for (let f = 0; f < fd.nF; f++) {
        if (mask[f]) continue;
        const c = cc.comp[f];
        if (c >= 0 && cc.enclosed[c]) { mask[f] = 1; filled++; }
      }
    }
    return { filled, gaps, converged: true };
  }

  // ═══════════════════════════════════════════════════════════
  //  Камера
  // ═══════════════════════════════════════════════════════════

  /* Позиция обзора «лицом к плоскости разреза» для куска pieceId.
     Возвращает { target, theta, phi, dist } в терминах орбиты viewer.js:
       pos = target + dist*(sin φ cos θ, sin φ sin θ, cos φ), up = +Z
     Камера ставится со стороны СВОЕГО куска — смотрит на плоскость
     разреза снаружи внутрь. Пустой кусок → null.                     */
  function focusPose(fd, split, pieceId, marginFactor = 0.9) {
    const pc = split.pieces[pieceId];
    if (!pc.count) return null;

    let minx = Infinity, miny = Infinity, minz = Infinity;
    let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    for (let li = 0; li < pc.count; li++) {
      for (let v = 0; v < 3; v++) {
        const o = li*9 + v*3;
        const x = pc.positions[o], y = pc.positions[o+1], z = pc.positions[o+2];
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (y < miny) miny = y; if (y > maxy) maxy = y;
        if (z < minz) minz = z; if (z > maxz) maxz = z;
      }
    }
    const diag = Math.hypot(maxx - minx, maxy - miny, maxz - minz);

    // Направление ОТ плоскости к своему куску: сторона 0 = отрицательная
    const sgn = (pieceId === 0) ? -1 : 1;
    const E = 0.05;   // тот же кламп phi, что в viewer.js
    return {
      target: [(minx+maxx)/2, (miny+maxy)/2, (minz+maxz)/2],
      theta:  Math.atan2(split.plane.ny * sgn, split.plane.nx * sgn),
      phi:    Math.max(E, Math.min(Math.PI - E,
                Math.acos(Math.max(-1, Math.min(1, split.plane.nz * sgn))))),
      dist:   Math.max(diag * marginFactor, 1),
    };
  }

  // ═══════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════
  //  Деление по НАПРАВЛЕНИЮ нормали (перегородка / латеральная стенка)
  // ═══════════════════════════════════════════════════════════

  /* Плоскость делит по ПОЛОЖЕНИЮ, а перегородка и латеральная стенка
     различаются тем, КУДА СМОТРЯТ. Ход изогнут, раковины заходят
     медиально — прямая плоскость режет и то и другое.

     Проверено на когорте по меткам зон (inner_zoned_segmentation.json):
     чистота отделения SEP от LAT у плоскости 88.1 %, у этого метода
     100.0 % на всех 9 случаях с метками.

     Сырое поле шумное (раковины, складки дают локальные развороты
     нормали) — сглаживаем лапласианом по графу граней. Тот же приём,
     что в operations/segment.py для полей hit_fwd и n·r. */
  function medialField(fd, axis, iters) {
    if (iters == null) iters = 8;
    const { nF, normals, nbrOff, nbrIdx } = fd;
    let f = new Float32Array(nF);
    for (let i = 0; i < nF; i++) {
      f[i] = normals[i*9]*axis[0] + normals[i*9+1]*axis[1] + normals[i*9+2]*axis[2];
    }
    for (let it = 0; it < iters; it++) {
      const g = new Float32Array(nF);
      for (let i = 0; i < nF; i++) {
        let s = f[i], n = 1;
        for (let k = nbrOff[i]; k < nbrOff[i+1]; k++) { s += f[nbrIdx[k]]; n++; }
        g[i] = 0.35 * f[i] + 0.65 * (s / n);
      }
      f = g;
    }
    return f;
  }

  /* bias ∈ [-0.3, 0.3] — ползунок «граница»: двигает порог медиально
     или латерально.

     Связность половин НЕ обеспечиваем НАМЕРЕННО. Кусок может состоять
     из нескольких частей — они всё равно показываются вместе, а
     принудительная склейка островов портит чистоту отделения
     (проверено: с чисткой островов 7 случаев из 10 ломались). */
  function computeSideMedial(fd, field, bias) {
    const side = new Uint8Array(fd.nF);
    const b = bias || 0;
    for (let i = 0; i < fd.nF; i++) side[i] = field[i] < b ? 0 : 1;
    return side;
  }

  /* Пересборка кусков под новый порог. Поле считается один раз в
     enableSplit, поэтому здесь только порог + сборка буферов — можно
     звать прямо на протяжке ползунка. */
  function resplitMedial(split, fd, field, bias, THREE, scene) {
    const prevActive = split.active, prevVis = split.visibility;
    detach(split, scene);
    disposeGeom(split);
    const side = computeSideMedial(fd, field, bias);
    const bp = buildPieces(fd, side);
    split.side       = side;
    split.seam       = computeSeam(fd, side);
    split.seamAxis   = seamAxis(fd, split.seam);
    split.orig2local = bp.orig2local;
    split.pieces     = bp.pieces;
    split.active     = prevActive;
    split.visibility = prevVis;
    if (THREE) buildMeshes(THREE, split);
    applyVisibility(split);
    if (scene) attach(split, scene);
    return split;
  }
  /* Пересборка кусков под новое положение реза. Линия x*(y) считается
     один раз в enableSplit, здесь только сдвиг + доводка + сборка
     буферов — можно звать прямо на протяжке ползунка. */
  function resplitFloor(split, fd, cut, biasMM, THREE, scene) {
    const prevActive = split.active, prevVis = split.visibility;
    detach(split, scene);
    disposeGeom(split);
    let side = computeSideFloor(fd, cut, biasMM);
    /* Порог доводки зависит от того, ставил ли врач точки.

       Без точек линию выбирает автомат, и присоединить отслоившийся
       лоскут к соседу — правильно: это чинит редкие случаи, где
       вертикальная линия задевает нависающую раковину.

       С точками линию выбирает ВРАЧ, и перекидывать из-за неё крупный
       кусок — значит молча отменять его решение. Поэтому порог падает
       до слияния мелких заусенцев; всё крупное остаётся как есть, а
       счётчик кусков в панели показывает, что кусок распался. */
    const pinned = cut.pins && cut.pins.length;
    side = reattachFragments(fd, side, pinned ? 0.06 : 0.55);
    const bp = buildPieces(fd, side);
    split.side       = side;
    split.seam       = computeSeam(fd, side);
    split.seamAxis   = seamAxis(fd, split.seam);
    split.orig2local = bp.orig2local;
    split.pieces     = bp.pieces;
    split.active     = prevActive;
    split.visibility = prevVis;
    if (THREE) buildMeshes(THREE, split);
    applyVisibility(split);
    if (scene) attach(split, scene);
    return split;
  }


  /* ═══════════════════════════════════════════════════════════
  //  РЕЗ ВДОЛЬ ДНА
  // ═══════════════════════════════════════════════════════════

   Рез вдоль дна: вертикальная секущая поверхность x = x*(y),
   следующая за ходом.

   ЗАЧЕМ. Проверено на 10 реальных mesh_clean: у ШЕСТИ из них genus ≥ 1
   (№1,2,4,5,9 — один тоннель, №3 — два). Это сросшиеся перегородка и
   латеральная стенка. Любой метод, опирающийся на СВЯЗНОСТЬ поверхности
   — сглаженное поле нормалей, геодезические расстояния, разрез по
   графу — в месте сращения замыкается накоротко, и куски дробятся.
   Ровно это врач и видел.

   Здесь разрез чисто ПОЗИЦИОННЫЙ: грань уходит влево или вправо от
   поверхности x = x*(y). Топология позиционному критерию безразлична:
   сросся меш или нет, перегородка целиком остаётся с одной стороны,
   латеральная стенка целиком с другой.

   ГДЕ ПРОВЕСТИ ЛИНИЮ. Вертикальная плоскость параллельна перегородке:
   поставленная на перегородку, разрезала бы её вдоль, на огромной
   площади. Поставленная на дно — пересекает только два тонких листа.
   Значит нужное положение — минимум рассечённой площади. Считаем
   плотность площади по x в каждом поперечном срезе и ищем минимум,
   домножая вклад грани на её высоту: пересекать высоко расположенную
   поверхность дорого, дно дёшево. Без взвешивания высотой у дна
   получается ПЛОСКИЙ минимум, и линия садится куда попало (на меше №3
   заезжала внутрь перегородки: 4 компоненты, 70 % в крупнейшей).

   ГЛАДКОСТЬ. Поминутный минимум в каждом срезе прыгал бы. Ищем путь
   динамическим программированием со штрафом за скачок — тот же приём,
   что в intelligent scissors. Линия выходит гладкой и следует за
   изгибом хода: на реальных данных дно уезжает по x на 2-6 мм от
   преддверия к хоане, прямая плоскость промахивается.

   РЕЗУЛЬТАТ на когорте из 10 (после доводки reattachFragments):
   ровно одна компонента на кусок у всех десяти, 99.7-100 % площади
   куска в ней. Лишние компоненты у №7, №9, №10 — изолированные острова,
   которые были в исходных мешах (8-32 грани), разрез их не создаёт.

   ОСИ. Slicer пишет в заголовке OBJ «SPACE=LPS»: x = медиолатеральная,
   y = передне-задняя, z = вертикаль. Оси не оцениваем. Для страховки
   проверяем габариты: у носового хода передне-задний размер заведомо
   наибольший (70-80 мм), медиолатеральный наименьший (22-32 мм). Если
   не так — предупреждаем и используем габаритный порядок.
*/

  /* Оси по габаритам, с проверкой на ожидаемую анатомию.
     Возвращает индексы координат { ml, ap, si }. */
  function detectAxes(fd) {
    const { fc, nF } = fd;
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let f = 0; f < nF; f++) for (let k = 0; k < 3; k++) {
      const v = fc[f * 3 + k];
      if (v < mn[k]) mn[k] = v;
      if (v > mx[k]) mx[k] = v;
    }
    const ext = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
    const ord = [0, 1, 2].sort((a, b) => ext[a] - ext[b]);
    const axes = { ml: ord[0], si: ord[1], ap: ord[2], ext, mn, mx };
    axes.lps = (axes.ml === 0 && axes.ap === 1 && axes.si === 2);
    return axes;
  }

  /* Сетка стоимости C[j][i]: площадь, приходящаяся на столбец x_i
     внутри поперечного среза y_j, с весом по высоте.
     Плюс маска allowed — где рез вообще разрешён (см. keep). */
  function costGrid(fd, ax, opt) {
    const { positions: P, fc, areas, nF } = fd;
    const nBins = opt.nBins, nCols = opt.nCols;
    const ml = ax.ml, ap = ax.ap, si = ax.si;

    let x0 = ax.mn[ml], x1 = ax.mx[ml];
    const pad = (x1 - x0) * 0.02;
    x0 -= pad; x1 += pad;
    const y0 = ax.mn[ap], y1 = ax.mx[ap];
    const colW = (x1 - x0) / nCols;
    const zmin = ax.mn[si], zr = Math.max(ax.mx[si] - ax.mn[si], 1e-9);

    const C = new Float64Array(nBins * nCols);
    const H = new Float64Array(nBins * nCols);

    for (let f = 0; f < nF; f++) {
      let j = Math.floor((fc[f * 3 + ap] - y0) / (y1 - y0 + 1e-12) * nBins);
      if (j < 0) j = 0; else if (j >= nBins) j = nBins - 1;

      // x-протяжённость грани
      const o = f * 9;
      let fmin = Infinity, fmax = -Infinity;
      for (let v = 0; v < 3; v++) {
        const xv = P[o + v * 3 + ml];
        if (xv < fmin) fmin = xv;
        if (xv > fmax) fmax = xv;
      }
      let i0 = Math.floor((fmin - x0) / colW), i1 = Math.floor((fmax - x0) / colW);
      if (i0 < 0) i0 = 0; if (i1 >= nCols) i1 = nCols - 1;
      if (i1 < i0) i1 = i0;

      const hw = 1 + opt.beta * (fc[f * 3 + si] - zmin) / zr;
      const w = areas[f] * hw / (i1 - i0 + 1);
      const base = j * nCols;
      for (let i = i0; i <= i1; i++) C[base + i] += w;

      // распределение площади по x — для запретной зоны
      let ic = Math.floor((fc[f * 3 + ml] - x0) / colW);
      if (ic < 0) ic = 0; else if (ic >= nCols) ic = nCols - 1;
      H[base + ic] += areas[f];
    }

    /* ЗАПРЕТНАЯ ЗОНА. Снаружи меша стоимость нулевая, и без ограничения
       путь минимальной стоимости просто уходит за край — первый прогон
       дал ровно это: x* = min(x), один кусок пустой. Разрешаем только
       столбцы между квантилями keep и 1−keep площадного распределения:
       рез обязан оставить с каждой стороны хотя бы долю keep площади
       среза. */
    const allowed = new Uint8Array(nBins * nCols);
    for (let j = 0; j < nBins; j++) {
      const base = j * nCols;
      let tot = 0;
      for (let i = 0; i < nCols; i++) tot += H[base + i];
      if (tot <= 0) { for (let i = 0; i < nCols; i++) allowed[base + i] = 1; continue; }
      let cum = 0;
      for (let i = 0; i < nCols; i++) {
        cum += H[base + i];
        const fr = cum / tot;
        allowed[base + i] = (fr > opt.keep && fr < 1 - opt.keep) ? 1 : 0;
      }
    }

    /* ТОЧКИ ВРАЧА. Каждая точка — пара (y, x) в мм, снятая с меша
       кликом. В её срезе разрешённым остаётся ровно один столбец, и путь
       обязан пройти через него. Всё между точками и за ними по-прежнему
       ищется автоматически: врач не рисует линию целиком, а прибивает её
       там, где автомат ошибся, обычно двумя-тремя кликами.

       Точка перекрывает запретную зону: если хирург хочет вести рез у
       самого края, это его право. */
    const pinnedBins = [];
    if (opt.pins && opt.pins.length) {
      for (const p of opt.pins) {
        let j = Math.floor((p.y - y0) / (y1 - y0 + 1e-12) * nBins);
        if (j < 0) j = 0; else if (j >= nBins) j = nBins - 1;
        let i = Math.floor((p.x - x0) / colW);
        if (i < 0) i = 0; else if (i >= nCols) i = nCols - 1;
        const base = j * nCols;
        allowed.fill(0, base, base + nCols);
        allowed[base + i] = 1;
        pinnedBins.push(j);
      }
    }
    return { C, allowed, x0, colW, y0, y1, nBins, nCols, pinnedBins };
  }

  /* Путь минимальной стоимости со штрафом lam за смещение на столбец.

     Жёсткого ограничения на скачок НЕТ намеренно. Оно было в первой
     версии как страховка, но делает точки врача недостижимыми: если
     поставленная точка отстоит от соседних срезов дальше, чем позволяет
     окно, путь до неё просто не доходит и задача становится
     невыполнимой. Штраф λ·|Δi| и так удерживает линию от прыжков, а
     решётка 48×160 просматривается целиком за единицы миллисекунд. */
  function dpPath(g, lam) {
    const { C, allowed, nBins, nCols } = g;
    const INF = Infinity;
    const D = new Float64Array(nBins * nCols).fill(INF);
    const Pr = new Int32Array(nBins * nCols);
    for (let i = 0; i < nCols; i++) D[i] = allowed[i] ? C[i] : INF;

    for (let j = 1; j < nBins; j++) {
      const cur = j * nCols, prev = (j - 1) * nCols;
      for (let i = 0; i < nCols; i++) {
        if (!allowed[cur + i]) { D[cur + i] = INF; continue; }
        let best = INF, arg = i;
        for (let k = 0; k < nCols; k++) {
          const v = D[prev + k];
          if (v === INF) continue;
          const c = v + lam * Math.abs(k - i);
          if (c < best) { best = c; arg = k; }
        }
        D[cur + i] = best === INF ? INF : C[cur + i] + best;
        Pr[cur + i] = arg;
      }
    }
    const last = (nBins - 1) * nCols;
    let bi = 0, bv = INF;
    for (let i = 0; i < nCols; i++) if (D[last + i] < bv) { bv = D[last + i]; bi = i; }
    const path = new Int32Array(nBins);
    path[nBins - 1] = bi;
    for (let j = nBins - 1; j > 0; j--) path[j - 1] = Pr[j * nCols + path[j]];
    return path;
  }

  /* Мелкие отколовшиеся компоненты возвращаем соседнему куску.

     После DP-реза 8 мешей из 10 дают ровно по одной компоненте на кусок,
     но на №2 и №7 отслаивается кусочек в 3-4 % площади — обычно кончик
     раковины у самого реза. Человек отнёс бы его к соседней стенке;
     делаем то же. Компоненты без соседей за пределами себя
     (изолированные острова самого меша) не трогаем: перекидывать их
     некуда.

     Порог 55 % от площади главной компоненты. В автоматическом режиме
     он не срабатывает никогда — там и так одна компонента на кусок, — но
     когда врач ставит точки, линия может пойти так, что отслоится
     заметный кусок; лучше присоединить его к соседу, чем показать
     плавающим. */
  function reattachFragments(fd, side, maxFrac) {
    const { nF, nbrOff, nbrIdx, areas } = fd;
    maxFrac = maxFrac == null ? 0.55 : maxFrac;
    const comp = new Int32Array(nF);
    const queue = new Int32Array(nF);

    for (let pass = 0; pass < 4; pass++) {
      comp.fill(-1);
      const compArea = [], compPiece = [], compHasOut = [];
      let nc = 0;
      for (let s = 0; s < nF; s++) {
        if (comp[s] !== -1) continue;
        const p = side[s];
        let head = 0, tail = 0, a = 0, hasOut = false;
        queue[tail++] = s; comp[s] = nc;
        while (head < tail) {
          const f = queue[head++];
          a += areas[f];
          for (let k = nbrOff[f]; k < nbrOff[f + 1]; k++) {
            const g = nbrIdx[k];
            if (side[g] !== p) { hasOut = true; continue; }
            if (comp[g] !== -1) continue;
            comp[g] = nc; queue[tail++] = g;
          }
        }
        compArea.push(a); compPiece.push(p); compHasOut.push(hasOut); nc++;
      }
      const big = [0, 0];
      for (let c = 0; c < nc; c++) if (compArea[c] > big[compPiece[c]]) big[compPiece[c]] = compArea[c];
      const flip = new Uint8Array(nc);
      let changed = false;
      for (let c = 0; c < nc; c++) {
        if (compArea[c] >= big[compPiece[c]]) continue;
        if (compArea[c] > maxFrac * big[compPiece[c]]) continue;
        if (!compHasOut[c]) continue;
        flip[c] = 1; changed = true;
      }
      if (!changed) break;
      for (let f = 0; f < nF; f++) if (flip[comp[f]]) side[f] = 1 - side[f];
    }
    return side;
  }

  /* Главная функция. biasMM сдвигает линию реза медиально/латерально. */
  function floorCut(fd, opts) {
    opts = opts || {};
    const opt = {
      nBins: opts.nBins != null ? opts.nBins : 48,
      nCols: opts.nCols != null ? opts.nCols : 160,
      keep:  opts.keep  != null ? opts.keep  : 0.12,
      beta:  opts.beta  != null ? opts.beta  : 3.0,
      smooth: opts.smooth != null ? opts.smooth : 2,
      pins:  opts.pins || [],
    };
    const ax = detectAxes(fd);
    const g = costGrid(fd, ax, opt);

    // λ от масштаба стоимости — чтобы не зависеть от размера меша
    const nz = [];
    for (let i = 0; i < g.C.length; i++) if (g.C[i] > 0) nz.push(g.C[i]);
    nz.sort((a, b) => a - b);
    const med = nz.length ? nz[nz.length >> 1] : 1;
    const lam = opts.lam != null ? opts.lam : 0.35 * med;
    const path = dpPath(g, lam);
    let xstar = new Float64Array(g.nBins);
    for (let j = 0; j < g.nBins; j++) xstar[j] = g.x0 + (path[j] + 0.5) * g.colW;

    if (opt.smooth > 0) {
      const w = opt.smooth, out = new Float64Array(g.nBins);
      for (let j = 0; j < g.nBins; j++) {
        let acc = 0, n = 0;
        for (let k = -w; k <= w; k++) {
          const q = Math.min(g.nBins - 1, Math.max(0, j + k));
          acc += xstar[q]; n++;
        }
        out[j] = acc / n;
      }
      xstar = out;
    }

    /* ТОЧНОЕ ПОПАДАНИЕ В ТОЧКИ ВРАЧА.

       Прибить столбец в срезе мало: сглаживание уводит соседей, а
       computeSideFloor берёт линию интерполяцией МЕЖДУ срезами. В сумме
       линия проходила мимо клика на 0.5-1.1 мм — для дна шириной 15 мм
       терпимо, но врач ставит точку не «примерно там».

       Поэтому после сглаживания измеряем невязку в самой точке и
       гасим её треугольным ядром по соседним срезам. Два прохода —
       на случай, когда точки стоят рядом и влияют друг на друга. */
    const R = 2;
    for (let it = 0; it < 2 && opt.pins.length; it++) {
      for (const p of opt.pins) {
        const t = clampT((p.y - g.y0) / ((g.y1 - g.y0) / g.nBins) - 0.5, g.nBins);
        const j = Math.min(g.nBins - 2, Math.floor(t)), u = t - j;
        const cur = xstar[j] * (1 - u) + xstar[j + 1] * u;
        const err = p.x - cur;
        if (Math.abs(err) < 1e-9) continue;
        for (let k = -R; k <= R; k++) {
          const q = j + k;
          if (q < 0 || q >= g.nBins) continue;
          xstar[q] += err * Math.max(0, 1 - Math.abs(k - u) / (R + 1));
        }
      }
    }

    return { xstar, axes: ax, y0: g.y0, y1: g.y1, nBins: g.nBins, lam,
             pins: opt.pins };
  }

  const clampT = (t, n) => (t < 0 ? 0 : (t > n - 1 ? n - 1 : t));

  /* Разбиение по линии. biasMM > 0 двигает рез в сторону +ML. */
  function computeSideFloor(fd, cut, biasMM) {
    const { fc, nF } = fd;
    const { xstar, axes, y0, y1, nBins } = cut;
    const b = biasMM || 0;
    const side = new Uint8Array(nF);
    const step = (y1 - y0) / nBins;
    for (let f = 0; f < nF; f++) {
      const y = fc[f * 3 + axes.ap];
      const t = clampT((y - y0) / step - 0.5, nBins);
      const j = Math.min(nBins - 2, Math.floor(t));
      const u = t - j;
      const xc = xstar[j] * (1 - u) + xstar[j + 1] * u + b;
      side[f] = fc[f * 3 + axes.ml] < xc ? 0 : 1;
    }
    return side;
  }

  // ═══════════════════════════════════════════════════════════

  /* Точка из клика: берём центроид грани и проецируем на анатомические
     оси. Возвращает { y, x, fx, fy, fz } — последние три для маркера. */
  function pinFromFace(fd, cut, faceIdx) {
    const ax = cut.axes, fc = fd.fc;
    return {
      y:  fc[faceIdx * 3 + ax.ap],
      x:  fc[faceIdx * 3 + ax.ml],
      fx: fc[faceIdx * 3],
      fy: fc[faceIdx * 3 + 1],
      fz: fc[faceIdx * 3 + 2],
    };
  }

  /* Индекс ближайшей точки по срезу (для удаления повторным кликом),
     либо −1. tol — допуск в мм вдоль хода. */
  function findPin(pins, pin, tolMM) {
    const tol = tolMM == null ? 3.0 : tolMM;
    let best = -1, bd = Infinity;
    for (let k = 0; k < pins.length; k++) {
      const d = Math.abs(pins[k].y - pin.y);
      if (d < tol && d < bd) { bd = d; best = k; }
    }
    return best;
  }

  // ═══════════════════════════════════════════════════════════
  //  РЕЗ ПО НАРИСОВАННОЙ ЛИНИИ
  // ═══════════════════════════════════════════════════════════

  /* Врач проводит линию мышкой; она рассекает меш НАСКВОЗЬ вдоль
     направления взгляда — как нож. Грань уходит в тот кусок, в чьей
     половине экрана оказался её центроид.

     ПОЧЕМУ ТАК, А НЕ АВТОМАТИЧЕСКИ. На когорте из 10 перебрано четыре
     автоматических критерия (плоскость по минимуму рассечённой площади,
     плоскость по балансу половин, кривая по просвету, рез по касанию с
     разделением вдоль поверхности). Ни один не берёт оба требования
     сразу: те, что дают доступ кистью, разрезают перегородку вдоль;
     те, что оставляют перегородку целой, доступа не дают (11-19 %
     закрытой площади против 13-18 % вообще без разреза). Причина не в
     стоимости, а в постановке: секущая ПОВЕРХНОСТЬ обязана пройти меш
     насквозь, а перегородка сама поверхность, вертикальная и во всю
     высоту, — они неизбежно пересекаются длинной полосой.

     Нарисованная линия эту развилку убирает: где резать, решает врач,
     а не критерий. Правильный рез, по его словам, идёт по воздушному
     просвету, пересекая ткань только на дне и в месте касания
     перегородки со стенкой — нарисовать такую линию тривиально,
     угадать формулой не получилось.

     РЕАЛИЗАЦИЯ. Экранная ломаная делит канвас надвое; принадлежность
     точки определяем чётностью пересечений луча влево. Ломаная
     продлевается за края канваса, иначе у концов деление не определено.
     Ничего не проецируется обратно в 3D: рез «сквозной» по построению,
     поэтому оба листа кармана рассекаются одинаково — что и нужно,
     чтобы куски реально разошлись.                                    */

  /* proj — Float32Array(nF*2), экранные координаты центроидов граней.
     poly — [[x,y], …] ломаная в тех же координатах. */
  function sideFromPolyline(fd, proj, poly) {
    const nF = fd.nF;
    const side = new Uint8Array(nF);
    if (!poly || poly.length < 2) return side;

    // продлеваем концы далеко за пределы канваса
    const EXT = 1e5;
    const p = poly.slice();
    const dx0 = p[0][0] - p[1][0], dy0 = p[0][1] - p[1][1];
    const l0 = Math.hypot(dx0, dy0) || 1;
    p.unshift([p[0][0] + dx0 / l0 * EXT, p[0][1] + dy0 / l0 * EXT]);
    const n = p.length;
    const dx1 = p[n-1][0] - p[n-2][0], dy1 = p[n-1][1] - p[n-2][1];
    const l1 = Math.hypot(dx1, dy1) || 1;
    p.push([p[n-1][0] + dx1 / l1 * EXT, p[n-1][1] + dy1 / l1 * EXT]);

    const m = p.length;
    for (let f = 0; f < nF; f++) {
      const x = proj[f * 2], y = proj[f * 2 + 1];
      let cross = 0;
      for (let k = 0; k + 1 < m; k++) {
        const ax = p[k][0], ay = p[k][1], bx = p[k+1][0], by = p[k+1][1];
        // луч влево от точки: считаем пересечения с отрезком
        if ((ay > y) === (by > y)) continue;
        const t = (y - ay) / (by - ay);
        if (ax + t * (bx - ax) < x) cross++;
      }
      side[f] = (cross & 1) ? 1 : 0;
    }
    return side;
  }

  /* Пересборка кусков под нарисованную линию. */
  function resplitPolyline(split, fd, proj, poly, THREE, scene) {
    const prevActive = split.active, prevVis = split.visibility;
    detach(split, scene);
    disposeGeom(split);
    let side = sideFromPolyline(fd, proj, poly);
    side = reattachFragments(fd, side, 0.06);   // линию рисует врач — не переигрываем
    const bp = buildPieces(fd, side);
    split.side       = side;
    split.seam       = computeSeam(fd, side);
    split.seamAxis   = seamAxis(fd, split.seam);
    split.orig2local = bp.orig2local;
    split.pieces     = bp.pieces;
    split.active     = prevActive;
    split.visibility = prevVis;
    if (THREE) buildMeshes(THREE, split);
    applyVisibility(split);
    if (scene) attach(split, scene);
    return split;
  }

  global.MeshSplit = {
    makePlane, autoPlane, offsetPlane, planeRange, principalAxes,
    computeSide, computeSideMedial, medialField, resplitMedial,
    floorCut, computeSideFloor, reattachFragments, resplitFloor, detectAxes,
    sideFromPolyline, resplitPolyline,
    pinFromFace, findPin,
    buildPieces, computeSeam, seamAxis,
    create, resplit, attach, detach, dispose,
    setVisibility, setActive, applyVisibility, pickTargets, pick,
    syncColors, syncColorsWithSeam, previewCut,
    seamReport, stitchSeam,
    focusPose,
    GHOST_OPACITY,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.MeshSplit;

})(typeof window !== 'undefined' ? window : globalThis);
