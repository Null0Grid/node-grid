'use strict';
// End-to-end check of the "not secure" warning in front of plain http sites:
//   1. an http site (not this computer) stops at the warning, showing its address
//   2. CLOSE never goes in: back to the page you were on
//   3. PROCEED, DON'T TRUST opens it; logins are never offered or filled there;
//      the same site doesn't warn again until Null Grid closes, and Back skips the warning
//   4. PROCEED, I TRUST IT opens it and remembers it: logins are offered and filled,
//      and after a restart there's no warning
//   5. after a restart, a site you didn't trust warns again
// Needs a non-loopback address for this computer (this computer itself is exempt).
//
//   xvfb-run -a -s "-screen 0 1400x900x24" node tests/ui-insecure.test.js
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const pw = require('playwright');

const APP_DIR = path.resolve(__dirname, '..');
const electronPath = require(path.join(APP_DIR, 'node_modules', 'electron'));
const SHOTS = process.env.INS_SHOTS || '';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { try { const v = await fn(); if (v) return v; } catch {} await wait(150); }
  return null;
}
let failed = false;
const check = async (label, fn) => { try { await fn(); console.log('[pass] ' + label); } catch (e) { failed = true; console.log('[FAIL] ' + label + ': ' + e.message); } };
const ip = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal);
if (!ip) { console.log('no non-loopback IPv4 address; skipping'); console.log('ALL INSECURE WARNING TESTS PASS'); process.exit(0); }

const LOGIN = '<!doctype html><title>router login</title><body style="background:#fff"><form action="/welcome" method="get"><input id="u" name="username" type="text"><input id="p" name="password" type="password"><button id="go" type="submit">Sign in</button></form>';

