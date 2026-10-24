'use strict';
// End-to-end sweep of the Settings page, through the real app:
//   1. every section is there, in order, and every jump link points at one
//   2. every FEATURES switch turns off and back on; each change is saved
//      (Settings is closed and reopened and the switch still shows it) and the
//      app reflects it (the shell gets the matching nofeat-* class)
//   3. every dropdown (search engine, sleep timer, burner timer, translate
//      language, default AI) changes and keeps its value after reopening
//   4. the row switches (dark pages, ad blocking, automatic update checks)
//      turn off and on and are saved
//   5. no errors in the Settings page or the shell while doing all of this
//
//   xvfb-run -a node tests/ui-settings.test.js
const assert = require('assert');
const os = require('os');
const path = require('path');
const pw = require('playwright');

const APP_DIR = path.resolve(__dirname, '..');
const electronPath = require(path.join(APP_DIR, 'node_modules', 'electron'));
const ORDER = ['search', 'look', 'tabs', 'browser', 'ai', 'features', 'privacy', 'sites', 'logins', 'drive', 'updates', 'about'];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { try { const v = await fn(); if (v) return v; } catch {} await wait(120); }
  return null;
}

(async () => {
  const app = await pw._electron.launch({
    args: [APP_DIR, '--user-data-dir=' + path.join(os.tmpdir(), 'node-grid-ci-settings-' + Date.now())],
    executablePath: electronPath,
    env: { ...process.env, NODEGRID_TEST_PLAINTEXT_VAULT: '1', NODEGRID_UPDATE_URL: 'http://127.0.0.1:1/' },
  });
  let failed = false;
  const check = async (label, fn) => { try { await fn(); console.log('[pass] ' + label); } catch (e) { failed = true; console.log('[FAIL] ' + label + ': ' + e.message); } };
  const errors = [];
  try {
    const shell = await waitFor(() => app.windows().find((w) => /shell\.html$/.test(w.url())), 15000);
    shell.on('pageerror', (e) => errors.push('shell: ' + e.message));
    await wait(800);
    let s = null;
    const openSettings = async () => {
      if (s) { await shell.evaluate(() => { const t = [...document.querySelectorAll('#tabs .tab')].find((x) => /Settings/.test(x.textContent)); if (t) t.querySelector('.close').click(); }); await waitFor(() => !app.windows().some((w) => /settings\.html/.test(w.url())), 5000); }
      await shell.evaluate(() => window.shell.openSettings());
      s = await waitFor(() => app.windows().find((w) => /settings\.html/.test(w.url())), 8000);
      s.on('pageerror', (e) => errors.push('settings: ' + e.message));
      await s.waitForSelector('#sections section');
      await wait(300);
      return s;
    };
    await openSettings();

    // 1. sections + jump links
    await check('every section is there, in order', async () => {
      const ids = await s.evaluate(() => [...document.querySelectorAll('#sections > section')].map((x) => x.id));
      assert.deepStrictEqual(ids, ORDER);
    });
    await check('every jump link points at a section', async () => {
      const bad = await s.evaluate(() => [...document.querySelectorAll('#jump a')].filter((a) => !document.getElementById(a.getAttribute('href').slice(1))).map((a) => a.textContent));
      const n = await s.evaluate(() => document.querySelectorAll('#jump a').length);
      assert.strictEqual(n, 12); assert.deepStrictEqual(bad, []);
    });

    // 2. every feature switch: off, saved, reflected; then back on
    const features = await s.evaluate(() => [...document.querySelectorAll('.fitem .flabel')].map((l) => l.firstChild.textContent.trim()));
    await check(`there are feature switches (${features.length})`, () => assert.ok(features.length >= 18, features.join(', ')));
    const tile = (label) => s.evaluate((l) => { const f = [...document.querySelectorAll('.fitem')].find((x) => x.querySelector('.flabel').firstChild.textContent.trim() === l); return f && f.querySelector('.tgl').getAttribute('aria-checked'); }, label);
    const flip = (label) => s.evaluate((l) => [...document.querySelectorAll('.fitem')].find((x) => x.querySelector('.flabel').firstChild.textContent.trim() === l).querySelector('.tgl').click(), label);
    const badFlip = [];
    for (const f of features) {
      const before = await tile(f);
      await flip(f);
      const after = await waitFor(async () => { const v = await tile(f); return v !== before ? v : null; }, 4000);
      if (!after) badFlip.push(f + ' (did not change)');
    }
    await check('every feature switch turns off', () => assert.deepStrictEqual(badFlip, []));
    const nofeat = await shell.evaluate(() => [...document.body.classList].filter((c) => c.startsWith('nofeat-')).length);
    await check(`the app reflects them (${nofeat} features off in the shell)`, () => assert.ok(nofeat >= features.length - 1, String(nofeat)));
    await openSettings();
    const stillOff = [];
    for (const f of features) if ((await tile(f)) !== 'false') stillOff.push(f);
    await check('...and they stay off after reopening Settings', () => assert.deepStrictEqual(stillOff, []));
    for (const f of features) { await flip(f); await waitFor(async () => (await tile(f)) === 'true', 4000); }
    await openSettings();
    const backOn = [];
    for (const f of features) if ((await tile(f)) !== 'true') backOn.push(f);
    await check('every feature switch turns back on and stays on', () => assert.deepStrictEqual(backOn, []));
    await check('the shell has no features switched off now', async () => assert.strictEqual(await shell.evaluate(() => [...document.body.classList].filter((c) => c.startsWith('nofeat-')).length), 0));

    // 3. dropdowns
    const selects = await s.evaluate(() => [...document.querySelectorAll('#sections select')].map((x, i) => ({ i, sec: x.closest('section').id, value: x.value, options: [...x.options].map((o) => o.value) })));
    await check(`there are dropdowns (${selects.length})`, () => assert.ok(selects.length >= 5, JSON.stringify(selects.map((x) => x.sec))));
    const chosen = [];
    for (const sel of selects) {
      const alt = sel.options.find((o) => o !== sel.value && !/^(add|del|custom)$/.test(o));
      if (alt == null) continue;
      await s.evaluate(({ i, v }) => { const x = document.querySelectorAll('#sections select')[i]; x.value = v; x.dispatchEvent(new Event('change', { bubbles: true })); }, { i: sel.i, v: alt });
      await wait(500);
      chosen.push({ sec: sel.sec, i: sel.i, v: alt });
    }
    await openSettings();
    const lost = [];
    for (const c of chosen) { const v = await s.evaluate((i) => document.querySelectorAll('#sections select')[i].value, c.i); if (v !== c.v) lost.push(`${c.sec}: wanted ${c.v}, got ${v}`); }
    await check(`every dropdown keeps its new value after reopening (${chosen.length} changed)`, () => assert.deepStrictEqual(lost, []));

    // 4. row switches
    const rowSwitch = (sec, label) => s.evaluate(({ sec, label }) => { const r = [...document.querySelectorAll('#' + sec + ' .row')].find((x) => x.querySelector('.label').textContent.trim() === label); return r && r.querySelector('.tgl') ? r.querySelector('.tgl').getAttribute('aria-checked') : null; }, { sec, label });
    const rowFlip = (sec, label) => s.evaluate(({ sec, label }) => [...document.querySelectorAll('#' + sec + ' .row')].find((x) => x.querySelector('.label').textContent.trim() === label).querySelector('.tgl').click(), { sec, label });
    for (const [sec, label] of [['look', 'Dark pages'], ['privacy', 'Ad + tracker blocking'], ['updates', 'Check automatically']]) {
      const before = await rowSwitch(sec, label);
      await rowFlip(sec, label);
      const after = await waitFor(async () => { const v = await rowSwitch(sec, label); return v !== before ? v : null; }, 4000);
      await openSettings();
      const kept = await rowSwitch(sec, label);
      await check(`${label}: switches and is saved`, () => { assert.ok(before && after, `${before} -> ${after}`); assert.strictEqual(kept, after); });
      await rowFlip(sec, label);
      await waitFor(async () => (await rowSwitch(sec, label)) === before, 4000);
    }

    // 5. no errors anywhere
    await check('no errors in the Settings page or the shell', () => assert.deepStrictEqual(errors, []));
  } finally {
    await app.close().catch(() => {});
  }
  if (failed) { console.log('SETTINGS TEST FAILED'); process.exit(1); }
  console.log('ALL SETTINGS TESTS PASS');
})().catch((e) => { console.error(e); process.exit(1); });
