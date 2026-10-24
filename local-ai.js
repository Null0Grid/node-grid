// The built-in local AI chat. Talks (through the app) to Ollama or any OpenAI-style
// server you point it at. Messages are shown as plain text (code blocks kept), never as
// HTML, so nothing an AI writes can run here.
(() => {
  const $ = (id) => document.getElementById(id);
  const L = window.localAI;
  let server = null;            // { url, kind, models }
  let messages = [];            // the conversation, in memory only
  let busy = null;              // request id while streaming
  let pageCtx = null;           // attached page text

  const el = (t, c, txt) => { const n = document.createElement(t); if (c) n.className = c; if (txt != null) n.textContent = txt; return n; };

  // ---- server ----
  function setConnected(s) {
    server = s;
    $('dot').className = 'dot' + (s ? ' on' : '');
    $('dot').title = s ? `Connected: ${s.url} (${s.kind === 'ollama' ? 'Ollama' : 'OpenAI-style API'})` : 'Not connected';
    const sel = $('model');
    sel.replaceChildren(...(s && s.models.length ? s.models : ['no model']).map((m) => { const o = el('option', null, m); o.value = m; return o; }));
    sel.disabled = !(s && s.models.length);
    try { const last = localStorage.getItem('localModel'); if (last && s && s.models.includes(last)) sel.value = last; } catch {}
    $('msg').disabled = $('send').disabled = !(s && s.models.length);
    $('setup').hidden = !!s;
    if (s && !s.models.length) { $('setup').hidden = false; $('setuplead').textContent = `Connected to ${s.url}, but it has no models yet. For Ollama run: ollama pull llama3.2`; }
    if (s) $('srv').value = s.url;
    if (s && s.models.length) $('msg').focus();
  }
  async function connect(url) {
    $('setuplead').textContent = url ? `Connecting to ${url}…` : 'Looking for an AI on this PC…';
    $('setup').hidden = false;
    const r = await L.detect(url);
    if (r && r.url) { setConnected(r); return; }
    setConnected(null);
    $('setuplead').textContent = url
      ? `No AI answered at ${url}. Check the address and that the server is running.`
      : "No AI found on this PC (checked Ollama on 11434, LM Studio on 1234, and 8080 / 5001). Enter your server's address below.";
  }
  $('model').addEventListener('change', () => { try { localStorage.setItem('localModel', $('model').value); } catch {} });
  $('setupbtn').onclick = () => { $('setup').hidden = !$('setup').hidden; };
  $('scan').onclick = () => connect('');
  $('srvform').addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = $('key').value.trim();
    if (key) { const ok = await L.setKey(key); $('key').value = ''; $('key').placeholder = ok ? 'saved (encrypted on this computer)' : "couldn't save the key"; }
    connect($('srv').value.trim());
  });

  // ---- messages ----
  // Show text with ``` code blocks as boxes; everything else as plain text.
  function renderText(node, text) {
    node.replaceChildren();
    const parts = String(text).split(/```/);
    parts.forEach((p, i) => {
      if (i % 2 === 1) {
        const nl = p.indexOf('\n');
        const lang = nl > 0 && nl < 20 ? p.slice(0, nl).trim() : '';
        const pre = el('pre', 'code', lang ? p.slice(nl + 1) : p);
        if (lang) pre.dataset.lang = lang;
        node.append(pre);
      } else if (p) node.append(el('span', 'txt', p));
    });
  }
  function bubble(role, text) {
    $('hello').hidden = true;
    const b = el('div', 'msg ' + role);
    b.append(el('div', 'who', role === 'user' ? 'YOU' : ($('model').value || 'AI').toUpperCase()));
    const body = el('div', 'body'); renderText(body, text); b.append(body);
    $('log').append(b);
    $('log').scrollTop = $('log').scrollHeight;
    return body;
  }
  function setBusy(id) {
    busy = id;
    $('stop').hidden = !id; $('send').hidden = !!id;
    $('msg').disabled = !!id || !server;
  }
  let liveBody = null, liveText = '';
  L.onChunk((id, text) => {
    if (id !== busy || !liveBody) return;
    liveText += text;
    renderText(liveBody, liveText);
    const log = $('log'); if (log.scrollHeight - log.scrollTop - log.clientHeight < 120) log.scrollTop = log.scrollHeight;
  });
  L.onDone((id, err) => {
    if (id !== busy) return;
    if (liveText) messages.push({ role: 'assistant', content: liveText });
    if (err) { const e2 = el('div', 'err', err); liveBody.parentNode.append(e2); }
    if (!liveText && !err) liveBody.parentNode.remove();
    liveBody = null; liveText = '';
    setBusy(null); $('msg').focus();
  });
  function send() {
    const text = $('msg').value.trim();
    if (!text || busy || !server) return;
    $('msg').value = '';
    let content = text;
    if (pageCtx) {
      content = `Here is the web page I'm looking at.\nTitle: ${pageCtx.title}\nAddress: ${pageCtx.url}\n---\n${pageCtx.text}\n---\n\n${text}`;
      bubble('user', text + `\n\n[+ page: ${pageCtx.title}]`);
      pageCtx = null; $('attach').hidden = true;
    } else bubble('user', text);
    messages.push({ role: 'user', content });
    liveBody = bubble('assistant', '…'); liveText = '';
    const id = 'q' + Date.now();
    setBusy(id);
    L.chat(id, { url: server.url, kind: server.kind, model: $('model').value, messages });
  }
  $('ask').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  $('msg').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  $('stop').onclick = () => { if (busy) L.stop(busy); };
  $('clear').onclick = () => {
    if (busy) { L.stop(busy); setBusy(null); }    // the stopped answer must not land in the new chat
    liveBody = null; liveText = '';
    messages = []; pageCtx = null; $('attach').hidden = true;
    for (const n of [...$('log').querySelectorAll('.msg')]) n.remove();
    $('hello').hidden = false;
  };
  $('pagebtn').onclick = async () => {
    const p = await L.page();
    if (!p || !p.text) { $('attachtxt').textContent = 'Open a web page in a tab first.'; $('attach').hidden = false; pageCtx = null; return; }
    pageCtx = p;
    const n = p.text.length;
    $('attachtxt').textContent = `+ page: ${p.title || p.url} (${n < 1000 ? n : Math.round(n / 100) / 10 + 'k'} characters)`;
    $('attach').hidden = false;
    $('msg').focus();
  };
  $('detach').onclick = () => { pageCtx = null; $('attach').hidden = true; };

  L.hasKey().then((k) => { if (k) $('key').placeholder = 'saved (encrypted on this computer)'; });
  connect('');
})();
