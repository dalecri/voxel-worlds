const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const PB = require('../sim.js');

// Capture mesher output before GPU upload; no browser or WebGL is needed.
const context = { PB, window: {}, THREE: { Color: class {
  constructor(hex) { this.r = (hex >> 16 & 255) / 255; this.g = (hex >> 8 & 255) / 255; this.b = (hex & 255) / 255; }
} } };
vm.runInNewContext(fs.readFileSync(require.resolve('../render.js'), 'utf8'), context);
function renderer(world) {
  const view = Object.create(context.window.PBRender.Renderer.prototype);
  Object.assign(view, { world, surfaces: {}, buffers: {}, swap(k, b) { this.buffers[k] = b; } });
  return view;
}
function fill(w, x, y, z, mass, f = PB.WATER) {
  const i = PB.idx(x, y, z); w.fluid[i] = f; w.mass[i] = mass;
}
function vertices(buf) {
  return Array.from({ length: buf.v }, (_, i) => ({
    x: buf.p[i * 3], y: buf.p[i * 3 + 1], z: buf.p[i * 3 + 2],
    ny: buf.n[i * 3 + 1], wave: buf.w[i],
  }));
}

for (const [name, f, amp] of [['water', PB.WATER, 0.045], ['lava', PB.LAVA, 0.03]]) {
  test(`${name}: shallow ripples remain above the floor`, () => {
    const w = new PB.World(); fill(w, 4, 5, 4, 0.004, f);
    w.type[PB.idx(4, 4, 4)] = PB.T.STONE;
    const v = renderer(w); v.rebuildFluids();
    const top = vertices(v.buffers[name]).filter(p => p.ny === 1);
    assert.equal(top.length, 4);
    for (const p of top) assert.ok(p.y - p.wave * amp * 2 >= 5.01999);
  });
  test(`${name}: waterfall junction has no animated cracks`, () => {
    const w = new PB.World();
    fill(w, 4, 5, 4, 1, f); fill(w, 4, 6, 4, 0.4, f);
    fill(w, 5, 5, 4, 0.3, f);
    const v = renderer(w); v.rebuildFluids();
    const seam = vertices(v.buffers[name]).filter(p => p.x === 5 && p.y === 6 && (p.z === 4 || p.z === 5));
    assert.ok(seam.length >= 4);
    for (const p of seam) assert.equal(p.wave, 0);
  });
  test(`${name}: adjacent surfaces and side walls share wave displacement`, () => {
    const w = new PB.World(); fill(w, 4, 5, 4, 0.2, f); fill(w, 5, 5, 4, 0.7, f);
    const v = renderer(w); v.rebuildFluids();
    const points = new Map();
    for (const p of vertices(v.buffers[name])) {
      const key = `${p.x},${p.y},${p.z}`;
      if (points.has(key)) assert.equal(p.wave, points.get(key));
      points.set(key, p.wave);
    }
  });
}

test('corner cache updates when fluid changes and stays separate for lava', () => {
  const w = new PB.World(); fill(w, 4, 5, 4, 0.1); fill(w, 5, 5, 4, 0.7, PB.LAVA);
  const v = renderer(w); v.rebuildFluids(); const cache = v.fluidCorners;
  fill(w, 4, 5, 4, 0.6); v.rebuildFluids();
  assert.equal(v.fluidCorners, cache);
  for (const [name, y] of [['water', 5.6], ['lava', 5.7]]) {
    for (const p of vertices(v.buffers[name]).filter(p => p.ny === 1)) assert.ok(Math.abs(p.y - y) < 1e-6);
  }
});

test('all presets simulate and mesh with finite geometry and valid indices', () => {
  for (const preset of Object.keys(PB.PRESETS)) {
    const w = new PB.World(); w.rand = PB.mulberry(42); w.generate(preset);
    const v = renderer(w);
    for (let tick = 0; tick < 180; tick++) {
      w.step(); w.events.length = 0;
      if (tick % 30) continue;
      v.rebuildFluids();
      for (const b of Object.values(v.buffers)) {
        assert.equal(b.p.length, b.v * 3);
        for (const a of [b.p, b.n, b.c, b.w]) assert.ok(a.every(Number.isFinite));
        assert.ok(b.i.every(i => i >= 0 && i < b.v));
        assert.ok(b.w.every(w => w >= 0 && w <= 1));
      }
    }
  }
});
