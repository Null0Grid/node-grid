// Unlock to fill: type your PIN, the saved login goes into the page.
(() => {
  const U = window.unlockfill, $ = (id) => document.getElementById(id);
  const fill = (i) => { if (!i) return; $('host').textContent = i.host; $('user').textContent = i.user || ''; setTimeout(() => $('pin').focus(), 0); };
  U.info().then(fill); U.onInfo(fill);
  $('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await U.unlock($('pin').value);
    $('pin').value = '';
    if (r && r.ok) return;
    $('msg').textContent = r && r.wait ? 'Too many tries. Wait 30 seconds.' : r && r.left ? `Wrong PIN (${r.left} ${r.left === 1 ? 'try' : 'tries'} left)` : 'Wrong PIN';
    $('pin').focus();
  });
  $('close').onclick = () => U.close();
  U.onEscape(() => U.close());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') U.close(); });
})();
