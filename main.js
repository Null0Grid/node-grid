// NODE_GRID browser shell — main process
// Window chrome only: vertical tab sidebar, back / reload / home.
// Pages render in WebContentsViews; the shell UI (shell.html) draws everything around them.

const { app, BrowserWindow, WebContentsView, ipcMain, Menu, clipboard, nativeTheme, session, safeStorage, shell: eshell, protocol, net, dialog } = require('electron');
const crypto = require('crypto');
const path = require('path');
const { pathToFileURL } = require('url');

// Built-in error page (shown when a page can't load, or a server returns a blank error)
const ERROR_PAGE = pathToFileURL(path.join(__dirname, 'error.html')).href;
const isErrorPage = (u) => typeof u === 'string' && u.startsWith(ERROR_PAGE);

// Dark native menus (right-click menus) to match the shell.
nativeTheme.themeSource = 'dark';

// The start page ships inside the app (home/index.html), so Home opens instantly and
// offline. Searches still go to the NODE_GRID server for results.
const SEARCH_ORIGIN = (process.env.NODEGRID_SEARCH || 'https://search.nullgrid.dev').replace(/\/$/, '');
const HOME_FILE = pathToFileURL(path.join(__dirname, 'home', 'index.html')).href;
const APP_VERSION = require('./package.json').version;    // shown in the start page footer
const HOME = process.env.NODEGRID_HOME ||
  HOME_FILE + '?v=' + encodeURIComponent(APP_VERSION) +
  (process.env.NODEGRID_SEARCH ? '&search=' + encodeURIComponent(SEARCH_ORIGIN) : '');

// NODE_GRID SIM (Freedoom on doomgeneric) ships inside the app and is served from
// nodegrid://doom/ so the game can fetch its own files (file:// pages can't).
// It runs in its own small saved storage so game saves survive a restart; nothing
// else ever loads there.
protocol.registerSchemesAsPrivileged([
  { scheme: 'nodegrid', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);
const SIM_PARTITION = 'persist:nodegrid-sim';
const SIM_URL = 'nodegrid://doom/index.html';
const isSimUrl = (u) => /^nodegrid:\/\/doom(\/|$)/i.test(u || '');

// Only one copy at a time: clicking the taskbar icon again focuses the open window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

// No "persist:" prefix = in-memory session. History, cookies, cache and storage
// live in RAM only and vanish when the app closes. Nothing is written to disk.
const PARTITION = 'nullgrid-ephemeral';

let win = null;
let tabs = [];          // { id, view, title, favicon, loading, url }
let activeId = null;
let nextId = 1;
let viewport = { x: 0, y: 0, width: 800, height: 600 };

// ---------- window ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 400,
    backgroundColor: '#0a0a0f',
    icon: path.join(__dirname, 'icon.png'),
    titleBarStyle: 'hidden',              // our toolbar is the title bar
    titleBarOverlay: process.platform === 'darwin' ? undefined : {
      color: '#0a0a0f',
      symbolColor: '#00e5ff',
      height: 40                          // keep in sync with --bar-h in shell.css
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true
    }
  });

  win.loadFile('shell.html');
  win.webContents.on('before-input-event', handleKeys);
  win.webContents.once('did-finish-load', () => {
    if (featureOn('pinned')) for (const u of (settings.pinned || []).filter((x) => /^https?:\/\//i.test(x)).slice(0, 20)) newTab(u, { pinned: true });
    newTab(HOME);
  });

  // Mouse side button "back" (Windows)
  win.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward') back();
    if (cmd === 'browser-forward') forward();
    if (cmd === 'browser-refresh') reload();
    if (cmd === 'browser-home') home();
  });

  win.on('closed', () => { win = null; tabs = []; });
  // Coming back to the window: keyboard goes to the page, not the sidebar/toolbar
  win.on('focus', () => setTimeout(() => {
    if (!win || win.isDestroyed() || peekUI) return;
    if (win.webContents.isFocused()) {
      win.webContents.executeJavaScript('!!(document.activeElement && document.activeElement.matches("input, textarea"))')
        .then((typing) => { if (!typing) focusPage(); }).catch(() => {});
    }
  }, 0));
}

// ---------- tabs ----------

function getTab(id) { return tabs.find(t => t.id === id); }
function activeTab() { return getTab(activeId); }

// PEEK: a tab that shows a site's HTML + CSS with all JavaScript switched off.
// Separate in-memory storage, no history entry. (Server code like Python/PHP always
// runs on the site's server; what Peek blocks is everything that would run here.)
const PEEK_PARTITION = 'nullgrid-peek';

function newTab(url = HOME, opts = {}) {
  const peek = !!opts.peek;
  const sim = !peek && (!!opts.sim || isSimUrl(url));
  const burner = !peek && !sim && opts.burner ? opts.burner : null;     // { part } of its burner group
  const settingsTab = !peek && !sim && !burner && url === SETTINGS_PAGE;
  const view = new WebContentsView({
    webPreferences: settingsTab ? {
      partition: PARTITION, contextIsolation: true, sandbox: true,
      preload: path.join(__dirname, 'settings-preload.js')
    } : burner ? {
      partition: burner.part,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'tab-preload.js')
    } : sim ? {
      partition: SIM_PARTITION,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'tab-preload.js')
    } : peek ? {
      partition: PEEK_PARTITION,
      javascript: false,          // no scripts at all
      webgl: false,
      contextIsolation: true,
      sandbox: true
    } : {
      partition: PARTITION,
      contextIsolation: true,
      sandbox: true,
      // Only tells the shell "the mouse is over the page" so a peeked sidebar can
      // collapse. Exposes nothing to websites.
      preload: path.join(__dirname, 'tab-preload.js')
    }
  });
  view.setBackgroundColor('#0a0a0f');
  view.setBounds(viewport);
  win.contentView.addChildView(view);

  let title = 'New Tab';
  if (url.startsWith('view-source:')) { try { title = 'Source: ' + new URL(url.slice(12)).host; } catch {} }
  const tab = { id: nextId++, view, title, favicon: null, loading: true, url, peek, sim, burner, settingsTab, lastActive: Date.now(), pinned: !!opts.pinned };
  tabs.push(tab);

  const wc = view.webContents;

  // Links with target=_blank / window.open become tabs instead of new windows
  wc.setWindowOpenHandler(({ url }) => { newTab(url, { peek, burner }); return { action: 'deny' }; });   // burner links stay burner

  wc.on('page-title-updated', (_e, title) => { if (tab.sleeping) return; tab.title = title; pushState(); });
  wc.on('page-favicon-updated', (_e, icons) => {
    if (tab.sleeping) return;
    tab.favicon = icons[0] || null;
    const f = findFav(tab.url);
    if (f && tab.favicon && f.favicon !== tab.favicon) { f.favicon = tab.favicon; saveFavs(); }
    pushState();
  });
  wc.on('did-start-loading', () => { if (tab.sleeping) return; tab.loading = true; pushState(); });
  wc.on('did-stop-loading', () => {
    if (tab.sleeping) return;
    tab.loading = false;
    const u = wc.getURL();
    tab.url = isErrorPage(u) || (peek && u.startsWith('data:text/html')) ? tab.errorUrl : isReaderPage(u) ? (tab.readerUrl || tab.url) : u;
    pushState();
  });
  wc.on('did-start-navigation', (_e, u, inPage, isMainFrame) => {
    if (isMainFrame && !inPage) { blockedByTab.delete(wc.id); trails.set(wc.id, freshTrail()); trailChanged(wc.id); tab.readerable = false; tab.hasVideo = false; }
  });
  wc.on('found-in-page', (_e, r) => {
    if (tab.id === activeId && win && !win.isDestroyed()) win.webContents.send('find-result', { active: r.activeMatchOrdinal, total: r.matches });
  });
  // ---------- 9. a crashed tab gets the error page (with a robot sweeping up) ----------
  wc.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || wc.isDestroyed()) return;
    const url = isErrorPage(wc.getURL()) ? tab.errorUrl : (tab.url || wc.getURL());
    tab.loading = false;
    setTimeout(() => { if (!wc.isDestroyed()) showError(tab, { url, kind: 'crash', code: details.exitCode || 0, desc: details.reason }); }, 50);
  });
  wc.on('did-navigate', (_e, u, status, statusText) => {
    if (tab.sleeping) return;
    if (tab.waking) { tab.waking = false; dropBlankEntries(wc); }   // woke up: no history visit, no blank entry left behind
    else tab.lastNavRecorded = true;
    tab.favicon = null;
    if (peek && u.startsWith('data:text/html')) { tab.url = tab.errorUrl; pushState(); return; }
    if (isReaderPage(u)) {
      tab.reader = true; tab.url = tab.readerUrl || tab.url;   // reader view shows the article's own address
      pushState(); return;
    }
    tab.reader = false;
    if (isErrorPage(u)) {
      tab.url = tab.errorUrl;                 // keep showing the address that failed
      dropFailedEntry(wc, tab.errorUrl);
    } else {
      tab.url = u;
      tab.pendingHttp = status >= 400 ? { url: u, code: status, desc: statusText } : null;
      if (status > 0 && !peek && !burner && tab.lastNavRecorded) recordVisit(u);     // Peek + burner visits stay out of history
      tab.lastNavRecorded = false;
    }
    pushState();
  });

  // Couldn't load at all: DNS failure, offline, refused, timeout, bad certificate...
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (tab.sleeping) return;
    if (!isMainFrame || code === -3 || isErrorPage(url)) return;   // -3 = aborted (Stop, or navigated away)
    if (peek) { tab.errorUrl = url; return peekError(wc, url, code, desc); }   // the scripted error page can't run here
    showError(tab, { url, kind: 'net', code, desc });
  });

  // Server answered 4xx/5xx: only replace it if the server sent a blank page.
  // Sites with their own designed 404 page keep theirs, like in any browser.
  wc.on('did-finish-load', async () => {
    const p = tab.pendingHttp;
    if (!p || peek) return;
    tab.pendingHttp = null;
    const len = await wc.executeJavaScript('document.body ? document.body.innerText.trim().length : 0').catch(() => 999);
    if (len < 20 && wc.getURL() === p.url) showError(tab, { url: p.url, kind: 'http', code: p.code, desc: p.desc });
  });
  wc.on('did-navigate-in-page', (_e, u) => { tab.url = u; pushState(); });
  wc.on('did-start-navigation', (_e, _u, inPage, isMainFrame) => { if (isMainFrame && !inPage) { tab.darkKeys = []; tab.darkGen = (tab.darkGen || 0) + 1; } });   // new page = no CSS yet
  wc.on('dom-ready', () => applyDark(tab));
  wc.on('did-finish-load', () => { if (!tab.sleeping) checkReaderable(tab); });
  // music player: remember which tab is playing sound
  wc.on('media-started-playing', () => {
    wc.executeJavaScript('!!document.querySelector("video")').then((v) => { if (v !== tab.hasVideo) { tab.hasVideo = v; pushState(); } }).catch(() => {});
    tab.mediaPlaying = true; mediaTabId = tab.id; readMediaMeta(tab); win.webContents.send('media-started'); pushState(); });
  wc.on('media-paused', () => { tab.mediaPlaying = false; pushState(); });
  wc.on('page-title-updated', () => { if (tab.id === mediaTabId) readMediaMeta(tab); });
  // The game needs Ctrl (fire), Alt (strafe), W, Tab... so app shortcuts are off in its tab.
  if (!sim) wc.on('before-input-event', handleKeys);
  else wc.on('will-navigate', (e, u) => { if (!isSimUrl(u)) { e.preventDefault(); newTab(u); } });   // the web never loads in the sim's storage
  wc.on('context-menu', (_e, params) => pageMenu(tab, params));

  wc.loadURL(url);
  activate(tab.id);
  return tab;
}

// Switching tabs = bring that page to the front. Every tab stays painted underneath,
// so there is nothing to hide, re-show or repaint and the switch is instant.
// (Re-adding an existing child view moves it to the top of the stack.)
function activate(id) {
  const next = getTab(id);
  if (!next) return;
  if (peekUI) closePeek();
  setTimeout(raiseOverlays, 0);                        // keep popups + pixel above the newly front tab
  if (overlays.vault) setTimeout(sendVault, 0);
  if (overlays.recon) dropOverlay('recon');                 // recon describes one page; switching tabs closes it
  if (overlays.qr) dropOverlay('qr');
  setTimeout(sendTrail, 0);
  const prev = getTab(activeId);
  if (prev) prev.lastActive = Date.now();
  activeId = id;
  next.lastActive = Date.now();
  if (next.sleeping) wakeTab(next);
  next.view.setBounds(tabBounds(next));
  win.contentView.addChildView(next.view);
  next.view.webContents.focus();
  pushState();
}

function closeTab(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  const [tab] = tabs.splice(idx, 1);
  if (tab.pinned) setTimeout(savePins, 0);
  win.contentView.removeChildView(tab.view);
  trails.delete(tab.view.webContents.id);
  tab.view.webContents.close();
  if (tab.burner && !tabs.some((t) => t.burner && t.burner.part === tab.burner.part)) burnGroup(tab.burner.part, false);

  if (tabs.length === 0) { newTab(HOME); return; }   // never leave the window empty
  if (id === activeId) activate(tabs[Math.min(idx, tabs.length - 1)].id);
  else pushState();
}

function peekError(wc, url, code, desc) {
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const html = `<!doctype html><meta charset="utf-8"><title>Peek failed</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#0a0a0f;color:#b8c7d9;font:18px Consolas,monospace">
<div style="max-width:560px;padding:24px"><div style="color:#ffb000;letter-spacing:2px;font-size:12px">NODE_GRID :: PEEK</div>
<h1 style="color:#00e5ff;font-weight:normal;margin:10px 0">Couldn't load this page</h1>
<p style="border-left:2px solid #ff2e88;padding:8px 12px;background:#10131b;overflow-wrap:anywhere">${esc(url)}<br><span style="color:#5a6b80">${esc(desc || 'ERROR')} (${esc(code)})</span></p></div></body>`;
  wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

function showError(tab, { url, kind, code, desc }) {
  tab.errorUrl = url;
  const q = new URLSearchParams({ url, kind, code: String(code), desc: desc || '', home: HOME });
  const ce = certErrors.get(tab.view.webContents.id);
  if (code <= -200 && code > -300 && ce && ce.url === url && certTrustable(ce.host)) q.set('trust', '1');   // own device: offer "Proceed anyway"
  tab.view.webContents.loadURL(ERROR_PAGE + '?' + q.toString());
}

// Remove the broken entry sitting right behind the error page, so Back goes
// straight to the last page that worked instead of failing again.
function dropFailedEntry(wc, failedUrl) {
  const h = wc.navigationHistory;
  if (!h || !h.removeEntryAtIndex) return;
  const i = h.getActiveIndex();
  if (i < 1) return;
  const prev = h.getAllEntries()[i - 1];
  if (prev && (prev.url === failedUrl || prev.url.startsWith('chrome-error://'))) h.removeEntryAtIndex(i - 1);
}

function cycle(dir) {
  if (tabs.length < 2) return;
  const idx = tabs.findIndex(t => t.id === activeId);
  activate(tabs[(idx + dir + tabs.length) % tabs.length].id);
}

// ---------- navigation ----------

function canGoBack(wc) {
  return wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack();
}

function back() {
  const t = activeTab(); if (!t) return;
  const wc = t.view.webContents;
  if (!canGoBack(wc)) return;
  wc.navigationHistory ? wc.navigationHistory.goBack() : wc.goBack();
}

function canGoForward(wc) {
  return wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward();
}

function forward() {
  const t = activeTab(); if (!t) return;
  const wc = t.view.webContents;
  if (!canGoForward(wc)) return;
  wc.navigationHistory ? wc.navigationHistory.goForward() : wc.goForward();
}

function reload() {
  const t = activeTab(); if (!t) return;
  const wc = t.view.webContents;
  if (wc.isLoading()) wc.stop();
  else if (isErrorPage(wc.getURL()) && t.errorUrl) wc.executeJavaScript(`location.replace(${JSON.stringify(t.errorUrl)})`);  // retry the real address
  else wc.reload();
}

// Load a page in a tab. The sim tab only ever shows the sim: anything else opens in a normal tab.
function loadInTab(t, url) {
  if (url === SETTINGS_PAGE) return openSettings();
  if (t && t.settingsTab) return newTab(url);                 // the settings tab only shows settings
  if (!t) return newTab(url);
  if (t.sim && !isSimUrl(url)) return newTab(url);
  if (!t.sim && isSimUrl(url)) return openSim();
  t.view.webContents.loadURL(url).catch(() => {});
}

function home() {
  const t = activeTab(); if (t) loadInTab(t, HOME);
}

// ---------- favorites ----------
// The one thing the app keeps on disk: pages you starred on purpose.
// Saved as JSON in the app's own folder; browsing history is still never stored.
const fs = require('fs');
let favs = [];            // { id, url, title, favicon }
let favFile = null;
let nextFavId = 1;

const normUrl = (u) => { try { const x = new URL(u); x.hash = ''; return x.href.replace(/\/$/, ''); } catch { return u || ''; } };
const findFav = (u) => favs.find((f) => normUrl(f.url) === normUrl(u));
const favById = (id) => favs.find((f) => f.id === id);
const starrable = (u) => /^https?:\/\//i.test(u || '');

function loadFavs() {
  favFile = process.env.NODEGRID_FAVS || path.join(app.getPath('userData'), 'favorites.json');
  try {
    const data = JSON.parse(fs.readFileSync(favFile, 'utf8'));
    if (Array.isArray(data)) favs = data.filter((f) => f && starrable(f.url)).map((f) => ({ id: nextFavId++, url: f.url, title: String(f.title || f.url), favicon: f.favicon || null }));
  } catch { favs = []; }
}

function saveFavs() {
  try {
    const tmp = favFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(favs.map(({ url, title, favicon }) => ({ url, title, favicon })), null, 2));
    fs.renameSync(tmp, favFile);            // write-then-rename: never leaves a half-written file
  } catch (err) { console.error('Could not save favorites:', err.message); }
  pushState();
}

function addFav(url, title, favicon) {
  if (!starrable(url) || findFav(url)) return;
  favs.push({ id: nextFavId++, url, title: (title || '').trim() || url, favicon: favicon || null });
  saveFavs();
}
function removeFav(id) { favs = favs.filter((f) => f.id !== id); saveFavs(); }

function toggleFavForTab(t) {
  if (!t || !starrable(t.url)) return;
  const u = untranslate(t.url) || t.url;                 // a translated page stars the real site
  const f = findFav(u);
  if (f) removeFav(f.id); else addFav(u, t.title, u === t.url ? t.favicon : null);   // Google's copy: no proxied icon
}

