'use strict';
// End-to-end check of NODE_GRID updating itself, with two real packaged builds:
// an "old" one that is run, and a "new" release archive served by a stand-in for
// the GitHub releases API (same JSON shape, including the sha256 digest).
//
//   1. a download that doesn't match the checksum is thrown away; nothing changes
//   2. UPDATE downloads + checks + unpacks it; RESTART TO UPDATE swaps the new
//      files in, NODE_GRID comes back on the new version, says so, and reopens
//      the tabs that were open
//   3. with a downloaded update, simply closing NODE_GRID installs it too
//
// Linux (.tar.gz copy) and Windows (portable .zip) are the copies that do this
// with a helper script, so this runs on both (CI: Linux here, Windows in ci.yml).
//
//   SU_OLD=<old program folder> SU_NEW=<new .tar.gz/.zip> SU_NEW_VERSION=9.9.9 \
//     xvfb-run -a node tests/selfupdate.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const pw = require('playwright');
const asar = require('@electron/asar');

const OLD = process.env.SU_OLD, NEW = process.env.SU_NEW, NEWV = process.env.SU_NEW_VERSION || '9.9.9';
if (!OLD || !NEW) { console.error('set SU_OLD and SU_NEW'); process.exit(2); }
const WIN = process.platform === 'win32';
const KIND = WIN ? 'zip' : 'tar';
const EXE = WIN ? 'NODE_GRID.exe' : 'node-grid';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { try { const v = await fn(); if (v) return v; } catch {} await wait(200); }
  return null;
}
let failed = false;
const note = (msg) => { if (process.env.GITHUB_ACTIONS) console.log('::error title=self-update::' + String(msg).replace(/\r?\n/g, ' ').slice(0, 900)); };
const check = async (label, fn) => { try { await fn(); console.log('[pass] ' + label); } catch (e) { failed = true; console.log('[FAIL] ' + label + ': ' + e.message); note(label + ': ' + e.message); } };
const versionIn = (dir) => JSON.parse(asar.extractFile(path.join(dir, 'resources', 'app.asar'), 'package.json').toString()).version;
const readSettings = (ud) => { try { return JSON.parse(fs.readFileSync(path.join(ud, 'settings.json'), 'utf8')); } catch { return {}; } };
function killAll(dir) {
  try {
    if (WIN) execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-Process | Where-Object { $_.Path -like '${dir.replace(/'/g, "''")}*' } | Stop-Process -Force`], { stdio: 'ignore' });
    else execFileSync('pkill', ['-f', dir], { stdio: 'ignore' });
  } catch {}
}
const running = (dir) => {
  try {
    if (WIN) return execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process | Where-Object { $_.Path -like '${dir.replace(/'/g, "''")}*' }).Count`]).toString().trim() !== '0';
    execFileSync('pgrep', ['-f', dir], { stdio: 'ignore' }); return true;
  } catch { return false; }
};

