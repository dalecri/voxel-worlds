// Voxel Worlds: the voxel world and its physics. No rendering in here, so it
// also runs in Node for tests. Exposes `PB` (window.PB in the browser).
//
// Fluids are mass-conserving cellular automata: every cell holds some water or
// lava (0..~1.05), which falls, spreads sideways to level out and gets pushed
// up under pressure, so pools find their own level, U-bends equalise and
// anything that reaches the island edge spills off as a waterfall.

(function (root) {
  const W = 24, D = 24, H = 24;
  const WD = W * D, N = W * D * H;

  const T = {
    AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, SAND: 4, SNOW: 5, LOG: 6, LEAVES: 7, BLOSSOM: 8,
    AUTUMN: 9, PINE: 10, PLANK: 11, BRICK: 12, OBSIDIAN: 13, BASALT: 14, SPRING: 15, VENT: 16,
    LANTERN: 17, CACTUS: 18, FLOWER: 19, TUFT: 20, SAPLING: 21, MUSHROOM: 22, MOSS: 23,
  };
  const NT = 24;
  const WATER = 1, LAVA = 2;

  const flags = (list) => { const a = new Uint8Array(NT); list.forEach(t => { a[t] = 1; }); return a; };
  // decor: tiny plants that sit in an otherwise empty cell; fluids sweep them away
  const DECOR = flags([T.FLOWER, T.TUFT, T.SAPLING, T.MUSHROOM]);
  const FLAMMABLE = flags([T.LOG, T.LEAVES, T.BLOSSOM, T.AUTUMN, T.PINE, T.PLANK, T.CACTUS, T.MOSS,
    T.FLOWER, T.TUFT, T.SAPLING, T.MUSHROOM]);
  const FALLS = flags([T.SAND]);
  const LEAFY = flags([T.LEAVES, T.BLOSSOM, T.AUTUMN, T.PINE]);

  const isSolid = t => t !== T.AIR && !DECOR[t];
  const idx = (x, y, z) => x + z * W + y * WD;

  // ---- tiny deterministic randomness ----
  function hash3(x, y, z, s) {
    let h = (x * 374761393 + y * 668265263 + z * 2147483647 + (s || 0) * 144665) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function mulberry(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---- fluid constants ----
  const MAXM = 1, COMP = 0.03, MINM = 0.004;
  // how much of `total` the lower of two stacked cells should hold
  function stable(total) {
    if (total <= MAXM) return MAXM;
    if (total < 2 * MAXM + COMP) return (MAXM * MAXM + total * COMP) / (MAXM + COMP);
    return (total + COMP) / 2;
  }
  const FL = {
    [WATER]: { spread: 1, minSide: 0.04, maxSpeed: 1 },   // a little surface tension: puddles stop spreading when thin
    [LAVA]: { spread: 0.55, minSide: 0.16, maxSpeed: 0.45 },   // thick: it heaps up and creeps
  };
  const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const DIRS6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

  function World() {
    this.type = new Uint8Array(N);
    this.fluid = new Uint8Array(N);
    this.mass = new Float32Array(N);
    this.nm = new Float32Array(N);
    this.claim = new Uint8Array(N);
    this.events = [];
    this.tick = 0;
    this.raining = false;
    this.queue = [];          // blocks waiting to appear (growing trees)
    this.saplings = [];
    this.solidDirty = true;
    this.fluidDirty = true;
    this.changed = true;      // anything worth saving
    this.rand = mulberry(Date.now() & 0xffff);
    this.stats = { fall: 0, spill: 0, water: 0, lava: 0, waterSurface: 0 };
  }

  const P = World.prototype;
  P.inB = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < W && y < H && z < D;
  P.get = function (x, y, z) { return this.inB(x, y, z) ? this.type[idx(x, y, z)] : T.AIR; };
  P.solidAt = function (x, y, z) { return this.inB(x, y, z) && isSolid(this.type[idx(x, y, z)]); };
  P.canHold = function (i, f) { return !isSolid(this.type[i]) && (this.fluid[i] === 0 || this.fluid[i] === f); };
  P.emit = function (k, x, y, z, a) { if (this.events.length < 600) this.events.push({ k, x, y, z, a: a || 0 }); };

  // set a cell's block; a solid block shoves any fluid in its way upward
  P.set = function (x, y, z, t) {
    if (!this.inB(x, y, z)) return false;
    const i = idx(x, y, z);
    if (this.type[i] === t) return false;
    if (isSolid(t) && this.fluid[i]) this.displace(x, y, z);
    this.type[i] = t;
    this.solidDirty = this.changed = true;
    return true;
  };
  P.displace = function (x, y, z) {
    const i = idx(x, y, z), f = this.fluid[i];
    let m = this.mass[i];
    this.fluid[i] = 0; this.mass[i] = 0;
    for (let yy = y + 1; yy < H && m > 0; yy++) {
      const j = idx(x, yy, z);
      if (isSolid(this.type[j]) || (this.fluid[j] && this.fluid[j] !== f)) break;
      const add = Math.min(m, 1.05 - this.mass[j]);
      if (add > 0) { this.fluid[j] = f; this.mass[j] += add; m -= add; }
    }
    this.fluidDirty = true;
  };
  P.addFluid = function (x, y, z, f, amt, cap) {
    if (!this.inB(x, y, z)) return 0;
    const i = idx(x, y, z);
    if (isSolid(this.type[i])) return 0;
    if (this.fluid[i] && this.fluid[i] !== f) return 0;
    const add = Math.min(amt, (cap || 1) - this.mass[i]);
    if (add <= 0) return 0;
    if (DECOR[this.type[i]]) { this.type[i] = T.AIR; this.solidDirty = true; }
    this.fluid[i] = f; this.mass[i] += add;
    this.fluidDirty = this.changed = true;
    return add;
  };
  P.removeFluid = function (x, y, z) {
    if (!this.inB(x, y, z)) return 0;
    const i = idx(x, y, z), m = this.mass[i];
    this.fluid[i] = 0; this.mass[i] = 0;
    this.fluidDirty = this.changed = true;
    return m;
  };
  P.topY = function (x, z) {        // highest solid cell in a column, -1 if none
    for (let y = H - 1; y >= 0; y--) if (isSolid(this.type[idx(x, y, z)])) return y;
    return -1;
  };

  // ---------------------------------------------------------------
  // Fluid flow, one fluid at a time, double-buffered through `nm`
  P.flow = function (f) {
    const { type, fluid, mass, nm, claim } = this;
    const cfg = FL[f];
    nm.set(mass);
    let fall = 0, spill = 0;
    for (let y = 0; y < H; y++) for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
      const i = x + z * W + y * WD;
      if (fluid[i] !== f) continue;
      let rem = mass[i];
      if (rem <= 0) continue;

      // 1. fall
      if (y === 0) {
        const fl = Math.min(rem, 0.5);
        nm[i] -= fl; rem -= fl; spill += fl;
        if (this.rand() < fl * 0.6) this.emit('spill', x + 0.5, 0, z + 0.5, f);
      } else {
        const j = i - WD;
        if (!isSolid(type[j]) && (fluid[j] === 0 || fluid[j] === f)) {
          let fl = stable(rem + mass[j]) - mass[j];
          if (fl > 0.1) fl *= 0.5;
          fl = Math.max(0, Math.min(fl, cfg.maxSpeed, rem));
          if (fl > 0) {
            nm[i] -= fl; nm[j] += fl; rem -= fl;
            if (!fluid[j]) claim[j] = f;
            if (mass[j] < 0.98 || (y > 1 && !isSolid(type[j - WD]) && !fluid[j - WD])) fall += fl;
            if (mass[j] > 0.5 && fl > 0.08 && this.rand() < 0.05) this.emit('splash', x + 0.5, y, z + 0.5, f);
          }
        }
      }
      if (rem <= 0) continue;

      // 2. spread sideways (level out)
      if (rem > cfg.minSide) {
        for (let d = 0; d < 4; d++) {
          const nx = x + DIRS4[d][0], nz = z + DIRS4[d][1];
          if (nx < 0 || nz < 0 || nx >= W || nz >= D) {
            // over the edge of the world: it pours off
            const fl = Math.min(rem, rem * 0.25 * cfg.spread);
            if (fl > 0.001) {
              nm[i] -= fl; rem -= fl; spill += fl;
              if (this.rand() < fl * 4) this.emit('spill', x + 0.5 + DIRS4[d][0] * 0.55, y + Math.min(1, mass[i]) * 0.9, z + 0.5 + DIRS4[d][1] * 0.55, f);
            }
            continue;
          }
          const j = i + DIRS4[d][0] + DIRS4[d][1] * W;
          if (isSolid(type[j]) || (fluid[j] && fluid[j] !== f)) continue;
          let fl = (mass[i] - mass[j]) / 5 * cfg.spread;
          if (fl <= 0) continue;
          fl = Math.min(fl, rem);
          nm[i] -= fl; nm[j] += fl; rem -= fl;
          if (!fluid[j]) claim[j] = f;
        }
      }
      if (rem <= 0 || y >= H - 1) continue;

      // 3. pressure pushes the excess up
      const j = i + WD;
      if (!isSolid(type[j]) && (fluid[j] === 0 || fluid[j] === f)) {
        let fl = rem - stable(rem + mass[j]);
        if (fl > 0.1) fl *= 0.5;
        fl = Math.max(0, Math.min(fl, cfg.maxSpeed, rem));
        if (fl > 0) { nm[i] -= fl; nm[j] += fl; if (!fluid[j]) claim[j] = f; }
      }
    }

    // commit
    let count = 0;
    for (let i = 0; i < N; i++) {
      if (claim[i] === f) {
        claim[i] = 0;
        if (!fluid[i]) {
          fluid[i] = f;
          if (DECOR[type[i]]) {           // swept away / burnt
            const y = (i / WD) | 0, r = i - y * WD;
            this.emit(f === LAVA ? 'burn' : 'uproot', (r % W) + 0.5, y + 0.3, ((r / W) | 0) + 0.5, type[i]);
            type[i] = T.AIR; this.solidDirty = true;
          }
        }
      }
      if (fluid[i] !== f) continue;
      let m = nm[i];
      // thin films of water slowly soak in / evaporate so puddles don't linger forever
      if (f === WATER && m < 0.045 && i >= WD && isSolid(type[i - WD])) m -= 0.0025;
      if (m < MINM) { fluid[i] = 0; mass[i] = 0; continue; }
      mass[i] = m; count++;
    }
    if (f === WATER) { this.stats.fall = fall; this.stats.spill = spill; this.stats.water = count; }
    else { this.stats.lava = count; this.stats.lavaFall = fall; }
    this.fluidDirty = true;
  };

  // ---------------------------------------------------------------
  // Everything that happens cell-by-cell: springs, vents, lava meeting
  // things, sand falling.
  P.cellPass = function (lavaTick, sandTick) {
    const { type, fluid, mass } = this;
    for (let y = 0; y < H; y++) for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
      const i = x + z * W + y * WD;
      const t = type[i];

      // vents erupt in pulses: about 25s on, 35s resting
      if (t === T.SPRING || (t === T.VENT && lavaTick && this.tick % 900 < 380)) {
        const f = t === T.SPRING ? WATER : LAVA, rate = f === WATER ? 0.3 : 0.14;
        // sources push a little past full, so the pressure lifts whatever sits above
        if (y < H - 1 && this.canHold(i + WD, f)) this.addFluid(x, y + 1, z, f, rate, 1.25);
        else for (const [dx, dz] of DIRS4) this.addFluid(x + dx, y, z + dz, f, rate / 3, 1.1);
        continue;
      }

      if (FALLS[t] && sandTick && y > 0) {
        const j = i - WD;
        if (!isSolid(type[j])) {
          // sand sinks through fluid, the fluid swaps up into its place
          type[j] = t; type[i] = T.AIR;
          fluid[i] = fluid[j]; mass[i] = mass[j];
          fluid[j] = 0; mass[j] = 0;
          this.solidDirty = this.fluidDirty = this.changed = true;
          if (y > 1 && isSolid(type[j - WD])) this.emit('thud', x + 0.5, y - 1, z + 0.5, t);
          this.sandSlid = true;
        }
        continue;
      }

      if (fluid[i] !== LAVA || !lavaTick) continue;
      // lava touching things
      for (let d = 0; d < 6; d++) {
        const nx = x + DIRS6[d][0], ny = y + DIRS6[d][1], nz = z + DIRS6[d][2];
        if (!this.inB(nx, ny, nz)) continue;
        const j = idx(nx, ny, nz), nt = type[j];
        if (fluid[j] === WATER) {
          const strong = mass[i] > 0.6;
          fluid[i] = 0; mass[i] = 0;
          type[i] = strong ? T.OBSIDIAN : T.BASALT;
          mass[j] -= 0.3;
          if (mass[j] <= MINM) { fluid[j] = 0; mass[j] = 0; }
          this.emit('steam', x + 0.5, y + 0.6, z + 0.5, strong ? T.OBSIDIAN : T.BASALT);
          this.solidDirty = this.fluidDirty = this.changed = true;
          break;
        }
        if (nt === T.SNOW && this.rand() < 0.08) {
          type[j] = T.AIR; fluid[j] = WATER; mass[j] = 0.9;
          this.emit('melt', nx + 0.5, ny + 0.5, nz + 0.5, 0);
          this.solidDirty = this.fluidDirty = this.changed = true;
        } else if (FLAMMABLE[nt] && this.rand() < 0.035) {
          type[j] = T.AIR;
          this.emit('burn', nx + 0.5, ny + 0.5, nz + 0.5, nt);
          this.solidDirty = this.changed = true;
          this.ignite(nx, ny, nz);
        } else if (nt === T.GRASS && this.rand() < 0.03) {
          type[j] = T.DIRT; this.solidDirty = true;
        }
      }
      // a thin, still crust of lava cools to basalt
      if (fluid[i] === LAVA && mass[i] < 0.24 && y > 0 && isSolid(type[i - WD]) && this.rand() < 0.012) {
        fluid[i] = 0; mass[i] = 0; type[i] = T.BASALT;
        this.emit('cool', x + 0.5, y + 0.4, z + 0.5, 0);
        this.solidDirty = this.fluidDirty = this.changed = true;
      }
    }
  };

  // fire creeps a little through a tree once lava catches it
  P.ignite = function (x, y, z) {
    for (const [dx, dy, dz] of DIRS6) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (!this.inB(nx, ny, nz)) continue;
      const t = this.type[idx(nx, ny, nz)];
      if (FLAMMABLE[t] && this.rand() < 0.45) this.queue.push({ burn: true, x: nx, y: ny, z: nz, at: this.tick + 4 + ((this.rand() * 10) | 0) });
    }
  };

  // ---------------------------------------------------------------
  // Slow life: grass spreads, flowers bloom near water
  P.randomTicks = function (n) {
    const { type, fluid, mass } = this;
    for (let k = 0; k < n; k++) {
      const x = (this.rand() * W) | 0, z = (this.rand() * D) | 0, y = (this.rand() * (H - 1)) | 0;
      const i = idx(x, y, z), t = type[i];
      if (t !== T.GRASS && t !== T.DIRT) continue;
      const a = i + WD, at = type[a];
      if (t === T.GRASS) {
        if (isSolid(at)) { type[i] = T.DIRT; this.solidDirty = true; continue; }
        if (at !== T.AIR || fluid[a]) continue;
        if (this.nearWater(x, y + 1, z, 2) && this.rand() < 0.35) {
          type[a] = this.rand() < 0.6 ? T.FLOWER : T.TUFT;
          this.emit('bloom', x + 0.5, y + 1.2, z + 0.5, type[a]);
          this.solidDirty = this.changed = true;
        } else if (this.rand() < 0.02) {
          type[a] = T.TUFT; this.solidDirty = true;
        }
      } else if (t === T.DIRT) {
        if (isSolid(at) || (fluid[a] && mass[a] > 0.3)) continue;
        let near = false;
        for (let dy = -1; dy <= 1 && !near; dy++) for (const [dx, dz] of DIRS4) {
          if (this.get(x + dx, y + dy, z + dz) === T.GRASS) { near = true; break; }
        }
        if (near) { type[i] = T.GRASS; this.solidDirty = this.changed = true; }
      }
    }
  };
  P.nearWater = function (x, y, z, r) {
    for (let dy = -1; dy <= 0; dy++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (!this.inB(x + dx, y + dy, z + dz)) continue;
      const j = idx(x + dx, y + dy, z + dz);
      if (this.fluid[j] === WATER && this.mass[j] > 0.2) return true;
    }
    return false;
  };

  P.rain = function (drops) {
    for (let k = 0; k < drops; k++) {
      const x = (this.rand() * W) | 0, z = (this.rand() * D) | 0;
      let y = H - 1;
      while (y >= 0) {
        const i = idx(x, y, z);
        if (isSolid(this.type[i]) || this.fluid[i]) break;
        y--;
      }
      if (y < 0) continue;
      const i = idx(x, y, z);
      if (LEAFY[this.type[i]]) continue;        // the canopy keeps the ground beneath it dry
      if (this.fluid[i] === LAVA) { this.emit('sizzle', x + 0.5, y + 1, z + 0.5, 0); continue; }
      if (this.fluid[i] === WATER) this.addFluid(x, y, z, WATER, 0.035);
      else this.addFluid(x, y + 1, z, WATER, 0.035);
    }
  };

  // ---------------------------------------------------------------
  // Trees, grown block by block through the queue
  P.plantSapling = function (x, y, z, kind) {
    if (!this.inB(x, y, z) || isSolid(this.type[idx(x, y, z)]) || this.fluid[idx(x, y, z)]) return false;
    this.set(x, y, z, T.SAPLING);
    this.saplings.push({ x, y, z, kind, at: this.tick + 30 + ((this.rand() * 25) | 0) });
    return true;
  };
  P.treeBlocks = function (x, y, z, kind, rnd) {
    const out = [];
    const put = (dx, dy, dz, t) => out.push([x + dx, y + dy, z + dz, t]);
    if (kind === 'cactus') {
      const h = 2 + ((rnd() * 2) | 0);
      for (let k = 0; k < h; k++) put(0, k, 0, T.CACTUS);
      if (rnd() < 0.6) { const [dx, dz] = DIRS4[(rnd() * 4) | 0]; put(dx, 1, dz, T.CACTUS); put(dx, 2, dz, T.CACTUS); }
      return out;
    }
    if (kind === 'pine') {
      const trunk = 1 + ((rnd() * 2) | 0);
      for (let k = 0; k < trunk; k++) put(0, k, 0, T.LOG);
      let yy = trunk;
      for (const r of [1, 1, 0, 0]) {
        for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
          if (r && Math.abs(dx) + Math.abs(dz) === 2 && (yy > trunk || rnd() < 0.5)) continue;
          put(dx, yy, dz, T.PINE);
        }
        yy++;
      }
      put(0, yy, 0, T.SNOW);
      return out;
    }
    if (kind === 'palm') {
      const h = 3 + ((rnd() * 2) | 0);
      for (let k = 0; k < h; k++) put(0, k, 0, T.LOG);
      put(0, h, 0, T.LEAVES);
      for (const [dx, dz] of DIRS4) { put(dx, h, dz, T.LEAVES); put(dx * 2, h - 1, dz * 2, T.LEAVES); }
      return out;
    }
    // the reference-style box tree: thin trunk, chunky cube canopy
    const leaf = kind === 'blossom' ? T.BLOSSOM : kind === 'autumn' ? T.AUTUMN : T.LEAVES;
    const trunk = 1 + ((rnd() * 2) | 0);
    for (let k = 0; k < trunk + 1; k++) put(0, k, 0, T.LOG);
    const big = rnd() < 0.55;
    const r0 = big ? -1 : 0, r1 = 1;
    for (let dy = 0; dy < (big ? 3 : 2); dy++) for (let dz = r0; dz <= r1; dz++) for (let dx = r0; dx <= r1; dx++) {
      if (big && dy === 2 && Math.abs(dx) + Math.abs(dz) === 2 && rnd() < 0.7) continue;
      if (dx === 0 && dz === 0 && dy === 0) continue;
      put(dx, trunk + dy, dz, leaf);
    }
    return out;
  };
  P.growTree = function (x, y, z, kind, instant) {
    if (!kind) {
      const g = this.get(x, y - 1, z), r = this.rand();
      kind = g === T.SNOW ? 'pine' : g === T.SAND ? (r < 0.5 ? 'cactus' : 'palm')
        : r < 0.34 ? 'oak' : r < 0.67 ? 'blossom' : 'autumn';
    }
    const rnd = mulberry((x * 73856093) ^ (z * 19349663) ^ (y * 83492791) ^ (this.tick + 1));
    const blocks = this.treeBlocks(x, y, z, kind, rnd);
    if (this.type[idx(x, y, z)] === T.SAPLING) this.type[idx(x, y, z)] = T.AIR;
    blocks.forEach(([bx, by, bz, t], k) => {
      if (!this.inB(bx, by, bz)) return;
      if (instant) { if (!isSolid(this.type[idx(bx, by, bz)])) this.set(bx, by, bz, t); }
      else this.queue.push({ x: bx, y: by, z: bz, t, at: this.tick + 1 + k });
    });
    if (!instant) this.emit('tree', x + 0.5, y + 1, z + 0.5, 0);
    return kind;
  };

  P.runQueue = function () {
    if (!this.queue.length) return;
    const keep = [];
    for (const q of this.queue) {
      if (q.at > this.tick) { keep.push(q); continue; }
      const i = idx(q.x, q.y, q.z);
      if (q.burn) {
        if (FLAMMABLE[this.type[i]]) {
          const was = this.type[i];
          this.type[i] = T.AIR; this.solidDirty = this.changed = true;
          this.emit('burn', q.x + 0.5, q.y + 0.5, q.z + 0.5, was);
          if (this.rand() < 0.7) this.ignite(q.x, q.y, q.z);
        }
        continue;
      }
      if (!isSolid(this.type[i])) { this.set(q.x, q.y, q.z, q.t); this.emit('pop', q.x + 0.5, q.y + 0.5, q.z + 0.5, q.t); }
    }
    this.queue = keep;
  };

  // ---------------------------------------------------------------
  P.step = function () {
    this.tick++;
    const lavaTick = this.tick % 3 === 0;
    this.cellPass(lavaTick, this.tick % 2 === 0);
    this.flow(WATER);
    if (lavaTick) this.flow(LAVA);
    if (this.raining) this.rain(4);
    this.randomTicks(24);
    this.runQueue();
    if (this.saplings.length) {
      this.saplings = this.saplings.filter(s => {
        if (s.at > this.tick) return true;
        if (this.type[idx(s.x, s.y, s.z)] === T.SAPLING) this.growTree(s.x, s.y, s.z, s.kind);
        return false;
      });
    }
  };

  // ---------------------------------------------------------------
  // Save / load
  const b64 = {
    enc(u8) {
      if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
      let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      return btoa(s);
    },
    dec(str) {
      if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(str, 'base64'));
      const s = atob(str), u8 = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
      return u8;
    },
  };
  P.serialize = function () {
    const q = new Uint8Array(N);
    for (let i = 0; i < N; i++) q[i] = Math.min(255, Math.round(this.mass[i] * 200));
    return { v: 1, w: W, d: D, h: H, t: b64.enc(this.type), f: b64.enc(this.fluid), m: b64.enc(q),
      sap: this.saplings.map(s => [s.x, s.y, s.z, s.kind || '']) };
  };
  P.load = function (o) {
    if (!o || o.v !== 1 || o.w !== W || o.d !== D || o.h !== H) return false;
    const t = b64.dec(o.t), f = b64.dec(o.f), m = b64.dec(o.m);
    if (t.length !== N || f.length !== N || m.length !== N) return false;
    this.type.set(t); this.fluid.set(f);
    for (let i = 0; i < N; i++) this.mass[i] = f[i] ? m[i] / 200 : 0;
    this.saplings = (o.sap || []).map(([x, y, z, kind], k) => ({ x, y, z, kind: kind || undefined, at: this.tick + 20 + k * 5 }));
    this.queue = [];
    this.solidDirty = this.fluidDirty = true;
    return true;
  };
  P.snapshot = function () {
    return { type: this.type.slice(), fluid: this.fluid.slice(), mass: this.mass.slice() };
  };
  P.restore = function (s) {
    this.type.set(s.type); this.fluid.set(s.fluid); this.mass.set(s.mass);
    this.queue = []; this.saplings = [];
    this.solidDirty = this.fluidDirty = this.changed = true;
  };
  P.clear = function () {
    this.type.fill(0); this.fluid.fill(0); this.mass.fill(0);
    this.queue = []; this.saplings = []; this.events = [];
    this.solidDirty = this.fluidDirty = this.changed = true;
  };

  // ---------------------------------------------------------------
  // World presets
  function column(w, x, z, h, top, opts) {
    opts = opts || {};
    for (let y = 0; y < h; y++) {
      let t;
      if (y === h - 1) t = top;
      else if (y >= h - 1 - (opts.sub || 3)) t = opts.under || (top === T.SAND ? T.SAND : T.DIRT);
      else if (y <= 1) t = T.STONE;
      else t = T.DIRT;
      w.type[idx(x, y, z)] = t;
    }
  }
  function fillWater(w, x, z, from, to) {
    for (let y = from; y < to; y++) { const i = idx(x, y, z); w.fluid[i] = WATER; w.mass[i] = 1; }
  }

  const PRESETS = {
    valley: {
      name: 'Waterfall Valley',
      blurb: 'A snowy bluff, a spring-fed pond and a waterfall tumbling to the dunes.',
      build(w) {
        const rnd = mulberry(4242);
        for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
          let h = 8, top = T.GRASS, sub = 3, under;
          const snow = x >= 14 && z <= 11;
          const sand = x >= 12 && z >= 13;
          if (snow) {
            h = (x >= 18 && z <= 6) ? 16 : 14;
            if ((x === 14 || z === 11) && hash3(x, 0, z, 1) < 0.35) h -= 1;
            top = T.SNOW;
          } else if (sand) {
            h = (x === 12 || z === 13) ? 6 : 5; top = T.SAND;
          }
          const pdx = (x - 6.5) / 4.1, pdz = (z - 13) / 3.6;
          const pond = pdx * pdx + pdz * pdz < 1;
          if (pond) { h = 6; top = T.SAND; sub = 1; under = T.DIRT; }
          // channel from the pond over the cliff, then a stream across the dunes
          const channel = !pond && (x === 10 || x === 11) && (z === 13 || z === 14);
          if (channel) { h = 7; top = T.GRASS; }
          const river = (x >= 12 && x <= 14 && (z === 13 || z === 14)) || ((x === 13 || x === 14) && z >= 13);
          if (river) { h = 4; top = T.SAND; }
          column(w, x, z, h, top, { sub, under });
          if (pond) fillWater(w, x, z, 6, 8);
          if (channel) fillWater(w, x, z, 7, 8);
          if (river) fillWater(w, x, z, 4, 5);
        }
        w.type[idx(5, 5, 13)] = T.SPRING;
        w.type[idx(6, 5, 14)] = T.SPRING;
        // trees
        [[2, 3, 'oak'], [5, 2, 'blossom'], [9, 4, 'autumn'], [2, 8, 'oak'], [10, 8, 'oak'], [3, 19, 'blossom'],
          [8, 20, 'autumn'], [11, 2, 'oak']].forEach(([x, z, k]) => w.growTree(x, w.topY(x, z) + 1, z, k, true));
        [[16, 3], [20, 9], [17, 8], [22, 2], [19, 4]].forEach(([x, z]) => w.growTree(x, w.topY(x, z) + 1, z, 'pine', true));
        [[19, 18], [21, 15], [17, 21], [22, 21]].forEach(([x, z]) => w.growTree(x, w.topY(x, z) + 1, z, 'cactus', true));
        w.growTree(16, w.topY(16, 16) + 1, 16, 'palm', true);
        // flowers, tufts, a few boulders and a lantern by the pond
        for (let k = 0; k < 70; k++) {
          const x = (rnd() * 13) | 0, z = (rnd() * D) | 0;
          const y = w.topY(x, z);
          if (y < 0 || w.type[idx(x, y, z)] !== T.GRASS) continue;
          const a = idx(x, y + 1, z);
          if (w.type[a] || w.fluid[a]) continue;
          w.type[a] = rnd() < 0.55 ? T.FLOWER : rnd() < 0.85 ? T.TUFT : T.MUSHROOM;
        }
        [[1, 13], [12, 10]].forEach(([x, z]) => { w.type[idx(x, w.topY(x, z) + 1, z)] = T.STONE; });
        w.type[idx(8, 8, 9)] = T.LANTERN;
        w.type[idx(20, 5, 20)] = T.LANTERN;
      },
    },
    volcano: {
      name: 'Ember Isle',
      blurb: 'A smoking cone with a snowcap, a lagoon at its feet and a beach of palms.',
      build(w) {
        const rnd = mulberry(777);
        const cx = 13.5, cz = 10.5;
        for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
          const d = Math.hypot(x - cx, z - cz) + (hash3(x, 0, z, 5) - 0.5) * 0.8;
          let h = Math.round(18 - d * 1.35), top;
          if (d < 2.3) h = 13;
          h = Math.max(h, 5);
          const lagoon = Math.hypot((x - 5) / 4.2, (z - 18.5) / 3.6) < 1;
          if (lagoon) h = 3;
          // a gully runs from the crater down to the lagoon, so overflowing lava has somewhere to go
          const gx = x - cx, gz = z - cz, along = (-gx * 8.5 + gz * 8) / 136.25;
          const off = Math.abs(gx * 8 + gz * 8.5) / 11.7;
          if (d >= 2.3 && along > 0 && along < 1.05 && off < 1.1 && !lagoon) h = Math.max(5, h - 2);
          if (h <= 5) top = T.SAND; else if (h <= 8) top = T.GRASS; else if (h >= 13) top = T.SNOW;
          else top = hash3(x, 1, z, 2) < 0.75 ? T.STONE : T.BASALT;
          if (d < 2.3) top = T.BASALT;
          column(w, x, z, h, top, { under: h > 9 ? T.STONE : undefined });
          if (lagoon) fillWater(w, x, z, 3, 5);
        }
        // a notch in the crater rim facing the lagoon so lava overflows that way
        for (let k = 0; k < 3; k++) {
          const x = Math.round(cx - 2 - k * 0.7), z = Math.round(cz + 2 + k * 0.7);
          for (let y = 13; y < H; y++) w.type[idx(x, y, z)] = T.AIR;
        }
        w.type[idx(13, 12, 10)] = T.VENT;
        w.type[idx(14, 12, 11)] = T.VENT;
        for (let y = 13; y < 14; y++) for (let z = 9; z <= 12; z++) for (let x = 12; x <= 15; x++) {
          const i = idx(x, y, z); if (!isSolid(w.type[i])) { w.fluid[i] = LAVA; w.mass[i] = 0.8; }
        }
        [[2, 3, 'palm'], [21, 20, 'palm'], [1, 12, 'palm'], [19, 22, 'cactus']].forEach(([x, z, k]) => w.growTree(x, w.topY(x, z) + 1, z, k, true));
        [[20, 15, 'oak'], [6, 4, 'autumn'], [22, 7, 'blossom'], [9, 22, 'oak']].forEach(([x, z, k]) => {
          const y = w.topY(x, z); if (y > 0) w.growTree(x, y + 1, z, k, true);
        });
        for (let k = 0; k < 50; k++) {
          const x = (rnd() * W) | 0, z = (rnd() * D) | 0, y = w.topY(x, z);
          if (y < 0 || w.type[idx(x, y, z)] !== T.GRASS || w.type[idx(x, y + 1, z)] || w.fluid[idx(x, y + 1, z)]) continue;
          w.type[idx(x, y + 1, z)] = rnd() < 0.5 ? T.FLOWER : T.TUFT;
        }
      },
    },
    meadow: {
      name: 'Quiet Meadow',
      blurb: 'A blank grassy plot and a single spring. Make it yours.',
      build(w) {
        const rnd = mulberry(99);
        for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) column(w, x, z, 6, T.GRASS);
        w.type[idx(4, 5, 4)] = T.SPRING;
        w.type[idx(4, 6, 4)] = T.AIR;
        [[18, 5, 'blossom'], [5, 18, 'oak']].forEach(([x, z, k]) => w.growTree(x, 6, z, k, true));
        for (let k = 0; k < 40; k++) {
          const x = (rnd() * W) | 0, z = (rnd() * D) | 0;
          if (!w.type[idx(x, 6, z)]) w.type[idx(x, 6, z)] = rnd() < 0.4 ? T.FLOWER : T.TUFT;
        }
      },
    },
  };
  P.generate = function (name) {
    this.clear();
    (PRESETS[name] || PRESETS.valley).build(this);
    this.queue = [];
    this.solidDirty = this.fluidDirty = this.changed = true;
  };

  const PB = { W, D, H, N, WD, T, WATER, LAVA, DECOR, FLAMMABLE, LEAFY, isSolid, idx, hash3, mulberry, World, PRESETS };
  if (typeof module !== 'undefined' && module.exports) module.exports = PB;
  else root.PB = PB;
})(typeof window !== 'undefined' ? window : globalThis);
