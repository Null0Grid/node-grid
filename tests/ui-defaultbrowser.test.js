'use strict';
// End-to-end check of Settings > DEFAULT BROWSER on Linux, through the real app,
// inside a throwaway home folder (HOME / XDG_* point at a temp dir, so the real
// desktop settings are never touched):
//   1. before: Settings says another browser (or none) is the default
//   2. MAKE DEFAULT registers this copy (writes ~/.local/share/applications/
//      node-grid.desktop with http/https/html, since no package installed one)
//      and sets it with xdg-settings / xdg-mime
//   3. after: xdg-settings itself reports node-grid.desktop, the http/https
//      handlers point at it, and Settings says Null Grid is the default
// Linux only; needs xdg-utils and an X display (xvfb-run).
//
//   xvfb-run -a node tests/ui-defaultbrowser.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const pw = require('playwright');

if (process.platform !== 'linux') { console.log('ALL DEFAULT BROWSER TESTS PASS (skipped: Linux only)'); process.exit(0); }
const APP_DIR = path.resolve(__dirname, '..');
const electronPath = require(path.join(APP_DIR, 'node_modules', 'electron'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { try { const v = await fn(); if (v) return v; } catch {} await wait(150); }
  return null;
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-home-'));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CURRENT_DESKTOP: '', DESKTOP_SESSION: '', NULLGRID_TEST_PLAINTEXT_VAULT: '1', NULLGRID_UPDATE_URL: 'http://127.0.0.1:1/', NULLGRID_SKIP_INTRO: '1' };
  const xdg = (...a) => { try { return execFileSync(a[0], a.slice(1), { env, encoding: 'utf8' }).trim(); } catch { return ''; } };
  const app = await pw._electron.launch({ args: [APP_DIR, '--user-data-dir=' + path.join(home, 'ud')], executablePath: electronPath, env });
  let failed = false;
  const check = async (label, fn) => { try { await fn(); console.log('[pass] ' + label); } catch (e) { failed = true; console.log('[FAIL] ' + label + ': ' + e.message); } };
  try {
    const shell = await waitFor(() => app.windows().find((w) => /shell\.html$/.test(w.url())), 15000);
    await wait(800);
    await shell.evaluate(() => window.shell.openSettings());
    const s = await waitFor(() => app.windows().find((w) => /settings\.html/.test(w.url())), 8000);
    await s.waitForSelector('#browserstat');
    await check('before: Settings says Null Grid is not the default', async () => assert.ok(!/is your default browser/.test(await s.textContent('#browserstat')), await s.textContent('#browserstat')));
    await check('before: xdg-settings agrees', () => assert.notStrictEqual(xdg('xdg-settings', 'get', 'default-web-browser'), 'node-grid.desktop'));

    await s.click('#browsermake');
    await check('MAKE DEFAULT registers this copy (launcher entry with http/https/html)', async () => {
      const f = path.join(home, '.local', 'share', 'applications', 'node-grid.desktop');
      assert.ok(await waitFor(() => fs.existsSync(f), 6000), 'no ' + f);
      const d = fs.readFileSync(f, 'utf8');
      assert.ok(/^Exec=.+ %U$/m.test(d), d);
      assert.ok(/MimeType=.*x-scheme-handler\/http;.*x-scheme-handler\/https;.*text\/html;/.test(d), d);
      assert.ok(/Categories=Network;WebBrowser;/.test(d), d);
    });
    await check('after: xdg-settings reports Null Grid as the default browser', async () => assert.ok(await waitFor(() => xdg('xdg-settings', 'get', 'default-web-browser') === 'node-grid.desktop', 6000), xdg('xdg-settings', 'get', 'default-web-browser')));
    await check('after: http and https links go to Null Grid', () => {
      assert.strictEqual(xdg('xdg-mime', 'query', 'default', 'x-scheme-handler/http'), 'node-grid.desktop');
      assert.strictEqual(xdg('xdg-mime', 'query', 'default', 'x-scheme-handler/https'), 'node-grid.desktop');
    });
    await check('after: Settings says Null Grid is your default browser', async () => assert.ok(await waitFor(async () => /is your default browser/.test(await s.textContent('#browserstat')), 6000)));
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
  if (failed) { console.log('DEFAULT BROWSER TEST FAILED'); process.exit(1); }
  console.log('ALL DEFAULT BROWSER TESTS PASS');
})().catch((e) => { console.error(e); process.exit(1); });