(async () => {
  const handler = (q, r) => { r.setHeader('Content-Type', 'text/html'); const u = new URL(q.url, 'http://x'); r.end(u.pathname === '/login' ? LOGIN : '<!doctype html><title>page ' + u.pathname + '</title>page'); };
  const s1 = http.createServer(handler), s2 = http.createServer(handler);
  await new Promise((r) => s1.listen(0, '0.0.0.0', r));
  await new Promise((r) => s2.listen(0, '0.0.0.0', r));
  const P = `http://${ip.address}:${s1.address().port}`, T = `http://${ip.address}:${s2.address().port}`;   // P: proceed only, T: trusted
  const home = http.createServer(handler); await new Promise((r) => home.listen(0, '127.0.0.1', r));
  const L = 'http://127.0.0.1:' + home.address().port;                     // this computer: never warned
  const ud = path.join(os.tmpdir(), 'null-grid-ci-insecure-' + Date.now());
  fs.mkdirSync(ud, { recursive: true });
  fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ seenVersion: require(path.join(APP_DIR, 'package.json')).version }));
  const launch = () => pw._electron.launch({ args: [APP_DIR, '--user-data-dir=' + ud], executablePath: electronPath,
    env: { ...process.env, NULLGRID_TEST_PLAINTEXT_VAULT: '1', NULLGRID_UPDATE_URL: 'http://127.0.0.1:1/', NULLGRID_SKIP_INTRO: '1' } });
  let app = await launch(), shell;
  const attach = async () => {
    shell = await waitFor(() => app.windows().find((w) => /shell\.html$/.test(w.url())), 15000);
    await shell.evaluate(() => { window.__s = null; window.shell.onState((s) => { window.__s = s; }); });
    await wait(1200);
  };
  await attach();
  const active = async () => { const s = await shell.evaluate(() => window.__s); return s && s.tabs.find((t) => t.id === s.activeId); };
  const go = (u) => shell.evaluate((x) => window.shell.go(x), u);
  const warning = () => app.windows().find((w) => /insecure\.html/.test(w.url()));
  const promptWin = () => app.windows().find((w) => /loginsave\.html/.test(w.url()));
  const pageAt = (prefix) => app.windows().filter((w) => w.url().startsWith(prefix)).pop();
  try {
    await shell.evaluate(() => window.shell.newTab()); await wait(300);
    await go(L + '/mine'); await waitFor(async () => (await active()).title === 'page /mine');
    await check('this computer (127.0.0.1) never gets the warning', async () => assert.ok(!warning()));

    // 1 + 2
    await go(P + '/first');
    let w = await waitFor(warning, 6000);
    await check('an http site stops at the "not secure" warning, showing its address', async () => {
      assert.ok(w, 'no warning');
      assert.strictEqual(await w.evaluate(() => document.getElementById('addr').textContent), P + '/first');
      assert.strictEqual(await w.evaluate(() => document.querySelectorAll('.choices button').length), 3);
    });
    if (SHOTS) { await wait(400); execFileSync('import', ['-window', 'root', path.join(SHOTS, 'not-secure.png')]); }
    await w.click('#close').catch(() => {});
    await check("CLOSE never goes in: you're back on the page you were on", async () => assert.ok(await waitFor(async () => { const t = await active(); return t && t.title === 'page /mine' && !warning(); }, 6000)));

    // 3. proceed, don't trust
    await go(P + '/login');
    w = await waitFor(warning, 6000);
    await w.click('#proceed').catch(() => {});
    const lp = await waitFor(() => pageAt(P + '/login'), 6000);
    await check('PROCEED, DON\'T TRUST opens the site', () => assert.ok(lp));
    await lp.fill('#u', 'admin'); await lp.fill('#p', 'router-pass'); await lp.click('#go');
    await wait(1500);
    await check('...and never offers to save a login there', () => assert.ok(!promptWin()));
    await go(P + '/second');
    await check('...and the same site doesn\'t warn again this run', async () => assert.ok(await waitFor(async () => (await active()).title === 'page /second' && !warning(), 6000)));
    await shell.evaluate(() => window.shell.back()); await wait(800);
    await shell.evaluate(() => window.shell.back()); await wait(800);
    await check('Back goes through the site, not back to the warning', async () => { assert.ok(!warning()); });

    // 4. trust
    await go(T + '/login');
    w = await waitFor(warning, 6000);
    await w.click('#trust').catch(() => {});
    let tp = await waitFor(() => pageAt(T + '/login'), 6000);
    await check('PROCEED, I TRUST IT opens the site and remembers it', () => {
      assert.ok(tp);
      const st = JSON.parse(fs.readFileSync(path.join(ud, 'settings.json'), 'utf8'));
      assert.ok((st.httpTrusted || []).includes(`${ip.address}:${s2.address().port}`), JSON.stringify(st.httpTrusted));
    });
    await tp.fill('#u', 'admin'); await tp.fill('#p', 'trusted-pass'); await tp.click('#go');
    const pr = await waitFor(promptWin, 6000);
    await check('...and offers to save the login there', () => assert.ok(pr));
    if (pr) await pr.click('#save').catch(() => {});
    await wait(800);
    await shell.evaluate(() => window.shell.newTab()); await wait(300);
    await go(T + '/login');
    await check('...and fills it in next time', async () => assert.ok(await waitFor(async () => {
      for (const x of app.windows().filter((y) => y.url().startsWith(T + '/login'))) { const v = await x.evaluate(() => [document.getElementById('u').value, document.getElementById('p').value]).catch(() => null); if (v && v[0] === 'admin' && v[1] === 'trusted-pass') return true; }
      return false;
    }, 8000)));
  } finally { await app.close().catch(() => {}); }

  // 5. restart
  app = await launch();
  try {
    await attach();
    await shell.evaluate(() => window.shell.newTab()); await wait(300);
    await go(T + '/again');
    await check('after a restart, a trusted site opens with no warning', async () => assert.ok(await waitFor(async () => (await active()).title === 'page /again' && !warning(), 6000)));
    await shell.evaluate(() => window.shell.newTab()); await wait(300);
    await go(P + '/again');
    await check("...and a site you didn't trust warns again", async () => assert.ok(await waitFor(warning, 6000)));
  } finally { await app.close().catch(() => {}); s1.close(); s2.close(); home.close(); }
  if (failed) { console.log('INSECURE WARNING TEST FAILED'); process.exit(1); }
  console.log('ALL INSECURE WARNING TESTS PASS');
})().catch((e) => { console.error(e); process.exit(1); });
