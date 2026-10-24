// Shell UI: renders the sidebar + toolbar from state pushed by the main process.

const $ = (id) => document.getElementById(id);
const body = document.body;
const tabsEl = $('tabs');
const sidebar = $('sidebar');

if (window.shell.platform === 'darwin') body.classList.add('mac');

const X_SVG = '<svg viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';

// ---------- sidebar: pin open / collapse ----------

function isCollapsed() { return body.classList.contains('collapsed'); }

function setCollapsed(on) {
  body.classList.toggle('collapsed', on);
  body.classList.remove('peek');
  try { localStorage.setItem('sidebarCollapsed', on ? '1' : '0'); } catch {}
}
try { setCollapsed(localStorage.getItem('sidebarCollapsed') === '1'); } catch {}

$('toggle').onclick = () => setCollapsed(!isCollapsed());
window.shell.onToggleSidebar(() => setCollapsed(!isCollapsed()));

// ---------- sidebar: hover to peek (only while collapsed) ----------
// A short delay so just sweeping the mouse past the edge doesn't pop it open.

let peekTimer = null;
function endPeek() { clearTimeout(peekTimer); body.classList.remove('peek'); }

// Settings > FEATURES > "Expand the shrunk sidebar when you hover over it" can turn this off.
sidebar.addEventListener('mouseenter', () => {
  if (!isCollapsed() || body.classList.contains('nofeat-hoverpeek')) return;
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => body.classList.add('peek'), 150);
});
sidebar.addEventListener('mouseleave', endPeek);
window.shell.onPageHover(endPeek);           // mouse reached the page itself
window.addEventListener('blur', endPeek);    // window lost focus

// ---------- toolbar ----------

$('back').onclick = () => window.shell.back();
$('reload').onclick = () => window.shell.reload();
$('home').onclick = () => window.shell.home();
$('newtab').onclick = () => window.shell.newTab();

// ---------- keep the page view glued to #viewport ----------

const vp = $('viewport');
new ResizeObserver(() => {
  const r = vp.getBoundingClientRect();
  window.shell.setViewport({ x: r.left, y: r.top, width: r.width, height: r.height });
}).observe(vp);

// ---------- picture-in-picture dock area ----------
// The empty strip below the tab list (above the music player), when nothing else
// in the sidebar is open. A video can dock here instead of popping out as its own
// floating window. We just report its rect, the same way #viewport does -- the
// main process decides whether anything actually lives there. It naturally goes
// to 0x0 while collapsed or while another sidebar panel (history, downloads...)
// is showing, since those hide .tabspacer in CSS; the main process treats that as
// "nowhere to dock" and falls back to a floating window on its own.
const pipdockEl = $('tabspacer');
new ResizeObserver(() => {
  const r = pipdockEl.getBoundingClientRect();
  window.shell.setPipDockBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
}).observe(pipdockEl);

// ---------- tabs ----------
// Each tab's element is created once and then updated in place. Rebuilding the
// whole list on every page event swallowed clicks, which made switching feel slow.

function host(url) { try { return new URL(url).host; } catch { return ''; } }

const tabEls = new Map();   // id -> { li, icon, title, iconKey }

function selectTab(id) {
  for (const [tid, t] of tabEls) t.li.classList.toggle('active', tid === id);  // instant feedback
  window.shell.activate(id);
}

// Shrunk sidebar that stays shrunk (Settings > FEATURES > hover-to-expand off):
// the tabs' own close buttons are hidden there, so the site icon doubles as one.
const RAIL_X_DELAY = 350;   // ms of hovering before the icon turns into an X
const railX = () => isCollapsed() && body.classList.contains('nofeat-hoverpeek') && !body.classList.contains('peek');

function createTab(id) {
  const li = document.createElement('li');
  li.className = 'tab';

  // Site icon. Normally just an icon (closing is the X on the right). On the
  // shrunk sidebar with hover-to-expand switched off, that X is hidden, so
  // resting the mouse on the icon for a moment turns it into a close X (see
  // railX below). A quick click still switches to the tab.
  const fav = document.createElement('span');
  fav.className = 'fav';
  const icon = document.createElement('span');
  icon.className = 'icon';
  const favX = document.createElement('span');
  favX.className = 'fav-x';
  favX.innerHTML = X_SVG;
  fav.append(icon, favX);

  const title = document.createElement('span');
  title.className = 'title';

  const close = document.createElement('button');
  close.className = 'close';
  close.title = 'Close tab (Ctrl+W)';
  close.innerHTML = X_SVG;

  const timer = document.createElement('span');
  timer.className = 'burn-timer';
  li.append(fav, title, timer, close);

  // Switch on mouse-down: fires immediately, no waiting for the click to finish.
  li.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('.fav.x-on, .close')) return;
    selectTab(id);
  });
  const closeThis = (e) => { e.stopPropagation(); window.shell.closeTab(id); };

  let xTimer = null;
  fav.addEventListener('mouseenter', () => {
    clearTimeout(xTimer);
    if (railX()) xTimer = setTimeout(() => { if (railX()) { fav.classList.add('x-on'); fav.title = 'Close tab'; } }, RAIL_X_DELAY);
  });
  fav.addEventListener('mouseleave', () => { clearTimeout(xTimer); fav.classList.remove('x-on'); fav.title = ''; });
  fav.addEventListener('click', (e) => { if (fav.classList.contains('x-on')) closeThis(e); });

  close.addEventListener('click', closeThis);
  li.addEventListener('auxclick', (e) => { if (e.button === 1) window.shell.closeTab(id); }); // middle-click
  li.addEventListener('contextmenu', (e) => { e.preventDefault(); window.shell.tabMenu(id); });  // right-click

  const rec = { li, icon, title, timer, iconKey: null };
  tabEls.set(id, rec);
  return rec;
}

function updateTab(rec, t, activeId) {
  rec.li.classList.toggle('active', t.id === activeId);
  rec.li.classList.toggle('peek', !!t.peek);
  rec.li.classList.toggle('mobile', !!t.mobile);
  rec.li.classList.toggle('burner', !!t.burnEnds);
  rec.li.classList.toggle('sleeping', !!t.sleeping);
  rec.li.title = t.sleeping ? `${rec.title.textContent}\n(asleep: click to wake)` : rec.title.textContent;
  rec.timer.dataset.ends = t.burnEnds || '';
  tickBurners();

  const name = t.title || host(t.url) || 'New Tab';
  if (rec.title.textContent !== name) {
    rec.title.textContent = name;
    rec.li.title = name;
  }

  // Only touch the icon when it actually changes, so favicons don't flicker or reload.
  const key = t.loading ? 'loading' : (t.favicon || 'none');
  if (key !== rec.iconKey) {
    rec.iconKey = key;
    rec.icon.replaceChildren();
    if (t.loading) {
      rec.icon.innerHTML = '<span class="spin"></span>';
    } else if (t.favicon) {
      const img = document.createElement('img');
      img.src = t.favicon;
      img.onerror = () => { rec.icon.innerHTML = '<span class="dot"></span>'; };
      rec.icon.appendChild(img);
    } else {
      rec.icon.innerHTML = '<span class="dot"></span>';
    }
  }
}

