/* ─── core/state ───────────────────────────────────────────────

──────────────────────────────────────────────────────────────── */

window.M = {
  // === Tab 1 ===
  source: { type: null, name: null, bytes: 0 },
  volume: null,
  volMask: null,

  // === Raw mesh  ===
  rawV: null, rawF: null, rawNV: 0, rawNF: 0,
  rayDist: null,        // расстояние до противоположной стенки по нормали
  rawInnerMask: null,   // Uint8Array(nF) — маска внутренней поверхности
  rawFaceAdj: null,
  maskHistory: [],
  maskHistoryIdx: -1,

  // === Active mesh (после commit на Tab 2) ===
  V: null, F: null, nV: 0, nF: 0,
  fn: null, fa: null, fc: null,  // нормали / площади / центроиды граней

  // === Tab 3 ===
  axes: null,           // { lr, si, ap, lr_sign, si_sign, mn, mx, bb }
  lr_norm: null, si_norm: null,
  labels: null,         // Int32Array(nF) — 0/1/2
  cuts: { med: 0.3, lat: 0.7, flr: 0.25 },
  defaultCuts: null,
  vAdj: null,

  // === Tab 4 ===
  uv: null,             // Float64Array(nV*2)
  valid: null,          // Uint8Array(nF) — какие грани показывать на развёртке
  fw: 0,                // ширина полосы «дна» в мм
  distortion: null,     // σ = A2D / A3D
  unfoldBuilt: false,
  annotations: [],      // { kind: 'defect'|'flap', faces: Uint8Array, area: number }

  // === MPR / crosshair ===
  crosshair: { x: 0, y: 0, z: 0 },
  wl: { lvl: 40, win: 400 },

  // === UI state ===
  currentTab: 'data',
  theme: 'light',  // 'light' | 'dark'
};

/* Хелпер для сброса при загрузке нового файла */
window.M.reset = function () {
  const M = window.M;
  M.source = { type: null, name: null, bytes: 0 };
  M.volume = null; M.volMask = null;
  M.rawV = null; M.rawF = null; M.rawNV = 0; M.rawNF = 0;
  M.rayDist = null; M.rawInnerMask = null; M.rawFaceAdj = null;
  M.maskHistory = []; M.maskHistoryIdx = -1;
  M.V = null; M.F = null; M.nV = 0; M.nF = 0;
  M.fn = null; M.fa = null; M.fc = null;
  M.axes = null; M.lr_norm = null; M.si_norm = null;
  M.labels = null; M.defaultCuts = null; M.vAdj = null;
  M.uv = null; M.valid = null; M.fw = 0; M.distortion = null;
  M.unfoldBuilt = false; M.annotations = [];
};
