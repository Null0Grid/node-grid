'use strict';
// ---------- Null Drive connection ----------
// The browser itself talks to your Null Drive (on this PC or a homelab server), never
// the web page and never the NODE_GRID search server. The Drive address and token are
// saved on this PC only; the token is encrypted by Windows.
//
// Handshake = GET /api/v1/me with the token. It tells us, in one call: the address
// answers, it is a Null Drive, the token works, and whether the account is end-to-end
// encrypted (Drive can't search those).
//
// Calls used (Null Drive API v1):
//   GET /api/v1/me                      handshake
//   GET /api/v1/search?q=&limit=        search (shared Null search contract)
//   GET /api/v1/files/{path}            view / download a file

const http = require('http');
const tls = require('tls');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PRIVATE = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|::1|f[cd][0-9a-f]{2}:.*|fe80:.*|[^.]+|.+\.(lan|home|home\.arpa|internal|local|localdomain))$/i;
const VIEW_MAX = 25 * 1024 * 1024;          // bigger files: download only
const TEXT_EXT = /\.(md|markdown|txt|text|log|csv|json|ya?ml|toml|ini|conf|cfg|xml|html?|css|js|ts|py|sh|ps1|bat|go|rs|c|h|cpp|java|sql|canvas)$/i;
const IMG = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif' };

// "192.168.1.50:8080" -> "http://192.168.1.50:8080". Returns '' if it isn't an address.
function normAddress(input) {
  let s = String(input || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  s = s.replace(/\/api(\/v\d+)?$/i, '');
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol) || !u.hostname || u.username || u.password) return '';
    return (u.origin + u.pathname).replace(/\/+$/, '');
  } catch { return ''; }
}
const hostOf = (base) => { try { return new URL(base).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return ''; } };
const isPrivate = (base) => PRIVATE.test(hostOf(base));
// a private IP address (or this computer) only: names like nas.lan can be answered by any network you're on
const isPrivateIp = (base) => /^(127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|::1|localhost)$/i.test(hostOf(base));
// Each path segment URL-encoded, "/" kept: "Null Notes/Plan.md" -> "Null%20Notes/Plan.md"
const encPath = (p) => String(p).split('/').filter(Boolean).map(encodeURIComponent).join('/');