// ---------- favorites bar ----------

const favsEl = $('favs');
const favEls = new Map();      // id -> { btn, img, name, iconKey }
let favOrder = [];
let renaming = null;

$('star').onclick = () => window.shell.toggleFav();

function setFavbar(on) {
  body.classList.toggle('no-favbar', !on);
  try { localStorage.setItem('favbarHidden', on ? '0' : '1'); } catch {}
}
try { setFavbar(localStorage.getItem('favbarHidden') !== '1'); } catch {}
window.shell.onToggleFavbar(() => setFavbar(body.classList.contains('no-favbar')));

function createFav(id) {
  const btn = document.createElement('button');
  btn.className = 'fav-item';
  btn.draggable = true;
  const icon = document.createElement('span');
  icon.className = 'ficon';
  icon.style.display = 'contents';
  const name = document.createElement('span');
  name.className = 'name';
  btn.append(icon, name);

  btn.addEventListener('click', (e) => { if (!renaming) window.shell.openFav(id, e.ctrlKey || e.metaKey); });
  btn.addEventListener('auxclick', (e) => { if (e.button === 1) window.shell.openFav(id, true); });
  btn.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });   // no autoscroll blob
  btn.addEventListener('contextmenu', (e) => { e.preventDefault(); window.shell.favMenu(id); });

  // drag to reorder
  btn.addEventListener('dragstart', (e) => { btn.classList.add('dragging'); e.dataTransfer.setData('text/x-nodegrid-fav', String(id)); e.dataTransfer.effectAllowed = 'move'; });
  btn.addEventListener('dragend', () => { btn.classList.remove('dragging'); clearDrop(); });
  btn.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('text/x-nodegrid-fav')) return;
    e.preventDefault();
    clearDrop();
    const r = btn.getBoundingClientRect();
    btn.classList.add(e.clientX < r.left + r.width / 2 ? 'drop-before' : 'drop-after');
  });
  btn.addEventListener('drop', (e) => {
    e.preventDefault();
    const dragged = Number(e.dataTransfer.getData('text/x-nodegrid-fav'));
    const after = btn.classList.contains('drop-after');
    clearDrop();
    if (!dragged || dragged === id) return;
    const order = favOrder.filter((x) => x !== dragged);
    let to = order.indexOf(id) + (after ? 1 : 0);
    window.shell.moveFav(dragged, to);
  });

  const rec = { btn, icon, name, iconKey: null };
  favEls.set(id, rec);
  return rec;
}

function clearDrop() {
  for (const { btn } of favEls.values()) btn.classList.remove('drop-before', 'drop-after');
}

function updateFav(rec, f) {
  rec.btn.title = `${f.title}\n${f.url}`;
  if (rec.name.textContent !== f.title && renaming !== f.id) rec.name.textContent = f.title;
  const key = f.favicon || 'none';
  if (key !== rec.iconKey) {
    rec.iconKey = key;
    rec.icon.replaceChildren();
    if (f.favicon) {
      const img = document.createElement('img');
      img.src = f.favicon;
      img.onerror = () => { rec.icon.innerHTML = '<span class="dot"></span>'; };
      rec.icon.appendChild(img);
    } else {
      rec.icon.innerHTML = '<span class="dot"></span>';
    }
  }
}

function renderFavs(list) {
  favOrder = list.map((f) => f.id);
  const live = new Set(favOrder);
  for (const [id, rec] of favEls) if (!live.has(id)) { rec.btn.remove(); favEls.delete(id); }
  list.forEach((f, i) => {
    const rec = favEls.get(f.id) || createFav(f.id);
    updateFav(rec, f);
    if (favsEl.children[i] !== rec.btn) favsEl.insertBefore(rec.btn, favsEl.children[i] || null);
  });
  $('favhint').hidden = list.length > 0;
  layoutFavs();
}

// Hide favorites that don't fit and offer them in the » menu
function layoutFavs() {
  const limit = favsEl.getBoundingClientRect().right;
  const hidden = [];
  for (const id of favOrder) {
    const { btn } = favEls.get(id);
    btn.classList.remove('overflow');
    if (btn.getBoundingClientRect().right > limit + 0.5) { btn.classList.add('overflow'); hidden.push(id); }
  }
  $('favmore').hidden = hidden.length === 0;
  $('favmore').onclick = () => window.shell.favOverflow(hidden);
}
new ResizeObserver(layoutFavs).observe(favsEl);

