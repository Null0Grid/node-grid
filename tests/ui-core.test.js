'use strict';
// End-to-end check of Null Grid's everyday features, through the real app, using
// real key presses (xdotool) for the keyboard shortcuts:
//   Ctrl+T new tab, Ctrl+L + typing an address, Ctrl+W close, Ctrl+Tab cycle,
//   Ctrl+R reload, Alt+Left back, Ctrl+F find on page, Ctrl+D favorite,
//   Ctrl+H history, Ctrl+Shift+N burner tab, Ctrl+B shrink sidebar;
//   plus dark pages, reader mode and the send-to-phone QR pop-up; and that
//   none of it puts an error in the shell or the main process.
// Needs an X display (xvfb-run) and xdotool.
//
//   xvfb-run -a -s "-screen 0 1400x900x24" node tests/ui-core.test.js
const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const pw = require('playwright');

const APP_DIR = path.resolve(__dirname, '..');
const electronPath = require(path.join(APP_DIR, 'node_modules', 'electron'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { try { const v = await fn(); if (v) return v; } catch {} await wait(120); }
  return null;
}
const key = (k) => execFileSync('xdotool', ['key', '--clearmodifiers', k]);
const type = (t) => execFileSync('xdotool', ['type', '--delay', '15', t]);

const ARTICLE = '<!doctype html><title>Field notes</title><body style="background:#fff"><article><h1>Field notes from the rack</h1>'
  + Array.from({ length: 12 }, (_, i) => `<p>Paragraph ${i + 1}: the homelab rack hums along with its Proxmox nodes, a ZimaBoard, a router and a switch. Cable runs are labelled and every service has its own VLAN, which keeps the network tidy and easy to reason about when something breaks at night.</p>`).join('')
  + '</article></body>';

(async () => {
  const hits = {};
  const site = http.createServer((q, r) => {
    hits[q.url] = (hits[q.url] || 0) + 1;
    r.setHeader('Content-Type', 'text/html');
    if (q.url === '/article') return r.end(ARTICLE);
    r.end('<!doctype html><title>page ' + q.url + '</title><body style="background:#fff">needle haystack needle ' + q.url);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + site.address().port;
  const app = await pw._electron.launch({
    args: [APP_DIR, '--user-data-dir=' + path.join(os.tmpdir(), 'null-grid-ci-core-' + Date.now())],
    executablePath: electronPath,
    env: { ...process.env, NULLGRID_TEST_PLAINTEXT_VAULT: '1', NULLGRID_UPDATE_URL: 'http://127.0.0.1:1/', NULLGRID_SKIP_INTRO: '1' },   // no first-start walkthrough over the keys
  });
  const mainErrors = [];
  app.process().stderr.on('data', (d) => { const s = String(d); if (/Uncaught|TypeError|ReferenceError|UnhandledPromiseRejection/.test(s)) mainErrors.push(s.trim().slice(0, 300)); });
  let failed = false;
  const check = async (label, fn) => { try { await fn(); console.log('[pass] ' + label); } catch (e) { failed = true; console.log('[FAIL] ' + label + ': ' + e.message); } };
  const shellErrors = [];
  try {
    const shell = await waitFor(() => app.windows().find((w) => /shell\.html$/.test(w.url())), 15000);
    shell.on('pageerror', (e) => shellErrors.push(e.message));
    await wait(1200);
    // key presses go to whichever window has focus, so make sure it's ours first
    await waitFor(() => app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; if (!w.isFocused()) { w.show(); w.focus(); } return w.isFocused(); }), 8000);
    await wait(300);
    const tabs = () => shell.evaluate(() => [...document.querySelectorAll('#tabs .tab')].map((t) => ({ title: t.querySelector('.title').textContent, active: t.classList.contains('active'), burner: t.classList.contains('burner') })));
    const active = async () => (await tabs()).find((t) => t.active) || {};
    const pageWin = (re) => app.windows().find((w) => re.test(w.url()));

    // Ctrl+T, Ctrl+L, type an address
    const n0 = (await tabs()).length;
    key('ctrl+t');
    await check('Ctrl+T opens a new tab', async () => assert.ok(await waitFor(async () => (await tabs()).length === n0 + 1)));
    if (process.env.NG_DIAG && (await tabs()).length !== n0 + 1) {
      const x = (a) => { try { return execFileSync('xdotool', a).toString().trim(); } catch (e) { return 'ERR ' + e.message.split('\n')[0]; } };
      console.log('DIAG focus=' + x(['getwindowfocus']) + ' name=' + x(['getwindowfocus', 'getwindowname']) + ' mouse=' + x(['getmouselocation']));
      console.log('DIAG app windows=' + x(['search', '--pid', String(app.process().pid)]).replace(/\n/g, ','));
      console.log('DIAG electron=' + JSON.stringify(await app.evaluate(({ BrowserWindow, webContents }) => ({ wins: BrowserWindow.getAllWindows().map((w) => ({ t: w.getTitle(), f: w.isFocused(), v: w.isVisible(), b: w.getBounds() })), focusedWc: (webContents.getFocusedWebContents() || { getURL: () => 'none' }).getURL() }))));
      console.log('DIAG shell focus=' + await shell.evaluate(() => document.hasFocus() + ' ' + (document.activeElement && document.activeElement.id)));
    }
    await wait(400);
    key('ctrl+l'); await wait(250); type(base + '/one'); key('Return');
    await check('Ctrl+L, type an address, Enter: the page loads', async () => assert.ok(await waitFor(async () => (await active()).title === 'page /one')));
    await wait(600);
    await check('reader + picture-in-picture buttons stay hidden on a page with no article or video', async () => assert.deepStrictEqual(await shell.evaluate(() => ['readbtn', 'pipbtn'].map((id) => getComputedStyle(document.getElementById(id)).display)), ['none', 'none']));
    key('ctrl+l'); await wait(250); type(base + '/two'); key('Return');
    await waitFor(async () => (await active()).title === 'page /two');

    // Alt+Left, Ctrl+R
    await wait(500);
    key('alt+Left');
    await check('Alt+Left goes back', async () => assert.ok(await waitFor(async () => (await active()).title === 'page /one')));
    const before = hits['/one'] || 0;
    key('ctrl+r');
    await check('Ctrl+R reloads', async () => assert.ok(await waitFor(() => (hits['/one'] || 0) > before)));

    // Ctrl+F
    await wait(500);
    key('ctrl+f'); await wait(300); type('needle');
    await check('Ctrl+F finds text on the page', async () => assert.ok(await waitFor(() => shell.evaluate(() => {
      const bar = document.getElementById('findbar'); const c = document.getElementById('findcount') || bar.querySelector('[id*=count], .count');
      return !bar.hidden && /2/.test((c && c.textContent) || bar.textContent);
    }), 4000), await shell.evaluate(() => document.getElementById('findbar').textContent)));
    key('Escape'); await wait(300);

    // Ctrl+D
    const favs = () => shell.evaluate(() => document.querySelectorAll('#favs .fav, #favs button, .favbar .fav').length);
    const f0 = await favs();
    key('ctrl+d');
    await check('Ctrl+D adds the page to favorites', async () => assert.ok(await waitFor(async () => (await favs()) > f0), String(await favs())));

    // Ctrl+H
    key('ctrl+h');
    await check('Ctrl+H opens history, which lists the site', async () => assert.ok(await waitFor(() => shell.evaluate(() => document.body.classList.contains('show-history') || /127\.0\.0\.1/.test((document.getElementById('history') || {}).textContent || '')))));
    key('ctrl+h'); await wait(300);

    // Ctrl+Tab
    const t1 = (await active()).title;
    key('ctrl+Tab');
    await check('Ctrl+Tab switches to the next tab', async () => assert.ok(await waitFor(async () => (await active()).title !== t1)));
    key('ctrl+shift+Tab'); await waitFor(async () => (await active()).title === t1);

    // Ctrl+Shift+N
    key('ctrl+shift+n');
    await check('Ctrl+Shift+N opens a burner tab', async () => assert.ok(await waitFor(async () => (await tabs()).some((t) => t.burner))));
    // Ctrl+W
    const nb = (await tabs()).length;
    key('ctrl+w');
    await check('Ctrl+W closes the tab', async () => assert.ok(await waitFor(async () => (await tabs()).length === nb - 1)));

    // Ctrl+B
    const wasCollapsed = await shell.evaluate(() => document.body.classList.contains('collapsed'));
    key('ctrl+b');
    await check('Ctrl+B shrinks / expands the sidebar', async () => assert.ok(await waitFor(() => shell.evaluate((w) => document.body.classList.contains('collapsed') !== w, wasCollapsed))));
    key('ctrl+b'); await wait(300);

    // dark pages
    await shell.evaluate(() => [...document.querySelectorAll('#tabs .tab')].find((t) => /page \/one/.test(t.textContent)).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })));
    await wait(500);
    await shell.evaluate(() => window.shell.toggleDark());
    const one = pageWin(/\/one$/);
    await check('dark pages darkens a bright page', async () => assert.ok(await waitFor(() => one.evaluate(() => /invert/.test(getComputedStyle(document.documentElement).filter)), 5000)));
    await shell.evaluate(() => window.shell.toggleDark());
    await check('...and switching it off restores the page', async () => assert.ok(await waitFor(() => one.evaluate(() => !/invert/.test(getComputedStyle(document.documentElement).filter)), 5000)));

    // reader mode
    key('ctrl+l'); await wait(250); type(base + '/article'); key('Return');
    await waitFor(async () => (await active()).title === 'Field notes');
    await check('reader mode is offered on an article', async () => assert.ok(await waitFor(() => shell.evaluate(() => !document.getElementById('readbtn').hidden), 6000)));
    await shell.evaluate(() => window.shell.toggleReader());
    await check('...and opens it', async () => assert.ok(await waitFor(() => app.windows().some((w) => /reader\.html/.test(w.url())), 6000)));
    await shell.evaluate(() => window.shell.toggleReader());
    await waitFor(() => !app.windows().some((w) => /reader\.html/.test(w.url())), 6000);

    // QR pop-up
    await shell.evaluate(() => window.shell.openQr());
    await check('send to phone opens the QR pop-up with a code', async () => assert.ok(await waitFor(async () => { const q = pageWin(/qr\.html$/); return q && (await q.evaluate(() => !!document.querySelector('#qr svg'))); }, 6000)));
    const q = pageWin(/qr\.html$/); if (q) await q.click('#close').catch(() => {});

    await check('no errors in the shell', () => assert.deepStrictEqual(shellErrors, []));
    await check('no errors in the main process', () => assert.deepStrictEqual(mainErrors, []));
  } finally {
    await app.close().catch(() => {});
    site.close();
  }
  if (failed) { console.log('CORE FEATURES TEST FAILED'); process.exit(1); }
  console.log('ALL CORE FEATURES TESTS PASS');
})().catch((e) => { console.error(e); process.exit(1); });
