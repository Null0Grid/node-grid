// Runs in every normal tab, isolated from the website's own code.
// 1) Tells the shell when the mouse is over the page (so a peeked sidebar collapses).
// 2) Easter eggs, active ONLY on the NODE_GRID start page. An egg replaces the search
//    completely: nothing is submitted, stored, sent or logged.
const { ipcRenderer, contextBridge } = require('electron');

let last = 0;
window.addEventListener('mousemove', (e) => {
  // Ignore synthetic moves Chromium fires when the page shifts under a still
  // pointer (e.g. while the sidebar expands). Only real movement counts.
  if (e.movementX === 0 && e.movementY === 0) return;
  const now = Date.now();
  if (now - last < 300) return;   // at most ~3 messages a second
  last = now;
  ipcRenderer.send('page-hover');
}, { passive: true, capture: true });

// ===================================================================================
//  EASTER EGGS (NODE_GRID start page only)
// ===================================================================================
let cfg = null;
try { cfg = ipcRenderer.sendSync('egg:config'); } catch {}
// The start page is bundled in the app (file://.../home/index.html); results and notes
// come from the NODE_GRID server. The server's own start page counts as home too.
const onHomePage = () => !!cfg && cfg.eggs !== false && (
  (location.protocol === 'file:' && location.href.split(/[?#]/)[0] === cfg.homeFile) ||
  (location.host === cfg.searchHost && /^\/(index\.html)?$/.test(location.pathname)));
const onStartPage = () => !!cfg && cfg.eggs !== false && (onHomePage() || location.host === cfg.searchHost);   // any NODE_GRID page (eggs can be switched off in Settings)

// Reader mode page (reader.html): gets the cleaned-up article from the app.
if (cfg && cfg.readerPage && location.href.startsWith(cfg.readerPage)) {
  try {
    contextBridge.exposeInMainWorld('nodegridReader', {
      get: (id) => ipcRenderer.sendSync('reader:get', String(id)),
      prefs: (p) => ipcRenderer.send('reader:prefs', p),
      exit: () => ipcRenderer.send('reader:exit'),
      saveMd: (id, md) => ipcRenderer.invoke('reader:save-md', String(id), String(md))
    });
  } catch {}
}

// Error page, certificate problem on one of YOUR local devices: lets it offer "Proceed anyway".
if (cfg && cfg.errorPage && location.href.startsWith(cfg.errorPage)) {
  try {
    contextBridge.exposeInMainWorld('nodegridCert', {
      info: () => ipcRenderer.sendSync('cert:info'),
      trust: () => ipcRenderer.send('cert:trust')
    });
  } catch {}
}

// The bundled start page remembers which engine + Vault setting you used last.
// (Only those two choices are saved, never what you searched for.)
if (cfg && location.protocol === 'file:' && location.href.split(/[?#]/)[0] === cfg.homeFile) {
  try {
    contextBridge.exposeInMainWorld('nodegridPrefs', {
      search: cfg.searchPrefs || null,
      saveSearch: (engine, vault) => ipcRenderer.send('prefs:search', String(engine), !!vault)
    });
  } catch {}
}
// NODE_GRID search results + note viewer (the search site only, top frame only): ask the
// browser for matches from YOUR Null Drive. The browser makes the connection; the page
// never sees the Drive address or token. Files can only be opened if a search returned them.
if (cfg && location.host === cfg.searchHost && window.top === window) {
  try {
    contextBridge.exposeInMainWorld('nodegridDrive', {
      status:   ()  => ipcRenderer.invoke('drive:status'),
      search:   (q) => ipcRenderer.invoke('drive:search', String(q || '')),
      view:     (p) => ipcRenderer.invoke('drive:view', String(p || '')),
      download: (p) => ipcRenderer.invoke('drive:download', String(p || '')),
      showDownload: (name) => ipcRenderer.send('drive:show-download', String(name || ''))
    });
  } catch {}
}
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- overlay layer (shadow DOM, so the page's CSS can't touch it) ----------
let layer = null;
function root() {
  if (layer && layer.isConnected) return layer.shadow;
  layer = document.createElement('nodegrid-eggs');
  layer.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block;';
  layer.shadow = layer.attachShadow({ mode: 'open' });
  const css = new CSSStyleSheet();
  css.replaceSync(EGG_CSS);
  layer.shadow.adoptedStyleSheets = [css];
  document.documentElement.appendChild(layer);
  return layer.shadow;
}
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toast(text, ms = 2200) {
  const t = el('div', 'toast', text);
  root().appendChild(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
  return t;
}

// ---------- 1 + 4: search terms --------------------------------------------------
function eggFor(q) {
  const t = String(q || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (/^(sudo )?rm -rf \/\*?$/.test(t)) return 'rm';
  if (t === 'sudo' || t === 'sudo su' || t === 'sudo !!' || t === 'sudo -i') return 'sudo';   // real "sudo ..." commands search normally
  if (t === 'ping') return 'ping';
  if (t === 'protocol 3' || t === 'bt-7274' || t === 'bt 7274') return 'bt';
  if (t === 'fsociety') return 'fsociety';
  const w = t.replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();     // ignore punctuation
  if (w === 'wubba lubba dub dub') return 'portal';
  if (/airspeed velocity/.test(w) && /swallow/.test(w)) return 'swallow';
  return null;
}

const isTextField = (n) => !!n && (
  n.tagName === 'TEXTAREA' ||
  (n.tagName === 'INPUT' && ['', 'text', 'search'].includes((n.getAttribute('type') || '').toLowerCase()))
);
function searchFieldNear(node) {
  const form = node && node.closest && node.closest('form');
  const inForm = form && [...form.querySelectorAll('input, textarea')].find(isTextField);
  if (inForm) return inForm;
  if (isTextField(document.activeElement)) return document.activeElement;
  return [...document.querySelectorAll('input, textarea')].find((n) => isTextField(n) && n.offsetParent !== null) || null;
}

let busy = false;
function intercept(e, field) {
  if (!onStartPage() || busy || !field) return false;
  const egg = eggFor(field.value);
  if (!egg) return false;
  e.preventDefault();
  e.stopImmediatePropagation();       // the page's own search code never sees it
  runEgg(egg, field);
  return true;
}

// Capture phase on window runs before the page's own handlers.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing && isTextField(e.target)) intercept(e, e.target);
}, true);
window.addEventListener('submit', (e) => intercept(e, searchFieldNear(e.target)), true);
window.addEventListener('click', (e) => {
  const btn = e.target && e.target.closest && e.target.closest('button, input[type=submit], input[type=button], [role=button]');
  if (!btn) return;
  const label = (btn.value || btn.textContent || btn.getAttribute('aria-label') || '').trim();
  if (btn.type === 'submit' || /\b(run|search|go)\b/i.test(label)) intercept(e, searchFieldNear(btn));
}, true);

async function runEgg(egg, field) {
  busy = true;
  try {
    if (egg === 'sudo') { toast('nice try.'); }
    if (egg === 'ping') { await ping(); }
    if (egg === 'rm') {
      await rmrf();
      if (onHomePage()) { field.value = ''; field.focus(); window.scrollTo(0, 0); }
      else ipcRenderer.send('egg:home');              // typed on the results page: back to the (bundled) start page
    }
    if (egg === 'bt') { await btCameo(); }
    if (egg === 'fsociety') { await fsociety(); field.value = ''; }
    if (egg === 'portal') { await portal(); field.value = ''; }
    if (egg === 'swallow') { await swallow(); field.value = ''; }
  } finally {
    busy = false;
  }
}

async function ping() {
  const t = toast('PING ' + (cfg && cfg.searchHost) + ' ...', 6000);
  const r = await ipcRenderer.invoke('egg:ping').catch(() => ({ ok: false }));
  t.textContent = r && r.ok ? `pong  ${r.ms} ms` : 'pong ...? (no reply)';
  t.classList.add(r && r.ok ? 'good' : 'bad');
}

// ---------- rm -rf / ----------------------------------------------------------
const FAKE_PATHS = [
  '/bin/bash', '/boot/vmlinuz', '/etc/passwd', '/etc/hosts', '/home/user/.bashrc', '/home/user/photos/',
  '/lib/systemd/', '/opt/node_grid/', '/root/.ssh/', '/sbin/init', '/srv/www/', '/tmp/', '/usr/bin/python3',
  '/usr/lib/firmware/', '/usr/share/fonts/', '/var/log/syslog', '/var/lib/docker/', '/etc/nginx/', '/dev/null (somehow)',
  '/home/user/Documents/taxes_FINAL_v3.pdf', '/usr/bin/sudo', '/etc/fstab', '/proc/self', '/sys/kernel/'
];
async function rmrf() {
  const r = root();
  const term = el('div', 'term');
  const out = el('pre', 'term-out');
  const barWrap = el('div', 'term-bar');
  const bar = el('i');
  const pct = el('span', 'term-pct', '0%');
  barWrap.append(bar);
  term.append(out, barWrap, pct);
  r.appendChild(term);
  const line = (t) => { out.textContent += t + '\n'; out.scrollTop = out.scrollHeight; };

  line('root@node_grid:~# rm -rf /');
  await sleep(500);
  const total = reduceMotion() ? 10 : 46;
  for (let i = 0; i < total; i++) {
    const p = FAKE_PATHS[i % FAKE_PATHS.length];
    line(`removed '${p}'`);
    const v = Math.round(((i + 1) / total) * 100);
    bar.style.width = v + '%';
    pct.textContent = v + '%';
    await sleep(reduceMotion() ? 220 : 55 + (i % 7) * 8);
  }
  line('');
  line('rm: system destroyed. goodbye.');
  await sleep(900);
  out.textContent = '';
  barWrap.style.visibility = 'hidden';
  pct.textContent = '';
  const jk = el('div', 'term-jk', 'jk.');
  term.appendChild(jk);
  await sleep(1300);
  term.classList.add('out');
  await sleep(350);
  term.remove();
}

// ---------- 4: BT cameo (original pixel robot, drawn in code) -----------------
// 16x22 sprite. c = cyan, p = pink, d = dark body, g = grey, w = white
const BOT = {
  stand: [
    '......pp........', '......pp........', '.......g........', '...dddddddddd...', '..dddddddddddd..',
    '..dcccccccccccd.', '..dcwccccccccd..', '..dddddddddddd..', '...dddddddddd...', '.ggdddppddddgg..',
    '.gddddddddddddg.', '.gddcccddcccddg.', '.gddddddddddddg.', '.gg.dddddddd.gg.', '.....dddddd.....',
    '.....dd..dd.....', '.....dd..dd.....', '.....gg..gg.....', '.....gg..gg.....', '....ggg..ggg....',
    '................', '................'
  ],
  walk1: null, walk2: null
};
BOT.walk1 = BOT.stand.slice(0, 15).concat(['....dd....dd....', '....dd.....dd...', '...gg......gg...', '...gg.......gg..', '..ggg.......ggg.', '................', '................']);
BOT.walk2 = BOT.stand.slice(0, 15).concat(['.....dd..dd.....', '......dddd......', '......gggg......', '.....gg..gg.....', '....ggg..ggg....', '................', '................']);
const BOT_COL = { c: '#00e5ff', p: '#ff2e88', d: '#1c2436', g: '#5a6b80', w: '#e6f6ff' };

function drawBot(ctx, frame) {
  ctx.clearRect(0, 0, 16, 22);
  const spr = BOT[frame];
  for (let y = 0; y < spr.length; y++) for (let x = 0; x < 16; x++) {
    const k = spr[y][x];
    if (k === '.') continue;
    ctx.fillStyle = BOT_COL[k];
    ctx.fillRect(x, y, 1, 1);
  }
}

// ---------- 6: fsociety (Mr. Robot-style "your browser got hacked") -------------
// Original text and effects only (no show artwork). Fake crash, then a takeover
// message, then everything snaps back. Leaves a tiny red pixel behind (app setting).
async function fsociety() {
  const r = root();
  const calm = reduceMotion();
  const box = el('div', 'fs' + (calm ? ' calm' : ''));
  box.style.pointerEvents = 'auto';
  r.appendChild(box);
  ipcRenderer.send('egg:corrupt', true);              // the app's own frame glitches too

  // stage 1: fake crash, error dialogs cascade
  const msgs = [
    ['NODE_GRID.exe', 'NODE_GRID.exe has stopped working.'],
    ['Fatal Exception 0x0000DEAD', 'The instruction at 0x7ff6a3c1 referenced memory at 0x00000000.\nThe memory could not be read.'],
    ['renderer.dll', 'Unhandled exception in module renderer.dll'],
    ['Integrity check', 'Tab data checksum mismatch. Profile may be corrupted.'],
    ['NODE_GRID.exe', 'Recovering session... failed.'],
    ['\u2588\u2588\u2588\u2588\u2588', 'unknown process requested SYSTEM access.']
  ];
  for (let i = 0; i < msgs.length; i++) {
    const d = el('div', 'fs-dlg');
    d.style.left = `calc(18% + ${i * 26}px)`;
    d.style.top = `calc(16% + ${i * 30}px)`;
    const bar = el('div', 'fs-dlg-bar', msgs[i][0]);
    const body = el('div', 'fs-dlg-body');
    body.append(el('span', 'fs-x', '\u2716'), el('pre', 'fs-dlg-text', msgs[i][1]));
    d.append(bar, body, el('div', 'fs-dlg-btns', '[ OK ]   [ CLOSE PROGRAM ]'));
    box.appendChild(d);
    if (!calm) box.classList.toggle('jolt');
    await sleep(calm ? 260 : 210 - i * 15);
  }
  box.classList.add('corrupting');
  await sleep(calm ? 700 : 900);

  // stage 2: hard cut to black, the message types out
  box.replaceChildren();
  box.classList.remove('corrupting', 'jolt');
  box.classList.add('black');
  await sleep(500);
  const term = el('pre', 'fs-term');
  box.appendChild(term);
  const type = async (text, cls, speed = 34) => {
    const line = el('span', cls || '');
    term.appendChild(line);
    for (const ch of text) { line.textContent += ch; await sleep(calm ? 8 : speed); }
    term.appendChild(document.createTextNode('\n'));
  };
  await type('hello, friend.', 'red', 70);
  await sleep(450);
  await type('this browser is no longer yours.');
  await type('we went through everything. your tabs. your favorites.');
  await type('the things you only look at after midnight.', 'dim');
  await sleep(300);
  await type('wiping all local data in 3', 'red', 20);
  for (const n of ['2', '1']) { await sleep(520); term.lastChild.previousSibling.textContent = 'wiping all local data in ' + n; }
  await sleep(520);

  // stage 3: the name, scrambled, then a hard cut back to normal
  term.remove();
  const name = el('div', 'fs-name');
  box.appendChild(name);
  const target = 'fsociety';
  const junk = '!<>-_\\/[]{}=+*^?#01ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let f = 0; f < (calm ? 6 : 26); f++) {
    name.textContent = [...target].map((c, i) => (f > 8 + i * 2 ? c : junk[(Math.random() * junk.length) | 0])).join('');
    await sleep(55);
  }
  name.textContent = target;
  name.dataset.text = target;
  name.classList.add('hold');
  await sleep(1300);
  box.classList.add('cut');
  await sleep(calm ? 120 : 260);
  box.remove();
  ipcRenderer.send('egg:corrupt', false);
  ipcRenderer.send('egg:pixel');                      // ...something stayed behind
}

// ---------- 7: portal (Rick and Morty nod) ------------------------------------
// A green portal opens, the page spins into it, then gets spat back out.
async function portal() {
  const r = root();
  const calm = reduceMotion();
  const ring = el('div', 'portal' + (calm ? ' calm' : ''));
  ring.append(el('div', 'portal-swirl'), el('div', 'portal-ring'), el('div', 'portal-core'));
  r.appendChild(ring);
  const b = document.body;
  const prev = { t: b.style.transform, tr: b.style.transition, o: b.style.transformOrigin, f: b.style.filter };
  b.style.transformOrigin = '50% ' + (window.scrollY + innerHeight / 2) + 'px';
  await sleep(40);
  ring.classList.add('open');
  await sleep(calm ? 400 : 700);
  b.style.transition = calm ? 'opacity .4s' : 'transform .9s cubic-bezier(.6,0,.9,.4), filter .9s';
  if (calm) b.style.opacity = '0';
  else { b.style.transform = 'scale(0.02) rotate(900deg)'; b.style.filter = 'hue-rotate(90deg) saturate(2)'; }
  await sleep(calm ? 450 : 950);
  ring.classList.add('gulp');
  await sleep(700);
  ring.classList.remove('gulp');
  b.style.transition = calm ? 'opacity .4s' : 'transform .7s cubic-bezier(.2,1.4,.5,1), filter .7s';
  if (calm) b.style.opacity = '';
  else { b.style.transform = 'scale(1) rotate(0deg)'; b.style.filter = ''; }
  await sleep(calm ? 450 : 750);
  ring.classList.add('close');
  await sleep(450);
  ring.remove();
  Object.assign(b.style, { transform: prev.t, transition: prev.tr, transformOrigin: prev.o, filter: prev.f });
  toast("*burp* ...relax. it's fine.", 2600);
}

// ---------- 8: unladen swallow (Monty Python nod) ------------------------------
// The bridge keeper asks back. Whatever you answer, the page gets flung.
async function swallow() {
  const r = root();
  const calm = reduceMotion();
  const panel = el('div', 'bridge');
  panel.style.pointerEvents = 'auto';
  panel.append(el('div', 'bridge-head', 'THE BRIDGE OF DEATH'), el('div', 'bridge-q', 'African or European?'));
  const btns = el('div', 'bridge-btns');
  const a = el('button', 'bridge-btn', 'AFRICAN'), e = el('button', 'bridge-btn', 'EUROPEAN');
  btns.append(a, e);
  panel.append(btns);
  r.appendChild(panel);
  const answer = await new Promise((resolve) => {
    a.addEventListener('click', () => resolve('african'));
    e.addEventListener('click', () => resolve('european'));
    setTimeout(() => resolve('timeout'), 15000);          // walked away from the bridge
  });
  if (answer === 'timeout') { panel.remove(); toast('...the keeper waits for no one.'); return; }
  panel.replaceChildren(el('div', 'bridge-head', 'THE BRIDGE OF DEATH'), el('div', 'bridge-q', "huh? i... i don't know that!"));
  await sleep(1300);
  panel.remove();
  const b = document.body;
  const prev = { t: b.style.transform, tr: b.style.transition };
  if (calm) { b.style.transition = 'opacity .3s'; b.style.opacity = '0'; await sleep(700); b.style.opacity = ''; await sleep(350); }
  else {
    b.style.transition = 'transform .55s cubic-bezier(.5,-0.3,.9,.4)';
    b.style.transform = 'translateY(-130vh) rotate(-14deg)';         // cast into the gorge... upward
    await sleep(1100);
    b.style.transition = 'transform .8s cubic-bezier(.3,1.5,.5,1)';
    b.style.transform = 'translateY(0) rotate(0deg)';
    await sleep(850);
  }
  Object.assign(b.style, { transform: prev.t, transition: prev.tr });
  toast("should've studied.", 2400);
}

async function btCameo() {
  const r = root();
  const stage = el('div', 'bot-stage');
  const bot = el('div', 'bot');
  const cv = el('canvas');
  cv.width = 16; cv.height = 22;
  const bubble = el('div', 'bubble', 'Trust me.');
  bot.append(bubble, cv);
  stage.append(bot);
  r.appendChild(stage);
  const ctx = cv.getContext('2d');

  const W = innerWidth, size = 66;
  const mid = W / 2 - size / 2;
  const walk = async (from, to, ms) => {
    const t0 = performance.now();
    let f = 0;
    while (true) {
      const k = Math.min(1, (performance.now() - t0) / ms);
      bot.style.transform = `translateX(${from + (to - from) * k}px)`;
      if (!reduceMotion()) drawBot(ctx, ++f % 16 < 8 ? 'walk1' : 'walk2'); else drawBot(ctx, 'stand');
      if (k >= 1) break;
      await new Promise(requestAnimationFrame);
    }
  };
  await walk(-size - 10, mid, reduceMotion() ? 1 : 2400);
  drawBot(ctx, 'stand');
  bubble.classList.add('on');
  await sleep(2200);
  bubble.classList.remove('on');
  await sleep(250);
  await walk(mid, W + 10, reduceMotion() ? 1 : 2400);
  stage.remove();
}

// ---------- 2: Stratagem takeover (Helldivers-style input) --------------------
// On the start page: HOLD Ctrl, a STRATAGEM panel shows the code, then enter the
// arrows while still holding Ctrl. Releasing Ctrl cancels. Nothing is stored.
const STRAT = { name: 'NODE_GRID TAKEOVER', code: ['up', 'up', 'down', 'down', 'left', 'right', 'left', 'right'] };
const ARROWS = { arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right' };
const GLYPH = { up: '\u25B2', down: '\u25BC', left: '\u25C0', right: '\u25B6' };
let ctrlHeld = false, hudTimer = null, hud = null, entered = 0, locked = false;
// Every 3rd miss earns a dry remark. Misses count across attempts until the code is entered.
const MISS_LINES = [
  'three misses. the code is literally on the screen.',
  'reinforcements are not coming.',
  "it's the same arrows. every time.",
  'high command has noted your performance.',
  'have you considered reading the arrows first?',
  'the arrows are shown for a reason.'
];
let misses = 0, missLine = 0;

function showHud() {
  if (hud || busy || !onHomePage()) return;
  hud = el('div', 'strat');
  hud.append(el('div', 'strat-head', 'STRATAGEM'));
  const row = el('div', 'strat-row');
  row.append(el('div', 'strat-icon', '//'));
  const info = el('div', 'strat-info');
  info.append(el('div', 'strat-name', STRAT.name));
  const arrows = el('div', 'strat-code');
  STRAT.code.forEach((d) => arrows.append(el('span', 'strat-arrow', GLYPH[d])));
  info.append(arrows);
  row.append(info);
  hud.append(row, el('div', 'strat-hint', 'hold CTRL \u00B7 enter the arrows'));
  root().appendChild(hud);
  entered = 0;
}
function hideHud() {
  clearTimeout(hudTimer); hudTimer = null;
  if (hud) { const h = hud; h.classList.add('out'); setTimeout(() => h.remove(), 180); }
  hud = null; entered = 0; locked = false;
}
function arrowEls() { return hud ? [...hud.querySelectorAll('.strat-arrow')] : []; }

function stratInput(dir) {
  if (!hud || locked) return;
  const els = arrowEls();
  if (dir === STRAT.code[entered]) {
    els[entered].classList.add('lit');
    entered++;
    if (entered === STRAT.code.length) {
      locked = true;
      misses = 0;
      hud.classList.add('done');
      hud.querySelector('.strat-hint').textContent = 'ACTIVATED';
      setTimeout(() => { hideHud(); if (!busy) takeover(); }, 650);
    }
  } else {
    locked = true;
    hud.classList.add('wrong');
    misses++;
    if (misses % 3 === 0) { toast(MISS_LINES[missLine % MISS_LINES.length], 2800); missLine++; }
    setTimeout(() => {
      if (!hud) return;
      hud.classList.remove('wrong');
      els.forEach((a) => a.classList.remove('lit'));
      entered = 0; locked = false;
    }, 320);
  }
}

window.addEventListener('keydown', (e) => {
  if (!onHomePage()) return;
  if (e.key === 'Control') {
    if (!ctrlHeld) { ctrlHeld = true; hudTimer = setTimeout(showHud, 160); }   // short delay: quick Ctrl+key shortcuts don't flash it
    return;
  }
  const dir = ARROWS[(e.key || '').toLowerCase()];
  if (dir && (ctrlHeld || e.ctrlKey)) {
    e.preventDefault();                 // Ctrl+arrows would otherwise jump words in the search box
    e.stopImmediatePropagation();
    if (!hud) { clearTimeout(hudTimer); showHud(); }
    if (!e.repeat) stratInput(dir);
  } else if (ctrlHeld && hud && !dir) {
    hideHud();                          // some other Ctrl shortcut: get out of the way
  }
}, true);
window.addEventListener('keyup', (e) => { if (e.key === 'Control') { ctrlHeld = false; if (!locked || !hud || !hud.classList.contains('done')) hideHud(); } }, true);
window.addEventListener('blur', () => { ctrlHeld = false; if (!(hud && hud.classList.contains('done'))) hideHud(); });

async function takeover() {
  busy = true;
  const r = root();
  const calm = reduceMotion();
  const box = el('div', 'hack' + (calm ? ' calm' : ''));
  box.style.pointerEvents = 'auto';
  if (!calm) for (let i = 0; i < 9; i++) {
    const s = el('i', 'tear');
    s.style.top = (Math.random() * 100) + '%';
    s.style.height = (2 + Math.random() * 9) + '%';
    s.style.animationDelay = (Math.random() * 0.6).toFixed(2) + 's';
    s.style.animationDuration = (0.25 + Math.random() * 0.5).toFixed(2) + 's';
    box.appendChild(s);
  }
  const main = el('div', 'hack-main');
  const glyph = el('div', 'hack-glyph', '// //');
  const title = el('div', 'hack-title', 'NODE_GRID COMPROMISED');
  title.dataset.text = 'NODE_GRID COMPROMISED';
  const sub = el('div', 'hack-sub', 'we own your tabs now.');
  const log = el('pre', 'hack-log');
  main.append(glyph, title, sub, log);
  box.append(main);
  r.appendChild(box);

  const lines = ['> injecting payload ........ ok', '> bypassing firewall ....... ok', '> stealing cookies ......... (they were in-memory anyway)', '> uploading to the cloud ... ' + (calm ? 'ok' : '██████████ 100%')];
  for (const l of lines) { log.textContent += l + '\n'; await sleep(calm ? 500 : 420); }
  await sleep(calm ? 800 : 900);

  main.replaceChildren(el('div', 'hack-reboot', 'rebooting...'));
  const bar = el('div', 'term-bar'); const fill = el('i'); bar.append(fill); main.append(bar);
  for (let i = 1; i <= 20; i++) { fill.style.width = i * 5 + '%'; await sleep(45); }
  await sleep(250);
  box.classList.add('out');
  await sleep(400);
  box.remove();
  toast('just kidding ;)');
  busy = false;
}

// ---------- styles for everything above ---------------------------------------
const EGG_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.toast {
  position: fixed; left: 50%; bottom: 48px; transform: translateX(-50%);
  background: #10131b; color: #e6f6ff; border: 1px solid #1f2a3a; border-left: 2px solid #00e5ff;
  font: 16px/1.2 Consolas, 'Courier New', monospace; padding: 10px 16px; white-space: nowrap;
  box-shadow: 0 0 18px rgba(0,229,255,.18), 0 8px 24px rgba(0,0,0,.5);
  animation: tin .18s ease-out; transition: opacity .35s, transform .35s;
}
.toast.good { border-left-color: #39ff88; color: #39ff88; }
.toast.bad { border-left-color: #ff2e88; color: #ff2e88; }
.toast.out { opacity: 0; transform: translate(-50%, 8px); }
@keyframes tin { from { opacity: 0; transform: translate(-50%, 8px); } }

.term {
  position: fixed; inset: 0; pointer-events: auto;
  background: rgba(3,4,8,.96); color: #39ff88;
  font: 15px/1.35 Consolas, 'Courier New', monospace;
  display: flex; flex-direction: column; padding: 28px 36px; gap: 14px;
  transition: opacity .3s;
}
.term.out { opacity: 0; }
.term-out { flex: 1; margin: 0; overflow: hidden; white-space: pre-wrap; text-shadow: 0 0 6px rgba(57,255,136,.5); }
.term-bar { height: 14px; border: 1px solid #39ff88; padding: 2px; max-width: 520px; width: 100%; }
.term-bar i { display: block; height: 100%; width: 0; background: #39ff88; box-shadow: 0 0 10px #39ff88; transition: width .08s linear; }
.term-pct { font-size: 13px; }
.term-jk { position: absolute; inset: 0; display: grid; place-items: center; font-size: 72px; color: #00e5ff; text-shadow: 0 0 22px rgba(0,229,255,.7); }

.bot-stage { position: fixed; left: 0; right: 0; bottom: 8px; height: 120px; overflow: hidden; }
.bot { position: absolute; bottom: 0; left: 0; width: 66px; will-change: transform; }
.bot canvas { width: 66px; height: 91px; image-rendering: pixelated; display: block; filter: drop-shadow(0 0 6px rgba(0,229,255,.45)); }
.bubble {
  position: absolute; bottom: 98px; left: 50%; transform: translateX(-50%) scale(.6); opacity: 0;
  background: #10131b; color: #e6f6ff; border: 1px solid #00e5ff; padding: 6px 10px; white-space: nowrap;
  font: 15px Consolas, 'Courier New', monospace; transition: opacity .2s, transform .2s;
  box-shadow: 0 0 12px rgba(0,229,255,.3);
}
.bubble::after { content: ''; position: absolute; left: 50%; bottom: -6px; margin-left: -5px; border: 5px solid transparent; border-top-color: #00e5ff; border-bottom: 0; }
.bubble.on { opacity: 1; transform: translateX(-50%) scale(1); }

.hack {
  position: fixed; inset: 0; background: #020203; color: #e6f6ff; overflow: hidden;
  font-family: Consolas, 'Courier New', monospace; animation: shake .12s steps(2) infinite;
  transition: opacity .35s;
}
.hack.out { opacity: 0; }
.hack::before {
  content: ''; position: absolute; inset: 0; pointer-events: none; z-index: 3;
  background: repeating-linear-gradient(to bottom, rgba(255,255,255,.06) 0 1px, transparent 1px 3px);
}
.hack::after {
  content: ''; position: absolute; inset: 0; pointer-events: none; z-index: 2;
  background: radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,.75) 100%);
}
.tear { position: absolute; left: -5%; width: 110%; background: linear-gradient(90deg, rgba(0,229,255,.35), rgba(255,46,136,.35)); mix-blend-mode: screen; animation: tear .4s steps(3) infinite; }
@keyframes tear { 0% { transform: translateX(-4%); } 50% { transform: translateX(5%); } 100% { transform: translateX(-2%); } }
@keyframes shake { 0% { transform: translate(0,0); } 50% { transform: translate(-2px,1px); } 100% { transform: translate(2px,-1px); } }
.hack-main { position: relative; z-index: 4; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; text-align: center; padding: 20px; }
.hack-glyph { font-size: 64px; letter-spacing: -6px; color: #ff2e88; text-shadow: 4px 0 #00e5ff, 0 0 24px rgba(255,46,136,.7); font-weight: bold; }
.hack-title { position: relative; font-size: clamp(28px, 6vw, 64px); font-weight: bold; letter-spacing: 4px; color: #fff; text-shadow: 3px 0 #ff2e88, -3px 0 #00e5ff; }
.hack-title::before, .hack-title::after { content: attr(data-text); position: absolute; left: 0; top: 0; width: 100%; overflow: hidden; }
.hack-title::before { color: #00e5ff; clip-path: inset(0 0 60% 0); animation: slice 1.1s steps(1) infinite; }
.hack-title::after { color: #ff2e88; clip-path: inset(55% 0 0 0); animation: slice 0.9s steps(1) infinite reverse; }
@keyframes slice { 0% { transform: translate(-6px, 0); } 30% { transform: translate(5px, 0); } 60% { transform: translate(-2px, 0); } 100% { transform: translate(0, 0); } }
.hack-sub { color: #ffb000; letter-spacing: 3px; font-size: 16px; text-transform: uppercase; }
.hack-log { color: #39ff88; text-align: left; font-size: 14px; min-height: 5.5em; margin: 8px 0 0; }
.hack-reboot { font-size: 30px; color: #00e5ff; letter-spacing: 3px; }
/* ---- fsociety ---- */
.fs { position: fixed; inset: 0; overflow: hidden; font-family: Consolas, 'Courier New', monospace; }
.fs.jolt { transform: translate(3px, -2px); }
.fs.corrupting { animation: fsTear .09s steps(2) infinite; filter: contrast(1.4) saturate(.2); }
@keyframes fsTear {
  0% { clip-path: inset(0 0 60% 0); transform: translate(-8px, 0); }
  50% { clip-path: inset(40% 0 0 0); transform: translate(10px, 2px); }
  100% { clip-path: inset(10% 0 30% 0); transform: translate(-4px, -2px); }
}
.fs-dlg {
  position: absolute; width: 420px; background: #c9c9c9; color: #000;
  border: 2px solid #fff; border-right-color: #555; border-bottom-color: #555;
  box-shadow: 4px 4px 0 rgba(0,0,0,.6); font-size: 13px;
}
.fs-dlg-bar { background: linear-gradient(90deg, #8b0000, #d22); color: #fff; font-weight: bold; padding: 3px 6px; }
.fs-dlg-body { display: flex; gap: 10px; padding: 12px 10px 6px; }
.fs-x { color: #fff; background: #d00; width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; flex-shrink: 0; font-size: 13px; }
.fs-dlg-text { margin: 0; white-space: pre-wrap; font: inherit; }
.fs-dlg-btns { padding: 4px 10px 10px; text-align: right; color: #222; font-size: 12px; }
.fs.black { background: #000; }
.fs-term {
  position: absolute; left: 12%; top: 22%; right: 12%;
  color: #e8e8e8; font-size: 22px; line-height: 1.55; white-space: pre-wrap; margin: 0;
  text-shadow: 0 0 6px rgba(255,255,255,.25);
}
.fs-term .red { color: #ff2a2a; text-shadow: 0 0 10px rgba(255,0,0,.6); }
.fs-term .dim { color: #8a8a8a; }
.fs-name {
  position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%);
  text-align: center; color: #fff; font-size: clamp(48px, 11vw, 120px); letter-spacing: 6px; font-weight: bold;
}
.fs-name.hold { animation: fsFlick 1.3s steps(1) infinite; }
.fs-name.hold::before, .fs-name.hold::after {
  content: attr(data-text); position: absolute; left: 0; right: 0; top: 0; overflow: hidden;
}
.fs-name.hold::before { color: #ff2a2a; transform: translate(-4px, 0); clip-path: inset(0 0 55% 0); mix-blend-mode: screen; }
.fs-name.hold::after { color: #2affff; transform: translate(4px, 0); clip-path: inset(55% 0 0 0); mix-blend-mode: screen; }
@keyframes fsFlick { 0%, 100% { opacity: 1; } 47% { opacity: .2; } 50% { opacity: 1; } 83% { opacity: .6; } }
.fs.cut { background: #000; }
.fs.cut * { display: none; }
.fs.calm, .fs.calm.corrupting { animation: none; transform: none; }
.fs.calm .fs-name.hold { animation: none; }
.fs.calm .fs-name.hold::before, .fs.calm .fs-name.hold::after { display: none; }

/* ---- portal ---- */
.portal { position: fixed; left: 50%; top: 50%; width: 0; height: 0; transform: translate(-50%, -50%); }
.portal > div { position: absolute; inset: 0; border-radius: 50%; }
.portal-swirl {
  background:
    radial-gradient(circle, transparent 28%, rgba(10, 60, 20, .55) 70%, transparent 72%),
    repeating-conic-gradient(from 0deg, #d6ff7a 0deg 14deg, #2cd14a 14deg 30deg, #0f6b2a 30deg 44deg, #8dff52 44deg 60deg);
  box-shadow: 0 0 46px 14px rgba(120, 255, 80, .55), inset 0 0 40px rgba(0, 50, 10, .85);
  animation: portalSpin 1.1s linear infinite;
  filter: blur(1.5px);
}
.portal .portal-ring {
  inset: 9%;
  background: repeating-conic-gradient(from 20deg, rgba(220, 255, 140, .9) 0deg 8deg, transparent 8deg 36deg);
  animation: portalSpin .8s linear infinite reverse;
  filter: blur(2px);
  mix-blend-mode: screen;
}
.portal .portal-core { inset: 32%; background: radial-gradient(circle, #f6ffe0 0%, #b9ff6a 40%, #2fbf4b 80%, transparent 100%); animation: portalPulse .5s ease-in-out infinite alternate; }
.portal.open { width: min(56vmin, 520px); height: min(56vmin, 520px); transition: width .6s cubic-bezier(.2,1.5,.5,1), height .6s cubic-bezier(.2,1.5,.5,1); }
.portal.gulp { animation: portalGulp .35s ease-in-out 2; }
.portal.close { width: 0; height: 0; transition: width .4s ease-in, height .4s ease-in; }
@keyframes portalSpin { to { transform: rotate(360deg); } }
@keyframes portalPulse { to { transform: scale(1.08); } }
@keyframes portalGulp { 50% { transform: translate(-50%, -50%) scale(.85); } }
.portal.calm .portal-swirl, .portal.calm .portal-ring, .portal.calm .portal-core, .portal.calm.gulp { animation: none; }

/* ---- bridge of death ---- */
.bridge {
  position: fixed; left: 50%; top: 42%; transform: translate(-50%, -50%);
  min-width: 340px; padding: 18px 22px 20px; text-align: center;
  background: #120f0a; border: 2px solid #8b6b2e; outline: 1px solid #3a2c12; outline-offset: 3px;
  color: #f1e3c0; font-family: Georgia, 'Times New Roman', serif;
  box-shadow: 0 12px 50px rgba(0,0,0,.7); animation: stratIn .2s ease-out;
}
.bridge-head { font-size: 11px; letter-spacing: 4px; color: #c9a14a; margin-bottom: 12px; font-family: Consolas, monospace; }
.bridge-q { font-size: 26px; font-style: italic; margin-bottom: 16px; }
.bridge-btns { display: flex; gap: 12px; justify-content: center; }
.bridge-btn {
  font: 12px Consolas, monospace; letter-spacing: 2px; padding: 9px 16px; cursor: pointer;
  background: transparent; color: #f1e3c0; border: 1px solid #8b6b2e;
}
.bridge-btn:hover { background: rgba(201, 161, 74, .15); border-color: #c9a14a; }

/* ---- stratagem panel (Helldivers-style) ---- */
.strat {
  position: fixed; left: 28px; bottom: 32px; width: 300px;
  background: rgba(10, 10, 15, .92);
  border: 1px solid #3a3320; border-left: 3px solid #ffb000;
  box-shadow: 0 0 24px rgba(255, 176, 0, .18);
  font-family: Consolas, 'Courier New', monospace; color: #e6f6ff;
  padding: 10px 12px 12px;
  animation: stratIn .16s ease-out;
}
.strat.out { opacity: 0; transform: translateY(8px); transition: all .16s; }
@keyframes stratIn { from { opacity: 0; transform: translateY(12px); } }
.strat-head { font-size: 10px; letter-spacing: 3px; color: #ffb000; margin-bottom: 8px; }
.strat-row { display: flex; gap: 10px; align-items: center; }
.strat-icon {
  width: 40px; height: 40px; flex-shrink: 0; display: grid; place-items: center;
  border: 1px solid #ffb000; color: #00e5ff; font-weight: bold; font-size: 18px;
  text-shadow: 2px 1px 0 #ff2e88; background: rgba(255, 176, 0, .08);
}
.strat-name { font-size: 13px; letter-spacing: 1px; margin-bottom: 6px; }
.strat-code { display: flex; gap: 6px; }
.strat-arrow { font-size: 15px; color: #4a5468; transition: color .08s, text-shadow .08s; }
.strat-arrow.lit { color: #ffb000; text-shadow: 0 0 8px rgba(255, 176, 0, .9); }
.strat-hint { margin-top: 8px; font-size: 10px; letter-spacing: 1px; color: #5a6b80; }
.strat.wrong { border-left-color: #ff3355; animation: stratShake .3s; }
.strat.wrong .strat-arrow { color: #ff3355; }
.strat.done { border-left-color: #39ff88; box-shadow: 0 0 28px rgba(57, 255, 136, .3); }
.strat.done .strat-arrow { color: #39ff88; text-shadow: 0 0 8px rgba(57, 255, 136, .9); }
.strat.done .strat-hint { color: #39ff88; letter-spacing: 3px; }
@keyframes stratShake { 25% { transform: translateX(-5px); } 75% { transform: translateX(5px); } }
@media (prefers-reduced-motion: reduce) { .strat, .strat.wrong { animation: none; } }

/* toned-down version for "reduce motion": no shaking, tearing or flicker */
.hack.calm { animation: none; }
.hack.calm .hack-title { text-shadow: none; color: #00e5ff; }
.hack.calm .hack-title::before, .hack.calm .hack-title::after { display: none; }
`;
