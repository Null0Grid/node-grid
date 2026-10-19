// Reader mode: shows the article Readability pulled out of the page. The article HTML
// comes from a website, so it's rebuilt here tag by tag from a short allow-list:
// no scripts, no styles, no event handlers, no iframes; links and images only.
(() => {
  const R = window.nodegridReader;
  const $ = (id) => document.getElementById(id);
  const id = new URLSearchParams(location.search).get('id');
  const data = R && R.get(id);
  const art = data && data.article;
  if (!art) { $('title').textContent = 'This article is no longer available'; $('meta').textContent = 'Reload the original page and open reader mode again.'; return; }

  // ---- safe rebuild of the article ----
  const ALLOWED = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'em', 'strong', 'b', 'i', 'u', 's',
    'a', 'img', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'br', 'hr', 'sup', 'sub', 'small', 'span', 'div', 'section', 'dl', 'dt', 'dd', 'mark', 'picture', 'abbr', 'time', 'cite', 'q', 'kbd', 'caption']);
  const base = art.url;
  const abs = (u) => { try { const x = new URL(u, base); return /^(https?|data):$/.test(x.protocol) ? x.href : null; } catch { return null; } };
  function rebuild(src, dst) {
    for (const n of src.childNodes) {
      if (n.nodeType === 3) { dst.append(document.createTextNode(n.nodeValue)); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase();
      if (!ALLOWED.has(tag)) { if (!/^(script|style|iframe|object|embed|form|input|button|svg|noscript|template)$/.test(tag)) rebuild(n, dst); continue; }
      if (tag === 'picture') { rebuild(n, dst); continue; }
      const el = document.createElement(tag);
      if (tag === 'a') { const h = abs(n.getAttribute('href') || ''); if (h && !h.startsWith('data:')) { el.href = h; el.rel = 'noopener noreferrer'; } }
      if (tag === 'img') {
        const srcset = (n.getAttribute('srcset') || '').split(',').map((x) => x.trim().split(/\s+/)[0]).filter(Boolean);
        const s = abs(n.getAttribute('src') || n.getAttribute('data-src') || srcset[srcset.length - 1] || '');
        if (!s) continue;
        el.src = s; el.alt = n.getAttribute('alt') || ''; el.loading = 'lazy';
      }
      if (tag === 'td' || tag === 'th') { for (const a of ['colspan', 'rowspan']) if (n.getAttribute(a)) el.setAttribute(a, String(parseInt(n.getAttribute(a), 10) || 1)); }
      rebuild(n, el);
      dst.append(el);
    }
  }
  const parsed = new DOMParser().parseFromString(art.content, 'text/html');
  rebuild(parsed.body, $('content'));

  $('title').textContent = art.title || '';
  document.title = (art.title || 'Reader') + ' :: Reader';
  let host = ''; try { host = new URL(art.url).hostname.replace(/^www\./, ''); } catch {}
  $('site').textContent = art.siteName || host;
  const words = (art.length || 0) / 5.5;
  $('meta').textContent = [art.byline, art.published ? new Date(art.published).toLocaleDateString() : '', words ? `${Math.max(1, Math.round(words / 230))} min read` : ''].filter(Boolean).join('  ::  ');
  $('src').textContent = art.url; $('src').href = art.url;
  if (art.lang) document.documentElement.lang = art.lang;

  // ---- look: size, width, theme (remembered) ----
  const prefs = Object.assign({ size: 20, width: 'normal', theme: 'neon' }, data.prefs || {});
  const WIDTHS = ['narrow', 'normal', 'wide'], THEMES = ['neon', 'paper', 'sepia'];
  function apply() {
    document.body.className = prefs.theme + ' w-' + prefs.width;
    document.documentElement.style.setProperty('--size', prefs.size + 'px');
  }
  const save = () => { apply(); R.prefs(prefs); };
  apply();
  $('smaller').onclick = () => { prefs.size = Math.max(14, prefs.size - 2); save(); };
  $('bigger').onclick = () => { prefs.size = Math.min(28, prefs.size + 2); save(); };
  $('width').onclick = () => { prefs.width = WIDTHS[(WIDTHS.indexOf(prefs.width) + 1) % WIDTHS.length]; save(); };
  $('theme').onclick = () => { prefs.theme = THEMES[(THEMES.indexOf(prefs.theme) + 1) % THEMES.length]; save(); };
  $('exit').onclick = () => R.exit();
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') R.exit(); });

  // ---- save as Markdown ----
  let toastT = null;
  const toast = (t) => { const n = $('toast'); n.textContent = t; n.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => n.classList.remove('on'), 2000); };
  if (!data.md) $('savemd').hidden = true;
  $('savemd').onclick = async () => {
    const md = nodegridToMarkdown($('content'), art.url);
    const r = await R.saveMd(id, md);
    toast(r && r.ok ? 'Saved to your Vault as Markdown' : "Couldn't save");
  };
})();
