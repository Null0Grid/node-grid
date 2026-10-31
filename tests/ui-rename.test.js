'use strict';
// Updating from a version before the rename (NODE_GRID 5.1.x) to Null Grid:
//   1. the old data folder moves to the new name before anything opens it
//   2. favorites, settings and loadouts (with their old nodegrid:// links) come along
//   3. saved logins, encrypted under the old app name, can still be read
//   4. the AI panel's saved sign-in (a cookie in its own storage) comes along
//   5. the app calls itself Null Grid (name, window title), and still does next start
//   6. a fresh install is Null Grid throughout
// Set KEYRING=1 inside a desktop keyring session (dbus-run-session + an unlocked
// gnome-keyring) to test it against a real keyring, where the app name matters:
//   dbus-run-session -- sh -c 'echo -n pw | gnome-keyring-daemon --unlock --components=secrets; \
//     KEYRING=1 xvfb-run -a -s "-screen 0 1400x900x24" node tests/ui-rename.test.js'
// Without it the test key store is used (the same key for every app name), so 3
// still runs but proves less.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const pw = require('playwright');

const APP_DIR = path.resolve(__dirname, '..');
const electronPath = require(path.join(APP_DIR, 'node_modules', 'electron'));
const KEYRING = process.env.KEYRING === '1';
const STORE = KEYRING ? ['--password-store=gnome-libsecret'] : [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { try { const v = await fn(); if (v) return v; } catch {} await wait(150); }
  return null;
}
let failed = false;
const check = async (label, fn) => { try { await fn(); console.log('[pass] ' + label); } catch (e) { failed = true; console.log('[FAIL] ' + label + ': ' + e.message); } };
const VERSION = require(path.join(APP_DIR, 'package.json')).version;
const OLD_NAME = 'NODE_GRID';

// A data folder exactly as the old version left it, written by an Electron
// process named like the old version (so its keyring entry is the old one too).
function makeOldData(cfg) {
  const dir = path.join(cfg, OLD_NAME);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ seenVersion: '5.1.7', theme: 'light', features: {} }));
  fs.writeFileSync(path.join(dir, 'favorites.json'), JSON.stringify([{ url: 'https://example.com/', title: 'Example', favicon: null }]));
  fs.writeFileSync(path.join(dir, 'loadouts.json'), JSON.stringify([{ id: 'l1', name: 'Morning', urls: ['nodegrid://home', 'https://example.com/'] }]));
  const script = path.join(os.tmpdir(), 'ng-old-' + Date.now() + '.js');
  fs.writeFileSync(script, `
    const { app, safeStorage, session } = require('electron'); const fs = require('fs'), path = require('path');
    app.setName(${JSON.stringify(OLD_NAME)}); app.setPath('userData', ${JSON.stringify(dir)});
    app.whenReady().then(async () => {
      if (${JSON.stringify(!KEYRING)}) safeStorage.setUsePlainTextEncryption(true);   // no keyring: like the app's own test switch
      const pass = safeStorage.encryptString('router-pass').toString('base64');
      fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'vault.json'), JSON.stringify([{ host: 'example.com', user: 'admin', pass }]));
      const ai = session.fromPartition('persist:' + 'nodegrid-ai');
      await ai.cookies.set({ url: 'https://claude.ai/', name: 'sessionKey', value: 'signed-in', expirationDate: Math.floor(Date.now() / 1000) + 86400 * 30 });
      await ai.cookies.flushStore();
      console.log('OLD DATA WRITTEN'); setTimeout(() => app.quit(), 300);
    });`);
  const out = execFileSync(electronPath, ['--no-sandbox', ...STORE, script], { env: { ...process.env, XDG_CONFIG_HOME: cfg }, encoding: 'utf8', timeout: 60000 });
  if (!/OLD DATA WRITTEN/.test(out)) throw new Error('could not make the old data: ' + out);
  return dir;
}