function openFav(id, inNewTab) {
  const f = favById(id);
  if (!f) return;
  if (inNewTab || !activeTab()) newTab(f.url);
  else loadInTab(activeTab(), f.url);
}

function favMenu(id) {
  const f = favById(id);
  if (!f) return;
  return popup([
    { label: 'Open', click: () => openFav(id, false) },
    { label: 'Open in new tab', click: () => openFav(id, true) },
    { label: 'Peek (quick look, no scripts)', click: () => openPeek(f.url) },
    SEP,
    { label: 'Rename…', click: () => win && win.webContents.send('fav-rename', id) },
    { label: 'Copy address', click: () => clipboard.writeText(f.url) },
    SEP,
    { label: 'Remove from favorites', click: () => removeFav(id) }
  ]);
}

ipcMain.on('fav:toggle', () => toggleFavForTab(activeTab()));
ipcMain.on('fav:open', (_e, id, inNewTab) => openFav(id, !!inNewTab));
ipcMain.on('fav:menu', (_e, id) => favMenu(id));
ipcMain.on('fav:rename', (_e, id, title) => { const f = favById(id); if (f && String(title).trim()) { f.title = String(title).trim().slice(0, 200); saveFavs(); } });
ipcMain.on('fav:move', (_e, id, to) => {
  const i = favs.findIndex((f) => f.id === id);
  if (i < 0) return;
  const [f] = favs.splice(i, 1);
  favs.splice(Math.max(0, Math.min(favs.length, to)), 0, f);
  saveFavs();
});
// Favorites that don't fit on the bar go in a » menu
ipcMain.on('fav:overflow', (_e, ids) => {
  popup(ids.map(favById).filter(Boolean).map((f) => ({ label: f.title.length > 48 ? f.title.slice(0, 47) + '…' : f.title, click: () => openFav(f.id, false) })));
});

// ---------- history (hostnames only) ----------
// Stores ONLY the hostname of each site visited (e.g. "mail.google.com") plus the
// DAY it was last visited, which is used solely to expire it. No paths, no search
// terms, no titles, no times, no counts. Newest first.
// Limits, whichever comes first: 100 sites, or 7 days since the last visit.
let history = [];          // [{ host, day: 'YYYY-MM-DD', count }]  (count = visits, for the history roast)
let histFile = null;
const HIST_MAX = 100;
const HIST_DAYS = 7;

const dayOf = (d = new Date()) => {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
};
// Oldest day still kept: today and the 6 days before it
const cutoffDay = () => { const d = new Date(); d.setDate(d.getDate() - (HIST_DAYS - 1)); return dayOf(d); };

function pruneHistory() {
  const cut = cutoffDay();
  const before = history.length;
  history = history.filter((e) => e.day >= cut).slice(0, HIST_MAX);
  return history.length !== before;
}

const isLocalHost = (h) =>
  h === 'localhost' || h.endsWith('.local') || h.endsWith('.localhost') ||
  /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h) ||
  h === '[::1]' || /^\[?f[cd]/i.test(h) || /^\[?fe80:/i.test(h);

function hostOf(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== 'http:' && x.protocol !== 'https:') return null;
    const h = x.hostname.toLowerCase();
    if (isTranslatedHost(h)) return null;          // a translated copy; the real site is already counted
    return !h || isLocalHost(h) ? null : h;
  } catch { return null; }
}

function loadHistory() {
  histFile = process.env.NODEGRID_HIST || path.join(app.getPath('userData'), 'history.json');
  try {
    const data = JSON.parse(fs.readFileSync(histFile, 'utf8'));
    const seen = new Set();
    if (Array.isArray(data)) {
      for (const e of data) {
        const host = hostOf('https://' + (typeof e === 'string' ? e : e && e.host));
        const day = e && /^\d{4}-\d{2}-\d{2}$/.test(e.day) ? e.day : dayOf();   // older files had no day
        const count = e && Number.isInteger(e.count) && e.count > 0 ? e.count : 1;
        if (host && !seen.has(host)) { seen.add(host); history.push({ host, day, count }); }
      }
    }
  } catch { history = []; }
  if (pruneHistory()) saveHistory();
  // Sites expire even if the app stays open for days
  setInterval(() => { if (pruneHistory()) saveHistory(); }, 60 * 60 * 1000).unref();
}

function saveHistory() {
  clearTimeout(histSaveTimer); histSaveTimer = null;
  try {
    const tmp = histFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(history.map(({ host, day, count }) => ({ host, day, count })), null, 1));
    fs.renameSync(tmp, histFile);
  } catch (err) { console.error('Could not save history:', err.message); }
  pushState();
}
// Visits happen often; batch the disk writes (flushed on quit too).
let histSaveTimer = null;
function saveHistorySoon() {
  pushState();
  if (!histSaveTimer) histSaveTimer = setTimeout(saveHistory, 1000);
}
app.on('before-quit', () => { if (histSaveTimer) saveHistory(); });

function recordVisit(u) {
  const h = hostOf(u);
  if (!h) return;
  const today = dayOf();
  const prev = history.find((e) => e.host === h);
  const count = Math.min(1e9, (prev ? prev.count || 0 : 0) + 1);
  history = [{ host: h, day: today, count }, ...history.filter((e) => e.host !== h)];
  pruneHistory();
  saveHistorySoon();
}

ipcMain.on('hist:open', (_e, host, inNewTab) => {
  if (!history.some((e) => e.host === host)) return;
  const url = 'https://' + host;
  if (inNewTab || !activeTab()) newTab(url); else loadInTab(activeTab(), url);
});
ipcMain.on('hist:remove', (_e, host) => { history = history.filter((e) => e.host !== host); saveHistory(); });
ipcMain.on('hist:clear', () => { history = []; saveHistory(); });

// ---------- floating Peek preview ----------
// A quick look at a site before committing to it: the page floats over the current
// one with JavaScript OFF (HTML + CSS + images only), in throwaway storage, no history.
// Two views: peekUI draws the dimmed backdrop + frame; peekView shows the site.
let peekUI = null, peekView = null, peekUrl = '';

function peekState() {
  if (!peekUI || !peekView) return;
  const cur = peekView.webContents.getURL();
  peekUI.webContents.send('peek-state', {
    url: peekUrl,
    loading: peekView.webContents.isLoading(),
    source: cur.startsWith('view-source:')
  });
}

function peekKeys(e, input) {
  if (input.type === 'keyDown' && input.key === 'Escape') { e.preventDefault(); closePeek(); return; }
  handleKeys(e, input);
}

function openPeek(url, { source = false } = {}) {
  if (!win || !starrable(url)) return;
  closePeek();
  peekUrl = url;

  peekUI = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'peek-preload.js'), contextIsolation: true, sandbox: true }
  });
  peekUI.setBackgroundColor('#00000000');          // transparent: the frame page draws its own dim backdrop
  peekUI.setBounds(viewport);
  win.contentView.addChildView(peekUI);
  peekUI.webContents.on('before-input-event', peekKeys);
  peekUI.webContents.on('did-finish-load', peekState);
  peekUI.webContents.loadFile(path.join(__dirname, 'peek.html'));

  peekView = new WebContentsView({
    webPreferences: { partition: PEEK_PARTITION, javascript: false, webgl: false, contextIsolation: true, sandbox: true }
  });
  peekView.setBackgroundColor('#ffffff');
  peekView.setBounds({ x: 0, y: 0, width: 0, height: 0 });   // placed once the frame reports its size
  win.contentView.addChildView(peekView);

  const pw = peekView.webContents;
  pw.setWindowOpenHandler(({ url: u }) => { if (starrable(u)) pw.loadURL(u); return { action: 'deny' }; });  // stay inside the preview
  pw.on('did-start-loading', peekState);
  pw.on('did-stop-loading', peekState);
  pw.on('did-navigate', (_e, u) => { if (!u.startsWith('data:')) peekUrl = u.replace(/^view-source:/, ''); peekState(); });
  pw.on('did-navigate-in-page', (_e, u) => { peekUrl = u; peekState(); });
  pw.on('did-fail-load', (_e, code, desc, u, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    peekUrl = u.replace(/^view-source:/, '');
    peekError(pw, peekUrl, code, desc);
  });
  pw.on('before-input-event', peekKeys);
  pw.on('context-menu', (_e, p) => {
    const items = [];
    if (p.linkURL && starrable(p.linkURL)) items.push(
      { label: 'Peek this link', click: () => pw.loadURL(p.linkURL) },
      { label: 'Open link for real (new tab)', click: () => { closePeek(); newTab(p.linkURL); } },
      { label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) },
      SEP);
    if ((p.selectionText || '').trim()) items.push({ label: 'Copy', click: () => pw.copy() }, SEP);
    items.push(
      { label: 'Open for real (new tab)', click: () => { const u = peekUrl; closePeek(); newTab(u); } },
      { label: 'Copy page address', click: () => clipboard.writeText(peekUrl) },
      { label: 'Close Peek', accelerator: 'Esc', click: closePeek });
    popup(items);
  });
  pw.loadURL(source ? 'view-source:' + url : url);
}

function closePeek() {
  for (const v of [peekView, peekUI]) {
    if (!v) continue;
    try { win && win.contentView.removeChildView(v); } catch {}
    try { v.webContents.close(); } catch {}
  }
  peekUI = peekView = null;
  peekUrl = '';
  const t = activeTab();
  if (t) t.view.webContents.focus();
}

ipcMain.on('peek:layout', (e, r) => {
  if (!peekUI || !peekView || e.sender !== peekUI.webContents) return;
  peekView.setBounds({
    x: Math.round(viewport.x + r.x), y: Math.round(viewport.y + r.y),
    width: Math.max(0, Math.round(r.width)), height: Math.max(0, Math.round(r.height))
  });
});
ipcMain.on('peek:close', (e) => { if (peekUI && e.sender === peekUI.webContents) closePeek(); });
ipcMain.on('peek:open-real', (e) => {
  if (!peekUI || e.sender !== peekUI.webContents) return;
  const u = peekUrl; closePeek(); newTab(u);
});
ipcMain.on('peek:source', (e) => {
  if (!peekView || e.sender !== peekUI.webContents) return;
  const pw = peekView.webContents;
  pw.loadURL(pw.getURL().startsWith('view-source:') ? peekUrl : 'view-source:' + peekUrl);
});

// ---------- Easter eggs: support for the start page ----------
// The eggs themselves run in tab-preload.js on the NODE_GRID page. Nothing here
// stores or logs anything: no search text ever reaches this process.
ipcMain.on('egg:config', (e) => {
  try { e.returnValue = { homeFile: HOME_FILE, errorPage: ERROR_PAGE, readerPage: READER_PAGE, searchHost: new URL(SEARCH_ORIGIN).host, searchPrefs: settings.searchPrefs || null, eggs: featureOn('eggs') }; } catch { e.returnValue = null; }
});

// fsociety: the frame glitches along with the page, and afterwards a tiny dark-red
// pixel stays in the bottom-right corner of the window (an app setting, not history).
const SETTINGS_FILE = () => process.env.NODEGRID_SETTINGS || path.join(app.getPath('userData'), 'settings.json');
let settings = {};
function loadSettings() { try { settings = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')) || {}; } catch { settings = {}; } }
function saveSettings() { try { fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 1)); } catch {} }

// ---------- feature switches ----------
// Every extra can be switched off in Settings > FEATURES. Off = its button, menu items and
// shortcuts disappear (core browsing is always on).
const FEATURES = {
  music: 'Music player', ai: 'AI side panel', translate: 'Translate button', dark: 'Dark pages (moon)',
  reader: 'Reader mode', md: 'Save text pages as Markdown', pip: 'Picture-in-picture', qr: 'QR code (send to phone)',
  pinned: 'Pinned tabs', passgen: 'Password generator', burner: 'Burner tabs', loadouts: 'Loadouts',
  saved: 'Vault (saved pages)', trail: 'Packet trail', eggs: 'Easter eggs',
  gear: 'Settings button (bottom-right corner)',
  recon: 'Recon (developer mode)', mobile: 'Mobile view (developer mode)', sim: 'NODE_GRID SIM game (developer mode)'
};
// Store builds can leave parts out (see store-kit): build-flags.json next to the app.
let BUILD = {};
try { BUILD = JSON.parse(fs.readFileSync(path.join(__dirname, 'build-flags.json'), 'utf8')) || {}; } catch {}
const SIM_AVAILABLE = !BUILD.noSim && fs.existsSync(path.join(__dirname, 'doom', 'index.html'));
const featureOn = (k) => {
  if (k === 'sim' && !SIM_AVAILABLE) return false;
  return !(settings.features && settings.features[k] === false);
};
const featureMap = () => Object.fromEntries(Object.keys(FEATURES).map((k) => [k, featureOn(k)]));

// Start page: last engine + Vault switch (a setting, not history: no queries).
const ENGINES = ['duckduckgo', 'brave', 'google', 'startpage'];
ipcMain.on('prefs:search', (e, engine, vault) => {
  if (e.sender.getURL().split(/[?#]/)[0] !== HOME_FILE || !ENGINES.includes(engine)) return;
  settings.searchPrefs = { engine, vault: !!vault };
  saveSettings();
});

let pixelView = null;
// ---------- settings gear, bottom-right corner of the page ----------
// A tiny transparent view of its own (pages are drawn above the app's frame, so a
// button there has to float above them). Sits just inside the corner, clear of the
// fsociety pixel.
let gearView = null;
const GEAR = 32;
function placeGear() {
  if (!win || win.isDestroyed()) return;
  if (!featureOn('gear')) { if (gearView) { try { win.contentView.removeChildView(gearView); gearView.webContents.close(); } catch {} gearView = null; } return; }
  if (!gearView) {
    gearView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'gear-preload.js'), contextIsolation: true, sandbox: true } });
    gearView.setBackgroundColor('#00000000');
    gearView.webContents.loadFile(path.join(__dirname, 'gear.html'));
  }
  gearView.setBounds({ x: Math.round(viewport.x + viewport.width - GEAR - 22), y: Math.round(viewport.y + viewport.height - GEAR - 14), width: GEAR, height: GEAR });
  win.contentView.addChildView(gearView);
}
ipcMain.on('gear:open', (e) => { if (gearView && e.sender === gearView.webContents) openSettings(); });

function placePixel() {
  if (!win || win.isDestroyed()) return;
  placeGear();
  if (!settings.redPixel || !featureOn('eggs')) { if (pixelView) { win.contentView.removeChildView(pixelView); pixelView = null; } return; }
  if (!pixelView) {
    pixelView = new WebContentsView({ webPreferences: { javascript: false, sandbox: true } });
    pixelView.setBackgroundColor('#8a1219');            // dark red: easy to miss
  }
  pixelView.setBounds({ x: viewport.x + viewport.width - 3, y: viewport.y + viewport.height - 3, width: 2, height: 2 });
  win.contentView.addChildView(pixelView);              // (re)added last = always on top
}

const fromNodeGrid = (wc) => { try { const u = new URL(wc.getURL()); return u.host === new URL(SEARCH_ORIGIN).host || (u.protocol === 'file:' && wc.getURL().split(/[?#]/)[0] === HOME_FILE); } catch { return false; } };
ipcMain.on('egg:corrupt', (e, on) => { if (fromNodeGrid(e.sender) && win && !win.isDestroyed()) win.webContents.send('egg-corrupt', !!on); });
ipcMain.on('egg:pixel', (e) => { if (!fromNodeGrid(e.sender)) return; settings.redPixel = true; saveSettings(); placePixel(); });

// rm -rf on the results page ends on the start page. A web page can't open the
// bundled file itself, so it asks; only NODE_GRID's own pages may ask.
ipcMain.on('egg:home', (e) => {
  const t = tabs.find((x) => x.view.webContents === e.sender);
  try { if (t && new URL(e.sender.getURL()).host === new URL(SEARCH_ORIGIN).host) e.sender.loadURL(HOME); } catch {}
});

// "ping": real round-trip time to the start page's server (HTTP HEAD, uncached).
// Best of 3, so the first connection's TLS handshake doesn't inflate the number.
let pinging = false;
ipcMain.handle('egg:ping', async () => {
  if (pinging) return { ok: false, busy: true };
  pinging = true;
  try {
    const target = SEARCH_ORIGIN + '/';
    const ses = session.fromPartition(PARTITION);
    const times = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const res = await ses.fetch(target, { method: 'HEAD', cache: 'no-store' });
      times.push(performance.now() - t0);
      if (!res.ok && res.status >= 500) break;
    }
    return { ok: true, ms: Math.round(Math.min(...times)), host: new URL(SEARCH_ORIGIN).host };
  } catch {
    return { ok: false };
  } finally {
    pinging = false;
  }
});

// ---------- small overlay windows (permission prompt, password vault) ----------
// Page views sit above the app's frame, so anything that floats over a page is its
// own tiny transparent view, kept on top of the tabs.
const overlays = { perm: null, vault: null, recon: null, qr: null };

function makeOverlay(file, preload) {
  const v = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, preload), contextIsolation: true, sandbox: true }
  });
  v.setBackgroundColor('#00000000');
  v.webContents.on('before-input-event', (e, i) => {
    if (i.type === 'keyDown' && i.key === 'Escape') { e.preventDefault(); v.webContents.send('escape'); }
  });
  v.webContents.loadFile(path.join(__dirname, file));
  win.contentView.addChildView(v);
  return v;
}
function dropOverlay(name) {
  const v = overlays[name];
  if (!v) return;
  try { win && win.contentView.removeChildView(v); } catch {}
  try { v.webContents.close(); } catch {}
  overlays[name] = null;
}
function raiseOverlays() {
  if (!win || win.isDestroyed()) return;
  for (const v of [overlays.recon, overlays.qr, overlays.vault, overlays.perm]) if (v) win.contentView.addChildView(v);
  placePixel();
}
const isOverlay = (wc, name) => !!overlays[name] && overlays[name].webContents === wc;
const originOf = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.origin : null; } catch { return null; } };

// ---------- 1. permission prompts (top right) ----------
// Electron would otherwise say YES to every site asking for camera, mic, location...
// Now the user decides. "Remember" choices are a local setting (origin + permission).
const SAFE_PERMS = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock']);
const PERM_KIND = {
  geolocation: 'location', notifications: 'notifications', 'clipboard-read': 'clipboard',
  midi: 'midi', midiSysex: 'midi', 'display-capture': 'screen', openExternal: 'external-app',
  'idle-detection': 'idle', 'storage-access': 'storage', 'top-level-storage-access': 'storage',
  'window-management': 'windows', 'speaker-selection': 'speakers'
};
const sessionGrants = new Map();      // "origin|kind" -> true/false, until the app closes
const permQueue = [];
let permShowing = null, permReady = false;