module.exports = function createDrive({ getSettings, saveSettings, enc, dec, canEncrypt, downloadsDir, onChange }) {
  const S = () => { const s = getSettings(); s.nullDrive = s.nullDrive || {}; return s.nullDrive; };
  let live = { state: 'off' };                       // last handshake result (memory only)
  const allowed = new Map();                         // path -> name, from this session's searches

  const token = () => { try { return S().token ? dec(S().token) : ''; } catch { return ''; } };
  const configured = () => !!(S().url && S().token);

  // One request to Drive. Accepts self-signed HTTPS only for devices you already trusted
  // in NODE_GRID (Settings > Trusted local devices), same as for web pages.
  // For https the TLS handshake is done first and the certificate checked before a
  // single byte (and so the token) is sent; only then does the request go out on
  // that socket.
  function secureSocket(u, timeout) {
    return new Promise((resolve, reject) => {
      const host = u.hostname.replace(/^\[|\]$/g, '');
      const sock = tls.connect({ host, port: Number(u.port) || 443, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] });
      const fail = (err) => { sock.destroy(); reject(err); };
      sock.setTimeout(timeout, () => fail(Object.assign(new Error('timed out'), { kind: 'unreachable' })));
      sock.once('error', (err) => fail(err.kind ? err : Object.assign(err, { kind: 'unreachable' })));
      sock.once('secureConnect', () => {
        if (!sock.authorized) {
          const c = sock.getPeerCertificate();
          const fp = c && c.raw ? 'sha256/' + crypto.createHash('sha256').update(c.raw).digest('base64') : '';
          const t = (getSettings().trustedCerts || {})[u.hostname.toLowerCase()];
          if (!t || t.fingerprint !== fp) return fail(Object.assign(new Error('untrusted certificate'), { kind: 'cert' }));
        }
        sock.setTimeout(0); sock.removeAllListeners('error');
        resolve(sock);
      });
    });
  }
  async function request(base, p, { timeout = 4000, tok = token(), stream = false } = {}) {
    let u; try { u = new URL(base + p); } catch { throw Object.assign(new Error('bad address'), { kind: 'address' }); }
    if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error('bad address'), { kind: 'address' });
    const sock = u.protocol === 'https:' ? await secureSocket(u, timeout) : null;
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port) || (sock ? 443 : 80), path: u.pathname + u.search,
        method: 'GET', timeout,
        headers: { Authorization: 'Bearer ' + tok, Accept: 'application/json, */*', 'User-Agent': 'NODE_GRID' },
        ...(sock ? { createConnection: () => sock } : {})
      }, (res) => {
        if (stream) { resolve(res); return; }
        const bufs = []; let n = 0;
        res.on('data', (d) => { n += d.length; if (n > VIEW_MAX + 1024) { res.destroy(); reject(Object.assign(new Error('too big'), { kind: 'big' })); } else bufs.push(d); });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(bufs) }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { kind: 'unreachable' })));
      req.on('error', (err) => reject(err.kind ? err : Object.assign(err, { kind: 'unreachable' })));
      req.end();
    });
  }
  const json = (r) => { try { return JSON.parse(r.body.toString('utf8')); } catch { return null; } };
  const errCode = (j) => (j && j.error && (j.error.code || j.error)) || '';

  async function handshake(base = S().url, tok = token()) {
    if (!base || !tok) { live = { state: 'off' }; return live; }
    const at = new Date().toISOString();
    try {
      const r = await request(base, '/api/v1/me', { tok });
      const j = json(r);
      if (r.status === 401 || r.status === 403) live = { state: 'token', at };
      else if (r.status !== 200 || !j || typeof j.user !== 'object' || !j.user) live = { state: 'not-drive', at, detail: 'HTTP ' + r.status };
      else {
        const u = j.user;
        const name = String(u.name || u.username || u.login || '').slice(0, 80);
        const e2ee = String(u.e2ee || 'off');
        live = { state: e2ee === 'off' ? 'connected' : 'encrypted', user: name, at };
      }
    } catch (err) {
      live = { state: err.kind === 'cert' ? 'cert' : 'unreachable', at, detail: err.code || err.message };
    }
    if (onChange) onChange();
    return live;
  }

  function status() {
    const s = S();
    return {
      configured: configured(), url: s.url || '', hasToken: !!s.token,
      state: configured() ? live.state : 'off', user: live.user || '', at: live.at || '',
      plain: !!s.url && /^http:/i.test(s.url) && !isPrivateIp(s.url),     // token would travel unencrypted to whoever answers for that name
      plainName: !!s.url && /^http:/i.test(s.url) && !isPrivateIp(s.url) && isPrivate(s.url)
    };
  }

  async function connect(address, newToken) {
    const base = normAddress(address);
    if (!base) return { ok: false, reason: 'address' };
    const tok = String(newToken || '').trim() || (S().url ? token() : '');
    if (!tok) return { ok: false, reason: 'token' };
    if (!canEncrypt()) return { ok: false, reason: 'encrypt' };
    const s = S();
    s.url = base; s.token = enc(tok);
    saveSettings();
    allowed.clear();
    await handshake(base, tok);
    return { ok: true };
  }

  function disconnect() { const s = getSettings(); delete s.nullDrive; saveSettings(); live = { state: 'off' }; allowed.clear(); if (onChange) onChange(); }

  // Search, for the Vault section of the results page.
  async function search(q) {
    q = String(q || '').trim().slice(0, 300);
    if (!configured()) return { ok: false, state: 'off' };
    if (!q) return { ok: true, items: [] };
    try {
      const r = await request(S().url, '/api/v1/search?' + new URLSearchParams({ q, limit: '25' }), { timeout: 5000 });
      if (r.status === 401 || r.status === 403) { live = { ...live, state: 'token' }; return { ok: false, state: 'token' }; }
      const j = json(r);
      if (r.status !== 200 || !Array.isArray(j)) return { ok: false, state: 'error', detail: errCode(j) || 'HTTP ' + r.status };
      if (String(r.headers['x-nulldrive-search'] || '') === 'encrypted') { live = { ...live, state: 'encrypted' }; return { ok: false, state: 'encrypted' }; }
      if (live.state !== 'connected') { live = { ...live, state: 'connected' }; }
      const items = j.slice(0, 25).filter((x) => x && typeof x.path === 'string').map((x) => ({
        id: String(x.id || ''), title: String(x.title || x.path.split('/').pop()).slice(0, 300),
        snippet: String(x.snippet || '').slice(0, 600), path: x.path.slice(0, 1000),
        modified: String(x.modified || '').slice(0, 40)
      }));
      for (const it of items) allowed.set(it.path, it.title);
      return { ok: true, items, user: live.user || '' };
    } catch (err) {
      live = { ...live, state: err.kind === 'cert' ? 'cert' : 'unreachable' };
      return { ok: false, state: live.state };
    }
  }

  // Only files that one of your searches returned can be opened or downloaded.
  const canOpen = (p) => typeof p === 'string' && allowed.has(p);

  async function view(p) {
    if (!configured()) return { ok: false, reason: 'off' };
    if (!canOpen(p)) return { ok: false, reason: 'not-allowed' };
    const name = p.split('/').pop();
    const ext = (name.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
    try {
      const r = await request(S().url, '/api/v1/files/' + encPath(p), { timeout: 15000 });
      const j = r.status === 200 ? null : json(r);
      if (r.status === 403 && errCode(j) === 'insufficient_scope') return { ok: false, reason: 'scope' };
      if (r.status === 401 || r.status === 403) return { ok: false, reason: 'token' };
      if (r.status === 404) return { ok: false, reason: 'gone' };
      if (r.status === 409) return { ok: false, reason: 'encrypted' };
      if (r.status !== 200) return { ok: false, reason: 'error', detail: 'HTTP ' + r.status };
      const out = { ok: true, name, path: p, size: r.body.length };
      if (IMG[ext]) return { ...out, kind: 'image', mime: IMG[ext], data: r.body.toString('base64') };
      if (TEXT_EXT.test(name) || !r.body.subarray(0, 4096).includes(0)) {
        return { ...out, kind: /\.(md|markdown)$/i.test(name) ? 'markdown' : 'text', text: r.body.toString('utf8') };
      }
      return { ...out, kind: 'binary' };
    } catch (err) {
      if (err.kind === 'big') return { ok: false, reason: 'big' };
      return { ok: false, reason: err.kind === 'cert' ? 'cert' : 'unreachable' };
    }
  }

  // Streams the file into your Downloads folder (a new name if one already exists).
  async function download(p) {
    if (!configured()) return { ok: false, reason: 'off' };
    if (!canOpen(p)) return { ok: false, reason: 'not-allowed' };
    const clean = (p.split('/').pop() || 'download').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'download';
    let res;
    try { res = await request(S().url, '/api/v1/files/' + encPath(p), { timeout: 30000, stream: true }); }
    catch (err) { return { ok: false, reason: err.kind === 'cert' ? 'cert' : 'unreachable' }; }
    if (res.statusCode !== 200) {
      const bufs = []; for await (const d of res) bufs.push(d);
      let j = null; try { j = JSON.parse(Buffer.concat(bufs).toString('utf8')); } catch {}
      if (res.statusCode === 403 && errCode(j) === 'insufficient_scope') return { ok: false, reason: 'scope' };
      if (res.statusCode === 401 || res.statusCode === 403) return { ok: false, reason: 'token' };
      if (res.statusCode === 404) return { ok: false, reason: 'gone' };
      return { ok: false, reason: 'error', detail: 'HTTP ' + res.statusCode };
    }
    const dir = downloadsDir();
    const ext = path.extname(clean), stem = clean.slice(0, clean.length - ext.length);
    let file = path.join(dir, clean);
    for (let i = 1; fs.existsSync(file); i++) file = path.join(dir, `${stem} (${i})${ext}`);
    const tmp = file + '.ngpart';
    try {
      await new Promise((resolve, reject) => {
        const w = fs.createWriteStream(tmp);
        res.on('error', reject); w.on('error', reject); w.on('finish', resolve);
        res.pipe(w);
      });
      fs.renameSync(tmp, file);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch {}
      return { ok: false, reason: 'write', detail: err.message };
    }
    return { ok: true, file, name: path.basename(file) };
  }

  return { normAddress, handshake, status, connect, disconnect, search, view, download, configured };
};
module.exports.normAddress = normAddress;
