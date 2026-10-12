// Voxel Worlds: input, tools, sound, saving and the little discovery journal.
// In the Android app, storage.js restores saves before boot and mirrors writes to SQLite.

function startVoxelWorlds() {
  const { T, WATER, LAVA, DECOR, isSolid, idx, W, D, H, PRESETS } = PB;
  const $ = s => document.querySelector(s);
  const put = (k, v) => {
    if (window.Store) window.Store.set(k, v);
    else try { localStorage.setItem(k, v); } catch (e) { /* private mode */ }
  };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { put(k, JSON.stringify(v)); },
  };

  // ---------------------------------------------------------------
  // Tools & palettes
  const TOOLS = {
    build: { label: 'Build', color: 0xffffff },
    dig: { label: 'Dig', color: 0xff8a7a },
    water: { label: 'Water', color: 0x6fe6ff },
    lava: { label: 'Lava', color: 0xffa04a },
    plant: { label: 'Plant', color: 0xb6f07a },
  };
  const BLOCKS = [
    [T.GRASS, 'Grass', '#7fd04b', '#9a6b45'], [T.DIRT, 'Dirt', '#a87752', '#8a5c3c'], [T.STONE, 'Stone', '#a6a6b0', '#8a8a96'],
    [T.SAND, 'Sand', '#f6dc9e', '#dcb672', 'falls'], [T.SNOW, 'Snow', '#eafcff', '#b8d4dc', 'melts'], [T.PLANK, 'Planks', '#e0b278', '#c4915a'],
    [T.BRICK, 'Brick', '#da8a6a', '#b86450'], [T.LOG, 'Log', '#c09060', '#8a5a36'], [T.LEAVES, 'Leaves', '#8ad856', '#62b03a'],
    [T.BLOSSOM, 'Blossom', '#fbb4d2', '#e080aa'], [T.AUTUMN, 'Maple', '#fbbd4e', '#e08a2a'], [T.OBSIDIAN, 'Obsidian', '#4a3a78', '#2a2040'],
    [T.LANTERN, 'Lantern', '#ffe7a8', '#e0a040', 'glows'], [T.SPRING, 'Spring', '#74e4f6', '#8a8a96', 'water source'],
    [T.VENT, 'Vent', '#ff8a2a', '#4a4652', 'lava source'],
  ];
  const PLANTS = [
    ['tree', 'Tree', '🌳'], ['pine', 'Pine', '🌲'], ['palm', 'Palm', '🌴'], ['cactus', 'Cactus', '🌵'],
    ['flower', 'Flower', '🌷'], ['tuft', 'Grass', '🌿'], ['mushroom', 'Shroom', '🍄'],
  ];

  // ---------------------------------------------------------------
  // Discoveries
  const DISCOVERIES = [
    ['waterfall', 'Waterfall', 'Water spilled over the edge of the world'],
    ['lavafall', 'Lavafall', 'Lava poured off the edge'],
    ['obsidian', 'Obsidian', 'A pool of lava met water and set solid'],
    ['basalt', 'Basalt', 'A thin lava flow cooled into stone'],
    ['snowmelt', 'Snowmelt', 'Lava melted snow into fresh water'],
    ['wildfire', 'Wildfire', 'Lava set a plant alight'],
    ['bloom', 'Bloom', 'Flowers sprouted beside water'],
    ['tree', 'Sapling', 'You grew a tree'],
    ['sandslide', 'Sandslide', 'Sand tumbled under its own weight'],
    ['flood', 'Flash flood', 'Water swept a little plant away'],
    ['rain', 'Rainy day', 'Rain filled the hollows'],
    ['night', 'Starry night', 'The lanterns came on'],
    ['lake', 'Great lake', 'Over 400 cells of water at once'],
  ];
  const found = new Set(store.get('pb.found', []));

  // ---------------------------------------------------------------
  // Sound: a soft generative pad with water, lava and rain beds
  const Sound = {
    on: store.get('pb.sound', true), ctx: null,
    init() {
      if (this.ctx || !this.on) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = this.ctx = new AC();
      this.master = ctx.createGain(); this.master.gain.value = 0.8; this.master.connect(ctx.destination);
      const len = ctx.sampleRate * 2, nb = ctx.createBuffer(1, len, ctx.sampleRate), d = nb.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = (last + 0.04 * w) / 1.04; d[i] = i % 2 ? w * 0.5 : last * 3; }
      this.noise = nb;
      const bed = (type, freq, q) => {
        const src = ctx.createBufferSource(); src.buffer = nb; src.loop = true;
        const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
        const g = ctx.createGain(); g.gain.value = 0;
        src.connect(f); f.connect(g); g.connect(this.master); src.start();
        return { g, f };
      };
      this.water = bed('bandpass', 900, 0.6);
      this.lava = bed('lowpass', 140, 0.8);
      this.rain = bed('highpass', 1800, 0.4);
      this.padBus = ctx.createBiquadFilter(); this.padBus.type = 'lowpass'; this.padBus.frequency.value = 1400;
      this.padGain = ctx.createGain(); this.padGain.gain.value = 0.9;
      this.padBus.connect(this.padGain); this.padGain.connect(this.master);
      this.nextChord = ctx.currentTime + 0.5; this.chordIx = 0; this.nextNote = ctx.currentTime + 3; this.nextCritter = ctx.currentTime + 6;
    },
    toggle() {
      this.on = !this.on; store.set('pb.sound', this.on);
      if (this.on) { this.init(); this.ctx && this.ctx.resume(); } else if (this.ctx) this.ctx.suspend();
    },
    tone(freq, t0, dur, vol, type, dest, attack) {
      const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type || 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(vol, t0 + (attack || 0.008));
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(dest || this.master);
      o.start(t0); o.stop(t0 + dur + 0.05);
      return o;
    },
    burst(dur, vol, type, freq) {
      const ctx = this.ctx, t0 = ctx.currentTime;
      const s = ctx.createBufferSource(); s.buffer = this.noise;
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      s.connect(f); f.connect(g); g.connect(this.master);
      s.start(t0, Math.random()); s.stop(t0 + dur + 0.05);
    },
    ready() { return this.on && this.ctx && this.ctx.state === 'running'; },
    place(t) { if (!this.ready()) return; const f = 380 + (t * 37) % 300; const o = this.tone(f, this.ctx.currentTime, 0.18, 0.12, 'triangle'); o.frequency.exponentialRampToValueAtTime(f * 0.6, this.ctx.currentTime + 0.12); },
    dig() { if (!this.ready()) return; this.burst(0.16, 0.25, 'lowpass', 700); },
    scoop() { if (!this.ready()) return; const o = this.tone(300, this.ctx.currentTime, 0.2, 0.1); o.frequency.exponentialRampToValueAtTime(900, this.ctx.currentTime + 0.15); },
    sizzle() { if (!this.ready() || this.ctx.currentTime < (this._sz || 0)) return; this._sz = this.ctx.currentTime + 0.25; this.burst(0.5, 0.12, 'highpass', 3500); },
    twinkle() {
      if (!this.ready() || this.ctx.currentTime < (this._tw || 0)) return; this._tw = this.ctx.currentTime + 0.4;
      const s = [1046.5, 1174.7, 1318.5, 1568, 1760], t0 = this.ctx.currentTime;
      this.tone(s[(Math.random() * 5) | 0], t0, 0.6, 0.05);
    },
    arpeggio() { if (!this.ready()) return; const t0 = this.ctx.currentTime; [523.3, 659.3, 784, 1046.5].forEach((f, k) => this.tone(f, t0 + k * 0.09, 0.7, 0.07)); },
    chime() { if (!this.ready()) return; const t0 = this.ctx.currentTime; [784, 1174.7, 1568].forEach((f, k) => this.tone(f, t0 + k * 0.12, 1.4, 0.06)); },
    update(w, night, pouring) {
      if (!this.ready()) return;
      const ctx = this.ctx, now = ctx.currentTime, st = w.stats;
      const flowing = Math.sqrt(st.fall + st.spill * 3) + (pouring === WATER ? 0.6 : 0);
      this.water.g.gain.setTargetAtTime(Math.min(0.32, flowing * 0.14 + Math.min(0.03, st.water * 0.0001)), now, 0.4);
      this.water.f.frequency.setTargetAtTime(700 + Math.min(900, flowing * 500), now, 0.5);
      this.lava.g.gain.setTargetAtTime(Math.min(0.5, st.lava * 0.004 + (pouring === LAVA ? 0.2 : 0)), now, 0.6);
      this.rain.g.gain.setTargetAtTime(w.raining ? 0.09 : 0, now, 1.2);
      if (st.lava > 4 && Math.random() < 0.02) {           // lava blub
        const o = this.tone(90 + Math.random() * 60, now, 0.25, 0.18); o.frequency.exponentialRampToValueAtTime(40, now + 0.2);
      }
      // pad
      if (now > this.nextChord) {
        const chords = [[174.6, 261.6, 329.6, 440], [130.8, 196, 293.7, 329.6], [110, 164.8, 261.6, 392], [146.8, 220, 293.7, 370]];
        const ch = chords[this.chordIx++ % chords.length];
        ch.forEach((f, k) => this.tone(f * (night > 0.5 ? 0.5 : 1) * 2, now + k * 0.15, 9, 0.022, k % 2 ? 'triangle' : 'sine', this.padBus, 2.5));
        this.nextChord = now + 8;
      }
      // music-box notes
      if (now > this.nextNote) {
        const scale = [523.3, 587.3, 659.3, 784, 880, 1046.5];
        this.tone(scale[(Math.random() * scale.length) | 0], now, 1.6, 0.035, 'sine', this.padBus);
        this.nextNote = now + 2 + Math.random() * 5;
      }
      // birds by day, crickets by night
      if (now > this.nextCritter) {
        if (night > 0.6) {
          for (let k = 0; k < 3; k++) this.tone(4400, now + k * 0.07, 0.04, 0.012, 'sine');
          this.nextCritter = now + 0.8 + Math.random() * 1.6;
        } else if (!w.raining) {
          const f0 = 2400 + Math.random() * 1200;
          for (let k = 0; k < 2 + ((Math.random() * 3) | 0); k++) {
            const o = this.tone(f0, now + k * 0.13, 0.1, 0.018);
            o.frequency.exponentialRampToValueAtTime(f0 * 1.4, now + k * 0.13 + 0.08);
          }
          this.nextCritter = now + 5 + Math.random() * 9;
        } else this.nextCritter = now + 3;
      }
    },
  };

  // ---------------------------------------------------------------
  // World, renderer, state
  const world = new PB.World();
  const meta = Object.assign({ preset: 'valley', phase: 'day', auto: true, raining: false }, store.get('pb.meta', {}));
  let loaded = false;
  try { loaded = world.load(JSON.parse(localStorage.getItem('pb.world') || 'null')); } catch (e) { loaded = false; }
  if (!loaded) world.generate(meta.preset);
  world.raining = !!meta.raining;

  const sky = $('#sky'), stars = $('#stars');
  const view = new PBRender.Renderer($('#c'), world, {
    sky(top, bot, night) {
      sky.style.background = `linear-gradient(180deg, ${top} 0%, ${bot} 100%)`;
      stars.style.opacity = Math.max(0, night - 0.3) * 1.4;
      document.body.classList.toggle('night', night > 0.6);
    },
    lift() { return innerWidth < 760 ? 60 : 70; },
  });
  view.setPhase(meta.phase, true);
  view.rebuildSolid(); view.snapFluids();
  world.solidDirty = world.fluidDirty = false;

  const state = { tool: 'build', block: T.GRASS, plant: 'tree', pour: null, stroke: null, mode: store.get('pb.mode', 'explore') };
  const undo = [];

  // stars
  (function () {
    const c = document.createElement('canvas'); c.width = 600; c.height = 900;
    const g = c.getContext('2d');
    for (let k = 0; k < 160; k++) {
      const s = Math.random() < 0.15 ? 3 : 2;
      g.fillStyle = `rgba(255,255,240,${0.4 + Math.random() * 0.6})`;
      g.fillRect((Math.random() * 600) | 0, (Math.random() * 900) | 0, s, s);
    }
    stars.style.backgroundImage = `url(${c.toDataURL()})`;
  })();

  // ---------------------------------------------------------------
  // UI building
  function cubeIcon(top, side) {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d');
    const shade = (hex, k) => {
      const n = parseInt(hex.slice(1), 16);
      const r = Math.round(((n >> 16) & 255) * k), gg = Math.round(((n >> 8) & 255) * k), b = Math.round((n & 255) * k);
      return `rgb(${Math.min(255, r)},${Math.min(255, gg)},${Math.min(255, b)})`;
    };
    const face = (pts, col) => { g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); pts.slice(1).forEach(p => g.lineTo(p[0], p[1])); g.closePath(); g.fillStyle = col; g.fill(); };
    face([[32, 6], [56, 18], [32, 30], [8, 18]], top);
    face([[8, 18], [32, 30], [32, 58], [8, 46]], shade(side, 1));
    face([[56, 18], [32, 30], [32, 58], [56, 46]], shade(side, 0.78));
    if (top !== side) {      // a lip of the top colour, like grass and snow
      face([[8, 18], [32, 30], [32, 36], [8, 24]], shade(top, 0.92));
      face([[56, 18], [32, 30], [32, 36], [56, 24]], shade(top, 0.75));
    }
    return c.toDataURL();
  }

  const tray = $('#tray');
  function renderTray() {
    tray.innerHTML = '';
    const show = state.mode === 'edit' && (state.tool === 'build' || state.tool === 'plant');
    tray.classList.toggle('open', show);
    if (state.tool === 'build') {
      BLOCKS.forEach(([t, name, top, side, hint]) => {
        const b = document.createElement('button');
        b.className = 'swatch' + (state.block === t ? ' on' : '');
        b.innerHTML = `<img alt="" src="${cubeIcon(top, t === T.GRASS || t === T.SNOW ? side : side)}"><span>${name}</span>${hint ? `<small>${hint}</small>` : ''}`;
        b.onclick = () => { state.block = t; renderTray(); };
        tray.appendChild(b);
      });
    } else if (state.tool === 'plant') {
      PLANTS.forEach(([k, name, emo]) => {
        const b = document.createElement('button');
        b.className = 'swatch' + (state.plant === k ? ' on' : '');
        b.innerHTML = `<i>${emo}</i><span>${name}</span>`;
        b.onclick = () => { state.plant = k; renderTray(); };
        tray.appendChild(b);
      });
    }
    const on = tray.querySelector('.on');
    if (on) on.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
  document.querySelectorAll('.tools button').forEach(b => {
    b.onclick = () => {
      const t = b.dataset.tool;
      if (b.dataset.mode === 'explore') { setMode('explore'); return; }
      state.tool = state.tool === t && (t === 'build' || t === 'plant') && tray.classList.contains('open') ? t : t;
      document.querySelectorAll('.tools button').forEach(x => x.classList.toggle('on', x.dataset.tool === state.tool));
      renderTray();
      Sound.init();
    };
  });

  // ---------------------------------------------------------------
  // Explore mode: look around freely, nothing you touch changes the world
  function setMode(mode, quiet) {
    state.mode = mode;
    store.set('pb.mode', mode);
    document.body.classList.toggle('exploring', mode === 'explore');
    state.stroke = null; state.pour = null; view.showCursor(null);
    renderTray();
    if (quiet) return;
    haptic(6);
    if (mode === 'explore' && !store.get('pb.tipExplore', false)) {
      store.set('pb.tipExplore', true);
      toast('<b>Exploring</b><span>Drag to look around, pinch to zoom, double-tap to zoom in. Nothing changes until you tap Edit.</span>', 4200);
    }
  }
  $('#bEdit').onclick = () => { setMode('edit'); Sound.init(); };

  // Random worlds
  function surprise() {
    pushUndo();
    const seed = (Math.random() * 0xffffffff) >>> 0;
    const r = world.generateRandom(seed);
    meta.preset = 'random'; meta.seed = seed; saveMeta();
    view.resetWorld(); updateHeader();
    view.panGoal.set(0, 0, 0); view.zoomGoal = 1;
    const label = PB.THEMES[r.theme].label;
    toast(`<b>${r.name}</b><span>${label}</span>`, 2200);
    const d = $('#bSurprise svg'); if (d) { d.classList.remove('spin'); void d.getBBox; requestAnimationFrame(() => d.classList.add('spin')); }
    Sound.arpeggio(); haptic(10);
  }
  $('#bSurprise').onclick = () => { Sound.init(); surprise(); };

  const toastQ = [];
  let toastBusy = 0;
  function toast(html, ms) {
    if (performance.now() < toastBusy) { toastQ.push([html, ms]); return; }
    toastBusy = performance.now() + Math.min(ms || 3200, 1600);
    setTimeout(() => { if (toastQ.length) toast(...toastQ.shift()); }, Math.min(ms || 3200, 1600) + 50);
    const el = document.createElement('div');
    el.className = 'toast'; el.innerHTML = html;
    $('#toasts').appendChild(el);
    requestAnimationFrame(() => el.classList.add('in'));
    setTimeout(() => { el.classList.remove('in'); setTimeout(() => el.remove(), 400); }, ms || 3200);
  }
  function discover(key) {
    if (found.has(key) || $('#intro').classList.contains('open')) return;
    const d = DISCOVERIES.find(x => x[0] === key);
    if (!d) return;
    found.add(key); store.set('pb.found', [...found]);
    toast(`<b>✦ ${d[1]}</b><span>${d[2]}</span>`, 3800);
    Sound.chime();
    updateHeader();
  }
  function updateHeader() {
    $('#worldName').textContent = world.name || (PRESETS[meta.preset] ? PRESETS[meta.preset].name : 'My World');
    $('#disc').textContent = `✦ ${found.size} of ${DISCOVERIES.length} found`;
    $('#bRain').classList.toggle('on', world.raining);
    $('#bTime').dataset.phase = meta.phase;
  }

  // ---------------------------------------------------------------
  // Acting on the world
  function pushUndo() {
    undo.push(world.snapshot());
    if (undo.length > 20) undo.shift();
  }
  function cellKey(c) { return c ? c.join(',') : ''; }

  // where the current tool would act for a pick result
  function targetFor(hit) {
    if (!hit) return null;
    const tool = state.tool;
    if (tool === 'dig') return [hit.x, hit.y, hit.z];
    if (DECOR[hit.t]) return [hit.x, hit.y, hit.z];
    const c = [hit.x + hit.n[0], hit.y + hit.n[1], hit.z + hit.n[2]];
    if (!world.inB(c[0], c[1], c[2])) return null;
    if (tool === 'plant' && !(hit.n[1] === 1 && isSolid(hit.t))) return null;
    return c;
  }

  function act(c, hit) {
    const [x, y, z] = c;
    const i = idx(x, y, z);
    const tool = state.tool;
    if (tool === 'build') {
      if (isSolid(world.type[i])) return false;
      world.set(x, y, z, state.block);
      world.emit('place', x + 0.5, y, z + 0.5, state.block);
      if (state.block === T.SPRING) world.emit('spring', x, y, z);
      Sound.place(state.block); haptic(6);
      return true;
    }
    if (tool === 'dig') {
      if (hit && hit.fluid) {
        world.removeFluid(x, y, z);
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (world.inB(x + dx, y, z + dz) && world.fluid[idx(x + dx, y, z + dz)]) world.mass[idx(x + dx, y, z + dz)] *= 0.5;
        }
        world.emit('splash', x + 0.5, y, z + 0.5, hit.fluid);
        Sound.scoop(); haptic(5);
        return true;
      }
      const t = world.type[i];
      if (!t) return false;
      world.set(x, y, z, T.AIR);
      if (y + 1 < H && DECOR[world.type[i + PB.WD]]) world.set(x, y + 1, z, T.AIR);
      world.emit('dig', x + 0.5, y, z + 0.5, t);
      Sound.dig(); haptic(8);
      return true;
    }
    if (tool === 'plant') {
      if (isSolid(world.type[i]) || world.fluid[i]) return false;
      const p = state.plant;
      if (p === 'flower' || p === 'tuft' || p === 'mushroom') {
        world.set(x, y, z, p === 'flower' ? T.FLOWER : p === 'tuft' ? T.TUFT : T.MUSHROOM);
        world.emit('bloom', x + 0.5, y + 0.3, z + 0.5, 0);
        Sound.twinkle();
      } else {
        world.plantSapling(x, y, z, p === 'tree' ? undefined : p);
        world.emit('pop', x + 0.5, y + 0.2, z + 0.5, 0);
        Sound.place(40);
      }
      haptic(5);
      return true;
    }
    return false;
  }
  function haptic(ms) { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) { /* unsupported */ } }

  // ---------------------------------------------------------------
  // Input
  const canvas = $('#c');
  const pointers = new Map();
  let gesture = null, orbit = null, hover = null;

  function beginStroke(e) {
    const tool = state.tool;
    const hit = view.pick(e.clientX, e.clientY, tool === 'dig');
    const c = targetFor(hit);
    if (!c) { orbit = { x: e.clientX, y: e.clientY }; return; }
    pushUndo();
    const s = state.stroke = { t0: performance.now(), lockY: c[1], last: cellKey(c), cell: c, acted: 0 };
    if (tool === 'water' || tool === 'lava') { state.pour = { f: tool === 'water' ? WATER : LAVA, cell: c }; Sound.init(); }
    else if (act(c, hit)) s.acted++;
    view.showCursor(c, TOOLS[tool].color);
  }
  function moveStroke(e) {
    const s = state.stroke;
    const tool = state.tool;
    const hit = view.pick(e.clientX, e.clientY, tool === 'dig');
    const c = targetFor(hit);
    if (!c) return;
    if (state.pour) { state.pour.cell = c; view.showCursor(c, TOOLS[tool].color); return; }
    // keep drags on one layer so building doesn't climb toward the camera
    if (c[1] !== s.lockY) return;
    const k = cellKey(c);
    if (k === s.last) return;
    s.last = k;
    if (act(c, hit)) s.acted++;
    view.showCursor(c, TOOLS[tool].color);
  }
  function endStroke() {
    if (state.stroke && !state.stroke.acted && !state.pour) undo.pop();
    state.stroke = null; state.pour = null;
    if (!matchMedia('(hover: hover)').matches) view.showCursor(null);
  }

  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('pointerdown', e => {
    Sound.init(); if (Sound.ctx && Sound.ctx.state === 'suspended' && Sound.on) Sound.ctx.resume();
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    closeSheets();
    if (pointers.size === 2) {
      // second finger: this is a camera gesture, take back the accidental tap
      if (state.stroke) {
        const quick = performance.now() - state.stroke.t0 < 350 && state.stroke.acted <= 1;
        if (quick && state.stroke.acted && undo.length) { world.restore(undo.pop()); view.rebuildSolid(); view.snapFluids(); }
        state.stroke = null; state.pour = null; view.showCursor(null);
      }
      orbit = null;
      const [a, b] = [...pointers.values()];
      gesture = { d: Math.hypot(a.x - b.x, a.y - b.y), ang: Math.atan2(b.y - a.y, b.x - a.x), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, zoom: view.zoomGoal };
      return;
    }
    if (pointers.size > 2) return;
    if (e.button === 2 || e.button === 1 || e.altKey) { orbit = { x: e.clientX, y: e.clientY, pan: e.button === 1 }; return; }
    if (state.mode === 'explore') {
      orbit = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t0: performance.now() };
      return;
    }
    beginStroke(e);
  });
  canvas.addEventListener('pointermove', e => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (gesture && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), ang = Math.atan2(b.y - a.y, b.x - a.x);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      view.zoomGoal = Math.max(0.6, Math.min(3.2, gesture.zoom * d / gesture.d));
      let da = ang - gesture.ang; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI;
      view.yawGoal -= da; gesture.ang = ang;
      panBy(mx - gesture.mx, my - gesture.my); gesture.mx = mx; gesture.my = my;
      return;
    }
    if (orbit) {
      const dx = e.clientX - orbit.x, dy = e.clientY - orbit.y;
      orbit.x = e.clientX; orbit.y = e.clientY;
      if (orbit.pan) panBy(dx, dy);
      else { view.yawGoal -= dx * 0.008; view.pitchGoal = Math.max(0.22, Math.min(1.25, view.pitchGoal + dy * 0.005)); }
      return;
    }
    if (state.stroke) { moveStroke(e); return; }
    if (e.pointerType === 'mouse' && state.mode === 'edit') {
      hover = targetFor(view.pick(e.clientX, e.clientY, state.tool === 'dig'));
      view.showCursor(hover, TOOLS[state.tool].color);
    }
  });
  let lastTap = null;
  const up = e => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) gesture = null;
    // explore mode: a quick tap with no drag; two of them zoom in on that spot
    if (orbit && orbit.t0 && e.type === 'pointerup' && pointers.size === 0 &&
        Math.hypot(e.clientX - orbit.sx, e.clientY - orbit.sy) < 10 && performance.now() - orbit.t0 < 300) {
      const now = performance.now();
      if (lastTap && now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) { zoomToward(e.clientX, e.clientY); lastTap = null; }
      else lastTap = { t: now, x: e.clientX, y: e.clientY };
    }
    if (pointers.size === 0) { orbit = null; endStroke(); }
  };
  function zoomToward(cx, cy) {
    const hit = view.pick(cx, cy, true);
    if (!hit || view.zoomGoal > 2.6) { view.zoomGoal = 1; view.panGoal.set(0, 0, 0); return; }
    view.panGoal.set(hit.x + 0.5 - W / 2, hit.y + 0.5 + view.root.position.y - 3.5, hit.z + 0.5 - D / 2);
    view.zoomGoal = Math.min(3.2, view.zoomGoal * 1.8);
    haptic(5);
  }
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && !state.stroke) view.showCursor(null); });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    view.zoomGoal = Math.max(0.6, Math.min(3.2, view.zoomGoal * Math.exp(-e.deltaY * 0.0015)));
  }, { passive: false });

  function panBy(dx, dy) {
    const cam = view.cam;
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const upv = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    const s = 1 / (view.ppu * view.zoom);
    view.panGoal.addScaledVector(right, -dx * s).addScaledVector(upv, dy * s);
    if (view.panGoal.length() > 16) view.panGoal.setLength(16);
  }

  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    const keys = { 1: 'build', 2: 'dig', 3: 'water', 4: 'lava', 5: 'plant' };
    if (keys[e.key]) { if (state.mode === 'explore') setMode('edit', true); document.querySelector(`.tools [data-tool="${keys[e.key]}"]`).click(); }
    if (e.key === 'x') setMode(state.mode === 'explore' ? 'edit' : 'explore');
    if (e.key === 'r') surprise();
    if (e.key === 'q') rotate(-1);
    if (e.key === 'e') rotate(1);
    if ((e.key === 'z' && (e.ctrlKey || e.metaKey)) || e.key === 'u') doUndo();
    if (e.key === 'Escape') closeSheets();
  });

  function rotate(dir) {
    const q = Math.PI / 2;
    view.yawGoal = Math.round((view.yawGoal - Math.PI / 4) / q) * q + Math.PI / 4 + dir * q;
  }
  $('#rotL').onclick = () => rotate(-1);
  $('#rotR').onclick = () => rotate(1);

  function doUndo() {
    if (!undo.length) { toast('<span>Nothing to undo</span>', 1200); return; }
    const before = world.theme + '|' + world.name;
    world.restore(undo.pop());
    if (before !== world.theme + '|' + world.name) view.resetWorld(); else { view.rebuildSolid(); view.snapFluids(); }
    updateHeader();
    Sound.dig();
  }
  $('#bUndo').onclick = doUndo;

  const PHASE_ORDER = ['dawn', 'day', 'golden', 'night'];
  let phaseClock = 0;
  function setPhase(p) {
    meta.phase = p; view.setPhase(p); phaseClock = 0; saveMeta(); updateHeader();
    if (p === 'night') discover('night');
  }
  $('#bTime').onclick = () => setPhase(PHASE_ORDER[(PHASE_ORDER.indexOf(meta.phase) + 1) % 4]);
  $('#bRain').onclick = () => {
    world.raining = !world.raining; meta.raining = world.raining; saveMeta();
    view.tintClouds(); updateHeader();
    if (world.raining) { discover('rain'); toast('<span>Rain is falling. Watch the hollows fill.</span>', 2200); }
  };

  // ---------------------------------------------------------------
  // Sheets: menu, intro, photo
  const sheet = $('#sheet');
  function closeSheets() { sheet.classList.remove('open'); }
  $('#bMenu').onclick = () => { renderMenu(); sheet.classList.add('open'); };
  sheet.addEventListener('click', e => { if (e.target === sheet) closeSheets(); });

  function worldCards(onPick) {
    const wrap = document.createElement('div'); wrap.className = 'worlds';
    Object.entries(PRESETS).forEach(([k, p]) => {
      const b = document.createElement('button'); b.className = 'world ' + k;
      b.innerHTML = `<div class="art"></div><b>${p.name}</b><span>${p.blurb}</span>`;
      b.onclick = () => onPick(k);
      wrap.appendChild(b);
    });
    const rb = document.createElement('button'); rb.className = 'world random';
    rb.innerHTML = `<div class="art"><i>🎲</i></div><b>Surprise me</b><span>A brand-new random landscape every time.</span>`;
    rb.onclick = () => onPick('random');
    wrap.appendChild(rb);
    return wrap;
  }
  function newWorld(k) {
    pushUndo();
    meta.preset = k; world.generate(k); world.name = PRESETS[k].name; saveMeta(); updateHeader();
    view.resetWorld();
    view.panGoal.set(0, 0, 0); view.zoomGoal = 1;
  }
  function renderMenu() {
    const body = $('#sheetBody');
    body.innerHTML = '';
    const h = (tag, cls, html) => { const el = document.createElement(tag); if (cls) el.className = cls; if (html) el.innerHTML = html; body.appendChild(el); return el; };
    h('div', 'grab');
    h('h2', '', 'New world');
    h('p', 'muted', 'Your current world is replaced. Undo brings it back.');
    body.appendChild(worldCards(k => {
      closeSheets();
      if (k === 'random') { surprise(); return; }
      newWorld(k); toast(`<b>${PRESETS[k].name}</b><span>${PRESETS[k].blurb}</span>`, 2600);
    }));
    h('h2', '', `Discoveries <small>${found.size}/${DISCOVERIES.length}</small>`);
    const list = h('div', 'disc');
    DISCOVERIES.forEach(([k, name, desc]) => {
      const got = found.has(k);
      const el = document.createElement('div'); el.className = 'd' + (got ? ' got' : '');
      el.innerHTML = `<i>${got ? '✦' : '?'}</i><div><b>${got ? name : '???'}</b><span>${got ? desc : 'Keep playing…'}</span></div>`;
      list.appendChild(el);
    });
    h('h2', '', 'Settings');
    const row = (label, on, fn) => {
      const r = h('button', 'toggle' + (on ? ' on' : ''), `<span>${label}</span><i></i>`);
      r.onclick = () => { fn(); renderMenu(); };
    };
    row('Sound', Sound.on, () => Sound.toggle());
    row('Day cycles on its own', meta.auto, () => { meta.auto = !meta.auto; saveMeta(); });
    h('p', 'muted small', 'Explore mode (the hand) is for looking around: drag to spin, pinch to zoom, double-tap to zoom in. In Edit mode, tap to use a tool. Hold to pour. Drag the sky to spin, pinch to zoom, two fingers to twist and pan. On a computer: right-drag spins, wheel zooms, keys 1–5 pick tools.');
  }

  function showIntro() {
    const intro = $('#intro');
    intro.classList.add('open');
    const cards = $('#introWorlds'); cards.innerHTML = '';
    cards.appendChild(worldCards(k => {
      if (k === 'random') surprise(); else newWorld(k);
      undo.length = 0; store.set('pb.intro', true);
      intro.classList.remove('open'); Sound.init(); Sound.chime();
    }));
  }
  if (!store.get('pb.intro', false)) showIntro();

  $('#bPhoto').onclick = () => {
    const shot = view.snapshot();
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d');
      const cs = getComputedStyle(sky).backgroundImage.match(/rgb[a]?\([^)]+\)|#[0-9a-f]{6}/gi) || ['#9ae8d4', '#3cb6a4'];
      const gr = g.createLinearGradient(0, 0, 0, c.height); gr.addColorStop(0, cs[0]); gr.addColorStop(1, cs[cs.length - 1]);
      g.fillStyle = gr; g.fillRect(0, 0, c.width, c.height);
      if (document.body.classList.contains('night')) { g.globalAlpha = 0.8; g.drawImage(starsImg(), 0, 0, c.width, c.height); g.globalAlpha = 1; }
      g.drawImage(img, 0, 0);
      const s = c.width / 400;
      g.font = `600 ${Math.round(14 * s)}px Fredoka, sans-serif`; g.fillStyle = 'rgba(255,255,255,0.85)';
      g.fillText('Voxel Worlds', 16 * s, c.height - 18 * s);
      const url = c.toDataURL('image/png');
      $('#photoImg').src = url;
      const dl = $('#photoSave'); if (dl) dl.href = url;
      $('#photo').classList.add('open');
      $('#flash').classList.remove('go'); void $('#flash').offsetWidth; $('#flash').classList.add('go');
      Sound.place(5);
    };
    img.src = shot;
  };
  function starsImg() { const i = new Image(); i.src = stars.style.backgroundImage.slice(5, -2); return i; }
  $('#photoClose').onclick = () => $('#photo').classList.remove('open');
  // in the app, hand the picture to Android's share sheet (Instagram, Photos, Messages…)
  const cap = window.Capacitor;
  if (cap && cap.isNativePlatform && cap.isNativePlatform()) {
    const shareBtn = $('#photoSave');
    shareBtn.textContent = 'Share';
    shareBtn.removeAttribute('download');
    shareBtn.onclick = async e => {
      e.preventDefault();
      try {
        const fsys = cap.registerPlugin('Filesystem'), share = cap.registerPlugin('Share');
        const file = await fsys.writeFile({ path: `voxel-worlds-${Date.now()}.png`, data: $('#photoImg').src.split(',')[1], directory: 'CACHE' });
        await share.share({ title: 'My Voxel World', files: [file.uri] });
      } catch (err) {
        if (!/cancel/i.test(String(err && err.message))) toast('<span>Couldn’t open the share sheet</span>', 2000);
      }
    };
    $('#photo p').textContent = 'Share it, or long-press the picture to copy it';
  }

  // ---------------------------------------------------------------
  // Save
  function saveMeta() { store.set('pb.meta', meta); }
  let saveTimer = 0;
  function save() {
    try { put('pb.world', JSON.stringify(world.serialize())); } catch (e) { /* quota */ }
    world.changed = false;
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
  window.addEventListener('pagehide', save);

  // ---------------------------------------------------------------
  // Android: back button closes overlays first, pausing saves to disk
  const app = window.Store && window.Store.app;
  if (app) {
    app.addListener('pause', () => { save(); window.Store.flush(); if (Sound.ctx) Sound.ctx.suspend(); });
    app.addListener('resume', () => { if (Sound.ctx && Sound.on) Sound.ctx.resume(); });
    app.addListener('backButton', () => {
      if ($('#photo').classList.contains('open')) $('#photo').classList.remove('open');
      else if (sheet.classList.contains('open')) closeSheets();
      else if (tray.classList.contains('open') && state.tool !== 'build') document.querySelector('.tools [data-tool="build"]').click();
      else { save(); window.Store.flush(); app.minimizeApp(); }
    });
  }

  // ---------------------------------------------------------------
  // Main loop
  const STEP = 1 / 15;
  let acc = 0, last = performance.now(), t = 0, soundT = 0, rebuildT = 0;
  function loop(now) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now; t += dt;
    acc += dt;
    let steps = 0;
    while (acc >= STEP && steps < 3) {
      if (state.pour) {
        const [x, y, z] = state.pour.cell;
        const added = world.addFluid(x, y, z, state.pour.f, 0.3);
        world.emit('pour', x + 0.5, y + 1.6, z + 0.5, state.pour.f);
        if (!added && y + 1 < H) world.addFluid(x, y + 1, z, state.pour.f, 0.3);
      }
      world.step();
      acc -= STEP; steps++;
    }
    if (acc > STEP) acc = 0;

    if (world.events.length) {
      view.handleEvents(world.events);
      for (const e of world.events) {
        switch (e.k) {
          case 'spill': discover(e.a === LAVA ? 'lavafall' : 'waterfall'); break;
          case 'steam': Sound.sizzle(); discover(e.a === T.OBSIDIAN ? 'obsidian' : 'basalt'); break;
          case 'melt': Sound.sizzle(); discover('snowmelt'); break;
          case 'sizzle': Sound.sizzle(); break;
          case 'cool': discover('basalt'); break;
          case 'burn': Sound.sizzle(); discover('wildfire'); break;
          case 'bloom': if (e.a) { Sound.twinkle(); discover('bloom'); } break;
          case 'tree': Sound.arpeggio(); discover('tree'); break;
          case 'thud': discover('sandslide'); break;
          case 'uproot': discover('flood'); break;
        }
      }
      world.events.length = 0;
    }
    if (world.stats.water > 400) discover('lake');

    // rebuild meshes at most ~20 times a second
    rebuildT += dt;
    if (rebuildT > 0.05) {
      if (world.solidDirty) { view.rebuildSolid(); world.solidDirty = false; }
      world.fluidDirty = false;   // the renderer re-meshes fluids every frame
      rebuildT = 0;
    }

    if (meta.auto) {
      phaseClock += dt;
      if (phaseClock > 100) setPhase(PHASE_ORDER[(PHASE_ORDER.indexOf(meta.phase) + 1) % 4]);
    }
    soundT += dt;
    if (soundT > 0.15) { Sound.update(world, view.ph.night, state.pour && state.pour.f); soundT = 0; }

    saveTimer += dt;
    if (saveTimer > 4 && world.changed) { save(); saveTimer = 0; }

    view.frame(dt, t, Math.min(1, acc / STEP));
    requestAnimationFrame(loop);
  }

  window.addEventListener('resize', () => view.resize());
  updateHeader();
  setMode(state.mode, true);
  view.resetCritters();
  requestAnimationFrame(loop);
  window.__pb = { world, view, state };   // handy for poking at it from the console
}

(window.Store ? window.Store.ready : Promise.resolve()).then(startVoxelWorlds);