const mediaKind = (types) => {
  const v = (types || []).includes('video'), a = (types || []).includes('audio');
  return v && a ? 'camera+microphone' : v ? 'camera' : a ? 'microphone' : 'camera+microphone';
};
const decided = (origin, kind) => {
  const k = origin + '|' + kind;
  if (settings.permissions && k in settings.permissions) return settings.permissions[k];
  return sessionGrants.has(k) ? sessionGrants.get(k) : undefined;
};

function permBounds() {
  const w = 360, h = 186;
  return { x: Math.round(viewport.x + viewport.width - w - 10), y: Math.round(viewport.y + 8), width: w, height: h };
}
function nextPrompt() {
  if (permShowing) return;
  while (permQueue.length && permQueue[0].wc.isDestroyed()) permQueue.shift().callback(false);
  if (!permQueue.length) { dropOverlay('perm'); permReady = false; return; }
  permShowing = permQueue.shift();
  if (!overlays.perm) {
    overlays.perm = makeOverlay('perm.html', 'perm-preload.js');
    overlays.perm.setBounds(permBounds());
    overlays.perm.webContents.once('did-finish-load', () => { permReady = true; sendPrompt(); });
    placePixel();
  } else sendPrompt();
}
function sendPrompt() {
  if (!permShowing || !permReady || !overlays.perm) return;
  overlays.perm.webContents.send('perm-show', { host: new URL(permShowing.origin).host, kind: permShowing.kind });
}
function answerPrompt(allow, remember) {
  const p = permShowing;
  if (!p) return;
  permShowing = null;
  const k = p.origin + '|' + p.kind;
  if (remember) { settings.permissions = settings.permissions || {}; settings.permissions[k] = !!allow; saveSettings(); }
  else sessionGrants.set(k, !!allow);
  try { p.callback(!!allow); } catch {}
  // anything else waiting on the same answer gets it too
  for (let i = permQueue.length - 1; i >= 0; i--) {
    if (permQueue[i].origin + '|' + permQueue[i].kind === k) { try { permQueue[i].callback(!!allow); } catch {} permQueue.splice(i, 1); }
  }
  nextPrompt();
}
ipcMain.on('perm:answer', (e, allow, remember) => { if (isOverlay(e.sender, 'perm')) answerPrompt(allow, remember); });

function setupPermissions(ses, { peek = false } = {}) {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (peek) return callback(false);                         // Peek never gets anything
    if (SAFE_PERMS.has(permission)) return callback(true);
    const origin = originOf((details && details.requestingUrl) || wc.getURL());
    if (!origin) return callback(false);
    const kind = permission === 'media' ? mediaKind(details && details.mediaTypes) : (PERM_KIND[permission] || permission);
    const known = decided(origin, kind);
    if (known !== undefined) return callback(known);
    permQueue.push({ wc, origin, kind, callback });
    nextPrompt();
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    if (peek) return false;
    if (SAFE_PERMS.has(permission)) return true;
    const origin = originOf(requestingOrigin || (wc && wc.getURL()));
    if (!origin) return false;
    if (permission === 'media') {
      const t = details && details.mediaType;
      const kinds = t === 'video' ? ['camera', 'camera+microphone'] : t === 'audio' ? ['microphone', 'camera+microphone'] : ['camera', 'microphone', 'camera+microphone'];
      return kinds.some((k) => decided(origin, k) === true);
    }
    return decided(origin, PERM_KIND[permission] || permission) === true;
  });
  ses.setDevicePermissionHandler(() => false);                // USB / serial / HID: no
}

// ---------- 3. typing an address ----------
const LOCALISH = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?(\/|$)/i;
function resolveInput(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (t.toLowerCase() === 'nodegrid://home') return HOME;
  if (/^nodegrid:\/\/settings\/?$/i.test(t)) return SETTINGS_PAGE;
  if (isSimUrl(t)) return SIM_URL;
  if (/^https?:\/\//i.test(t)) return t;
  if (!/\s/.test(t)) {
    if (LOCALISH.test(t)) return 'http://' + t;                        // homelab gear, routers
    if (/^[^\s/?#]+\.[a-z][a-z0-9-]{1,62}(:\d+)?([/?#].*)?$/i.test(t)) return 'https://' + t;
  }
  return SEARCH_ORIGIN + '/results.html?' + new URLSearchParams({ q: t, engine: 'duckduckgo' }).toString();
}
ipcMain.on('nav:go', (e, text) => {
  if (e.sender !== win.webContents) return;
  const url = resolveInput(text);
  const t = activeTab();
  if (!url || !t) return;
  loadInTab(t, url);
  focusPage();
});

// ---------- NODE_GRID SIM (the game button) ----------
function openSim() {
  if (!devMode || !featureOn('sim')) { toast('NODE_GRID SIM is only available in developer mode'); return null; }   // hidden game
  const t = tabs.find((x) => x.sim);
  if (t) { activate(t.id); return t; }                       // one sim tab; the button jumps back to it
  return newTab(SIM_URL, { sim: true });
}
ipcMain.on('sim:open', (e) => { if (e.sender === win.webContents) openSim(); });

function setupSim() {
  const ses = session.fromPartition(SIM_PARTITION);
  const root = path.join(__dirname, 'doom');
  const fonts = path.join(__dirname, 'fonts');
  ses.protocol.handle('nodegrid', (req) => {
    let u;
    try { u = new URL(req.url); } catch { return new Response('bad address', { status: 400 }); }
    if (u.host !== 'doom') return new Response('not found', { status: 404 });
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    const base = rel.startsWith('fonts/') ? fonts : root;
    const file = path.resolve(base, rel.startsWith('fonts/') ? rel.slice(6) : rel);
    if (!file.startsWith(base + path.sep)) return new Response('not found', { status: 404 });   // no ../ escapes
    return net.fetch(pathToFileURL(file).href);
  });
  setupPermissions(ses);                       // mouse capture is allowed; anything else asks
  ses.on('will-download', (_e, item) => item.cancel());
}

// ---------- packet trail ----------
// Every server each tab talked to: request count, reported size, IP, blocked or not.
// Kept in memory for the current page only; never written anywhere.
const trails = new Map();                     // webContents id -> trail
const freshTrail = () => ({ hosts: new Map(), total: 0, blocked: 0, bytes: 0 });
const trailFor = (id) => { let t = trails.get(id); if (!t) { t = freshTrail(); trails.set(id, t); } return t; };
const hdr = (h, name) => { if (!h) return ''; for (const k of Object.keys(h)) if (k.toLowerCase() === name) return [].concat(h[k])[0] || ''; return ''; };
function trailHost(tr, host) {
  let h = tr.hosts.get(host);
  if (!h) { h = { count: 0, blocked: 0, failed: 0, bytes: 0, ips: new Set() }; tr.hosts.set(host, h); }
  return h;
}
const hostOfUrl = (u) => { try { const x = new URL(u); return /^(https?|wss?):$/.test(x.protocol) ? x.hostname.toLowerCase() : ''; } catch { return ''; } };
function noteBlocked(wc, url) {
  const host = hostOfUrl(url); if (!host) return;
  const tr = trailFor(wc.id), h = trailHost(tr, host);
  h.count++; h.blocked++; tr.total++; tr.blocked++;
  trailChanged(wc.id);
}
function noteRequest(d, failed) {
  const wc = d.webContents;
  if (!wc || wc.isDestroyed()) return;
  if (failed && /BLOCKED_BY_CLIENT/.test(d.error || '')) return;     // already counted as blocked
  const host = hostOfUrl(d.url); if (!host) return;
  const tr = trailFor(wc.id), h = trailHost(tr, host);
  h.count++; tr.total++;
  if (failed) h.failed++;
  else {
    if (d.ip) h.ips.add(d.ip);
    const len = Number(hdr(d.responseHeaders, 'content-length')) || 0;
    h.bytes += len; tr.bytes += len;
  }
  if (d.resourceType === 'mainFrame' && !failed) {
    const t = tabs.find((x) => x.view.webContents === wc);
    if (t) t.mainInfo = { url: d.url, ip: d.ip || '', statusCode: d.statusCode, statusLine: d.statusLine || '', headers: d.responseHeaders || {} };
  }
  trailChanged(wc.id);
}
function hookTrail(ses) {
  ses.webRequest.onCompleted({ urls: ['<all_urls>'] }, (d) => noteRequest(d, false));
  ses.webRequest.onErrorOccurred({ urls: ['<all_urls>'] }, (d) => noteRequest(d, true));
}
let trailWatching = false, trailTimer = null;
function trailChanged(wcId) {
  const t = activeTab();
  if (!trailWatching || !t || t.view.webContents.id !== wcId || trailTimer) return;
  trailTimer = setTimeout(() => { trailTimer = null; sendTrail(); }, 400);
}
const baseDomain = (h) => { const p = h.split('.'); if (/^\d+$/.test(p[p.length - 1])) return h; const n = p.length > 2 && /^(co|com|org|net|gov|ac|edu)$/.test(p[p.length - 2]) ? 3 : 2; return p.slice(-n).join('.'); };
function sendTrail() {
  if (!trailWatching || !win || win.isDestroyed()) return;
  const t = activeTab();
  const tr = t ? trailFor(t.view.webContents.id) : freshTrail();
  const page = t ? hostOfUrl(untranslate(t.url) || t.url) : '';
  const base = page ? baseDomain(page) : '';
  const hosts = [...tr.hosts].map(([host, h]) => ({
    host, count: h.count, blocked: h.blocked, failed: h.failed, bytes: h.bytes,
    ip: [...h.ips][0] || '', moreIps: Math.max(0, h.ips.size - 1),
    first: !!base && (host === base || host.endsWith('.' + base))
  })).sort((a, b) => (b.first - a.first) || (b.count - a.count)).slice(0, 300);
  win.webContents.send('trail', { page, total: tr.total, blocked: tr.blocked, bytes: tr.bytes, servers: tr.hosts.size, hosts });
}
ipcMain.on('trail:watch', (e, on) => { if (e.sender === win.webContents) { trailWatching = !!on; sendTrail(); } });

// ---------- recon (developer mode) ----------
// A popup with what's behind the current page: addresses, network owner, DNS,
// certificate and security headers. Looked up live, shown once, never stored.
const dnsp = require('dns').promises;
const tlsMod = require('tls');
function reconBounds() {
  const w = Math.min(500, viewport.width - 20), h = Math.min(600, viewport.height - 20);
  return { x: Math.round(viewport.x + (viewport.width - w) / 2), y: Math.round(viewport.y + 10), width: Math.round(w), height: Math.round(h) };
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))]);
const isPrivateIp = (ip) => /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd]|fe80:)/i.test(ip);
function securityGrade(url, headers) {
  const https = /^https:/i.test(url);
  const csp = hdr(headers, 'content-security-policy');
  const checks = [
    ['HTTPS', https],
    ['Strict-Transport-Security', !!hdr(headers, 'strict-transport-security')],
    ['Content-Security-Policy', !!csp],
    ['X-Content-Type-Options', /nosniff/i.test(hdr(headers, 'x-content-type-options'))],
    ['Clickjacking protection', !!hdr(headers, 'x-frame-options') || /frame-ancestors/i.test(csp)],
    ['Referrer-Policy', !!hdr(headers, 'referrer-policy')],
    ['Permissions-Policy', !!hdr(headers, 'permissions-policy')]
  ];
  const score = checks.filter(([, ok]) => ok).length;
  const grade = !https ? 'F' : score >= 7 ? 'A+' : score === 6 ? 'A' : score === 5 ? 'B' : score === 4 ? 'C' : score === 3 ? 'D' : 'F';
  return { grade, checks: checks.map(([name, ok]) => ({ name, ok })) };
}
function tlsInfo(host, port) {
  return new Promise((resolve) => {
    const sock = tlsMod.connect({ host, port, servername: /^[\d.]+$|:/.test(host) ? undefined : host, rejectUnauthorized: false, timeout: 6000 }, () => {
      const c = sock.getPeerCertificate() || {};
      const days = c.valid_to ? Math.floor((new Date(c.valid_to) - Date.now()) / 86400000) : null;
      resolve({
        ok: true, trusted: sock.authorized, error: sock.authorized ? '' : String(sock.authorizationError || ''),
        protocol: sock.getProtocol(), cipher: (sock.getCipher() || {}).name || '',
        subject: (c.subject && c.subject.CN) || '', issuer: (c.issuer && (c.issuer.O || c.issuer.CN)) || '',
        validFrom: c.valid_from || '', validTo: c.valid_to || '', daysLeft: days,
        names: c.subjectaltname ? c.subjectaltname.split(', ').length : 0
      });
      sock.end();
    });
    sock.on('timeout', () => { sock.destroy(); resolve({ ok: false, error: 'timed out' }); });
    sock.on('error', (err) => resolve({ ok: false, error: err.code || err.message }));
  });
}
async function asnInfo(ip) {
  if (!ip || ip.includes(':')) return { note: 'IPv6 lookup not supported' };
  if (isPrivateIp(ip)) return { note: 'Private / local network' };
  const r = new dnsp.Resolver({ timeout: 3000, tries: 1 });
  const first = (await withTimeout(r.resolveTxt(ip.split('.').reverse().join('.') + '.origin.asn.cymru.com'), 4000))[0].join('');
  const [asn, prefix, cc, registry] = first.split('|').map((x) => x.trim());
  let name = '';
  try { name = ((await withTimeout(r.resolveTxt('AS' + asn.split(' ')[0] + '.asn.cymru.com'), 4000))[0].join('').split('|')[4] || '').trim(); } catch {}
  return { asn: 'AS' + asn.split(' ')[0], prefix, country: cc, registry, name };
}
async function dnsRecords(host) {
  const r = new dnsp.Resolver({ timeout: 3000, tries: 1 });
  const q = (fn) => withTimeout(fn, 4000).catch(() => []);
  const [a, aaaa, cname, mx, ns, txt] = await Promise.all([
    q(r.resolve4(host)), q(r.resolve6(host)), q(r.resolveCname(host)),
    q(r.resolveMx(host)), q(r.resolveNs(baseDomain(host))), q(r.resolveTxt(baseDomain(host)))
  ]);
  return {
    A: a, AAAA: aaaa, CNAME: cname,
    MX: mx.sort((x, y) => x.priority - y.priority).map((m) => `${m.priority} ${m.exchange}`),
    NS: ns, TXT: txt.map((t) => t.join('')).slice(0, 8)
  };
}
function openRecon(tab) {
  dropOverlay('recon');
  const target = untranslate(tab.url) || tab.url;
  let u; try { u = new URL(target); } catch { return; }
  if (!/^https?:$/.test(u.protocol)) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const v = overlays.recon = makeOverlay('recon.html', 'recon-preload.js');
  v.setBounds(reconBounds());
  raiseOverlays();
  const send = (key, data) => { if (overlays.recon === v && !v.webContents.isDestroyed()) v.webContents.send('recon-part', key, data); };
  v.webContents.once('did-finish-load', () => {
    send('target', { url: target, host });
    const mi = tab.mainInfo && tab.mainInfo.url && hostOfUrl(tab.mainInfo.url) === host.toLowerCase() ? tab.mainInfo : null;
    if (mi) send('http', { status: mi.statusLine || String(mi.statusCode), server: hdr(mi.headers, 'server'), poweredBy: hdr(mi.headers, 'x-powered-by'), ...securityGrade(mi.url, mi.headers) });
    else send('http', { status: 'not captured (reload the page, then open Recon)', ...securityGrade(target, {}) });
    withTimeout(dnsp.lookup(host, { all: true }), 5000).then((list) => {
      const ips = list.map((x) => x.address);
      if (mi && mi.ip && !ips.includes(mi.ip)) ips.unshift(mi.ip);
      send('ips', { ips, connected: mi ? mi.ip : '' });
      const v4 = (mi && mi.ip && !mi.ip.includes(':') ? mi.ip : null) || ips.find((x) => !x.includes(':'));
      asnInfo(v4).then((a) => send('asn', a), (err) => send('asn', { error: err.message }));
    }, (err) => { send('ips', { error: err.code || err.message }); send('asn', { error: 'no address' }); });
    if (/^[\d.]+$|:/.test(host)) send('dns', { note: 'This is an IP address, so there are no DNS records to look up.' });
    else dnsRecords(host).then((d) => send('dns', d), (err) => send('dns', { error: err.message }));
    if (u.protocol === 'https:') tlsInfo(host, Number(u.port) || 443).then((t) => send('tls', t));
    else send('tls', { ok: false, error: 'Not encrypted (plain http)' });
  });
}
ipcMain.on('recon:close', (e) => { if (isOverlay(e.sender, 'recon')) { dropOverlay('recon'); focusPage(); } });
ipcMain.on('recon:copy', (e, text) => { if (isOverlay(e.sender, 'recon')) clipboard.writeText(String(text).slice(0, 20000)); });

