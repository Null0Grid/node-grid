// The key popover: pick a saved login to fill into the page, or manage them.
(() => {
  const $ = (id) => document.getElementById(id);
  const V = window.vault;
  let state = { host: '', canEncrypt: true, entries: [] };
  let editing = null;          // null = adding, else entry id
  let pending = null;          // entry waiting on "fill anyway"
  let revealed = false;

  const ICON = {
    user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>',
    pass: '<svg viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
    edit: '<svg viewBox="0 0 24 24"><polygon points="16 3 21 8 9 20 4 20 4 15"/></svg>',
    del:  '<svg viewBox="0 0 24 24"><polyline points="4 7 20 7"/><path d="M6 7l1 14h10l1-14"/><path d="M9 7V4h6v3"/></svg>'
  };

  let statusTimer = null;
  function say(text, bad) {
    const s = $('status');
    s.textContent = text;
    s.classList.toggle('bad', !!bad);
    s.classList.add('on');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => s.classList.remove('on'), 2200);
  }

  function iconBtn(kind, title, fn) {
    const b = document.createElement('button');
    b.className = 'act act-' + kind;
    b.title = title;
    b.innerHTML = ICON[kind];
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    return b;
  }

  async function fill(entry, force) {
    const r = await V.fill(entry.id, force);
    if (r && r.ok) return;                                  // popover closes itself
    if (r && r.mismatch) {
      pending = entry;
      $('confirmtext').textContent = `This login is for ${r.entryHost}, but you're on ${r.pageHost}. Fill it in anyway?`;
      $('confirm').hidden = false;
      $('cno').focus();
      return;
    }
    const why = { 'no-fields': 'No login boxes found on this page.', 'not-a-site': 'Open the site first, then pick a login.', decrypt: "Couldn't unlock that password." };
    say((r && why[r.reason]) || "Couldn't fill this page.", true);
  }

  function row(e) {
    const li = document.createElement('li');
    li.className = 'entry' + (e.match ? ' match' : '');
    li.tabIndex = 0;
    li.title = e.match ? 'Fill in this login' : `Fill in (saved for ${e.host})`;
    const txt = document.createElement('div');
    txt.className = 'txt';
    const u = document.createElement('div'); u.className = 'u'; u.textContent = e.user || '(no username)';
    const h = document.createElement('div'); h.className = 'h'; h.textContent = e.host;
    txt.append(u, h);
    const acts = document.createElement('div');
    acts.className = 'acts';
    acts.append(
      iconBtn('user', 'Copy username', async () => { if (await V.copy(e.id, 'user')) say('Username copied'); }),
      iconBtn('pass', 'Copy password (cleared from clipboard in 30s)', async () => { if (await V.copy(e.id, 'pass')) say('Password copied for 30s'); }),
      iconBtn('edit', 'Edit', () => openForm(e)),
      iconBtn('del', 'Delete', () => askDelete(li, e))
    );
    li.append(txt, acts);
    li.addEventListener('click', () => fill(e, false));
    li.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') fill(e, false); });
    return li;
  }

  function askDelete(li, e) {
    if (li.classList.contains('confirm-del')) return;
    li.classList.add('confirm-del');
    const bar = document.createElement('div');
    bar.className = 'delbar';
    const t = document.createElement('span'); t.textContent = 'Delete this login?';
    const no = document.createElement('button'); no.className = 'btn'; no.textContent = 'KEEP';
    const yes = document.createElement('button'); yes.className = 'btn danger'; yes.textContent = 'DELETE';
    no.onclick = (ev) => { ev.stopPropagation(); bar.remove(); li.classList.remove('confirm-del'); };
    yes.onclick = async (ev) => { ev.stopPropagation(); await V.remove(e.id); say('Deleted'); };
    bar.append(t, no, yes);
    bar.addEventListener('click', (ev) => ev.stopPropagation());
    li.append(bar);
  }

  function render() {
    $('site').textContent = state.host || '';
    $('noenc').hidden = state.canEncrypt;
    $('add').disabled = !state.canEncrypt;
    const q = $('filter').value.trim().toLowerCase();
    const show = state.entries.filter((e) => !q || e.host.includes(q) || e.user.toLowerCase().includes(q));
    const mine = show.filter((e) => e.match), other = show.filter((e) => !e.match);
    $('l-site').replaceChildren(...mine.map(row));
    $('l-other').replaceChildren(...other.map(row));
    $('g-site').hidden = !mine.length;
    $('g-other').hidden = !other.length;
    $('empty').textContent = state.entries.length === 0
      ? 'No saved logins yet. Hit + ADD LOGIN, or type your login into a page and use "use what\'s typed on this page".'
      : show.length === 0 ? 'Nothing matches.' : '';
    $('empty').hidden = !$('empty').textContent;
  }

  async function openForm(entry) {
    editing = entry ? entry.id : null;
    revealed = false;
    $('f-pass').type = 'password';
    $('f-host').value = entry ? entry.host : state.host || '';
    $('f-user').value = entry ? entry.user : '';
    $('f-pass').value = '';
    $('f-pass').placeholder = entry ? 'leave blank to keep the current one' : '';
    $('f-pass').required = !entry;
    $('save').textContent = entry ? 'SAVE CHANGES' : 'SAVE';
    $('grab').hidden = !state.host;
    $('gen').hidden = !state.passgen;
    $('genopts').hidden = true;
    $('listview').hidden = true;
    $('formview').hidden = false;
    $('confirm').hidden = true;
    (entry ? $('f-user') : ($('f-host').value ? $('f-user') : $('f-host'))).focus();
  }
  function closeForm() {
    $('f-pass').value = '';
    $('formview').hidden = true;
    $('listview').hidden = false;
    editing = null;
    $('filter').focus();
  }

  $('add').onclick = () => openForm(null);
  $('cancel').onclick = closeForm;
  $('eye').onclick = async () => {
    revealed = !revealed;
    if (revealed && editing && !$('f-pass').value) {
      const p = await V.reveal(editing);
      if (p != null) $('f-pass').value = p;
    }
    $('f-pass').type = revealed ? 'text' : 'password';
    $('eye').classList.toggle('on', revealed);
  };
  // ---- password generator ----
  // Uses the system's secure random numbers. Avoids look-alike characters (l 1 I O 0).
  function makePassword(len, symbols) {
    const sets = ['abcdefghijkmnopqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789'];
    if (symbols) sets.push('!@#$%^&*-_=+?');
    const all = sets.join('');
    const rnd = (n) => { const a = new Uint32Array(1); const lim = Math.floor(0x100000000 / n) * n; do crypto.getRandomValues(a); while (a[0] >= lim); return a[0] % n; };
    const out = sets.map((s) => s[rnd(s.length)]);           // at least one of each kind
    while (out.length < len) out.push(all[rnd(all.length)]);
    for (let i = out.length - 1; i > 0; i--) { const j = rnd(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
    return out.join('');
  }
  function generate() {
    const len = Number($('genrange').value), sym = $('gensym').checked;
    $('f-pass').value = makePassword(len, sym);
    $('f-pass').type = 'text'; revealed = true; $('eye').classList.add('on');
    const bits = Math.round(len * Math.log2(sym ? 70 : 57));
    $('strength').textContent = `~${bits} bits :: ${bits >= 100 ? 'very strong' : 'strong'}`;
    $('genlen').textContent = len;
  }
  $('gen').onclick = () => { $('genopts').hidden = false; generate(); };
  $('genrange').addEventListener('input', generate);
  $('gensym').addEventListener('change', generate);

  $('grab').onclick = async () => {
    const g = await V.grab();
    if (!g || (!g.user && !g.pass)) { say('Type your login into the page first.', true); return; }
    if (g.host) $('f-host').value = g.host;
    if (g.user) $('f-user').value = g.user;
    if (g.pass) $('f-pass').value = g.pass;
    say('Copied from the page');
  };
  $('form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const r = await V.save({ id: editing || undefined, host: $('f-host').value, user: $('f-user').value, pass: $('f-pass').value });
    if (r && r.ok) { say(editing ? 'Saved' : 'Login saved'); closeForm(); return; }
    const why = { host: 'Enter the site, like example.com', pass: 'Enter a password', 'no-encryption': "Windows encryption isn't available." };
    say((r && why[r.reason]) || "Couldn't save.", true);
  });

  $('cno').onclick = () => { pending = null; $('confirm').hidden = true; };
  $('cyes').onclick = () => { const p = pending; pending = null; $('confirm').hidden = true; if (p) fill(p, true); };

  $('filter').addEventListener('input', render);
  $('filter').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { const first = document.querySelector('.entry'); if (first) first.click(); }
    if (ev.key === 'ArrowDown') { const first = document.querySelector('.entry'); if (first) { ev.preventDefault(); first.focus(); } }
  });
  document.addEventListener('keydown', (ev) => {
    const cur = document.activeElement;
    if (!cur || !cur.classList.contains('entry')) return;
    const all = [...document.querySelectorAll('.entry')];
    const i = all.indexOf(cur);
    if (ev.key === 'ArrowDown' && all[i + 1]) { ev.preventDefault(); all[i + 1].focus(); }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); (all[i - 1] || $('filter')).focus(); }
  });

  $('close').onclick = () => V.close();
  V.onEscape(() => {
    if (!$('confirm').hidden) { $('cno').click(); return; }
    if (!$('formview').hidden) { closeForm(); return; }
    if (!$('pinview').hidden) { $('pincancel').click(); return; }
    V.close();
  });

  // ---- PIN lock ----
  let lockTimer = null;
  function showLock(s) {
    const locked = !!s.locked;
    $('lockview').hidden = !locked;
    if (locked) { $('listview').hidden = true; $('formview').hidden = true; $('pinview').hidden = true; }
    else if ($('formview').hidden && $('pinview').hidden) $('listview').hidden = false;
    $('pinbtn').textContent = s.pinSet ? 'LOCK' : 'SET PIN';
    $('pinbtn').title = s.pinSet ? 'Lock your logins now' : 'Lock your logins with a PIN';
    clearTimeout(lockTimer);
    if (locked && s.waitUntil) {
      const tick = () => {
        const left = Math.ceil((s.waitUntil - Date.now()) / 1000);
        if (left > 0) { $('lockmsg').textContent = `Too many wrong tries. Wait ${left}s.`; $('pin').disabled = true; lockTimer = setTimeout(tick, 500); }
        else { $('lockmsg').textContent = ''; $('pin').disabled = false; $('pin').focus(); }
      };
      tick();
    } else if (locked) { $('pin').disabled = false; setTimeout(() => $('pin').focus(), 0); }
  }
  $('unlockform').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const r = await V.unlock($('pin').value);
    $('pin').value = '';
    if (r && r.ok) { $('lockmsg').textContent = ''; return; }
    if (r && r.wait) return;                                   // the state update shows the countdown
    $('lockmsg').textContent = r && r.left ? `Wrong PIN. ${r.left} tr${r.left === 1 ? 'y' : 'ies'} left.` : 'Wrong PIN.';
  });
  $('forgot').onclick = () => { $('forgotbox').hidden = false; };
  $('fno').onclick = () => { $('forgotbox').hidden = true; };
  $('fyes').onclick = async () => { await V.forgot(); $('forgotbox').hidden = true; say('Logins erased, PIN removed'); };
  $('pinbtn').onclick = () => {
    if (state.pinSet) { V.lock(); return; }
    $('listview').hidden = true; $('pinview').hidden = false; $('pin1').value = ''; $('pin2').value = ''; $('pin1').focus();
  };
  $('pincancel').onclick = () => { $('pinview').hidden = true; $('listview').hidden = false; };
  $('pinform').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const a = $('pin1').value, b = $('pin2').value;
    if (!/^\d{4,8}$/.test(a)) { say('Use 4 to 8 digits', true); return; }
    if (a !== b) { say("The two PINs don't match", true); return; }
    const r = await V.setPin('', a);
    if (r && r.ok) { $('pinview').hidden = true; $('listview').hidden = false; say('PIN set. Logins are locked from now on.'); }
    else say("Couldn't set the PIN", true);
  });
  for (const id of ['pin', 'pin1', 'pin2']) $(id).addEventListener('input', () => { $(id).value = $(id).value.replace(/\D/g, '').slice(0, 8); });

  V.onState((s) => {
    state = s;
    showLock(s);
    render();
    if (!$('formview').hidden) return;
    if (!s.locked && document.activeElement === document.body) $('filter').focus();
  });
})();