// Inline rename (right-click > Rename…)
window.shell.onFavRename((id) => {
  const rec = favEls.get(id);
  if (!rec) return;
  renaming = id;
  const input = document.createElement('input');
  input.value = rec.name.textContent;
  rec.name.replaceChildren(input);
  input.focus();
  input.select();
  const finish = (save) => {
    if (renaming !== id) return;
    renaming = null;
    const v = input.value.trim();
    rec.name.textContent = save && v ? v : rec.btn.title.split('\n')[0];
    if (save && v) window.shell.renameFav(id, v);
    layoutFavs();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
});

// ---------- easter egg: "//" logo clicker -> developer mode ----------
// 7 taps in a row (a pause of 2s+ resets the count). The unlocked flag is a local
// setting, not history.

let toastTimer = null;
function shellToast(text, ms = 1600) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

const isDev = () => { try { return localStorage.getItem('devMode') === '1'; } catch { return false; } };
function showDevButton() {
  $('devbtn').hidden = !isDev();
  $('simbtn').hidden = !isDev();               // the SIM game is a developer-mode extra
  window.shell.setDevMode(isDev());
}
showDevButton();

let taps = 0, lastTap = 0;
$('logo').addEventListener('click', () => {
  const now = Date.now();
  taps = now - lastTap > 2000 ? 1 : taps + 1;
  lastTap = now;
  if (isDev()) {                                     // 7 taps again = leave developer mode
    const left = 7 - taps;
    if (left > 0 && left <= 3) shellToast(`${left} tap${left === 1 ? '' : 's'} away from leaving developer mode.`);
    if (left === 0) { taps = 0; exitDev(); }
    return;
  }
  const left = 7 - taps;
  if (left > 0 && left <= 3) shellToast(`You are ${left} tap${left === 1 ? '' : 's'} away from being a developer.`);
  if (left === 0) {
    try { localStorage.setItem('devMode', '1'); } catch {}
    taps = 0;
    shellToast('You are now a developer.', 2200);
    showDevButton();
  }
});
// Clicking the green </> button leaves developer mode (tap "//" 7 times to come back).
function exitDev() {
  try { localStorage.removeItem('devMode'); } catch {}
  showDevButton();
  shellToast('Developer mode off. Tap // 7 times to turn it back on.', 2600);
}
$('devbtn').addEventListener('click', exitDev);

// ---------- history panel ----------

const histList = $('histlist');
const histEls = new Map();   // host -> li

function setHistory(on) {
  if (on && !body.classList.contains('show-history')) { roastTurn++; renderHistory(lastHistory); }
  if (on) clearPanels('show-history');               // one side panel at a time
  body.classList.toggle('show-history', on);
  if (on && isCollapsed()) setCollapsed(false);     // open the sidebar so the list is readable
}
$('histbtn').onclick = () => setHistory(!body.classList.contains('show-history'));
window.shell.onToggleHistory(() => setHistory(!body.classList.contains('show-history')));
$('histclear').onclick = () => window.shell.clearHist();

// Easter egg: hostnames visited 100+ times get a dry comment (rotates each time
// the history list is opened). Counts only; no URLs, paths or times.
const ROAST = ['maybe bookmark it?', "you know there's a star button, right?", 'at this point just pin it.', 'it misses you when you leave.', 'rent is due on this one.'];
const ROAST_STARRED = ['even starred it. respect.', 'starred and visited 100+ times. committed.', 'certified regular.'];
let roastTurn = 0;
let lastHistory = [];
let lastFavHosts = new Set();
const hashStr = (t) => [...t].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
function roastFor(host, count) {
  if (!(count >= 100) || body.classList.contains('nofeat-eggs')) return '';
  const list = lastFavHosts.has(host) ? ROAST_STARRED : ROAST;
  return list[(hashStr(host) + roastTurn) % list.length];
}

function histRow(host) {
  const li = document.createElement('li');
  const row = document.createElement('div');
  row.className = 'hist-row';
  const btn = document.createElement('button');
  btn.className = 'hist-host';
  btn.textContent = host;
  btn.title = `Open ${host}  (middle-click: new tab)`;
  btn.addEventListener('click', (e) => window.shell.openHist(host, e.ctrlKey || e.metaKey));
  btn.addEventListener('auxclick', (e) => { if (e.button === 1) window.shell.openHist(host, true); });
  const roast = document.createElement('span');
  roast.className = 'hist-roast';
  const x = document.createElement('button');
  x.className = 'close hist-x';
  x.title = 'Forget this site';
  x.innerHTML = X_SVG;
  x.addEventListener('click', () => window.shell.removeHist(host));
  row.append(btn, roast, x);
  li.append(row);
  li._roast = roast;
  histEls.set(host, li);
  return li;
}

function renderHistory(list) {
  lastHistory = list;
  const hosts = list.map((e) => e.host);
  const live = new Set(hosts);
  for (const [h, li] of histEls) if (!live.has(h)) { li.remove(); histEls.delete(h); }
  list.forEach((e, i) => {
    const li = histEls.get(e.host) || histRow(e.host);
    const line = roastFor(e.host, e.count);
    if (li._roast.textContent !== line) li._roast.textContent = line;
    li._roast.title = line;
    if (histList.children[i] !== li) histList.insertBefore(li, histList.children[i] || null);
  });
  $('histempty').hidden = list.length > 0;
  $('histclear').hidden = list.length === 0;
}

window.shell.onState((s) => {
  lastFavHosts = new Set((s.favs || []).map((f) => { try { return new URL(f.url).hostname; } catch { return ''; } }));
  renderHistory(s.history || []);
  renderFavs(s.favs || []);
  const star = $('star');
  star.classList.toggle('on', !!s.starred);
  star.disabled = !s.canStar;
  star.title = s.starred ? 'Remove from favorites (Ctrl+D)' : 'Add to favorites (Ctrl+D)';

  // Drop closed tabs
  const live = new Set(s.tabs.map((t) => t.id));
  for (const [id, rec] of tabEls) {
    if (!live.has(id)) { rec.li.remove(); tabEls.delete(id); }
  }

  // Add / update / order the rest, moving elements only when out of place.
  // Pinned tabs go in the icon row at the top; everything else in the list.
  const pinsEl = $('pins');
  let pi = 0, ti = 0;
  s.tabs.forEach((t) => {
    const rec = tabEls.get(t.id) || createTab(t.id);
    updateTab(rec, t, s.activeId);
    rec.li.classList.toggle('pinned', !!t.pinned);
    const box = t.pinned ? pinsEl : tabsEl, i = t.pinned ? pi++ : ti++;
    if (box.children[i] !== rec.li) box.insertBefore(rec.li, box.children[i] || null);
  });
  pinsEl.hidden = pi === 0;

  // Toolbar
  $('back').disabled = !s.canGoBack;
  body.classList.toggle('loading', s.loading);

  const active = s.tabs.find((t) => t.id === s.activeId);
  // Full address: scheme and path in grey, the site itself in green
  const where = $('where');
  let full = active ? active.url || '' : '';
  if (s.origUrl) full = s.origUrl;                     // translated: show the real address
  if (/^file:\/\/.*\/home\/index\.html(\?|$)/i.test(full)) full = 'nodegrid://home';   // bundled start page
  if (/^nodegrid:\/\/doom(\/|$)/i.test(full)) full = 'nodegrid://doom';                    // the sim
  if (/^file:\/\/.*\/settings\.html(\?|#|$)/i.test(full)) full = 'nodegrid://settings';     // settings page
  $('simbtn').classList.toggle('on', /^nodegrid:\/\/doom/.test(full));
  if (where.dataset.url !== full) {
    where.dataset.url = full;
    where.title = full;
    where.replaceChildren();
    let parts = null;
    try {
      const u = new URL(full);
      if (u.host) parts = [u.protocol + '//', u.host, full.slice(full.indexOf(u.host) + u.host.length)];
    } catch {}
    if (parts) {
      const [pre, h, rest] = parts;
      const a = document.createElement('span'); a.className = 'u-dim'; a.textContent = pre;
      const b = document.createElement('b'); b.textContent = h;
      const c = document.createElement('span'); c.className = 'u-rest'; c.textContent = rest;
      where.append(a, b, c);
    } else {
      where.textContent = full;
    }
  }
  document.title = active && active.title ? `${active.title} :: NODE_GRID` : 'NODE_GRID';
  body.classList.toggle('burner-active', !!(active && active.burnEnds));
  renderSaved(s.saved || []);
  renderLoadouts(s.loadouts || []);

  // Ad blocking shield: count for this page; click pauses it for this site
  const isSite = /^https?:/i.test((active && active.url) || '');
  const shield = $('shield');
  shield.hidden = !s.adblockOn || !isSite;
  shield.classList.toggle('paused', !!s.adblockPaused);
  $('blocked').textContent = s.adblockPaused || !s.blocked ? '' : (s.blocked > 99 ? '99+' : String(s.blocked));
  const h = host((active && active.url) || '');
  shield.title = s.adblockPaused
    ? `Ad blocking is OFF for ${h}. Click to turn it back on.`
    : `${s.blocked || 0} ad${s.blocked === 1 ? '' : 's'} & trackers blocked on this page. Click to allow ads on ${h}.`;

  // Feature switches (Settings > FEATURES): hide what's turned off
  const f = s.features || {};
  for (const k of Object.keys(f)) body.classList.toggle('nofeat-' + k, f[k] === false);
  if (f.hoverpeek === false) endPeek();
  if (f.music === false && radioPlaying()) { stopAll(); renderPlayer(); }
  if (f.ai === false && aiOpen()) setAi(false);
  for (const [k, cls] of [['saved', 'show-saved'], ['loadouts', 'show-loadouts'], ['trail', 'show-trail']]) if (f[k] === false && body.classList.contains(cls)) setPanel(cls, false);

  // Reader mode + picture-in-picture buttons (only when the page has something for them)
  $('readbtn').hidden = !(s.readerable || s.reader);
  $('readbtn').classList.toggle('on', !!s.reader);
  $('readbtn').title = s.reader ? 'Exit reader mode' : 'Reader mode: just the article, nothing else';
  $('pipbtn').hidden = !s.pip;

  // Dark pages button (moon)
  const dk = $('darkbtn');
  dk.classList.toggle('on', !!s.dark);
  dk.classList.toggle('skip', !!s.dark && !!s.darkSkip);
  dk.title = !s.dark ? 'Dark pages: OFF. Click to darken bright websites (right-click for options)'
    : s.darkSkip ? 'Dark pages: ON, but this site is kept as it is (right-click to change)'
    : 'Dark pages: ON. Click to turn off (right-click to keep one site as it is)';

  // Translate button: translate / show original. Right-click picks the language.
  const tr = $('trbtn');
  tr.hidden = !s.canTranslate;
  tr.classList.toggle('on', !!s.translated);
  $('trlabel').textContent = s.translated ? 'ORIGINAL' : '';
  tr.title = s.translated
    ? 'Translated by Google. Click to show the original page.'
    : `Translate this page to ${s.translateLang} (right-click to pick a language)`;

  // Find bar follows the active tab
  if (s.activeId !== lastActiveId) {
    lastActiveId = s.activeId;
    if (!$('findbar').hidden && $('findq').value) window.shell.find($('findq').value, true, false);
  }
});
let lastActiveId = null;

// ---------- easter egg: fsociety makes the frame glitch too ----------
window.shell.onCorrupt((on) => document.body.classList.toggle('corrupt', !!on));


// ---------- address bar: click the address (or Ctrl+L) to type ----------
// Enter goes there: a web address opens, anything else is searched on the home search.
const whereEl = $('where'), addr = $('addr');
function editAddress() {
  if (!addr.hidden) { addr.select(); return; }
  addr.value = whereEl.dataset.url || '';
  whereEl.hidden = true;
  addr.hidden = false;
  addr.focus();
  addr.select();
}
function endAddress() {
  if (addr.hidden) return;
  addr.hidden = true;
  whereEl.hidden = false;
}
whereEl.addEventListener('click', () => {
  // let people still drag-select the text to copy part of it
  if (String(window.getSelection())) return;
  editAddress();
});
addr.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const v = addr.value.trim();
    endAddress();
    if (v && v !== whereEl.dataset.url) window.shell.go(v);
    else if (v) window.shell.reload();
  } else if (e.key === 'Escape') { endAddress(); if (findbar.hidden) window.shell.stopFind(); }   // hands focus back to the page
});
addr.addEventListener('blur', endAddress);
window.shell.onFocusAddress(editAddress);

