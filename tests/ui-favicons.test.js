'use strict';
// End-to-end check of site icons in the sidebar, through the real app. Stand-in
// sites serve their icons in different ways: PNG and SVG, same site and a
// separate asset site, icons swapped by script after load (GitHub does this),
// and icons sent with Cross-Origin-Resource-Policy: same-origin / same-site
// (GitHub's asset site does this too), which the sidebar couldn't load before
// NODE_GRID started fetching icons itself. Every one must show its icon; a page
// with no icon shows the placeholder.
//
//   xvfb-run -a node tests/ui-favicons.test.js
const assert = require('assert');
const path = require('path'), http = require('http'), os = require('os');
const APP = __dirname + '/..';
const pw = require('playwright');
const electronPath = require(path.join(APP, 'node_modules', 'electron'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGElEQVR42mP8z8DwnwEJMMIYGRkYGBgAAH0EB/2y2b4AAAAASUVORK5CYII=', 'base64');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><style>.a{fill:#24292f}@media (prefers-color-scheme:dark){.a{fill:#f0f6fc}}</style><circle class="a" cx="8" cy="8" r="7"/></svg>';
(async () => {
  // asset server on a second origin, like github.githubassets.com
  const assets = http.createServer((q, r) => {
    const u = new URL(q.url, 'http://x');
    if (u.searchParams.get('corp')) r.setHeader('Cross-Origin-Resource-Policy', u.searchParams.get('corp'));
    if (u.pathname.endsWith('.svg')) { r.setHeader('Content-Type', 'image/svg+xml'); r.end(SVG); } else { r.setHeader('Content-Type', 'image/png'); r.end(PNG); }
  }); await new Promise((r) => assets.listen(0, '127.0.0.1', r));
  const A = 'http://127.0.0.1:' + assets.address().port;
  const pages = {
    '/png-same': '<link rel="icon" href="/f.png">',
    '/svg-same': '<link rel="icon" type="image/svg+xml" href="/f.svg">',
    '/svg-other': `<link rel="icon" type="image/svg+xml" href="${A}/f.svg">`,
    '/svg-corp-sameorigin': `<link rel="icon" type="image/svg+xml" href="${A}/f.svg?corp=same-origin">`,
    '/svg-corp-samesite': `<link rel="icon" type="image/svg+xml" href="${A}/f.svg?corp=same-site">`,
    '/no-icon': '',
    '/slow-icon': '<link rel="icon" href="/slow.png">',
    '/github-like': `<link rel="alternate icon" class="js-site-favicon" type="image/png" href="${A}/favicon.png"><link rel="icon" class="js-site-favicon" type="image/svg+xml" href="${A}/favicon.svg"><script>setTimeout(()=>{document.querySelectorAll('.js-site-favicon').forEach(l=>{l.href=l.href.replace('favicon','favicon-dark')})},400)</script>`,
  };
  const site = http.createServer((q, r) => {
    if (q.url === '/slow.png') { setTimeout(() => { r.setHeader('Content-Type', 'image/png'); r.end(PNG); }, 2500); return; }
    if (q.url.startsWith('/f.')) { r.setHeader('Content-Type', q.url.endsWith('.svg') ? 'image/svg+xml' : 'image/png'); return r.end(q.url.endsWith('.svg') ? SVG : PNG); }
    r.setHeader('Content-Type', 'text/html'); r.end('<!doctype html><title>' + q.url + '</title>' + (pages[q.url] || '') + '<body>' + q.url);
  }); await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const B = 'http://127.0.0.1:' + site.address().port;
  const app = await pw._electron.launch({ args: [APP, '--user-data-dir=' + path.join(os.tmpdir(), 'ng-fav-' + Date.now())], executablePath: electronPath, env: { ...process.env, NODEGRID_TEST_PLAINTEXT_VAULT: '1', NODEGRID_UPDATE_URL: 'http://127.0.0.1:1/', NODEGRID_SKIP_INTRO: '1' } });
  let shell; for (let i = 0; i < 80 && !shell; i++) { shell = app.windows().find((w) => /shell\.html$/.test(w.url())); await wait(150); }
  await wait(800);
  for (const p of Object.keys(pages).filter((k) => k !== '/slow-icon')) { await shell.evaluate(() => window.shell.newTab()); await wait(250); await shell.evaluate((u) => window.shell.go(u), B + p); await wait(700); }
  // a local page with a local icon (the start page works like this)
  const fs = require('fs'); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-fav-file-'));
  fs.writeFileSync(path.join(dir, 'icon.svg'), SVG);
  fs.writeFileSync(path.join(dir, 'local.html'), '<!doctype html><title>/local-file</title><link rel="icon" href="icon.svg"><body>local');
  // opened the way a double-clicked .html file is (typed file:// addresses are searched, on purpose)
  await app.evaluate(({ app: a }, f) => a.emit('second-instance', {}, ['node-grid', f], '/'), path.join(dir, 'local.html')); await wait(1200);
  // stale icon: the slow page's icon arrives after the tab has moved on to a page with no icon
  await shell.evaluate(() => window.shell.newTab()); await wait(250);
  await shell.evaluate((u) => window.shell.go(u), B + '/slow-icon'); await wait(900);
  await shell.evaluate((u) => window.shell.go(u), B + '/no-icon?after-slow');
  await wait(4000);
  const res = await shell.evaluate(() => [...document.querySelectorAll('#tabs .tab')].map((t) => {
    const img = t.querySelector('.fav img');
    return { title: t.querySelector('.title').textContent, shows: img ? (img.complete && img.naturalWidth > 0 ? 'icon' : 'broken') : (t.querySelector('.dot') ? 'placeholder' : '?'), src: img ? img.src.replace(/http:\/\/127\.0\.0\.1:\d+/, '') : '' };
  }));
  let failed = false;
  for (const p of Object.keys(pages).filter((k) => k !== '/slow-icon')) {
    const r = res.find((x) => x.title === p);
    const want = p === '/no-icon' ? 'placeholder' : 'icon';
    const ok = r && r.shows === want;
    if (!ok) failed = true;
    console.log((ok ? '[pass] ' : '[FAIL] ') + p + ' shows ' + (r ? r.shows : 'nothing') + (want === 'icon' ? '' : ' (expected)'));
  }
  const loc = res.find((x) => x.title === '/local-file');
  const locOk = loc && loc.shows === 'icon';
  if (!locOk) failed = true;
  console.log((locOk ? '[pass] ' : '[FAIL] ') + 'a local file:// page shows its local icon (' + (loc ? loc.shows : 'nothing') + ')');
  const moved = res.find((x) => x.title === '/no-icon?after-slow');
  const movedOk = moved && moved.shows === 'placeholder';
  if (!movedOk) failed = true;
  console.log((movedOk ? '[pass] ' : '[FAIL] ') + "a slow icon from the previous page doesn't replace the new page's icon (" + (moved ? moved.shows : 'nothing') + ')');
  const gh = res.find((x) => x.title === '/github-like');
  const ghOk = gh && gh.shows === 'icon' && gh.src.startsWith('data:image/');
  if (!ghOk) failed = true;
  console.log((ghOk ? '[pass] ' : '[FAIL] ') + 'icons reach the sidebar as data: URLs (the sidebar never contacts the site)');
  await app.close(); site.close(); assets.close();
  if (failed) { console.log('FAVICON TEST FAILED'); process.exit(1); }
  console.log('ALL FAVICON TESTS PASS');
})().catch((e) => { console.error(e); process.exit(1); });
