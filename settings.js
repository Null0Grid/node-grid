// NODE_GRID settings: one place for every switch. Each change is saved right away.
(() => {
  const S = window.ngSettings;
  const $ = (id) => document.getElementById(id);
  const el = (t, c, txt) => { const n = document.createElement(t); if (c) n.className = c; if (txt != null) n.textContent = txt; return n; };
  let M = null;

  let toastT = null;
  function toast(t, bad) { const n = $('toast'); n.textContent = t; n.classList.toggle('bad', !!bad); n.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => n.classList.remove('on'), 1800); }
  async function act(action, a, b, msg) {
    const r = await S.do(action, a, b);
    if (r && r.ok) { M = r.model; render(); if (msg) toast(msg); }
    else toast(r && r.reason === 'wrong' ? 'Wrong PIN' : r && r.reason === 'wait' ? 'Too many wrong PINs. Wait 30 seconds and try again' : r && r.reason === 'format' ? 'Use 4 to 8 digits' : r && r.reason === 'address' ? "That isn't a valid address" : r && r.reason === 'token' ? 'Paste your Null Drive token' : r && r.reason === 'encrypt' ? "This computer can't encrypt the token" : "Couldn't change that", true);
    return r;
  }

  // ---- small building blocks ----
  const section = (id, title, sub, jump) => { const s = el('section', 'card'); s.id = id; s.dataset.jump = jump || title; s.append(el('h2', null, title)); if (sub) s.append(el('p', 'sub', sub)); return s; };
  const row = (label, hint, control) => { const r = el('div', 'row'); const t = el('div', 'rl'); t.append(el('div', 'label', label)); if (hint) t.append(el('div', 'hint', hint)); r.append(t, control); return r; };
  function toggle(on, fn) {
    const b = el('button', 'tgl' + (on ? ' on' : '')); b.setAttribute('role', 'switch'); b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.append(el('span'));
    b.onclick = () => fn(!on);
    return b;
  }
  function select(options, value, fn) {
    const s = el('select');
    for (const [v, label] of options) { const o = el('option', null, label); o.value = String(v); s.append(o); }
    s.value = String(value);
    s.onchange = () => fn(s.value);
    return s;
  }
  function button(text, fn, cls = '') { const b = el('button', 'btn ' + cls, text); b.onclick = fn; return b; }
  function list(items, empty, render) {
    if (!items.length) return el('p', 'empty', empty);
    const ul = el('ul', 'list');
    for (const it of items) ul.append(render(it));
    return ul;
  }
  const li = (text, sub, btnText, fn) => { const l = el('li'); const t = el('div', 'lt'); t.append(el('div', null, text)); if (sub) t.append(el('div', 'hint', sub)); l.append(t, button(btnText, fn, 'small')); return l; };
  function inputRow(value, placeholder, btnText, fn) {
    const f = el('form', 'inrow'); const i = el('input'); i.value = value || ''; i.placeholder = placeholder; i.spellcheck = false;
    f.append(i, el('button', 'btn', btnText)); f.onsubmit = (e) => { e.preventDefault(); fn(i.value.trim()); };
    return f;
  }

  // Settings > FEATURES: which group each switch sits in, and its short label + hint.
  const FEATURE_GROUPS = [
    ['Browsing', ['translate', 'dark', 'reader', 'md', 'qr', 'saved']],
    ['Tabs + sidebar', ['hoverpeek', 'pinned', 'burner', 'loadouts']],
    ['Media', ['music', 'pip', 'pipdock']],
    ['Tools', ['ai', 'passgen', 'trail', 'gear', 'updates', 'eggs']],
    ['Developer', ['recon', 'mobile', 'sim']],
  ];
  const FEATURE_TEXT = {
    translate: ['Translate button', 'Translate a page into your language'],
    dark: ['Dark pages button', 'The moon in the toolbar'],
    reader: ['Reader mode', 'Just the article, nothing else'],
    md: ['Save as Markdown', 'Save text pages as .md files'],
    qr: ['Send to phone', 'QR code for the page you are on'],
    hoverpeek: ['Expand sidebar on hover', 'When shrunk, hovering opens it'],
    pinned: ['Pinned tabs', 'Keep tabs at the top'],
    burner: ['Burner tabs', 'Tabs that wipe themselves'],
    loadouts: ['Loadouts', 'Saved sets of tabs'],
    saved: ['Vault', 'Pages you saved to read later'],
    music: ['Music player', 'Radio and tab audio in the sidebar'],
    pip: ['Picture-in-picture', 'Pop videos out of the page'],
    pipdock: ['Dock PiP in the sidebar', 'Instead of a floating window'],
    ai: ['AI side panel', 'Claude or another AI beside the page'],
    passgen: ['Password generator', 'Strong passwords for sign-ups'],
    trail: ['Packet trail', 'Where a page connects to'],
    gear: ['Settings button', 'The gear in the bottom-right corner'],
    updates: ['Update checks', 'Ask GitHub once a day for new versions'],
    eggs: ['Easter eggs', 'Hidden surprises'],
    recon: ['Recon', 'DNS, TLS and security grade'],
    mobile: ['Mobile view', 'See a page as a phone would'],
    sim: ['NODE_GRID SIM', 'The mini-game'],
  };
  // Order of the sections, most-used first.
  const ORDER = ['search', 'look', 'tabs', 'browser', 'ai', 'features', 'privacy', 'sites', 'logins', 'drive', 'updates', 'about'];
  const KEYRING = { win32: 'encrypted by Windows', darwin: 'encrypted with your Mac keychain', linux: "encrypted with your system's keyring" };

  const ENGINES = [['duckduckgo', 'DuckDuckGo'], ['brave', 'Brave'], ['google', 'Google'], ['startpage', 'Startpage']];
  const KIND = { location: 'Location', camera: 'Camera', microphone: 'Microphone', 'camera+microphone': 'Camera + mic', notifications: 'Notifications', screen: 'Screen sharing', clipboard: 'Clipboard' };
  const fmtSec = (s) => s === 0 ? 'Never' : s < 60 ? `After ${s} seconds` : `After ${s / 60} minute${s === 60 ? '' : 's'}`;


  // NULL DRIVE: the Vault on the results page searches your own Null Drive.
  const DRIVE_STATE = {
    off:         ['', 'Not set up. Vault searches the NODE_GRID GitHub vault.'],
    checking:    ['wait', 'Connecting…'],
    connected:   ['ok', 'Connected'],
    encrypted:   ['warn', "Connected, but this account is end-to-end encrypted, so Drive can't search it"],
    token:       ['bad', 'Token rejected. Make a new one in Null Drive and paste it here'],
    'not-drive': ['bad', "Something answered, but it isn't a Null Drive. Check the port"],
    unreachable: ['bad', "Can't reach that address. Is Null Drive running?"],
    cert:        ['bad', 'Untrusted HTTPS certificate. Open the address in a tab once and choose "Proceed anyway"']
  };
  function driveSection() {
    const D = M.drive;
    const s = section('drive', 'NULL DRIVE', 'Vault search uses your own Null Drive: on this computer or a server on your network. NODE_GRID connects to it directly.', 'DRIVE');
    const st = D.configured ? D.state : 'off';
    const [cls, text] = DRIVE_STATE[st] || ['bad', st];
    const stat = el('div', 'dstat ' + cls);
    stat.append(el('span', 'ddot'), el('span', null, st === 'connected' && D.user ? `Connected as ${D.user}` : text));
    s.append(stat);

    const f = el('form', 'dform');
    const addr = el('input'); addr.value = D.url.replace(/^http:\/\//, ''); addr.placeholder = '192.168.1.50:8080  or  127.0.0.1:8080'; addr.spellcheck = false; addr.autocomplete = 'off';
    const tok = el('input'); tok.type = 'password'; tok.autocomplete = 'off'; tok.spellcheck = false;
    tok.placeholder = D.hasToken ? '•••••••• saved' : 'Token from Null Drive > Settings > Devices';
    const go = el('button', 'btn primary', D.configured ? 'RECONNECT' : 'CONNECT');
    const fa = el('label', 'dfield'); fa.append(el('span', 'hint', 'Address'), addr);
    const ft = el('label', 'dfield'); ft.append(el('span', 'hint', 'Token'), tok);
    f.append(fa, ft, go);
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (!addr.value.trim()) { toast('Type your Null Drive address', true); addr.focus(); return; }
      go.disabled = true; stat.className = 'dstat wait'; stat.lastChild.textContent = 'Connecting…';
      const r = await act('drive-connect', addr.value.trim(), tok.value);
      go.disabled = false;
      if (r && r.ok) { const d = M.drive; toast(d.state === 'connected' ? 'Null Drive connected' : (DRIVE_STATE[d.state] || [, 'Not connected'])[1], d.state !== 'connected'); }
      else render();
    };
    s.append(f);
    if (D.plain) s.append(el('p', 'hint dwarn', "This address isn't on your home network and uses plain http, so your token would travel unencrypted. Use https for a Drive outside your network."));
    s.append(el('p', 'hint', 'Make the token in Null Drive: Settings > Devices > Add device > Create an API token, scope Everything (needed to view and download files). Press Enter to connect.'));
    if (D.configured) {
      const b = el('div', 'drow');
      b.append(button('CHECK AGAIN', async () => { stat.className = 'dstat wait'; stat.lastChild.textContent = 'Connecting…'; await act('drive-retry'); }),
               button('DISCONNECT', () => act('drive-disconnect', null, null, 'Null Drive disconnected'), 'danger'));
      s.append(b);
    }
    return s;
  }

  function render() {
    $('ver').textContent = `NODE_GRID v${M.version}${M.devMode ? '  ::  developer mode ON' : ''}`;
    const out = [];

    // FEATURES: every extra, on or off, grouped by what it's for
    const sf = section('features', 'FEATURES', 'Switch any extra on or off. Off means its button, menu items and shortcuts disappear.');
    const byKey = Object.fromEntries(M.features.map((f) => [f.key, f]));
    for (const [group, keys] of FEATURE_GROUPS) {
      const items = keys.map((k) => byKey[k]).filter(Boolean);
      const dev = group === 'Developer';
      if (!items.length || (dev && !M.devMode)) continue;
      sf.append(el('h3', null, group));
      const grid = el('div', 'fgrid');
      for (const f of items) {
        const meta = FEATURE_TEXT[f.key] || [f.label.replace(' (developer mode)', ''), ''];
        const item = el('div', 'fitem');
        const t = el('div', 'ftext');
        const lab = el('div', 'flabel', meta[0]);
        if (dev) lab.append(el('span', 'devtag', 'DEV'));
        t.append(lab);
        if (meta[1]) t.append(el('div', 'fhint', meta[1]));
        item.append(t, toggle(f.on, async (on) => {
          const r = await S.feature(f.key, on);
          if (r && r.ok) { M = r.model; render(); toast(`${meta[0]}: ${on ? 'on' : 'off'}`); }
        }));
        grid.append(item);
      }
      sf.append(grid);
    }
    const known = new Set(FEATURE_GROUPS.flatMap(([, k]) => k));
    const rest = M.features.filter((f) => !known.has(f.key));
    if (rest.length) {                                   // anything new that isn't grouped yet
      sf.append(el('h3', null, 'More'));
      const grid = el('div', 'fgrid');
      for (const f of rest) { const item = el('div', 'fitem'); const t = el('div', 'ftext'); t.append(el('div', 'flabel', f.label)); item.append(t, toggle(f.on, async (on) => { const r = await S.feature(f.key, on); if (r && r.ok) { M = r.model; render(); } })); grid.append(item); }
      sf.append(grid);
    }
    if (!M.devMode) sf.append(el('p', 'hint', 'Developer switches show up in developer mode (tap the // logo 7 times).'));
    out.push(sf);

    // SEARCH
    const s1 = section('search', 'START PAGE SEARCH', 'What the search box on your start page uses.', 'SEARCH');
    s1.append(row('Search engine', null, select(ENGINES, M.search.engine, (v) => act('search', v, M.search.vault, 'Saved'))));
    s1.append(row('Vault', 'Search through NODE_GRID (Startpage only)', toggle(M.search.engine === 'startpage' && M.search.vault, (on) => {
      if (M.search.engine !== 'startpage') { toast('Vault only works with Startpage', true); return; }
      act('search', 'startpage', on, on ? 'Vault on' : 'Vault off');
    })));
    out.push(s1);

    // NULL DRIVE
    out.push(driveSection());

    // PRIVACY
    const s2 = section('privacy', 'PRIVACY + BLOCKING', null, 'PRIVACY');
    s2.append(row('History', `${M.historyCount} site name${M.historyCount === 1 ? '' : 's'} kept (no pages, no searches; last 100 sites / 7 days)`,
      button('CLEAR HISTORY', () => act('history-clear', null, null, 'History cleared'), 'danger')));
    s2.append(row('Ad + tracker blocking', M.adblock.ready ? 'Blocks ads and trackers on every site' : 'Block lists are still loading', toggle(M.adblock.on, (on) => act('adblock', on, null, on ? 'Ad blocking on' : 'Ad blocking off'))));
    s2.append(el('h3', null, 'Sites where ad blocking is paused'));
    s2.append(list(M.adblock.paused, 'None. (Click the shield on a site to pause it there.)', (h) => li(h, null, 'BLOCK AGAIN', () => act('adblock-resume', h, null, 'Blocking again on ' + h))));
    out.push(s2);

    // PERMISSIONS + CERTS
    const s3 = section('sites', 'SITE PERMISSIONS + DEVICES', 'Choices you told NODE_GRID to remember.', 'PERMISSIONS');
    s3.append(list(M.permissions, 'No remembered permissions.', (p) => li(`${p.origin.replace(/^https?:\/\//, '')}`, `${KIND[p.kind] || p.kind}: ${p.allow ? 'ALLOWED' : 'BLOCKED'}`, 'FORGET', () => act('perm-remove', p.key, null, 'Forgotten'))));
    if (M.permissions.length) s3.append(button('FORGET ALL', () => act('perm-clear', null, null, 'All permissions forgotten'), 'danger'));
    s3.append(el('h3', null, 'Trusted local devices (self-signed certificates)'));
    s3.append(list(M.certs, 'None yet. When one of your devices shows a certificate error, use "Proceed anyway" there.', (c) => li(c.host, `issued by ${c.issuer || 'unknown'} :: trusted ${c.added || ''}`, 'REMOVE', () => act('cert-remove', c.host, null, 'Removed'))));
    out.push(s3);

    // LOGINS
    const s4 = section('logins', 'SAVED LOGINS', `${M.logins} login${M.logins === 1 ? '' : 's'} saved, ${KEYRING[M.platform] || KEYRING.win32}. Open them with the key button in the toolbar.`, 'LOGINS');
    if (!M.pin.set) {
      s4.append(row('PIN lock', 'Ask for a PIN (4 to 8 digits) before showing or using your logins', el('span', 'state', 'OFF')));
      const f = el('form', 'pinf'); const a = el('input'); a.type = 'password'; a.inputMode = 'numeric'; a.placeholder = 'New PIN'; a.maxLength = 8;
      const b = el('input'); b.type = 'password'; b.inputMode = 'numeric'; b.placeholder = 'Repeat PIN'; b.maxLength = 8;
      f.append(a, b, el('button', 'btn primary', 'SET PIN'));
      f.onsubmit = (e) => { e.preventDefault(); if (a.value !== b.value) { toast("The PINs don't match", true); return; } act('pin-set', '', a.value, 'PIN set'); };
      s4.append(f);
    } else {
      s4.append(row('PIN lock', 'On. Logins stay unlocked for 5 minutes after each use.', el('span', 'state on', 'ON')));
      const f = el('form', 'pinf'); const o = el('input'); o.type = 'password'; o.inputMode = 'numeric'; o.placeholder = 'Current PIN'; o.maxLength = 8;
      const n = el('input'); n.type = 'password'; n.inputMode = 'numeric'; n.placeholder = 'New PIN'; n.maxLength = 8;
      const chg = el('button', 'btn', 'CHANGE'); const rem = el('button', 'btn danger', 'REMOVE PIN'); rem.type = 'button';
      f.append(o, n, chg, rem);
      f.onsubmit = (e) => { e.preventDefault(); act('pin-set', o.value, n.value, 'PIN changed'); };
      rem.onclick = () => act('pin-clear', o.value, null, 'PIN removed');
      s4.append(f);
    }
    out.push(s4);

    // LOOK
    const s5 = section('look', 'APPEARANCE + LANGUAGE', null, 'APPEARANCE');
    s5.append(row('Dark pages', 'Turns bright websites dark (the moon button)', toggle(M.dark.on, (on) => act('dark', on, null, on ? 'Dark pages on' : 'Dark pages off'))));
    if (M.dark.except.length) { s5.append(el('h3', null, 'Kept as they are')); s5.append(list(M.dark.except, '', (h) => li(h, null, 'DARKEN', () => act('dark-unexcept', h, null, 'Saved')))); }
    s5.append(row('Translate pages to', 'Used by the translate button', select([['', `System language (${M.translate.system})`], ...M.translate.langs], M.translate.lang, (v) => act('translate', v, null, 'Saved'))));
    out.push(s5);

    // AI
    const s6 = section('ai', 'AI SIDE PANEL', 'The BT button always opens Claude; this is what the panel shows otherwise.', 'AI');
    s6.append(row('Default AI', null, select([['claude', 'Claude'], ['chatgpt', 'ChatGPT'], ['gemini', 'Gemini'], ['perplexity', 'Perplexity'], ['grok', 'Grok'], ['local', 'Local AI (your own)'], ...(M.ai.custom ? [['custom', 'Custom: ' + M.ai.custom]] : [])], M.ai.provider, (v) => act('ai-provider', v, null, 'Saved'))));
    s6.append(row('Custom AI address', 'Any AI web page (claude.ai, grok.com, your Open WebUI...)', inputRow(M.ai.custom, 'https://…  (empty = none)', 'SAVE', (v) => act('ai-custom', v, null, 'Saved'))));
    s6.append(row('Local AI server', 'Ollama, LM Studio, LocalAI... used by LOCAL', inputRow(M.ai.local, 'http://localhost:11434', 'SAVE', (v) => act('local-ai', v, null, 'Saved'))));
    out.push(s6);

    // TABS
    const s7 = section('tabs', 'TABS');
    s7.append(row('Put unused tabs to sleep', 'Frees memory. A sleeping tab reloads when you click it. Tabs playing sound never sleep.',
      select(M.sleep.choices.map((x) => [x, fmtSec(x)]), M.sleep.after, (v) => act('sleep', Number(v), null, 'Saved'))));
    s7.append(row('Wipe burner tabs', 'Closes and wipes a burner tab group after this long', select(M.burnerChoices.map((m) => [m, `After ${m} minutes`]), M.burnerMinutes, (v) => act('burner', Number(v), null, 'Saved'))));
    out.push(s7);

    // DEFAULT BROWSER: open web links from other apps in NODE_GRID
    const B = M.browser || {};
    const sb = section('browser', 'DEFAULT BROWSER', 'Open web links from other apps (mail, chat, the terminal) in NODE_GRID.', 'DEFAULT');
    if (B.platform === 'win32' && B.state === 'portable') {
      sb.append(el('p', 'hint', "This is the portable version, which isn't installed, so Windows can't list it as a browser. To make NODE_GRID your default browser, install it from the Microsoft Store, then pick it here."));
    } else if (B.platform === 'win32') {
      sb.append(row('Make NODE_GRID your default browser', 'Windows asks you to choose: in Default apps, pick NODE_GRID, then set it for HTTP, HTTPS and .html.',
        button('OPEN DEFAULT APPS', () => act('default-browser', null, null, 'Opened Windows Default apps'), 'primary')));
    } else if (B.platform === 'linux' && B.state !== 'sandboxed') {
      const bst = el('div', 'dstat ' + (B.state === 'yes' ? 'ok' : B.state === 'no' ? 'warn' : ''));
      bst.id = 'browserstat';
      bst.append(el('span', 'ddot'), el('span', null, B.state === 'yes' ? 'NODE_GRID is your default browser.'
        : B.state === 'no' ? 'Another browser is the default' + (B.current ? ` (${B.current.replace(/\.desktop$/, '')})` : '') + '.'
        : "Couldn't check. Is xdg-utils installed?"));
      sb.append(bst);
      if (B.state !== 'yes') {
        const mk = button('MAKE DEFAULT', async () => {
          let r = null;
          try { r = await S.do('default-browser'); } catch { r = null; }
          if (r && r.model) { M = r.model; render(); }
          toast(r && r.ok ? 'NODE_GRID is now your default browser' : r && r.reason === 'write' ? "Couldn't write the launcher file in ~/.local/share/applications" : "Couldn't set it. Try: xdg-settings set default-web-browser node-grid.desktop", !(r && r.ok));
        }, 'primary');
        mk.id = 'browsermake';
        const br = el('div', 'drow'); br.append(mk); sb.append(br);
      }
      sb.append(el('p', 'hint', 'Uses your system settings (xdg-settings), the same ones Omarchy and other desktops read. A copy run from an AppImage or .tar.gz is registered for your user first.'));
    } else {
      sb.append(el('p', 'hint', B.state === 'sandboxed' ? 'Flatpak and Snap builds are set as the default from your desktop\'s own settings.' : 'Set NODE_GRID as the default from your system settings.'));
    }
    out.push(sb);

    // UPDATES: ask GitHub whether a newer NODE_GRID is out
    const U = M.update;
    const su = section('updates', 'UPDATES', U.store
      ? 'This is the Microsoft Store copy, so the Store installs your updates. NODE_GRID still asks GitHub, so you hear about a new version as soon as it is out.'
      : 'NODE_GRID asks GitHub (github.com/Null0Grid/node-grid) whether a newer version is out. Only that question is sent.');
    su.append(row('Check automatically', 'At launch and once a day', toggle(U.auto, async (on) => {
      const r = await S.feature('updates', on);
      if (r && r.ok) { M = r.model; render(); toast(on ? 'Automatic update checks on' : 'Automatic update checks off'); }
    })));
    const ust = el('div', 'dstat ' + (U.state === 'available' ? 'warn' : U.state === 'current' ? 'ok' : U.state === 'error' ? 'bad' : ''));
    ust.id = 'updstat';
    const when = U.checkedAt ? ' :: checked ' + new Date(U.checkedAt).toLocaleString() : '';
    ust.append(el('span', 'ddot'), el('span', null,
      U.state === 'checking' ? 'Checking GitHub…'
        : U.state === 'available' ? `NODE_GRID ${U.latest} is available. You have ${U.current}.`
        : U.state === 'current' ? `You're up to date (${U.current})${when}`
        : U.state === 'error' ? `Couldn't check: ${U.error}${when}`
        : `You have ${U.current}. Not checked yet.`));
    su.append(ust);
    const ub = el('div', 'drow');
    const chk = button('CHECK FOR UPDATES', async () => { chk.disabled = true; ust.className = 'dstat wait'; ust.lastChild.textContent = 'Checking GitHub…'; await act('update-check'); }, 'primary');
    chk.id = 'updcheck';
    ub.append(chk);
    if (U.state === 'available') {
      if (U.store) ub.append(button("WHAT'S NEW", () => act('update-notes')));
      else {
        const get = button(U.asset ? 'DOWNLOAD ' + U.latest : 'GET IT ON GITHUB', () => act('update-get', null, null, U.asset ? 'Downloading ' + U.asset.name : 'Opened the release page'), 'primary');
        get.id = 'updget';
        ub.append(get, button("WHAT'S NEW", () => act('update-notes')));
      }
    }
    su.append(ub);
    if (U.state === 'available' && !U.store && U.asset) su.append(el('p', 'hint', `Downloads ${U.asset.name} to your Downloads folder. Close NODE_GRID and install it like the version you have now.`));
    if (U.state === 'available' && U.store) su.append(el('p', 'hint', "The Store update usually arrives within a few days. A GitHub download would install as a second, separate NODE_GRID without your settings, so it's better to wait."));
    out.push(su);

    // ABOUT
    const s8 = section('about', 'ABOUT');
    s8.append(row('Version', null, el('span', 'state', 'v' + M.version)));
    s8.append(row('Your data folder', M.dataDir, button('OPEN', () => act('open-data'))));
    out.push(s8);

    out.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
    // jump links
    $('jump').replaceChildren(...out.map((s) => { const a = el('a', null, s.dataset.jump); a.href = '#' + s.id; return a; }));
    const y = window.scrollY;
    $('sections').replaceChildren(...out);
    window.scrollTo(0, y);
  }

  S.get().then((m) => { M = m; if (M) render(); });
  if (S.onRefresh) S.onRefresh(() => { if (document.activeElement && document.activeElement.tagName === 'INPUT') return; S.get().then((m) => { if (m) { M = m; render(); } }); });
})();
