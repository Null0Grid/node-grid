'use strict';
// Regression checks for the bugs fixed after the October 2026 review, through the
// real app (plus one check of the Null Drive client on its own):
//   - Null Drive: the token is never sent to a server whose certificate isn't trusted
//   - right-click "Open link in new tab" in a burner tab stays burner (its own
//     session) and only opens web links
//   - a web page can't make the sidebar read a file:// "icon"
//   - "sudo ..." searches on the start page are searched; a bare "sudo" is the joke
//   - reader / picture-in-picture buttons hidden on a plain page
//   - logins popup: Enter on a row's button doesn't fill the page; Enter on the row does
//   - loadout Swap keeps pinned tabs
//   - "Get it" for an update downloads through the window's session even with a
//     burner tab in front
//   - the Dark pages switch shows the saved value even with the moon button off
//   - developer mode refreshes an open Settings page
//   - every PIN check counts toward the lockout (remove-PIN can't be brute-forced)
//   - settings.json is written whole (no temp file left behind) and stays valid JSON
//
//   xvfb-run -a node tests/ui-fixes.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
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
let failed = false;
const check = async (label, fn) => { try { await fn(); console.log('[pass] ' + label); } catch (e) { failed = true; console.log('[FAIL] ' + label + ': ' + e.message); } };
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

async function driveCertCheck() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-fix-cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const cert = fs.readFileSync(path.join(dir, 'c.pem'));
  let reached = 0;
  const srv = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert }, (q, r) => { reached++; r.setHeader('Content-Type', 'application/json'); r.end(JSON.stringify({ user: { name: 'luke', e2ee: 'off' } })); });
  const port = await listen(srv);
  const settings = { trustedCerts: {} };
  const drive = require(path.join(APP_DIR, 'null-drive.js'))({ getSettings: () => settings, saveSettings: () => {}, enc: (x) => x, dec: (x) => x, canEncrypt: () => false, downloadsDir: () => os.tmpdir(), onChange: null });
  const base = 'https://localhost:' + port;
  const untrusted = await drive.handshake(base, 'SECRET-TOKEN');
  await check('Null Drive: an untrusted certificate is refused before anything is sent (0 requests reached the server)', () => { assert.strictEqual(untrusted.state, 'cert'); assert.strictEqual(reached, 0); });
  settings.trustedCerts.localhost = { fingerprint: 'sha256/' + crypto.createHash('sha256').update(new crypto.X509Certificate(cert).raw).digest('base64') };
  const trusted = await drive.handshake(base, 'SECRET-TOKEN');
  await check('Null Drive: a certificate you trusted still connects', () => { assert.strictEqual(trusted.state, 'connected'); assert.strictEqual(reached, 1); });
  srv.close();
}

