/* ─── saddle-seg.js ────────────────────────────────────────────────────
   Автоматическая сегментация «седла» одного носового хода на 3 зоны:
       0 — septum      (перегородка)
       1 — floor       (дно)
       2 — lateral     (латеральная стенка)

   Идея та же, что в saddle_seg.py (эталон валидирован на 6 размеченных
   мешах: area-weighted accuracy ≈ 0.966 в среднем, 0 прямых рёбер
   septum↔lateral).

   ИСПОЛЬЗОВАНИЕ:
       var result = SaddleSeg.computeLabels({
         vertices: Float32Array,   // [x,y,z, x,y,z, ...]
         faces:    Int32Array,     // [a,b,c, a,b,c, ...]
       });
       // result.labels      — Uint8Array длины nFaces, значения 0/1/2
       // result.eML, eUP, eAP — оси в виде [x,y,z]
       // result.faceCenters, result.faceNormals, result.faceAreas, result.adjacency
       //     — промежуточные массивы; если уже посчитаны снаружи, можно
       //       передать их через options

   Параметры (все опциональны):
       positionWeight   — вес позиционного приора (по умолчанию 1.5).
       smoothingIters   — итераций сглаживания соседями (по умолчанию 3).
       speckleFrac      — порог «спекла» относительно площади класса (0.01).

────────────────────────────────────────────────────────────────────────── */

