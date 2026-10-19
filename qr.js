// QR pop-up. The SVG comes from the app's QR generator (squares only, no page content).
(() => {
  const $ = (id) => document.getElementById(id);
  let url = '';
  window.qr.onShow((d) => {
    url = d.url;
    $('qr').innerHTML = d.svg;
    $('qtitle').textContent = d.title || '';
    $('qurl').textContent = d.url;
    $('qnote').textContent = d.local
      ? "Point your phone's camera at the code. This is a local address, so your phone must be on the same network."
      : "Point your phone's camera at the code.";
  });
  $('copy').onclick = () => {
    window.qr.copy(url);
    const s = $('status'); s.textContent = 'Link copied'; s.classList.add('on'); setTimeout(() => s.classList.remove('on'), 1400);
  };
  $('close').onclick = () => window.qr.close();
  window.qr.onEscape(() => window.qr.close());
})();
