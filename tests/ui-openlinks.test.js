'use strict';
// End-to-end check that NODE_GRID opens the links it's handed, the way it gets
// them as the default browser (Windows Default apps, xdg-open / Omarchy on Linux):
//   1. started with a link: that page opens instead of the start page
//   2. while it's open, another launch with a link (what Windows / xdg-open do)
//      opens it in a new tab in the running window; no second window
//   3. an .html file opened with NODE_GRID opens as a file:// tab
//   4. command-line flags are never mistaken for links
//
//   xvfb-run -a node tests/ui-openlinks.test.js
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const pw = require('playwright');

const APP_DIR = path.resolve(__dirname, '..');
const electronPath = require(path.join(APP_DIR, 'node_modules', 'electron'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { try { const v = await fn(); if (v) return v; } catch {} await wait(150); }
  return null;
}
// What the OS does when NODE_GRID is already running: start it again with the link.
function launchAgain(userData, arg) {
  return new Promise((resolve) => {
    const root = process.getuid && process.getuid() === 0;   // Chromium won't start as root without --no-sandbox (CI containers)
    const p = spawn(electronPath, [APP_DIR, '--user-data-dir=' + userData, '--some-flag', ...(root ? ['--no-sandbox'] : []), arg], { env: { ...process.env, NODEGRID_TEST_PLAINTEXT_VAULT: '1' }, stdio: 'ignore' });
    const t = setTimeout(() => { p.kill(); resolve('still running'); }, 15000);
    p.on('exit', () => { clearTimeout(t); resolve('exited'); });
  });
}

(async () => {
  const site = http.createServer((q, r) => { r.setHeader('Content-Type', 'text/html'); r.end('<!doctype html><title>page ' + q.url + '</title>' + q.url); });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + site.address().port;
  const userData = path.join(os.tmpdir(), 'node-grid-ci-links-' + Date.now());
  const htmlFile = path.join(os.tmpdir(), 'ng-local-' + Date.now() + '.html');
  fs.writeFileSync(htmlFile, '<!doctype html><title>local file</title>hello from a file');

  const app = await pw._electron.launch({
    args: [APP_DIR, '--user-data-dir=' + userData, base + '/first'],
    executablePath: electronPath,
    env: { ...process.env, NODEGRID_TEST_PLAINTEXT_VAULT: '1', NODEGRID_UPDATE_URL: 'http://127.0.0.1:1/', NODEGRID_SKIP_INTRO: '1' },
  });
  let failed = false;
  const check = async (label, fn) => { try { await fn(); console.log('[pass] ' + label); } catch (e) { failed = true; console.log('[FAIL] ' + label + ': ' + e.message); } };
  try {
    const shell = await waitFor(() => app.windows().find((w) => /shell\.html$/.test(w.url())), 15000);
    assert.ok(shell, 'shell window should appear');
    const tabs = () => shell.evaluate(() => [...document.querySelectorAll('#tabs .tab')].map((t) => ({ title: t.querySelector('.title').textContent, active: t.classList.contains('active') })));

    // 1. started with a link
    await check('started with a link: it opens, instead of the start page', async () => {
      const t = await waitFor(async () => { const x = await tabs(); return x.length && x.some((y) => y.title === 'page /first') ? x : null; }, 10000);
      assert.ok(t, JSON.stringify(await tabs()));
      assert.strictEqual(t.length, 1, 'just that one tab: ' + JSON.stringify(t));
      assert.ok(t[0].active);
    });

    // 2. a link from "another app" while open
    const r = await launchAgain(userData, base + '/second');
    await check('a second launch hands its link over and exits (one window)', () => assert.strictEqual(r, 'exited'));
    await check('...and the link opens in a new, active tab', async () => assert.ok(await waitFor(async () => (await tabs()).some((y) => y.title === 'page /second' && y.active), 8000), JSON.stringify(await tabs())));

    // 3. an .html file
    await launchAgain(userData, htmlFile);
    await check('an .html file opens as a tab', async () => assert.ok(await waitFor(async () => (await tabs()).some((y) => y.title === 'local file'), 8000), JSON.stringify(await tabs())));
    await check('...from its file:// address', async () => assert.ok(app.windows().some((w) => w.url() === require('url').pathToFileURL(htmlFile).href)));

    // 4. flags are not links
    await check('flags (--some-flag, --user-data-dir) never become tabs', async () => {
      const t = await tabs();
      assert.strictEqual(t.length, 3, JSON.stringify(t));
    });
  } finally {
    await app.close().catch(() => {});
    site.close();
    try { fs.unlinkSync(htmlFile); } catch {}
  }
  if (failed) { console.log('OPEN LINKS TEST FAILED'); process.exit(1); }
  console.log('ALL OPEN LINKS TESTS PASS');
})().catch((e) => { console.error(e); process.exit(1); });
