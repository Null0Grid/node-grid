'use strict';
// End-to-end check: drives the real NODE_GRID app (via Playwright's Electron
// support) to confirm that toggling picture-in-picture docks the active
// tab's video into the sidebar's .tabspacer strip (instead of only ever
// opening a floating OS PiP window), that the dock can be restored or
// closed again, and that it falls back automatically when the sidebar is
// collapsed (no room to dock). Uses the fixture at
// tests/fixtures/pip-site/ (a tiny local video page) so it needs no network.
//
// Assertions are made only through externally-observable state: which
// .tab element carries the "active" class, and whether a pipdock.html-URL
// window (the tiny restore/close overlay) exists -- the same signals a
// person watching the real UI would see. No main-process debug hooks.
//
//   xvfb-run -a node tests/ui-pipdock.test.js
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const pw = require('playwright');

const APP_DIR = __dirname + '/..';
const electronPath = require(path.join(APP_DIR, 'node_modules', 'electron'));
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'pip-site');

function startFixtureSite() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      let filePath = url.pathname === '/' ? '/video.html' : url.pathname;
      filePath = path.join(FIXTURE_DIR, path.basename(filePath));
      fs.readFile(filePath, (err, data) => {
        if (err) { res.statusCode = 404; res.end('not found'); return; }
        if (filePath.endsWith('.mp4')) res.setHeader('Content-Type', 'video/mp4');
        else res.setHeader('Content-Type', 'text/html');
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
    const w = electronApp.windows().find((w) => { try { return pred(w); } catch { return false; } });
    if (w) return w;
    await wait(150);
  }
  return null;
}
async function waitForGone(electronApp, pred, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 8000)) {
    if (!electronApp.windows().find((w) => { try { return pred(w); } catch { return false; } })) return true;
    await wait(150);
  }
  return false;
}

const isDock = (w) => /pipdock\.html/.test(w.url());
const isVideoTab = (w) => /video\.html/.test(w.url());
const isShell = (w) => /shell\.html$/.test(w.url());

// Index of the .tab currently carrying the "active" class, within the shell window.
async function activeTabIndex(shell) {
  return shell.evaluate(() => {
    const tabs = [...document.querySelectorAll('#tabs .tab, .tabs .tab, ul.tabs li.tab')];
    return tabs.findIndex((t) => t.classList.contains('active'));
  });
}
async function tabCount(shell) {
  return shell.evaluate(() => document.querySelectorAll('#tabs .tab, .tabs .tab, ul.tabs li.tab').length);
}

