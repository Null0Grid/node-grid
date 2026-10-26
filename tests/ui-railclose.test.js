'use strict';
// End-to-end check of closing tabs from the shrunk sidebar, through the real app:
// with the sidebar shrunk and Settings > FEATURES > "Expand the shrunk sidebar
// when you hover over it" switched OFF, a tab's own close button is hidden, so
//   1. a click on a tab's icon switches to that tab (never closes it)
//   2. hovering a tab for under 2 s shows nothing; after 2 s a small close X shows
//      on the icon's top-right corner, and the icon stays
//   3. clicking the icon with the X showing still switches tabs; clicking the X closes
//   4. with hover-to-expand ON, the X never shows (the sidebar expands instead)
// Needs an X display (xvfb-run). Set RAIL_SHOTS=<dir> to save a screenshot of the X.
//
//   xvfb-run -a -s "-screen 0 1400x900x24" node tests/ui-railclose.test.js
const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const pw = require('playwright');

const APP_DIR = __dirname + '/..';
const electronPath = require(path.join(APP_DIR, 'node_modules', 'electron'));
const SHOTS = process.env.RAIL_SHOTS || '';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { try { const v = await fn(); if (v) return v; } catch {} await wait(150); }
  return null;
}

(async () => {
  const site = http.createServer((q, r) => { r.setHeader('Content-Type', 'text/html'); r.end('<!doctype html><title>page ' + q.url + '</title><body style="background:#fff">x'); });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + site.address().port;
  const app = await pw._electron.launch({
    args: [APP_DIR, '--user-data-dir=' + path.join(os.tmpdir(), 'node-grid-ci-rail-' + Date.now())],
    executablePath: electronPath,
    env: { ...process.env, NODEGRID_TEST_PLAINTEXT_VAULT: '1', NODEGRID_UPDATE_URL: 'http://127.0.0.1:1/', NODEGRID_SKIP_INTRO: '1' },
  });
  let failed = false;
  const check = async (label, fn) => { try { await fn(); console.log('[pass] ' + label); } catch (e) { failed = true; console.log('[FAIL] ' + label + ': ' + e.message); } };
  try {
    const shell = await waitFor(() => app.windows().find((w) => /shell\.html$/.test(w.url())), 15000);
    assert.ok(shell, 'shell window should appear');
    await wait(800);
    const tabs = () => shell.$$('#tabs .tab');
    const count = async () => (await tabs()).length;
    const active = () => shell.evaluate(() => [...document.querySelectorAll('#tabs .tab')].findIndex((t) => t.classList.contains('active')));
    for (const p of ['/a', '/b']) {
      await shell.evaluate(() => window.shell.newTab()); await wait(300);
      await shell.evaluate((u) => window.shell.go(u), base + p); await wait(500);
    }
    await waitFor(async () => (await count()) === 3);

    // Switch hover-to-expand off in Settings, then come back to tab 3 ("/b").
    await shell.evaluate(() => window.shell.openSettings());
    const settings = await waitFor(() => app.windows().find((w) => /settings\.html/.test(w.url())), 8000);
    await settings.waitForSelector('.fitem');
    await settings.evaluate(() => [...document.querySelectorAll('.fitem')].find((i) => /Expand sidebar on hover/.test(i.textContent)).querySelector('.tgl').click());
    await wait(600);
    await shell.evaluate(() => [...document.querySelectorAll('#tabs .tab .close')].pop().click());   // close the Settings tab
    await waitFor(async () => (await count()) === 3);
    await shell.evaluate(() => { if (!document.body.classList.contains('collapsed')) document.getElementById('toggle').click(); });
    await wait(500);
    await check('hover-to-expand is off and the sidebar is shrunk', async () => assert.ok(await shell.evaluate(() => document.body.classList.contains('collapsed') && document.body.classList.contains('nofeat-hoverpeek'))));

    // 1. click on tab 2's icon switches to it
    const fav = async (i) => (await tabs())[i].$('.fav');
    await (await fav(1)).click();
    await wait(400);
    await check('a click on an icon switches to that tab', async () => { assert.strictEqual(await active(), 1); assert.strictEqual(await count(), 3); });

    // 2. hover tab 3: nothing at 1 s, the corner X at 2 s, icon still there
    const xState = (i) => shell.evaluate((i) => {
      const f = [...document.querySelectorAll('#tabs .tab .fav')][i], x = f.querySelector('.fav-x'), ic = f.querySelector('.icon');
      const fb = f.getBoundingClientRect(), xb = x.getBoundingClientRect();
      return { on: f.classList.contains('x-on'), xShown: getComputedStyle(x).display !== 'none', iconShown: getComputedStyle(ic).display !== 'none', corner: xb.left > fb.left + fb.width / 2 && xb.top < fb.top + fb.height / 2 };
    }, i);
    await shell.mouse.move(0, 0);
    await (await fav(2)).hover();
    await wait(1000);
    await check('hovering for 1 second shows no X yet', async () => assert.strictEqual((await xState(2)).xShown, false));
    await wait(1400);
    await check('after 2 seconds a small X shows on the top-right corner, and the icon stays', async () => { const x = await xState(2); assert.ok(x.xShown && x.iconShown && x.corner, JSON.stringify(x)); });
    if (SHOTS) execFileSync('import', ['-window', 'root', path.join(SHOTS, 'rail-close-x.png')]);
    // 3. the icon still switches; the X closes
    const fb = await (await fav(2)).boundingBox();
    await shell.mouse.click(fb.x + fb.width * 0.35, fb.y + fb.height * 0.65);
    await wait(400);
    await check('with the X showing, clicking the icon itself switches to the tab (no close)', async () => { assert.strictEqual(await count(), 3); assert.strictEqual(await active(), 2); });
    await waitFor(async () => (await xState(2)).xShown, 3000) || (await (await fav(2)).hover(), await wait(2300));
    const xb = await (await (await tabs())[2].$('.fav-x')).boundingBox();
    await shell.mouse.click(xb.x + xb.width / 2, xb.y + xb.height / 2);
    await check('clicking the corner X closes that tab', async () => assert.ok(await waitFor(async () => (await count()) === 2, 4000)));

    // 3. hover-to-expand back on: no X on the rail
    await shell.evaluate(() => window.shell.openSettings());
    const s2 = await waitFor(() => app.windows().find((w) => /settings\.html/.test(w.url())), 8000);
    await s2.waitForSelector('.fitem');
    await s2.evaluate(() => [...document.querySelectorAll('.fitem')].find((i) => /Expand sidebar on hover/.test(i.textContent)).querySelector('.tgl').click());
    await wait(600);
    await check('with hover-to-expand on, the icon never turns into an X', async () => {
      assert.ok(!(await shell.evaluate(() => document.body.classList.contains('nofeat-hoverpeek'))));
      await shell.mouse.move(0, 0);
      await (await fav(1)).hover(); await wait(2400);
      assert.ok(!(await shell.evaluate(() => [...document.querySelectorAll('#tabs .tab .fav')][1].classList.contains('x-on'))));
    });
  } finally {
    await app.close().catch(() => {});
    site.close();
  }
  if (failed) { console.log('RAIL CLOSE TEST FAILED'); process.exit(1); }
  console.log('ALL RAIL CLOSE TESTS PASS');
})().catch((e) => { console.error(e); process.exit(1); });