// ---------- vault: your saved pages (this Windows user only) ----------
// Right-click > Save to Vault, or Ctrl+S: keeps the link AND an offline copy of the
// page in this user's own app folder. Nothing is shared or synced.
const SAVED_DIR = () => process.env.NODEGRID_SAVED || path.join(app.getPath('userData'), 'saved-pages');
let saved = [];               // [{ id, url, title, host, savedAt, file }]
function loadSaved() {
  try { saved = JSON.parse(fs.readFileSync(path.join(SAVED_DIR(), 'saved.json'), 'utf8')).filter((x) => x && x.id && x.url); } catch { saved = []; }
}
function writeSaved() {
  try {
    fs.mkdirSync(SAVED_DIR(), { recursive: true });
    const f = path.join(SAVED_DIR(), 'saved.json');
    fs.writeFileSync(f + '.tmp', JSON.stringify(saved, null, 1)); fs.renameSync(f + '.tmp', f);
  } catch (err) { console.error('Could not save the vault list:', err.message); }
}
const toast = (text) => { if (win && !win.isDestroyed()) win.webContents.send('toast', String(text)); };
const savable = (t) => !!t && !t.sim && /^https?:/i.test(t.url || '') && !isErrorPage(t.view.webContents.getURL());
async function saveToVault(t) {
  if (!featureOn('saved')) return;
  if (!savable(t)) { toast("This page can't be saved"); return; }
  const url = untranslate(t.url) || t.url;
  let entry = saved.find((x) => normUrl(x.url) === normUrl(url));
  const id = entry ? entry.id : Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const file = path.join(SAVED_DIR(), id + '.mhtml');
  toast('Saving to Vault…');
  let ok = false;
  try { fs.mkdirSync(SAVED_DIR(), { recursive: true }); await t.view.webContents.savePage(file, 'MHTML'); ok = true; } catch {}
  const rec = { id, url, title: (t.title || hostOfUrl(url)).slice(0, 200), host: hostOfUrl(url), savedAt: new Date().toISOString(), file: ok ? id + '.mhtml' : null };
  // Text-heavy page (article, docs, post): also keep it as a Markdown file.
  let md = false;
  if (featureOn('md') && t.readerable && !t.reader) {
    const art = await extractArticle(t, true);
    if (art && art.markdown) md = writeMarkdown(id, { ...art, url });
  }
  if (md) rec.md = id + '.md'; else if (entry && entry.md) rec.md = entry.md;
  if (entry) Object.assign(entry, rec); else saved.unshift(rec);
  writeSaved(); pushState();
  toast(ok ? `Saved to Vault (offline copy${md ? ' + Markdown' : ''})` : 'Saved to Vault (link only)');
}
const savedById = (id) => saved.find((x) => x.id === id);
ipcMain.on('saved:open', (e, id, inNew) => { const s = savedById(id); if (e.sender === win.webContents && s) { if (inNew || !activeTab()) newTab(s.url); else loadInTab(activeTab(), s.url); focusPage(); } });
ipcMain.on('saved:offline', (e, id) => {
  const s = savedById(id);
  if (e.sender !== win.webContents || !s || !s.file) return;
  const f = path.join(SAVED_DIR(), path.basename(s.file));
  if (fs.existsSync(f)) newTab(pathToFileURL(f).href); else toast('The offline copy is missing');
});
ipcMain.on('saved:md', (e, id) => {
  const s = savedById(id);
  if (e.sender !== win.webContents || !s || !s.md) return;
  const f = path.join(SAVED_DIR(), path.basename(s.md));
  if (fs.existsSync(f)) eshell.openPath(f); else toast('The Markdown file is missing');
});
ipcMain.on('saved:remove', (e, id) => {
  const s = savedById(id);
  if (e.sender !== win.webContents || !s) return;
  if (s.file) { try { fs.unlinkSync(path.join(SAVED_DIR(), path.basename(s.file))); } catch {} }
  if (s.md) { try { fs.unlinkSync(path.join(SAVED_DIR(), path.basename(s.md))); } catch {} }
  saved = saved.filter((x) => x.id !== id); writeSaved(); pushState();
});
ipcMain.on('saved:save', (e) => { if (e.sender === win.webContents) saveToVault(activeTab()); });

// ---------- loadouts ----------
// A named set of tabs you can drop back in with one click. Saved locally.
const LOADOUT_FILE = () => process.env.NODEGRID_LOADOUTS || path.join(app.getPath('userData'), 'loadouts.json');
let loadouts = [];            // [{ id, name, urls: [] }]
function loadLoadouts() { try { loadouts = JSON.parse(fs.readFileSync(LOADOUT_FILE(), 'utf8')).filter((l) => l && l.name && Array.isArray(l.urls)); } catch { loadouts = []; } }
function writeLoadouts() { try { fs.writeFileSync(LOADOUT_FILE(), JSON.stringify(loadouts, null, 1)); } catch (err) { console.error('Could not save loadouts:', err.message); } }
const isHomeUrl = (u) => typeof u === 'string' && u.split(/[?#]/)[0] === HOME_FILE;
function loadoutUrls() {
  return tabs.filter((t) => !t.peek && !t.burner).map((t) => {
    const u = untranslate(t.url) || t.url || '';
    if (t.sim) return 'nodegrid://doom';
    if (isHomeUrl(u) || u === HOME) return 'nodegrid://home';
    return /^https?:/i.test(u) ? u : null;
  }).filter(Boolean);
}
ipcMain.on('loadout:save', (e, name) => {
  if (e.sender !== win.webContents) return;
  const urls = loadoutUrls();
  if (!urls.length) { toast('No tabs to save'); return; }
  const n = String(name || '').trim().slice(0, 60) || `Loadout ${loadouts.length + 1}`;
  const existing = loadouts.find((l) => l.name.toLowerCase() === n.toLowerCase());
  if (existing) existing.urls = urls; else loadouts.push({ id: Date.now().toString(36), name: n, urls });
  writeLoadouts(); pushState();
  toast(`Loadout saved: ${n} (${urls.length} tab${urls.length === 1 ? '' : 's'})`);
});
ipcMain.on('loadout:deploy', (e, id, swap) => {
  const l = loadouts.find((x) => x.id === id);
  if (e.sender !== win.webContents || !l) return;
  const old = swap ? tabs.filter((t) => !t.burner).map((t) => t.id) : [];
  for (const u of l.urls) {
    if (u === 'nodegrid://doom') { if (devMode) openSim(); }
    else newTab(u === 'nodegrid://home' ? HOME : u);
  }
  old.forEach(closeTab);
  toast(`Loadout deployed: ${l.name}`);
});
ipcMain.on('loadout:remove', (e, id) => { if (e.sender === win.webContents) { loadouts = loadouts.filter((x) => x.id !== id); writeLoadouts(); pushState(); } });

// ---------- burner tabs ----------
// A red tab with its own throwaway cookies and storage. When its timer runs out (or its
// last tab closes) the tab closes and everything it stored is wiped. Never in history.
const burners = new Map();    // partition -> { ends, timer, warn }
let burnerSeq = 0;
const BURN_CHOICES = [5, 15, 30, 60];
const burnerMinutes = () => BURN_CHOICES.includes(settings.burnerMinutes) ? settings.burnerMinutes : 15;
function scheduleBurn(part) {
  const b = burners.get(part); if (!b) return;
  clearTimeout(b.timer); clearTimeout(b.warn);
  const left = b.ends - Date.now();
  b.timer = setTimeout(() => burnGroup(part, true), Math.max(0, left));
  if (left > 60000) b.warn = setTimeout(() => toast('Burner tab wipes itself in 1 minute'), left - 60000);
}
function openBurner(url = HOME) {
  if (!featureOn('burner')) return null;
  const part = 'nodegrid-burner-' + (++burnerSeq);       // in memory only, separate from every other tab
  setupWebSession(session.fromPartition(part));
  burners.set(part, { ends: Date.now() + (Number(process.env.NODEGRID_BURN_TEST_MS) || burnerMinutes() * 60000) });   // (env: tests only)
  scheduleBurn(part);
  return newTab(url, { burner: { part } });
}
function burnGroup(part, expired) {
  const b = burners.get(part);
  if (!b) return;
  clearTimeout(b.timer); clearTimeout(b.warn);
  burners.delete(part);
  for (const t of tabs.filter((x) => x.burner && x.burner.part === part)) closeTab(t.id);
  const ses = session.fromPartition(part);
  ses.clearStorageData().catch(() => {}); ses.clearCache().catch(() => {}); ses.clearAuthCache().catch(() => {});
  if (expired) toast('Burner tab wiped');
  pushState();
}
function extendBurner(part, minutes) { const b = burners.get(part); if (b) { b.ends = Math.max(b.ends, Date.now()) + minutes * 60000; scheduleBurn(part); pushState(); } }
function burnerMenu() {
  popup([
    { label: 'Open burner tab', accelerator: 'CmdOrCtrl+Shift+N', click: () => openBurner() },
    SEP,
    ...BURN_CHOICES.map((m) => ({ label: `Wipe after ${m} minutes`, type: 'radio', checked: burnerMinutes() === m,
      click: () => { settings.burnerMinutes = m; saveSettings(); } }))
  ]);
}
ipcMain.on('burner:open', (e) => { if (e.sender === win.webContents) openBurner(); });
ipcMain.on('burner:menu', (e) => { if (e.sender === win.webContents) burnerMenu(); });

// ---------- AI side panel ----------
// A small second browser docked on the right for an AI chat (Claude, ChatGPT, ...or
// your own, like BT). It has its OWN saved storage, so you stay signed in to the AI
// between launches; your normal tabs never share it.
const AI_PARTITION = 'persist:nodegrid-ai';
const AI_PROVIDERS = {
  claude: 'https://claude.ai/new',
  chatgpt: 'https://chatgpt.com/',
  gemini: 'https://gemini.google.com/app',
  perplexity: 'https://www.perplexity.ai/',
  grok: 'https://grok.com/'
};
const LOCAL_AI_FILE = pathToFileURL(path.join(__dirname, 'local-ai.html')).href;
let aiView = null, aiShown = false;
const aiProvider = () => (settings.aiProvider === 'custom' ? (settings.aiCustom ? 'custom' : 'claude')
  : settings.aiProvider === 'local' ? 'local' : (AI_PROVIDERS[settings.aiProvider] ? settings.aiProvider : 'claude'));
const aiUrl = (p) => p === 'custom' ? settings.aiCustom : p === 'local' ? LOCAL_AI_FILE : AI_PROVIDERS[p];
function setupAiSession() {
  const ses = session.fromPartition(AI_PARTITION);
  // Some AI sites refuse anything that says "Electron": present a plain Chrome identity.
  ses.setUserAgent(ses.getUserAgent().replace(/ Electron\/\S+/, '').replace(/ nullgrid-browser\/\S+/i, '').replace(/ NODE_GRID\/\S+/i, ''));
  setupPermissions(ses);            // microphone for voice chat etc. still asks first
  setupDownloads(ses);
  hookAdblock(ses);
}
function ensureAiView() {
  if (aiView) return aiView;
  aiView = new WebContentsView({ webPreferences: { partition: AI_PARTITION, contextIsolation: true, sandbox: true,
    preload: path.join(__dirname, 'local-ai-preload.js') } });          // the preload only does anything on the built-in local chat page
  aiView.setBackgroundColor('#0a0a0f');
  const wc = aiView.webContents;
  wc.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) newTab(url); return { action: 'deny' }; });   // links from a chat open as normal tabs
  wc.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown') return;
    const ctrl = i.control || i.meta, k = i.key.toLowerCase();
    if (ctrl && i.shift && k === 'a') { e.preventDefault(); win.webContents.send('ai-toggle'); }
    else if ((ctrl && k === 'r') || k === 'f5') { e.preventDefault(); wc.reload(); }
  });
  wc.on('context-menu', (_e, p) => {
    const items = [];
    if (p.linkURL && /^https?:/i.test(p.linkURL)) items.push({ label: 'Open link in new tab', click: () => newTab(p.linkURL) }, { label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) }, SEP);
    if (p.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    else if (p.selectionText) items.push({ role: 'copy' });
    items.push(SEP, { label: 'Back', enabled: canGoBack(wc), click: () => wc.navigationHistory.goBack() }, { label: 'Reload', click: () => wc.reload() });
    popup(items);
  });
  wc.on('did-navigate', () => pushState());
  wc.on('page-title-updated', () => pushState());
  wc.loadURL(aiUrl(aiProvider())).catch(() => {});
  return aiView;
}
ipcMain.on('ai:bounds', (e, r) => {
  if (e.sender !== win.webContents) return;
  if (!r || r.width < 50 || r.height < 50) {
    if (aiView && aiShown) { try { win.contentView.removeChildView(aiView); } catch {} }
    aiShown = false; focusPage(); pushState(); return;
  }
  const v = ensureAiView();
  v.setBounds({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });
  if (!aiShown) { win.contentView.addChildView(v); aiShown = true; setTimeout(raiseOverlays, 0); pushState(); }
});
ipcMain.on('ai:provider', (e, p) => {
  if (e.sender !== win.webContents || !(p in AI_PROVIDERS || p === 'custom' || p === 'local')) return;
  if (p === 'custom' && !settings.aiCustom) return;
  settings.aiProvider = p; saveSettings();
  if (aiView) aiView.webContents.loadURL(aiUrl(p)).catch(() => {});
  pushState();
});
ipcMain.on('ai:custom', (e, url) => {
  if (e.sender !== win.webContents) return;
  let u = String(url || '').trim();
  if (!u) { delete settings.aiCustom; if (settings.aiProvider === 'custom') settings.aiProvider = 'claude'; saveSettings(); pushState(); return; }
  if (!/^https?:\/\//i.test(u)) u = (LOCALISH.test(u) ? 'http://' : 'https://') + u;
  try { new URL(u); } catch { toast("That doesn't look like an address"); return; }
  settings.aiCustom = u; settings.aiProvider = 'custom'; saveSettings();
  if (aiView) aiView.webContents.loadURL(u).catch(() => {});
  pushState();
});
ipcMain.on('ai:action', (e, what) => {
  if (e.sender !== win.webContents || !aiView) return;
  const wc = aiView.webContents;
  if (what === 'back' && canGoBack(wc)) wc.navigationHistory.goBack();
  if (what === 'reload') wc.reload();
  if (what === 'home') wc.loadURL(aiUrl(aiProvider())).catch(() => {});
  if (what === 'tab' && /^https?:/i.test(wc.getURL())) newTab(wc.getURL());
});

// ---------- music player: tab audio ----------
// Shows and controls whatever is playing in a tab (YouTube, Spotify web, SoundCloud...).
let mediaTabId = null;
const MEDIA_META_JS = `(() => { const m = navigator.mediaSession && navigator.mediaSession.metadata;
  return m ? { title: m.title || '', artist: m.artist || '' } : null; })()`;
function readMediaMeta(tab) {
  const wc = tab.view.webContents;
  if (wc.isDestroyed()) return;
  wc.executeJavaScript(MEDIA_META_JS).then((m) => { tab.mediaMeta = m; pushState(); }).catch(() => {});
}
// Use the site's own buttons when it has them (keeps its UI in sync), else the raw media element.
const MEDIA_CMD_JS = (cmd) => `(() => {
  const q = (sels) => { for (const s of sels) { const el = document.querySelector(s); if (el) return el; } return null; };
  const media = [...document.querySelectorAll('video, audio')];
  const PLAY = ['[data-testid="control-button-playpause"]', '.ytp-play-button', '.playControl', 'button[aria-label="Play"], button[aria-label="Pause"]'];
  const NEXT = ['[data-testid="control-button-skip-forward"]', '.ytp-next-button', '.skipControl__next', 'button[aria-label*="Next" i]'];
  const PREV = ['[data-testid="control-button-skip-back"]', '.ytp-prev-button', '.skipControl__previous', 'button[aria-label*="Previous" i]'];
  const cmd = ${JSON.stringify(cmd)};
  if (cmd === 'toggle') {
    const b = q(PLAY); if (b) { b.click(); return 'site'; }
    const on = media.find((m) => !m.paused);
    if (on) { media.forEach((m) => m.pause()); return 'paused'; }
    const m = media.find((x) => x.currentSrc) || media[0]; if (m) { m.play(); return 'playing'; } return 'none';
  }
  const b = q(cmd === 'next' ? NEXT : PREV); if (b) { b.click(); return 'site'; }
  const m = media.find((x) => !x.paused) || media[0];
  if (m && cmd === 'prev') { m.currentTime = 0; return 'restart'; }
  if (m && cmd === 'next' && isFinite(m.duration)) { m.currentTime = m.duration - 0.1; return 'end'; }
  return 'none';
})()`;
function mediaTab() { const t = getTab(mediaTabId); return t && !t.view.webContents.isDestroyed() ? t : null; }
ipcMain.on('media:cmd', (e, cmd) => {
  if (e.sender !== win.webContents) return;
  const t = mediaTab(); if (!t) return;
  const wc = t.view.webContents;
  if (cmd === 'mute') { wc.setAudioMuted(!wc.isAudioMuted()); pushState(); return; }
  if (cmd === 'focus') { activate(t.id); return; }
  if (['toggle', 'next', 'prev'].includes(cmd)) wc.executeJavaScript(MEDIA_CMD_JS(cmd), true).then(() => setTimeout(() => readMediaMeta(t), 800)).catch(() => {});
});
function mediaState() {
  const t = mediaTab();
  if (!t) return null;
  const m = t.mediaMeta;
  return {
    tabId: t.id, playing: !!t.mediaPlaying, muted: t.view.webContents.isAudioMuted(),
    title: (m && m.title) || t.title || 'Playing in a tab',
    artist: (m && m.artist) || hostOfUrl(t.url) || '',
  };
}

// ---------- music player: radio stream addresses + health ----------
// Stations can have several servers. SomaFM publishes its current server list in a
// .pls file per channel; Nightride serves each channel in a few formats. The player
// tries them in order, and a background check marks stations that are down.
const RADIO_TEST_BASE = process.env.NODEGRID_RADIO_TEST || '';      // (tests only: fake servers)
function somaFallback(ch) {
  return [`https://ice.somafm.com/${ch}`, `https://ice1.somafm.com/${ch}-128-mp3`, `https://ice2.somafm.com/${ch}-128-mp3`,
    `https://ice4.somafm.com/${ch}-128-mp3`, `https://ice6.somafm.com/${ch}-128-aac`];
}
const somaCache = new Map();          // channel -> { urls, at }
async function radioCandidates(st) {
  if (!st || typeof st !== 'object') return [];
  if (RADIO_TEST_BASE && (st.soma || st.nightride)) {
    const ch = st.soma || st.nightride;
    return [`${RADIO_TEST_BASE}/dead/${ch}`, `${RADIO_TEST_BASE}/live/${ch}`];
  }
  if (st.soma && /^[a-z0-9]{2,30}$/.test(st.soma)) {
    const ch = st.soma, c = somaCache.get(ch);
    if (c && Date.now() - c.at < 6 * 3600000) return c.urls;
    let urls = [];
    try {
      const r = await fetch(`https://somafm.com/${ch}.pls`, { signal: AbortSignal.timeout(4000) });
      if (r.ok) urls = [...(await r.text()).matchAll(/^File\d+=(\S+)/gim)].map((m) => m[1]).filter((u) => /^https?:\/\//.test(u));
    } catch {}
    urls = [...new Set([...urls.filter((u) => u.startsWith('https:')), ...somaFallback(ch)])];
    somaCache.set(ch, { urls, at: Date.now() });
    return urls;
  }
  if (st.nightride && /^[a-z0-9]{2,30}$/.test(st.nightride)) {
    const ch = st.nightride;
    return [`https://stream.nightride.fm/${ch}.mp3`, `https://stream.nightride.fm/${ch}.m4a`, `https://stream.nightride.fm/${ch}.ogg`];
  }
  return st.url && /^https?:\/\//i.test(st.url) ? [st.url] : [];
}
// Is anything there? Ask for the stream, look at the answer's headers, hang up.
async function streamAlive(url) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 6000);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { 'Icy-MetaData': '0' } });
    const type = (r.headers.get('content-type') || '').toLowerCase();
    ac.abort();
    return r.ok && /audio|ogg|mpeg|aac|octet-stream|video/.test(type);
  } catch { return false; } finally { clearTimeout(t); }
}
ipcMain.handle('radio:candidates', (e, st) => (e.sender === win.webContents ? radioCandidates(st) : []));
ipcMain.handle('radio:health', async (e, list) => {
  if (e.sender !== win.webContents || !Array.isArray(list)) return [];
  return Promise.all(list.slice(0, 40).map(async (st) => {
    if (st && st.yt) return true;                     // YouTube streams are checked when they play
    for (const u of (await radioCandidates(st)).slice(0, 3)) if (await streamAlive(u)) return true;
    return false;
  }));
});

