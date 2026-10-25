// The downloads pop-over: newest first. Click a finished file to open it;
// the folder button shows it in its folder; a running one can be cancelled.
(() => {
  const D = window.dlpop;
  const $ = (id) => document.getElementById(id);
  const ICON = {
    folder: '<svg viewBox="0 0 24 24"><path d="M3 6h7l2 2h9v11H3z"/></svg>',
    stop: '<svg viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
    file: '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><polyline points="14 3 14 7 18 7"/></svg>',
    retry: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.7"/><polyline points="20 4 20 9 15 9"/></svg>'
  };
  const fmt = (n) => (n >= 1 << 30 ? (n / (1 << 30)).toFixed(1) + ' GB' : n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : (n || 0) + ' B');
  function act(cls, title, svg, fn) {
    const b = document.createElement('button');
    b.className = 'act ' + cls; b.title = title; b.innerHTML = svg;
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    return b;
  }
  function row(d) {
    const li = document.createElement('li');
    li.className = 'dl ' + d.state;
    const ico = document.createElement('span'); ico.className = 'ico'; ico.innerHTML = ICON.file;
    const txt = document.createElement('div'); txt.className = 'txt';
    const name = document.createElement('div'); name.className = 'name'; name.textContent = d.name; name.title = d.name;
    const info = document.createElement('div'); info.className = 'info';
    const pct = d.total > 0 ? Math.min(100, Math.round((d.received / d.total) * 100)) : null;
    info.textContent = d.state === 'progressing' ? (pct === null ? fmt(d.received) : `${fmt(d.received)} of ${fmt(d.total)} · ${pct}%`)
      : d.state === 'completed' ? fmt(d.received || d.total) + ' · click to open'
      : d.state === 'cancelled' ? 'Cancelled' : 'Failed';
    txt.append(name, info);
    if (d.state === 'progressing') {
      const bar = document.createElement('div'); bar.className = 'bar' + (pct === null ? ' indeterminate' : '');
      const fill = document.createElement('span'); fill.style.width = (pct === null ? 30 : pct) + '%'; bar.append(fill); txt.append(bar);
    }
    const acts = document.createElement('span'); acts.className = 'acts';
    if (d.state === 'progressing') acts.append(act('stop', 'Cancel this download', ICON.stop, () => D.cancel(d.id)));
    else if (d.state === 'completed') acts.append(act('', 'Show in folder', ICON.folder, () => D.show(d.id)), act('stop', 'Remove from the list (the file stays)', ICON.stop, () => D.remove(d.id)));
    else acts.append(act('stop', 'Remove from the list', ICON.stop, () => D.remove(d.id)));
    li.append(ico, txt, acts);
    if (d.state === 'completed') {
      li.tabIndex = 0; li.title = 'Open ' + d.name;
      li.addEventListener('click', () => D.open(d.id));
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === li) D.open(d.id); });
    }
    return li;
  }
  D.onList((list) => {
    $('list').replaceChildren(...list.map(row));
    $('empty').hidden = list.length > 0;
    $('clear').hidden = !list.some((d) => d.state !== 'progressing');
  });
  $('close').onclick = () => D.close();
  $('clear').onclick = () => D.clear();
  $('folder').onclick = () => D.folder();
  D.onEscape(() => D.close());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') D.close(); });
  // click elsewhere = close, like Firefox (ignoring the first moment: the click on
  // the toolbar button that opened it can still pull focus back to the toolbar)
  const openedAt = Date.now();
  window.addEventListener('blur', () => setTimeout(() => {
    if (document.hasFocus()) return;
    if (Date.now() - openedAt < 600) { D.focus(); return; }
    D.close(true);
  }, 120));
  D.ready();
})();
