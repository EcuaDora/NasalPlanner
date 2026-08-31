/* ─── io/nrrd ───────────────────────────────────────────────────
   Минимальный NRRD reader/writer для браузера.

   Читает то, что пишет SimpleITK и наша backend-операция roi_pair:
     encoding: raw | gzip,  attached-данные (заголовок + бинарь в одном файле),
     type: signed char / unsigned char / short / ushort / int / uint / float /
           double,  little-endian, 3D.

   NRRD.parse(arrayBuffer) → Promise<{
       data,            // TypedArray, layout: x меняется быстрее всего
       sizes,           // [X, Y, Z]
       dtype,           // 'int16' | 'uint8' | 'float32' | ...
       spaceDirections, // [[..],[..],[..]]  (вектор на ось X,Y,Z)
       spaceOrigin,     // [ox, oy, oz]
       space,           // строка ('left-posterior-superior')
       spacing,         // [sx, sy, sz] = нормы столбцов
       at(x,y,z),       // значение вокселя
   }>

   NRRD.encodeMaskU8(sizes, dataU8, geom) → ArrayBuffer
       Кодирует uint8-маску в raw-NRRD с заданной геометрией — чтобы
       залить исправленную маску обратно в session (PUT /api/session/roi_mask).
──────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const TYPE_MAP = {
    'signed char': Int8Array, 'int8': Int8Array, 'int8_t': Int8Array,
    'uchar': Uint8Array, 'unsigned char': Uint8Array, 'uint8': Uint8Array, 'uint8_t': Uint8Array,
    'short': Int16Array, 'short int': Int16Array, 'signed short': Int16Array,
    'signed short int': Int16Array, 'int16': Int16Array, 'int16_t': Int16Array,
    'ushort': Uint16Array, 'unsigned short': Uint16Array, 'uint16': Uint16Array, 'uint16_t': Uint16Array,
    'int': Int32Array, 'signed int': Int32Array, 'int32': Int32Array, 'int32_t': Int32Array,
    'uint': Uint32Array, 'unsigned int': Uint32Array, 'uint32': Uint32Array, 'uint32_t': Uint32Array,
    'float': Float32Array, 'double': Float64Array,
  };
  const TA_NAME = (ta) =>
    ({ Int8Array: 'int8', Uint8Array: 'uint8', Int16Array: 'int16',
       Uint16Array: 'uint16', Int32Array: 'int32', Uint32Array: 'uint32',
       Float32Array: 'float32', Float64Array: 'float64' }[ta.name] || 'int16');

  function findHeaderEnd(bytes) {
    for (let i = 0; i + 1 < bytes.length; i++) {
      if (bytes[i] === 0x0a && bytes[i + 1] === 0x0a) return { end: i, skip: 2 };
      if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a &&
          bytes[i + 2] === 0x0d && bytes[i + 3] === 0x0a) return { end: i, skip: 4 };
    }
    throw new Error('NRRD: конец заголовка не найден');
  }

  function parseVectors(text) {
    const out = [];
    const re = /\(([^)]*)\)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      out.push(m[1].split(',').map(Number));
    }
    return out;
  }

  async function gunzip(u8) {
    if (typeof DecompressionStream === 'function') {
      const ds = new DecompressionStream('gzip');
      const stream = new Blob([u8]).stream().pipeThrough(ds);
      const buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    }
    if (window.pako && window.pako.ungzip) return window.pako.ungzip(u8);
    throw new Error('Нет распаковки gzip (DecompressionStream/pako недоступны)');
  }

  async function parse(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const { end, skip } = findHeaderEnd(bytes);
    const headerText = new TextDecoder('utf-8').decode(bytes.subarray(0, end));

    const H = {};
    headerText.split(/\r?\n/).forEach((line) => {
      if (!line || line[0] === '#' || /^NRRD/i.test(line)) return;
      let idx = line.indexOf(':=');
      if (idx >= 0) { H[line.slice(0, idx).trim()] = line.slice(idx + 2).trim(); return; }
      idx = line.indexOf(':');
      if (idx >= 0) { H[line.slice(0, idx).trim()] = line.slice(idx + 1).trim(); }
    });

    const TA = TYPE_MAP[(H.type || '').toLowerCase()];
    if (!TA) throw new Error("NRRD: тип '" + H.type + "' не поддержан");

    const sizes = (H.sizes || '').trim().split(/\s+/).map(Number);
    if (sizes.length !== 3) throw new Error('NRRD: ожидается 3D, sizes=' + sizes);
    const [X, Y, Z] = sizes;
    const count = X * Y * Z;

    let dataBytes = bytes.subarray(end + skip);
    const enc = (H.encoding || 'raw').toLowerCase();
    if (enc === 'gzip' || enc === 'gz') dataBytes = await gunzip(dataBytes);
    else if (enc !== 'raw') throw new Error("NRRD: encoding '" + enc + "' не поддержан");

    const need = count * TA.BYTES_PER_ELEMENT;
    const copy = new Uint8Array(need);
    copy.set(dataBytes.subarray(0, need));
    let data = new TA(copy.buffer);

    // endian: данные пишутся в порядке файла; JS TypedArray — нативный
    // (little на всех целевых платформах). Если файл big-endian и тип
    // многобайтный — переставим байты.
    if (TA.BYTES_PER_ELEMENT > 1 && (H.endian || 'little').toLowerCase() === 'big') {
      const dv = new DataView(copy.buffer);
      const n = TA.BYTES_PER_ELEMENT;
      for (let i = 0; i < copy.length; i += n) {
        for (let a = 0, b = n - 1; a < b; a++, b--) {
          const t = dv.getUint8(i + a); dv.setUint8(i + a, dv.getUint8(i + b)); dv.setUint8(i + b, t);
        }
      }
      data = new TA(copy.buffer);
    }

    const dirs = parseVectors(H['space directions'] || '(1,0,0) (0,1,0) (0,0,1)');
    const orig = (parseVectors(H['space origin'] || '(0,0,0)')[0]) || [0, 0, 0];
    const spacing = dirs.map((v) => Math.hypot(v[0] || 0, v[1] || 0, v[2] || 0) || 1);

    const XY = X * Y;
    return {
      data, sizes, dtype: TA_NAME(TA),
      spaceDirections: dirs, spaceOrigin: orig, spacing,
      space: H.space || 'left-posterior-superior',
      at(x, y, z) { return data[x + X * y + XY * z]; },
    };
  }

  // ── Кодирование uint8-маски обратно в raw-NRRD ──────────────────
  function encodeMaskU8(sizes, dataU8, geom) {
    const [X, Y, Z] = sizes;
    const dirs = geom.spaceDirections;
    const org = geom.spaceOrigin;
    const vec = (v) => '(' + v.map((x) => +(+x).toPrecision(10)).join(',') + ')';
    const header =
      'NRRD0004\n' +
      '# saved by nasal-planner (edited mask)\n' +
      'type: unsigned char\n' +
      'dimension: 3\n' +
      'space: ' + (geom.space || 'left-posterior-superior') + '\n' +
      'sizes: ' + X + ' ' + Y + ' ' + Z + '\n' +
      'space directions: ' + dirs.map(vec).join(' ') + '\n' +
      'kinds: domain domain domain\n' +
      'endian: little\n' +
      'encoding: raw\n' +
      'space origin: ' + vec(org) + '\n\n';

    const head = new TextEncoder().encode(header);
    const out = new Uint8Array(head.length + dataU8.length);
    out.set(head, 0);
    out.set(dataU8, head.length);
    return out.buffer;
  }

  // ── Кодирование КТ (int16, signed short) обратно в raw-NRRD ─────
  // Нужен, чтобы фронт мог восстановить roi_ct, если серверная сессия его
  // потеряла (рестарт / переконвертация DICOM / reset_except). Геометрию
  // берём ту же, что у маски — size/spacing/origin/direction совпадают.
  function encodeCTInt16(sizes, data, geom) {
    const [X, Y, Z] = sizes;
    const N = X * Y * Z;
    const dirs = geom.spaceDirections;
    const org = geom.spaceOrigin;
    const vec = (v) => '(' + v.map((x) => +(+x).toPrecision(10)).join(',') + ')';
    const header =
      'NRRD0004\n' +
      '# saved by nasal-planner (roi_ct rehydrate)\n' +
      'type: short\n' +
      'dimension: 3\n' +
      'space: ' + (geom.space || 'left-posterior-superior') + '\n' +
      'sizes: ' + X + ' ' + Y + ' ' + Z + '\n' +
      'space directions: ' + dirs.map(vec).join(' ') + '\n' +
      'kinds: domain domain domain\n' +
      'endian: little\n' +
      'encoding: raw\n' +
      'space origin: ' + vec(org) + '\n\n';

    const head = new TextEncoder().encode(header);
    const out = new Uint8Array(head.length + N * 2);
    out.set(head, 0);
    const dv = new DataView(out.buffer, head.length);
    for (let i = 0; i < N; i++) {
      let v = Math.round(data[i]);
      if (!Number.isFinite(v)) v = 0;
      if (v < -32768) v = -32768; else if (v > 32767) v = 32767;
      dv.setInt16(i * 2, v, true);   // little-endian — совпадает с header
    }
    return out.buffer;
  }

  window.NRRD = { parse, encodeMaskU8, encodeCTInt16 };
})();
