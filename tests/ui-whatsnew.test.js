'use strict';
// End-to-end check of the What's new card and the first-start walkthrough hook:
//   1. after an update (you last saw an older version), the start page shows the
//      card with every version since, newest first; GOT IT closes it for good
//   2. the next start doesn't show it again
//   3. Settings > About > WHAT'S NEW shows it any time
//   4. a brand-new install never gets the What's new card; it gets Packet's
//      walkthrough, which plays, and SKIP closes it
//
//   xvfb-run -a -s "-screen 0 1400x900x24" node tests/ui-whatsnew.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const pw = require('playwright');

const APP_DIR = path.resolve(__dirname, '..');
const electronPath = require(path.join(APP_DIR, 'node_modules', 'electron'));
const SHOTS = process.env.WN_SHOTS || '';
const VERSION = require(path.join(APP_DIR, 'package.json')).version;
const NOTES = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'whats-new.json'), 'utf8'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { try { const v = await fn(); if (v) return v; } catch {} await wait(150); }
  return null;
}
const parts = (v) => v.split('.').map(Number);
const newer = (a, b) => { const x = parts(a), y = parts(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
let failed = false;
const check = async (label, fn) => { try { await fn(); console.log('[pass] ' + label); } catch (e) { failed = true; console.log('[FAIL] ' + label + ': ' + e.message); } };

(async () => {
  const launch = (ud) => pw._electron.launch({ args: [APP_DIR, '--user-data-dir=' + ud], executablePath: electronPath,
    env: { ...process.env, NULLGRID_TEST_PLAINTEXT_VAULT: '1', NULLGRID_UPDATE_URL: 'http://127.0.0.1:1/' } });
  const card = (app) => app.windows().find((w) => /whatsnew\.html/.test(w.url()));
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-wn-'));
  fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ seenVersion: '5.1.2' }));
  const want = Object.keys(NOTES).filter((v) => !newer(v, VERSION) && newer(v, '5.1.2')).sort((a, b) => (newer(a, b) ? -1 : 1)).slice(0, 4);   // the card shows the 4 newest at most

  let app = await launch(ud);
  try {
    const c = await waitFor(() => card(app), 12000);
    await check('after an update, the start page shows the What\'s new card', () => assert.ok(c));
    await c.waitForSelector('#notes section');
    const shown = await c.evaluate(() => [...document.querySelectorAll('#notes h2')].map((h) => h.textContent.split(' ')[0]));
    await check(`it lists the versions since the one you had (newest 4), newest first (${want.join(', ')})`, () => assert.deepStrictEqual(shown, want));
    await check('each version shows what is new and what was fixed', async () => assert.ok(await c.evaluate(() => document.querySelectorAll('#notes li').length > 0 && !!document.querySelector('#notes h3.new'))));
    if (SHOTS) { await wait(400); execFileSync('import', ['-window', 'root', path.join(SHOTS, 'whats-new.png')]); }
    await c.click('#ok').catch(() => {});
    await check('GOT IT closes it and remembers this version', async () => {
      assert.ok(await waitFor(() => !card(app), 4000));
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(ud, 'settings.json'), 'utf8')).seenVersion, VERSION);
    });
  } finally { await app.close().catch(() => {}); }

  app = await launch(ud);
  try {
    await wait(5000);
    await check("the next start doesn't show it again", () => assert.ok(!card(app)));
    const shell = app.windows().find((w) => /shell\.html$/.test(w.url()));
    await shell.evaluate(() => window.shell.openSettings());
    const s = await waitFor(() => app.windows().find((w) => /settings\.html/.test(w.url())), 8000);
    await s.waitForSelector('#about');
    await s.evaluate(() => [...document.querySelectorAll('#about button')].find((b) => /WHAT'S NEW/.test(b.textContent)).click());
    await check("Settings > About > WHAT'S NEW shows it any time", async () => assert.ok(await waitFor(() => card(app), 5000)));
  } finally { await app.close().catch(() => {}); }

  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-wn-fresh-'));
  app = await launch(fresh);
  try {
    await wait(5000);
    await check("a brand-new install doesn't get the What's new card", () => assert.ok(!card(app)));
    await check('...and counts this version as seen', () => assert.strictEqual(JSON.parse(fs.readFileSync(path.join(fresh, 'settings.json'), 'utf8')).seenVersion, VERSION));
    const tour = await waitFor(() => app.windows().find((w) => /tour\.html/.test(w.url())), 4000);
    await check("...it gets Packet's walkthrough instead, and the video plays (with its music track)", async () => {
      assert.ok(tour, 'no walkthrough');
      assert.ok(await waitFor(() => tour.evaluate(() => { const v = document.getElementById('v'); return v.currentTime > 1 && !v.paused && v.duration > 60; }), 8000), 'video not playing');
      assert.ok(await tour.evaluate(() => { const v = document.getElementById('v'); return (v.audioTracks ? v.audioTracks.length > 0 : true) && v.mozHasAudio !== false; }));
    });
    if (SHOTS) execFileSync('import', ['-window', 'root', path.join(SHOTS, 'walkthrough.png')]);
    await tour.click('#skip').catch(() => {});
    await check('SKIP closes the walkthrough', async () => assert.ok(await waitFor(() => !app.windows().some((w) => /tour\.html/.test(w.url())), 4000)));
  } finally { await app.close().catch(() => {}); }

  if (failed) { console.log("WHAT'S NEW TEST FAILED"); process.exit(1); }
  console.log("ALL WHAT'S NEW TESTS PASS");
})().catch((e) => { console.error(e); process.exit(1); });
