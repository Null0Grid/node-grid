'use strict';
// End-to-end checks for the 5.1.5 features, through the real app:
//   1. signing in to a site brings up "Save login?"; SAVE (with "Keep me signed
//      in") stores it and keeps the site
//   2. the next time the site's sign-in page opens, the login is filled in
//   3. NEVER FOR THIS SITE stops the prompt for that site
//   4. after a restart, a kept site is still signed in (its cookie survived) and a
//      site you didn't keep is not
//   5. a pinned tab comes back with Masking on, the way it was left
//   6. Theme (Dark / Light / Match my computer) and Sidebar size apply and are saved
//
//   xvfb-run -a -s "-screen 0 1400x900x24" node tests/ui-515.test.js
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const pw = require('playwright');

const APP_DIR = path.resolve(__dirname, '..');
const electronPath = require(path.join(APP_DIR, 'node_modules', 'electron'));
const SHOTS = process.env.F515_SHOTS || '';
const { execFileSync } = require('child_process');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { try { const v = await fn(); if (v) return v; } catch {} await wait(150); }
  return null;
}
let failed = false;
const check = async (label, fn) => { try { await fn(); console.log('[pass] ' + label); } catch (e) { failed = true; console.log('[FAIL] ' + label + ': ' + e.message); } };

const LOGIN = '<!doctype html><title>sign in</title><body style="background:#fff"><form action="/welcome" method="get"><input id="u" name="username" type="text" autocomplete="username"><input id="p" name="password" type="password"><button id="go" type="submit">Sign in</button></form>';

