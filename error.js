// Fills in the error page from its query string. Everything is set with
// textContent, so a hostile URL can't inject anything into the page.
(() => {
  const q = new URLSearchParams(location.search);
  const target = q.get('url') || '';
  const home = q.get('home') || '';
  const kind = q.get('kind') || 'net';        // 'net' (couldn't connect) or 'http' (server answered with an error)
  const code = Number(q.get('code') || 0);
  const desc = q.get('desc') || '';

  const safe = (u) => /^https?:\/\//i.test(u) ? u : '';
  const $0 = (id) => document.getElementById(id);
  let host = '';
  try { host = new URL(target).host; } catch {}

  // Chromium network error codes -> plain English
  const NET = {
    '-105': ['Node not found', `The address ${host || 'you entered'} doesn't exist, or DNS couldn't find it. Check the spelling.`],
    '-137': ['Node not found', `DNS couldn't find ${host || 'that address'}.`],
    '-106': ['No connection', 'This PC is offline. Check Wi-Fi or the network cable, then retry.'],
    '-21':  ['Network changed', 'The network connection changed while loading. Retry should fix it.'],
    '-102': ['Connection refused', `${host || 'The server'} is reachable but refused the connection. The service may be down.`],
    '-109': ['Address unreachable', `There's no route to ${host || 'that server'}.`],
    '-118': ['Timed out', `${host || 'The server'} took too long to answer.`],
    '-7':   ['Timed out', `${host || 'The server'} took too long to answer.`],
    '-101': ['Connection reset', 'The connection was cut off partway through.'],
    '-100': ['Connection closed', 'The server closed the connection unexpectedly.'],
    '-324': ['Empty response', `${host || 'The server'} sent nothing back.`],
    '-130': ['Proxy failed', 'The proxy server isn\'t responding.'],
    '-312': ['Blocked port', 'Browsers refuse to connect to this port for safety. Use the service\'s normal port.'],
    '-20':  ['Blocked', 'This request was blocked before it left the app.'],
    '-27':  ['Blocked by the site', 'The site refuses to be shown this way.'],
    '-501': ['Insecure response', 'The connection isn\'t secure enough to continue.']
  };
  const HTTP = {
    400: ['Bad request', 'The server didn\'t understand that request.'],
    401: ['Sign-in required', 'This page needs you to sign in first.'],
    403: ['Access denied', 'The server understood but won\'t let you in.'],
    404: ['Page not found', `${host || 'The server'} is up, but there's nothing at this address. The link may be old or mistyped.`],
    410: ['Gone', 'This page was removed on purpose.'],
    429: ['Too many requests', 'The server is rate-limiting you. Wait a moment, then retry.'],
    500: ['Server error', `${host || 'The server'} hit an internal error.`],
    502: ['Bad gateway', 'A server in the middle got a bad answer upstream.'],
    503: ['Service unavailable', `${host || 'The server'} is down or overloaded right now.`],
    504: ['Gateway timeout', 'A server in the middle timed out waiting upstream.']
  };

  const CRASH = {
    oom: 'The page ran out of memory and had to stop.',
    killed: 'The page was stopped from outside the app (maybe Task Manager or Windows).',
    'launch-failed': "The page couldn't start.",
    'integrity-failure': 'The page failed a safety check and was stopped.'
  };

  let big, headline, explain;
  if (kind === 'crash') {
    big = 'CRASH';
    headline = 'This tab crashed';
    explain = (CRASH[desc] || 'Something on this page broke and its process stopped.') + ' Your other tabs are fine. Hit RELOAD to try again.';
    document.body.classList.add('crash');
    document.querySelector('.tag').textContent = 'NODE_GRID :: TAB CRASHED';
    $0('retry').textContent = 'RELOAD';
    for (const el of document.querySelectorAll('.game, .game-hint')) el.remove();   // the robot is cleaning up instead
    $0('sweeper').hidden = false;
  } else if (kind === 'http') {
    big = String(code || 'ERROR');
    [headline, explain] = HTTP[code] || [`Error ${code}`, 'The server answered with an error.'];
  } else if (code <= -200 && code > -300) {
    big = 'TLS';
    headline = 'Certificate problem';
    explain = `The security certificate for ${host || 'this site'} isn't valid, so the connection was stopped to protect you.`;
  } else {
    big = code === -105 || code === -137 ? '404' : 'ERROR';
    [headline, explain] = NET[String(code)] || ['Signal lost', 'The page couldn\'t be loaded.'];
  }

  const $ = (id) => document.getElementById(id);
  $('code').textContent = big;
  $('code').dataset.text = big;
  $('headline').textContent = headline;
  $('explain').textContent = explain;
  $('target').textContent = target || '—';
  $('status').textContent = kind === 'http' ? `HTTP ${code}${desc ? ' ' + desc : ''}`
    : kind === 'crash' ? `${(desc || 'crashed').toUpperCase()} (exit ${code})`
    : `${desc || 'NET_ERROR'} (${code})`;
  document.title = `${headline} :: ${host || 'NODE_GRID'}`;

  // Retry replaces this page with the original address, so Back never lands here again.
  if (safe(target) || /^file:\/\/.*\/home\/index\.html(\?|$)/i.test(target)) {
    $('retry').href = target;
    $('retry').addEventListener('click', (e) => { e.preventDefault(); location.replace(target); });
  } else {
    $('retry').hidden = true;
  }
  const isBundledHome = /^file:\/\/.*\/home\/index\.html(\?|$)/i.test(home);   // start page shipped inside the app
  if (safe(home) || isBundledHome) $('home').href = home; else $('home').hidden = true;

  // Certificate problem on a LOCAL device (homelab gear): offer "Proceed anyway".
  if (q.get('trust') === '1' && window.nodegridCert) {
    const info = window.nodegridCert.info();
    if (info) {
      $('trustbox').hidden = false;
      $('trustfp').textContent = `${info.host} :: issued by ${info.issuer || 'unknown'} :: fingerprint ${String(info.fingerprint || '').replace(/^sha256\//, '').slice(0, 23)}…`;
      $('explain').textContent = `The certificate for ${host || 'this device'} isn't from a public authority (${info.error || 'untrusted'}).`;
      $('trust').addEventListener('click', (e) => { e.preventDefault(); window.nodegridCert.trust(); });
    }
  }

  // The broken entry is removed from history by the app, so one step back is the last good page.
  $('back').addEventListener('click', (e) => { e.preventDefault(); history.back(); });
  if (history.length <= 1) $('back').hidden = true;
})();