(function (global) {
  'use strict';

  var LABELS = ['septum', 'floor', 'lateral'];
  var SEP = 0, FLR = 1, LAT = 2;


  function computeFaceAttrs(verts, faces) {
    var nF = (faces.length / 3) | 0;
    var C = new Float32Array(nF * 3);
    var N = new Float32Array(nF * 3);
    var A = new Float32Array(nF);
    for (var f = 0; f < nF; f++) {
      var i0 = faces[f * 3],
          i1 = faces[f * 3 + 1],
          i2 = faces[f * 3 + 2];
      var ax = verts[i0 * 3],     ay = verts[i0 * 3 + 1], az = verts[i0 * 3 + 2];
      var bx = verts[i1 * 3],     by = verts[i1 * 3 + 1], bz = verts[i1 * 3 + 2];
      var cx = verts[i2 * 3],     cy = verts[i2 * 3 + 1], cz = verts[i2 * 3 + 2];
      C[f * 3]     = (ax + bx + cx) / 3;
      C[f * 3 + 1] = (ay + by + cy) / 3;
      C[f * 3 + 2] = (az + bz + cz) / 3;
      var ex = bx - ax, ey = by - ay, ez = bz - az;
      var fx = cx - ax, fy = cy - ay, fz = cz - az;
      var nx = ey * fz - ez * fy;
      var ny = ez * fx - ex * fz;
      var nz = ex * fy - ey * fx;
      var nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      A[f] = nl * 0.5;
      if (nl > 1e-12) {
        N[f * 3]     = nx / nl;
        N[f * 3 + 1] = ny / nl;
        N[f * 3 + 2] = nz / nl;
      }
    }
    return { centers: C, normals: N, areas: A };
  }

  function buildAdjacency(faces, nF) {
    // Граф смежности граней: рёбра, разделённые ровно двумя гранями.
    var edgeMap = new Map();
    for (var f = 0; f < nF; f++) {
      var a = faces[f * 3], b = faces[f * 3 + 1], c = faces[f * 3 + 2];
      var edges = [[a, b], [b, c], [c, a]];
      for (var i = 0; i < 3; i++) {
        var u = edges[i][0], v = edges[i][1];
        var key = u < v ? u + '_' + v : v + '_' + u;
        var arr = edgeMap.get(key);
        if (!arr) { arr = []; edgeMap.set(key, arr); }
        arr.push(f);
      }
    }
    var adj = new Array(nF);
    for (var ii = 0; ii < nF; ii++) adj[ii] = [];
    edgeMap.forEach(function (flist) {
      if (flist.length === 2) {
        adj[flist[0]].push(flist[1]);
        adj[flist[1]].push(flist[0]);
      }
    });
    for (var j = 0; j < nF; j++) adj[j] = new Int32Array(adj[j]);
    return adj;
  }



  // Собственные векторы симметричной 3×3 матрицы через Якоби.
  // Возвращает { evals: [3], evecs: [[3],[3],[3]] } — отсортировано
  // по возрастанию собственных значений.
  function eigSym3(M) {
    // копия, на месте будем зануливать off-diagonal
    var a = [
      [M[0][0], M[0][1], M[0][2]],
      [M[1][0], M[1][1], M[1][2]],
      [M[2][0], M[2][1], M[2][2]]
    ];
    var V = [[1,0,0],[0,1,0],[0,0,1]];
    for (var sweep = 0; sweep < 50; sweep++) {
      var off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
      if (off < 1e-14) break;
      // по всем внедиагональным
      for (var p = 0; p < 2; p++) {
        for (var q = p + 1; q < 3; q++) {
          var apq = a[p][q];
          if (Math.abs(apq) < 1e-18) continue;
          var app = a[p][p], aqq = a[q][q];
          var theta = (aqq - app) / (2 * apq);
          var t;
          if (Math.abs(theta) > 1e15) {
            t = 1 / (2 * theta);
          } else {
            t = (theta >= 0 ? 1 : -1) /
                (Math.abs(theta) + Math.sqrt(theta * theta + 1));
          }
          var c = 1 / Math.sqrt(t * t + 1);
          var s = t * c;
          // обновляем a
          a[p][p] = app - t * apq;
          a[q][q] = aqq + t * apq;
          a[p][q] = a[q][p] = 0;
          for (var r = 0; r < 3; r++) {
            if (r !== p && r !== q) {
              var arp = a[r][p], arq = a[r][q];
              a[r][p] = a[p][r] = c * arp - s * arq;
              a[r][q] = a[q][r] = s * arp + c * arq;
            }
          }
          for (var k = 0; k < 3; k++) {
            var vkp = V[k][p], vkq = V[k][q];
            V[k][p] = c * vkp - s * vkq;
            V[k][q] = s * vkp + c * vkq;
          }
        }
      }
    }
    var evals = [a[0][0], a[1][1], a[2][2]];
    var evecs = [
      [V[0][0], V[1][0], V[2][0]],
      [V[0][1], V[1][1], V[2][1]],
      [V[0][2], V[1][2], V[2][2]]
    ];
    // сортируем по возрастанию
    var order = [0, 1, 2].sort(function (x, y) { return evals[x] - evals[y]; });
    return {
      evals: order.map(function (i) { return evals[i]; }),
      evecs: order.map(function (i) { return evecs[i]; })
    };
  }

  // ──────────────────────── оси каркаса ────────────────────────────

  function estimateFrame(normals, areas) {
    var nF = areas.length;
    // M = Σ aᵢ nᵢ nᵢᵀ (симметричная 3×3)
    var M = [[0,0,0],[0,0,0],[0,0,0]];
    for (var f = 0; f < nF; f++) {
      var a = areas[f];
      var nx = normals[f * 3], ny = normals[f * 3 + 1], nz = normals[f * 3 + 2];
      M[0][0] += a * nx * nx; M[0][1] += a * nx * ny; M[0][2] += a * nx * nz;
      M[1][1] += a * ny * ny; M[1][2] += a * ny * nz;
      M[2][2] += a * nz * nz;
    }
    M[1][0] = M[0][1]; M[2][0] = M[0][2]; M[2][1] = M[1][2];

    var e = eigSym3(M);          // evals по возрастанию
    var eML = e.evecs[2];        // λ_max → ML
    var eUP = e.evecs[1];        // средний → UP
    var eAP = e.evecs[0];        // λ_min → AP

    // ─ знак ê_ML: положительный кластер нормалей должен иметь большую площадь
    //    (перегородка — крупнейшая зона; её нормали сонаправлены с +ê_ML).
    var aPos = 0, aNeg = 0;
    for (var k = 0; k < nF; k++) {
      var d = normals[k*3]*eML[0] + normals[k*3+1]*eML[1] + normals[k*3+2]*eML[2];
      if (d > 0) aPos += areas[k];
      else if (d < 0) aNeg += areas[k];
    }
    if (aPos < aNeg) {
      eML = [-eML[0], -eML[1], -eML[2]];
    }

    // ─ знак ê_UP: суммарный area-weighted (n·ê_UP) должен быть положителен
    //    (нормали дна смотрят «вверх»).
    var fluxUp = 0;
    for (var kk = 0; kk < nF; kk++) {
      var du = normals[kk*3]*eUP[0] + normals[kk*3+1]*eUP[1] + normals[kk*3+2]*eUP[2];
      fluxUp += areas[kk] * du;
    }
    if (fluxUp < 0) {
      eUP = [-eUP[0], -eUP[1], -eUP[2]];
    }

    // ê_AP = ê_ML × ê_UP — чтобы тройка была правая и строго ортогональна.
    eAP = cross(eML, eUP);
    eUP = cross(eAP, eML);
    eML = normalize(eML);
    eUP = normalize(eUP);
    eAP = normalize(eAP);
    return { eML: eML, eUP: eUP, eAP: eAP };
  }

  function cross(a, b) {
    return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  }
  function normalize(v) {
    var l = Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]) || 1;
    return [v[0]/l, v[1]/l, v[2]/l];
  }

  // ──────────────────── скор грани по 3 классам ────────────────────
  //
  // Позиция — главный сигнал, нормаль — множитель доверия.
  //
  //     pos_floor = max(0, 1 − t_up / floor_band)²     (0 выше floor_band)
  //     φ_flr     = pos_floor × ((1 − w_F) + w_F · max(0, n·ê_UP))
  //     φ_sep     = max(0, −t_ml) × ((1 − w_W) + w_W · max(0,  n·ê_ML))
  //     φ_lat     = max(0, +t_ml) × ((1 − w_W) + w_W · max(0, −n·ê_ML))
  //
  function computeScores(centers, normals, areas, eML, eUP,
                         floorBand, floorNormalWeight, wallNormalWeight) {
    var nF = areas.length;
    var nmlArr = new Float32Array(nF), nupArr = new Float32Array(nF);
    var cmlArr = new Float32Array(nF), cupArr = new Float32Array(nF);
    for (var f = 0; f < nF; f++) {
      nmlArr[f] = normals[f*3]*eML[0] + normals[f*3+1]*eML[1] + normals[f*3+2]*eML[2];
      nupArr[f] = normals[f*3]*eUP[0] + normals[f*3+1]*eUP[1] + normals[f*3+2]*eUP[2];
      cmlArr[f] = centers[f*3]*eML[0] + centers[f*3+1]*eML[1] + centers[f*3+2]*eML[2];
      cupArr[f] = centers[f*3]*eUP[0] + centers[f*3+1]*eUP[1] + centers[f*3+2]*eUP[2];
    }

    // Робастные шкалы
    function quantile2_98(arr) {
      var s = Array.prototype.slice.call(arr).sort(function(a,b){return a-b;});
      return [s[Math.floor(0.02*(s.length-1))], s[Math.floor(0.98*(s.length-1))]];
    }
    var mlQ = quantile2_98(cmlArr);
    var upQ = quantile2_98(cupArr);
    var mlMid = 0.5 * (mlQ[0] + mlQ[1]);
    var mlHalf = Math.max(1e-9, 0.5 * (mlQ[1] - mlQ[0]));
    var upLo = upQ[0];
    var upSpan = Math.max(1e-9, upQ[1] - upQ[0]);

    var wF = floorNormalWeight;
    var wW = wallNormalWeight;

    var scores = new Float32Array(nF * 3);
    for (var ff = 0; ff < nF; ff++) {
      var tml = (cmlArr[ff] - mlMid) / mlHalf;
      if (tml > 1) tml = 1; else if (tml < -1) tml = -1;
      var tup = (cupArr[ff] - upLo) / upSpan;

      var posFloorRaw = 1 - tup / floorBand;
      var posFloor = posFloorRaw > 0 ? posFloorRaw * posFloorRaw : 0;
      if (posFloor > 1) posFloor = 1;
      var posSep = tml < 0 ? -tml : 0;
      var posLat = tml > 0 ?  tml : 0;

      var nml = nmlArr[ff], nup = nupArr[ff];
      var nrmF = nup > 0 ? nup : 0;
      var nrmS = nml > 0 ? nml : 0;
      var nrmL = nml < 0 ? -nml : 0;

      scores[ff*3]     = posSep   * ((1 - wW) + wW * nrmS);  // SEP
      scores[ff*3 + 1] = posFloor * ((1 - wF) + wF * nrmF);  // FLR
      scores[ff*3 + 2] = posLat   * ((1 - wW) + wW * nrmL);  // LAT
    }
    return scores;
  }

  function argmaxScore(scores, f) {
    var a = scores[f*3], b = scores[f*3+1], c = scores[f*3+2];
    if (a >= b && a >= c) return SEP;
    if (b >= c) return FLR;
    return LAT;
  }

  // ───────────── сглаживание: голосование рёберных соседей ─────────
  //
  // neighborWeights[f] — Float32Array той же длины, что adj[f]: вес голоса
  //   i-го соседа грани f. Если не передан — считаем все веса = 1.
  // Веса < 1 (например на рёбрах-гребнях) ослабляют переток меток через
  // анатомический излом.
  function neighborSmoothing(labels, scores, adj, nF, iters, neighborWeights) {
    var out = new Uint8Array(labels);
    var votes = new Float32Array(nF * 3);
    var haveW = !!neighborWeights;
    for (var it = 0; it < iters; it++) {
      votes.fill(0);
      for (var f = 0; f < nF; f++) {
        var nn = adj[f];
        var ww = haveW ? neighborWeights[f] : null;
        for (var i = 0; i < nn.length; i++) {
          var w = ww ? ww[i] : 1;
          votes[f*3 + out[nn[i]]] += w;
        }
      }
      for (var g = 0; g < nF; g++) {
        var own = votes[g*3 + out[g]];
        var v0 = votes[g*3], v1 = votes[g*3+1], v2 = votes[g*3+2];
        var best = 0, bestCount = v0;
        if (v1 > bestCount) { best = 1; bestCount = v1; }
        if (v2 > bestCount) { best = 2; bestCount = v2; }
        if (best !== out[g] && bestCount > own + 1e-6 && scores[g*3 + best] > 0) {
          out[g] = best;
        }
      }
    }
    return out;
  }

  // Взвешивание рёбер по диэдральному углу: 1 для плавных, → 0 для гребней.
  // Возвращает neighborWeights — массив Float32Array, параллельный adj.
  function buildCreaseWeights(adj, faces, normals, nF, creaseAngleDeg) {
    if (!creaseAngleDeg || creaseAngleDeg <= 0) return null;
    var t0 = creaseAngleDeg;
    var nw = new Array(nF);
    for (var f = 0; f < nF; f++) {
      var nn = adj[f];
      var w = new Float32Array(nn.length);
      var nxF = normals[f*3], nyF = normals[f*3+1], nzF = normals[f*3+2];
      for (var i = 0; i < nn.length; i++) {
        var g = nn[i];
        var dot = nxF*normals[g*3] + nyF*normals[g*3+1] + nzF*normals[g*3+2];
        if (dot > 1) dot = 1; else if (dot < -1) dot = -1;
        var theta = Math.acos(dot) * (180 / Math.PI);
        var excess = theta - t0;
        if (excess < 0) excess = 0;
        var wi = 1 - excess / t0;
        if (wi < 0) wi = 0; else if (wi > 1) wi = 1;
        w[i] = wi;
      }
      nw[f] = w;
    }
    return nw;
  }

  // ───────────── удаление «спеклов» + BFS переназначение ───────────

  function removeSpeckles(labels, adj, areas, nF, fracThreshold) {
    var out = new Uint8Array(labels);
    var spurious = new Uint8Array(nF);
    var seen = new Uint8Array(nF);
    for (var k = 0; k < 3; k++) {
      // общая площадь класса
      var totalArea = 0;
      for (var i = 0; i < nF; i++) if (out[i] === k) totalArea += areas[i];
      if (totalArea <= 0) continue;
      var thr = fracThreshold * totalArea;
      seen.fill(0);
      for (var s = 0; s < nF; s++) {
        if (out[s] !== k || seen[s]) continue;
        var comp = [];
        var stack = [s];
        seen[s] = 1;
        var compArea = 0;
        while (stack.length) {
          var u = stack.pop();
          comp.push(u); compArea += areas[u];
          var nn = adj[u];
          for (var j = 0; j < nn.length; j++) {
            var v = nn[j];
            if (out[v] === k && !seen[v]) { seen[v] = 1; stack.push(v); }
          }
        }
        if (compArea < thr) {
          for (var c = 0; c < comp.length; c++) spurious[comp[c]] = 1;
        }
      }
    }
    if (!spurious.some(function(x){ return x; })) return out;
    // BFS от не-спеклов
    var INF = 0x7fffffff;
    var dist = new Int32Array(nF); for (var q = 0; q < nF; q++) dist[q] = INF;
    var queue = [];
    for (var f = 0; f < nF; f++) if (!spurious[f]) { dist[f] = 0; queue.push(f); }
    var head = 0;
    while (head < queue.length) {
      var x = queue[head++];
      var nx = adj[x];
      for (var jj = 0; jj < nx.length; jj++) {
        var y = nx[jj];
        if (dist[y] > dist[x] + 1) {
          dist[y] = dist[x] + 1;
          out[y] = out[x];
          queue.push(y);
        }
      }
    }
    return out;
  }

  // ───────────── топология: septum и lateral не соприкасаются ──────

  function enforceTopology(labels, scores, adj, nF) {
    var out = new Uint8Array(labels);
    for (var iter = 0; iter < 8; iter++) {
      var problems = [];
      // собираем все проблемные рёбра
      for (var f = 0; f < nF; f++) {
        var nn = adj[f];
        for (var k = 0; k < nn.length; k++) {
          var g = nn[k];
          if (g < f) continue;  // каждое ребро один раз
          if ((out[f] === SEP && out[g] === LAT) || (out[f] === LAT && out[g] === SEP)) {
            problems.push([f, g]);
          }
        }
      }
      if (problems.length === 0) break;
      var pickSet = new Uint8Array(nF);
      for (var p = 0; p < problems.length; p++) {
        var fi = problems[p][0], fj = problems[p][1];
        var confI = scores[fi*3 + out[fi]];
        var confJ = scores[fj*3 + out[fj]];
        var pick = (confI <= confJ) ? fi : fj;
        pickSet[pick] = 1;
      }
      for (var u = 0; u < nF; u++) if (pickSet[u]) out[u] = FLR;
    }
    return out;
  }

  // ───────────── пол — одна непрерывная полоса между sep и lat ─────
  //
  // Оставляем: главную по площади компоненту floor + все компоненты,
  // одновременно касающиеся SEP и LAT (это мосты, в том числе созданные
  // enforceTopology). Остальные (острова floor внутри одной стены)
  // переназначаются в ближайший wall: сначала BFS по графу смежности,
  // для недостижимых — ближайшая по центроиду.
  //
  function keepLargestFloor(labels, adj, areas, nF, centers) {
    // Компоненты FLR
    var comp = new Int32Array(nF);
    for (var z = 0; z < nF; z++) comp[z] = -1;
    var cid = 0;
    for (var seed = 0; seed < nF; seed++) {
      if (labels[seed] !== FLR || comp[seed] !== -1) continue;
      var stack = [seed];
      comp[seed] = cid;
      while (stack.length) {
        var u = stack.pop();
        var nn = adj[u];
        for (var k = 0; k < nn.length; k++) {
          var v = nn[k];
          if (labels[v] === FLR && comp[v] === -1) {
            comp[v] = cid;
            stack.push(v);
          }
        }
      }
      cid++;
    }
    if (cid <= 1) return new Uint8Array(labels);

    // Площадь + касания
    var areaC = new Float64Array(cid);
    var touchSep = new Uint8Array(cid);
    var touchLat = new Uint8Array(cid);
    for (var f = 0; f < nF; f++) {
      if (comp[f] < 0) continue;
      var c = comp[f];
      areaC[c] += areas[f];
      var nn2 = adj[f];
      for (var ii = 0; ii < nn2.length; ii++) {
        var lab = labels[nn2[ii]];
        if (lab === SEP) touchSep[c] = 1;
        else if (lab === LAT) touchLat[c] = 1;
      }
    }

    // largest по площади
    var largest = 0;
    for (var cc = 1; cc < cid; cc++) if (areaC[cc] > areaC[largest]) largest = cc;

    var keep = new Uint8Array(cid);
    keep[largest] = 1;
    for (var cj = 0; cj < cid; cj++) {
      if (touchSep[cj] && touchLat[cj]) keep[cj] = 1;
    }

    var out = new Uint8Array(labels);
    // reassign: сначала BFS от sep/lat
    var INF2 = 0x7fffffff;
    var dist = new Int32Array(nF);
    var src  = new Int8Array(nF);
    for (var p = 0; p < nF; p++) { dist[p] = INF2; src[p] = -1; }
    var q3 = [];
    for (var s3 = 0; s3 < nF; s3++) {
      if (out[s3] === SEP) { dist[s3] = 0; src[s3] = SEP; q3.push(s3); }
      else if (out[s3] === LAT) { dist[s3] = 0; src[s3] = LAT; q3.push(s3); }
    }
    var head3 = 0;
    while (head3 < q3.length) {
      var x = q3[head3++];
      var nx = adj[x];
      for (var m = 0; m < nx.length; m++) {
        var y = nx[m];
        if (dist[y] > dist[x] + 1) {
          dist[y] = dist[x] + 1;
          src[y]  = src[x];
          q3.push(y);
        }
      }
    }

    // Список изолированных, которые не достигнуты BFS
    var isolated = [];
    for (var t = 0; t < nF; t++) {
      if (labels[t] === FLR && comp[t] >= 0 && !keep[comp[t]]) {
        if (src[t] !== -1) out[t] = src[t];
        else               isolated.push(t);
      }
    }
    // Евклидов fallback для изолированных
    if (isolated.length && centers) {
      // Собираем список wall-граней
      var wallList = [];
      for (var w = 0; w < nF; w++) {
        if (out[w] === SEP || out[w] === LAT) wallList.push(w);
      }
      if (wallList.length) {
        for (var ii2 = 0; ii2 < isolated.length; ii2++) {
          var fi = isolated[ii2];
          var cx = centers[fi*3], cy = centers[fi*3+1], cz = centers[fi*3+2];
          var best = wallList[0], bestD = Infinity;
          for (var jj = 0; jj < wallList.length; jj++) {
            var wi = wallList[jj];
            var dx = centers[wi*3] - cx;
            var dy = centers[wi*3+1] - cy;
            var dz = centers[wi*3+2] - cz;
            var dd = dx*dx + dy*dy + dz*dz;
            if (dd < bestD) { bestD = dd; best = wi; }
          }
          out[fi] = out[best];
        }
      }
    }
    return out;
  }


  // ─────────────── разбиение sep/lat по связным компонентам ────────
  //
  // перегородка и латеральная стенка физически
  // разделены полом, поэтому non-floor грани распадаются на 2 больших
  // связных куска. Сопоставляем метку по среднему c·ê_ML (меньшее =
  // перегородка). Это защищает от «утечки» метки через выпуклости.
  //
  function componentsToLabels(init, centers, areas, eML, adj, nF) {
    var floorMask = new Uint8Array(nF);
    for (var a = 0; a < nF; a++) floorMask[a] = (init[a] === FLR) ? 1 : 0;

    // Connected components среди wall-граней
    var comp = new Int32Array(nF);
    for (var z = 0; z < nF; z++) comp[z] = -1;
    var cid = 0;
    for (var seed = 0; seed < nF; seed++) {
      if (floorMask[seed] || comp[seed] !== -1) continue;
      var stack = [seed];
      comp[seed] = cid;
      while (stack.length) {
        var u = stack.pop();
        var nn = adj[u];
        for (var k = 0; k < nn.length; k++) {
          var v = nn[k];
          if (!floorMask[v] && comp[v] === -1) {
            comp[v] = cid;
            stack.push(v);
          }
        }
      }
      cid++;
    }

    if (cid === 0) return new Uint8Array(init);   // всё — пол

    // Площади компонент
    var areaC = new Float64Array(cid);
    for (var b = 0; b < nF; b++) {
      if (comp[b] >= 0) areaC[comp[b]] += areas[b];
    }

    // Две крупнейшие по площади
    var order = new Int32Array(cid);
    for (var i = 0; i < cid; i++) order[i] = i;
    // сортировка по убыванию
    var orderArr = Array.prototype.slice.call(order);
    orderArr.sort(function(x, y) { return areaC[y] - areaC[x]; });

    // Fallback: одна крупная компонента (пол не отсекает стены)
    if (cid === 1 || areaC[orderArr[1]] / Math.max(areaC[orderArr[0]], 1e-9) < 0.03) {
      return new Uint8Array(init);
    }

    // Какая из топ-2 компонент — перегородка (меньшее среднее c·ê_ML)
    var c0 = orderArr[0], c1 = orderArr[1];
    var sum0 = 0, cnt0 = 0, sum1 = 0, cnt1 = 0;
    for (var g = 0; g < nF; g++) {
      if (comp[g] === c0) {
        sum0 += centers[g*3]*eML[0] + centers[g*3+1]*eML[1] + centers[g*3+2]*eML[2];
        cnt0++;
      } else if (comp[g] === c1) {
        sum1 += centers[g*3]*eML[0] + centers[g*3+1]*eML[1] + centers[g*3+2]*eML[2];
        cnt1++;
      }
    }
    var mean0 = cnt0 ? sum0 / cnt0 : 0;
    var mean1 = cnt1 ? sum1 / cnt1 : 0;
    var sepId, latId;
    if (mean0 < mean1) { sepId = c0; latId = c1; }
    else               { sepId = c1; latId = c0; }

    // Стартовая разметка: пол остаётся полом; большие sep/lat проставляем.
    // Мелкие wall-компоненты — пока считаем полом, потом уточним BFS-ом.
    var out = new Uint8Array(nF);
    for (var h = 0; h < nF; h++) {
      if (comp[h] === sepId)      out[h] = SEP;
      else if (comp[h] === latId) out[h] = LAT;
      else                        out[h] = FLR;
    }

    // Мелкие wall-компоненты: волна BFS от sep/lat seeds определяет,
    // к какой большой компоненте они ближе.
    var hasSmall = false;
    for (var r = 0; r < nF; r++) {
      if (!floorMask[r] && comp[r] !== sepId && comp[r] !== latId) {
        hasSmall = true; break;
      }
    }
    if (hasSmall) {
      var INF = 0x7fffffff;
      var dist = new Int32Array(nF);
      var src  = new Int8Array(nF);  // 0=нет, SEP, LAT (±1 смещение не нужно)
      for (var p = 0; p < nF; p++) { dist[p] = INF; src[p] = -1; }
      var q2 = [];
      for (var s = 0; s < nF; s++) {
        if (out[s] === SEP) { dist[s] = 0; src[s] = SEP; q2.push(s); }
        else if (out[s] === LAT) { dist[s] = 0; src[s] = LAT; q2.push(s); }
      }
      var head = 0;
      while (head < q2.length) {
        var x = q2[head++];
        var nn2 = adj[x];
        for (var m = 0; m < nn2.length; m++) {
          var y = nn2[m];
          if (dist[y] > dist[x] + 1) {
            dist[y] = dist[x] + 1;
            src[y] = src[x];
            q2.push(y);
          }
        }
      }
      for (var t2 = 0; t2 < nF; t2++) {
        if (!floorMask[t2] && comp[t2] !== sepId && comp[t2] !== latId &&
            src[t2] !== -1) {
          out[t2] = src[t2];
        }
      }
    }
    return out;
  }


  function computeLabels(mesh, options) {
    options = options || {};
    var floorBand          = options.floorBand          != null ? options.floorBand          : 0.30;
    var floorNormalWeight  = options.floorNormalWeight  != null ? options.floorNormalWeight  : 0.70;
    var wallNormalWeight   = options.wallNormalWeight   != null ? options.wallNormalWeight   : 0.60;
    var smoothingIters     = options.smoothingIters     != null ? options.smoothingIters     : 3;
    var speckleFrac        = options.speckleFrac        != null ? options.speckleFrac        : 0.01;
    var creaseAngleDeg     = options.creaseAngleDeg     != null ? options.creaseAngleDeg     : 15.0;

    var verts = mesh.vertices;
    var faces = mesh.faces;
    var nF = (faces.length / 3) | 0;

    var attrs;
    if (options.faceCenters && options.faceNormals && options.faceAreas) {
      attrs = { centers: options.faceCenters,
                normals: options.faceNormals,
                areas:   options.faceAreas };
    } else {
      attrs = computeFaceAttrs(verts, faces);
    }
    var adj = options.adjacency || buildAdjacency(faces, nF);
    var nbrW = buildCreaseWeights(adj, faces, attrs.normals, nF, creaseAngleDeg);

    var frame = estimateFrame(attrs.normals, attrs.areas);
    var scores = computeScores(attrs.centers, attrs.normals, attrs.areas,
                               frame.eML, frame.eUP,
                               floorBand, floorNormalWeight, wallNormalWeight);

    // 1) Стартовая разметка: argmax + короткое сглаживание.
    var init = new Uint8Array(nF);
    for (var f = 0; f < nF; f++) init[f] = argmaxScore(scores, f);
    init = neighborSmoothing(init, scores, adj, nF, smoothingIters, nbrW);

    // 2) Разбиение sep/lat через связные компоненты.
    var labels = componentsToLabels(init, attrs.centers, attrs.areas,
                                    frame.eML, adj, nF);

    // 3) Финишная чистка.
    labels = neighborSmoothing(labels, scores, adj, nF, 1, nbrW);
    labels = removeSpeckles(labels, adj, attrs.areas, nF, speckleFrac);
    labels = enforceTopology(labels, scores, adj, nF);

    // 4) Пол — одна непрерывная полоса (плюс мосты, созданные enforceTopology).
    //    Оторвавшиеся floor-острова на стенах переназначаются в ближайший wall.
    labels = keepLargestFloor(labels, adj, attrs.areas, nF, attrs.centers);

    return {
      labels:       labels,
      eML:          frame.eML,
      eUP:          frame.eUP,
      eAP:          frame.eAP,
      faceCenters:  attrs.centers,
      faceNormals:  attrs.normals,
      faceAreas:    attrs.areas,
      adjacency:    adj,
      neighborWeights: nbrW,
      scores:       scores
    };
  }

  global.SaddleSeg = {
    LABELS:         LABELS,
    SEP: SEP, FLR: FLR, LAT: LAT,
    computeLabels:   computeLabels,
    computeFaceAttrs: computeFaceAttrs,
    buildAdjacency:   buildAdjacency,
    estimateFrame:    estimateFrame,
    componentsToLabels: componentsToLabels
  };

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