// ---------- find in page (Ctrl+F) ----------
const findbar = $('findbar'), findq = $('findq');
function openFind() {
  findbar.hidden = false;
  findq.focus();
  findq.select();
  if (findq.value) window.shell.find(findq.value, true, false);
}
function closeFind() {
  if (findbar.hidden) return;
  findbar.hidden = true;
  $('findcount').textContent = '';
  window.shell.stopFind();
}
function findStep(forward) { if (findq.value) window.shell.find(findq.value, forward, true); }
findq.addEventListener('input', () => window.shell.find(findq.value, true, false));
findq.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); findStep(!e.shiftKey); }
  else if (e.key === 'Escape') closeFind();
});
$('findnext').onclick = () => findStep(true);
$('findprev').onclick = () => findStep(false);
$('findclose').onclick = closeFind;
window.shell.onFindOpen(openFind);
window.shell.onFindResult(({ active, total }) => {
  const c = $('findcount');
  c.textContent = findq.value ? `${total ? active : 0}/${total}` : '';
  c.classList.toggle('none', !!findq.value && !total);
  findq.classList.toggle('none', !!findq.value && !total);
});

// ---------- downloads panel (Ctrl+J) ----------
const dlList = $('dllist');
const dlEls = new Map();      // id -> { li, ... }
function setDownloads(on) {
  if (on) clearPanels('show-downloads');
  body.classList.toggle('show-downloads', on);
  if (on && isCollapsed()) setCollapsed(false);
}
$('dlbtn').onclick = () => setDownloads(!body.classList.contains('show-downloads'));
window.shell.onToggleDownloads(() => setDownloads(!body.classList.contains('show-downloads')));
$('dlclear').onclick = () => window.shell.dlClear();

