// What's new: one block per version you haven't seen, newest first.
(() => {
  const W = window.whatsnew, $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  W.info().then((i) => {
    if (!i) return;
    $('ver').textContent = 'v' + i.current;
    for (const v of i.versions) {
      const sec = el('section');
      sec.append(el('h2', null, v.version + (v.title ? ' :: ' + v.title : '')));
      if (v.new.length) { sec.append(el('h3', 'new', 'NEW')); const ul = el('ul'); for (const t of v.new) ul.append(el('li', null, t)); sec.append(ul); }
      if (v.fixed.length) { sec.append(el('h3', 'fix', 'FIXED')); const ul = el('ul'); for (const t of v.fixed) ul.append(el('li', null, t)); sec.append(ul); }
      $('notes').append(sec);
    }
    $('tour').hidden = !i.hasTour;
    $('ok').focus();
  });
  $('ok').onclick = () => W.close();
  $('close').onclick = () => W.close();
  $('tour').onclick = () => W.tour();
  W.onEscape(() => W.close());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') W.close(); });
})();
