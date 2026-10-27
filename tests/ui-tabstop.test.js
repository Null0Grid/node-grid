'use strict';
// End-to-end check of Settings > APPEARANCE > Tabs (side or across the top):
//   1. by default the tabs are down the side
//   2. "Across the top" moves them into a row above the toolbar at once; the
//      sidebar shrinks to a rail one icon wide and the page moves down under the strip
//   3. the top tabs work: click to switch, X to close, + for a new tab
//   4. a rail panel (history) opens the sidebar to full width; closing it shrinks it back
//   5. the choice is saved and still there after a restart
//   6. "On the side" puts everything back the way it was
// Set TT_SHOTS=<dir> for screenshots (dark + light).
//
//   xvfb-run -a -s "-screen 0 1400x900x24" node tests/ui-tabstop.test.js
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const pw = require('playwright');

const APP_DIR = path.resolve(__dirname, '..');
const electronPath = require(path.join(APP_DIR, 'node_modules', 'electron'));
const SHOTS = process.env.TT_SHOTS || '';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { try { const v = await fn(); if (v) return v; } catch {} await wait(150); }
  return null;
}
let failed = false;
const check = async (label, fn) => { try { await fn(); console.log('[pass] ' + label); } catch (e) { failed = true; console.log('[FAIL] ' + label + ': ' + e.message); } };
const shot = (name) => { if (SHOTS) execFileSync('import', ['-window', 'root', path.join(SHOTS, name)]); };

