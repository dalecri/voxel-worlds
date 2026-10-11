const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const root = path.resolve('www');
  const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '/index.html'));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' };
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream'); res.end(data);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const page = await browser.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    page.on('console', msg => { if (msg.type() === 'error' && /WebGL|shader|THREE/i.test(msg.text())) errors.push(msg.text()); });
    await page.addInitScript(() => localStorage.setItem('pb.intro', 'true'));
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__pb);
    fs.mkdirSync('test-results', { recursive: true });
    for (const preset of ['valley', 'volcano', 'meadow']) {
      await page.evaluate(preset => {
        const { world, view } = window.__pb;
        world.generate(preset);
        for (let i = 0; i < 90; i++) { world.step(); world.events.length = 0; }
        view.rebuildSolid(); view.rebuildFluids();
        world.solidDirty = world.fluidDirty = false;
      }, preset);
      for (let side = 0; side < 4; side++) {
        await page.evaluate(side => { const v = window.__pb.view; v.yaw = v.yawGoal = Math.PI / 4 + side * Math.PI / 2; }, side);
        await page.waitForTimeout(250);
        await page.screenshot({ path: `test-results/${preset}-${side}.png` });
      }
    }
    const result = await page.evaluate(() => {
      const v = window.__pb.view;
      return { transparent: v.waterMat.transparent, depthWrite: v.waterMat.depthWrite,
        distinctShaders: v.waterMat.customProgramCacheKey() !== v.lavaMat.customProgramCacheKey(),
        lost: v.r.getContext().isContextLost(), calls: v.r.info.render.calls };
    });
    assert.equal(result.transparent, false); assert.equal(result.depthWrite, true);
    assert.equal(result.distinctShaders, true); assert.equal(result.lost, false);
    assert.ok(result.calls > 0); assert.deepEqual(errors, []);
    console.log('Browser smoke passed:', result);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
