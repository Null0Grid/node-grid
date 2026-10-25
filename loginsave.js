// "Save this login?" — SAVE / NOT NOW / NEVER FOR THIS SITE, plus "Keep me signed in".
(() => {
  const L = window.loginsave, $ = (id) => document.getElementById(id);
  function fill(i) {
    if (!i) return;
    $('title').textContent = i.update ? 'UPDATE PASSWORD?' : 'SAVE LOGIN?';
    $('site').textContent = i.host;
    $('user').textContent = i.user || '(no username)';
    $('save').textContent = i.update ? 'UPDATE' : 'SAVE';
    $('keephost').textContent = i.keepHost;
    $('keeprow').hidden = !!i.kept || !i.keepHost;      // already kept: nothing to ask
  }
  L.info().then(fill); L.onInfo(fill);
  const keep = () => !$('keeprow').hidden && $('keep').checked;
  $('save').onclick = () => L.choose('save', keep());
  $('later').onclick = () => L.choose('later');
  $('close').onclick = () => L.choose('later');
  $('never').onclick = () => L.choose('never');
  L.onEscape(() => L.choose('later'));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') L.choose('later'); });
})();
