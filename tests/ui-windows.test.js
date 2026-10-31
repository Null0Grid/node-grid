'use strict';
// End-to-end check of several Null Grid windows:
//   1. Ctrl+N opens a second window with a tab of its own (pinned tabs stay in the first)
//   2. each window browses on its own: typing an address in one never touches the other
//   3. favorites (and the rest of your settings) are shared: starring in one shows in both
//   4. a tab moves to a new window (dragged out) with its page still loaded, and moves
//      into another window (dropped on its tabs); a window left with no tabs closes
//   5. Settings is one tab: opening it from another window jumps to it
//   6. closing a window's last tab closes that window; the others carry on
//   7. after an update restart every window comes back with its own tabs
//
//   xvfb-run -a -s "-screen 0 1400x900x24" node tests/ui-windows.test.js
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const pw = require('playwright');

const APP_DIR = path.resolve(__dirname, '..');
const electronPath = require(path.join(APP_DIR, 'node_modules', 'electron'));
const SHOTS = process.env.WIN_SHOTS || '';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { try { const v = await fn(); if (v) return v; } catch {} await wait(150); }
  return null;
}
let failed = false;
const check = async (label, fn) => { try { await fn(); console.log('[pass] ' + label); } catch (e) { failed = true; console.log('[FAIL] ' + label + ': ' + e.message); } };

