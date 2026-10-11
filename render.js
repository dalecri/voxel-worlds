// Voxel Worlds: three.js renderer. Meshes the voxel world (with baked ambient
// occlusion), the two fluids, particles, clouds, rain and the day cycle.
// Exposes window.PBRender.

(function () {
  const { W, D, H, T, WATER, LAVA, DECOR, isSolid, idx, hash3 } = PB;

  // ---- palette ----
  const C = hex => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const pal = list => list.map(C);
  const P = {
    grass: pal([0x7fd04b, 0x76c845, 0x88d855, 0x70c242]),
    grassSide: C(0x6cbf40),
    dirt: C(0x9a6b45), dirtDark: C(0x84593a), dirtLight: C(0xa87752),
    stone: pal([0x9c9ca8, 0x92929e, 0xa6a6b0]),
    sand: pal([0xf2d391, 0xeccb84, 0xf6dc9e]), sandSide: C(0xe0bd78),
    snow: pal([0xeafcff, 0xdcf5fa, 0xf4ffff]),
    log: C(0x8a5a36), logTop: C(0xbd8f5c),
    leaves: pal([0x7ccf48, 0x6ec23e, 0x8ad856]),
    blossom: pal([0xf59ac4, 0xee88b8, 0xfbb4d2]),
    autumn: pal([0xf6a83a, 0xf0962c, 0xfbbd4e]),
    pine: pal([0x3f8f58, 0x37824e, 0x48a062]),
    plank: C(0xd8a86c), plankDark: C(0xc4915a),
    brick: pal([0xd27a5e, 0xc86c52, 0xda8a6a]),
    obsidian: pal([0x30264c, 0x3c2e64, 0x281f40]),
    basalt: pal([0x58525e, 0x4c4754, 0x625b68]),
    spring: C(0x74e4f6), vent: C(0xff8a2a),
    moss: pal([0x6aa84a, 0x5e9a40]),
    cactus: pal([0x5fae4c, 0x55a044]),
    flowers: pal([0xff7aa8, 0xffd54a, 0xffffff, 0xff5a5a, 0xb48cff, 0xff9a3a, 0x7ad0ff]),
    stem: C(0x4f9a3a), tuft: pal([0x8ee05a, 0x7fd04b, 0x9ae868]),
    lantern: C(0xffdb8a), lanternCap: C(0x3a3040),
    shroomCap: C(0xe8524a), shroomStem: C(0xf4ead8),
    water: C(0x0070c0), waterShallow: C(0x00bfee), foam: C(0xb8f4ff),
    lava: C(0xff5c14), lavaHot: C(0xffb83a), lavaCrust: C(0xb83a14),
  };
  const pick = (list, x, y, z, s) => list[(hash3(x, y, z, s) * list.length) | 0];
  const jit = (c, x, y, z) => mul(c, 0.94 + hash3(x, y, z, 9) * 0.1);

  // cube faces: normal + corners (CCW from outside); side faces list bottom corners first
  const FACES = [
    { n: [1, 0, 0], c: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] },
    { n: [-1, 0, 0], c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
    { n: [0, 1, 0], c: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
    { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
    { n: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
    { n: [0, 0, -1], c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] },
  ];
  const AO = [0.5, 0.68, 0.84, 1];

  // types that hide the faces of their neighbours
  const OPAQUE = new Uint8Array(32);
  for (let t = 1; t < 32; t++) OPAQUE[t] = isSolid(t) && t !== T.CACTUS && t !== T.LANTERN ? 1 : 0;

  // Fluid surfaces: a gentle swell in the vertex shader, plus bright bands that
  // stream down falling water (aFlow) so waterfalls read as moving.
  function fluidMaterial(mat, key, amp, speed, uTime, flow) {
    mat.onBeforeCompile = sh => {
      sh.uniforms.uTime = uTime;
      sh.vertexShader = 'attribute float aWave;\nattribute float aFlow;\nuniform float uTime;\nvarying float vFlow;\nvarying float vWy;\n' +
        sh.vertexShader.replace('#include <begin_vertex>',
        `#include <begin_vertex>
         float wv = sin(uTime * ${speed.toFixed(2)} + position.x * 1.9 + position.z * 1.3) * 0.5
                  + sin(uTime * ${(speed * 0.63).toFixed(2)} - position.x * 0.8 + position.z * 2.2) * 0.5;
         transformed.y += aWave * (wv * ${amp.toFixed(3)} - ${amp.toFixed(3)});
         vFlow = aFlow; vWy = position.y + position.x * 0.13 + position.z * 0.07;`);
      if (flow) {
        sh.fragmentShader = 'uniform float uTime;\nvarying float vFlow;\nvarying float vWy;\n' + sh.fragmentShader.replace('#include <opaque_fragment>',
          `#include <opaque_fragment>
           float band = 0.5 + 0.5 * sin(vWy * 6.0 + uTime * ${flow.toFixed(1)});
           gl_FragColor.rgb += vFlow * band * band * 0.22;`);
      }
    };
    mat.customProgramCacheKey = () => key;
    return mat;
  }

  // Growable typed-array buffer for meshes rebuilt every frame (no garbage per frame)
  function FBuf() { this.cap = 0; this.grow(4096); this.v = 0; this.ni = 0; }
  FBuf.prototype.grow = function (verts) {
    const keep = this.cap ? { p: this.p, n: this.n, c: this.c, w: this.w, f: this.f, i: this.i } : null;
    this.cap = verts;
    this.p = new Float32Array(verts * 3); this.n = new Float32Array(verts * 3); this.c = new Float32Array(verts * 3);
    this.w = new Float32Array(verts); this.f = new Float32Array(verts); this.i = new Uint32Array(Math.ceil(verts * 1.5));
    if (keep) { this.p.set(keep.p); this.n.set(keep.n); this.c.set(keep.c); this.w.set(keep.w); this.f.set(keep.f); this.i.set(keep.i); }
    this.geo = null;
  };
  FBuf.prototype.reset = function () { this.v = 0; this.ni = 0; };
  // corners: 4 [x,y,z]; col: [r,g,b] per corner or one; wave/flow: per-corner arrays or numbers
  FBuf.prototype.quad = function (ps, n, cols, ws, fs, flip) {
    if (this.v + 4 > this.cap) this.grow(this.cap * 2);
    const v = this.v;
    for (let k = 0; k < 4; k++) {
      const o = (v + k) * 3, c = typeof cols[0] === 'number' ? cols : cols[k];
      this.p[o] = ps[k][0]; this.p[o + 1] = ps[k][1]; this.p[o + 2] = ps[k][2];
      this.n[o] = n[0]; this.n[o + 1] = n[1]; this.n[o + 2] = n[2];
      this.c[o] = c[0]; this.c[o + 1] = c[1]; this.c[o + 2] = c[2];
      this.w[v + k] = ws ? (ws.length ? ws[k] : ws) : 0;
      this.f[v + k] = fs ? (fs.length ? fs[k] : fs) : 0;
    }
    const I = this.i, o = this.ni;
    if (flip) { I[o] = v + 1; I[o + 1] = v + 2; I[o + 2] = v + 3; I[o + 3] = v + 1; I[o + 4] = v + 3; I[o + 5] = v; }
    else { I[o] = v; I[o + 1] = v + 1; I[o + 2] = v + 2; I[o + 3] = v; I[o + 4] = v + 2; I[o + 5] = v + 3; }
    this.ni += 6; this.v += 4;
  };
  FBuf.prototype.box = function (x0, y0, z0, x1, y1, z1, col, fl, topWave) {
    for (let f = 0; f < 6; f++) {
      if (f === 3) continue;
      const F = FACES[f];
      const ps = F.c.map(c => [c[0] ? x1 : x0, c[1] ? y1 : y0, c[2] ? z1 : z0]);
      this.quad(ps, F.n, f === 2 ? col : mul(col, 0.92), f === 2 ? (topWave || 0) : F.c.map(c => (c[1] ? topWave || 0 : 0)), f === 2 ? 0 : fl);
    }
  };
  // push into a mesh, reusing GPU buffers while they fit
  FBuf.prototype.apply = function (mesh) {
    let g = this.geo;
    if (!g) {
      g = this.geo = new THREE.BufferGeometry();
      const dyn = (a, s) => new THREE.BufferAttribute(a, s).setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('position', dyn(this.p, 3)); g.setAttribute('normal', dyn(this.n, 3));
      g.setAttribute('color', dyn(this.c, 3)); g.setAttribute('aWave', dyn(this.w, 1));
      g.setAttribute('aFlow', dyn(this.f, 1)); g.setIndex(dyn(this.i, 1));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(W / 2, H / 2, D / 2), 40);
    }
    for (const k of ['position', 'normal', 'color', 'aWave', 'aFlow']) {
      const a = g.attributes[k];
      a.needsUpdate = true;
      a.clearUpdateRanges && a.clearUpdateRanges();
      a.addUpdateRange ? a.addUpdateRange(0, this.v * a.itemSize) : (a.updateRange = { offset: 0, count: this.v * a.itemSize });
    }
    g.index.needsUpdate = true;
    g.index.clearUpdateRanges && g.index.clearUpdateRanges();
    g.index.addUpdateRange ? g.index.addUpdateRange(0, this.ni) : (g.index.updateRange = { offset: 0, count: this.ni });
    g.setDrawRange(0, this.ni);
    [].concat(mesh).forEach(m => { if (m.geometry !== g) { m.geometry.dispose(); m.geometry = g; } });
  };

  // ---- particles: square sprites read as tiny voxels ----
  function Particles(max, additive) {
    this.max = max; this.n = 0;
    this.pos = new Float32Array(max * 3); this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max); this.alpha = new Float32Array(max);
    this.vel = new Float32Array(max * 3); this.life = new Float32Array(max); this.max0 = new Float32Array(max);
    this.grav = new Float32Array(max); this.drag = new Float32Array(max); this.s0 = new Float32Array(max);
    this.wander = new Uint8Array(max);
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this.aAlpha = new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos); g.setAttribute('pcolor', this.aCol);
    g.setAttribute('psize', this.aSize); g.setAttribute('palpha', this.aAlpha);
    this.uScale = { value: 10 };
    const m = new THREE.ShaderMaterial({
      uniforms: { uScale: this.uScale },
      vertexShader: `attribute vec3 pcolor; attribute float psize; attribute float palpha; uniform float uScale;
        varying vec3 vC; varying float vA;
        void main(){ vC = pcolor; vA = palpha; vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv; gl_PointSize = max(1.5, psize * uScale); }`,
      fragmentShader: `varying vec3 vC; varying float vA;
        void main(){ if (vA < 0.01) discard; gl_FragColor = vec4(vC, vA);
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }
  Particles.prototype.spawn = function (x, y, z, vx, vy, vz, col, size, life, grav, drag, wander) {
    if (this.n >= this.max) return;
    const k = this.n++;
    this.pos.set([x, y, z], k * 3); this.vel.set([vx, vy, vz], k * 3); this.col.set(col, k * 3);
    this.s0[k] = size; this.life[k] = life; this.max0[k] = life;
    this.grav[k] = grav || 0; this.drag[k] = drag || 0; this.wander[k] = wander ? 1 : 0;
  };
  Particles.prototype.update = function (dt, t) {
    let k = 0;
    while (k < this.n) {
      this.life[k] -= dt;
      if (this.life[k] <= 0) {     // swap-remove
        const j = --this.n;
        if (k !== j) {
          for (let a = 0; a < 3; a++) {
            this.pos[k * 3 + a] = this.pos[j * 3 + a]; this.vel[k * 3 + a] = this.vel[j * 3 + a]; this.col[k * 3 + a] = this.col[j * 3 + a];
          }
          this.s0[k] = this.s0[j]; this.life[k] = this.life[j]; this.max0[k] = this.max0[j];
          this.grav[k] = this.grav[j]; this.drag[k] = this.drag[j]; this.wander[k] = this.wander[j];
        }
        continue;
      }
      const i3 = k * 3;
      if (this.wander[k]) {
        this.vel[i3] += Math.sin(t * 1.3 + k * 7.1) * dt * 0.8;
        this.vel[i3 + 1] += Math.sin(t * 1.7 + k * 3.3) * dt * 0.4;
        this.vel[i3 + 2] += Math.cos(t * 1.1 + k * 5.7) * dt * 0.8;
      }
      this.vel[i3 + 1] -= this.grav[k] * dt;
      const dr = 1 - this.drag[k] * dt;
      this.vel[i3] *= dr; this.vel[i3 + 1] *= dr; this.vel[i3 + 2] *= dr;
      this.pos[i3] += this.vel[i3] * dt; this.pos[i3 + 1] += this.vel[i3 + 1] * dt; this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      const f = this.life[k] / this.max0[k];
      this.alpha[k] = this.wander[k] ? Math.min(1, f * 3) * (0.55 + 0.45 * Math.sin(t * 4 + k)) : Math.min(1, f * 2.2);
      this.size[k] = this.s0[k] * (this.wander[k] ? 1 : 0.6 + 0.4 * f);
      k++;
    }
    this.points.geometry.setDrawRange(0, this.n);
    this.aPos.needsUpdate = this.aCol.needsUpdate = this.aSize.needsUpdate = this.aAlpha.needsUpdate = true;
  };

  // ---- times of day ----
  const PHASES = {
    dawn: { top: '#ffd9c4', bot: '#8fd6cc', sun: 0xffd2a8, sunI: 2.1, dir: [-0.7, 0.55, 0.55], amb: 0xd6c8e8, ambI: 0.7,
      sky: 0xffe8d0, ground: 0x6a8a70, hemiI: 0.6, exp: 1.08, night: 0.1 },
    day: { top: '#9ae8d4', bot: '#3cb6a4', sun: 0xfff3dc, sunI: 2.5, dir: [0.45, 1, 0.3], amb: 0xe8f4ff, ambI: 0.75,
      sky: 0xdff6ff, ground: 0x7a9a60, hemiI: 0.7, exp: 1.12, night: 0 },
    golden: { top: '#ffc394', bot: '#e3809a', sun: 0xffad6a, sunI: 2.4, dir: [0.95, 0.42, -0.15], amb: 0xf0c0c8, ambI: 0.6,
      sky: 0xffd0b0, ground: 0x80606a, hemiI: 0.55, exp: 1.06, night: 0.25 },
    night: { top: '#161d4c', bot: '#34488a', sun: 0xa8bcff, sunI: 1.25, dir: [-0.35, 1, 0.55], amb: 0x7080c8, ambI: 0.85,
      sky: 0x8a9ae0, ground: 0x30305a, hemiI: 0.7, exp: 1.05, night: 1 },
  };
  const hexMix = (a, b, t) => new THREE.Color(a).lerp(new THREE.Color(b), t);

  // =================================================================
  function Renderer(canvas, world, hooks) {
    this.world = world;
    this.hooks = hooks || {};
    const r = this.r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: false });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.setClearColor(0x000000, 0);
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.1;

    const scene = this.scene = new THREE.Scene();
    this.cam = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 400);
    this.yaw = this.yawGoal = Math.PI / 4;
    this.pitch = this.pitchGoal = 0.6;
    this.zoom = this.zoomGoal = 1;
    this.pan = new THREE.Vector3(); this.panGoal = new THREE.Vector3();

    this.sun = new THREE.DirectionalLight(0xffffff, 2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { near: 1, far: 140, left: -24, right: 24, top: 24, bottom: -24 });
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.03;
    this.amb = new THREE.AmbientLight(0xffffff, 0.7);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x666666, 0.6);
    this.rim = new THREE.DirectionalLight(0xbfe8ff, 0.35); this.rim.position.set(-30, 20, -10);
    scene.add(this.sun, this.sun.target, this.amb, this.hemi, this.rim);

    this.root = new THREE.Group();
    this.root.position.set(-W / 2, -4, -D / 2);
    scene.add(this.root);

    this.uTime = { value: 0 };
    this.solidMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.glowMat = new THREE.MeshBasicMaterial({ vertexColors: true });
    this.waterMat = fluidMaterial(new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.88, depthWrite: false,
      emissive: 0x06506a, emissiveIntensity: 0.4 }), 'water', 0.045, 1.8, this.uTime, 9);
    // depth-only pass: lets the translucent water show only its front-most surface,
    // so back faces and inner walls never shimmer through
    this.waterDepthMat = fluidMaterial(new THREE.MeshBasicMaterial({ colorWrite: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
      'waterDepth', 0.045, 1.8, this.uTime, 0);
    this.lavaMat = fluidMaterial(new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0xff3c00, emissiveIntensity: 0.55 }), 'lava', 0.03, 0.9, this.uTime, 3);
    this.meshes = {};
    ['solid', 'glow', 'waterDepth', 'water', 'lava'].forEach(k => {
      const m = new THREE.Mesh(new THREE.BufferGeometry(), this[k + 'Mat']);
      m.frustumCulled = false;
      m.castShadow = k === 'solid'; m.receiveShadow = k === 'solid' || k === 'water' || k === 'lava';
      if (k === 'waterDepth') m.renderOrder = 1;
      if (k === 'water') m.renderOrder = 2;
      this.meshes[k] = m; this.root.add(m);
    });
    this.waterBuf = new FBuf(); this.lavaBuf = new FBuf();

    // smoothed copies of the simulation so levels glide instead of stepping each tick
    this.dm = new Float32Array(PB.N);       // displayed amount
    this.df = new Uint8Array(PB.N);         // displayed fluid type
    this.dFall = new Float32Array(PB.N);    // displayed inflow from above (foam)
    this.dEdge = new Float32Array(PB.N);    // displayed outflow over the island edge

    // blocks in mid-fall (sand), drawn between simulation ticks
    this.fallMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), 256);
    this.fallMesh.castShadow = this.fallMesh.receiveShadow = true;
    this.fallMesh.frustumCulled = false;
    this.fallMesh.count = 0;
    this.root.add(this.fallMesh);

    // a soft shadow beneath the floating island
    const sh = document.createElement('canvas'); sh.width = sh.height = 128;
    const sx = sh.getContext('2d'), gr = sx.createRadialGradient(64, 64, 4, 64, 64, 64);
    gr.addColorStop(0, 'rgba(0,30,40,0.35)'); gr.addColorStop(1, 'rgba(0,30,40,0)');
    sx.fillStyle = gr; sx.fillRect(0, 0, 128, 128);
    this.under = new THREE.Mesh(new THREE.PlaneGeometry(46, 46), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sh), transparent: true, depthWrite: false }));
    this.under.rotation.x = -Math.PI / 2; this.under.position.set(W / 2, -7, D / 2);
    this.root.add(this.under);

    // cursor
    const cg = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.04, 1.04, 1.04));
    this.cursor = new THREE.LineSegments(cg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false }));
    this.cursor.renderOrder = 9; this.cursor.visible = false;
    const fill = new THREE.Mesh(new THREE.BoxGeometry(1.02, 1.02, 1.02), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18, depthWrite: false }));
    this.cursor.add(fill); this.cursorFill = fill;
    this.root.add(this.cursor);

    this.fx = new Particles(2600, false);
    this.glowFx = new Particles(900, true);
    this.root.add(this.fx.points, this.glowFx.points);

    this.buildClouds();
    this.buildRain();

    this.phase = 'day';
    this.ph = Object.assign({}, PHASES.day);
    this.phaseFrom = PHASES.day; this.phaseTo = PHASES.day; this.phaseT = 1;
    this.applyPhase(1);

    this.surfaces = { water: [], lava: [], vents: [], lanterns: [], grass: [] };
    this.heights = new Int16Array(W * D);
    this.raycaster = new THREE.Raycaster();
    this.resize();
  }
  const R = Renderer.prototype;

  R.resize = function () {
    const c = this.r.domElement;
    const w = c.clientWidth || window.innerWidth, h = c.clientHeight || window.innerHeight;
    this.r.setSize(w, h, false);
    this.w = w; this.h = h;
    this.placeCamera();
  };

  R.placeCamera = function () {
    const aspect = this.w / this.h;
    // frame the island: wide enough for its diagonal, tall enough for the cliff
    const viewH = Math.max(aspect > 1 ? 46 : 36, 37 / aspect) / this.zoom;
    const cam = this.cam;
    cam.top = viewH / 2; cam.bottom = -viewH / 2;
    cam.left = -viewH * aspect / 2; cam.right = viewH * aspect / 2;
    const cp = Math.cos(this.pitch);
    const dir = new THREE.Vector3(cp * Math.sin(this.yaw), Math.sin(this.pitch), cp * Math.cos(this.yaw));
    const target = new THREE.Vector3(0, 3.5, 0).add(this.pan);
    cam.position.copy(target).addScaledVector(dir, 120);
    cam.lookAt(target);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    const ppu = this.h / viewH;           // css pixels per world unit
    // nudge the island up so it sits between the header and the tool bar
    const lift = (this.hooks.lift ? this.hooks.lift() : 0) / ppu;
    cam.top -= lift; cam.bottom -= lift;
    cam.updateProjectionMatrix();
    this.fx.uScale.value = this.glowFx.uScale.value = ppu * this.r.getPixelRatio();
    this.ppu = ppu;
  };

  // ---- day cycle ----
  R.setPhase = function (name, instant) {
    if (!PHASES[name]) return;
    this.phase = name;
    this.phaseFrom = Object.assign({}, this.ph);
    this.phaseTo = PHASES[name];
    this.phaseT = instant ? 1 : 0;
    if (instant) this.applyPhase(1);
  };
  R.applyPhase = function (t) {
    const a = this.phaseFrom, b = this.phaseTo, s = t * t * (3 - 2 * t);
    const ph = this.ph;
    for (const k of ['sunI', 'ambI', 'hemiI', 'exp', 'night']) ph[k] = a[k] + (b[k] - a[k]) * s;
    ph.dir = a.dir.map((v, i) => v + (b.dir[i] - v) * s);
    this.sun.color.copy(hexMix(a.sun, b.sun, s)); this.sun.intensity = ph.sunI;
    this.amb.color.copy(hexMix(a.amb, b.amb, s)); this.amb.intensity = ph.ambI;
    this.hemi.color.copy(hexMix(a.sky, b.sky, s)); this.hemi.groundColor.copy(hexMix(a.ground, b.ground, s)); this.hemi.intensity = ph.hemiI;
    this.r.toneMappingExposure = ph.exp;
    const d = new THREE.Vector3().fromArray(ph.dir).normalize();
    this.sun.position.copy(d).multiplyScalar(60);
    this.rim.intensity = 0.35 * (1 - ph.night * 0.6);
    this.lavaMat.emissiveIntensity = 0.55 + ph.night * 0.5;
    if (this.hooks.sky) this.hooks.sky('#' + hexMix(a.top, b.top, s).getHexString(), '#' + hexMix(a.bot, b.bot, s).getHexString(), ph.night);
    if (this.cloudMat) this.tintClouds();
  };

  // ---- clouds & rain ----
  R.buildClouds = function () {
    this.cloudMat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.82, depthWrite: false });
    this.clouds = [];
    const rnd = PB.mulberry(31);
    for (let k = 0; k < 5; k++) {
      const g = new THREE.Group();
      g.userData.mat = this.cloudMat.clone();
      const n = 3 + ((rnd() * 3) | 0);
      for (let j = 0; j < n; j++) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(2 + rnd() * 3, 0.9 + rnd() * 0.8, 1.6 + rnd() * 2.2), g.userData.mat);
        m.position.set(j * 1.6 - n * 0.8 + rnd(), rnd() * 0.6, (rnd() - 0.5) * 2);
        m.castShadow = true;
        g.add(m);
      }
      g.position.set(rnd() * 60 - 30, H + 7 + rnd() * 4, rnd() * 34 - 5);
      g.userData.speed = 0.4 + rnd() * 0.5;
      this.clouds.push(g); this.root.add(g);
    }
  };
  R.tintClouds = function () {
    const rain = this.world.raining;
    const base = new THREE.Color(rain ? 0x9aa4b4 : 0xffffff).lerp(new THREE.Color(0x6a74a8), this.ph.night * 0.7);
    this.cloudMat.color.copy(base);
    this.clouds.forEach(c => c.userData.mat.color.copy(base));
  };
  R.buildRain = function () {
    const n = 260;
    this.rainN = n;
    this.rainPos = new Float32Array(n * 6);
    this.rainStop = new Float32Array(n);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.rain = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xcfeaff, transparent: true, opacity: 0.55 }));
    this.rain.frustumCulled = false; this.rain.visible = false;
    this.root.add(this.rain);
    for (let k = 0; k < n; k++) this.resetDrop(k, true);
  };
  R.resetDrop = function (k, scatter) {
    const x = Math.random() * W, z = Math.random() * D;
    const y = scatter ? Math.random() * (H + 4) : H + 3 + Math.random() * 3;
    const hx = Math.min(W - 1, x | 0), hz = Math.min(D - 1, z | 0);
    this.rainStop[k] = this.heights ? this.heights[hx + hz * W] + 1 : 0;
    this.rainPos.set([x, y, z, x - 0.05, y + 0.7, z - 0.05], k * 6);
  };

  // =================================================================
  // Meshing
  // per face and corner: the three neighbours (side, side, diagonal) that darken it
  const AO_OFF = FACES.map(F => {
    const ax = F.n[0] ? 0 : F.n[1] ? 1 : 2, u = (ax + 1) % 3, v = (ax + 2) % 3;
    return F.c.map(c => {
      const du = c[u] ? 1 : -1, dv = c[v] ? 1 : -1;
      const a = F.n.slice(), b = F.n.slice(), d = F.n.slice();
      a[u] += du; b[v] += dv; d[u] += du; d[v] += dv;
      return [a, b, d];
    });
  });

  R.rebuildSolid = function () {
    const w = this.world, type = w.type;
    if (!this.solidBuf) { this.solidBuf = new FBuf(); this.glowBuf = new FBuf(); }
    const buf = this.solidBuf, glow = this.glowBuf;
    buf.reset(); glow.reset();
    const L = W * D;
    const op = (x, y, z) => (x >= 0 && y >= 0 && z >= 0 && x < W && y < H && z < D && OPAQUE[type[x + z * W + y * L]]) | 0;
    const S = this.surfaces; S.vents = []; S.lanterns = []; S.grass = [];
    const br = [0, 0, 0, 0], ps = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]], cs = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const setC = (k, c, b) => { cs[k][0] = c[0] * b; cs[k][1] = c[1] * b; cs[k][2] = c[2] * b; };

    for (let y = 0; y < H; y++) for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
      const t = type[x + z * W + y * L];
      if (!t) continue;
      if (!OPAQUE[t]) { this.decor(buf, glow, t, x, y, z, op); continue; }
      const openAbove = !op(x, y + 1, z);
      if (t === T.GRASS && openAbove) S.grass.push([x, y, z]);
      if (t === T.VENT) S.vents.push([x, y, z]);
      for (let f = 0; f < 6; f++) {
        if (f === 3 && y === 0) continue;
        const F = FACES[f];
        if (op(x + F.n[0], y + F.n[1], z + F.n[2])) continue;
        const AOf = AO_OFF[f];
        for (let k = 0; k < 4; k++) {
          const [a, b, d] = AOf[k];
          const s1 = op(x + a[0], y + a[1], z + a[2]), s2 = op(x + b[0], y + b[1], z + b[2]);
          br[k] = AO[s1 && s2 ? 0 : 3 - (s1 + s2 + op(x + d[0], y + d[1], z + d[2]))];
          const c = F.c[k];
          ps[k][0] = x + c[0]; ps[k][1] = y + c[1]; ps[k][2] = z + c[2];
        }
        const col = this.faceColor(t, x, y, z, f);
        const target = (t === T.VENT && f === 2) ? glow : buf;
        if (col.band && f !== 2 && f !== 3 && openAbove) {
          // grass and snow wrap a lip over the side, like the reference
          const k = 1 - col.band;
          const m0 = [ps[0][0], ps[0][1] + k, ps[0][2]], m1 = [ps[1][0], ps[1][1] + k, ps[1][2]];
          const b0 = br[0] + (br[3] - br[0]) * k, b1 = br[1] + (br[2] - br[1]) * k;
          setC(0, col.c, br[0]); setC(1, col.c, br[1]); setC(2, col.c, b1); setC(3, col.c, b0);
          target.quad([ps[0], ps[1], m1, m0], F.n, cs);
          setC(0, col.top, b0); setC(1, col.top, b1); setC(2, col.top, br[2]); setC(3, col.top, br[3]);
          target.quad([m0, m1, ps[2], ps[3]], F.n, cs);
        } else {
          for (let k = 0; k < 4; k++) setC(k, col.c, br[k]);
          target.quad(ps, F.n, cs, 0, 0, br[0] + br[2] < br[1] + br[3]);
        }
      }
    }
    buf.apply(this.meshes.solid); glow.apply(this.meshes.glow);
    // column heights for rain
    for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) this.heights[x + z * W] = w.topY(x, z);
  };

  R.faceColor = function (t, x, y, z, f) {
    const top = f === 2;
    const stripe = (base, dark, light) => (y % 4 === 0 ? dark : y % 4 === 2 ? light : base);
    switch (t) {
      case T.GRASS:
        if (top) return { c: jit(pick(P.grass, x, 0, z, 1), x, y, z) };
        return { c: jit(stripe(P.dirt, P.dirtDark, P.dirtLight), x, y, z), top: jit(P.grassSide, x, y, z), band: 0.28 };
      case T.DIRT: return { c: jit(top ? P.dirtLight : stripe(P.dirt, P.dirtDark, P.dirtLight), x, y, z) };
      case T.STONE: return { c: jit(pick(P.stone, x, y, z, 2), x, y, z) };
      case T.SAND: return { c: jit(top ? pick(P.sand, x, 0, z, 3) : (y % 3 === 0 ? P.sandSide : P.sand[0]), x, y, z) };
      case T.SNOW:
        if (top) return { c: jit(pick(P.snow, x, 0, z, 4), x, y, z) };
        return { c: jit(stripe(P.dirt, P.dirtDark, P.dirtLight), x, y, z), top: P.snow[0], band: 0.36 };
      case T.LOG: return { c: top ? P.logTop : jit(P.log, x, y, z) };
      case T.LEAVES: return { c: jit(pick(P.leaves, x, y, z, 5), x, y, z) };
      case T.BLOSSOM: return { c: jit(pick(P.blossom, x, y, z, 5), x, y, z) };
      case T.AUTUMN: return { c: jit(pick(P.autumn, x, y, z, 5), x, y, z) };
      case T.PINE: return { c: jit(pick(P.pine, x, y, z, 5), x, y, z) };
      case T.PLANK: return { c: (y % 2 ? P.plank : P.plankDark) };
      case T.BRICK: return { c: jit(pick(P.brick, x, y, z, 6), x, y, z) };
      case T.OBSIDIAN: return { c: jit(pick(P.obsidian, x, y, z, 7), x, y, z) };
      case T.BASALT: return { c: jit(pick(P.basalt, x, y, z, 7), x, y, z) };
      case T.SPRING: return { c: top ? P.spring : jit(P.stone[0], x, y, z) };
      case T.VENT: return { c: top ? P.vent : jit(P.basalt[1], x, y, z) };
      case T.MOSS: return { c: jit(pick(P.moss, x, y, z, 8), x, y, z) };
      default: return { c: [1, 0, 1] };
    }
  };

  R.decor = function (buf, glow, t, x, y, z, op) {
    const h = (s) => hash3(x, y, z, s);
    if (t === T.FLOWER) {
      const ox = (h(1) - 0.5) * 0.4, oz = (h(2) - 0.5) * 0.4, sh = 0.22 + h(3) * 0.2;
      buf.box(x + 0.46 + ox, y, z + 0.46 + oz, x + 0.54 + ox, y + sh, z + 0.54 + oz, P.stem);
      buf.box(x + 0.36 + ox, y + sh, z + 0.36 + oz, x + 0.64 + ox, y + sh + 0.2, z + 0.64 + oz, pick(P.flowers, x, y, z, 4));
      buf.box(x + 0.45 + ox, y + sh + 0.2, z + 0.45 + oz, x + 0.55 + ox, y + sh + 0.24, z + 0.55 + oz, [1, 0.9, 0.4]);
    } else if (t === T.TUFT) {
      for (let k = 0; k < 3; k++) {
        const ox = 0.2 + h(k + 1) * 0.55, oz = 0.2 + h(k + 5) * 0.55, hh = 0.2 + h(k + 9) * 0.3;
        buf.box(x + ox, y, z + oz, x + ox + 0.09, y + hh, z + oz + 0.09, pick(P.tuft, x + k, y, z, 3));
      }
    } else if (t === T.SAPLING) {
      buf.box(x + 0.45, y, z + 0.45, x + 0.55, y + 0.45, z + 0.55, P.log);
      buf.box(x + 0.28, y + 0.35, z + 0.4, x + 0.48, y + 0.5, z + 0.6, P.leaves[2]);
      buf.box(x + 0.52, y + 0.42, z + 0.4, x + 0.72, y + 0.57, z + 0.6, P.leaves[0]);
    } else if (t === T.MUSHROOM) {
      buf.box(x + 0.43, y, z + 0.43, x + 0.57, y + 0.22, z + 0.57, P.shroomStem);
      buf.box(x + 0.28, y + 0.22, z + 0.28, x + 0.72, y + 0.4, z + 0.72, P.shroomCap);
      buf.box(x + 0.34, y + 0.4, z + 0.34, x + 0.42, y + 0.42, z + 0.42, P.shroomStem);
      buf.box(x + 0.56, y + 0.4, z + 0.5, x + 0.64, y + 0.42, z + 0.58, P.shroomStem);
    } else if (t === T.CACTUS) {
      const top = this.world.get(x, y + 1, z) !== T.CACTUS;
      const c = jit(pick(P.cactus, x, y, z, 2), x, y, z);
      buf.box(x + 0.16, y, z + 0.16, x + 0.84, y + 1, z + 0.84, c);
      buf.box(x + 0.12, y + 0.15, z + 0.46, x + 0.16, y + 0.9, z + 0.54, mul(c, 0.85));
      buf.box(x + 0.84, y + 0.15, z + 0.46, x + 0.88, y + 0.9, z + 0.54, mul(c, 0.85));
      if (top && h(5) < 0.5) buf.box(x + 0.4, y + 1, z + 0.4, x + 0.6, y + 1.12, z + 0.6, P.flowers[0]);
    } else if (t === T.LANTERN) {
      const onGround = op(x, y - 1, z);
      const y0 = onGround ? y : y + 0.3;
      glow.box(x + 0.32, y0 + 0.05, z + 0.32, x + 0.68, y0 + 0.45, z + 0.68, P.lantern);
      buf.box(x + 0.27, y0 + 0.45, z + 0.27, x + 0.73, y0 + 0.53, z + 0.73, P.lanternCap);
      buf.box(x + 0.3, y0, z + 0.3, x + 0.7, y0 + 0.05, z + 0.7, P.lanternCap);
      if (!onGround) buf.box(x + 0.48, y0 + 0.53, z + 0.48, x + 0.52, y + 1, z + 0.52, P.lanternCap);
      this.surfaces.lanterns.push([x + 0.5, y0 + 0.3, z + 0.5]);
    }
  };

  // Ease the displayed fluid toward the simulation, so levels glide between ticks.
  R.smoothFluids = function (dt) {
    const w = this.world, { fluid, mass, type } = w;
    const dm = this.dm, df = this.df, dFall = this.dFall, dEdge = this.dEdge;
    const k = 1 - Math.exp(-dt * 8), kf = 1 - Math.exp(-dt * 4);
    let any = false;
    for (let i = 0; i < PB.N; i++) {
      const f = fluid[i];
      if (!f && !df[i]) continue;
      if (isSolid(type[i])) { df[i] = 0; dm[i] = dFall[i] = dEdge[i] = 0; continue; }
      if (f && df[i] !== f) { df[i] = f; dm[i] = 0; }
      const target = f ? Math.min(1.05, mass[i]) : 0;
      dm[i] += (target - dm[i]) * k;
      dFall[i] += ((f ? w.fallIn[i] : 0) - dFall[i]) * kf;
      dEdge[i] += ((f ? w.edgeOut[i] : 0) - dEdge[i]) * kf;
      if (!f && dm[i] < 0.012) { df[i] = 0; dm[i] = dFall[i] = dEdge[i] = 0; continue; }
      any = true;
    }
    return any;
  };

  R.rebuildFluids = function () {
    const w = this.world, type = w.type, dm = this.dm, df = this.df, dFall = this.dFall, dEdge = this.dEdge;
    const wb = this.waterBuf, lb = this.lavaBuf;
    wb.reset(); lb.reset();
    const S = this.surfaces; S.water = []; S.lava = [];
    const L = W * D;
    const has = (i, f) => df[i] === f && dm[i] > 0.012;
    const coveredAt = (i, f, y) => y + 1 < H && has(i + L, f);
    // a cell under more fluid counts as full only once it really is (a stream landing in a puddle stays shallow)
    const isFull = (i, f, y) => coveredAt(i, f, y) && dm[i] > 0.9;
    const hOf = (i, f, y) => (isFull(i, f, y) ? 1 : Math.max(0.05, Math.min(1, dm[i])));
    // a corner's height is shared by the (up to) four cells around it, so neighbouring surfaces meet exactly
    const corner = (x, y, z, cx, cz, f) => {
      let s = 0, n = 0;
      for (let dz = cz - 1; dz <= cz; dz++) for (let dx = cx - 1; dx <= cx; dx++) {
        const xx = x + dx, zz = z + dz;
        if (xx < 0 || zz < 0 || xx >= W || zz >= D) continue;
        const i = xx + zz * W + y * L;
        if (!has(i, f)) continue;
        s += hOf(i, f, y); n++;
      }
      return n ? s / n : 0.05;
    };
    const SIDES = [[1, 0, 0], [-1, 0, 1], [0, 1, 4], [0, -1, 5]];   // dx, dz, face index

    for (let y = 0; y < H; y++) for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
      const i = x + z * W + y * L, f = df[i];
      if (!f || dm[i] <= 0.012) continue;
      const buf = f === WATER ? wb : lb;
      const fed = coveredAt(i, f, y);            // something pours in from above
      const covered = fed && dm[i] > 0.9;
      const below = y > 0 ? i - L : -1;
      const belowSolid = below >= 0 && OPAQUE[type[below]];
      const belowFull = below >= 0 && has(below, f) && dm[below] > 0.9;
      const falling = !belowSolid && !belowFull;
      const m = Math.min(1, dm[i]);

      let col;
      if (f === WATER) {
        let d = 0;
        for (let k = 1; k <= 3 && y - k >= 0; k++) { const j = i - k * L; if (!has(j, f)) break; d += Math.min(1, dm[j]); }
        col = mix(P.waterShallow, P.water, Math.min(1, (d + m) / 3.2));
        col = mix(col, P.foam, Math.min(0.6, dFall[i] * 2.5 + (falling ? 0.28 : 0)));
      } else {
        const r = hash3(x, y, z, 11);
        col = r < 0.2 && !falling ? P.lavaCrust : mix(P.lava, P.lavaHot, falling ? 0.8 : r);
      }
      const flow = Math.min(1, dFall[i] * 5 + (falling ? 0.7 : 0));

      // tops of the four corners (x0z0, x1z0, x1z1, x0z1)
      let h = covered ? [1, 1, 1, 1] : [corner(x, y, z, 0, 0, f), corner(x, y, z, 1, 0, f), corner(x, y, z, 1, 1, f), corner(x, y, z, 0, 1, f)];
      // where a stream starts to fall, give it some body instead of a flat sliver
      if (falling && !covered) h = h.map(v => Math.max(v, Math.min(0.6, 0.15 + m * 3)));
      const hAt = (cx, cz) => h[cx ? (cz ? 2 : 1) : (cz ? 3 : 0)];
      // a falling trickle narrows to a stream, except where it joins neighbouring fluid
      const wd = falling ? Math.max(0.34, Math.min(1, 0.26 + 1.4 * Math.sqrt(m))) : 1;
      const ins = (1 - wd) / 2;
      const nb = SIDES.map(([dx, dz]) => {
        const xx = x + dx, zz = z + dz;
        if (xx < 0 || zz < 0 || xx >= W || zz >= D) return 0;
        const j = i + dx + dz * W;
        return OPAQUE[type[j]] ? 2 : has(j, f) ? 1 : 0;   // 2 solid, 1 same fluid, 0 open
      });
      // narrow only on open sides: a stream joins neighbouring water and clings to walls
      const x0 = x + (falling && nb[1] === 0 ? ins : 0), x1 = x + 1 - (falling && nb[0] === 0 ? ins : 0);
      const z0 = z + (falling && nb[3] === 0 ? ins : 0), z1 = z + 1 - (falling && nb[2] === 0 ? ins : 0);
      const px = c => (c ? x1 : x0), pz = c => (c ? z1 : z0);
      const wave = covered ? 0 : 1;

      // top
      if (!covered && !(y + 1 < H && OPAQUE[type[i + L]] && m > 0.97)) {
        const F = FACES[2];
        buf.quad(F.c.map(c => [px(c[0]), y + hAt(c[0], c[2]), pz(c[2])]), F.n, col, wave, Math.min(0.5, dFall[i] * 3));
        (f === WATER ? S.water : S.lava).push([x + 0.5, y + m, z + 0.5]);
      }
      // sides
      const sc = mul(col, 0.9);
      for (let s = 0; s < 4; s++) {
        if (nb[s] === 2) continue;
        const F = FACES[SIDES[s][2]];
        const tops = F.c.map(c => hAt(c[0], c[2]));
        let bots = [0, 0, 0, 0];
        if (nb[s] === 1) {
          // only the part of this cell that stands above its neighbour (e.g. the lip of a falling column)
          const j = i + SIDES[s][0] + SIDES[s][1] * W;
          if (!coveredAt(j, f, y) && covered) bots = F.c.map(c => corner(x, y, z, c[0], c[2], f));
          else continue;
        }
        const ps = F.c.map((c, k) => [px(c[0]), y + (c[1] ? tops[k] : bots[k]), pz(c[2])]);
        if (ps[3][1] - ps[0][1] < 0.01 && ps[2][1] - ps[1][1] < 0.01) continue;
        buf.quad(ps, F.n, sc, F.c.map(c => (c[1] ? wave : 0)), flow);
      }
      // the stream from above entering this shallow cell
      if (fed && !covered) {
        const ma = Math.min(1, dm[i + L]);
        const wa = Math.max(0.34, Math.min(1, 0.26 + 1.4 * Math.sqrt(ma)));
        const a = (1 - wa) / 2, base = y + Math.min(h[0], h[1], h[2], h[3]) - 0.02;
        const fc = mix(col, P.foam, f === WATER ? 0.3 : 0);
        for (let s = 0; s < 4; s++) {
          if (nb[s] === 2) continue;
          const F = FACES[SIDES[s][2]];
          const ps = F.c.map(c => [x + (c[0] ? 1 - a : a), c[1] ? y + 1 : base, z + (c[2] ? 1 - a : a)]);
          buf.quad(ps, F.n, mul(fc, 0.9), 0, 1);
        }
      }
      // underside of a stream hanging in the air
      if (below >= 0 && !belowSolid && !has(below, f)) {
        const F = FACES[3];
        buf.quad(F.c.map(c => [px(c[0]), y, pz(c[2])]), F.n, col, 0, flow);
      }

      // a sheet of water pouring over the island's edge, down its side
      if (dEdge[i] > 0.0015 && !covered) {
        const ww = Math.max(0.35, Math.min(1, 0.35 + dEdge[i] * 22));
        const top = y + Math.min(hAt(0, 0), hAt(1, 1)) - 0.02, bot = -1.2;
        const fc = mix(col, f === WATER ? P.foam : P.lavaHot, 0.35);
        for (let s = 0; s < 4; s++) {
          const [dx, dz, fi] = SIDES[s];
          const xx = x + dx, zz = z + dz;
          if (!(xx < 0 || zz < 0 || xx >= W || zz >= D)) continue;
          const F = FACES[fi], o = 0.04, a = (1 - ww) / 2;
          const ps = F.c.map(c => {
            const ex = dx ? (dx > 0 ? x + 1 + o : x - o) : x + (c[0] ? 1 - a : a);
            const ez = dz ? (dz > 0 ? z + 1 + o : z - o) : z + (c[2] ? 1 - a : a);
            return [ex, c[1] ? top : bot, ez];
          });
          buf.quad(ps, F.n, [fc, fc, col, col], 0, 1);
        }
      }
    }
    wb.apply([this.meshes.waterDepth, this.meshes.water]);
    lb.apply(this.meshes.lava);
  };

  // falling sand and friends, placed between simulation ticks
  R.updateFalling = function (alpha) {
    const list = this.world.falling, m = this.fallMesh;
    const M = new THREE.Matrix4(), c = new THREE.Color();
    m.count = Math.min(list.length, 256);
    for (let k = 0; k < m.count; k++) {
      const e = list[k];
      const y = e.py + (e.y - e.py) * alpha;
      M.makeTranslation(e.x + 0.5, y + 0.5, e.z + 0.5);
      m.setMatrixAt(k, M);
      const fc = this.faceColor(e.t, e.x, 0, e.z, 2).c;
      m.setColorAt(k, c.setRGB(fc[0], fc[1], fc[2]));
    }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  };

  // =================================================================
  // Picking: march the camera ray through the voxel grid
  R.pick = function (clientX, clientY, wantFluid) {
    const rect = this.r.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.cam);
    const o = this.raycaster.ray.origin.clone().sub(this.root.position);
    const d = this.raycaster.ray.direction;
    // slab test against the world box
    let t0 = -Infinity, t1 = Infinity, axis = -1;
    const lo = [0, 0, 0], hi = [W, H, D], oo = [o.x, o.y, o.z], dd = [d.x, d.y, d.z];
    for (let a = 0; a < 3; a++) {
      if (Math.abs(dd[a]) < 1e-9) { if (oo[a] < lo[a] || oo[a] > hi[a]) return null; continue; }
      let ta = (lo[a] - oo[a]) / dd[a], tb = (hi[a] - oo[a]) / dd[a];
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      if (ta > t0) { t0 = ta; axis = a; }
      if (tb < t1) t1 = tb;
    }
    if (t0 > t1 || t1 < 0) return null;
    const p = oo.map((v, a) => v + dd[a] * (t0 + 1e-4));
    const c = p.map((v, a) => Math.min(hi[a] - 1, Math.max(0, Math.floor(v))));
    const step = dd.map(v => (v > 0 ? 1 : -1));
    const tDelta = dd.map(v => Math.abs(1 / v));
    const tMax = dd.map((v, a) => {
      const edge = v > 0 ? c[a] + 1 : c[a];
      return Math.abs(v) < 1e-9 ? Infinity : (edge - p[a]) / v;
    });
    const n = [0, 0, 0];
    if (axis >= 0) n[axis] = -step[axis];
    const w = this.world;
    for (let k = 0; k < 120; k++) {
      const i = idx(c[0], c[1], c[2]), t = w.type[i];
      if (t !== T.AIR) return { x: c[0], y: c[1], z: c[2], n: n.slice(), t };
      if (wantFluid && w.fluid[i] && w.mass[i] > 0.2) return { x: c[0], y: c[1], z: c[2], n: n.slice(), t: 0, fluid: w.fluid[i] };
      let a = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
      c[a] += step[a]; tMax[a] += tDelta[a];
      n[0] = n[1] = n[2] = 0; n[a] = -step[a];
      if (c[a] < 0 || c[a] >= hi[a]) return null;
    }
    return null;
  };
  R.showCursor = function (cell, color) {
    if (!cell) { this.cursor.visible = false; return; }
    this.cursor.visible = true;
    this.cursor.position.set(cell[0] + 0.5, cell[1] + 0.5, cell[2] + 0.5);
    this.cursor.material.color.set(color);
    this.cursorFill.material.color.set(color);
  };

  // =================================================================
  // Effects from simulation events
  R.handleEvents = function (events) {
    const fx = this.fx, gfx = this.glowFx, rnd = Math.random;
    const steam = C(0xf4f8ff), drop = C(0xbff4ff), ember = C(0xff9a3a), dark = C(0x4a3a3a), dust = C(0xf0d8a0);
    for (const e of events) {
      const { x, y, z } = e;
      switch (e.k) {
        case 'steam': case 'melt': case 'sizzle':
          for (let k = 0; k < (e.k === 'sizzle' ? 2 : 9); k++) fx.spawn(x + (rnd() - 0.5) * 0.8, y + rnd() * 0.4, z + (rnd() - 0.5) * 0.8, (rnd() - 0.5) * 0.6, 1 + rnd() * 1.6, (rnd() - 0.5) * 0.6, steam, 0.32 + rnd() * 0.3, 1.2 + rnd(), -0.4, 0.8);
          break;
        case 'splash':
          for (let k = 0; k < 3; k++) fx.spawn(x + (rnd() - 0.5) * 0.6, y + 0.9, z + (rnd() - 0.5) * 0.6, (rnd() - 0.5) * 2, 2 + rnd() * 2, (rnd() - 0.5) * 2, e.a === LAVA ? ember : drop, 0.14, 0.6, 9);
          break;
        case 'spill': {
          const lava = e.a === LAVA;
          const p = lava ? gfx : fx;
          for (let k = 0; k < 4; k++) p.spawn(x + (rnd() - 0.5) * 0.8, y - rnd() * 0.3, z + (rnd() - 0.5) * 0.8, (x - W / 2) * 0.03 + (rnd() - 0.5) * 0.3, -rnd() * 0.5, (z - D / 2) * 0.03 + (rnd() - 0.5) * 0.3,
            lava ? ember : mix(P.waterShallow, P.foam, rnd() * 0.7), 0.2 + rnd() * 0.2, 2.4, 14, 0.4);
          break;
        }
        case 'burn':
          for (let k = 0; k < 6; k++) gfx.spawn(x + (rnd() - 0.5), y + rnd() * 0.5, z + (rnd() - 0.5), (rnd() - 0.5), 1.5 + rnd() * 2, (rnd() - 0.5), ember, 0.16, 1 + rnd(), 0, 0.5);
          for (let k = 0; k < 5; k++) fx.spawn(x + (rnd() - 0.5) * 0.6, y + 0.5, z + (rnd() - 0.5) * 0.6, (rnd() - 0.5) * 0.4, 1 + rnd(), (rnd() - 0.5) * 0.4, dark, 0.35, 1.6, -0.3, 0.5);
          break;
        case 'cool':
          for (let k = 0; k < 3; k++) fx.spawn(x, y + 0.3, z, (rnd() - 0.5) * 0.4, 0.8 + rnd(), (rnd() - 0.5) * 0.4, C(0x8a8090), 0.3, 1.4, -0.2, 0.6);
          break;
        case 'bloom': case 'tree': case 'pop': {
          const n = e.k === 'tree' ? 14 : e.k === 'bloom' ? 6 : 2;
          for (let k = 0; k < n; k++) {
            const col = e.k === 'pop' ? C(0xffffff) : pick(P.flowers, (rnd() * 99) | 0, 0, k, 1);
            gfx.spawn(x + (rnd() - 0.5), y + rnd() * 0.5, z + (rnd() - 0.5), (rnd() - 0.5) * 1.5, 1 + rnd() * 1.5, (rnd() - 0.5) * 1.5, mul(col, 0.8), 0.12, 0.8 + rnd() * 0.6, 2, 1.5);
          }
          break;
        }
        case 'uproot':
          for (let k = 0; k < 4; k++) fx.spawn(x, y, z, (rnd() - 0.5) * 2, 1 + rnd() * 2, (rnd() - 0.5) * 2, P.leaves[k % 3], 0.13, 0.8, 8);
          break;
        case 'thud': case 'dig': case 'place': {
          const col = e.a ? this.faceColor(e.a, x | 0, y | 0, z | 0, 2).c : dust;
          for (let k = 0; k < (e.k === 'thud' ? 4 : 8); k++) fx.spawn(x + (rnd() - 0.5) * 0.8, y + 0.5 + rnd() * 0.4, z + (rnd() - 0.5) * 0.8, (rnd() - 0.5) * 3, 1.5 + rnd() * 2.5, (rnd() - 0.5) * 3, col, 0.15 + rnd() * 0.1, 0.7 + rnd() * 0.4, 10, 1);
          break;
        }
        case 'pour': {
          const lava = e.a === LAVA;
          (lava ? gfx : fx).spawn(x + (rnd() - 0.5) * 0.3, y, z + (rnd() - 0.5) * 0.3, 0, -3, 0, lava ? ember : mix(P.waterShallow, P.foam, 0.4), 0.22, 0.35, 10);
          break;
        }
      }
    }
  };

  // ambient particles: glints, embers, smoke, fireflies, lantern motes
  R.ambient = function (dt, t) {
    const S = this.surfaces, rnd = Math.random, night = this.ph.night;
    if (S.water.length && rnd() < dt * Math.min(12, S.water.length * 0.1) * (1 - night * 0.7)) {
      const [x, y, z] = S.water[(rnd() * S.water.length) | 0];
      this.glowFx.spawn(x + (rnd() - 0.5) * 0.8, y + 0.06, z + (rnd() - 0.5) * 0.8, 0, 0, 0, [0.9, 1, 1], 0.12, 0.35, 0);
    }
    if (S.lava.length && rnd() < dt * Math.min(14, S.lava.length * 0.2)) {
      const [x, y, z] = S.lava[(rnd() * S.lava.length) | 0];
      this.glowFx.spawn(x + (rnd() - 0.5) * 0.8, y + 0.1, z + (rnd() - 0.5) * 0.8, (rnd() - 0.5) * 0.3, 0.8 + rnd() * 1.2, (rnd() - 0.5) * 0.3, mix(P.lavaHot, P.lava, rnd()), 0.12, 1.2 + rnd(), 0.2, 0.3);
    }
    const erupting = this.world.tick % 900 < 380;
    for (const [x, y, z] of S.vents) {
      if (rnd() < dt * (erupting ? 6 : 1.5)) this.fx.spawn(x + 0.5 + (rnd() - 0.5) * 0.6, y + 2, z + 0.5 + (rnd() - 0.5) * 0.6, (rnd() - 0.5) * 0.3 + 0.25, 1.5 + rnd(), (rnd() - 0.5) * 0.3, mix(C(0x9a96a4), C(0xe0dce8), rnd()), 0.6 + rnd() * 0.5, 4 + rnd() * 2, -0.05, 0.15);
    }
    if (night > 0.5 && S.grass.length && this.glowFx.n < 600 && rnd() < dt * 6 * night) {
      const [x, y, z] = S.grass[(rnd() * S.grass.length) | 0];
      this.glowFx.spawn(x + rnd(), y + 1.4 + rnd() * 1.5, z + rnd(), 0, 0, 0, [0.75, 1, 0.35], 0.13, 5 + rnd() * 4, 0, 0.6, true);
    }
  };

  // =================================================================
  // jump the displayed fluid straight to the simulation (new world, undo, load)
  R.snapFluids = function () {
    const w = this.world;
    for (let i = 0; i < PB.N; i++) {
      this.df[i] = w.fluid[i]; this.dm[i] = w.fluid[i] ? Math.min(1.05, w.mass[i]) : 0;
      this.dFall[i] = w.fallIn[i]; this.dEdge[i] = w.edgeOut[i];
    }
    this.rebuildFluids();
  };

  R.frame = function (dt, t, alpha) {
    this.uTime.value = t;
    const anyFluid = this.smoothFluids(dt);
    if (anyFluid || this.hadFluid) this.rebuildFluids();
    this.hadFluid = anyFluid;
    this.updateFalling(alpha || 0);
    if (this.phaseT < 1) { this.phaseT = Math.min(1, this.phaseT + dt / 2.5); this.applyPhase(this.phaseT); }

    // camera easing
    const e = 1 - Math.pow(0.0005, dt);
    let dy = this.yawGoal - this.yaw;
    this.yaw += dy * e; this.pitch += (this.pitchGoal - this.pitch) * e;
    this.zoom += (this.zoomGoal - this.zoom) * e;
    this.pan.lerp(this.panGoal, e);
    this.placeCamera();

    // clouds drift
    for (const c of this.clouds) {
      c.position.x += c.userData.speed * dt * (this.world.raining ? 1.8 : 1);
      if (c.position.x > W + 22) c.position.x = -22;
      // clouds fade out while over the island (their shadows still drift across it)
      const over = this.overIsland(c.position);
      const m = c.userData.mat;
      m.opacity += ((over ? 0 : 0.82) - m.opacity) * Math.min(1, dt * 2);
    }
    // rain
    this.rain.visible = this.world.raining;
    if (this.world.raining) {
      const p = this.rainPos;
      for (let k = 0; k < this.rainN; k++) {
        const o = k * 6, fall = 24 * dt;
        p[o + 1] -= fall; p[o + 4] -= fall; p[o] -= fall * 0.07; p[o + 3] -= fall * 0.07;
        if (p[o + 1] < this.rainStop[k]) {
          if (Math.random() < 0.3) this.fx.spawn(p[o], this.rainStop[k] + 0.05, p[o + 2], (Math.random() - 0.5), 1.2, (Math.random() - 0.5), [0.8, 0.95, 1], 0.1, 0.25, 8);
          this.resetDrop(k, false);
        }
      }
      this.rain.geometry.attributes.position.needsUpdate = true;
    }

    this.ambient(dt, t);
    this.fx.update(dt, t);
    this.glowFx.update(dt, t);
    this.r.render(this.scene, this.cam);
  };

  // is a point (island coords) drawn on top of the island on screen?
  R.overIsland = function (p) {
    const v = new THREE.Vector3(), lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    for (const x of [0, W]) for (const y of [0, 18]) for (const z of [0, D]) {
      v.set(x, y, z).add(this.root.position).project(this.cam);
      lo[0] = Math.min(lo[0], v.x); lo[1] = Math.min(lo[1], v.y); hi[0] = Math.max(hi[0], v.x); hi[1] = Math.max(hi[1], v.y);
    }
    v.copy(p).add(this.root.position).project(this.cam);
    const mx = (hi[0] - lo[0]) * 0.12, my = (hi[1] - lo[1]) * 0.08;
    return v.x > lo[0] - mx && v.x < hi[0] + mx && v.y > lo[1] - my && v.y < hi[1] + my;
  };

  R.snapshot = function () {
    this.r.render(this.scene, this.cam);
    return this.r.domElement.toDataURL('image/png');
  };

  window.PBRender = { Renderer, PHASES };
})();
