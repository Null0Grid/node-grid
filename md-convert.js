// HTML -> Markdown for saving text pages to the Vault. Works on a DOM element (the
// reader view's article, or a page's main content). Plain function, no dependencies;
// the app also injects this file into pages to convert them in place.
function nodegridToMarkdown(root, baseUrl) {
  const abs = (u) => { try { return new URL(u, baseUrl || location.href).href; } catch { return u || ''; } };
  const esc = (t) => t.replace(/([\\`*_[\]#])/g, '\\$1');
  const inline = (node) => {
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { out += esc(n.nodeValue.replace(/\s+/g, ' ')); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase();
      const inner = () => inline(n);
      if (tag === 'br') out += '  \n';
      else if (tag === 'strong' || tag === 'b') { const t = inner().trim(); if (t) out += `**${t}**`; }
      else if (tag === 'em' || tag === 'i') { const t = inner().trim(); if (t) out += `*${t}*`; }
      else if (tag === 'code') out += '`' + n.textContent.replace(/`/g, 'ˋ') + '`';
      else if (tag === 'a') { const t = inner().trim(); const h = n.getAttribute('href'); out += h && !/^javascript:/i.test(h) ? `[${t || abs(h)}](${abs(h)})` : t; }
      else if (tag === 'img') { const s = n.getAttribute('src'); if (s && !/^data:/i.test(s)) out += `![${(n.getAttribute('alt') || '').replace(/[\[\]]/g, '')}](${abs(s)})`; }
      else if (tag === 'script' || tag === 'style' || tag === 'noscript') { /* skip */ }
      else out += inner();
    }
    return out;
  };
  const blocks = [];
  const walk = (node, depth) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { const t = n.nodeValue.trim(); if (t) blocks.push(esc(t.replace(/\s+/g, ' '))); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) { const t = inline(n).trim(); if (t) blocks.push('#'.repeat(Number(tag[1])) + ' ' + t); }
      else if (tag === 'p') { const t = inline(n).trim(); if (t) blocks.push(t); }
      else if (tag === 'pre') blocks.push('```\n' + n.textContent.replace(/\n+$/, '') + '\n```');
      else if (tag === 'blockquote') { const sub = nodegridToMarkdown(n, baseUrl); if (sub) blocks.push(sub.split('\n').map((l) => '> ' + l).join('\n')); }
      else if (tag === 'ul' || tag === 'ol') {
        let i = 1; const lines = [];
        for (const li of n.children) {
          if (li.tagName.toLowerCase() !== 'li') continue;
          const nested = [...li.children].filter((c) => /^(ul|ol)$/i.test(c.tagName));
          const clone = li.cloneNode(true); for (const c of [...clone.children]) if (/^(ul|ol)$/i.test(c.tagName)) c.remove();
          lines.push('  '.repeat(depth) + (tag === 'ol' ? `${i++}. ` : '- ') + inline(clone).trim());
          for (const sub of nested) { const tmp = document.createElement('div'); tmp.append(sub.cloneNode(true)); const before = blocks.length; walk(tmp, depth + 1); lines.push(...blocks.splice(before)); }
        }
        if (lines.length) blocks.push(lines.join('\n'));
      }
      else if (tag === 'hr') blocks.push('---');
      else if (tag === 'img' || tag === 'a' || tag === 'strong' || tag === 'em' || tag === 'code' || tag === 'b' || tag === 'i') { const t = inline({ childNodes: [n] }).trim(); if (t) blocks.push(t); }
      else if (tag === 'figure') {
        const img = n.querySelector('img'); const cap = n.querySelector('figcaption');
        if (img && img.getAttribute('src') && !/^data:/i.test(img.getAttribute('src'))) blocks.push(`![${(img.getAttribute('alt') || '').replace(/[\[\]]/g, '')}](${abs(img.getAttribute('src'))})`);
        if (cap) blocks.push('*' + inline(cap).trim() + '*');
      }
      else if (tag === 'table') {
        const rows = [...n.querySelectorAll('tr')].map((tr) => [...tr.children].map((c) => inline(c).trim().replace(/\|/g, '\\|')));
        if (rows.length) {
          const w = Math.max(...rows.map((r) => r.length));
          const line = (r) => '| ' + Array.from({ length: w }, (_, k) => r[k] || '').join(' | ') + ' |';
          blocks.push([line(rows[0]), '| ' + Array(w).fill('---').join(' | ') + ' |', ...rows.slice(1).map(line)].join('\n'));
        }
      }
      else if (/^(script|style|noscript|nav|footer|aside|form|button|svg|iframe)$/.test(tag)) { /* not content */ }
      else walk(n, depth);
    }
  };
  walk(root, 0);
  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}
if (typeof module === 'object' && module.exports) module.exports = nodegridToMarkdown;
