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
    CLAY: 24, BIRCH: 25, CAP: 26, STEM: 27,
  };
  const NT = 32;
  const WATER = 1, LAVA = 2;

  const flags = (list) => { const a = new Uint8Array(NT); list.forEach(t => { a[t] = 1; }); return a; };
  // decor: tiny plants that sit in an otherwise empty cell; fluids sweep them away
  const DECOR = flags([T.FLOWER, T.TUFT, T.SAPLING, T.MUSHROOM]);
  const FLAMMABLE = flags([T.LOG, T.BIRCH, T.CAP, T.STEM, T.LEAVES, T.BLOSSOM, T.AUTUMN, T.PINE, T.PLANK, T.CACTUS, T.MOSS,
    T.FLOWER, T.TUFT, T.SAPLING, T.MUSHROOM]);
  const FALLS = flags([T.SAND]);
  const LEAFY = flags([T.LEAVES, T.BLOSSOM, T.AUTUMN, T.PINE, T.CAP]);

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

  // ---- themes for random worlds (the renderer adds matching colours and critters) ----
  const THEMES = {
    spring: { label: 'Spring meadow', adj: ['Clover', 'Bluebell', 'Honeybee', 'Dewdrop', 'Buttercup'], noun: ['Vale', 'Hollow', 'Meadows', 'Glen', 'Downs'],
      base: 7, amp: 3, snow: 99, trees: { oak: 3, round: 2, birch: 2, blossom: 1, bush: 2 }, density: 0.05,
      flowers: 0.12, tufts: 0.2, shrooms: 0.01, big: ['mountain', 'hill', 'none'], water: ['lake', 'river', 'lake+river'] },
    autumn: { label: 'Autumn woods', adj: ['Amber', 'Maple', 'Russet', 'Cider', 'Harvest'], noun: ['Ridge', 'Woods', 'Hollow', 'Hill', 'Brook'],
      base: 7, amp: 3, snow: 99, leaf: T.AUTUMN, trees: { round: 3, autumn: 3, birch: 2, bush: 2 }, density: 0.06,
      flowers: 0.04, tufts: 0.18, shrooms: 0.04, big: ['hill', 'mountain'], water: ['river', 'lake+river'] },
    sakura: { label: 'Cherry blossom', adj: ['Sakura', 'Petal', 'Moonlit', 'Blush', 'Spring'], noun: ['Garden', 'Pond', 'Terrace', 'Grove', 'Falls'],
      base: 7, amp: 3, snow: 99, trees: { sakura: 3, blossom: 2, bush: 1 }, density: 0.045,
      flowers: 0.1, tufts: 0.12, shrooms: 0, lanterns: 0.025, big: ['hill', 'mountain', 'none'], water: ['lake', 'lake+river'] },
    alpine: { label: 'Alpine lake', adj: ['Frost', 'Glacier', 'Granite', 'Edelweiss', 'Summit'], noun: ['Peak', 'Lake', 'Pass', 'Tarn', 'Crag'],
      base: 7, amp: 4, snow: 14, trees: { pine: 6, birch: 1 }, density: 0.06,
      flowers: 0.05, tufts: 0.15, shrooms: 0.01, big: ['mountain'], water: ['lake', 'lake+river', 'river'] },
    desert: { label: 'Desert canyon', adj: ['Sunbaked', 'Copper', 'Mirage', 'Dune', 'Saffron'], noun: ['Mesa', 'Canyon', 'Oasis', 'Butte', 'Flats'],
      base: 6, amp: 2, snow: 99, ground: 'sand', trees: { cactus: 5, palm: 1 }, density: 0.03,
      flowers: 0.01, tufts: 0.03, shrooms: 0, big: ['mesa'], water: ['oasis'] },
    tropical: { label: 'Tropical lagoon', adj: ['Coral', 'Mango', 'Lagoon', 'Turquoise', 'Coconut'], noun: ['Cove', 'Isle', 'Bay', 'Lagoon', 'Reef'],
      base: 6, amp: 2, snow: 99, trees: { palm: 4, round: 2, bush: 3 }, density: 0.05, beach: 2,
      flowers: 0.1, tufts: 0.15, shrooms: 0, big: ['hill', 'none'], water: ['lagoon'] },
    lavender: { label: 'Lavender fields', adj: ['Lavender', 'Lilac', 'Violet', 'Heather', 'Thistle'], noun: ['Fields', 'Farm', 'Hills', 'Rows', 'Valley'],
      base: 7, amp: 2, snow: 99, trees: { birch: 2, round: 1, bush: 2 }, density: 0.025, field: true,
      flowers: 0.3, tufts: 0.1, shrooms: 0, big: ['hill', 'none'], water: ['river', 'lake'] },
    mystic: { label: 'Mushroom forest', adj: ['Glowcap', 'Twilight', 'Mossy', 'Whisper', 'Fable'], noun: ['Grove', 'Bog', 'Thicket', 'Hollow', 'Marsh'],
      base: 7, amp: 2, snow: 99, trees: { giantShroom: 3, willow: 2, bush: 1 }, density: 0.05,
      flowers: 0.04, tufts: 0.2, shrooms: 0.08, lanterns: 0.03, big: ['hill', 'none'], water: ['lake', 'lake+river'] },
    winter: { label: 'Snowy woods', adj: ['Snowdrift', 'Frosty', 'Pinecone', 'Hollyberry', 'Starlit'], noun: ['Woods', 'Hills', 'Pond', 'Hollow', 'Lodge'],
      base: 7, amp: 3, snow: 0, ground: 'snow', trees: { pine: 5, birch: 1 }, density: 0.06,
      flowers: 0, tufts: 0, shrooms: 0, lanterns: 0.01, big: ['mountain', 'hill'], water: ['lake'] },
    volcanic: { label: 'Volcanic isle', adj: ['Ember', 'Cinder', 'Obsidian', 'Smoky', 'Magma'], noun: ['Isle', 'Peak', 'Caldera', 'Crater', 'Rock'],
      base: 6, amp: 2, snow: 99, ground: 'ash', trees: { bush: 2, round: 1, palm: 1 }, density: 0.03,
      flowers: 0.03, tufts: 0.08, shrooms: 0, big: ['volcano'], water: ['lake', 'lagoon'] },
  };
  const GRASS_TREES = new Set(['oak', 'round', 'birch', 'blossom', 'autumn', 'willow', 'bush', 'giantShroom', 'sakura', 'palm', 'pine']);
  function pickWeighted(weights, rnd, allowed) {
    let total = 0;
    for (const k in weights) if (!allowed || allowed.has(k)) total += weights[k];
    if (!total) return null;
    let r = rnd() * total;
    for (const k in weights) if (!allowed || allowed.has(k)) { r -= weights[k]; if (r <= 0) return k; }
    return null;
  }
  // smooth value noise, 0..1
  function makeNoise(rnd) {
    const S = 32, g = new Float32Array(S * S);
    for (let i = 0; i < g.length; i++) g[i] = rnd();
    const at = (x, z) => g[(x & 31) + (z & 31) * S];
    return (x, z) => {
      const x0 = Math.floor(x), z0 = Math.floor(z);
      let fx = x - x0, fz = z - z0;
      fx = fx * fx * (3 - 2 * fx); fz = fz * fz * (3 - 2 * fz);
      const a = at(x0, z0), b = at(x0 + 1, z0), c = at(x0, z0 + 1), d = at(x0 + 1, z0 + 1);
      return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
    };
  }

  function World() {
    this.type = new Uint8Array(N);
    this.fluid = new Uint8Array(N);
    this.mass = new Float32Array(N);
    this.nm = new Float32Array(N);
    this.claim = new Uint8Array(N);
    this.fallIn = new Float32Array(N);   // fluid that poured in from above last tick (renderer: foam)
    this.edgeOut = new Float32Array(N);  // fluid that poured over the island edge last tick
    this.falling = [];                   // blocks in mid-air: { x, z, y, py, vy, t }
    this.theme = null;                   // random worlds: palette, trees and critters
    this.name = '';
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
    const cfg = FL[f], { fallIn, edgeOut } = this;
    nm.set(mass);
    for (let i = 0; i < N; i++) if (fluid[i] === f || !fluid[i]) { fallIn[i] = 0; edgeOut[i] = 0; }
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
            fallIn[j] += fl;
            if (!fluid[j]) claim[j] = f;
            if (mass[j] < 0.98 || (y > 1 && !isSolid(type[j - WD]) && !fluid[j - WD])) fall += fl;
            if (mass[j] > 0.5 && fl > 0.08 && this.rand() < 0.05) this.emit('splash', x + 0.5, y, z + 0.5, f);
          }
        }
      }
      if (rem <= 0) continue;

      // 2. spread sideways (level out). Water at the island's edge always trickles off,
      // even when thin, so edge waterfalls run steadily instead of pulsing.
      const edgeDrain = f === WATER && rem > 0.004;
      if (rem > cfg.minSide || edgeDrain) {
        const thin = rem <= cfg.minSide;
        for (let d = 0; d < 4; d++) {
          const nx = x + DIRS4[d][0], nz = z + DIRS4[d][1];
          if (thin && !(nx < 0 || nz < 0 || nx >= W || nz >= D)) continue;
          if (nx < 0 || nz < 0 || nx >= W || nz >= D) {
            // over the edge of the world: it pours off
            const fl = Math.min(rem, rem * 0.25 * cfg.spread);
            if (fl > 0.001) {
              nm[i] -= fl; rem -= fl; spill += fl;
              edgeOut[i] += fl;
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
        // pushed up gently (half the excess per tick) so pools don't boil up and down
        let fl = (rem - stable(rem + mass[j])) * 0.5;
        if (fl < 0.01 && !fluid[j]) fl = 0;      // no wisps of water over a full cell
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
        const f = t === T.SPRING ? WATER : LAVA, rate = f === WATER ? 0.12 : 0.14;
        // sources push a little past full, so the pressure lifts whatever sits above
        if (y < H - 1 && this.canHold(i + WD, f)) this.addFluid(x, y + 1, z, f, rate, 1.06);
        else for (const [dx, dz] of DIRS4) this.addFluid(x + dx, y, z + dz, f, rate / 3, 1.1);
        continue;
      }

      if (FALLS[t] && y > 0 && !isSolid(type[i - WD])) {
        // unsupported: it lets go of the grid and falls freely until it lands
        type[i] = T.AIR;
        this.falling.push({ x, z, y, py: y, vy: 0, t });
        this.solidDirty = this.changed = true;
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
    const themeLeaf = (THEMES[this.theme] && THEMES[this.theme].leaf) || T.LEAVES;
    if (kind === 'birch') {
      const h = 3 + ((rnd() * 2) | 0);
      for (let k = 0; k < h; k++) put(0, k, 0, T.BIRCH);
      for (let dy = 0; dy < 2; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (Math.abs(dx) + Math.abs(dz) === 2 && (dy === 1 || rnd() < 0.5)) continue;
        if (dx || dz || dy) put(dx, h - 1 + dy, dz, themeLeaf);
      }
      put(0, h + 1, 0, themeLeaf);
      return out;
    }
    if (kind === 'round') {
      const trunk = 2 + ((rnd() * 2) | 0), cy = trunk + 1;
      for (let k = 0; k < cy; k++) put(0, k, 0, T.LOG);
      for (let dy = -1; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        if (dx * dx + dz * dz + (dy - 0.4) * (dy - 0.4) * 1.6 > 5.2) continue;
        if (!dx && !dz && dy < 0) continue;
        put(dx, cy + dy, dz, themeLeaf);
      }
      return out;
    }
    if (kind === 'willow') {
      const trunk = 3;
      for (let k = 0; k < trunk + 1; k++) put(0, k, 0, T.LOG);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { put(dx, trunk + 1, dz, themeLeaf); if (dx || dz) put(dx, trunk, dz, themeLeaf); }
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== 2 || (Math.abs(dx) === 2 && Math.abs(dz) === 2)) continue;
        const drop = 1 + ((rnd() * 3) | 0);                    // hanging fronds
        for (let k = 0; k < drop; k++) put(dx, trunk - k, dz, themeLeaf);
      }
      return out;
    }
    if (kind === 'bush') {
      put(0, 0, 0, themeLeaf);
      if (rnd() < 0.6) { const [dx, dz] = DIRS4[(rnd() * 4) | 0]; put(dx, 0, dz, themeLeaf); }
      if (rnd() < 0.3) put(0, 1, 0, themeLeaf);
      return out;
    }
    if (kind === 'giantShroom') {
      const h = 3 + ((rnd() * 2) | 0);
      for (let k = 0; k < h; k++) put(0, k, 0, T.STEM);
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
        put(dx, h, dz, T.CAP);
        if (Math.abs(dx) < 2 && Math.abs(dz) < 2) put(dx, h + 1, dz, T.CAP);
      }
      return out;
    }
    if (kind === 'sakura') {
      const trunk = 2 + ((rnd() * 2) | 0);
      for (let k = 0; k < trunk; k++) put(0, k, 0, T.LOG);
      const [ox, oz] = DIRS4[(rnd() * 4) | 0];
      put(ox, trunk, oz, T.LOG);                                 // a crooked branch
      for (let dy = 0; dy < 2; dy++) for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
        if (dy === 1 && (Math.abs(dx) === 2 || Math.abs(dz) === 2) && rnd() < 0.6) continue;
        put(dx + ox, trunk + 1 + dy, dz + oz, T.BLOSSOM);
      }
      for (let k = 0; k < 3; k++) put(ox + ((rnd() * 5) | 0) - 2, trunk, oz + ((rnd() * 5) | 0) - 2, T.BLOSSOM);
      return out;
    }
    // the reference-style box tree: thin trunk, chunky cube canopy
    const leaf = kind === 'blossom' ? T.BLOSSOM : kind === 'autumn' ? T.AUTUMN : themeLeaf;
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
      const th = THEMES[this.theme];
      kind = g === T.SNOW ? 'pine' : g === T.SAND ? (r < 0.5 ? 'cactus' : 'palm')
        : th ? pickWeighted(th.trees, this.rand, GRASS_TREES) || 'oak'
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
  // Free-falling blocks: real acceleration, slowed by water, settling back into the grid
  P.updateFalling = function (dt) {
    if (!this.falling.length) return;
    const keep = [];
    for (const e of this.falling) {
      e.py = e.y;
      const cy = Math.floor(e.y + 0.5);
      const wet = cy >= 0 && cy < H && this.fluid[idx(e.x, cy, e.z)];
      e.vy = Math.min(e.vy + 28 * dt, wet ? 3.5 : 16);
      if (wet) e.vy *= 0.85;
      const ny = e.y - e.vy * dt;
      const by = Math.floor(ny);
      if (by >= 0 && by < H && isSolid(this.type[idx(e.x, by, e.z)])) {
        // landed on top of cell `by`
        let ly = by + 1;
        while (ly < H && isSolid(this.type[idx(e.x, ly, e.z)])) ly++;
        if (ly < H) {
          e.y = e.py = ly;
          this.set(e.x, ly, e.z, e.t);
          if (e.vy > 4) this.emit('thud', e.x + 0.5, ly, e.z + 0.5, e.t);
          this.sandSlid = true;
        }
        continue;
      }
      if (ny < -8) continue;                 // fell off the bottom of the world
      e.y = ny;
      keep.push(e);
    }
    this.falling = keep;
  };

  P.step = function () {
    this.tick++;
    const lavaTick = this.tick % 3 === 0;
    this.cellPass(lavaTick, this.tick % 2 === 0);
    this.updateFalling(1 / 15);
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
    const types = this.type.slice();
    for (const e of this.falling) {           // a block in mid-air is saved where it is
      const y = Math.round(e.y);
      if (y >= 0 && y < H && !isSolid(types[idx(e.x, y, e.z)])) types[idx(e.x, y, e.z)] = e.t;
    }
    for (let i = 0; i < N; i++) q[i] = Math.min(255, Math.round(this.mass[i] * 200));
    return { v: 1, w: W, d: D, h: H, t: b64.enc(types), f: b64.enc(this.fluid), m: b64.enc(q),
      sap: this.saplings.map(s => [s.x, s.y, s.z, s.kind || '']), theme: this.theme, name: this.name };
  };
  P.load = function (o) {
    this.falling = [];
    if (!o || o.v !== 1 || o.w !== W || o.d !== D || o.h !== H) return false;
    const t = b64.dec(o.t), f = b64.dec(o.f), m = b64.dec(o.m);
    if (t.length !== N || f.length !== N || m.length !== N) return false;
    this.type.set(t); this.fluid.set(f);
    for (let i = 0; i < N; i++) this.mass[i] = f[i] ? m[i] / 200 : 0;
    this.theme = THEMES[o.theme] ? o.theme : null; this.name = o.name || '';
    this.saplings = (o.sap || []).map(([x, y, z, kind], k) => ({ x, y, z, kind: kind || undefined, at: this.tick + 20 + k * 5 }));
    this.queue = [];
    this.solidDirty = this.fluidDirty = true;
    return true;
  };
  P.snapshot = function () {
    return { type: this.type.slice(), fluid: this.fluid.slice(), mass: this.mass.slice(), theme: this.theme, name: this.name };
  };
  P.restore = function (s) {
    this.falling = [];
    this.type.set(s.type); this.fluid.set(s.fluid); this.mass.set(s.mass);
    this.theme = s.theme || null; this.name = s.name || '';
    this.queue = []; this.saplings = [];
    this.solidDirty = this.fluidDirty = this.changed = true;
  };
  P.clear = function () {
    this.falling = [];
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
    this.theme = null; this.name = '';
    (PRESETS[name] || PRESETS.valley).build(this);
    this.queue = [];
    this.solidDirty = this.fluidDirty = this.changed = true;
  };


  // ---------------------------------------------------------------
  // Random worlds: a themed landscape with a big feature (mountain, mesa,
  // volcano, hills) and water (lakes, rivers that pour off the edge, lagoons)
  P.generateRandom = function (seed, themeName) {
    const rnd = mulberry(Math.imul(seed >>> 0, 2654435761) ^ 0x5bd1e995);
    const keys = Object.keys(THEMES);
    const theme = THEMES[themeName] ? themeName : keys[(rnd() * keys.length) | 0];
    const TH = THEMES[theme];
    const pick = a => a[(rnd() * a.length) | 0];
    this.clear();
    this.theme = theme;
    this.name = pick(TH.adj) + ' ' + pick(TH.noun);
    const n1 = makeNoise(rnd), n2 = makeNoise(rnd), n3 = makeNoise(rnd);
    const ci = (x, z) => x + z * W;
    const hg = new Float32Array(W * D);
    const wl = new Int16Array(W * D).fill(-1);       // water surface height per column
    const mesa = new Uint8Array(W * D);
    const springs = [], vents = [];
    for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
      hg[ci(x, z)] = TH.base + (n1(x / 7, z / 7) * 0.65 + n2(x / 3.3, z / 3.3) * 0.35 - 0.5) * 2 * TH.amp;
    }
    const corner = () => [rnd() < 0.5 ? 3 + rnd() * 5 : W - 3 - rnd() * 5, rnd() < 0.5 ? 3 + rnd() * 5 : D - 3 - rnd() * 5];
    const forEachIn = (cx, cz, r, fn) => {
      for (let z = Math.max(0, Math.floor(cz - r)); z < Math.min(D, Math.ceil(cz + r + 1)); z++)
        for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(W, Math.ceil(cx + r + 1)); x++) fn(x, z, Math.hypot(x - cx, z - cz) / r);
    };

    // -- the big feature
    const big = pick(TH.big);
    let peak = null, peakR = 0;
    if (big === 'mountain' || big === 'hill') {
      const [cx, cz] = corner(), r = big === 'hill' ? 5 + rnd() * 3 : 8 + rnd() * 4, ph = big === 'hill' ? 2.5 + rnd() * 2 : 6 + rnd() * 4;
      forEachIn(cx, cz, r, (x, z, d) => { if (d < 1) hg[ci(x, z)] += ph * Math.pow(1 - d, 1.15) * (0.75 + 0.5 * n3(x / 4, z / 4)); });
      peak = [cx, cz]; peakR = r;
    } else if (big === 'mesa') {
      const count = 1 + ((rnd() * 2) | 0);
      for (let k = 0; k < count; k++) {
        const [cx, cz] = corner(), r = 3 + rnd() * 3, top = TH.base + 4 + ((rnd() * 4) | 0);
        forEachIn(cx, cz, r * 1.3, (x, z, d) => { if (d < 0.75 + 0.35 * n3(x / 2.5, z / 2.5)) { hg[ci(x, z)] = top; mesa[ci(x, z)] = 1; } });
        if (!peak) { peak = [cx, cz]; peakR = r * 1.2; }
      }
    } else if (big === 'volcano') {
      const [cx, cz] = rnd() < 0.5 ? [7 + rnd() * 10, 7 + rnd() * 10] : corner().map(v => (v + 12) / 2);
      forEachIn(cx, cz, 8, (x, z, d) => { if (d < 1) hg[ci(x, z)] = Math.max(hg[ci(x, z)], TH.base + 12 * Math.pow(1 - d, 0.9)); });
      forEachIn(cx, cz, 1.8, (x, z, d) => { if (d < 1) hg[ci(x, z)] = TH.base + 8; });
      vents.push([Math.round(cx), Math.round(cz)]);
      peak = [cx, cz]; peakR = 8;
    }

    // -- terraces: round to steps of 1 or 2 for crisp cliffs like the reference
    const step = rnd() < 0.55 ? 2 : 1;
    for (let i = 0; i < W * D; i++) hg[i] = Math.max(3, Math.min(H - 6, Math.round(hg[i] / step) * step));

    // -- water
    const lake = (cx, cz, rx, rz) => {
      const cells = [];
      for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
        const d = Math.hypot((x - cx) / rx, (z - cz) / rz) + (n3(x / 2, z / 2) - 0.5) * 0.25;
        if (d < 1) cells.push([x, z, d]);
      }
      if (!cells.length) return null;
      // the rim's lowest point sets the level, so the lake sits flush in the land
      let level = Infinity;
      for (const [x, z] of cells) for (const [dx, dz] of DIRS4) {
        const xx = x + dx, zz = z + dz;
        if (xx < 0 || zz < 0 || xx >= W || zz >= D) continue;
        if (!cells.some(c => c[0] === xx && c[1] === zz)) level = Math.min(level, hg[ci(xx, zz)]);
      }
      level = Math.max(4, Math.min(level, TH.base + 2));
      let deep = null;
      for (const [x, z, d] of cells) {
        const floor = level - 1 - Math.round((1 - d) * 2.4);
        hg[ci(x, z)] = Math.min(hg[ci(x, z)], Math.max(2, floor));
        wl[ci(x, z)] = level;
        if (!deep || d < deep[2]) deep = [x, z, d];
      }
      // keep the banks at least as high as the water
      for (const [x, z] of cells) for (const [dx, dz] of DIRS4) {
        const xx = x + dx, zz = z + dz;
        if (xx < 0 || zz < 0 || xx >= W || zz >= D || wl[ci(xx, zz)] >= 0) continue;
        if (hg[ci(xx, zz)] < level) hg[ci(xx, zz)] = level;
      }
      springs.push([deep[0], deep[1]]);
      return { cx, cz, level, cells };
    };
    const river = (sx, sz, startH) => {
      // walk toward the nearest edge, wandering a little; the bed only ever steps down
      const ex = sx < W / 2 ? -1 : 1, ez = sz < D / 2 ? -1 : 1;
      const alongX = Math.min(sx, W - 1 - sx) < Math.min(sz, D - 1 - sz);
      let x = Math.round(sx), z = Math.round(sz), cur = startH, first = true, wide = rnd() < 0.5;
      for (let guard = 0; guard < 60; guard++) {
        if (x < 0 || z < 0 || x >= W || z >= D) break;
        const i = ci(x, z);
        if (wl[i] >= 0 && !first) break;                  // ran into a lake
        cur = Math.min(cur, hg[i] - 1);
        cur = Math.max(cur, 2);
        if (!first || wl[i] < 0) { hg[i] = cur; wl[i] = cur + 1; }
        if (wide) {
          const wx = alongX ? x : x + 1, wz = alongX ? z + 1 : z;
          if (wx < W && wz < D && wl[ci(wx, wz)] < 0) { hg[ci(wx, wz)] = Math.min(hg[ci(wx, wz)], cur); wl[ci(wx, wz)] = cur + 1; }
        }
        first = false;
        const r = rnd();
        if (alongX) { x += ex; if (r < 0.25) z += 1; else if (r < 0.5) z -= 1; z = Math.max(0, Math.min(D - 2, z)); }
        else { z += ez; if (r < 0.25) x += 1; else if (r < 0.5) x -= 1; x = Math.max(0, Math.min(W - 2, x)); }
      }
    };
    const wat = pick(TH.water);
    if (wat === 'lake' || wat === 'lake+river' || wat === 'oasis' || wat === 'lagoon') {
      const size = wat === 'lagoon' ? 5 + rnd() * 2 : wat === 'oasis' ? 2.6 + rnd() * 1.2 : 3.5 + rnd() * 2;
      let cx = W / 2 + (rnd() - 0.5) * 6, cz = D / 2 + (rnd() - 0.5) * 6;
      if (peak) {
        // set the water beside the big feature, never on top of it
        let dx = W / 2 - peak[0], dz = D / 2 - peak[1], len = Math.hypot(dx, dz);
        if (len < 3) { const a = rnd() * Math.PI * 2; dx = Math.cos(a); dz = Math.sin(a); len = 1; }
        const dist = peakR * 0.85 + size;
        cx = Math.max(size * 0.8, Math.min(W - 1 - size * 0.8, peak[0] + dx / len * dist));
        cz = Math.max(size * 0.8, Math.min(D - 1 - size * 0.8, peak[1] + dz / len * dist));
      }
      const L = lake(cx, cz, size * (0.8 + rnd() * 0.4), size * (0.8 + rnd() * 0.4));
      if (L && wat === 'lake+river') {
        // the outlet: the lake's edge closest to the island edge
        let best = null;
        for (const [x, z] of L.cells) { const e = Math.min(x, z, W - 1 - x, D - 1 - z); if (!best || e < best[2]) best = [x, z, e]; }
        river(best[0], best[1], L.level - 1);
      }
    }
    if (wat === 'river') {
      const s = peak ? [peak[0] + (W / 2 - peak[0]) * 0.35, peak[1] + (D / 2 - peak[1]) * 0.35] : [W / 2 + (rnd() - 0.5) * 8, D / 2 + (rnd() - 0.5) * 8];
      const sx = Math.round(s[0]), sz = Math.round(s[1]);
      river(sx, sz, hg[ci(sx, sz)] - 1);
      springs.push([sx, sz]);
    }

    // -- build the columns
    const nearWater = (x, z, r) => {
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx, zz = z + dz;
        if (xx >= 0 && zz >= 0 && xx < W && zz < D && wl[ci(xx, zz)] >= 0) return wl[ci(xx, zz)];
      }
      return -1;
    };
    for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
      const i = ci(x, z), h = hg[i];
      let steep = 0;
      for (const [dx, dz] of DIRS4) { const xx = x + dx, zz = z + dz; if (xx >= 0 && zz >= 0 && xx < W && zz < D) steep = Math.max(steep, h - hg[ci(xx, zz)]); }
      const wv = nearWater(x, z, TH.beach || 1);
      let top;
      if (wl[i] >= 0) top = T.SAND;
      else if (TH.ground === 'snow' || h >= TH.snow) top = T.SNOW;
      else if (TH.ground === 'sand') top = mesa[i] && n3(x / 3, z / 3) > 0.45 ? T.CLAY : T.SAND;
      else if (TH.ground === 'ash') top = n3(x / 3, z / 3) > 0.45 ? T.GRASS : hash3(x, 3, z, seed) < 0.6 ? T.BASALT : T.STONE;
      else if (wv >= 0 && h <= wv + 1) top = T.SAND;
      else if (steep >= 4 && hash3(x, 1, z, seed) < 0.5) top = T.STONE;
      else top = T.GRASS;
      for (let y = 0; y < h; y++) {
        let t;
        if (y === h - 1) t = top;
        else if (y <= 1) t = T.STONE;
        else if (TH.ground === 'sand' || mesa[i]) t = y % 3 === 0 ? T.SAND : T.CLAY;     // banded canyon walls
        else if (top === T.SAND && y >= h - 3) t = T.SAND;
        else if (TH.ground === 'ash' && y < h - 2) t = T.STONE;
        else t = T.DIRT;
        this.type[idx(x, y, z)] = t;
      }
      if (wl[i] > h) for (let y = h; y < wl[i]; y++) { const j = idx(x, y, z); this.fluid[j] = WATER; this.mass[j] = 1; }
    }
    for (const [x, z] of springs) { const y = hg[ci(x, z)] - 1; if (y > 0) this.type[idx(x, y, z)] = T.SPRING; }
    for (const [x, z] of vents) {
      const y = hg[ci(x, z)] - 1;
      this.type[idx(x, y, z)] = T.VENT;
      forEachIn(x, z, 1.5, (xx, zz, d) => { if (d < 1) this.type[idx(xx, hg[ci(xx, zz)] - 1, zz)] = T.BASALT; });
      this.type[idx(x, y, z)] = T.VENT;
    }

    // -- trees, flowers and mushrooms
    const trunks = vents.map(([x, z]) => [x, z]);       // keep the volcano's mouth bare
    const clear = (x, z, d) => trunks.every(([a, b]) => Math.abs(a - x) + Math.abs(b - z) > d);
    const tries = Math.round(W * D * TH.density * 2.2);
    for (let k = 0; k < tries; k++) {
      const x = 1 + ((rnd() * (W - 2)) | 0), z = 1 + ((rnd() * (D - 2)) | 0);
      const y = this.topY(x, z);
      if (y < 0 || wl[ci(x, z)] >= 0 || this.fluid[idx(x, y + 1, z)] || this.type[idx(x, y + 1, z)]) continue;
      const g = this.type[idx(x, y, z)];
      let kind;
      if (g === T.SNOW) kind = pickWeighted(TH.trees, rnd, new Set(['pine', 'birch'])) || (TH.ground === 'snow' ? 'pine' : null);
      else if (g === T.SAND) kind = pickWeighted(TH.trees, rnd, new Set(['palm', 'cactus']));
      else if (g === T.GRASS) kind = pickWeighted(TH.trees, rnd, GRASS_TREES);
      if (vents.some(([vx, vz]) => Math.hypot(vx - x, vz - z) < 5)) continue;
      const spread = kind === 'bush' ? 1 : (kind === 'round' || kind === 'sakura' || kind === 'willow' || kind === 'giantShroom') ? 4 : 3;
      if (!kind || !clear(x, z, spread)) continue;
      if (rnd() > TH.density * 12) continue;
      this.growTree(x, y + 1, z, kind, true);
      trunks.push([x, z]);
    }
    for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
      const y = this.topY(x, z);
      if (y < 0 || y + 1 >= H) continue;
      const a = idx(x, y + 1, z), g = this.type[idx(x, y, z)];
      if (this.type[a] || this.fluid[a]) continue;
      const r = rnd();
      if (g === T.GRASS) {
        const nearTree = !clear(x, z, 2);
        const fp = TH.field ? (n2(x / 2.2, z / 6) > 0.5 ? TH.flowers * 2.6 : TH.flowers * 0.15) : TH.flowers;
        if (r < fp) this.type[a] = T.FLOWER;
        else if (r < fp + TH.shrooms * (nearTree ? 3 : 1)) this.type[a] = T.MUSHROOM;
        else if (r < fp + TH.shrooms * 3 + TH.tufts) this.type[a] = T.TUFT;
        else if (TH.lanterns && nearWater(x, z, 1) >= 0 && r > 1 - TH.lanterns * 4) this.type[a] = T.LANTERN;
      } else if (g === T.SAND && TH.ground === 'sand' && r < 0.02) this.type[a] = T.TUFT;
    }
    this.queue = [];
    this.solidDirty = this.fluidDirty = this.changed = true;
    return { theme, name: this.name };
  };

  const PB = { W, D, H, N, WD, T, WATER, LAVA, DECOR, FLAMMABLE, LEAFY, isSolid, idx, hash3, mulberry, World, PRESETS, THEMES };
  if (typeof module !== 'undefined' && module.exports) module.exports = PB;
  else root.PB = PB;
})(typeof window !== 'undefined' ? window : globalThis);
