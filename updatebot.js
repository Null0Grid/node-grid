// NODE_GRID update bot: Packet (BT-0404), the Null Grid mascot. He walks in from
// the left, hops twice with happy eyes, then waves while he tells you there's an
// update. Drawn to his character sheet (project doc "mascot-packet.md"): 12x14
// pixel grid with some half-pixel details, whole-step scale (x6), his own
// colours, mood only through the visor and antenna, no mouth, one Packet on
// screen.
(() => {
  const cv = document.getElementById('bot');
  const ctx = cv.getContext('2d');
  const bubble = document.getElementById('bubble');
  const S = 6;                          // screen pixels per sprite pixel (whole steps only)
  const SW = 14, SH = 16;               // sprite box incl. 1 px padding (viewBox -1 -1 14 16)
  const HOP = 7;                        // how high he hops, sprite pixels
  const CH = SH + HOP + 1;              // canvas height, sprite pixels
  const HOME_X = 1;                     // where he stops (sprite pixels from the left)
  const C = { body: '#323c54', trim: '#4a5677', visor: '#0b0e15', cyan: '#00e5ff', pink: '#ff2e88',
    green: '#39ff88', stem: '#8b92a8' };
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function resize() {
    cv.width = Math.ceil(window.innerWidth); cv.height = CH * S;
    cv.style.width = cv.width + 'px'; cv.style.height = cv.height + 'px';
  }
  resize();
  window.addEventListener('resize', resize);

  const bot = { x: still ? HOME_X : -SW - 1, y: 0, dir: 1, t: 0, blink: 0, phase: still ? 'talk' : 'walk', hop: 0, hops: 0, idle: 0 };

  // One sprite rect; x, y in his own sprite coordinates (top-left origin, as on
  // the character sheet), flipped when he walks away to the left.
  function r(x, y, w, h, c) {
    const sx = bot.dir > 0 ? x : 12 - x - w;
    const X = Math.round((bot.x + 1 + sx) * S);
    const Y = Math.round((CH - SH + 1 + y - bot.y) * S);
    ctx.fillStyle = c;
    ctx.fillRect(X, Y, Math.round(w * S), Math.round(h * S));
  }
  function eyes(mood) {
    if (bot.blink > 0 && mood === 'calm') { r(4, 4.5, 1, 0.5, C.cyan); r(7, 4.5, 1, 0.5, C.cyan); return; }
    if (mood === 'happy') {
      for (const [x, y] of [[3.5, 4.5], [4, 4], [4.5, 4], [5, 4.5], [6.5, 4.5], [7, 4], [7.5, 4], [8, 4.5]]) r(x, y, 0.5, 0.5, C.cyan);
      return;
    }
    r(4, 4, 1, 1, C.cyan); r(7, 4, 1, 1, C.cyan);                       // calm
  }
  function drawPacket() {
    const t = bot.t;
    const walking = bot.phase === 'walk' || bot.phase === 'leave';
    const step = walking && Math.floor(t / 7) % 2;                      // walk A / walk B
    const happy = bot.phase === 'hop' || bot.phase === 'talk';
    const waving = bot.phase === 'talk' && Math.floor(t / 90) % 3 !== 2;
    // antenna (pulses while he has news) + stem
    r(5, 0, 2, 1, bot.phase === 'talk' && Math.floor(t / 20) % 2 ? C.trim : C.pink);
    r(5.5, 1, 1, 1, C.stem);
    // head, highlight, visor, ears
    r(2, 2, 8, 5, C.body); r(2, 2, 8, 1, C.trim);
    r(3, 3, 6, 3, C.visor);
    r(1, 4, 1, 2, C.trim); r(10, 4, 1, 2, C.trim);
    eyes(happy ? 'happy' : 'calm');
    // body, chest lights, status light
    r(3, 7, 6, 4, C.body);
    r(4, 8, 1, 2, C.cyan); r(5, 8, 1, 2, C.cyan); r(6, 9, 1, 1, Math.floor(t / 40) % 2 ? C.green : C.body);
    // arms: left always down; right down, or up in a wave
    r(2, 8, 1, 2, C.trim);
    if (waving) { const up = Math.floor(t / 12) % 2; r(9, 7, 1, 1, C.trim); r(9.5 + (up ? 0.5 : 0), 5.5, 1, 1.5, C.trim); }
    else if (bot.y > 0.5) { r(9, 7, 1, 1, C.trim); r(9.5, 5.5, 1, 1.5, C.trim); r(2, 7, 1, 1, C.trim); r(1.5, 5.5, 1, 1.5, C.trim); }   // both up mid-hop
    else r(9, 8, 1, 2, C.trim);
    // legs + feet: walk A (x3 & x7) / walk B (x4 & x8), standing (x4 & x7)
    const [la, lb] = walking ? (step ? [4, 8] : [3, 7]) : [4, 7];
    r(la, 11, 1, 2, C.trim); r(lb, 11, 1, 2, C.trim);
    r(la - 1, 13, 2, 1, C.cyan); r(lb, 13, 2, 1, C.cyan);
  }

  function hop() { bot.phase = 'hop'; bot.hop = 0; }
  function stepWorld() {
    bot.t++;
    if (bot.blink > 0) bot.blink--; else if (Math.random() < 0.008) bot.blink = 7;
    if (bot.phase === 'walk') {
      bot.x += 0.32;
      if (bot.x >= HOME_X) { bot.x = HOME_X; bot.hops = 0; hop(); }
    } else if (bot.phase === 'hop') {
      const T = 20;
      bot.hop++;
      bot.y = Math.sin(Math.PI * bot.hop / T) * (bot.hops === 0 ? HOP : HOP - 2);
      if (bot.hop >= T) {
        bot.y = 0; bot.hops++;
        if (bot.hops < 2) bot.hop = 0; else { bot.phase = 'talk'; showBubble(); }
      }
    } else if (bot.phase === 'talk') {
      if (++bot.idle > 300 && Math.random() < 0.02) { bot.idle = 0; bot.hops = 1; hop(); }   // a little hop now and then
    } else if (bot.phase === 'leave') {
      bot.x -= 0.45;
      if (bot.x < -SW - 2) { window.updbot.gone(); return false; }
    }
    return true;
  }
  function draw() { ctx.clearRect(0, 0, cv.width, cv.height); drawPacket(); }
  function loop() { if (stepWorld()) { draw(); requestAnimationFrame(loop); } }

  // ---- what he says ----
  const $ = (id) => document.getElementById(id);
  function btn(text, fn, go) { const b = document.createElement('button'); b.textContent = text; if (go) b.className = 'go'; b.onclick = fn; return b; }
  function leave(later) {
    if (later) window.updbot.later();
    bubble.classList.remove('on');
    if (still) { window.updbot.gone(); return; }
    bot.dir = -1; bot.y = 0; bot.phase = 'leave';
  }
  function fill(i) {
    if (!i || !['available', 'downloading', 'ready', 'installing'].includes(i.state)) return;
    const v = document.createElement('b'); v.textContent = 'NODE_GRID ' + i.latest;
    const p = $('bx'); p.replaceChildren();
    const h = $('bt'); if (h) h.textContent = i.state === 'downloading' ? '// DOWNLOADING' : i.state === 'ready' ? '// UPDATE READY' : i.state === 'installing' ? '// INSTALLING' : '// UPDATE AVAILABLE';
    if (i.self) {                              // this copy updates itself
      if (i.state === 'downloading') {
        p.append('Downloading ', v, '… ', String(i.progress || 0) + '%');
        $('btns').replaceChildren(btn('HIDE', () => leave(false)));
      } else if (i.state === 'ready') {
        p.append(v, i.needsPassword ? ' is downloaded and checked. Restart to install it (your password is needed).' : ' is downloaded and checked. Restart now, or it installs when you close NODE_GRID.');
        if (i.error) { const e = document.createElement('span'); e.className = 'err'; e.textContent = ' ' + i.error + '.'; p.append(e); }
        $('btns').replaceChildren(btn('RESTART NOW', () => window.updbot.restart(), true), btn('LATER', () => leave(false)));
      } else if (i.state === 'installing') {
        p.append('Installing ', v, '. NODE_GRID reopens in a moment, with your tabs.');
        $('btns').replaceChildren();
      } else {
        p.append(v, ` is out. You're on ${i.current}.`);
        if (i.error) { const e = document.createElement('span'); e.className = 'err'; e.textContent = " Couldn't update: " + i.error + '.'; p.append(e); }
        $('btns').replaceChildren(
          btn(i.error ? 'TRY AGAIN' : 'UPDATE', () => window.updbot.get(), true),
          btn("WHAT'S NEW", () => window.updbot.notes()),
          btn('LATER', () => leave(true)));
      }
      return;
    }
    if (i.state !== 'available') return;
    if (i.store) {
      p.append(v, ' is out on GitHub. Your Microsoft Store copy gets it through the Store soon.');
      $('btns').replaceChildren(btn("WHAT'S NEW", () => window.updbot.notes(), true), btn('OK', () => leave(true)));
    } else {
      p.append(v, ` is out. You're on ${i.current}.`);
      $('btns').replaceChildren(
        btn(i.asset ? 'GET IT' : 'GET IT ON GITHUB', () => window.updbot.get(), true),
        btn("WHAT'S NEW", () => window.updbot.notes()),
        btn('LATER', () => leave(true)));
    }
  }
  function showBubble() { bubble.style.left = (HOME_X + SW + 1) * S + 'px'; bubble.classList.add('on'); }
  window.updbot.onInfo(fill);
  window.updbot.info().then((i) => { fill(i); if (still) { draw(); showBubble(); } else requestAnimationFrame(loop); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') leave(true); });
})();
