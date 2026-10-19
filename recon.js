// Recon popup: fills in each section as its lookup comes back. All text is set with
// textContent, so nothing a server returns can inject markup here.
(() => {
  const $ = (id) => document.getElementById(id);
  const R = window.recon;
  const data = {};

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const row = (k, v, cls) => { const r = el('div', 'row' + (cls ? ' ' + cls : '')); r.append(el('span', 'k', k), el('span', 'val', v)); return r; };
  const fill = (key, nodes) => {
    const box = document.querySelector(`section[data-k="${key}"] .v`);
    box.className = 'v';
    box.replaceChildren(...nodes);
  };
  const err = (key, msg) => fill(key, [el('div', 'bad', msg)]);

  const render = {
    target: (d) => { $('host').textContent = d.host; $('host').title = d.url; },
    ips: (d) => {
      if (d.error) return err('ips', `Couldn't resolve (${d.error})`);
      fill('ips', d.ips.map((ip) => row(ip === d.connected ? 'connected' : (ip.includes(':') ? 'IPv6' : 'IPv4'), ip, ip === d.connected ? 'hi' : '')));
    },
    asn: (d) => {
      if (d.error) return err('asn', `Lookup failed (${d.error})`);
      if (d.note) return fill('asn', [el('div', 'dim', d.note)]);
      fill('asn', [row('owner', d.name || '—', 'hi'), row('ASN', d.asn), row('prefix', d.prefix || '—'), row('country', d.country || '—'), row('registry', (d.registry || '—').toUpperCase())]);
    },
    tls: (d) => {
      if (!d.ok) return err('tls', d.error || 'No certificate');
      const left = d.daysLeft;
      fill('tls', [
        row('status', d.trusted ? 'Trusted' : `NOT trusted (${d.error})`, d.trusted ? 'good' : 'bad'),
        row('issued to', d.subject || '—'),
        row('issued by', d.issuer || '—'),
        row('expires', `${d.validTo}${left != null ? `  (${left} day${left === 1 ? '' : 's'})` : ''}`, left != null && left < 14 ? 'bad' : ''),
        row('covers', `${d.names} name${d.names === 1 ? '' : 's'}`),
        row('protocol', `${d.protocol}  ${d.cipher}`)
      ]);
    },
    http: (d) => {
      const g = el('div', 'grade g-' + d.grade.replace('+', 'p'), d.grade);
      const head = el('div', 'gradebox');
      const info = el('div', 'gradeinfo');
      info.append(row('status', d.status || '—'));
      if (d.server) info.append(row('server', d.server));
      if (d.poweredBy) info.append(row('powered by', d.poweredBy));
      head.append(g, info);
      const list = el('ul', 'checks');
      for (const c of d.checks) { const li = el('li', c.ok ? 'ok' : 'no', c.name); list.append(li); }
      fill('http', [head, list]);
    },
    dns: (d) => {
      if (d.error) return err('dns', d.error);
      if (d.note) return fill('dns', [el('div', 'dim', d.note)]);
      const out = [];
      for (const k of ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT']) for (const v of d[k] || []) out.push(row(k, v, k === 'TXT' ? 'wrap' : ''));
      fill('dns', out.length ? out : [el('div', 'dim', 'No records returned')]);
    }
  };

  R.onPart((key, d) => { data[key] = d; try { render[key] && render[key](d); } catch (e) { err(key, 'Could not show this result'); } });

  // Plain-text report for the clipboard
  $('copy').onclick = () => {
    const lines = [`NODE_GRID RECON :: ${data.target ? data.target.url : ''}`, `Taken ${new Date().toISOString()}`, ''];
    for (const s of document.querySelectorAll('section')) {
      lines.push('[' + s.querySelector('h3').textContent + ']');
      for (const r of s.querySelectorAll('.row')) lines.push('  ' + r.querySelector('.k').textContent.padEnd(12) + r.querySelector('.val').textContent);
      for (const li of s.querySelectorAll('.checks li')) lines.push('  ' + (li.className === 'ok' ? '[x] ' : '[ ] ') + li.textContent);
      const g = s.querySelector('.grade'); if (g) lines.push('  grade       ' + g.textContent);
      for (const n of s.querySelectorAll('.dim, .bad')) if (!n.closest('.row')) lines.push('  ' + n.textContent);
      lines.push('');
    }
    R.copy(lines.join('\n'));
    const st = $('status'); st.textContent = 'Report copied'; st.classList.add('on'); setTimeout(() => st.classList.remove('on'), 1500);
  };
  $('close').onclick = () => R.close();
  R.onEscape(() => R.close());
})();
