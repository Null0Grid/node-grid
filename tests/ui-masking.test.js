'use strict';
// End-to-end check of right-click > Masking, driven through the real app and
// the real native right-click menu (no main-process backdoors):
//   1. a normal tab identifies as Electron/nullgrid-browser (the unmasked default)
//   2. right-click the page, pick "Masking" from the menu with the keyboard
//   3. that tab now looks like plain Google Chrome to the site: the
//      User-Agent header, navigator.userAgent and navigator.userAgentData brands
//   4. a second tab is unaffected (masking is per tab)
//   5. picking "Masking" again turns it back off
// A tiny local page echoes the User-Agent header it received, so no network
// is needed. Needs an X display (xvfb-run) and xdotool to work the native menu.
// Set MASKING_SHOTS=<dir> to also save screenshots of the open menus.
//
//   xvfb-run -a -s "-screen 0 1400x900x24" node tests/ui-masking.test.js
const assert = require('assert');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');
const pw = require('playwright');

const APP_DIR = __dirname + '/..';
const electronPath = require(path.join(APP_DIR, 'node_modules', 'electron'));
const BAD = /Electron\/|nullgrid-browser\/|NODE_GRID\//i;
const SHOTS = process.env.MASKING_SHOTS || '';

function startEchoSite() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const ua = String(req.headers['user-agent'] || '');
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><title>ua-echo</title><body style="background:#fff;font:14px sans-serif">'
        + '<pre id="hdr"></pre><script>document.getElementById("hdr").textContent = ' + JSON.stringify(ua) + ';</script>');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForWindow(app, pred, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 10000)) {
    const w = app.windows().find((w) => { try { return pred(w); } catch { return false; } });
    if (w) return w;
    await wait(150);
  }
  return null;
}
const xdo = (...a) => execFileSync('xdotool', a);
const shot = (name) => { if (SHOTS) execFileSync('import', ['-window', 'root', path.join(SHOTS, name)]); };

async function identity(tab) {
  await tab.waitForSelector('#hdr');
  return tab.evaluate(async () => ({
    header: document.getElementById('hdr').textContent,
    nav: navigator.userAgent,
    brands: (navigator.userAgentData && navigator.userAgentData.brands || []).map((b) => b.brand),
  }));
}
// Right-click the middle of the page, optionally screenshot the open menu, then
// pick "Masking": it sits just above "Inspect", the last item, so Up wraps to
// Inspect and a second Up lands on Masking. (Developer mode is off here, so
// nothing else sits between them.)
async function pickMasking(tab, shotName) {
  await tab.mouse.click(420, 260, { button: 'right' });
  await wait(900);
  if (shotName) shot(shotName);
  xdo('key', 'Up'); await wait(120);
  xdo('key', 'Up'); await wait(120);
  xdo('key', 'Return');
  await wait(1800);   // Masking reloads the page
}

(async () => {
  const site = await startEchoSite();
  const base = 'http://127.0.0.1:' + site.address().port;
  const userData = path.join(require('os').tmpdir(), 'node-grid-ci-mask-' + Date.now());
  const app = await pw._electron.launch({
    args: [APP_DIR, '--user-data-dir=' + userData],
    executablePath: electronPath,
    env: { ...process.env, NODEGRID_TEST_PLAINTEXT_VAULT: '1' },
  });
  let failed = false;
  const check = (label, fn) => { try { fn(); console.log('[pass] ' + label); } catch (e) { failed = true; console.log('[FAIL] ' + label + ': ' + e.message); } };
  try {
    const shell = await waitForWindow(app, (w) => /shell\.html$/.test(w.url()), 15000);
    assert.ok(shell, 'shell window should appear');
    await shell.waitForTimeout(800);

    // Tab A and tab B, both on the echo page; tab B is left alone throughout.
    await shell.evaluate(() => window.shell.newTab());
    await shell.waitForTimeout(300);
    await shell.evaluate((u) => window.shell.go(u), base + '/?tab=b');
    const tabB = await waitForWindow(app, (w) => w.url().includes('tab=b'), 8000);
    await shell.evaluate(() => window.shell.newTab());
    await shell.waitForTimeout(300);
    await shell.evaluate((u) => window.shell.go(u), base + '/?tab=a');
    const tabA = await waitForWindow(app, (w) => w.url().includes('tab=a'), 8000);
    assert.ok(tabA && tabB, 'both echo tabs should load');
    await wait(600);

    const before = await identity(tabA);
    check('unmasked tab still says Electron (the default)', () => assert.ok(BAD.test(before.header) && BAD.test(before.nav)));

    await pickMasking(tabA, 'menu-masking-off.png');
    const on = await identity(tabA);
    console.log('  masked header UA:', on.header);
    console.log('  masked brands   :', on.brands.join(', '));
    check('masked tab: User-Agent header is plain Chrome', () => { assert.ok(!BAD.test(on.header)); assert.ok(/Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/.test(on.header)); });
    check('masked tab: navigator.userAgent matches the header', () => assert.strictEqual(on.nav, on.header));
    check('masked tab: brands say Google Chrome', () => assert.ok(on.brands.includes('Google Chrome')));

    await tabB.reload(); await wait(800);
    const other = await identity(tabB);
    check('other tab is not masked', () => assert.ok(BAD.test(other.header) && !other.brands.includes('Google Chrome')));

    // Menu again, now showing Masking ticked; picking it turns masking off.
    await pickMasking(tabA, 'menu-masking-on.png');
    const off = await identity(tabA);
    check('unmasking restores the normal identity', () => assert.ok(BAD.test(off.header) && !off.brands.includes('Google Chrome')));
  } finally {
    await app.close().catch(() => {});
    site.close();
  }
  if (failed) { console.log('MASKING TEST FAILED'); process.exit(1); }
  console.log('ALL MASKING TESTS PASS');
})().catch((e) => { console.error(e); process.exit(1); });
