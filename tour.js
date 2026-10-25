// Packet's walkthrough: plays once on the first start; SKIP / LET'S GO close it.
(() => {
  const T = window.tour, $ = (id) => document.getElementById(id), v = $('v');
  v.addEventListener('ended', () => { $('done').hidden = false; $('skip').hidden = true; $('done').focus(); });
  v.volume = 0.6;                           // background music, not loud
  v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });   // if sound can't autoplay, play muted (the controls can unmute)                 // autoplay can be refused; the controls are there
  $('skip').onclick = () => T.close();
  $('done').onclick = () => T.close();
  $('close').onclick = () => T.close();
  T.onEscape(() => T.close());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') T.close(); });
})();
