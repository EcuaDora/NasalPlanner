/* ─── render3d/viewer ─────────────────────────────────────────
   Three.js-обёртка для 3D-просмотра меша.
──────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  function _cssVar(name, fallback) {
    try {
      const v = getComputedStyle(document.body).getPropertyValue(name).trim();
      return v || fallback;
    } catch (_) { return fallback; }
  }

  function _themePalette() {
    const light = document.body.classList.contains('light-theme');
    if (light) {
      return {
        // Фон сцены берём из CSS
        bg:          new THREE.Color(_cssVar('--bg', '#f0f3f7')),
        mesh:        0x9a7a5a,
        specular:    0x2a2420,
        shininess:   22,
        wireColor:   0x3a5fb8,
        wireOpacity: 0.22,
        gridA:       0x6a7a90,
        gridB:       0x9aa8bc,
        ambient:     0.32,
        dir1:        0.85,
        dir2:        0.40,
        hemi:        0.25,
      };
    }
    // Тёмная
    return {
      bg:          new THREE.Color(0x060910),
      mesh:        0xe8d5c4,
      specular:    0x181818,
      shininess:   18,
      wireColor:   0x0090a8,
      wireOpacity: 0.10,
      gridA:       0x88a0b8,
      gridB:       0xc0d0dc,
      ambient:     0.55,
      dir1:        0.75,
      dir2:        0.35,
      hemi:        0.30,
    };
  }

  function createInstance(canvas) {
    if (!window.THREE) { console.warn('[Viewer] THREE не загружен'); return null; }
    if (!canvas) return null;

    const pal0 = _themePalette();

    const scene = new THREE.Scene();
    scene.background = pal0.bg;

    const cam = new THREE.PerspectiveCamera(45, 1, 0.01, 50000);
    cam.up.set(0, 0, 1);

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: canvas, antialias: true, alpha: false,
        powerPreference: 'high-performance',
      });
    } catch (e) {
      console.error('[Viewer] WebGL недоступен:', e);
      if (typeof toast === 'function') {
        toast('Ваш браузер не поддерживает WebGL', 'err', 8000);
      }
      return null;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    const ambient = new THREE.AmbientLight(0xffffff, pal0.ambient);
    scene.add(ambient);
    const dir1 = new THREE.DirectionalLight(0xffffff, pal0.dir1);
    dir1.position.set(1, 1, 2); scene.add(dir1);
    const dir2 = new THREE.DirectionalLight(0xffffff, pal0.dir2);
    dir2.position.set(-1, -1, 0.5); scene.add(dir2);
    const hemi = new THREE.HemisphereLight(0xcce0ff, 0x556677, pal0.hemi);
    scene.add(hemi);

    let grid = new THREE.GridHelper(200, 20, pal0.gridA, pal0.gridB);
    grid.rotation.x = Math.PI / 2;
    grid.material.opacity = 0.35;
    grid.material.transparent = true;
    scene.add(grid);

    const meshGroup = new THREE.Group();
    scene.add(meshGroup);

    const st = {
      canvas, scene, cam, renderer, meshGroup, grid,
      ambient, dir1, dir2, hemi,
      orbit: {
        target: new THREE.Vector3(),
        theta: Math.PI * 0.35 - Math.PI / 2,
        phi:   Math.PI * 0.40,
        dist:  250,
      },
      bbox: null, animHandle: null, active: true,
      _cleanup: [],
    };

    (function installMouseControls() {
      let mode = null;
      let lastX = 0, lastY = 0;

      const onCtxMenu = e => e.preventDefault();
      const onDown = e => {
        if (e.button === 0 && !e.shiftKey) mode = 'orbit';
        else if (e.button === 2 || e.shiftKey) mode = 'pan';
        else return;
        lastX = e.clientX; lastY = e.clientY;
        e.preventDefault();
      };
      const onMove = e => {
        if (!mode || !st.active) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX; lastY = e.clientY;
        if (mode === 'orbit') {
          st.orbit.theta -= dx * 0.007;
          st.orbit.phi   -= dy * 0.007;
          const EPS = 0.05;
          st.orbit.phi = Math.max(EPS, Math.min(Math.PI - EPS, st.orbit.phi));
        } else if (mode === 'pan') {
          const dist = st.orbit.dist;
          const r = st.canvas.getBoundingClientRect();
          const worldPerPx = (2 * dist * Math.tan(st.cam.fov * Math.PI / 360)) / r.height;
          const forward = new THREE.Vector3()
            .subVectors(st.orbit.target, st.cam.position).normalize();
          const right = new THREE.Vector3()
            .crossVectors(forward, st.cam.up).normalize();
          const up = new THREE.Vector3()
            .crossVectors(right, forward).normalize();
          st.orbit.target.addScaledVector(right, -dx * worldPerPx);
          st.orbit.target.addScaledVector(up,     dy * worldPerPx);
        }
      };
      const onEnd = () => { mode = null; };
      const onWheel = e => {
        if (!st.active) return;
        const k = e.deltaY > 0 ? 1.15 : 0.87;
        st.orbit.dist = Math.max(0.01, Math.min(100000, st.orbit.dist * k));
        e.preventDefault();
      };
      const onDbl = () => {
        if (!st.bbox) return;
        st.bbox.getCenter(st.orbit.target);
        const s = st.bbox.getSize(new THREE.Vector3());
        st.orbit.dist = Math.max(s.x, s.y, s.z, 1) * 1.3;
      };

      canvas.addEventListener('contextmenu', onCtxMenu);
      canvas.addEventListener('mousedown',  onDown);
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup',   onEnd);
      window.addEventListener('mouseleave', onEnd);
      canvas.addEventListener('wheel', onWheel, { passive: false });
      canvas.addEventListener('dblclick', onDbl);

      st._cleanup.push(() => {
        canvas.removeEventListener('contextmenu', onCtxMenu);
        canvas.removeEventListener('mousedown',  onDown);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup',   onEnd);
        window.removeEventListener('mouseleave', onEnd);
        canvas.removeEventListener('wheel', onWheel);
        canvas.removeEventListener('dblclick', onDbl);
      });
    })();

    (function installResize() {
      const onResize = () => resize();
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(onResize);
        ro.observe(canvas);
        st._cleanup.push(() => ro.disconnect());
      } else {
        window.addEventListener('resize', onResize);
        st._cleanup.push(() => window.removeEventListener('resize', onResize));
      }
    })();

    const onTheme = () => {
      const p = _themePalette();
      st.scene.background = p.bg;
      if (st.ambient) st.ambient.intensity = p.ambient;
      if (st.dir1)    st.dir1.intensity    = p.dir1;
      if (st.dir2)    st.dir2.intensity    = p.dir2;
      if (st.hemi)    st.hemi.intensity    = p.hemi;

      st.meshGroup.traverse(obj => {
        if (obj.userData && obj.userData.__wire && obj.material) {
          obj.material.color.setHex(p.wireColor);
          obj.material.opacity = p.wireOpacity;
        } else if (obj.isMesh && obj.material && !Array.isArray(obj.material)) {
          obj.material.color.setHex(p.mesh);
          if (obj.material.specular) obj.material.specular.setHex(p.specular);
          if ('shininess' in obj.material) obj.material.shininess = p.shininess;
        }
      });

      // Грид проще пересоздать
      if (st.grid) {
        const gSize = (st.grid.geometry.parameters && st.grid.geometry.parameters.size) || 200;
        const gPos = st.grid.position.clone();
        st.scene.remove(st.grid);
        st.grid.geometry.dispose();
        if (Array.isArray(st.grid.material)) st.grid.material.forEach(m => m.dispose());
        else st.grid.material.dispose();
        st.grid = new THREE.GridHelper(gSize, 20, p.gridA, p.gridB);
        st.grid.rotation.x = Math.PI / 2;
        st.grid.position.copy(gPos);
        st.grid.material.opacity = 0.35;
        st.grid.material.transparent = true;
        st.scene.add(st.grid);
      }
    };
    window.addEventListener('theme:change', onTheme);
    st._cleanup.push(() => window.removeEventListener('theme:change', onTheme));

    function resize() {
      const r = st.canvas.getBoundingClientRect();
      const w = Math.max(1, Math.floor(r.width));
      const h = Math.max(1, Math.floor(r.height));
      st.renderer.setSize(w, h, false);
      st.cam.aspect = w / h;
      st.cam.updateProjectionMatrix();
    }

    function clear() {
      const g = st.meshGroup;
      while (g.children.length) {
        const c = g.children[0];
        g.remove(c);
        if (c.geometry) c.geometry.dispose();
        if (c.material) {
          if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
          else c.material.dispose();
        }
      }
      st.bbox = null;
    }

    function loadMesh(M) {
      clear();
      const V = M.rawV, F = M.rawF, nV = M.rawNV, nF = M.rawNF;
      if (!V || !F || !nV || !nF) return;

      const pal = _themePalette();

      const pos = new Float32Array(nV * 3);
      for (let i = 0; i < nV * 3; i++) pos[i] = V[i];
      const idx = new Uint32Array(nF * 3);
      for (let i = 0; i < nF * 3; i++) idx[i] = F[i];

      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geom.setIndex(new THREE.BufferAttribute(idx, 1));
      geom.computeVertexNormals();
      geom.computeBoundingBox();

      const mat = new THREE.MeshPhongMaterial({
        color: pal.mesh, specular: pal.specular, shininess: pal.shininess,
        side: THREE.DoubleSide, flatShading: false,
      });
      const mesh = new THREE.Mesh(geom, mat);

      const _cLocal = new THREE.Vector3();
      geom.boundingBox.getCenter(_cLocal);
      mesh.position.copy(_cLocal).sub(_cLocal.clone().applyEuler(mesh.rotation));
      st.meshGroup.add(mesh);

      const wireMat = new THREE.LineBasicMaterial({
        color: pal.wireColor, transparent: true, opacity: pal.wireOpacity,
      });
      const wire = new THREE.LineSegments(new THREE.WireframeGeometry(geom), wireMat);
      wire.rotation.copy(mesh.rotation);
      wire.position.copy(mesh.position);
      wire.userData.__wire = true;
      st.meshGroup.add(wire);

      st.bbox = geom.boundingBox;
      const c = st.bbox.getCenter(new THREE.Vector3());
      const s = st.bbox.getSize(new THREE.Vector3());
      const maxDim = Math.max(s.x, s.y, s.z, 1);
      st.orbit.target.copy(c);
      st.orbit.dist = maxDim * 1.3;
      st.orbit.theta = Math.PI * 0.35 - Math.PI / 2;
      st.orbit.phi   = Math.PI * 0.40;

      st.scene.remove(st.grid);
      const gSize = Math.max(maxDim * 1.5, 50);
      st.grid = new THREE.GridHelper(gSize, 20, pal.gridA, pal.gridB);
      st.grid.rotation.x = Math.PI / 2;
      st.grid.position.set(c.x, c.y, st.bbox.min.z - maxDim * 0.05);
      st.grid.material.opacity = 0.35;
      st.grid.material.transparent = true;
      st.scene.add(st.grid);

      st.cam.near = Math.max(maxDim * 0.001, 0.01);
      st.cam.far  = Math.max(maxDim * 100, 1000);
      st.cam.updateProjectionMatrix();

      resize();
    }

    function setActive(on) {
      st.active = !!on;
      if (st.active && !st.animHandle) _startLoop();
      else if (!st.active && st.animHandle) {
        cancelAnimationFrame(st.animHandle);
        st.animHandle = null;
      }
    }

    function dispose() {
      if (st.animHandle) { cancelAnimationFrame(st.animHandle); st.animHandle = null; }
      clear();
      st._cleanup.forEach(fn => { try { fn(); } catch (_) {} });
      st._cleanup = [];
      if (st.renderer) {
        st.renderer.dispose();
        const gl = st.renderer.getContext();
        const ext = gl && gl.getExtension('WEBGL_lose_context');
        if (ext) ext.loseContext();
      }
    }

    function _startLoop() {
      const tmpUp = new THREE.Vector3(0, 0, 1);
      function frame() {
        if (!st.active) { st.animHandle = null; return; }
        const { theta, phi, dist, target } = st.orbit;
        const sp = Math.sin(phi), cp = Math.cos(phi);
        const st_ = Math.sin(theta), ct = Math.cos(theta);
        st.cam.position.set(
          target.x + dist * sp * ct,
          target.y + dist * sp * st_,
          target.z + dist * cp
        );
        st.cam.up.copy(tmpUp);
        st.cam.lookAt(target);
        st.renderer.render(st.scene, st.cam);
        st.animHandle = requestAnimationFrame(frame);
      }
      st.animHandle = requestAnimationFrame(frame);
    }

    resize();
    _startLoop();

    return {
      canvas,
      scene:  st.scene,
      camera: st.cam,
      loadMesh, clear, resize, setActive, dispose,
      isReady: () => true,
      getBBox: () => st.bbox,
      setOrbitDistance: d => {
        if (d > 0 && Number.isFinite(d)) st.orbit.dist = d;
      },
    };
  }

  let primary = null;

  window.Viewer = {
    create(canvas) {
      const inst = createInstance(canvas);
      if (inst && !primary) primary = inst;
      return inst;
    },
    init(canvas) {
      if (primary) return true;
      const inst = createInstance(canvas);
      if (!inst) return false;
      primary = inst;
      return true;
    },
    isReady()    { return primary !== null; },
    loadMesh(M)  { if (primary) primary.loadMesh(M); },
    clear()      { if (primary) primary.clear(); },
    resize()     { if (primary) primary.resize(); },
    primary()    { return primary; },
  };
})();