// ---------- music player: YouTube live streams as radio stations ----------
// A YouTube stream isn't a plain audio stream, so it plays in a tiny 1x1 YouTube
// player tucked under everything. Its own in-memory storage, ad blocking on.
const RADIO_PARTITION = 'nodegrid-radio';
let ytView = null, ytVol = 0.7, ytStartTimer = null;
const ytEmbed = (id) => (process.env.NODEGRID_YT_EMBED || 'https://www.youtube.com/embed/') + encodeURIComponent(id) +
  '?autoplay=1&playsinline=1&rel=0&modestbranding=1';
const ytSend = (st) => { if (win && !win.isDestroyed()) win.webContents.send('yt-state', st); };
const YT_VOL_JS = (v) => `(() => { const m = document.querySelector('video, audio'); if (m) { m.volume = ${Number(v)}; m.muted = false; } })()`;
function ytStop() {
  clearTimeout(ytStartTimer);
  if (!ytView) return;
  try { win.contentView.removeChildView(ytView); } catch {}
  try { ytView.webContents.close(); } catch {}
  ytView = null;
}
function ytPlay(id) {
  ytStop();
  if (BUILD.noYouTubeRadio) { ytSend({ state: 'error' }); return; }
  if (!/^[\w-]{6,20}$/.test(id)) { ytSend({ state: 'error' }); return; }
  const v = ytView = new WebContentsView({ webPreferences: { partition: RADIO_PARTITION, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  v.setBounds({ x: 0, y: 0, width: 1, height: 1 });
  win.contentView.addChildView(v, 0);                  // bottom of the stack: never covers anything
  const wc = v.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('media-started-playing', () => { wc.executeJavaScript(YT_VOL_JS(ytVol)).catch(() => {}); ytSend({ state: 'playing' }); });
  wc.on('media-paused', () => ytSend({ state: 'paused' }));
  wc.on('did-fail-load', (_e, code, _d, _u, main) => { if (main && code !== -3) ytSend({ state: 'error' }); });
  wc.on('did-finish-load', () => {
    // If autoplay didn't kick in, press the big play button once.
    ytStartTimer = setTimeout(() => {
      if (ytView === v && !wc.isDestroyed()) wc.executeJavaScript(`(() => { const b = document.querySelector('.ytp-large-play-button, .ytp-play-button'); if (b) b.click(); else { const m = document.querySelector('video, audio'); if (m) m.play(); } })()`, true).catch(() => {});
    }, 2500);
  });
  ytSend({ state: 'connecting' });
  wc.loadURL(ytEmbed(id), { httpReferrer: { url: 'https://search.nullgrid.dev/', policy: 'unsafe-url' } }).catch(() => {});   // embeds need a referring site
}
ipcMain.on('yt:cmd', (e, cmd, arg) => {
  if (e.sender !== win.webContents) return;
  if (cmd === 'play') { ytVol = Math.min(1, Math.max(0, Number(arg && arg.vol) || ytVol)); ytPlay(String(arg && arg.id || '')); }
  if (cmd === 'stop') { ytStop(); ytSend({ state: 'stopped' }); }
  if (cmd === 'volume') { ytVol = Math.min(1, Math.max(0, Number(arg) || 0)); if (ytView) ytView.webContents.executeJavaScript(YT_VOL_JS(ytVol)).catch(() => {}); }
});

// ---------- sleeping tabs ----------
// Background tabs you haven't looked at for a while (20 seconds by default) unload
// their page to free memory; clicking the tab loads it again. Tabs playing sound, the
// game and the settings page never sleep. Right-click a tab to put it to sleep now.
const SLEEP_CHOICES = [0, 20, 60, 300, 900];             // seconds; 0 = never
const sleepAfter = () => (settings.sleepAfter === undefined ? 20 : SLEEP_CHOICES.includes(settings.sleepAfter) ? settings.sleepAfter : 20);
function canSleep(t, manual) {
  if (!t || t.sleeping || t.sim || t.peek || t.settingsTab || (t.pinned && featureOn('pinned'))) return false;
  if (!manual && t.id === activeId) return false;
  if (t.id === activeId) return false;                     // never the tab you're looking at
  const wc = t.view.webContents;
  if (wc.isDestroyed() || wc.isCurrentlyAudible() || t.mediaPlaying) return false;
  if (downloads.some((d) => d.state === 'progressing' && d.wcId === wc.id)) return false;
  return /^(https?|file):/i.test(t.url || '');
}
function sleepTab(t, manual) {
  if (!canSleep(t, manual)) return;
  const wc = t.view.webContents;
  t.sleeping = { url: t.url, title: t.title, favicon: t.favicon };
  t.loading = false;
  wc.loadURL('about:blank').catch(() => {});             // drops the page (and its memory); history stays
  pushState();
}
function dropBlankEntries(wc) {
  const h = wc.navigationHistory;
  if (!h || !h.removeEntryAtIndex) return;
  const entries = h.getAllEntries(), cur = h.getActiveIndex();
  for (let i = entries.length - 1; i >= 0; i--) if (i !== cur && entries[i].url === 'about:blank') { try { h.removeEntryAtIndex(i); } catch {} }
}
function wakeTab(t) {
  const s = t.sleeping; if (!s) return;
  t.sleeping = null;
  t.waking = true;
  t.title = s.title; t.favicon = s.favicon;
  t.view.webContents.loadURL(s.url).catch(() => {});
  pushState();
}
setInterval(() => {
  const after = sleepAfter() * 1000;
  if (!after) return;
  const now = Date.now();
  for (const t of tabs) if (t.id !== activeId && !t.sleeping && now - (t.lastActive || 0) > after && canSleep(t)) sleepTab(t);
}, 5000).unref();

// ---------- local devices with self-signed certificates ----------
// Homelab gear (Proxmox, routers, Pi-hole...) uses its own certificates. On LOCAL
// addresses only, the certificate error page offers "Proceed anyway"; the choice is
// remembered for that device AND that exact certificate (if it changes, you're asked again).
const certErrors = new Map();         // webContents id -> last certificate problem
const certTrustable = (h) => !!h && (isLocalHost(h) || !h.includes('.') || /\.(lan|home|home\.arpa|internal|localdomain|intranet|router|box)$/i.test(h));
app.on('certificate-error', (event, wc, url, error, cert, callback) => {
  if (event.defaultPrevented) return;
  let host = '';
  try { host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch {}
  const trusted = (settings.trustedCerts || {})[host];
  if (certTrustable(host) && trusted && trusted.fingerprint === cert.fingerprint) { event.preventDefault(); callback(true); return; }
  certErrors.set(wc.id, { url, host, error, fingerprint: cert.fingerprint, issuer: cert.issuerName || '', subject: cert.subjectName || '' });
  callback(false);
});
ipcMain.on('cert:trust', (e) => {
  if (!isErrorPage(e.sender.getURL())) return;
  const ce = certErrors.get(e.sender.id);
  if (!ce || !certTrustable(ce.host)) return;
  settings.trustedCerts = settings.trustedCerts || {};
  settings.trustedCerts[ce.host] = { fingerprint: ce.fingerprint, issuer: ce.issuer, subject: ce.subject, added: new Date().toISOString().slice(0, 10) };
  saveSettings();
  e.sender.loadURL(ce.url).catch(() => {});
});
ipcMain.on('cert:info', (e) => {
  const ce = isErrorPage(e.sender.getURL()) ? certErrors.get(e.sender.id) : null;
  e.returnValue = ce && certTrustable(ce.host) ? { host: ce.host, issuer: ce.issuer, fingerprint: ce.fingerprint, error: ce.error } : null;
});

// ---------- PIN lock for saved logins ----------
// Optional 4-8 digit PIN. Stored only as a salted scrypt hash. Unlocking lasts 5 minutes
// (each use extends it). 5 wrong tries = a 30 second wait. Forgot it = erase the logins.
let vaultUnlockedUntil = 0, pinFails = 0, pinLockedUntil = 0;
const pinSet = () => !!(settings.vaultPin && settings.vaultPin.hash);
const vaultLocked = () => pinSet() && Date.now() > vaultUnlockedUntil;
const touchUnlock = () => { if (pinSet()) vaultUnlockedUntil = Date.now() + 5 * 60000; };
const hashPin = (pin, salt) => crypto.scryptSync(String(pin), Buffer.from(salt, 'hex'), 32).toString('hex');
function pinMatches(pin) {
  if (!pinSet()) return false;
  const a = Buffer.from(hashPin(pin, settings.vaultPin.salt), 'hex'), b = Buffer.from(settings.vaultPin.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const validPin = (p) => /^\d{4,8}$/.test(String(p || ''));
function tryUnlock(pin) {
  if (Date.now() < pinLockedUntil) return { ok: false, wait: pinLockedUntil };
  if (pinMatches(pin)) { pinFails = 0; touchUnlock(); return { ok: true }; }
  pinFails++;
  if (pinFails >= 5) { pinFails = 0; pinLockedUntil = Date.now() + 30000; return { ok: false, wait: pinLockedUntil }; }
  return { ok: false, left: 5 - pinFails };
}
function setPin(oldPin, newPin) {
  if (pinSet() && !pinMatches(oldPin)) return { ok: false, reason: 'wrong' };
  if (!validPin(newPin)) return { ok: false, reason: 'format' };
  const salt = crypto.randomBytes(16).toString('hex');
  settings.vaultPin = { salt, hash: hashPin(newPin, salt) }; saveSettings();
  touchUnlock();
  return { ok: true };
}
function clearPin(pin) {
  if (!pinSet()) return { ok: true };
  if (!pinMatches(pin)) return { ok: false, reason: 'wrong' };
  delete settings.vaultPin; saveSettings();
  return { ok: true };
}
function forgotPin() { vault = []; saveVault(); delete settings.vaultPin; saveSettings(); vaultUnlockedUntil = 0; }
ipcMain.handle('vault:unlock', (e, pin) => { if (!isOverlay(e.sender, 'vault')) return { ok: false }; const r = tryUnlock(pin); sendVault(); return r; });
ipcMain.handle('vault:setpin', (e, oldPin, newPin) => { if (!isOverlay(e.sender, 'vault')) return { ok: false }; const r = setPin(oldPin, newPin); sendVault(); return r; });
ipcMain.handle('vault:forgot', (e) => { if (!isOverlay(e.sender, 'vault')) return false; forgotPin(); sendVault(); return true; });
ipcMain.on('vault:lock', (e) => { if (isOverlay(e.sender, 'vault')) { vaultUnlockedUntil = 0; sendVault(); } });

// ---------- print / save as PDF ----------
function printTab(t) {
  if (!t || t.sim) return;
  t.view.webContents.print({}, (ok, why) => { if (!ok && why && why !== 'cancelled') toast("Couldn't print: " + why); });
}
async function savePdf(t) {
  if (!t || t.sim) return;
  const wc = t.view.webContents;
  const base = (t.title || hostOfUrl(t.url) || 'page').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100).trim() || 'page';
  const dir = process.env.NODEGRID_DOWNLOADS || app.getPath('downloads');
  let file = process.env.NODEGRID_PDF_PATH;              // (tests only)
  if (!file) {
    const r = await dialog.showSaveDialog(win, { title: 'Save as PDF', defaultPath: path.join(dir, base + '.pdf'), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (r.canceled || !r.filePath) return;
    file = r.filePath;
  }
  try {
    const data = await wc.printToPDF({ printBackground: true, pageSize: 'A4' });
    await fs.promises.writeFile(file, data);
    toast('Saved PDF: ' + path.basename(file));
  } catch (err) { toast("Couldn't save the PDF"); }
}

// ---------- local AI chat (AI panel > LOCAL) ----------
// A small built-in chat page that talks to an AI running on your own PC or network:
// Ollama, LM Studio, LocalAI, llama.cpp server, Open WebUI's API, or anything that speaks
// the OpenAI chat format. The app makes the requests (so no browser CORS trouble).
// The conversation lives only in that page's memory.
const isLocalChat = (wc) => !!aiView && wc === aiView.webContents && wc.getURL().split(/[?#]/)[0] === LOCAL_AI_FILE;
const localChats = new Map();          // request id -> AbortController
const normBase = (u) => { let x = String(u || '').trim().replace(/\/+$/, ''); if (x && !/^https?:\/\//i.test(x)) x = 'http://' + x; return x.replace(/\/(v1|api)$/i, ''); };
function localKey() { try { return settings.localAiKey ? dec(settings.localAiKey) : ''; } catch { return ''; } }
async function probeLocal(base) {
  const key = localKey();
  const headers = key ? { Authorization: 'Bearer ' + key } : {};
  const get = async (p) => { const r = await fetch(base + p, { headers, signal: AbortSignal.timeout(2500) }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
  try { const j = await get('/api/tags'); if (Array.isArray(j.models)) return { url: base, kind: 'ollama', models: j.models.map((m) => m.name) }; } catch {}
  try { const j = await get('/v1/models'); if (Array.isArray(j.data)) return { url: base, kind: 'openai', models: j.data.map((m) => m.id) }; } catch {}
  return null;
}
ipcMain.handle('localai:detect', async (e, url) => {
  if (!isLocalChat(e.sender)) return null;
  const tries = url ? [normBase(url)] : [...new Set([settings.localAi, 'http://localhost:11434', 'http://localhost:1234', 'http://localhost:8080', 'http://localhost:5001'].filter(Boolean).map(normBase))];
  for (const base of tries) {
    const r = await probeLocal(base);
    if (r) { settings.localAi = base; saveSettings(); return r; }
  }
  return { error: url ? 'no-answer' : 'none-found', tried: tries };
});
ipcMain.handle('localai:setkey', (e, key) => {
  if (!isLocalChat(e.sender)) return false;
  if (!key) { delete settings.localAiKey; saveSettings(); return true; }
  if (!canEncrypt()) return false;
  settings.localAiKey = enc(String(key)); saveSettings(); return true;
});
ipcMain.handle('localai:haskey', (e) => isLocalChat(e.sender) && !!settings.localAiKey);
ipcMain.handle('localai:page', async (e) => {
  if (!isLocalChat(e.sender)) return null;
  const t = activeTab();
  if (!t || !/^https?:/i.test(t.url || '') || t.sleeping) return null;
  try {
    const text = await t.view.webContents.executeJavaScript('document.body ? document.body.innerText : ""');
    return { title: t.title, url: untranslate(t.url) || t.url, text: String(text).replace(/\n{3,}/g, '\n\n').slice(0, 12000) };
  } catch { return null; }
});
ipcMain.on('localai:chat', async (e, id, req) => {
  if (!isLocalChat(e.sender)) return;
  const wc = e.sender;
  const send = (ch, ...a) => { if (!wc.isDestroyed()) wc.send(ch, id, ...a); };
  const ac = new AbortController(); localChats.set(id, ac);
  const base = normBase(req.url), key = localKey();
  const headers = { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) };
  const messages = (req.messages || []).slice(-40).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user', content: String(m.content || '').slice(0, 60000) }));
  try {
    const ollama = req.kind === 'ollama';
    const res = await fetch(base + (ollama ? '/api/chat' : '/v1/chat/completions'), {
      method: 'POST', headers, signal: ac.signal,
      body: JSON.stringify({ model: req.model, messages, stream: true })
    });
    if (!res.ok) { send('localai-done', `The AI answered with HTTP ${res.status}. ${(await res.text().catch(() => '')).slice(0, 200)}`); return; }
    const dec8 = new TextDecoder(); let buf = '';
    for await (const chunk of res.body) {
      buf += dec8.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        if (!ollama) { if (!line.startsWith('data:')) continue; line = line.slice(5).trim(); if (line === '[DONE]') continue; }
        try {
          const j = JSON.parse(line);
          const piece = ollama ? (j.message && j.message.content) : (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content);
          if (piece) send('localai-chunk', piece);
          if (j.error) send('localai-chunk', '\n[' + (j.error.message || j.error) + ']');
        } catch {}
      }
    }
    send('localai-done', null);
  } catch (err) {
    send('localai-done', ac.signal.aborted ? null : "Couldn't reach the AI (" + (err.cause && err.cause.code || err.message) + ')');
  } finally { localChats.delete(id); }
});
ipcMain.on('localai:stop', (e, id) => { if (isLocalChat(e.sender)) { const ac = localChats.get(id); if (ac) ac.abort(); } });

// ---------- settings page (nodegrid://settings) ----------
const SETTINGS_PAGE = pathToFileURL(path.join(__dirname, 'settings.html')).href;
const isSettingsPage = (wc) => { const t = tabs.find((x) => x.view.webContents === wc); return !!t && t.settingsTab && wc.getURL().split(/[?#]/)[0] === SETTINGS_PAGE; };
function openSettings() {
  const t = tabs.find((x) => x.settingsTab);
  if (t) { activate(t.id); return t; }
  return newTab(SETTINGS_PAGE);
}
ipcMain.on('settings:open', (e) => { if (e.sender === win.webContents) openSettings(); });
function settingsModel() {
  return {
    version: APP_VERSION, dataDir: app.getPath('userData'), devMode,
    search: settings.searchPrefs || { engine: 'duckduckgo', vault: true },
    historyCount: history.length,
    adblock: { on: !settings.adblockOff, ready: !!blocker, paused: settings.adblockPaused || [] },
    permissions: Object.entries(settings.permissions || {}).map(([k, allow]) => { const i = k.lastIndexOf('|'); return { key: k, origin: k.slice(0, i), kind: k.slice(i + 1), allow }; }),
    certs: Object.entries(settings.trustedCerts || {}).map(([host, c]) => ({ host, issuer: c.issuer, added: c.added })),
    burnerMinutes: burnerMinutes(), burnerChoices: BURN_CHOICES,
    pin: { set: pinSet() }, logins: vault.length,
    dark: { on: darkOn(), except: settings.darkExcept || [] },
    translate: { lang: settings.translateLang || '', system: langName(systemLang()), langs: LANGS },
    ai: { provider: aiProvider(), custom: settings.aiCustom || '', local: settings.localAi || '' },
    sleep: { after: sleepAfter(), choices: SLEEP_CHOICES },
    drive: drive.status(),
    features: Object.entries(FEATURES).filter(([key]) => key !== 'sim' || SIM_AVAILABLE).map(([key, label]) => ({ key, label, on: featureOn(key) }))
  };
}
ipcMain.handle('settings:get', (e) => (isSettingsPage(e.sender) ? settingsModel() : null));
ipcMain.handle('settings:do', async (e, action, a, b) => {
  if (!isSettingsPage(e.sender)) return { ok: false };
  const ok = (extra) => { pushState(); return { ok: true, ...extra, model: settingsModel() }; };
  switch (action) {
    case 'search': if (!ENGINES.includes(a)) return { ok: false }; settings.searchPrefs = { engine: a, vault: !!b }; saveSettings(); return ok();
    case 'history-clear': history = []; saveHistory(); return ok();
    case 'adblock': settings.adblockOff = !a; saveSettings(); return ok();
    case 'adblock-resume': settings.adblockPaused = (settings.adblockPaused || []).filter((h) => h !== a); saveSettings(); return ok();
    case 'perm-remove': if (settings.permissions) delete settings.permissions[a]; saveSettings(); return ok();
    case 'perm-clear': settings.permissions = {}; sessionGrants.clear(); saveSettings(); return ok();
    case 'cert-remove': if (settings.trustedCerts) delete settings.trustedCerts[a]; saveSettings(); return ok();
    case 'burner': if (!BURN_CHOICES.includes(Number(a))) return { ok: false }; settings.burnerMinutes = Number(a); saveSettings(); return ok();
    case 'dark': settings.darkPages = !!a; saveSettings(); applyDarkAll(); return ok();
    case 'dark-unexcept': settings.darkExcept = (settings.darkExcept || []).filter((h) => h !== a); saveSettings(); applyDarkAll(); return ok();
    case 'translate': if (a && !LANGS.some(([k]) => k === a)) return { ok: false }; if (a) settings.translateLang = a; else delete settings.translateLang; saveSettings(); return ok();
    case 'ai-provider': if (!(a in AI_PROVIDERS || a === 'local' || (a === 'custom' && settings.aiCustom))) return { ok: false }; settings.aiProvider = a; saveSettings(); if (aiView) aiView.webContents.loadURL(aiUrl(a)).catch(() => {}); return ok();
    case 'ai-custom': {
      let u = String(a || '').trim();
      if (!u) { delete settings.aiCustom; if (settings.aiProvider === 'custom') settings.aiProvider = 'claude'; saveSettings(); return ok(); }
      if (!/^https?:\/\//i.test(u)) u = (LOCALISH.test(u) ? 'http://' : 'https://') + u;
      try { new URL(u); } catch { return { ok: false, reason: 'address' }; }
      settings.aiCustom = u; saveSettings(); return ok();
    }
    case 'local-ai': { const u = normBase(a); if (u) settings.localAi = u; else delete settings.localAi; saveSettings(); return ok(); }
    case 'sleep': if (!SLEEP_CHOICES.includes(Number(a))) return { ok: false }; settings.sleepAfter = Number(a); saveSettings(); return ok();
    case 'pin-set': { const r = setPin(a, b); return r.ok ? ok() : r; }
    case 'pin-clear': { const r = clearPin(a); return r.ok ? ok() : r; }
    case 'drive-connect': { const r = await drive.connect(a, b); return r.ok ? ok() : r; }
    case 'drive-retry': await drive.handshake(); return ok();
    case 'drive-disconnect': drive.disconnect(); return ok();
    case 'open-data': eshell.openPath(app.getPath('userData')); return ok();
    default: return { ok: false };
  }
});

// ---------- Null Drive (Vault search source) ----------
// The browser connects to your Null Drive itself (see null-drive.js). The results page on
// the NODE_GRID search site asks the browser for Drive matches through a small bridge;
// no other site gets it, and the search server never sees your Drive.
const drive = require('./null-drive')({
  getSettings: () => settings, saveSettings,
  enc: (t) => enc(t), dec: (b) => dec(b), canEncrypt: () => canEncrypt(),
  downloadsDir: () => app.getPath('downloads'),
  onChange: () => { for (const t of tabs) if (t.settingsTab && !t.view.webContents.isDestroyed()) t.view.webContents.send('settings-refresh'); }
});
const fromSearchPage = (e) => {
  try {
    if (!tabs.some((t) => t.view.webContents === e.sender)) return false;
    if (e.senderFrame && e.senderFrame !== e.sender.mainFrame) return false;
    return new URL(e.sender.getURL()).origin === new URL(SEARCH_ORIGIN).origin;
  } catch { return false; }
};
ipcMain.handle('drive:status', (e) => (fromSearchPage(e) ? drive.status() : null));
ipcMain.handle('drive:search', (e, q) => (fromSearchPage(e) ? drive.search(q) : { ok: false }));
ipcMain.handle('drive:view', (e, p) => (fromSearchPage(e) ? drive.view(p) : { ok: false }));
ipcMain.handle('drive:download', async (e, p) => {
  if (!fromSearchPage(e)) return { ok: false };
  const r = await drive.download(p);
  if (r.ok) toast('Saved to Downloads: ' + r.name);
  return r.ok ? { ok: true, name: r.name } : r;
});
ipcMain.on('drive:show-download', (e, name) => {
  if (!fromSearchPage(e)) return;
  const f = path.join(app.getPath('downloads'), path.basename(String(name || '')));
  if (fs.existsSync(f)) eshell.showItemInFolder(f);
});

// ---------- pinned tabs ----------
// Small icon tabs at the top of the sidebar. They never sleep and come back when the app
// starts (their addresses are a setting you chose; nothing else is stored).
function savePins() {
  settings.pinned = tabs.filter((t) => t.pinned).map((t) => untranslate(t.url) || t.url).filter((u) => /^https?:\/\//i.test(u));
  saveSettings();
}
function setPinned(t, on) {
  if (!t) return;
  t.pinned = !!on;
  if (on) {                                   // pinned tabs live at the top
    tabs.splice(tabs.indexOf(t), 1);
    const at = tabs.filter((x) => x.pinned).length;
    tabs.splice(at, 0, t);
    if (t.sleeping) wakeTab(t);
  }
  savePins(); pushState();
}

// ---------- reader mode (+ Markdown) ----------
// Uses Mozilla's Readability (the engine behind Firefox's reader view) inside the page,
// in an isolated world, to pull out the article. The reader page shows it cleaned up.
const READER_PAGE = pathToFileURL(path.join(__dirname, 'reader.html')).href;
const isReaderPage = (u) => typeof u === 'string' && u.startsWith(READER_PAGE);
let READABILITY_SRC = '', READERABLE_SRC = '', MDCONVERT_SRC = '';
try {
  const dir = path.dirname(require.resolve('@mozilla/readability/package.json'));
  READABILITY_SRC = fs.readFileSync(path.join(dir, 'Readability.js'), 'utf8');
  READERABLE_SRC = fs.readFileSync(path.join(dir, 'Readability-readerable.js'), 'utf8');
  MDCONVERT_SRC = fs.readFileSync(path.join(__dirname, 'md-convert.js'), 'utf8');
} catch (err) { console.error('Reader mode unavailable:', err.message); }
const readerDocs = new Map();     // id -> article (memory only)
function checkReaderable(tab) {
  if (!READERABLE_SRC || !(featureOn('reader') || featureOn('md'))) return;
  const wc = tab.view.webContents;
  if (!/^https?:/i.test(wc.getURL())) { if (tab.readerable) { tab.readerable = false; pushState(); } return; }
  wc.executeJavaScriptInIsolatedWorld(1014, [{ code: READERABLE_SRC + '\n;isProbablyReaderable(document, { minContentLength: 140, minScore: 20 })' }])
    .then((r) => { if (!!r !== !!tab.readerable) { tab.readerable = !!r; pushState(); } }).catch(() => {});
}
async function extractArticle(tab, wantMd) {
  if (!READABILITY_SRC) return null;
  const code = READABILITY_SRC + '\n' + (wantMd ? MDCONVERT_SRC : '') + `
  ;(() => {
    const a = new Readability(document.cloneNode(true), { charThreshold: 300 }).parse();
    if (!a) return null;
    const out = { title: a.title || document.title, byline: a.byline || '', siteName: a.siteName || '', excerpt: a.excerpt || '',
      content: a.content || '', length: a.length || 0, lang: a.lang || document.documentElement.lang || '', published: a.publishedTime || '' };
    ${wantMd ? `const box = document.createElement('div'); box.innerHTML = a.content; out.markdown = nodegridToMarkdown(box, location.href);` : ''}
    return out;
  })()`;
  try { return await tab.view.webContents.executeJavaScriptInIsolatedWorld(1014, [{ code }]); } catch { return null; }
}
async function toggleReader(tab) {
  if (!tab || !featureOn('reader')) return;
  if (tab.reader) {                         // back to the real page
    const h = tab.view.webContents.navigationHistory;
    if (h.canGoBack()) h.goBack(); else loadInTab(tab, tab.readerUrl);
    return;
  }
  const art = await extractArticle(tab, false);
  if (!art || !art.content) { toast("This page doesn't have an article to read"); return; }
  const id = crypto.randomBytes(8).toString('hex');
  readerDocs.set(id, { ...art, url: untranslate(tab.url) || tab.url, favicon: tab.favicon });
  if (readerDocs.size > 30) readerDocs.delete(readerDocs.keys().next().value);
  tab.readerUrl = tab.url;
  tab.view.webContents.loadURL(READER_PAGE + '?id=' + id).catch(() => {});
}
ipcMain.on('reader:toggle', (e) => { if (e.sender === win.webContents) toggleReader(activeTab()); });
const readerSender = (wc) => isReaderPage(wc.getURL());
ipcMain.on('reader:get', (e, id) => {
  e.returnValue = readerSender(e.sender) ? { article: readerDocs.get(String(id)) || null, prefs: settings.reader || {}, md: featureOn('md') && featureOn('saved') } : null;
});
ipcMain.on('reader:prefs', (e, p) => {
  if (!readerSender(e.sender) || !p || typeof p !== 'object') return;
  settings.reader = { size: Math.min(28, Math.max(14, Number(p.size) || 20)), width: ['narrow', 'normal', 'wide'].includes(p.width) ? p.width : 'normal', theme: ['neon', 'paper', 'sepia'].includes(p.theme) ? p.theme : 'neon' };
  saveSettings();
});
ipcMain.on('reader:exit', (e) => { const t = tabs.find((x) => x.view.webContents === e.sender); if (t && readerSender(e.sender)) toggleReader(t); });
function writeMarkdown(id, art) {
  try {
    fs.mkdirSync(SAVED_DIR(), { recursive: true });
    const q = (x) => JSON.stringify(String(x || ''));
    const front = ['---', `title: ${q(art.title)}`, `source: ${q(art.url)}`, art.byline ? `author: ${q(art.byline)}` : null, art.siteName ? `site: ${q(art.siteName)}` : null,
      `saved: ${new Date().toISOString()}`, '---', '', `# ${art.title || ''}`, '', art.byline ? `*${art.byline}*\n` : null].filter((x) => x !== null).join('\n');
    fs.writeFileSync(path.join(SAVED_DIR(), id + '.md'), front + '\n' + art.markdown + '\n');
    return true;
  } catch { return false; }
}
ipcMain.handle('reader:save-md', (e, id, markdown) => {
  if (!readerSender(e.sender) || !featureOn('md') || !featureOn('saved')) return { ok: false };
  const art = readerDocs.get(String(id)); if (!art) return { ok: false };
  let entry = saved.find((x) => normUrl(x.url) === normUrl(art.url));
  const sid = entry ? entry.id : Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  if (!writeMarkdown(sid, { ...art, markdown: String(markdown || '').slice(0, 3e6) })) return { ok: false };
  const rec = { id: sid, url: art.url, title: (art.title || hostOfUrl(art.url)).slice(0, 200), host: hostOfUrl(art.url), savedAt: new Date().toISOString(), md: sid + '.md' };
  if (entry) Object.assign(entry, { ...rec, file: entry.file }); else saved.unshift({ ...rec, file: null });
  writeSaved(); pushState();
  return { ok: true };
});

// ---------- picture-in-picture ----------
const PIP_JS = `(() => {
  if (document.pictureInPictureElement) { document.exitPictureInPicture(); return 'off'; }
  const vids = [...document.querySelectorAll('video')].filter((v) => v.readyState > 0 && !v.disablePictureInPicture);
  vids.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));
  const v = vids.find((x) => !x.paused) || vids[0];
  if (!v) return 'none';
  return v.requestPictureInPicture().then(() => 'on', (e) => 'error:' + e.message);
})()`;
async function togglePip(tab) {
  if (!tab || !featureOn('pip')) return;
  const r = await tab.view.webContents.executeJavaScript(PIP_JS, true).catch((e) => 'error:' + e.message);
  if (r === 'none') toast('No video to pop out on this page');
  else if (String(r).startsWith('error')) toast("This video can't be popped out");
}
ipcMain.on('pip:toggle', (e) => { if (e.sender === win.webContents) togglePip(activeTab()); });

// ---------- QR code: send this page to your phone ----------
let QRCode = null;
try { QRCode = require('qrcode'); } catch {}
function qrBounds() {
  const w = 300, h = 400;
  return { x: Math.round(viewport.x + viewport.width - w - 10), y: Math.round(viewport.y + 8), width: w, height: h };
}
async function openQr(tab) {
  if (!tab || !QRCode || !featureOn('qr')) return;
  const url = untranslate(tab.url) || tab.url;
  if (!/^https?:/i.test(url || '')) return;
  dropOverlay('qr');
  const svg = await QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#0a0a0fff', light: '#e6f6ffff' } }).catch(() => null);
  if (!svg) return;
  const v = overlays.qr = makeOverlay('qr.html', 'qr-preload.js');
  v.setBounds(qrBounds());
  raiseOverlays();
  let host = ''; try { host = new URL(url).hostname; } catch {}
  v.webContents.once('did-finish-load', () => { if (overlays.qr === v) v.webContents.send('qr-show', { svg, url, title: tab.title || '', local: isLocalHost(host) }); });
}
ipcMain.on('qr:close', (e) => { if (isOverlay(e.sender, 'qr')) { dropOverlay('qr'); focusPage(); } });
ipcMain.on('qr:copy', (e, text) => { if (isOverlay(e.sender, 'qr')) clipboard.writeText(String(text).slice(0, 4000)); });
ipcMain.on('qr:open', (e) => { if (e.sender === win.webContents) openQr(activeTab()); });

// ---------- settings: feature switches ----------
ipcMain.handle('settings:feature', (e, key, on) => {
  if (!isSettingsPage(e.sender) || !(key in FEATURES)) return { ok: false };
  settings.features = settings.features || {};
  if (on) delete settings.features[key]; else settings.features[key] = false;
  saveSettings();
  // switching things off cleans up after them
  if (!on && key === 'dark') applyDarkAll();
  if (on && key === 'dark') applyDarkAll();
  if (!on && key === 'eggs') placePixel();
  if (on && key === 'eggs') placePixel();
  if (!on && key === 'burner') [...burners.keys()].forEach((p) => burnGroup(p, false));
  if (!on && key === 'sim') tabs.filter((t) => t.sim).map((t) => t.id).forEach(closeTab);
  if (!on && key === 'mobile') tabs.filter((t) => t.mobile).forEach((t) => setMobile(t, false));
  if (!on && key === 'qr') dropOverlay('qr');
  if (!on && key === 'recon') dropOverlay('recon');
  if (!on && key === 'pinned') pushState();
  if (key === 'gear') placeGear();
  pushState();
  return { ok: true, model: settingsModel() };
});

// ---------- developer mode: mobile view ----------
// Right-click > Mobile view (only once the "//" logo unlocked developer mode).
// The tab shrinks to a phone-width column and tells sites it is a phone: mobile
// screen size, touch input, and a phone browser's user agent. Toggle it off again
// from the same menu.
let devMode = false;
ipcMain.on('dev:mode', (e, on) => {
  if (e.sender !== win.webContents) return;
  devMode = !!on;
  if (!devMode) tabs.filter((t) => t.sim).map((t) => t.id).forEach(closeTab);   // leaving dev mode closes the game
});
const PHONE = { width: 390, height: 844 };
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
function tabBounds(t) {
  if (!t || !t.mobile) return viewport;
  const w = Math.min(PHONE.width, viewport.width);
  return { x: Math.round(viewport.x + (viewport.width - w) / 2), y: viewport.y, width: w, height: viewport.height };
}
function mobileMetrics(t) {
  const d = t.view.webContents.debugger, b = tabBounds(t);
  if (!d.isAttached()) return Promise.resolve();
  return d.sendCommand('Emulation.setDeviceMetricsOverride', {
    width: b.width, height: b.height, deviceScaleFactor: 0, mobile: true,
    screenWidth: PHONE.width, screenHeight: PHONE.height
  }).catch(() => {});
}
async function setMobile(t, on) {
  if (!t || t.peek || t.sim) return;
  const wc = t.view.webContents, d = wc.debugger;
  if (on) {
    try { if (!d.isAttached()) d.attach('1.3'); } catch { return; }      // (fails if Inspect is open on this tab)
    t.mobile = true;
    await mobileMetrics(t);
    await d.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }).catch(() => {});
    await d.sendCommand('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' }).catch(() => {});
    await d.sendCommand('Emulation.setUserAgentOverride', { userAgent: MOBILE_UA, platform: 'Linux armv8l',
      userAgentMetadata: { platform: 'Android', platformVersion: '14', architecture: '', model: 'Pixel 8', mobile: true,
        brands: [{ brand: 'Chromium', version: '130' }] } }).catch(() => {});
  } else {
    t.mobile = false;
    try { if (d.isAttached()) d.detach(); } catch {}                   // detaching drops every override
  }
  t.view.setBounds(tabBounds(t));
  if (/^https?:/i.test(wc.getURL())) wc.reload();                      // sites pick their mobile layout on load
  pushState();
}

// ---------- dark pages ----------
// Turns bright websites dark by inverting them (pictures and video are flipped back so
// they look normal). Sites that are already dark are left alone. On/off and per-site
// exceptions are local settings.
const DARK_CSS = `
html { filter: invert(1) hue-rotate(180deg) !important; background: #f2f2f2 !important; }
img, video, picture, canvas, iframe, embed, object, svg image, [style*="background-image"] {
  filter: invert(1) hue-rotate(180deg) !important; }`;
const BG_LUMA_JS = `(() => {
  const bg = (el) => el ? getComputedStyle(el).backgroundColor : '';
  const parse = (c) => { const m = (c || '').match(/[\\d.]+/g); if (!m) return null; const [r, g, b, a = 1] = m.map(Number); return a < 0.1 ? null : (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
  const v = parse(bg(document.body)); if (v !== null) return v;
  const w = parse(bg(document.documentElement)); return w === null ? 1 : w;
})()`;
const darkOn = () => !!settings.darkPages && featureOn('dark');
const darkExcluded = (u) => { const h = siteHost(u); return !!h && (settings.darkExcept || []).includes(h); };
async function applyDark(tab) {
  if (!tab || tab.peek || tab.sim) return;
  const wc = tab.view.webContents;
  if (wc.isDestroyed()) return;
  const want = darkOn() && /^https?:/i.test(wc.getURL()) && !darkExcluded(wc.getURL());
  const gen = tab.darkGen = (tab.darkGen || 0) + 1;     // a newer call wins over one still in flight
  if (!want) {
    for (const k of tab.darkKeys || []) wc.removeInsertedCSS(k).catch(() => {});
    tab.darkKeys = [];
    return;
  }
  if ((tab.darkKeys || []).length) return;
  const luma = await wc.executeJavaScriptInIsolatedWorld(1013, [{ code: BG_LUMA_JS }]).catch(() => 1);
  if (gen !== tab.darkGen || luma < 0.45 || wc.isDestroyed()) return;   // superseded, or already a dark site
  const key = await wc.insertCSS(DARK_CSS).catch(() => null);
  if (!key) return;
  if (gen !== tab.darkGen) { wc.removeInsertedCSS(key).catch(() => {}); return; }
  tab.darkKeys = [key];
}
const applyDarkAll = () => { for (const t of tabs) applyDark(t); };
function toggleDark() { settings.darkPages = !darkOn(); saveSettings(); applyDarkAll(); pushState(); }
function darkMenu() {
  const t = activeTab(), h = t && siteHost(t.url);
  const items = [{ label: 'Dark pages', type: 'checkbox', checked: darkOn(), click: toggleDark }];
  if (h) items.push(SEP, { label: `Keep ${h} as it is`, type: 'checkbox', checked: darkExcluded(t.url), click: () => {
    const list = new Set(settings.darkExcept || []);
    if (list.has(h)) list.delete(h); else list.add(h);
    settings.darkExcept = [...list]; saveSettings(); applyDarkAll(); pushState();
  } });
  popup(items);
}
ipcMain.on('dark:toggle', (e) => { if (e.sender === win.webContents) { toggleDark(); focusPage(); } });
ipcMain.on('dark:menu', (e) => { if (e.sender === win.webContents) darkMenu(); });

// ---------- translate page ----------
// Uses Google's page translator (no account, no key): the page address is sent to
// Google, which returns the page in your language. Local / homelab addresses can't be
// reached by Google, so the button is off there.
const LANGS = [
  ['en', 'English'], ['pl', 'Polish'], ['es', 'Spanish'], ['de', 'German'], ['fr', 'French'],
  ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['uk', 'Ukrainian'], ['ru', 'Russian'],
  ['tr', 'Turkish'], ['ar', 'Arabic'], ['hi', 'Hindi'], ['zh-CN', 'Chinese (Simplified)'],
  ['ja', 'Japanese'], ['ko', 'Korean'], ['vi', 'Vietnamese'], ['tl', 'Filipino']
];
const langName = (c) => (LANGS.find(([k]) => k === c) || [c, c])[1];
function systemLang() {
  const raw = ((app.getPreferredSystemLanguages && app.getPreferredSystemLanguages()[0]) || app.getLocale() || 'en');
  if (/^zh/i.test(raw)) return 'zh-CN';
  const base = raw.split(/[-_]/)[0].toLowerCase();
  return LANGS.some(([k]) => k === base) ? base : 'en';
}
const targetLang = () => (settings.translateLang && LANGS.some(([k]) => k === settings.translateLang)) ? settings.translateLang : systemLang();

function isTranslatedHost(h) { return /\.translate\.goog$/i.test(h) || h === 'translate.google.com' || h === 'translate.googleusercontent.com'; }
// www-example--site-com.translate.goog/path?_x_tr_tl=pl  ->  https://www.example-site.com/path
function untranslate(u) {
  try {
    const x = new URL(u);
    if (/\.translate\.goog$/i.test(x.hostname)) {
      const host = x.hostname.replace(/\.translate\.goog$/i, '').replace(/--/g, '\u0000').replace(/-/g, '.').replace(/\u0000/g, '-');
      for (const k of [...x.searchParams.keys()]) if (k.startsWith('_x_tr_')) x.searchParams.delete(k);
      return 'https://' + host + x.pathname + (x.searchParams.toString() ? '?' + x.searchParams.toString() : '') + x.hash;
    }
    if (x.hostname === 'translate.google.com' && x.searchParams.get('u')) return x.searchParams.get('u');
  } catch {}
  return null;
}
function translatable(t) {
  if (!t || t.peek || t.sim || !featureOn('translate')) return false;
  try { const x = new URL(t.url); return /^https?:$/.test(x.protocol) && !isLocalHost(x.hostname.toLowerCase()); } catch { return false; }
}
function translateTab(t) {
  if (!t) return;
  const orig = untranslate(t.url);
  if (orig) { loadInTab(t, orig); return; }                       // translated already -> show the original
  if (!translatable(t)) return;
  const tl = targetLang();
  loadInTab(t, 'https://translate.google.com/translate?' + new URLSearchParams({ sl: 'auto', tl, hl: tl, u: t.url }).toString());
}
function translateMenu() {
  const cur = targetLang(), sys = systemLang();
  const items = [{ label: `System language (${langName(sys)})`, type: 'radio', checked: !settings.translateLang,
    click: () => { delete settings.translateLang; saveSettings(); pushState(); } }, SEP];
  for (const [k, name] of LANGS) items.push({ label: name, type: 'radio', checked: !!settings.translateLang && cur === k,
    click: () => { settings.translateLang = k; saveSettings(); pushState(); } });
  popup(items);
}
ipcMain.on('translate:go', (e) => { if (e.sender === win.webContents) { translateTab(activeTab()); focusPage(); } });
ipcMain.on('translate:menu', (e) => { if (e.sender === win.webContents) translateMenu(); });

// ---------- 4. find in page ----------
// (Electron's own findNext flag means "start a new search", the opposite of how it reads,
// so `step` here = Enter/arrows moving between matches of the same text.)
ipcMain.on('find:go', (e, text, forward, step) => {
  const t = activeTab();
  if (!t || e.sender !== win.webContents) return;
  if (!text) { t.view.webContents.stopFindInPage('clearSelection'); win.webContents.send('find-result', { active: 0, total: 0 }); return; }
  t.view.webContents.findInPage(text, { forward: forward !== false, findNext: !step });
});
ipcMain.on('find:stop', (e) => {
  if (e.sender !== win.webContents) return;
  for (const t of tabs) try { t.view.webContents.stopFindInPage('keepSelection'); } catch {}
  focusPage();
});

// ---------- 5. downloads ----------
// Straight to the Downloads folder. The list lives in memory only (no download history).
const downloads = [];
let nextDl = 1, dlPushTimer = null;
function uniqueName(dir, name) {
  const safe = (name || 'download').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180) || 'download';
  if (!fs.existsSync(path.join(dir, safe))) return safe;
  const ext = path.extname(safe), base = safe.slice(0, safe.length - ext.length);
  for (let i = 1; i < 1000; i++) { const n = `${base} (${i})${ext}`; if (!fs.existsSync(path.join(dir, n))) return n; }
  return `${base}-${Date.now()}${ext}`;
}
const dlView = () => downloads.map(({ id, name, received, total, state }) => ({ id, name, received, total, state }));
function pushDownloads(now) {
  if (!win || win.isDestroyed()) return;
  if (now) { clearTimeout(dlPushTimer); dlPushTimer = null; win.webContents.send('downloads', dlView()); return; }
  if (!dlPushTimer) dlPushTimer = setTimeout(() => { dlPushTimer = null; if (win && !win.isDestroyed()) win.webContents.send('downloads', dlView()); }, 250);
}
function setupDownloads(ses, { peek = false } = {}) {
  ses.on('will-download', (_e, item, srcWc) => {
    if (peek) { item.cancel(); return; }                      // Peek is look-only
    const dir = process.env.NODEGRID_DOWNLOADS || app.getPath('downloads');
    const name = uniqueName(dir, item.getFilename());
    const full = path.join(dir, name);
    item.setSavePath(full);
    const d = { id: nextDl++, wcId: srcWc ? srcWc.id : 0, name, path: full, received: 0, total: item.getTotalBytes(), state: 'progressing', item };
    downloads.unshift(d);
    item.on('updated', (_ev, state) => {
      d.received = item.getReceivedBytes(); d.total = item.getTotalBytes();
      d.state = state === 'interrupted' ? 'interrupted' : 'progressing';
      pushDownloads();
    });
    item.once('done', (_ev, state) => {
      d.received = item.getReceivedBytes(); d.state = state; d.item = null;   // completed | cancelled | interrupted
      pushDownloads(true);
      if (win && !win.isDestroyed()) win.webContents.send('download-done', { name, state });
    });
    pushDownloads(true);
    if (win && !win.isDestroyed()) win.webContents.send('download-started', { name });
  });
}
const dlById = (id) => downloads.find((d) => d.id === id);
ipcMain.on('dl:open', (e, id) => { const d = dlById(id); if (e.sender === win.webContents && d && d.state === 'completed') eshell.openPath(d.path); });
ipcMain.on('dl:show', (e, id) => { const d = dlById(id); if (e.sender === win.webContents && d && d.state === 'completed') eshell.showItemInFolder(d.path); });
ipcMain.on('dl:cancel', (e, id) => { const d = dlById(id); if (e.sender === win.webContents && d && d.item) d.item.cancel(); });
ipcMain.on('dl:remove', (e, id) => {
  if (e.sender !== win.webContents) return;
  const i = downloads.findIndex((d) => d.id === id);
  if (i >= 0 && downloads[i].state !== 'progressing') { downloads.splice(i, 1); pushDownloads(true); }
});
ipcMain.on('dl:clear', (e) => {
  if (e.sender !== win.webContents) return;
  for (let i = downloads.length - 1; i >= 0; i--) if (downloads[i].state !== 'progressing') downloads.splice(i, 1);
  pushDownloads(true);
});

// ---------- 7. password vault (key icon) ----------
// Logins are encrypted with the OS (Windows DPAPI via safeStorage), tied to the Windows
// user. No cookies, nothing in the browsing session. Passwords never reach the popover:
// filling and copying happen here in the main process.
const VAULT_FILE = () => process.env.NODEGRID_VAULT || path.join(app.getPath('userData'), 'vault.json');
let vault = [];               // [{ id, host, user, pass (encrypted, base64) }]
let nextVaultId = 1;
if (process.env.NODEGRID_TEST_PLAINTEXT_VAULT && process.platform === 'linux') {
  app.whenReady().then(() => { try { safeStorage.setUsePlainTextEncryption(true); } catch {} });   // test machines only
}
const canEncrypt = () => { try { return safeStorage.isEncryptionAvailable() || !!process.env.NODEGRID_TEST_PLAINTEXT_VAULT; } catch { return false; } };
const enc = (t) => safeStorage.encryptString(String(t)).toString('base64');
const dec = (b) => safeStorage.decryptString(Buffer.from(b, 'base64'));
function loadVault() {
  try {
    const data = JSON.parse(fs.readFileSync(VAULT_FILE(), 'utf8'));
    vault = (Array.isArray(data) ? data : []).filter((v) => v && v.host && typeof v.pass === 'string')
      .map((v) => ({ id: nextVaultId++, host: String(v.host).toLowerCase(), user: String(v.user || ''), pass: v.pass }));
  } catch { vault = []; }
}
function saveVault() {
  try {
    const tmp = VAULT_FILE() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(vault.map(({ host, user, pass }) => ({ host, user, pass })), null, 1));
    fs.renameSync(tmp, VAULT_FILE());
  } catch (err) { console.error('Could not save vault:', err.message); }
}
const siteHost = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.hostname.toLowerCase().replace(/^www\./, '') : ''; } catch { return ''; } };
const normHost = (h) => String(h || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^www\./, '');
const hostMatch = (entryHost, pageHost) => !!pageHost && (entryHost === pageHost || pageHost.endsWith('.' + entryHost) || entryHost.endsWith('.' + pageHost));

function vaultState() {
  const t = activeTab();
  const host = t ? siteHost(t.url) : '';
  return {
    host,
    canEncrypt: canEncrypt(),
    pinSet: pinSet(),
    passgen: featureOn('passgen'),
    locked: vaultLocked(),
    waitUntil: pinLockedUntil > Date.now() ? pinLockedUntil : 0,
    entries: vaultLocked() ? [] : vault.map(({ id, host: h, user }) => ({ id, host: h, user, match: hostMatch(h, host) }))
  };
}
function sendVault() { if (overlays.vault) overlays.vault.webContents.send('vault-state', vaultState()); }

let vaultAnchor = null;
function vaultBounds() {
  const w = 340, h = Math.min(470, Math.max(240, viewport.height - 16));
  const right = vaultAnchor ? vaultAnchor.right : viewport.x + viewport.width - 10;
  return { x: Math.round(Math.max(viewport.x + 6, right - w)), y: Math.round(viewport.y + 6), width: w, height: Math.round(h) };
}
function openVault(anchor) {
  if (overlays.vault) { dropOverlay('vault'); return; }       // the key toggles it
  vaultAnchor = anchor || null;
  overlays.vault = makeOverlay('vault.html', 'vault-preload.js');
  overlays.vault.setBounds(vaultBounds());
  overlays.vault.webContents.once('did-finish-load', () => { sendVault(); overlays.vault && overlays.vault.webContents.focus(); });
  raiseOverlays();
}
ipcMain.on('vault:toggle', (e, anchor) => { if (e.sender === win.webContents) openVault(anchor); });
ipcMain.on('vault:close', (e) => { if (isOverlay(e.sender, 'vault')) { dropOverlay('vault'); focusPage(); } });

// Fill a login into the current page (top frame), in an isolated world.
const FILL_JS = (user, pass) => `(() => {
  const vis = (el) => !!el && !el.disabled && !el.readOnly && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const set = (el, v) => {
    el.focus();
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    desc.set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const pw = [...document.querySelectorAll('input[type=password]')].find(vis);
  const textLike = (el) => vis(el) && /^(text|email|tel|)$/i.test(el.getAttribute('type') || '') && !/search/i.test(el.name + el.id);
  let userEl = null;
  if (pw) {
    const scope = pw.form || document;
    const all = [...scope.querySelectorAll('input')];
    const before = all.slice(0, all.indexOf(pw)).filter(textLike);
    userEl = before[before.length - 1] || null;
  } else {
    userEl = [...document.querySelectorAll('input')].find((el) => textLike(el) && /user|login|email|account|identifier/i.test(el.name + ' ' + el.id + ' ' + el.autocomplete + ' ' + el.type)) || null;
  }
  if (userEl && ${JSON.stringify(user)}) set(userEl, ${JSON.stringify(user)});
  if (pw) set(pw, ${JSON.stringify(pass)});
  return { user: !!userEl, pass: !!pw };
})()`;

ipcMain.handle('vault:fill', async (e, id, force) => {
  if (!isOverlay(e.sender, 'vault')) return { ok: false };
  if (vaultLocked()) return { ok: false, reason: 'locked' };
  touchUnlock();
  const v = vault.find((x) => x.id === id), t = activeTab();
  if (!v || !t) return { ok: false };
  const pageHost = siteHost(t.url);
  if (!pageHost) return { ok: false, reason: 'not-a-site' };
  if (!hostMatch(v.host, pageHost) && !force) return { ok: false, mismatch: true, entryHost: v.host, pageHost };
  let pass;
  try { pass = dec(v.pass); } catch { return { ok: false, reason: 'decrypt' }; }
  try {
    const r = await t.view.webContents.executeJavaScriptInIsolatedWorld(1012, [{ code: FILL_JS(v.user, pass) }]);
    pass = null;
    if (r && (r.user || r.pass)) { dropOverlay('vault'); focusPage(); return { ok: true, ...r }; }
    return { ok: false, reason: 'no-fields' };
  } catch { return { ok: false, reason: 'page' }; }
});
ipcMain.handle('vault:copy', (e, id, what) => {
  if (!isOverlay(e.sender, 'vault')) return false;
  if (vaultLocked()) return false;
  touchUnlock();
  const v = vault.find((x) => x.id === id);
  if (!v) return false;
  if (what === 'user') { clipboard.writeText(v.user); return true; }
  try {
    const p = dec(v.pass);
    clipboard.writeText(p);
    setTimeout(() => { try { if (clipboard.readText() === p) clipboard.clear(); } catch {} }, 30000);   // wipe after 30s
    return true;
  } catch { return false; }
});
ipcMain.handle('vault:save', (e, entry) => {
  if (!isOverlay(e.sender, 'vault')) return { ok: false };
  if (vaultLocked()) return { ok: false, reason: 'locked' };
  touchUnlock();
  if (!canEncrypt()) return { ok: false, reason: 'no-encryption' };
  const host = normHost(entry && entry.host), user = String((entry && entry.user) || '').trim();
  const pass = entry && typeof entry.pass === 'string' ? entry.pass : '';
  if (!host) return { ok: false, reason: 'host' };
  if (entry.id) {
    const v = vault.find((x) => x.id === entry.id);
    if (!v) return { ok: false };
    v.host = host; v.user = user;
    if (pass) v.pass = enc(pass);                             // blank = keep the old password
  } else {
    if (!pass) return { ok: false, reason: 'pass' };
    vault.push({ id: nextVaultId++, host, user, pass: enc(pass) });
  }
  saveVault(); sendVault();
  return { ok: true };
});
ipcMain.handle('vault:delete', (e, id) => {
  if (!isOverlay(e.sender, 'vault')) return false;
  if (vaultLocked()) return false;
  touchUnlock();
  vault = vault.filter((x) => x.id !== id); saveVault(); sendVault();
  return true;
});
ipcMain.handle('vault:reveal', (e, id) => {
  if (!isOverlay(e.sender, 'vault')) return null;
  if (vaultLocked()) return null;
  touchUnlock();
  const v = vault.find((x) => x.id === id);
  try { return v ? dec(v.pass) : null; } catch { return null; }
});
// "Use what's typed on this page": read the current page's login fields
ipcMain.handle('vault:grab', async (e) => {
  if (!isOverlay(e.sender, 'vault')) return null;
  if (vaultLocked()) return null;
  touchUnlock();
  const t = activeTab();
  if (!t || !siteHost(t.url)) return null;
  try {
    return await t.view.webContents.executeJavaScriptInIsolatedWorld(1012, [{ code: `(() => {
      const pw = [...document.querySelectorAll('input[type=password]')].find((el) => el.value);
      let user = '';
      const scope = (pw && pw.form) || document;
      const cands = [...scope.querySelectorAll('input')].filter((el) => /^(text|email|tel|)$/i.test(el.getAttribute('type') || '') && el.value);
      if (cands.length) user = cands[cands.length - 1].value;
      return { host: location.hostname.replace(/^www\\./, ''), user, pass: pw ? pw.value : '' };
    })()` }]);
  } catch { return null; }
});

// ---------- 8. ad + tracker blocking ----------
// Network-level blocking with Ghostery's engine (EasyList-style lists). Lists are
// fetched once and cached for offline starts. Per-site pause is a local setting.
let blocker = null;
const blockedByTab = new Map();       // webContents id -> count (current page)
async function initAdblock() {
  let ElectronBlocker;
  try { ({ ElectronBlocker } = require('@ghostery/adblocker-electron')); } catch { return; }
  const cache = path.join(app.getPath('userData'), 'adblock-engine.bin');
  try {
    if (process.env.NODEGRID_ADBLOCK_FILTERS) blocker = ElectronBlocker.parse(process.env.NODEGRID_ADBLOCK_FILTERS);
    else blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, { path: cache, read: fs.promises.readFile, write: fs.promises.writeFile });
  } catch (err) {
    try { blocker = ElectronBlocker.deserialize(await fs.promises.readFile(cache)); } catch { blocker = null; }
    if (!blocker) { console.error('Ad blocking unavailable (lists could not be loaded yet):', err.message); return; }
  }
  pushState();
}
function hookAdblock(ses) {
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    if (!blocker || settings.adblockOff) return callback({});   // lists not loaded yet, or switched off in settings
    const wc = details.webContents;
    const top = wc && !wc.isDestroyed() ? siteHost(wc.getURL()) : '';
    if (top && (settings.adblockPaused || []).includes(top)) return callback({});
    blocker.onBeforeRequest(details, (res) => {
      if ((res.cancel || res.redirectURL) && wc && !wc.isDestroyed()) {
        blockedByTab.set(wc.id, (blockedByTab.get(wc.id) || 0) + 1);
        noteBlocked(wc, details.url);
        pushStateSoon();
      }
      callback(res);
    });
  });
}
// Everything a browsing session needs: permission prompts, downloads, ad blocking, packet trail.
function setupWebSession(ses, opts = {}) {
  setupPermissions(ses, opts);
  setupDownloads(ses, opts);
  hookAdblock(ses);
  hookTrail(ses);
}
let pushSoonTimer = null;
const pushStateSoon = () => { if (!pushSoonTimer) pushSoonTimer = setTimeout(() => { pushSoonTimer = null; pushState(); }, 300); };
ipcMain.on('adblock:toggle-site', (e) => {
  if (e.sender !== win.webContents) return;
  const t = activeTab(); const h = t && siteHost(t.url);
  if (!h) return;
  const list = new Set(settings.adblockPaused || []);
  if (list.has(h)) list.delete(h); else list.add(h);
  settings.adblockPaused = [...list]; saveSettings();
  t.view.webContents.reload();
});

// ---------- right-click menus ----------

// Drop leading, trailing and doubled separators so menus never look broken.
function tidy(items) {
  const out = [];
  for (const it of items) {
    if (it.type === 'separator' && (out.length === 0 || out[out.length - 1].type === 'separator')) continue;
    out.push(it);
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop();
  return out;
}

function popup(items) {
  const menu = Menu.buildFromTemplate(tidy(items));
  if (win && !win.isDestroyed()) menu.popup({ window: win });
  return menu;
}

const SEP = { type: 'separator' };
const short = (s, n = 32) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function pageMenu(tab, p) {
  const wc = tab.view.webContents;
  const f = p.editFlags || {};
  const items = [];
  const selection = (p.selectionText || '').trim();

  // Spelling fixes inside text boxes
  if (p.misspelledWord) {
    const sugg = (p.dictionarySuggestions || []).slice(0, 5);
    if (sugg.length) sugg.forEach((s) => items.push({ label: s, click: () => wc.replaceMisspelling(s) }));
    else items.push({ label: 'No spelling suggestions', enabled: false });
    items.push({ label: 'Add to dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
    items.push(SEP);
  }

  // Links
  if (p.linkURL) {
    items.push(
      { label: 'Open link in new tab', click: () => newTab(p.linkURL, { peek: tab.peek }) },
      starrable(p.linkURL) ? { label: 'Peek (quick look, no scripts)', click: () => openPeek(p.linkURL) } : SEP,
      { label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) },
      starrable(p.linkURL) && !findFav(p.linkURL)
        ? { label: 'Add link to favorites', click: () => addFav(p.linkURL, (p.linkText || '').trim() || p.linkURL, null) }
        : SEP,
      SEP
    );
  }

  // Images
  if (p.mediaType === 'image' && p.srcURL) {
    items.push(
      { label: 'Open image in new tab', click: () => newTab(p.srcURL) },
      { label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) },
      { label: 'Copy image address', click: () => clipboard.writeText(p.srcURL) },
      SEP
    );
  }

  // Text boxes
  if (p.isEditable) {
    items.push(
      { label: 'Undo', accelerator: 'CmdOrCtrl+Z', enabled: f.canUndo !== false, click: () => wc.undo() },
      { label: 'Redo', accelerator: 'CmdOrCtrl+Y', enabled: f.canRedo !== false, click: () => wc.redo() },
      SEP,
      { label: 'Cut', accelerator: 'CmdOrCtrl+X', enabled: f.canCut !== false, click: () => wc.cut() },
      { label: 'Copy', accelerator: 'CmdOrCtrl+C', enabled: f.canCopy !== false, click: () => wc.copy() },
      { label: 'Paste', accelerator: 'CmdOrCtrl+V', enabled: f.canPaste !== false, click: () => wc.paste() },
      { label: 'Paste as plain text', accelerator: 'CmdOrCtrl+Shift+V', enabled: f.canPaste !== false, click: () => wc.pasteAndMatchStyle() },
      SEP,
      { label: 'Select all', accelerator: 'CmdOrCtrl+A', click: () => wc.selectAll() },
      SEP
    );
  } else if (selection) {
    // Selected text on a page
    items.push(
      { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: () => wc.copy() },
      { label: `Search DuckDuckGo for "${short(selection)}"`,
        click: () => newTab('https://duckduckgo.com/?q=' + encodeURIComponent(selection)) },
      SEP
    );
  }

  // Plain page background
  if (!p.isEditable && !p.linkURL && !selection && p.mediaType !== 'image') {
    items.push(
      { label: 'Back', accelerator: 'Alt+Left', enabled: canGoBack(wc), click: () => { activate(tab.id); back(); } },
      { label: 'Forward', accelerator: 'Alt+Right', enabled: canGoForward(wc), click: () => { activate(tab.id); forward(); } },
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => { activate(tab.id); reload(); } },
      SEP,
      { label: 'Select all', accelerator: 'CmdOrCtrl+A', click: () => wc.selectAll() },
      untranslate(tab.url) ? { label: 'Show original (untranslated)', click: () => { activate(tab.id); translateTab(tab); } }
        : translatable(tab) ? { label: `Translate to ${langName(targetLang())}`, click: () => { activate(tab.id); translateTab(tab); } } : SEP,
      { label: 'Copy page address', click: () => clipboard.writeText(tab.url || wc.getURL()) },
      starrable(tab.url)
        ? { label: findFav(tab.url) ? 'Remove from favorites' : 'Add to favorites', accelerator: 'CmdOrCtrl+D', click: () => toggleFavForTab(tab) }
        : SEP,
      SEP
    );
  }

  if (starrable(tab.url) && !p.isEditable && !p.linkURL) {
    items.push(SEP, { label: 'View page source', accelerator: 'CmdOrCtrl+U', click: () => openPeek(tab.url, { source: true }) });
  }
  items.push(SEP);
  if (p.mediaType === 'video' && featureOn('pip')) items.push(SEP, { label: 'Picture in picture', click: () => togglePip(tab) });
  if (featureOn('reader') && (tab.readerable || tab.reader)) items.push(SEP, { label: tab.reader ? 'Exit reader mode' : 'Reader mode', click: () => { activate(tab.id); toggleReader(tab); } });
  if (featureOn('qr') && /^https?:/i.test(tab.url || '')) items.push({ label: 'Send to phone (QR code)', click: () => { activate(tab.id); openQr(tab); } });
  if (savable(tab) && featureOn('saved')) items.push(SEP, { label: 'Save to Vault', accelerator: 'CmdOrCtrl+S', click: () => saveToVault(tab) });
  if (!tab.sim && !tab.settingsTab) items.push({ label: 'Print…', accelerator: 'CmdOrCtrl+P', click: () => printTab(tab) },
    { label: 'Save as PDF…', click: () => savePdf(tab) });
  if (!tab.sim && featureOn('trail')) items.push({ label: 'Packet trail', click: () => { activate(tab.id); win.webContents.send('trail-open'); } });
  if (devMode && !tab.peek && !tab.sim) {
    items.push(SEP);
    if (/^https?:/i.test(tab.url || '') && featureOn('recon')) items.push({ label: 'Recon', click: () => { activate(tab.id); openRecon(tab); } });
    if (featureOn('mobile')) items.push({ label: 'Mobile view', type: 'checkbox', checked: !!tab.mobile, click: () => setMobile(tab, !tab.mobile) });
  }
  items.push({ label: 'Inspect', accelerator: 'CmdOrCtrl+Shift+I', click: () => wc.inspectElement(p.x, p.y) });
  return popup(items);
}

function tabMenu(id) {
  const t = getTab(id);
  if (!t) return;
  const idx = tabs.indexOf(t);
  const url = t.url || t.view.webContents.getURL() || HOME;   // t.url is the real address, even on the error page
  return popup([
    { label: 'New tab', accelerator: 'CmdOrCtrl+T', click: () => newTab() },
    SEP,
    { label: 'Reload tab', click: () => { activate(id); reload(); } },
    { label: 'Duplicate tab', click: () => newTab(url, { peek: t.peek, burner: t.burner }) },
    ...(featureOn('pinned') && !t.peek && !t.burner && !t.sim && !t.settingsTab ? [{ label: t.pinned ? 'Unpin tab' : 'Pin tab', click: () => setPinned(t, !t.pinned) }] : []),
    ...(featureOn('qr') && /^https?:/i.test(url) ? [{ label: 'Send to phone (QR code)', click: () => { activate(id); openQr(t); } }] : []),

    { label: 'Copy page address', click: () => clipboard.writeText(url) },
    starrable(url)
      ? { label: findFav(url) ? 'Remove from favorites' : 'Add to favorites', click: () => toggleFavForTab(t) }
      : SEP,
    SEP,
    ...(t.burner ? [
      { label: 'Burner: +15 minutes', click: () => extendBurner(t.burner.part, 15) },
      { label: 'Burn now (close + wipe)', click: () => burnGroup(t.burner.part, false) },
      SEP] : []),
    t.sleeping ? { label: 'Wake tab', click: () => activate(id) }
      : { label: 'Put tab to sleep', enabled: canSleep(t, true), click: () => sleepTab(t, true) },
    { label: 'Put other tabs to sleep', enabled: tabs.some((x) => x.id !== id && !x.sleeping && canSleep(x, true)),
      click: () => tabs.filter((x) => x.id !== id).forEach((x) => { if (canSleep(x, true)) sleepTab(x, true); }) },
    SEP,
    { label: 'Close tab', accelerator: 'CmdOrCtrl+W', click: () => closeTab(id) },
    { label: 'Close other tabs', enabled: tabs.length > 1,
      click: () => { activate(id); tabs.filter((x) => x.id !== id).map((x) => x.id).forEach(closeTab); } },
    { label: 'Close tabs below', enabled: idx < tabs.length - 1,
      click: () => { tabs.slice(idx + 1).map((x) => x.id).forEach(closeTab); } }
  ]);
}

ipcMain.on('tab:menu', (_e, id) => tabMenu(id));

// ---------- shell <-> main ----------

let lastState = '';
function pushState() {
  if (!win || win.isDestroyed()) return;
  const t = activeTab();
  const state = {
    activeId,
    canGoBack: t ? canGoBack(t.view.webContents) : false,
    loading: t ? t.loading : false,
    url: t ? t.url : '',
    tabs: tabs.map(({ id, title, favicon, loading, url, peek, mobile, burner, sleeping, settingsTab, pinned }) => ({ id, title, favicon, loading: loading && !sleeping, url, peek, mobile: !!mobile,
      sleeping: !!sleeping, settings: !!settingsTab, pinned: !!pinned && featureOn('pinned'),
      burnEnds: burner && burners.has(burner.part) ? burners.get(burner.part).ends : 0 })),
    saved: saved.map(({ id, url, title, host, savedAt, file, md }) => ({ id, url, title, host, savedAt, offline: !!file, md: !!md })),
    loadouts: loadouts.map(({ id, name, urls }) => ({ id, name, count: urls.length,
      hosts: urls.map((u) => u.startsWith('nodegrid://') ? u.slice(11) : hostOfUrl(u)).filter(Boolean).slice(0, 6) })),
    peek: !!(t && t.peek),
    favs: favs.map(({ id, url, title, favicon }) => ({ id, url, title, favicon })),
    history: history.map((e) => ({ host: e.host, count: e.count })),   // hostnames + visit counts
    starred: !!(t && findFav(untranslate(t.url) || t.url)),
    canStar: !!(t && starrable(t.url)),
    blocked: t ? blockedByTab.get(t.view.webContents.id) || 0 : 0,
    adblockOn: !!blocker && !settings.adblockOff,
    dark: darkOn(),
    darkSkip: !!(t && darkExcluded(t.url)),
    media: featureOn('music') ? mediaState() : null,
    features: featureMap(),
    ytRadio: !BUILD.noYouTubeRadio,
    reader: !!(t && t.reader), readerable: !!(t && t.readerable && !t.reader && featureOn('reader')),
    pip: !!(t && t.hasVideo && featureOn('pip')),
    ai: { provider: aiProvider(), custom: settings.aiCustom || '', shown: aiShown,
      canBack: !!(aiView && canGoBack(aiView.webContents)) },
    translated: !!(t && untranslate(t.url)),
    origUrl: t ? untranslate(t.url) : null,
    canTranslate: !!(t && (translatable(t) || untranslate(t.url))),
    translateLang: langName(targetLang()),
    adblockPaused: !!(t && siteHost(t.url) && (settings.adblockPaused || []).includes(siteHost(t.url)))
  };
  // Pages fire lots of events that change nothing visible; don't redraw for those.
  const json = JSON.stringify(state);
  if (json === lastState) return;
  lastState = json;
  win.webContents.send('state', state);
}

ipcMain.on('tab:new', () => newTab());
ipcMain.on('tab:close', (_e, id) => closeTab(id));
ipcMain.on('tab:activate', (_e, id) => activate(id));
// After using the toolbar, hand the keyboard back to the page, so typing and
// key combos (like the stratagem) reach it instead of the app's frame.
const focusPage = () => { const t = activeTab(); if (t && !peekUI) t.view.webContents.focus(); };
ipcMain.on('nav:back', () => { back(); focusPage(); });
ipcMain.on('nav:reload', () => { reload(); focusPage(); });
ipcMain.on('nav:home', () => { home(); focusPage(); });

// Shell reports where the page area is; the active view is sized to match.
ipcMain.on('viewport', (_e, r) => {
  viewport = {
    x: Math.round(r.x), y: Math.round(r.y),
    width: Math.max(0, Math.round(r.width)), height: Math.max(0, Math.round(r.height))
  };
  for (const t of tabs) { t.view.setBounds(tabBounds(t)); if (t.mobile) mobileMetrics(t); }   // all tabs, so any can come to the front instantly
  if (peekUI) peekUI.setBounds(viewport);              // the frame re-reports its size, which moves the preview
  if (overlays.perm) overlays.perm.setBounds(permBounds());
  if (overlays.vault) overlays.vault.setBounds(vaultBounds());
  if (overlays.recon) overlays.recon.setBounds(reconBounds());
  if (overlays.qr) overlays.qr.setBounds(qrBounds());
  placePixel();
});

// Mouse moved onto the page -> let the shell collapse a peeked sidebar.
ipcMain.on('page-hover', (e) => {
  if (win && !win.isDestroyed() && e.sender !== win.webContents) win.webContents.send('page-hover');
});

// ---------- keyboard ----------

function handleKeys(e, input) {
  if (input.type !== 'keyDown') return;
  const ctrl = input.control || input.meta;
  const k = input.key.toLowerCase();
  let handled = true;

  if (ctrl && input.shift && k === 'n') openBurner();
  else if (ctrl && k === 's' && !input.shift) saveToVault(activeTab());
  else if (ctrl && input.shift && k === 'a') { if (featureOn('ai')) win.webContents.send('ai-toggle'); }
  else if (ctrl && k === 'p' && !input.shift) printTab(activeTab());
  else if (ctrl && k === ',') openSettings();
  else if (ctrl && k === 't') newTab();
  else if (ctrl && k === 'w') closeTab(activeId);
  else if ((ctrl && k === 'r') || k === 'f5') reload();
  else if (input.alt && k === 'arrowleft') back();
  else if (input.alt && k === 'arrowright') forward();
  else if (input.alt && k === 'home') home();
  else if (ctrl && input.shift && k === 'b') win.webContents.send('toggle-favbar');
  else if (ctrl && k === 'b') win.webContents.send('toggle-sidebar');
  else if (ctrl && k === 'd') toggleFavForTab(activeTab());
  else if (ctrl && k === 'h') win.webContents.send('toggle-history');
  else if (ctrl && k === 'j') win.webContents.send('toggle-downloads');
  else if (ctrl && k === 'l') { win.webContents.focus(); win.webContents.send('focus-address'); }
  else if (ctrl && k === 'f' && activeTab() && !isErrorPage(activeTab().view.webContents.getURL())) { win.webContents.focus(); win.webContents.send('find-open'); }
  else if (ctrl && k === 'u' && activeTab() && starrable(activeTab().url)) openPeek(activeTab().url, { source: true });
  else if (ctrl && k === 'tab') cycle(input.shift ? -1 : 1);
  else handled = false;

  if (handled) e.preventDefault();
}

// ---------- app ----------

app.whenReady().then(() => {
  if (!gotLock) return;
  loadFavs(); loadHistory(); loadSettings(); loadVault();
  loadSaved(); loadLoadouts();
  drive.handshake().catch(() => {});          // Null Drive: check the connection on every launch
  setupWebSession(session.fromPartition(PARTITION));
  setupWebSession(session.fromPartition(PEEK_PARTITION), { peek: true });
  setupSim();
  setupAiSession();
  hookAdblock(session.fromPartition(RADIO_PARTITION));
  createWindow();
  initAdblock();
});
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (!win) createWindow(); });