(async () => {
  await driveCertCheck();

  // a newer release, so "Get it" has something to fetch
  const gh = http.createServer((q, r) => {
    const v = 'v99.0.0';
    r.setHeader('Content-Type', 'application/json');
    r.end(JSON.stringify({ tag_name: v, html_url: 'https://github.com/Null0Grid/node-grid/releases/tag/' + v, body: 'notes',
      assets: ['NODE_GRID-99.0.0-win32-x64.zip', 'NODE_GRID-99.0.0.AppImage', 'nullgrid-browser_99.0.0_amd64.deb', 'nullgrid-browser-99.0.0.x86_64.rpm', 'nullgrid-browser-99.0.0.tar.gz']
        .map((name) => ({ name, size: 1000, browser_download_url: 'https://github.com/Null0Grid/node-grid/releases/download/' + v + '/' + name })) }));
  });
  const ghPort = await listen(gh);
  const iconDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-fix-icon-'));
  fs.writeFileSync(path.join(iconDir, 'secret.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7"/></svg>');
  const site = http.createServer((q, r) => {
    r.setHeader('Content-Type', 'text/html');
    const pages = {
      '/links': '<a id="web" href="/target">web</a> <a id="file" href="file:///etc/hostname">file</a>',
      '/target': '',
      '/control': '',
      '/fileicon': `<link rel="icon" href="file://${path.join(iconDir, 'secret.svg')}">`,
      '/login': '<form><input id="u" name="username" type="text" autocomplete="username"><input id="p" name="password" type="password"></form>',
    };
    r.end('<!doctype html><title>' + q.url.slice(1) + '</title><body style="background:#fff">' + (pages[q.url] || '') + ' ' + q.url);
  });
  const port = await listen(site);
  const A = 'http://127.0.0.1:' + port, L = 'http://localhost:' + port;   // two hosts: one for normal tabs, one for burner tabs
  const userData = path.join(os.tmpdir(), 'node-grid-ci-fixes-' + Date.now());
  const app = await pw._electron.launch({
    args: [APP_DIR, '--user-data-dir=' + userData],
    executablePath: electronPath,
    env: { ...process.env, NODEGRID_TEST_PLAINTEXT_VAULT: '1', NODEGRID_UPDATE_URL: 'http://127.0.0.1:' + ghPort + '/latest', NODEGRID_UPDATE_DELAY_MS: '600000' },
  });
  const errors = [];
  app.process().stderr.on('data', (d) => { const s = String(d); if (/Uncaught|TypeError|ReferenceError|UnhandledPromiseRejection/.test(s)) errors.push('main: ' + s.trim().slice(0, 300)); });
  try {
    const shell = await waitFor(() => app.windows().find((w) => /shell\.html$/.test(w.url())), 15000);
    shell.on('pageerror', (e) => errors.push('shell: ' + e.message));
    await shell.evaluate(() => { window.__s = null; window.shell.onState((s) => { window.__s = s; }); });
    await wait(1000);
    // record native menus instead of showing them, and record downloads instead of starting them
    await app.evaluate(({ Menu, BrowserWindow }) => {
      global.__menus = [];
      const build = Menu.buildFromTemplate.bind(Menu);
      Menu.buildFromTemplate = (t) => { global.__menus.push(t); const m = build(t); m.popup = () => {}; return m; };
      global.__dl = [];
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      wc.downloadURL = (u) => global.__dl.push(u);
    });
    const state = () => shell.evaluate(() => window.__s);
    const activeTab = async () => { const s = await state(); return s && s.tabs.find((t) => t.id === s.activeId); };
    const go = async (u) => { await shell.evaluate((x) => window.shell.go(x), u); await waitFor(async () => { const t = await activeTab(); return t && t.url === u && !t.loading; }); };
    const menuClick = (label) => app.evaluate((_, l) => { const m = global.__menus[global.__menus.length - 1] || []; const it = m.find((i) => i.label === l); if (!it) return false; it.click(); return true; }, label);
    const lastMenuLabels = () => app.evaluate(() => (global.__menus[global.__menus.length - 1] || []).map((i) => i.label).filter(Boolean));
    const rightClick = (urlPart, params) => app.evaluate(({ webContents }, { urlPart, params }) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().includes(urlPart));
      wc.emit('context-menu', { preventDefault() {} }, { x: 5, y: 5, linkURL: '', srcURL: '', mediaType: 'none', selectionText: '', isEditable: false, editFlags: {}, dictionarySuggestions: [], pageURL: wc.getURL(), frameURL: wc.getURL(), ...params });
      return true;
    }, { urlPart, params });

    // normal tab on host A (shows up in history: the positive control)
    await shell.evaluate(() => window.shell.newTab()); await wait(300);
    await go(A + '/control');

    // burner tab on host L, right-click a link
    await shell.evaluate(() => window.shell.openBurner());
    await waitFor(async () => { const t = await activeTab(); return t && t.burnEnds; });
    await go(L + '/links');
    await rightClick(L + '/links', { linkURL: L + '/target' });
    await menuClick('Open link in new tab');
    const opened = await waitFor(async () => { const t = await activeTab(); return t && /\/target$/.test(t.url) && !t.loading ? t : null; });
    await check('burner tab: "Open link in new tab" opens a burner tab', () => { assert.ok(opened, 'no new tab'); assert.ok(opened.burnEnds, 'the new tab is a normal tab'); });
    await rightClick(L + '/links', { linkURL: 'file:///etc/hostname' });
    await check('right-click on a file:// link offers no "Open link in new tab"', async () => assert.ok(!(await lastMenuLabels()).includes('Open link in new tab'), (await lastMenuLabels()).join(', ')));
    const nTabs = (await state()).tabs.length;
    await rightClick(L + '/links', { mediaType: 'image', srcURL: 'file:///etc/hostname' });
    await menuClick('Open image in new tab'); await wait(800);
    await check("right-click on a file:// image doesn't open it", async () => assert.strictEqual((await state()).tabs.length, nTabs));
    const sessions = await app.evaluate(({ webContents, session }, { a, l }) => {
      const normal = session.fromPartition('nullgrid-ephemeral');
      const of = (u) => webContents.getAllWebContents().find((w) => w.getURL() === u);
      return { control: of(a).session === normal, opened: of(l).session === normal };
    }, { a: A + '/control', l: L + '/target' });
    await check("...in the burner tab's own session, not the normal one (so nothing reaches history or cookies)", () => { assert.strictEqual(sessions.control, true, 'control tab not in the normal session'); assert.strictEqual(sessions.opened, false, 'opened link is in the normal session'); });

    // a web page pointing its icon at a local file
    await shell.evaluate(() => window.shell.newTab()); await wait(300);
    await go(A + '/fileicon'); await wait(1500);
    await check("a web page can't make the sidebar read a file:// icon", async () => {
      const shows = await shell.evaluate(() => { const t = [...document.querySelectorAll('#tabs .tab')].find((x) => x.querySelector('.title').textContent === 'fileicon'); return t ? (t.querySelector('.fav img') ? 'icon' : 'placeholder') : 'missing'; });
      assert.strictEqual(shows, 'placeholder');
    });
    await check('reader + picture-in-picture buttons are hidden on a plain page', async () => assert.deepStrictEqual(await shell.evaluate(() => ['readbtn', 'pipbtn'].map((id) => getComputedStyle(document.getElementById(id)).display)), ['none', 'none']));

    // start page: sudo searches
    await shell.evaluate(() => window.shell.newTab()); await wait(300);
    await wait(800);
    const home = app.windows().filter((w) => /home\/index\.html/.test(w.url())).pop();   // the newest start page = the tab just opened
    await home.waitForSelector('#q');
    const homeUrl = home.url();
    await home.fill('#q', 'sudo'); await home.press('#q', 'Enter'); await wait(1000);
    await check('start page: a bare "sudo" is still the easter egg (no search)', async () => assert.strictEqual(home.url(), homeUrl));
    await home.fill('#q', 'sudo systemctl status nginx'); await home.press('#q', 'Enter');
    await check('start page: "sudo systemctl status nginx" is searched', async () => assert.ok(await waitFor(() => /sudo(\+|%20|%2520)systemctl/.test(home.url()), 6000), home.url()));

    // logins popup
    await shell.evaluate(() => window.shell.newTab()); await wait(300);
    await go(A + '/login');
    const loginPage = await waitFor(() => app.windows().find((w) => w.url() === A + '/login'));
    await shell.evaluate(() => window.shell.toggleVault());
    let vault = await waitFor(() => app.windows().find((w) => /vault\.html/.test(w.url())), 6000);
    await vault.evaluate(() => window.vault.save({ host: '127.0.0.1', user: 'luke', pass: 'hunter2' }));
    await vault.waitForSelector('li .act-user', { timeout: 6000 });
    await vault.focus('li .act-user'); await vault.keyboard.press('Enter'); await wait(800);
    await check("logins: Enter on a row's copy button doesn't fill the page", async () => assert.strictEqual(await loginPage.evaluate(() => document.getElementById('u').value), ''));
    vault = await waitFor(() => app.windows().find((w) => /vault\.html/.test(w.url())), 3000);
    if (!vault) { await shell.evaluate(() => window.shell.toggleVault()); vault = await waitFor(() => app.windows().find((w) => /vault\.html/.test(w.url())), 6000); }
    await vault.waitForSelector('li .act-user');
    await vault.focus('li:has(.act-user)'); await vault.keyboard.press('Enter');
    await check('logins: Enter on the row itself still fills the page', async () => assert.ok(await waitFor(() => loginPage.evaluate(() => document.getElementById('u').value === 'luke'), 5000)));
    if (app.windows().some((w) => /vault\.html/.test(w.url()))) await shell.evaluate(() => window.shell.toggleVault());

    // loadout Swap keeps pinned tabs
    const control = (await state()).tabs.find((t) => /\/control$/.test(t.url));
    await shell.evaluate((id) => window.shell.tabMenu(id), control.id); await wait(300);
    await menuClick('Pin tab');
    await waitFor(async () => (await state()).tabs.find((t) => t.id === control.id).pinned);
    await shell.evaluate(() => window.shell.loadoutSave('swaptest'));
    const lo = await waitFor(async () => (await state()).loadouts.find((l) => l.name === 'swaptest'));
    await shell.evaluate((id) => window.shell.loadoutDeploy(id, true), lo.id); await wait(2000);
    await check('loadout Swap keeps the pinned tab open and pinned', async () => { const t = (await state()).tabs.find((x) => /\/control$/.test(x.url) && x.pinned); assert.ok(t); });
    await check('...and it stays saved as pinned', () => assert.ok((JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')).pinned || []).some((u) => /\/control$/.test(u))));

    // Settings
    await shell.evaluate(() => window.shell.openSettings());
    const s = await waitFor(() => app.windows().find((w) => /settings\.html/.test(w.url())), 8000);
    s.on('pageerror', (e) => errors.push('settings: ' + e.message));
    await s.waitForSelector('#sections section');
    // update download with a burner tab in front
    await s.evaluate(() => window.ngSettings.do('update-check'));
    await waitFor(async () => (await s.evaluate(() => window.ngSettings.get())).update.state === 'available', 8000);
    await shell.evaluate(() => window.shell.openBurner()); await waitFor(async () => (await activeTab()).burnEnds);
    await s.evaluate(() => window.ngSettings.do('update-get'));
    await check('"Get it" downloads the update through the window, even with a burner tab in front', async () => assert.ok(await waitFor(() => app.evaluate(() => global.__dl.some((u) => /99\.0\.0/.test(u))), 4000)));
    // back to the Settings tab
    const setTab = (await state()).tabs.find((t) => t.settings);
    await shell.evaluate((id) => window.shell.activate(id), setTab.id); await wait(400);
    // dark pages switch with the moon button turned off
    const featTile = (l) => s.evaluate((l) => [...document.querySelectorAll('.fitem')].find((x) => x.querySelector('.flabel').firstChild.textContent.trim() === l).querySelector('.tgl'), l);
    const darkRow = () => s.evaluate(() => [...document.querySelectorAll('#look .row')].find((x) => x.querySelector('.label').textContent.trim() === 'Dark pages').querySelector('.tgl').getAttribute('aria-checked'));
    await s.evaluate(() => [...document.querySelectorAll('.fitem')].find((x) => x.querySelector('.flabel').firstChild.textContent.trim() === 'Dark pages button').querySelector('.tgl').click());
    await wait(600);
    const before = await darkRow();
    await s.evaluate(() => [...document.querySelectorAll('#look .row')].find((x) => x.querySelector('.label').textContent.trim() === 'Dark pages').querySelector('.tgl').click());
    await wait(800);
    await check('Dark pages switch shows what was saved, even with the moon button off', async () => { assert.strictEqual(before, 'false'); assert.strictEqual(await darkRow(), 'true'); assert.strictEqual(JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')).darkPages, true); });
    await s.evaluate(() => [...document.querySelectorAll('#look .row')].find((x) => x.querySelector('.label').textContent.trim() === 'Dark pages').querySelector('.tgl').click());
    await s.evaluate(() => [...document.querySelectorAll('.fitem')].find((x) => x.querySelector('.flabel').firstChild.textContent.trim() === 'Dark pages button').querySelector('.tgl').click());
    await wait(600);
    // developer mode refreshes Settings
    const tiles0 = await s.evaluate(() => document.querySelectorAll('.fitem').length);
    await shell.evaluate(() => window.shell.setDevMode(true));
    await check('turning on developer mode updates the open Settings page', async () => assert.ok(await waitFor(() => s.evaluate((n) => document.querySelectorAll('.fitem').length > n, tiles0), 5000)));
    await shell.evaluate(() => window.shell.setDevMode(false)); await wait(500);
    // PIN lockout covers remove-PIN
    const set = await s.evaluate(() => window.ngSettings.do('pin-set', '', '4321'));
    const tries = [];
    for (let i = 0; i < 5; i++) tries.push(await s.evaluate(() => window.ngSettings.do('pin-clear', '0000')));
    const right = await s.evaluate(() => window.ngSettings.do('pin-clear', '4321'));
    await check('remove-PIN: wrong guesses lock it after 5 tries, and then even the right PIN waits', () => {
      assert.ok(set && set.ok !== false, JSON.stringify(set));
      assert.strictEqual(tries[3].reason, 'wrong'); assert.strictEqual(tries[4].reason, 'wait');
      assert.strictEqual(right.reason, 'wait');
    });
    // settings file
    await check('settings.json is valid and no half-written temp file is left', () => {
      JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
      assert.ok(!fs.existsSync(path.join(userData, 'settings.json.tmp')));
    });

    await check('no errors in the app while doing all of this', () => assert.deepStrictEqual(errors, []));
  } finally {
    await app.close().catch(() => {});
    site.close(); gh.close();
  }
  if (failed) { console.log('FIXES TEST FAILED'); process.exit(1); }
  console.log('ALL FIXES TESTS PASS');
})().catch((e) => { console.error(e); process.exit(1); });