(async () => {
  const site = http.createServer((q, r) => { r.setHeader('Content-Type', 'text/html'); const p = new URL(q.url, 'http://x').pathname; r.end(`<!doctype html><title>page ${p}</title><body style="background:#fff;font:26px sans-serif;padding:30px">${p}`); });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + site.address().port;
  const ud = path.join(os.tmpdir(), 'null-grid-ci-windows-' + Date.now());
  fs.mkdirSync(ud, { recursive: true });
  const VERSION = require(path.join(APP_DIR, 'package.json')).version;
  fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ seenVersion: VERSION, pinned: [base + '/pinned'] }));
  const settingsFile = () => JSON.parse(fs.readFileSync(path.join(ud, 'settings.json'), 'utf8'));
  const launch = () => pw._electron.launch({ args: [APP_DIR, '--user-data-dir=' + ud], executablePath: electronPath,
    env: { ...process.env, NULLGRID_TEST_PLAINTEXT_VAULT: '1', NULLGRID_UPDATE_URL: 'http://127.0.0.1:1/', NULLGRID_SKIP_INTRO: '1', NULLGRID_FAVS: path.join(ud, 'favs.json') } });
  let app = await launch();
  const errors = [];
  const known = new Set();
  const shells = () => app.windows().filter((w) => /shell\.html$/.test(w.url()));
  const hook = async (s) => {
    if (known.has(s)) return s;
    known.add(s);
    s.on('pageerror', (e) => errors.push(e.message));
    await s.waitForLoadState('domcontentloaded').catch(() => {});
    await s.evaluate(() => { if (!window.__hooked) { window.__hooked = true; window.__s = null; window.shell.onState((st) => { window.__s = st; }); } window.shell.refreshState(); });
    return s;
  };
  const newShell = async (before) => hook(await waitFor(() => shells().find((s) => !before.includes(s)), 10000));
  const st = (s) => s.evaluate(() => window.__s);
  const titles = async (s) => ((await st(s)) || { tabs: [] }).tabs.map((t) => t.title);
  const activeTitle = async (s) => { const x = await st(s); const t = x && x.tabs.find((y) => y.id === x.activeId); return t && t.title; };
  const nWindows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length);
  const go = (s, u) => s.evaluate((x) => window.shell.go(x), u);
  const pageAt = (u) => app.windows().filter((w) => w.url() === u).pop();
  // a real Ctrl+N (shortcuts only answer real key presses), in the window that has focus
  const ctrlN = async (title) => {
    await app.evaluate(({ BrowserWindow }, t) => { const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === t) || BrowserWindow.getAllWindows()[0]; w.focus(); }, title);
    await wait(400);
    execFileSync('xdotool', ['key', '--clearmodifiers', 'ctrl+n']);
  };
  const shot = (name) => { if (SHOTS) execFileSync('import', ['-window', 'root', path.join(SHOTS, name)]); };
  try {
    const s1 = await hook(await waitFor(() => shells()[0], 15000));
    await wait(1200);
    await s1.evaluate(() => window.shell.newTab()); await wait(300); await go(s1, base + '/a');
    await waitFor(async () => (await activeTitle(s1)) === 'page /a');
    await s1.evaluate(() => window.shell.newTab()); await wait(300); await go(s1, base + '/b');
    await waitFor(async () => (await activeTitle(s1)) === 'page /b');
    await check('one window to start with, pinned tab in it', async () => { assert.strictEqual(await nWindows(), 1); assert.ok((await titles(s1)).includes('page /pinned'), JSON.stringify(await titles(s1))); });

    // 1. Ctrl+N
    let before = shells();
    await ctrlN('page /b - Null Grid');
    const s2 = await newShell(before);
    await check('Ctrl+N opens a second window', async () => assert.ok(s2 && await waitFor(async () => (await nWindows()) === 2)));
    await waitFor(async () => ((await st(s2)) || { tabs: [] }).tabs.length === 1, 8000);
    await check('...with one tab of its own (the start page), no pinned tabs', async () => {
      const t = await titles(s2);
      assert.strictEqual(t.length, 1, JSON.stringify(t));
      assert.ok(!t.includes('page /pinned'));
    });
    await check('...and the first window keeps its tabs', async () => assert.deepStrictEqual((await titles(s1)).filter((x) => /page/.test(x)), ['page /pinned', 'page /a', 'page /b']));

    // 2. separate browsing
    await go(s2, base + '/c');
    await check('typing an address in window 2 loads it there', async () => assert.ok(await waitFor(async () => (await activeTitle(s2)) === 'page /c')));
    await check('...and window 1 is untouched', async () => { assert.strictEqual(await activeTitle(s1), 'page /b'); assert.ok(!(await titles(s1)).includes('page /c')); });
    await check('each window is named after the tab it shows (taskbar, Alt+Tab)', async () => assert.ok(await waitFor(async () => {
      const ts = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()));
      return ts.includes('page /b - Null Grid') && ts.includes('page /c - Null Grid');
    })));

    // 3. shared favorites
    await s2.evaluate(() => window.shell.toggleFav());
    await check('starring a page in window 2 shows it in window 1 too', async () => assert.ok(await waitFor(async () => ((await st(s1)).favs || []).some((f) => f.url.startsWith(base + '/c')))));
    if (SHOTS) { await wait(500); shot('two-windows.png'); }

    // 4. moving tabs
    const pb = pageAt(base + '/b');
    await pb.evaluate(() => { window.__still = 'same page'; });
    const idB = (await st(s1)).tabs.find((t) => t.title === 'page /b').id;
    before = shells();
    await s1.evaluate((id) => window.shell.tabToNewWindow(id, { x: 300, y: 200 }), idB);
    const s3 = await newShell(before);
    await check('a tab dragged out of the window gets a new window', async () => {
      assert.ok(s3);
      assert.ok(await waitFor(async () => (await titles(s3)).length === 1 && (await titles(s3))[0] === 'page /b'));
      assert.strictEqual(await nWindows(), 3);
    });
    await check('...it left the first window', async () => assert.ok(await waitFor(async () => !(await titles(s1)).includes('page /b'))));
    await check('...and its page kept running (not reloaded)', async () => assert.strictEqual(await pb.evaluate(() => window.__still), 'same page'));
    await s2.evaluate((id) => window.shell.adoptTab(id), idB);
    await check('dropping it on window 2 moves it there', async () => assert.ok(await waitFor(async () => (await titles(s2)).includes('page /b'))));
    await check('...and the window it left, now empty, closes', async () => assert.ok(await waitFor(async () => (await nWindows()) === 2)));
    await check('...still the same page', async () => assert.strictEqual(await pb.evaluate(() => window.__still), 'same page'));

    // 5. one Settings tab
    await s1.evaluate(() => window.shell.openSettings());
    await waitFor(async () => (await titles(s1)).some((t) => /settings/i.test(t)));
    await s2.evaluate(() => window.shell.openSettings());
    await wait(800);
    await check('Settings opened from window 2 jumps to its tab in window 1 (no second copy)', async () => {
      const all = [...await titles(s1), ...await titles(s2)].filter((t) => /settings/i.test(t));
      assert.strictEqual(all.length, 1, JSON.stringify(all));
      assert.ok(/settings/i.test(await activeTitle(s1)));
    });

    // 6. closing the last tab closes the window
    for (const t of (await st(s2)).tabs) await s2.evaluate((id) => window.shell.closeTab(id), t.id).catch(() => {});
    await check("closing window 2's last tab closes window 2", async () => assert.ok(await waitFor(async () => (await nWindows()) === 1)));
    await s1.evaluate(() => window.shell.newTab()); await wait(300); await go(s1, base + '/d');
    await check('...and window 1 carries on', async () => assert.ok(await waitFor(async () => (await activeTitle(s1)) === 'page /d')));
    before = shells();
    await ctrlN('page /d - Null Grid');
    const s4 = await newShell(before);
    await waitFor(async () => (await nWindows()) === 2);
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find((w) => w.getTitle() !== 'page /d - Null Grid').close(); });   // the new one
    await check('closing a window with its X leaves the other one working', async () => {
      assert.ok(await waitFor(async () => (await nWindows()) === 1));
      await s1.evaluate(() => window.shell.newTab()); await wait(300); await go(s1, base + '/e');
      assert.ok(await waitFor(async () => (await activeTitle(s1)) === 'page /e'));
    });
    void s4;
    await check('no errors in any window', () => assert.deepStrictEqual(errors, []));
  } finally { await app.close().catch(() => {}); }

  // 7. back after an update restart: every window, each with its tabs
  const sf = settingsFile();
  sf.restoreTabs = [base + '/a', base + '/b']; sf.restoreWindows = [[base + '/a', base + '/b'], [base + '/c']];
  fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify(sf));
  app = await launch();
  known.clear();
  try {
    await waitFor(async () => shells().length === 2, 15000);
    const list = await Promise.all(shells().map(hook));
    await wait(2500);
    const sets = await Promise.all(list.map(async (s) => (await titles(s)).filter((t) => /page/.test(t)).sort()));
    await check('after an update restart both windows come back with their own tabs', () => {
      const j = sets.map((x) => x.join(',')).sort();
      assert.deepStrictEqual(j, ['page /a,page /b,page /pinned', 'page /c'], JSON.stringify(sets));
    });
    await check('...and the restart list is cleared', () => { const s = settingsFile(); assert.ok(!s.restoreWindows && !s.restoreTabs); });
  } finally { await app.close().catch(() => {}); site.close(); }
  if (failed) { console.log('WINDOWS TEST FAILED'); process.exit(1); }
  console.log('ALL WINDOWS TESTS PASS');
})().catch((e) => { console.error(e); process.exit(1); });
