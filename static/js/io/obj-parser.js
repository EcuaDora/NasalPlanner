/* ─── io/obj-parser ───────────────────────────────────────────
   Минимальный парсер Wavefront OBJ.
   Возвращает { V, F, nV, nF }:
     V — Float64Array длины nV*3 (x,y,z каждой вершины)
     F — Int32Array  длины nF*3 (индексы вершин, triangulated fan)
   Поддерживаются строки `v x y z` и `f a b c [d [e...]]`
   с опциональными v/vt/vn (берётся только v-индекс).
   Всё остальное (vt, vn, g, o, s, mtl) молча игнорируется.
──────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  window.IO = window.IO || {};

  window.IO.parseOBJ = function (text) {
    const vs = [], fs = [];
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const r = lines[i];
      if (r.length < 4) continue;
      const c0 = r.charCodeAt(0), c1 = r.charCodeAt(1);

      if (c0 === 118 /* v */ && c1 === 32 /* space */) {
        const p = r.split(/\s+/);
        vs.push(+p[1], +p[2], +p[3]);
      } else if (c0 === 102 /* f */ && c1 === 32 /* space */) {
        const ps = r.split(/\s+/);
        const idx = [];
        for (let j = 1; j < ps.length; j++) {
          const t = ps[j];
          if (!t) continue;
          const si = t.indexOf('/');
          idx.push(parseInt(si >= 0 ? t.slice(0, si) : t, 10) - 1);
        }
        // fan triangulation
        for (let j = 1; j < idx.length - 1; j++) {
          fs.push(idx[0], idx[j], idx[j + 1]);
        }
      }
    }

    return {
      V: new Float64Array(vs),
      F: new Int32Array(fs),
      nV: (vs.length / 3) | 0,
      nF: (fs.length / 3) | 0,
    };
  };
})();