function fmtBytes(n) {
  if (!(n >= 0)) return '';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
}
function dlButton(cls, text, title, fn) {
  const b = document.createElement('button');
  b.className = 'dl-act ' + cls;
  b.textContent = text;
  b.title = title;
  b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
  return b;
}
function dlRow(d) {
  const li = document.createElement('li');
  li.className = 'dl';
  const name = document.createElement('div'); name.className = 'dl-name';
  const bar = document.createElement('div'); bar.className = 'dl-bar';
  const fill = document.createElement('span'); bar.append(fill);
  const meta = document.createElement('div'); meta.className = 'dl-meta';
  const info = document.createElement('span'); info.className = 'dl-info';
  const acts = document.createElement('span'); acts.className = 'dl-acts';
  meta.append(info, acts);
  li.append(name, bar, meta);
  li.addEventListener('dblclick', () => window.shell.dlOpen(d.id));
  const rec = { li, name, bar, fill, info, acts, state: null };
  dlEls.set(d.id, rec);
  return rec;
}
function updateDl(rec, d) {
  if (rec.name.textContent !== d.name) { rec.name.textContent = d.name; rec.name.title = d.name; }
  rec.li.className = 'dl ' + d.state;
  const pct = d.total > 0 ? Math.min(100, Math.round((d.received / d.total) * 100)) : null;
  rec.bar.hidden = d.state !== 'progressing';
  rec.bar.classList.toggle('indeterminate', pct === null);
  rec.fill.style.width = (pct === null ? 30 : pct) + '%';
  rec.info.textContent =
    d.state === 'progressing' ? (pct === null ? fmtBytes(d.received) : `${fmtBytes(d.received)} / ${fmtBytes(d.total)}`)
    : d.state === 'completed' ? fmtBytes(d.received || d.total)
    : d.state === 'cancelled' ? 'Cancelled' : 'Failed';
  if (rec.state !== d.state) {
    rec.state = d.state;
    if (d.state === 'progressing') rec.acts.replaceChildren(dlButton('stop', 'CANCEL', 'Stop this download', () => window.shell.dlCancel(d.id)));
    else if (d.state === 'completed') rec.acts.replaceChildren(
      dlButton('', 'OPEN', 'Open the file', () => window.shell.dlOpen(d.id)),
      dlButton('', 'FOLDER', 'Show in folder', () => window.shell.dlShow(d.id)),
      dlButton('x', '×', 'Remove from list (the file stays)', () => window.shell.dlRemove(d.id)));
    else rec.acts.replaceChildren(dlButton('x', '×', 'Remove from list', () => window.shell.dlRemove(d.id)));
  }
}
window.shell.onDownloads((list) => {
  const live = new Set(list.map((d) => d.id));
  for (const [id, rec] of dlEls) if (!live.has(id)) { rec.li.remove(); dlEls.delete(id); }
  list.forEach((d, i) => {
    const rec = dlEls.get(d.id) || dlRow(d);
    updateDl(rec, d);
    if (dlList.children[i] !== rec.li) dlList.insertBefore(rec.li, dlList.children[i] || null);
  });
  const active = list.filter((d) => d.state === 'progressing').length;
  $('dlbadge').hidden = !active;
  $('dlbadge').textContent = active;
  $('dlempty').hidden = list.length > 0;
  $('dlclear').hidden = !list.some((d) => d.state !== 'progressing');
});
window.shell.onDownloadStarted(({ name }) => {
  shellToast(`Downloading ${name}`, 2200);
  if (!isCollapsed()) setDownloads(true);
});
window.shell.onDownloadDone(({ name, state }) => {
  if (state === 'completed') shellToast(`Downloaded ${name}`, 2600);
  else if (state === 'interrupted') shellToast(`Download failed: ${name}`, 3000);
});

