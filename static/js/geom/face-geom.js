/* ─── geom/face-geom ───────────────────────────────────────────
   Чистые функции над массивами вершин/граней.
   Ничего не знает про M и про Three.js.
──────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  window.Geom = window.Geom || {};

  /* Для каждой грани: нормаль (unit), площадь, центроид.
     Возвращает { fn: Float64Array(nF*3), fa: Float64Array(nF), fc: Float64Array(nF*3) } */
  window.Geom.compute = function (V, F, nF) {
    const fn = new Float64Array(nF * 3);
    const fa = new Float64Array(nF);
    const fc = new Float64Array(nF * 3);
    for (let fi = 0; fi < nF; fi++) {
      const i0 = F[fi * 3], i1 = F[fi * 3 + 1], i2 = F[fi * 3 + 2];
      const ax = V[i0 * 3], ay = V[i0 * 3 + 1], az = V[i0 * 3 + 2];
      const bx = V[i1 * 3], by = V[i1 * 3 + 1], bz = V[i1 * 3 + 2];
      const cx = V[i2 * 3], cy = V[i2 * 3 + 1], cz = V[i2 * 3 + 2];

      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;

      const ln = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const inv = ln > 1e-15 ? 1 / ln : 0;
      fn[fi * 3]     = nx * inv;
      fn[fi * 3 + 1] = ny * inv;
      fn[fi * 3 + 2] = nz * inv;
      fa[fi] = ln * 0.5;
      fc[fi * 3]     = (ax + bx + cx) / 3;
      fc[fi * 3 + 1] = (ay + by + cy) / 3;
      fc[fi * 3 + 2] = (az + bz + cz) / 3;
    }
    return { fn, fa, fc };
  };

  /* Min/max/size/center по вершинам. */
  window.Geom.bounds = function (V, nV) {
    let xn =  Infinity, yn =  Infinity, zn =  Infinity;
    let xx = -Infinity, yx = -Infinity, zx = -Infinity;
    for (let i = 0; i < nV; i++) {
      const x = V[i * 3], y = V[i * 3 + 1], z = V[i * 3 + 2];
      if (x < xn) xn = x; if (x > xx) xx = x;
      if (y < yn) yn = y; if (y > yx) yx = y;
      if (z < zn) zn = z; if (z > zx) zx = z;
    }
    return {
      min:    [xn, yn, zn],
      max:    [xx, yx, zx],
      size:   [xx - xn, yx - yn, zx - zn],
      center: [(xn + xx) / 2, (yn + yx) / 2, (zn + zx) / 2],
    };
  };

  window.Geom.totalArea = function (fa, nF) {
    let s = 0;
    for (let i = 0; i < nF; i++) s += fa[i];
    return s;
  };
})();
