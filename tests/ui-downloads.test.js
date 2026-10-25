'use strict';
// End-to-end check of the toolbar download button and its pop-over, through the
// real app (like Firefox's):
//   1. no button until something is downloaded; then it shows, with a progress
//      line while a download runs
//   2. clicking it opens the list, newest first, with size and state
//   3. clicking a finished file opens it; the folder icon shows it in its folder
//   4. Escape closes the list; clicking somewhere else closes it too
//   5. removing everything from the list hides the button again
// Set DL_SHOTS=<dir> for a screenshot of the open list.
//
//   xvfb-run -a -s "-screen 0 1400x900x24" node tests/ui-downloads.test.js
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const pw = require('playwright');

const APP_DIR = path.resolve(__dirname, '..');
const electronPath = require(path.join(APP_DIR, 'node_modules', 'electron'));
const SHOTS = process.env.DL_SHOTS || '';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { try { const v = await fn(); if (v) return v; } catch {} await wait(120); }
  return null;
}
let failed = false;
const check = async (label, fn) => { try { await fn(); console.log('[pass] ' + label); } catch (e) { failed = true; console.log('[FAIL] ' + label + ': ' + e.message); } };

(async () => {
  const big = Buffer.alloc(3 * 1024 * 1024, 7);
  const site = http.createServer((q, r) => {
    if (q.url === '/notes.txt') { r.setHeader('Content-Type', 'text/plain'); r.setHeader('Content-Disposition', 'attachment; filename="notes.txt"'); return r.end('hello from the rack\n'); }
    if (q.url === '/homelab-backup.iso') {               // slow, so the progress line shows
      r.setHeader('Content-Type', 'application/octet-stream'); r.setHeader('Content-Disposition', 'attachment; filename="homelab-backup.iso"'); r.setHeader('Content-Length', big.length);
      let i = 0; const step = big.length / 12; const t = setInterval(() => { if (i >= big.length) { clearInterval(t); return r.end(); } r.write(big.subarray(i, i + step)); i += step; }, 180);
      return;
    }
    r.setHeader('Content-Type', 'text/html'); r.end('<!doctype html><title>files</title><body style="background:#fff">files');
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + site.address().port;
  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-dl-'));
  const app = await pw._electron.launch({
    args: [APP_DIR, '--user-data-dir=' + path.join(os.tmpdir(), 'node-grid-ci-dl-' + Date.now())],
    executablePath: electronPath,
    env: { ...process.env, NODEGRID_TEST_PLAINTEXT_VAULT: '1', NODEGRID_UPDATE_URL: 'http://127.0.0.1:1/', NODEGRID_DOWNLOADS: dlDir },
  });
  const errors = [];
  try {
    const shell = await waitFor(() => app.windows().find((w) => /shell\.html$/.test(w.url())), 15000);
    shell.on('pageerror', (e) => errors.push(e.message));
    await wait(1000);
    // record what would be opened instead of opening it
    await app.evaluate(({ shell: s }) => { global.__opened = []; global.__shown = []; s.openPath = async (p) => { global.__opened.push(p); return ''; }; s.showItemInFolder = (p) => { global.__shown.push(p); }; });
    const btn = () => shell.evaluate(() => { const b = document.getElementById('dltop'); return { hidden: b.hidden, busy: b.classList.contains('busy'), shown: getComputedStyle(b).display !== 'none' }; });
    await check('no download button before anything is downloaded', async () => assert.strictEqual((await btn()).shown, false));

    await shell.evaluate((u) => window.shell.go(u), base + '/');
    await wait(800);
    await shell.evaluate((u) => window.shell.go(u), base + '/homelab-backup.iso');
    await check('a download shows the button, with a progress line while it runs', async () => assert.ok(await waitFor(async () => { const b = await btn(); return b.shown && b.busy; }, 6000), JSON.stringify(await btn())));
    await waitFor(async () => !(await btn()).busy, 15000);
    await shell.evaluate((u) => window.shell.go(u), base + '/notes.txt');
    await waitFor(() => fs.existsSync(path.join(dlDir, 'notes.txt')), 8000);
    await wait(600);
    await check('when downloads finish, the progress line goes away', async () => assert.strictEqual((await btn()).busy, false));

    const dlpopWin = () => app.windows().find((w) => /dlpop\.html/.test(w.url()));
    await shell.click('#dltop');
    const pop = await waitFor(dlpopWin, 6000);
    await check('clicking the button opens the downloads list', () => assert.ok(pop));
    await pop.waitForSelector('#list .dl');
    const rows = await pop.evaluate(() => [...document.querySelectorAll('#list .dl')].map((li) => ({ name: li.querySelector('.name').textContent, info: li.querySelector('.info').textContent, state: li.className })));
    await check('the list shows both files, newest first, with their size', () => {
      assert.deepStrictEqual(rows.map((r) => r.name), ['notes.txt', 'homelab-backup.iso']);
      assert.ok(/MB/.test(rows[1].info) && rows.every((r) => /completed/.test(r.state)), JSON.stringify(rows));
    });
    if (SHOTS) { await wait(300); execFileSync('import', ['-window', 'root', path.join(SHOTS, 'downloads-popover.png')]); }
    await pop.click('#list .dl:nth-child(2) .act:not(.stop)');
    await check('the folder icon shows the file in its folder', async () => assert.ok(await waitFor(() => app.evaluate(() => global.__shown.some((p) => /homelab-backup\.iso$/.test(p))), 3000)));
    await pop.click('#list .dl:nth-child(1)').catch(() => {});   // the list closes as the file opens
    await check('clicking a finished file opens it (and closes the list)', async () => {
      assert.ok(await waitFor(() => app.evaluate(() => global.__opened.some((p) => /notes\.txt$/.test(p))), 3000));
      assert.ok(await waitFor(() => !dlpopWin(), 3000), 'list still open');
    });

    await shell.click('#dltop');
    let p2 = await waitFor(dlpopWin, 6000);
    await p2.waitForSelector('#list .dl');
    await p2.keyboard.press('Escape').catch(() => {});   // the list is gone before the key comes back up
    await check('Escape closes the list', async () => assert.ok(await waitFor(() => !dlpopWin(), 3000)));
    await shell.click('#dltop');
    p2 = await waitFor(dlpopWin, 6000);
    await p2.waitForSelector('#list .dl');
    await wait(300);
    // a real mouse click on the page (simulated clicks don't move focus between views)
    const wb = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.focus(); return w.getContentBounds(); });
    execFileSync('xdotool', ['mousemove', String(wb.x + 500), String(wb.y + 400), 'click', '1']);
    await check('clicking somewhere else closes it too', async () => assert.ok(await waitFor(() => !dlpopWin(), 3000)));
    await wait(500);
    await shell.click('#dltop');
    p2 = await waitFor(dlpopWin, 6000);
    await check('...and the button opens it again right after', () => assert.ok(p2));
    await p2.waitForSelector('#clear');
    await p2.click('#clear');
    await check('clearing the list hides the download button again (the files stay)', async () => {
      assert.ok(await waitFor(async () => !(await btn()).shown, 4000));
      assert.ok(fs.existsSync(path.join(dlDir, 'notes.txt')) && fs.existsSync(path.join(dlDir, 'homelab-backup.iso')));
    });
    await check('no errors in the shell', () => assert.deepStrictEqual(errors, []));
  } finally {
    await app.close().catch(() => {});
    site.close();
  }
  if (failed) { console.log('DOWNLOADS TEST FAILED'); process.exit(1); }
  console.log('ALL DOWNLOADS TESTS PASS');
})().catch((e) => { console.error(e); process.exit(1); });