// ---------- toolbar: shield + key ----------
$('shield').onclick = () => window.shell.toggleAdblockSite();
$('simbtn').onclick = () => window.shell.openSim();
$('trbtn').onclick = () => window.shell.translate();
$('darkbtn').onclick = () => window.shell.toggleDark();
$('darkbtn').addEventListener('contextmenu', (e) => { e.preventDefault(); window.shell.darkMenu(); });
$('trbtn').addEventListener('contextmenu', (e) => { e.preventDefault(); window.shell.translateMenu(); });
$('keybtn').onclick = () => {
  const r = $('keybtn').getBoundingClientRect();
  window.shell.toggleVault({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
};


// ---------- side panels: one at a time ----------
const PANELS = ['show-history', 'show-downloads', 'show-trail', 'show-saved', 'show-loadouts'];
function clearPanels(except) {
  for (const c of PANELS) if (c !== except) body.classList.remove(c);
  if (except !== 'show-trail') window.shell.trailWatch(false);
}
function setPanel(cls, on) {
  if (on) { clearPanels(cls); if (isCollapsed()) setCollapsed(false); }
  body.classList.toggle(cls, on);
  if (cls === 'show-trail') window.shell.trailWatch(on);
}
const togglePanel = (cls) => setPanel(cls, !body.classList.contains(cls));

const fmtSize = (n) => !n ? '' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const actBtn = (text, title, fn, cls = '') => { const b = mk('button', 'dl-act ' + cls, text); b.title = title; b.addEventListener('click', (e) => { e.stopPropagation(); fn(e); }); return b; };

// ---------- packet trail ----------
window.shell.onTrailOpen(() => setPanel('show-trail', true));
$('trailclose').onclick = () => setPanel('show-trail', false);
window.shell.onTrail((d) => {
  $('trailsum').textContent = d.page
    ? `${d.page} :: ${d.total} request${d.total === 1 ? '' : 's'} to ${d.servers} server${d.servers === 1 ? '' : 's'}${d.blocked ? ` :: ${d.blocked} blocked` : ''}${d.bytes ? ` :: ${fmtSize(d.bytes)}` : ''}`
    : 'Open a website to see its trail.';
  const rows = d.hosts.map((h) => {
    const li = mk('li', 'trow' + (h.first ? ' first' : ' third') + (h.blocked && h.blocked === h.count ? ' blocked' : ''));
    const top = mk('div', 'trow-top');
    top.append(mk('span', 'thost', h.host), mk('span', 'tcount', String(h.count)));
    const meta = [h.ip ? h.ip + (h.moreIps ? ` +${h.moreIps}` : '') : '', fmtSize(h.bytes), h.blocked ? `${h.blocked} blocked` : '', h.failed ? `${h.failed} failed` : '']
      .filter(Boolean).join(' · ');
    li.append(top, mk('div', 'tmeta', meta || (h.first ? 'this site' : 'third party')));
    li.title = `${h.host}\n${h.first ? 'Same site as the page' : 'Third party'}`;
    return li;
  });
  $('traillist').replaceChildren(...rows);
});

// ---------- vault: saved pages ----------
$('savedbtn').onclick = () => togglePanel('show-saved');
$('savenow').onclick = () => window.shell.saveVault();
let savedKey = '';
function renderSaved(list) {
  const key = JSON.stringify(list);
  if (key === savedKey) return;
  savedKey = key;
  $('savedempty').hidden = list.length > 0;
  $('savedlist').replaceChildren(...list.map((s) => {
    const li = mk('li', 'srow');
    const t = mk('div', 'stitle', s.title || s.host); t.title = s.url;
    const d = new Date(s.savedAt);
    const meta = mk('div', 'tmeta', `${s.host} · ${isNaN(d) ? '' : d.toLocaleDateString()}`);
    const acts = mk('div', 'dl-acts');
    if (s.offline) acts.append(actBtn('OFFLINE', 'Open the saved copy (works without internet)', () => window.shell.savedOffline(s.id)));
    if (s.md) acts.append(actBtn('MD', 'Open the Markdown (.md) copy', () => window.shell.savedMd(s.id)));
    acts.append(actBtn('×', 'Remove from the Vault (deletes the saved copy)', () => window.shell.savedRemove(s.id), 'x'));
    const bottom = mk('div', 'srow-bottom'); bottom.append(meta, acts);
    li.append(t, bottom);
    li.addEventListener('click', (e) => window.shell.savedOpen(s.id, e.ctrlKey || e.metaKey));
    li.addEventListener('auxclick', (e) => { if (e.button === 1) window.shell.savedOpen(s.id, true); });
    return li;
  }));
}

// ---------- loadouts ----------
$('loadbtn').onclick = () => togglePanel('show-loadouts');
$('loadform').addEventListener('submit', (e) => { e.preventDefault(); window.shell.loadoutSave($('loadname').value); $('loadname').value = ''; });
$('loadname').addEventListener('keydown', (e) => e.stopPropagation());
let loadKey = '';
function renderLoadouts(list) {
  const key = JSON.stringify(list);
  if (key === loadKey) return;
  loadKey = key;
  $('loadempty').hidden = list.length > 0;
  $('loadlist').replaceChildren(...list.map((l) => {
    const li = mk('li', 'lrow');
    li.append(mk('div', 'stitle', l.name), mk('div', 'tmeta', `${l.count} tab${l.count === 1 ? '' : 's'}: ${l.hosts.join(', ')}${l.count > l.hosts.length ? '…' : ''}`));
    const acts = mk('div', 'dl-acts');
    acts.append(
      actBtn('DEPLOY', 'Open these tabs (keeps your current ones)', () => window.shell.loadoutDeploy(l.id, false)),
      actBtn('SWAP', 'Close your current tabs and open these', () => window.shell.loadoutDeploy(l.id, true)),
      actBtn('×', 'Delete this loadout', () => window.shell.loadoutRemove(l.id), 'x'));
    li.append(acts);
    return li;
  }));
}

// ---------- burner tabs ----------
$('burnbtn').onclick = () => window.shell.openBurner();
$('burnbtn').addEventListener('contextmenu', (e) => { e.preventDefault(); window.shell.burnerMenu(); });
function tickBurners() {
  const now = Date.now();
  for (const { timer } of tabEls.values()) {
    const ends = Number(timer.dataset.ends);
    if (!ends) { if (timer.textContent) timer.textContent = ''; continue; }
    const left = Math.max(0, Math.ceil((ends - now) / 1000));
    const txt = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    if (timer.textContent !== txt) timer.textContent = txt;
    timer.classList.toggle('soon', left <= 60);
  }
}
setInterval(tickBurners, 1000);

window.shell.onToast((t) => shellToast(t, 2400));


// ---------- AI side panel ----------
// The chat itself is a separate little browser drawn by the app inside #aiview.
const aiview = $('aiview');
let aiState = { provider: 'claude', custom: '' };
function aiOpen() { return body.classList.contains('ai-open'); }
function reportAi() {
  if (!aiOpen()) { window.shell.aiBounds(null); return; }
  const r = aiview.getBoundingClientRect();
  window.shell.aiBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
}
new ResizeObserver(reportAi).observe(aiview);
function setAi(on) {
  body.classList.toggle('ai-open', on);
  try { localStorage.setItem('aiOpen', on ? '1' : '0'); } catch {}
  requestAnimationFrame(reportAi);
}
try { if (localStorage.getItem('aiOpen') === '1') setAi(true); } catch {}
// The BT button always opens straight to Claude (the panel's other buttons still switch for now).
function openBT() { if (aiState.provider !== 'claude') window.shell.aiProvider('claude'); setAi(true); }
$('aibtn').onclick = () => (aiOpen() ? setAi(false) : openBT());
$('aiclose').onclick = () => setAi(false);
window.shell.onAiToggle(() => (aiOpen() ? setAi(false) : openBT()));
$('aiback').onclick = () => window.shell.aiAction('back');
$('aireload').onclick = () => window.shell.aiAction('reload');
$('aitab').onclick = () => window.shell.aiAction('tab');
for (const b of document.querySelectorAll('#aipick button')) {
  b.addEventListener('click', () => {
    const p = b.dataset.p;
    if (p === 'custom' && (!aiState.custom || aiState.provider === 'custom')) { toggleCustomForm(); return; }
    if (p === aiState.provider) window.shell.aiAction('home'); else window.shell.aiProvider(p);
  });
}
function toggleCustomForm(force) {
  const f = $('aicustomform');
  f.hidden = force !== undefined ? !force : !f.hidden;
  if (!f.hidden) { $('aicustomurl').value = aiState.custom || ''; $('aicustomurl').focus(); }
  requestAnimationFrame(reportAi);
}
$('aicustomform').addEventListener('submit', (e) => { e.preventDefault(); window.shell.aiCustom($('aicustomurl').value); toggleCustomForm(false); });
$('aicustomurl').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') toggleCustomForm(false); });
$('aicustombtn').addEventListener('contextmenu', (e) => { e.preventDefault(); toggleCustomForm(true); });
window.shell.onState((s) => {
  if (!s.ai) return;
  aiState = s.ai;
  for (const b of document.querySelectorAll('#aipick button')) b.classList.toggle('on', b.dataset.p === s.ai.provider);
  $('aicustombtn').textContent = s.ai.custom ? 'CUSTOM' : '+ CUSTOM';
  $('aicustombtn').title = s.ai.custom ? `Your AI: ${s.ai.custom} (right-click to change)` : 'Your own AI (like BT): set its address';
  $('aiback').disabled = !s.ai.canBack;
  $('aibtn').classList.toggle('on', aiOpen());
});


// ---------- music player (bottom of the left panel) ----------
// RADIO plays internet stations right here; TABS controls whatever is playing in a tab.
const STATIONS = [
  { name: 'DEF CON Radio', sub: 'SomaFM :: music for hacking', soma: 'defcon' },
  { name: 'Groove Salad', sub: 'SomaFM :: ambient / downtempo', soma: 'groovesalad' },
  { name: 'Vaporwaves', sub: 'SomaFM :: vaporwave', soma: 'vaporwaves' },
  { name: 'Space Station Soma', sub: 'SomaFM :: spaced-out electronica', soma: 'spacestation' },
  { name: 'Secret Agent', sub: 'SomaFM :: spy lounge', soma: 'secretagent' },
  { name: 'Fluid', sub: 'SomaFM :: instrumental hip-hop', soma: 'fluid' },
  { name: 'Synphaera', sub: 'SomaFM :: modern space ambient', soma: 'synphaera' },
  { name: 'Nightride FM', sub: 'synthwave', nightride: 'nightride' },
  { name: 'Darksynth', sub: 'Nightride FM :: darksynth', nightride: 'darksynth' },
  { name: 'Chillsynth', sub: 'Nightride FM :: chillsynth', nightride: 'chillsynth' },
  { name: 'Chillhop Radio', sub: 'YouTube live :: jazzy & lofi hip hop', yt: '5yx6BWlEVcY' }
];
// YouTube links (watch?v=, youtu.be/, /live/, /embed/) can be stations too.
function ytIdOf(u) {
  try {
    const x = new URL(u), h = x.hostname.replace(/^(www|m|music)\./, '');
    if (h === 'youtu.be') return x.pathname.slice(1).split('/')[0] || null;
    if (h === 'youtube.com' || h === 'youtube-nocookie.com') {
      if (x.searchParams.get('v')) return x.searchParams.get('v');
      const m = x.pathname.match(/^\/(live|embed|shorts)\/([\w-]{6,20})/); if (m) return m[2];
    }
  } catch {}
  return null;
}
const pl = {
  audio: $('plaudio'),
  mode: 'radio',
  media: null,                 // tab audio state from the app
  custom: [],
  station: 0,
  badStations: new Set(),      // stations that didn't answer the last check
  connecting: false
};
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
pl.custom = (lsGet('plCustom', []) || []).filter((c) => c && (/^https?:\/\//i.test(c.url) || c.yt));
let ytRadioOn = true;          // (a build can still leave YouTube stations out)
const allStations = () => STATIONS.concat(pl.custom.map((c) => ({ ...c, sub: c.yt ? 'your YouTube station' : 'your station', custom: true })))
  .filter((s) => ytRadioOn || !s.yt);
pl.yt = 'stopped';          // state of a YouTube station: stopped | connecting | playing | paused | error
pl.station = Math.min(Math.max(0, Number(lsGet('plStation', 0)) || 0), allStations().length - 1);
pl.audio.volume = Math.min(1, Math.max(0, Number(lsGet('plVol', 0.7))));
$('plvol').value = Math.round(pl.audio.volume * 100);
if (lsGet('plMin', false)) body.classList.add('pl-min');

function fillStations() {
  const sel = $('plstation');
  sel.replaceChildren(...allStations().map((s, i) => { const o = document.createElement('option'); o.value = i; o.textContent = (pl.badStations.has(s.name) ? '✕ ' : '') + s.name + (pl.badStations.has(s.name) ? ' (offline)' : ''); return o; }),
    Object.assign(document.createElement('option'), { value: 'add', textContent: '+ Add station…' }),
    ...(pl.custom.length ? [Object.assign(document.createElement('option'), { value: 'del', textContent: '− Remove this station' })] : []));
  sel.value = String(pl.station);
}
fillStations();

const audioPlaying = () => (!pl.audio.paused && !!pl.audio.src) || !!pl.connecting;
const radioPlaying = () => audioPlaying() || pl.yt === 'playing' || pl.yt === 'connecting';
function stopAll() {
  tryRun++; pl.connecting = false;
  if (audioPlaying() || pl.audio.src) { pl.audio.pause(); pl.audio.removeAttribute('src'); pl.audio.load(); }   // live radio: no point buffering
  if (pl.yt !== 'stopped') { window.shell.ytCmd('stop'); pl.yt = 'stopped'; }
}
// Try each server for the station until one actually plays (9s each, at most).
let tryRun = 0;
async function playStation(i) {
  stopAll();
  pl.station = i; lsSet('plStation', i);
  const s = allStations()[i];
  const run = ++tryRun;
  pl.failed = null;
  if (s.yt) { pl.yt = 'connecting'; window.shell.ytCmd('play', { id: s.yt, vol: pl.audio.volume }); renderPlayer(); return; }
  pl.connecting = true; renderPlayer('waiting');
  const urls = await window.shell.radioCandidates({ soma: s.soma, nightride: s.nightride, url: s.url });
  for (const u of urls) {
    if (run !== tryRun) return;                       // user picked something else meanwhile
    const ok = await new Promise((resolve) => {
      const a = pl.audio;
      const done = (v) => { clearTimeout(t); a.removeEventListener('playing', yes); a.removeEventListener('error', no); resolve(v); };
      const yes = () => done(true), no = () => done(false);
      const t = setTimeout(() => done(false), 9000);
      a.addEventListener('playing', yes); a.addEventListener('error', no);
      a.src = u;
      a.play().catch(() => {});
    });
    if (run !== tryRun) return;
    if (ok) { pl.connecting = false; pl.badStations.delete(s.name); fillStations(); renderPlayer(); return; }
  }
  if (run !== tryRun) return;
  pl.connecting = false;
  if (pl.audio.src) { pl.audio.pause(); pl.audio.removeAttribute('src'); pl.audio.load(); }
  pl.badStations.add(s.name); fillStations();
  pl.failed = s.name;                                  // keep saying so until something else is picked
  renderPlayer('error');
}
function radioToggle() {
  if (radioPlaying()) { stopAll(); renderPlayer(); }
  else playStation(pl.station);
}
window.shell.onYtState((st) => { if (pl.yt === 'stopped' && st.state !== 'stopped') return; pl.yt = st.state; renderPlayer(st.state === 'error' ? 'error' : st.state === 'connecting' ? 'waiting' : undefined); });
function setMode(m) { pl.mode = m; lsSet('plMode', m); renderPlayer(); }
pl.mode = lsGet('plMode', 'radio') === 'tabs' ? 'tabs' : 'radio';

for (const b of document.querySelectorAll('.pl-mode')) b.addEventListener('click', () => setMode(b.dataset.mode));
$('plmin').onclick = () => { body.classList.toggle('pl-min'); lsSet('plMin', body.classList.contains('pl-min')); };
$('plplay').onclick = () => (pl.mode === 'radio' ? radioToggle() : window.shell.mediaCmd('toggle'));
$('plnext').onclick = () => {
  if (pl.mode === 'tabs') return window.shell.mediaCmd('next');
  const n = (pl.station + 1) % allStations().length; if (radioPlaying()) playStation(n); else { pl.station = n; lsSet('plStation', n); renderPlayer(); }
};
$('plprev').onclick = () => {
  if (pl.mode === 'tabs') return window.shell.mediaCmd('prev');
  const n = (pl.station - 1 + allStations().length) % allStations().length; if (radioPlaying()) playStation(n); else { pl.station = n; lsSet('plStation', n); renderPlayer(); }
};
$('plmute').onclick = () => window.shell.mediaCmd('mute');
$('plnow').onclick = () => { if (pl.mode === 'tabs') window.shell.mediaCmd('focus'); };
$('plvol').addEventListener('input', () => {
  pl.audio.volume = $('plvol').value / 100; lsSet('plVol', pl.audio.volume);
  if (pl.yt !== 'stopped') window.shell.ytCmd('volume', pl.audio.volume);
});
$('plstation').addEventListener('change', () => {
  const v = $('plstation').value;
  if (v === 'add') { $('pladd').hidden = false; $('pladdname').focus(); $('plstation').value = String(pl.station); return; }
  if (v === 'del') {
    const s = allStations()[pl.station];
    if (s && s.custom) {
      pl.custom = pl.custom.filter((c) => c.url !== s.url); lsSet('plCustom', pl.custom);
      if (radioPlaying()) radioToggle();
      pl.station = 0; lsSet('plStation', 0); fillStations();
    } else { $('plstation').value = String(pl.station); shellToast('Built-in stations stay; pick one of yours to remove it'); }
    renderPlayer(); return;
  }
  const i = Number(v);
  if (radioPlaying()) playStation(i); else { pl.station = i; lsSet('plStation', i); renderPlayer(); }
});
$('pladd').addEventListener('submit', (e) => {
  e.preventDefault();
  let url = $('pladdurl').value.trim();
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { new URL(url); } catch { shellToast("That doesn't look like a stream address"); return; }
  const yt = ytIdOf(url);
  if (yt && !ytRadioOn) { shellToast("YouTube links can't be stations in this version"); return; }
  pl.custom.push(yt ? { name: $('pladdname').value.trim() || 'YouTube station', url, yt } : { name: $('pladdname').value.trim() || 'My station', url });
  lsSet('plCustom', pl.custom);
  $('pladd').hidden = true; $('pladdname').value = ''; $('pladdurl').value = '';
  fillStations(); playStation(allStations().length - 1);
});
for (const id of ['pladdname', 'pladdurl']) $(id).addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') $('pladd').hidden = true; });

for (const ev of ['playing', 'pause', 'waiting', 'error', 'emptied']) pl.audio.addEventListener(ev, () => { if (pl.connecting && (ev === 'error' || ev === 'emptied')) return; renderPlayer(ev); });   // (errors while trying backup servers are expected)

// YouTube stations play in a small visible YouTube player (YouTube's terms don't
// allow a hidden one). #plvideo is the box it sits in: we report the box's rect,
// the same way #viewport is reported, and the main process keeps the player on
// top of it. When the box can't be seen (player minimised, sidebar collapsed),
// its rect is 0x0 and the main process pauses YouTube until it's back.
const plVideo = $('plvideo');
function reportYt() {
  const r = plVideo.getBoundingClientRect();
  window.shell.setYtBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
}
new ResizeObserver(reportYt).observe(plVideo);
new ResizeObserver(reportYt).observe(document.body);
window.addEventListener('resize', reportYt);
document.addEventListener('transitionend', reportYt);
setInterval(() => { if (!plVideo.hidden) reportYt(); }, 700);   // catches the box moving without resizing

function renderPlayer(ev) {
  const radio = pl.mode === 'radio';
  for (const b of document.querySelectorAll('.pl-mode')) b.classList.toggle('on', b.dataset.mode === pl.mode);
  $('player').classList.toggle('radio', radio);
  $('player').classList.toggle('tabs', !radio);
  let title, sub, playing;
  if (radio) {
    const s = allStations()[pl.station] || STATIONS[0];
    title = s.name;
    playing = radioPlaying();
    const connecting = (ev === 'waiting' && playing) || pl.yt === 'connecting' || pl.connecting;
    sub = ev === 'error' || pl.yt === 'error' || (pl.failed === s.name && !playing) ? "Couldn't connect to this station" : connecting ? 'connecting…' : playing ? '● LIVE :: ' + s.sub : s.sub;
    $('plstation').value = String(pl.station);
  } else {
    const m = pl.media;
    title = m ? m.title : 'Nothing playing in your tabs';
    sub = m ? (m.muted ? 'muted :: ' : '') + m.artist + '  (click to go to the tab)' : 'Play a video or song in any tab';
    playing = !!(m && m.playing);
    $('plmute').classList.toggle('muted', !!(m && m.muted));
    $('plmute').disabled = !m;
  }
  $('pltitle').textContent = title;
  $('pltitle').classList.toggle('scroll', title.length > 26);
  $('plsub').textContent = sub;
  $('plnow').title = radio ? title : (pl.media ? 'Go to this tab' : '');
  $('player').classList.toggle('playing', playing);
  const ytOn = pl.yt === 'connecting' || pl.yt === 'playing' || pl.yt === 'paused';
  if (plVideo.hidden === ytOn) { plVideo.hidden = !ytOn; requestAnimationFrame(reportYt); }
  $('pleq').classList.toggle('on', radioPlaying() || !!(pl.media && pl.media.playing));
}
window.shell.onState((s) => {
  if (s.ytRadio === false && ytRadioOn) { ytRadioOn = false; if (pl.station >= allStations().length) pl.station = 0; fillStations(); }
  pl.media = s.media || null; if (pl.mode === 'tabs' || (pl.media && pl.media.playing)) renderPlayer(); else $('pleq').classList.toggle('on', radioPlaying() || !!(pl.media && pl.media.playing)); });
// A tab starts playing: the radio steps aside and the player follows the tab.
window.shell.onMediaStarted(() => { if (radioPlaying()) radioToggle(); setMode('tabs'); });
renderPlayer();

// ---------- settings ----------
$('setbtn').onclick = () => window.shell.openSettings();

// Check which stations answer (in the background, a few seconds after start-up).
setTimeout(async () => {
  const list = allStations().map((s) => ({ soma: s.soma, nightride: s.nightride, url: s.url, yt: s.yt }));
  const ok = await window.shell.radioHealth(list).catch(() => null);
  if (!ok) return;
  allStations().forEach((s, i) => { if (ok[i] === false) pl.badStations.add(s.name); else pl.badStations.delete(s.name); });
  fillStations(); renderPlayer();
}, 4000);

// ---------- reader mode + picture-in-picture ----------
$('readbtn').onclick = () => window.shell.toggleReader();
$('pipbtn').onclick = () => window.shell.togglePip();
