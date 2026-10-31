'use strict';
// End-to-end check of YouTube radio stations, through the real app:
//   1. adding a YouTube link as a station shows the radio panel's video box
//   2. the YouTube player really is drawn inside that box (the box's middle
//      pixel on screen is the test video's red), it's at least 200x200
//      (YouTube's minimum for embedded players), and it plays
//   3. minimising the player pauses it (YouTube's terms: no hidden player)
//   4. showing the player again carries on playing
// NULLGRID_YT_EMBED points the player at a local stand-in for YouTube's embed
// page (a short red video), so no network is needed. Needs an X display
// (xvfb-run) and ImageMagick's `import` for the on-screen pixel check.
// Set YT_SHOTS=<dir> to also save a screenshot of the playing player.
//
//   xvfb-run -a -s "-screen 0 1400x900x24" node tests/ui-ytradio.test.js
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const pw = require('playwright');

const APP_DIR = __dirname + '/..';
const electronPath = require(path.join(APP_DIR, 'node_modules', 'electron'));
const VIDEO = path.join(__dirname, 'fixtures', 'pip-site', 'red.mp4');
const SHOTS = process.env.YT_SHOTS || '';

function startFakeYouTube() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/red.mp4')) { res.setHeader('Content-Type', 'video/mp4'); return fs.createReadStream(VIDEO).pipe(res); }
      res.setHeader('Content-Type', 'text/html');
      // laid out like YouTube's own player: a 16:9 video letterboxed in the middle of
      // the box, with black above and below (Null Grid stretches it to fill the box)
      res.end('<!doctype html><title>fake-yt</title><style>html,body{margin:0;height:100%;overflow:hidden;background:#000}</style>'
        + '<div id="player" style="width:100%;height:100%"><div class="html5-video-player" style="position:relative;width:100%;height:100%;background:#000"><div class="html5-video-container">'
        + '<video class="html5-main-video" style="position:absolute;width:100%;height:56%;left:0;top:22%;object-fit:contain" src="/red.mp4" autoplay loop playsinline></video></div></div></div>');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { try { const v = await fn(); if (v) return v; } catch {} await wait(200); }
  return null;
}
// Colour of one on-screen pixel (root window), as [r, g, b] 0-255.
function screenPixel(x, y) {
  const file = path.join(os.tmpdir(), 'ng-yt-px-' + Date.now() + '.png');
  execFileSync('import', ['-window', 'root', '-crop', `1x1+${Math.round(x)}+${Math.round(y)}`, file]);
  const out = execFileSync('convert', [file, '-format', '%[fx:int(255*r)],%[fx:int(255*g)],%[fx:int(255*b)]', 'info:']).toString();
  fs.unlinkSync(file);
  return out.split(',').map(Number);
}

(async () => {
  const yt = await startFakeYouTube();
  const base = 'http://127.0.0.1:' + yt.address().port;
  const app = await pw._electron.launch({
    args: [APP_DIR, '--user-data-dir=' + path.join(os.tmpdir(), 'null-grid-ci-yt-' + Date.now())],
    executablePath: electronPath,
    env: { ...process.env, NULLGRID_TEST_PLAINTEXT_VAULT: '1', NULLGRID_SKIP_INTRO: '1', NULLGRID_YT_EMBED: base + '/embed/' },
  });
  let failed = false;
  const check = async (label, fn) => { try { await fn(); console.log('[pass] ' + label); } catch (e) { failed = true; console.log('[FAIL] ' + label + ': ' + e.message); } };
  try {
    const shell = await waitFor(() => app.windows().find((w) => /shell\.html$/.test(w.url())), 15000);
    assert.ok(shell, 'shell window should appear');
    await wait(1000);
    if (await shell.evaluate(() => document.body.classList.contains('pl-min'))) await shell.click('#plmin');

    // Add a YouTube link as a station, the way a person would.
    await shell.evaluate(() => { document.getElementById('pladd').hidden = false; });
    await shell.fill('#pladdname', 'Test stream');
    await shell.fill('#pladdurl', 'https://youtu.be/testVideo01');
    await shell.click('#pladd button[type=submit]');

    const player = await waitFor(() => app.windows().find((w) => w.url().startsWith(base + '/embed/testVideo01')), 10000);
    await check('the YouTube player loads', () => assert.ok(player));
    await check('the radio panel shows its video box', async () => assert.strictEqual(await shell.evaluate(() => document.getElementById('plvideo').hidden), false));
    const playing = () => player.evaluate(() => { const v = document.querySelector('video'); return v && !v.paused && v.currentTime > 0; });
    await check('it plays while the box is showing', async () => assert.ok(await waitFor(playing, 8000)));

    await wait(1200);
    const box = await shell.evaluate(() => { const r = document.getElementById('plvideo').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    const content = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentBounds());
    const px = screenPixel(content.x + box.x + box.w / 2, content.y + box.y + box.h / 2);
    console.log('  box', JSON.stringify(box), 'centre pixel', px.join(','));
    await check('the box is at least 200x200 (YouTube minimum)', () => assert.ok(box.w >= 200 && box.h >= 200, JSON.stringify(box)));
    const edges = [screenPixel(content.x + box.x + box.w / 2, content.y + box.y + 10), screenPixel(content.x + box.x + box.w / 2, content.y + box.y + box.h - 10)];
    console.log('  top/bottom edge pixels', edges.map((p) => p.join(',')).join(' / '));
    await check('the video fills the whole box: no black bars at the top or bottom', () => assert.ok(edges.every((p) => p[0] > 150 && p[1] < 90 && p[2] < 90), 'got ' + edges.join(' / ')));
    await check('the player is drawn inside the box (centre pixel is the red video)', () => assert.ok(px[0] > 150 && px[1] < 90 && px[2] < 90, 'got ' + px));
    if (SHOTS) execFileSync('import', ['-window', 'root', path.join(SHOTS, 'yt-radio-player.png')]);

    await shell.click('#plmin');                       // minimise the player
    await check('minimising the player pauses YouTube', async () => assert.ok(await waitFor(async () => !(await playing()), 5000)));

    await shell.click('#plmin');                       // show it again
    await check('showing the player again carries on playing', async () => assert.ok(await waitFor(playing, 6000)));
  } finally {
    await app.close().catch(() => {});
    yt.close();
  }
  if (failed) { console.log('YOUTUBE RADIO TEST FAILED'); process.exit(1); }
  console.log('ALL YOUTUBE RADIO TESTS PASS');
})().catch((e) => { console.error(e); process.exit(1); });