(async () => {
  const COLORS = { '/rack': '#123', '/grafana': '#241', '/pihole': '#412', '/proxmox': '#224' };
  const site = http.createServer((q, r) => { r.setHeader('Content-Type', 'text/html'); const p = new URL(q.url, 'http://x').pathname; r.end(`<!doctype html><title>${p.slice(1) || 'home'} dashboard</title><body style="background:${COLORS[p] || '#fff'};color:#fff;font:28px sans-serif;padding:30px">${p}`); });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + site.address().port;
  const ud = path.join(os.tmpdir(), 'node-grid-ci-tabstop-' + Date.now());
  fs.mkdirSync(ud, { recursive: true });
  fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ seenVersion: require(path.join(APP_DIR, 'package.json')).version }));
  const settingsFile = () => JSON.parse(fs.readFileSync(path.join(ud, 'settings.json'), 'utf8'));
  const launch = () => pw._electron.launch({ args: [APP_DIR, '--user-data-dir=' + ud], executablePath: electronPath,
    env: { ...process.env, NODEGRID_TEST_PLAINTEXT_VAULT: '1', NODEGRID_UPDATE_URL: 'http://127.0.0.1:1/', NODEGRID_SKIP_INTRO: '1' } });
  let app = await launch(), shell;
  const errors = [];
  const attach = async () => {
    shell = await waitFor(() => app.windows().find((w) => /shell\.html$/.test(w.url())), 15000);
    shell.on('pageerror', (e) => errors.push(e.message));
    await shell.evaluate(() => { window.__s = null; window.shell.onState((s) => { window.__s = s; }); });
    await wait(1200);
  };
  const layout = () => shell.evaluate(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; };
    const tabs = [...document.querySelectorAll('#tabs .tab')].map((li) => ({ ...r(li), title: li.querySelector('.title').textContent, titleShown: getComputedStyle(li.querySelector('.title')).display !== 'none', active: li.classList.contains('active') }));
    return { top: document.body.classList.contains('tabs-top'), inStrip: !!document.querySelector('#topstrip #tabs'), inSide: !!document.querySelector('#sidebar #tabs'),
      side: r(document.getElementById('sidebar')), vp: r(document.getElementById('viewport')), strip: r(document.getElementById('topstrip')), tabs,
      newtabShown: getComputedStyle(document.getElementById('newtab')).display !== 'none' && r(document.getElementById('newtab')).w > 0 };
  });
  const settingsPage = async () => {
    await shell.evaluate(() => window.shell.openSettings());
    const s = await waitFor(() => app.windows().find((w) => /settings\.html/.test(w.url())), 8000);
    await s.waitForSelector('#sections section');
    return s;
  };
  try {
    await attach();
    for (const p of ['/rack', '/grafana', '/pihole']) { await shell.evaluate(() => window.shell.newTab()); await wait(300); await shell.evaluate((u) => window.shell.go(u), base + p); await wait(500); }
    await waitFor(async () => (await layout()).tabs.filter((t) => /dashboard/.test(t.title)).length === 3, 8000);
    const before = await layout();
    await check('by default the tabs are down the side', () => { assert.ok(before.inSide && !before.top, JSON.stringify(before)); assert.ok(before.side.w >= 200); });

    let s = await settingsPage();
    await check('Settings has the Tabs choice', async () => assert.ok(await s.evaluate(() => /Across the top/.test(document.getElementById('look').textContent))));
    await s.evaluate(() => window.ngSettings.do('tabs-pos', 'top'));
    // back to a site tab
    await shell.evaluate(() => { const s = window.__s; const t = s.tabs.find((x) => /pihole/.test(x.title)); if (t) window.shell.activate(t.id); });
    await waitFor(async () => (await layout()).top, 5000);
    await wait(700);
    let L = await layout();
    await check('"Across the top" moves the tabs into a row above the toolbar at once', () => {
      assert.ok(L.top && L.inStrip && !L.inSide, JSON.stringify(L));
      const site3 = L.tabs.filter((t) => /dashboard/.test(t.title));
      assert.strictEqual(site3.length, 3);
      assert.ok(site3.every((t) => Math.abs(t.y - site3[0].y) < 2), 'not one row');
      assert.ok(site3[1].x > site3[0].x && site3[2].x > site3[1].x, 'not left to right');
      assert.ok(site3.every((t) => t.titleShown && t.w >= 72), 'titles hidden / too narrow');
    });
    await check('...the sidebar is a rail one icon wide', () => assert.ok(L.side.w <= 56, 'rail is ' + L.side.w));
    await check('...and the page sits under the tab strip and toolbar', () => assert.ok(L.vp.y >= L.strip.y + L.strip.h + 30 && L.vp.x <= 56, JSON.stringify(L.vp)));
    await check('...with the new-tab button on the strip', () => assert.ok(L.newtabShown));
    await wait(300); shot('tabs-top-dark.png');

    // 3. use them
    const grafana = L.tabs.find((t) => /grafana/.test(t.title));
    await shell.mouse.click(grafana.x + 30, grafana.y + grafana.h / 2);
    await check('clicking a top tab switches to it', async () => assert.ok(await waitFor(async () => { const st = await shell.evaluate(() => window.__s); return st.tabs.find((t) => t.id === st.activeId).title === 'grafana dashboard'; }, 4000)));
    const n0 = (await shell.evaluate(() => window.__s)).tabs.length;
    await shell.click('#topstrip #newtab');
    await check('+ on the strip opens a new tab', async () => assert.ok(await waitFor(async () => (await shell.evaluate(() => window.__s)).tabs.length === n0 + 1, 4000)));
    L = await layout();
    const rackIdx = L.tabs.findIndex((t) => /rack/.test(t.title));
    await shell.hover(`#tabs .tab:nth-child(${rackIdx + 1})`);
    await shell.click(`#tabs .tab:nth-child(${rackIdx + 1}) .close`);
    await check("a top tab's X closes it", async () => assert.ok(await waitFor(async () => !(await shell.evaluate(() => window.__s)).tabs.some((t) => /rack/.test(t.title)), 4000)));

    // 4. rail panel
    await shell.click('#histbtn');
    await check('opening History from the rail opens the sidebar to full width', async () => assert.ok(await waitFor(async () => (await layout()).side.w >= 200, 3000)));
    await check('...and the tabs stay on the strip meanwhile', async () => { const l = await layout(); assert.ok(l.inStrip && l.tabs.length >= 3 && l.tabs.every((t) => t.w > 0)); });
    await wait(300); shot('tabs-top-history.png');
    await shell.click('#histbtn');
    await shell.mouse.move(700, 20);                 // off the rail (hovering it peeks it open, like the shrunk sidebar)
    await check('closing it shrinks the rail back', async () => assert.ok(await waitFor(async () => (await layout()).side.w <= 56, 3000)));

    s = await settingsPage();
    await s.evaluate(() => window.ngSettings.do('theme', 'light'));
    await shell.evaluate(() => { const s = window.__s; const t = s.tabs.find((x) => /grafana/.test(x.title)); if (t) window.shell.activate(t.id); });
    await wait(900); shot('tabs-top-light.png');
    await check('the choice is saved', () => assert.strictEqual(settingsFile().tabsPos, 'top'));
  } finally { await app.close().catch(() => {}); }

  app = await launch();
  try {
    await attach();
    await check('after a restart the tabs are still across the top', async () => assert.ok(await waitFor(async () => { const l = await layout(); return l.top && l.inStrip && l.side.w <= 56; }, 5000)));
    const s = await settingsPage();
    await s.evaluate(() => window.ngSettings.do('theme', 'dark'));
    await s.evaluate(() => window.ngSettings.do('tabs-pos', 'side'));
    await check('"On the side" puts the tabs back down the side, full width', async () => assert.ok(await waitFor(async () => { const l = await layout(); return !l.top && l.inSide && l.side.w >= 200 && l.vp.y < 100 && l.strip.h === 0; }, 5000)));
    await check('...and the setting is cleared', () => assert.strictEqual(settingsFile().tabsPos, undefined));
    await check('no errors in the shell', () => assert.deepStrictEqual(errors, []));
  } finally { await app.close().catch(() => {}); site.close(); }
  if (failed) { console.log('TABS ON TOP TEST FAILED'); process.exit(1); }
  console.log('ALL TABS ON TOP TESTS PASS');
})().catch((e) => { console.error(e); process.exit(1); });