(async () => {
  const archive = fs.readFileSync(NEW);
  const name = path.basename(NEW);
  const good = crypto.createHash('sha256').update(archive).digest('hex');
  let digest = 'sha256:' + '0'.repeat(64);            // round 1: wrong on purpose
  const gh = http.createServer((q, r) => {
    const base = 'http://127.0.0.1:' + gh.address().port;
    if (q.url === '/latest') {
      r.setHeader('Content-Type', 'application/json');
      return r.end(JSON.stringify({ tag_name: NEWV, html_url: 'https://github.com/Null0Grid/node-grid/releases/tag/' + NEWV, body: 'test',
        assets: [{ name, size: archive.length, digest, browser_download_url: base + '/dl/' + name }] }));
    }
    if (q.url === '/dl/' + name) { r.setHeader('Content-Length', archive.length); return r.end(archive); }
    if (q.url === '/page') { r.setHeader('Content-Type', 'text/html'); return r.end('<!doctype html><title>kept tab</title>kept'); }
    r.statusCode = 404; r.end();
  });
  await new Promise((r) => gh.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + gh.address().port;

  async function launch(appDir, ud) {
    const app = await pw._electron.launch({
      executablePath: path.join(appDir, EXE),
      args: [...(WIN || process.getuid() !== 0 ? [] : ['--no-sandbox']), '--user-data-dir=' + ud],
      env: { ...process.env, NODEGRID_UPDATE_URL: base + '/latest', NODEGRID_UPDATE_TEST_HOST: base + '/', NODEGRID_UPDATE_DELAY_MS: '600000', NODEGRID_TEST_PLAINTEXT_VAULT: '1' },
    });
    const shell = await waitFor(() => app.windows().find((w) => /shell\.html$/.test(w.url())), 20000);
    await wait(1000);
    await shell.evaluate(() => window.shell.openSettings());
    const s = await waitFor(() => app.windows().find((w) => /settings\.html/.test(w.url())), 10000);
    await s.waitForSelector('#sections section');
    return { app, shell, s, model: () => s.evaluate(() => window.ngSettings.get()) };
  }
  const fresh = (tag) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-su-' + tag + '-'));
    const appDir = path.join(root, 'NODE_GRID'); fs.cpSync(OLD, appDir, { recursive: true, verbatimSymlinks: true });
    return { appDir, ud: path.join(root, 'data') };
  };

  // ---- 1 + 2: bad checksum, then update + restart ----
  const A = fresh('restart');
  const oldV = versionIn(A.appDir);
  let r = await launch(A.appDir, A.ud);
  try {
    await check(`this copy updates itself (kind ${KIND})`, async () => assert.strictEqual((await r.model()).update.kind, KIND));
    await r.shell.evaluate(() => window.shell.newTab()); await wait(300);
    await r.shell.evaluate((u) => window.shell.go(u), base + '/page'); await wait(1200);
    await r.s.evaluate(() => window.ngSettings.do('update-check'));
    await check('the newer version is found, and it can install itself', async () => { const u = (await r.model()).update; assert.strictEqual(u.state, 'available'); assert.strictEqual(u.self, true); });
    await r.s.evaluate(() => window.ngSettings.do('update-get'));
    const bad = await waitFor(async () => { const u = (await r.model()).update; return u.state === 'available' && u.error ? u : null; }, 60000);
    await check('a download with the wrong checksum is refused and nothing changes', () => {
      assert.ok(bad && /checksum/.test(bad.error), bad && bad.error);
      assert.strictEqual(versionIn(A.appDir), oldV);
      assert.ok(!fs.existsSync(path.join(A.ud, 'updates', 'stage')));
    });
    digest = 'sha256:' + good;
    await r.s.evaluate(() => window.ngSettings.do('update-check'));
    await r.s.evaluate(() => window.ngSettings.do('update-get'));
    const ready = await waitFor(async () => ((await r.model()).update.state === 'ready'), 120000);
    await check('UPDATE downloads, checks and unpacks it (state: ready)', () => assert.ok(ready, 'never got ready'));
    await check('...and Settings offers RESTART TO UPDATE', async () => assert.ok(await r.s.$('#updrestart')));
    const exited = new Promise((res) => r.app.process().once('exit', res));
    await r.s.evaluate(() => { window.ngSettings.do('update-restart'); });
    await check('RESTART TO UPDATE closes NODE_GRID', async () => assert.ok(await Promise.race([exited.then(() => true), wait(30000).then(() => false)])));
  } catch (e) { failed = true; console.log('[FAIL] ' + e.message); note(e.message); await r.app.close().catch(() => {}); }
  await check(`the new version (${NEWV}) is in place`, async () => assert.ok(await waitFor(() => versionIn(A.appDir) === NEWV, 60000), 'still ' + versionIn(A.appDir)));
  if (versionIn(A.appDir) !== NEWV) {
    const d = path.join(A.ud, 'updates');
    let listing = ''; try { listing = fs.readdirSync(d).join(', '); } catch (e) { listing = 'no updates folder'; }
    let log = ''; try { log = fs.readFileSync(path.join(d, 'last-update.log'), 'utf8'); } catch { log = 'no log'; }
    note('diagnostics: updates folder = [' + listing + '], helper log = ' + log + ', app still running = ' + running(A.appDir));
  }
  await check('the helper says it copied everything', async () => assert.ok(await waitFor(() => fs.readFileSync(path.join(A.ud, 'updates', 'last-update.log'), 'utf8').trim() === 'ok', 20000)));
  await check('NODE_GRID started again by itself, on the new version, and noticed the update', async () => {
    assert.ok(await waitFor(() => running(A.appDir), 30000), 'not running');
    assert.ok(await waitFor(() => { const st = readSettings(A.ud); return !st.updateFrom && !st.restoreTabs; }, 30000), JSON.stringify(readSettings(A.ud)).slice(0, 200));
  });
  killAll(A.appDir); await wait(1500);
  // look at the new version's first start: the toast + the reopened tab (relaunch it ourselves to watch)
  fs.writeFileSync(path.join(A.ud, 'settings.json'), JSON.stringify({ ...readSettings(A.ud), updateFrom: { from: oldV, to: NEWV }, restoreTabs: [base + '/page'] }));
  r = await launch(A.appDir, A.ud);
  await check('the new version reopens the tabs you had and says "Updated to NODE_GRID ' + NEWV + '"', async () => {
    assert.ok(await waitFor(() => r.shell.evaluate(() => [...document.querySelectorAll('#tabs .tab .title')].some((t) => t.textContent === 'kept tab')), 10000), 'tab not reopened');
    const toastSeen = await waitFor(() => r.shell.evaluate(() => /Updated to NODE_GRID/.test(document.getElementById('toast').textContent)), 6000);
    assert.ok(toastSeen, 'no toast');
  });
  await r.app.close().catch(() => {});
  killAll(A.appDir);

  // ---- 3: closing NODE_GRID installs a downloaded update ----
  const B = fresh('close');
  r = await launch(B.appDir, B.ud);
  try {
    await r.s.evaluate(() => window.ngSettings.do('update-check'));
    await r.s.evaluate(() => window.ngSettings.do('update-get'));
    await waitFor(async () => ((await r.model()).update.state === 'ready'), 120000);
  } finally { await r.app.close().catch(() => {}); }
  await check('closing NODE_GRID with an update downloaded installs it', async () => assert.ok(await waitFor(() => versionIn(B.appDir) === NEWV, 60000), 'still ' + versionIn(B.appDir)));
  await check("...and doesn't start it again by itself", async () => { await wait(4000); assert.ok(!running(B.appDir)); });
  killAll(B.appDir);

  gh.close();
  if (failed) { console.log('SELF-UPDATE TEST FAILED'); process.exit(1); }
  console.log('ALL SELF-UPDATE TESTS PASS');
  process.exit(0);
})().catch((e) => { console.error(e); note('crashed: ' + (e && e.stack || e)); process.exit(1); });
