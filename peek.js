// Frame around the floating Peek preview. The site itself is shown by the app in a
// separate scripts-off view placed exactly over #frame.
(() => {
  const $ = (id) => document.getElementById(id);
  const frame = $('frame');

  const report = () => {
    const r = frame.getBoundingClientRect();
    window.peek.layout({ x: r.left, y: r.top, width: r.width, height: r.height });
  };
  new ResizeObserver(report).observe(frame);
  addEventListener('resize', report);
  // the panel animates in; report again once it has settled
  setTimeout(report, 160);

  $('backdrop').addEventListener('mousedown', () => window.peek.close());
  $('close').addEventListener('click', () => window.peek.close());
  $('real').addEventListener('click', () => window.peek.openReal());
  $('source').addEventListener('click', () => window.peek.source());
  addEventListener('keydown', (e) => { if (e.key === 'Escape') window.peek.close(); });

  window.peek.onState((s) => {
    $('spin').hidden = !s.loading;
    $('source').classList.toggle('on', !!s.source);
    $('source').textContent = s.source ? 'PAGE' : 'SOURCE';
    $('source').title = s.source ? 'Back to the page view' : "Show this page's raw HTML";
    const url = $('url');
    url.title = s.url;
    url.replaceChildren();
    try {
      const u = new URL(s.url);
      const a = document.createElement('span'); a.className = 'dim'; a.textContent = u.protocol + '//';
      const b = document.createElement('b'); b.textContent = u.host;
      const c = document.createElement('span'); c.textContent = s.url.slice(s.url.indexOf(u.host) + u.host.length);
      url.append(a, b, c);
    } catch { url.textContent = s.url; }
  });
})();