(async () => {
  const siteServer = await startFixtureSite();
  const sitePort = siteServer.address().port;
  const userData = path.join(require('os').tmpdir(), 'node-grid-ci-pipdock-' + Date.now());

  const electronApp = await pw._electron.launch({
    args: [APP_DIR, '--user-data-dir=' + userData],
    executablePath: electronPath,
    env: { ...process.env, NODEGRID_TEST_PLAINTEXT_VAULT: '1' },
  });

  try {
    const shell = await waitForWindow(electronApp, isShell, 15000);
    assert.ok(shell, 'shell window should appear');
    await shell.waitForTimeout(800);

    // The shell renders its first tab asynchronously; poll briefly rather than
    // assuming a fixed sleep is always long enough (seen flake on a slow start).
    for (let i = 0; i < 20 && (await tabCount(shell)) < 1; i++) await shell.waitForTimeout(200);
    assert.strictEqual(await tabCount(shell), 1, 'should start with exactly one (home) tab');
    assert.strictEqual(await activeTabIndex(shell), 0, 'home tab should start active');

    // Open a second tab pointed at the fixture video page.
    await shell.evaluate(() => window.shell.newTab());
    await shell.waitForTimeout(300);
    await shell.evaluate((url) => window.shell.go(url), 'http://127.0.0.1:' + sitePort + '/video.html');

    const videoTab = await waitForWindow(electronApp, isVideoTab, 8000);
    assert.ok(videoTab, 'video fixture tab should load');
    await videoTab.waitForTimeout(1200); // let the <video> start playing so PiP sees it

    assert.strictEqual(await tabCount(shell), 2, 'should now have two tabs');
    assert.strictEqual(await activeTabIndex(shell), 1, 'new video tab should be active');

    const pipHidden = await shell.evaluate(() => document.getElementById('pipbtn').hidden);
    assert.strictEqual(pipHidden, false, 'pip button should be visible once a tab has video');

    const tsRect = await shell.evaluate(() => {
      const r = document.getElementById('tabspacer').getBoundingClientRect();
      return { width: r.width, height: r.height };
    });
    assert.ok(tsRect.width > 0 && tsRect.height > 0, 'tabspacer should have real room while sidebar is expanded');

    // --- dock ---
    await shell.click('#pipbtn');
    const dockOverlay1 = await waitForWindow(electronApp, isDock, 6000);
    assert.ok(dockOverlay1, 'pipdock controls overlay should appear after docking');
    await shell.waitForTimeout(300);
    assert.strictEqual(await activeTabIndex(shell), 0, 'docking should switch focus back to the home tab');
    const videoStillThere = await waitForWindow(electronApp, isVideoTab, 2000);
    assert.ok(videoStillThere, 'the docked tab itself should keep running, not be destroyed');

    // --- restore ---
    await dockOverlay1.click('#restore').catch(() => {});
    assert.ok(await waitForGone(electronApp, isDock, 5000), 'pipdock overlay should disappear after restore');
    await shell.waitForTimeout(300);
    assert.strictEqual(await activeTabIndex(shell), 1, 'restoring should bring the video tab back to the foreground');

    // --- dock again, then close (undock without switching focus) ---
    await shell.click('#pipbtn');
    const dockOverlay2 = await waitForWindow(electronApp, isDock, 6000);
    assert.ok(dockOverlay2, 'pipdock overlay should reappear on a second dock');
    await shell.waitForTimeout(300);
    assert.strictEqual(await activeTabIndex(shell), 0, 'home tab should be active again while docked');

    await dockOverlay2.click('#close').catch(() => {});
    assert.ok(await waitForGone(electronApp, isDock, 5000), 'pipdock overlay should disappear after close');
    await shell.waitForTimeout(300);
    assert.strictEqual(await activeTabIndex(shell), 0, 'closing the dock (not restoring) should leave the home tab active');

    // --- dock, then collapse the sidebar: should fall back automatically (no room to dock) ---
    // "close" (above) left the home tab active, not the video tab -- switch back to it first,
    // the same way a person would click the tab, before asking to pop it out again.
    await shell.evaluate(() => document.querySelectorAll('#tabs .tab')[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })));
    await shell.waitForTimeout(300);
    assert.strictEqual(await activeTabIndex(shell), 1, 'should be able to switch back to the video tab');
    await shell.click('#pipbtn');
    assert.ok(await waitForWindow(electronApp, isDock, 6000), 'pipdock overlay should appear on a third dock');
    await shell.click('#toggle'); // collapse sidebar
    assert.ok(await waitForGone(electronApp, isDock, 6000), 'collapsing the sidebar should drop the dock overlay (falls back to floating PiP)');
    await shell.waitForTimeout(300);
    const tsRectCollapsed = await shell.evaluate(() => {
      const r = document.getElementById('tabspacer').getBoundingClientRect();
      return { width: r.width, height: r.height };
    });
    assert.ok(tsRectCollapsed.width < tsRect.width || tsRectCollapsed.height < tsRect.height, 'tabspacer should shrink once collapsed');

    console.log('[pass] docking switches focus to the remaining tab and keeps the docked tab alive');
    console.log('[pass] restore brings the docked tab back to the foreground and drops the overlay');
    console.log('[pass] close drops the overlay without switching focus');
    console.log('[pass] collapsing the sidebar (no room) automatically falls back, dropping the overlay');
    console.log('ALL UI PIPDOCK TESTS PASS');
  } finally {
    await electronApp.close().catch(() => {});
    siteServer.close();
  }
})().catch((err) => {
  console.error('FAIL:', err.message);
  process.exitCode = 1;
});