(async () => {
  const site = http.createServer((q, r) => {
    const u = new URL(q.url, 'http://x');
    r.setHeader('Content-Type', 'text/html');
    if (u.pathname === '/login') return r.end(LOGIN);
    if (u.pathname === '/welcome') { r.setHeader('Set-Cookie', 'session=signed-in; Max-Age=86400; Path=/'); return r.end('<!doctype html><title>welcome</title>welcome'); }
    if (u.pathname === '/me') return r.end('<!doctype html><title>' + (/(^|; )session=signed-in/.test(q.headers.cookie || '') ? 'signed in' : 'signed out') + '</title>me');
    r.end('<!doctype html><title>page</title>page');
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const port = site.address().port;
  const A = 'http://127.0.0.1:' + port, B = 'http://localhost:' + port;   // A gets kept, B doesn't
  const ud = path.join(os.tmpdir(), 'node-grid-ci-515-' + Date.now());
  const launch = () => pw._electron.launch({
    args: [APP_DIR, '--user-data-dir=' + ud], executablePath: electronPath,
    env: { ...process.env, NODEGRID_TEST_PLAINTEXT_VAULT: '1', NODEGRID_UPDATE_URL: 'http://127.0.0.1:1/' },
  });
  const settingsFile = () => { try { return JSON.parse(fs.readFileSync(path.join(ud, 'settings.json'), 'utf8')); } catch { return {}; } };
  let app = await launch();
  const errors = [];
  const attach = async () => {
    const shell = await waitFor(() => app.windows().find((w) => /shell\.html$/.test(w.url())), 15000);
    shell.on('pageerror', (e) => errors.push(e.message));
    await shell.evaluate(() => { window.__s = null; window.shell.onState((s) => { window.__s = s; }); });
    await wait(1200);
    return shell;
  };
  let shell = await attach();
  const state = () => shell.evaluate(() => window.__s);
  const activeTab = async () => { const s = await state(); return s && s.tabs.find((t) => t.id === s.activeId); };
  const go = async (u) => { await shell.evaluate((x) => window.shell.go(x), u); await waitFor(async () => { const t = await activeTab(); return t && t.url.startsWith(u) && !t.loading; }); await wait(300); };
  const page = (re) => waitFor(() => app.windows().find((w) => re.test(w.url())), 8000);
  const promptWin = () => app.windows().find((w) => /loginsave\.html/.test(w.url()));
  try {
    // 1. sign in -> prompt -> SAVE with keep
    await shell.evaluate(() => window.shell.newTab()); await wait(300);
    await go(A + '/login');
    let lp = await page(new RegExp('127\\.0\\.0\\.1:' + port + '/login'));
    await lp.fill('#u', 'luke'); await lp.fill('#p', 'hunter2');
    await lp.click('#go');
    const prompt = await waitFor(promptWin, 6000);
    await check('signing in brings up "Save login?" with the site and username', async () => {
      assert.ok(prompt, 'no prompt');
      const t = await prompt.evaluate(() => ({ site: document.getElementById('site').textContent, user: document.getElementById('user').textContent, keep: !document.getElementById('keeprow').hidden }));
      assert.deepStrictEqual(t, { site: '127.0.0.1', user: 'luke', keep: true });
    });
    if (SHOTS) { await wait(300); execFileSync('import', ['-window', 'root', path.join(SHOTS, 'save-login.png')]); }
    await prompt.click('#save').catch(() => {});
    await check('SAVE stores the login and keeps you signed in on the site', async () => {
      assert.ok(await waitFor(() => !promptWin(), 4000), 'prompt still open');
      const st = settingsFile();
      assert.ok((st.keepSignedIn || []).includes('127.0.0.1'), JSON.stringify(st.keepSignedIn));
      const vault = JSON.parse(fs.readFileSync(path.join(ud, 'vault.json'), 'utf8'));
      assert.ok(vault.some((v) => v.host === '127.0.0.1' && v.user === 'luke'));
    });
    await waitFor(async () => /welcome/.test((await activeTab()).url), 6000);
    await check('...and the tab now uses the session that is kept between restarts', async () => assert.ok(await waitFor(() => app.evaluate(({ webContents, session }, u) => {
      return webContents.getAllWebContents().some((x) => !x.isDestroyed() && x.getURL().startsWith(u) && x.session === session.fromPartition('persist:nullgrid-kept'));
    }, A + '/welcome'), 8000)));

    // 2. auto-fill on the next visit
    await shell.evaluate(() => window.shell.newTab()); await wait(300);
    await go(A + '/login');
    const lps = () => app.windows().filter((w) => w.url().startsWith(A + '/login'));
    await check('opening the sign-in page again fills in the saved login', async () => assert.ok(await waitFor(async () => {
      for (const w of lps()) { const v = await w.evaluate(() => [document.getElementById('u').value, document.getElementById('p').value]).catch(() => null); if (v && v[0] === 'luke' && v[1] === 'hunter2') return true; }
      return false;
    }, 8000)));
    await check("...and it doesn't ask to save the same login again", async () => { const l = lps().pop(); await l.click('#go'); await wait(1500); assert.ok(!promptWin()); });

    // 3. NEVER on the other host
    await shell.evaluate(() => window.shell.newTab()); await wait(300);
    await go(B + '/login');
    lp = await page(new RegExp('localhost:' + port + '/login'));
    await lp.fill('#u', 'other'); await lp.fill('#p', 'pw-b'); await lp.click('#go');
    const p2 = await waitFor(promptWin, 6000);
    await p2.click('#never').catch(() => {});
    await waitFor(() => !promptWin(), 4000);
    await check('NEVER FOR THIS SITE is remembered', () => assert.ok((settingsFile().loginNever || []).includes('localhost')));
    await shell.evaluate(() => window.shell.newTab()); await wait(300);
    await go(B + '/login');
    lp = (await waitFor(() => app.windows().filter((w) => w.url().startsWith(B + '/login')).pop(), 6000));
    await lp.fill('#u', 'other2'); await lp.fill('#p', 'pw-b2'); await lp.click('#go');
    await wait(1500);
    await check('...and that site is never asked about again', () => assert.ok(!promptWin()));

    // 5 (setup). pin a tab with Masking on
    await shell.evaluate(() => window.shell.newTab()); await wait(300);
    await go(A + '/pinme');
    await app.evaluate(({ Menu }) => { global.__menus = []; const b = Menu.buildFromTemplate.bind(Menu); Menu.buildFromTemplate = (t) => { global.__menus.push(t); const m = b(t); m.popup = () => {}; return m; }; });
    const click = (label) => app.evaluate((_, l) => { const m = global.__menus[global.__menus.length - 1] || []; const it = m.find((i) => i.label === l); if (it) it.click(); return !!it; }, label);
    let pin = (await state()).tabs.find((t) => /\/pinme$/.test(t.url));
    await shell.evaluate((id) => window.shell.tabMenu(id), pin.id); await wait(200); await click('Masking'); await wait(800);
    await shell.evaluate((id) => window.shell.tabMenu(id), pin.id); await wait(200); await click('Pin tab'); await wait(800);
    await check('a pinned tab with Masking on is saved that way', () => assert.ok((settingsFile().pinnedMasked || []).some((u) => /\/pinme$/.test(u)), JSON.stringify(settingsFile().pinnedMasked)));

    // 6. theme + size
    await shell.evaluate(() => window.shell.openSettings());
    const s = await page(/settings\.html/);
    await s.waitForSelector('#sections section');
    await s.evaluate(() => window.ngSettings.do('theme', 'light'));
    await check('Theme: Light turns NODE_GRID light at once (sidebar, Settings, start page)', async () => assert.ok(await waitFor(async () =>
      (await shell.evaluate(() => document.documentElement.dataset.theme)) === 'light' && (await s.evaluate(() => document.documentElement.dataset.theme)) === 'light'
      && (await shell.evaluate(() => getComputedStyle(document.body).backgroundColor)) !== 'rgb(10, 10, 15)', 4000)));
    if (SHOTS) { await s.evaluate(() => document.getElementById('look').scrollIntoView()); await wait(500); execFileSync('import', ['-window', 'root', path.join(SHOTS, 'light-settings.png')]); }
    await s.evaluate(() => window.ngSettings.do('theme', 'system'));
    await check("Theme: Match my computer follows the computer's own light/dark mode", async () => {
      const sys = await app.evaluate(({ nativeTheme }) => (nativeTheme.themeSource === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : 'not system'));
      assert.ok(sys === 'dark' || sys === 'light', sys);
      assert.ok(await waitFor(async () => (await shell.evaluate(() => document.documentElement.dataset.theme)) === sys, 4000));
    });
    await s.evaluate(() => window.ngSettings.do('ui-size', 'xl'));
    await check('Sidebar size: Extra large makes the tab icons and sidebar bigger', async () => assert.ok(await waitFor(() => shell.evaluate(() => {
      const f = document.querySelector('#tabs .tab .fav');
      return document.body.classList.contains('size-xl') && f && f.getBoundingClientRect().width >= 34;
    }), 4000)));
    await s.evaluate(() => window.ngSettings.do('theme', 'light'));
    await check('theme and size are saved', () => { const st = settingsFile(); assert.strictEqual(st.theme, 'light'); assert.strictEqual(st.uiSize, 'xl'); });

    // 4 (setup). a cookie on the site you didn't keep
    await shell.evaluate(() => window.shell.newTab()); await wait(300);
    await go(B + '/welcome');
    await check('no errors in the app', () => assert.deepStrictEqual(errors, []));
  } finally { await app.close().catch(() => {}); }

  // ---- restart ----
  app = await launch();
  try {
    shell = await attach();
    await wait(1500);
    await check('after a restart: light theme and extra-large sidebar are still on', async () => assert.ok(await waitFor(() => shell.evaluate(() => document.documentElement.dataset.theme === 'light' && document.body.classList.contains('size-xl')), 5000)));
    await wait(3000); console.log('DIAG2', JSON.stringify(await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((x) => [x.getURL().slice(0, 50), x.getUserAgent().slice(-40), x.debugger.isAttached()]))));
    await check('after a restart: the pinned tab is back with Masking on', async () => assert.ok(await waitFor(() => app.evaluate(({ webContents }) => {
      const w = webContents.getAllWebContents().find((x) => /\/pinme$/.test(x.getURL()));
      return w && /Chrome\/\d+\.0\.0\.0 Safari/.test(w.getUserAgent()) && w.debugger.isAttached();   // the mask's Chrome identity
    }), 8000)));
    if (SHOTS) execFileSync('import', ['-window', 'root', path.join(SHOTS, 'light-xl.png')]);
    await shell.evaluate(() => window.shell.newTab()); await wait(300);
    await shell.evaluate((x) => window.shell.go(x), A + '/me');
    await check('after a restart: the site you kept is still signed in', async () => assert.ok(await waitFor(async () => { const s = await state(); const t = s && s.tabs.find((x) => x.id === s.activeId); return t && t.title === 'signed in'; }, 8000)));
    await shell.evaluate(() => window.shell.newTab()); await wait(300);
    await shell.evaluate((x) => window.shell.go(x), B + '/me');
    await check("after a restart: a site you didn't keep is signed out (wiped as always)", async () => assert.ok(await waitFor(async () => { const s = await state(); const t = s && s.tabs.find((x) => x.id === s.activeId); return t && t.title === 'signed out'; }, 8000)));
  } finally { await app.close().catch(() => {}); site.close(); }
  if (failed) { console.log('5.1.5 FEATURES TEST FAILED'); process.exit(1); }
  console.log('ALL 5.1.5 FEATURES TESTS PASS');
})().catch((e) => { console.error(e); process.exit(1); });
