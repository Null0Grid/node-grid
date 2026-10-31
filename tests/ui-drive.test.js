'use strict';
// End-to-end check: drives the real Null Grid app (via Playwright's
// Electron support) against the real null-drive.js and tab-preload.js
// bridge, with the test fixture at tests/fixtures/search-site/ standing in
// for the real Null Search results page (that page lives in a different
// repo). Linux only in CI (run under xvfb-run); needs a display locally too.
//
//   xvfb-run -a node tests/ui-drive.test.js
'use strict';
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const pw = require('playwright');
const { startMockDrive } = require('../tools/mock-drive');

const APP_DIR = __dirname + '/..';
const electronPath = require(path.join(APP_DIR, 'node_modules', 'electron'));
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'search-site');

function startFixtureSite() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      let filePath = url.pathname === '/' ? '/results.html' : url.pathname;
      filePath = path.join(FIXTURE_DIR, path.basename(filePath));
      fs.readFile(filePath, (err, data) => {
        if (err) { res.statusCode = 404; res.end('not found'); return; }
        res.setHeader('Content-Type', 'text/html');
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitForWindow(electronApp, pred, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 10000)) {
    const w = electronApp.windows().find(pred);
    if (w) return w;
    await wait(150);
  }
  throw new Error('window not found within timeout');
}

async function runScenario(label, mode, tokenValue) {
  const driveServer = await startMockDrive({ mode });
  const drivePort = driveServer.address().port;
  const siteServer = await startFixtureSite();
  const sitePort = siteServer.address().port;
  const userData = path.join(require('os').tmpdir(), 'null-grid-ci-' + label + '-' + Date.now());

  const electronApp = await pw._electron.launch({
    args: [APP_DIR, '--user-data-dir=' + userData],
    executablePath: electronPath,
    env: {
      ...process.env,
      NULLGRID_SEARCH: 'http://127.0.0.1:' + sitePort,
      NULLGRID_TEST_PLAINTEXT_VAULT: '1', NULLGRID_SKIP_INTRO: '1', // Linux CI has no OS keychain
    },
  });

  try {
    const shell = await electronApp.firstWindow();
    await shell.waitForTimeout(800);
    const home = await waitForWindow(electronApp, (w) => w.url().includes('/home/index.html'));
    await home.waitForTimeout(400);

    await shell.click('#setbtn');
    const settings = await waitForWindow(electronApp, (w) => w.url().includes('settings.html'));
    await settings.waitForTimeout(800);
    const driveForm = settings.locator('#drive form.dform');
    await driveForm.locator('input').first().fill('127.0.0.1:' + drivePort);
    await driveForm.locator('input').nth(1).fill(tokenValue);
    await driveForm.locator('button.primary').click();
    await wait(1200);

    const statusText = (await settings.locator('#drive .dstat span').nth(1).textContent()).trim();

    await home.goto('http://127.0.0.1:' + sitePort + '/results.html?q=checklist');
    await wait(1000);
    const driveStatusText = (await home.locator('#driveStatus').textContent()).trim();
    const driveCards = await home.locator('.result.drive').count();

    let afterView = '', afterDownload = '';
    if (driveCards > 0) {
      await home.locator('.result.drive').first().click();
      await wait(800);
      afterView = (await home.locator('#driveStatus').textContent()).trim();

      await home.locator('.result.drive [data-drive-download]').first().click();
      await wait(800);
      afterDownload = (await home.locator('#driveStatus').textContent()).trim();
    }

    return { statusText, driveStatusText, driveCards, afterView, afterDownload };
  } finally {
    await electronApp.close();
    driveServer.close();
    siteServer.close();
  }
}

(async () => {
  try {
    const normal = await runScenario('normal', 'normal', 'everything_tok');
    assert.strictEqual(normal.statusText, 'Connected as luke', 'normal: Settings status, got ' + JSON.stringify(normal.statusText));
    assert.strictEqual(normal.driveCards, 1, 'normal: expected 1 Drive result');
    assert.match(normal.afterDownload, /saved .* to Downloads/i, 'normal: download should report success, got ' + JSON.stringify(normal.afterDownload));
    console.log('[pass] normal account, live UI: connected, 1 Drive result, download succeeds');

    const encrypted = await runScenario('encrypted', 'encrypted', 'everything_tok');
    assert.match(encrypted.statusText, /end-to-end encrypted/, 'encrypted: Settings status, got ' + JSON.stringify(encrypted.statusText));
    assert.strictEqual(encrypted.driveCards, 0, 'encrypted: expected 0 Drive results');
    assert.match(encrypted.driveStatusText, /end-to-end encrypted/, 'encrypted: #driveStatus should explain why, got ' + JSON.stringify(encrypted.driveStatusText));
    console.log('[pass] encrypted account, live UI: "encrypted, search off" shown, not "no results"');

    const scope = await runScenario('scope', 'scope', 'search_only_tok');
    assert.strictEqual(scope.driveCards, 1, 'scope: search should still return a result');
    assert.match(scope.afterView, /can only search/i, 'scope: view should explain insufficient_scope, got ' + JSON.stringify(scope.afterView));
    assert.match(scope.afterDownload, /can only search/i, 'scope: download should explain insufficient_scope, got ' + JSON.stringify(scope.afterDownload));
    console.log('[pass] search-only token, live UI: view+download both explain the scope restriction');

    console.log('ALL UI DRIVE TESTS PASS');
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exitCode = 1;
  }
})();
