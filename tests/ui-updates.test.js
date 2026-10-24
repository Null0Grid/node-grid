'use strict';
// End-to-end check of update checks, the update bot, and the Settings controls,
// through the real app. A local stand-in for GitHub's "latest release" API
// (NODEGRID_UPDATE_URL) answers with a newer or the same version, so no
// network is needed.
//   1. at launch, a newer release brings out the bot (updatebot.html), whose
//      bubble names the new version and offers GET IT / WHAT'S NEW / LATER
//   2. LATER sends it away (the view closes)
//   3. Settings > UPDATES shows "available"; CHECK FOR UPDATES asks again and
//      brings the bot back, and the DOWNLOAD button is there
//   4. when GitHub's latest is the version we have, CHECK FOR UPDATES says
//      "up to date" and no bot appears
//   5. Settings > FEATURES > "Expand the shrunk sidebar when you hover over it":
//      on, hovering the shrunk sidebar expands it; off, it stays shrunk
// Needs an X display (xvfb-run). Set UPDATE_SHOTS=<dir> to save screenshots of
// the bot running in, hopping and talking, and of Settings > UPDATES.
//
//   xvfb-run -a -s "-screen 0 1400x900x24" node tests/ui-updates.test.js
const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const pw = require('playwright');

const APP_DIR = __dirname + '/..';
const electronPath = require(path.join(APP_DIR, 'node_modules', 'electron'));
const CURRENT = require('../package.json').version;
const SHOTS = process.env.UPDATE_SHOTS || '';
const shot = (name) => { if (SHOTS) execFileSync('import', ['-window', 'root', path.join(SHOTS, name)]); };

let answer = '9.9.9';                       // what the fake GitHub says is latest
function startFakeGitHub() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      const v = answer;
      res.end(JSON.stringify({
        tag_name: v, html_url: 'https://github.com/Null0Grid/node-grid/releases/tag/' + v, body: 'Test release notes.',
        assets: ['NODE_GRID-' + v + '-win32-x64.zip', 'NODE_GRID-' + v + '.AppImage', 'nullgrid-browser_' + v + '_amd64.deb',
          'nullgrid-browser-' + v + '.x86_64.rpm', 'nullgrid-browser-' + v + '.tar.gz']
          .map((name) => ({ name, size: 1000, browser_download_url: 'https://github.com/Null0Grid/node-grid/releases/download/' + v + '/' + name })),
      }));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { try { const v = await fn(); if (v) return v; } catch {} await wait(150); }
  return null;
}

(async () => {
  const gh = await startFakeGitHub();
  const app = await pw._electron.launch({
    args: [APP_DIR, '--user-data-dir=' + path.join(os.tmpdir(), 'node-grid-ci-upd-' + Date.now())],
    executablePath: electronPath,
    env: { ...process.env, NODEGRID_TEST_PLAINTEXT_VAULT: '1', NODEGRID_UPDATE_URL: 'http://127.0.0.1:' + gh.address().port + '/latest', NODEGRID_UPDATE_DELAY_MS: '1500' },
  });
  let failed = false;
  const check = async (label, fn) => { try { await fn(); console.log('[pass] ' + label); } catch (e) { failed = true; console.log('[FAIL] ' + label + ': ' + e.message); } };
  const botWin = () => app.windows().find((w) => /updatebot\.html$/.test(w.url()));
  try {
    const shell = await waitFor(() => app.windows().find((w) => /shell\.html$/.test(w.url())), 15000);
    assert.ok(shell, 'shell window should appear');

    // 1. the bot comes out by itself
    const bot = await waitFor(botWin, 12000);
    await check('a newer release brings out the update bot', () => assert.ok(bot));
    if (bot) {
      await wait(350); shot('bot-1-running-in.png');
      await wait(700); shot('bot-2-hopping.png');
      await waitFor(() => bot.evaluate(() => document.getElementById('bubble').classList.contains('on')), 6000);
      await wait(300); shot('bot-3-talking.png');
      const said = await bot.evaluate(() => document.getElementById('bubble').innerText);
      console.log('  bot says:', said.replace(/\s+/g, ' '));
      await check('its bubble names the new version and offers GET IT / LATER', () => {
        assert.ok(said.includes('NODE_GRID 9.9.9') && said.includes(CURRENT), said);
        assert.ok(/GET IT/.test(said) && /LATER/.test(said), said);
      });
      // 2. LATER: it runs off and its view closes
      await bot.click('text=LATER');
      await check('LATER sends the bot away', async () => assert.ok(await waitFor(() => !botWin(), 6000)));
    }

    // 3. Settings > UPDATES
    await shell.evaluate(() => window.shell.openSettings());
    const settings = await waitFor(() => app.windows().find((w) => /settings\.html/.test(w.url())), 8000);
    assert.ok(settings, 'settings page should open');
    await settings.waitForSelector('#updstat');
    await check('Settings shows the new version as available', async () => assert.ok(/9\.9\.9 is available/.test(await settings.textContent('#updstat'))));
    await settings.click('#updcheck');
    await check('CHECK FOR UPDATES brings the bot back', async () => assert.ok(await waitFor(botWin, 8000)));
    await check('a DOWNLOAD button is offered', async () => assert.ok(await waitFor(() => settings.$('#updget'), 4000)));
    if (SHOTS) { await settings.evaluate(() => document.getElementById('updates').scrollIntoView()); await wait(1600); shot('settings-updates.png'); }
    const b2 = botWin(); if (b2) { await b2.click('text=LATER'); await waitFor(() => !botWin(), 6000); }

    // 4. up to date
    answer = CURRENT;
    await settings.click('#updcheck');
    await check('when GitHub has our version, Settings says up to date', async () => assert.ok(await waitFor(async () => /up to date/.test(await settings.textContent('#updstat')), 8000)));
    await wait(1500);
    await check('...and no bot appears', () => assert.ok(!botWin()));

    // 5. hover-to-expand switch
    const hoverToggle = async () => settings.evaluate(() => {
      const item = [...document.querySelectorAll('.fitem')].find((i) => /Expand sidebar on hover/.test(i.textContent));
      item.querySelector('.tgl').click();
    });
    const peekAfterHover = async () => {
      await shell.evaluate(() => { if (!document.body.classList.contains('collapsed')) document.getElementById('toggle').click(); });
      await wait(400);
      await shell.dispatchEvent('#sidebar, aside, .sidebar', 'mouseleave').catch(() => {});
      await shell.evaluate(() => (document.querySelector('#sidebar') || document.querySelector('aside')).dispatchEvent(new MouseEvent('mouseenter')));
      await wait(450);
      return shell.evaluate(() => document.body.classList.contains('peek'));
    };
    await check('hovering the shrunk sidebar expands it (switch on, the default)', async () => assert.strictEqual(await peekAfterHover(), true));
    await hoverToggle(); await wait(600);
    await check('with the switch off, it stays shrunk', async () => assert.strictEqual(await peekAfterHover(), false));
    await hoverToggle(); await wait(600);
    await check('switched back on, hovering expands it again', async () => assert.strictEqual(await peekAfterHover(), true));
  } finally {
    await app.close().catch(() => {});
    gh.close();
  }
  if (failed) { console.log('UPDATE TEST FAILED'); process.exit(1); }
  console.log('ALL UPDATE TESTS PASS');
})().catch((e) => { console.error(e); process.exit(1); });