(async () => {
  console.log(KEYRING ? '(against a real desktop keyring)' : '(no desktop keyring: basic key store)');
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-rename-'));
  const oldDir = makeOldData(cfg);
  const newDir = path.join(cfg, 'Null Grid');
  const launch = (home) => pw._electron.launch({ args: [APP_DIR, ...STORE], executablePath: electronPath,
    env: { ...process.env, XDG_CONFIG_HOME: home, NULLGRID_UPDATE_URL: 'http://127.0.0.1:1/', NULLGRID_SKIP_INTRO: '1', ...(KEYRING ? {} : { NULLGRID_TEST_PLAINTEXT_VAULT: '1' }) } });
  const attach = async (app) => {
    const shell = await waitFor(() => app.windows().find((w) => /shell\.html$/.test(w.url())), 15000);
    await shell.evaluate(() => { window.__s = null; window.shell.onState((s) => { window.__s = s; }); window.shell.refreshState(); });
    await waitFor(() => shell.evaluate(() => !!window.__s));
    return shell;
  };
  const readLogin = (app, dir) => app.evaluate(({ safeStorage }, b64) => {
    try { return safeStorage.decryptString(Buffer.from(b64, 'base64')); } catch (e) { return 'FAILED: ' + e.message; }
  }, JSON.parse(fs.readFileSync(path.join(dir, 'vault.json'), 'utf8'))[0].pass);
  let app = await launch(cfg);
  try {
    const shell = await attach(app);
    await check('the old data folder moved to "Null Grid"', () => { assert.ok(fs.existsSync(path.join(newDir, 'settings.json'))); assert.ok(!fs.existsSync(oldDir), 'old folder still there'); });
    await check('favorites came along', async () => assert.ok((await shell.evaluate(() => window.__s.favs)).some((f) => f.url === 'https://example.com/')));
    await check('settings came along (light theme)', async () => assert.ok(await waitFor(() => shell.evaluate(() => document.documentElement.dataset.theme === 'light'))));
    await check('loadouts came along, their old start-page link updated', async () => {
      const l = (await shell.evaluate(() => window.__s.loadouts)).find((x) => x.name === 'Morning');
      assert.ok(l && l.count === 2 && l.hosts.includes('home'), JSON.stringify(l));
    });
    await check('a saved login encrypted by the old version still unlocks', async () => assert.strictEqual(await readLogin(app, newDir), 'router-pass'));
    await check('the AI panel stays signed in (its storage moved too)', async () => {
      const c = await app.evaluate(({ session }) => session.fromPartition('persist:nullgrid-ai').cookies.get({ name: 'sessionKey' }));
      assert.ok(c.length && c[0].value === 'signed-in', JSON.stringify(c));
    });
    await check('the app is called Null Grid', async () => {
      assert.strictEqual(await app.evaluate(({ app: a }) => a.getName()), 'Null Grid');
      assert.ok(await waitFor(async () => / - Null Grid$|^Null Grid$/.test(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()))));
    });
  } finally { await app.close().catch(() => {}); }

  app = await launch(cfg);
  try {
    await attach(app);
    await check('next start: logins still unlock, still called Null Grid', async () => {
      assert.strictEqual(await readLogin(app, newDir), 'router-pass');
      assert.strictEqual(await app.evaluate(({ app: a }) => a.getName()), 'Null Grid');
    });
  } finally { await app.close().catch(() => {}); }

  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-fresh-'));
  app = await launch(fresh);
  try {
    await attach(app);
    await check('a fresh install keeps its data in "Null Grid" and nothing under the old name', () => {
      assert.ok(fs.existsSync(path.join(fresh, 'Null Grid')));
      assert.ok(!fs.existsSync(path.join(fresh, OLD_NAME)));
      assert.ok(!fs.existsSync(path.join(fresh, 'Null Grid', 'legacy-keyring')));
    });
    await check('...and can save and read a login', async () => assert.strictEqual(await app.evaluate(({ safeStorage }) => safeStorage.decryptString(safeStorage.encryptString('x'))), 'x'));
  } finally { await app.close().catch(() => {}); }
  if (failed) { console.log('RENAME UPDATE TEST FAILED'); process.exit(1); }
  console.log('ALL RENAME UPDATE TESTS PASS');
})().catch((e) => { console.error(e); process.exit(1); });
