'use strict';
// End-to-end check of pinned tabs, through the real app and its real right-click
// menu (driven with xdotool):
//   1. right-click a tab > Pin tab moves it into the pinned row at the top
//   2. clicking a pinned tab's icon switches to it (it used to do nothing: the
//      icon swallowed clicks, and a pinned tab is almost all icon)
//   3. clicking the pinned tab again after using another tab still switches back
// Needs an X display (xvfb-run) and xdotool. Set PIN_SHOTS=<dir> for a screenshot.
//
//   xvfb-run -a -s "-screen 0 1400x900x24" node tests/ui-pinned.test.js
const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const pw = require('playwright');

const APP_DIR = __dirname + '/..';
const electronPath = require(path.join(APP_DIR, 'node_modules', 'electron'));
const SHOTS = process.env.PIN_SHOTS || '';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { try { const v = await fn(); if (v) return v; } catch {} await wait(150); }
  return null;
}

(async () => {
  const site = http.createServer((q, r) => { r.setHeader('Content-Type', 'text/html'); r.end('<!doctype html><title>page ' + q.url + '</title><body style="background:#fff">' + q.url); });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + site.address().port;
  const app = await pw._electron.launch({
    args: [APP_DIR, '--user-data-dir=' + path.join(os.tmpdir(), 'null-grid-ci-pin-' + Date.now())],
    executablePath: electronPath,
    env: { ...process.env, NULLGRID_TEST_PLAINTEXT_VAULT: '1', NULLGRID_UPDATE_URL: 'http://127.0.0.1:1/', NULLGRID_SKIP_INTRO: '1' },
  });
  let failed = false;
  const check = async (label, fn) => { try { await fn(); console.log('[pass] ' + label); } catch (e) { failed = true; console.log('[FAIL] ' + label + ': ' + e.message); } };
  try {
    const shell = await waitFor(() => app.windows().find((w) => /shell\.html$/.test(w.url())), 15000);
    assert.ok(shell, 'shell window should appear');
    await wait(800);
    for (const p of ['/pinme', '/other']) {
      await shell.evaluate(() => window.shell.newTab()); await wait(300);
      await shell.evaluate((u) => window.shell.go(u), base + p); await wait(600);
    }
    const state = () => shell.evaluate(() => ({
      pins: [...document.querySelectorAll('#pins .tab')].length,
      tabs: [...document.querySelectorAll('#tabs .tab')].length,
      activePinned: !!document.querySelector('#pins .tab.active'),
    }));

    // 1. pin "/pinme" (the 2nd tab) through its right-click menu: Pin tab is the 10th item (after New tab, New window, Duplicate, Move to new window, ...)
    const tabEl = (await shell.$$('#tabs .tab'))[1];
    await tabEl.click({ button: 'right' });
    await wait(900);
    for (let i = 0; i < 10; i++) { execFileSync('xdotool', ['key', 'Down']); await wait(80); }
    execFileSync('xdotool', ['key', 'Return']);
    await check('Pin tab moves it into the pinned row', async () => assert.ok(await waitFor(async () => (await state()).pins === 1, 4000), JSON.stringify(await state())));

    // make the other tab active, then click the pinned tab's icon
    await shell.evaluate(() => [...document.querySelectorAll('#tabs .tab .title')].pop().closest('.tab').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })));
    await wait(400);
    await check('another tab is active first', async () => assert.strictEqual((await state()).activePinned, false));
    await shell.click('#pins .tab .fav');
    await check('clicking the pinned tab opens it', async () => assert.ok(await waitFor(async () => (await state()).activePinned, 3000)));
    if (SHOTS) execFileSync('import', ['-window', 'root', path.join(SHOTS, 'pinned-tab.png')]);

    // 3. again, after switching away
    await shell.evaluate(() => [...document.querySelectorAll('#tabs .tab .title')].pop().closest('.tab').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })));
    await wait(400);
    await shell.click('#pins .tab');
    await check('...and again after using another tab', async () => assert.ok(await waitFor(async () => (await state()).activePinned, 3000)));
  } finally {
    await app.close().catch(() => {});
    site.close();
  }
  if (failed) { console.log('PINNED TAB TEST FAILED'); process.exit(1); }
  console.log('ALL PINNED TAB TESTS PASS');
})().catch((e) => { console.error(e); process.exit(1); });
