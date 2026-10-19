// NODE_GRID ROOFTOP RUNNER — the error page's offline game.
// A little guy auto-runs across neon rooftops; jump the gaps, don't hit the walls.
// Space / Up / W / click to jump. Hold for a higher jump, tap for a short hop.
(() => {
  const cv = document.getElementById('gc');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;           // logical pixels (scaled up crisply by CSS)
  const $score = document.getElementById('score');
  const $hi = document.getElementById('hi');
  const $msg = document.getElementById('msg');

  const C = {
    sky1: '#05050b', sky2: '#120d22', far: '#0c1020', mid: '#101626',
    bld: '#141b2b', bldSide: '#0f1420', win: '#1b2335',
    cyan: '#00e5ff', pink: '#ff2e88', amber: '#ffb000', white: '#e6f6ff'
  };
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- tuning ----
  const G = 0.22;            // gravity, px/step²
  const JUMP = -4.1;         // jump velocity -> max height ≈ 38px
  const SHORT = -1.7;        // releasing early cuts the jump to this
  const START_SPEED = 2.0, MAX_SPEED = 5.2;
  const PX = 44, PW = 8, PH = 12;   // player x, size
  const COYOTE = 5, BUFFER = 6;     // forgiving steps for late / early presses

  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  let hi = 0;
  try { hi = Number(localStorage.getItem('nodegrid-runner-hi')) || 0; } catch {}

  let state, speed, dist, blds, p, holding, buffer, coyote, frame, particles, deadAt, glitch;

  // ---- horizontal reach of a full jump that lands dh px higher than takeoff ----
  function reach(dh, spd) {
    const v = -JUMP, disc = v * v - 2 * G * dh;
    if (disc < 0) return 0;
    return spd * (v + Math.sqrt(disc)) / G;
  }

  // Steps a full jump needs to climb h px.
  function rise(h) {
    const v = -JUMP, disc = v * v - 2 * G * h;
    return disc < 0 ? Infinity : (v - Math.sqrt(disc)) / G;
  }

  function makeBuilding(x, roof, w) {
    const cols = Math.floor((w - 6) / 5), rows = Math.floor((H - roof - 8) / 6);
    const wins = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const roll = Math.random();
      wins.push(roll < 0.07 ? C.pink : roll < 0.14 ? C.cyan : roll < 0.17 ? C.amber : null);
    }
    const props = [];
    if (w > 40 && Math.random() < 0.55) props.push({ t: 'ac', x: rnd(6, w - 16) });
    if (Math.random() < 0.45) props.push({ t: 'ant', x: rnd(4, w - 6), h: rnd(6, 14) | 0, ph: Math.random() * 60 });
    if (w > 70 && Math.random() < 0.25) props.push({ t: 'tank', x: rnd(10, w - 24) });
    return { x, roof, w, cols, wins, props };
  }

  function addBuilding() {
    const last = blds[blds.length - 1];
    const ease = clamp(dist / 4000, 0, 1);                 // gentle start, harder later
    const dh = clamp(rnd(-26, 18) * (0.5 + 0.5 * ease), -30, 18);
    let roof = clamp(Math.round(last.roof - dh), 46, H - 18);
    let realDh = last.roof - roof;                          // + means higher
    // Gaps stay well inside a full jump's reach, with room left to land on the roof
    // (verified by a test bot over thousands of buildings at every speed).
    let maxGap = Math.max(12, reach(realDh, speed) * (0.30 + 0.08 * ease) - PW - 4);
    // Stepping UP needs time to rise above the wall: keep the gap at least that wide.
    let minGap = Math.min(10 + ease * 6, maxGap);
    if (realDh > 4) {
      const need = speed * rise(realDh + 3) - 4;
      if (need > maxGap) { roof = last.roof; realDh = 0; maxGap = Math.max(12, reach(0, speed) * (0.30 + 0.08 * ease) - PW - 4); }
      else minGap = Math.max(minGap, need);
    }
    const gap = Math.round(rnd(Math.min(minGap, maxGap), maxGap));
    const fullJump = speed * 2 * -JUMP / G;                 // distance of a full held jump on flat ground
    const minW = Math.round(Math.max(40, fullJump * (0.85 - 0.45 * ease)));
    blds.push(makeBuilding(last.x + last.w + gap, roof, Math.round(rnd(minW, Math.max(minW + 20, 130 - ease * 40)))));
  }

  function reset() {
    state = 'idle'; speed = START_SPEED; dist = 0; frame = 0; holding = false;
    buffer = 0; coyote = 0; particles = []; glitch = 0;
    blds = [makeBuilding(-10, 80, 220)];
    while (blds[blds.length - 1].x < W + 80) addBuilding();
    p = { y: 80 - PH, vy: 0, ground: true };
    show('PRESS SPACE OR CLICK TO RUN');
    hud();
  }

  // ---- input ----
  function press() {
    if (state === 'dead') { if (performance.now() - deadAt > 450) { reset(); start(); } return; }
    if (state === 'idle') start();
    holding = true; buffer = BUFFER;
  }
  function release() {
    holding = false;
    if (p.vy < SHORT) p.vy = SHORT;   // short hop
  }
  function start() { state = 'run'; show(''); }

  const JUMP_KEYS = new Set(['Space', 'ArrowUp', 'KeyW']);
  addEventListener('keydown', (e) => { if (!JUMP_KEYS.has(e.code)) return; e.preventDefault(); if (!e.repeat) press(); });
  addEventListener('keyup', (e) => { if (JUMP_KEYS.has(e.code)) release(); });
  cv.addEventListener('pointerdown', (e) => { e.preventDefault(); press(); });
  addEventListener('pointerup', release);

  // ---- one fixed simulation step (60 per second) ----
  function step() {
    frame++;
    if (state === 'run') {
      speed = Math.min(MAX_SPEED, START_SPEED + dist / 2200);
      dist += speed;
      for (const b of blds) b.x -= speed;
      while (blds.length && blds[0].x + blds[0].w < -20) blds.shift();
      while (blds[blds.length - 1].x < W + 80) addBuilding();

      // jump: buffered press + coyote time
      if (buffer > 0) buffer--;
      if (p.ground) coyote = COYOTE; else if (coyote > 0) coyote--;
      if (buffer > 0 && coyote > 0) {
        p.vy = JUMP; p.ground = false; coyote = 0; buffer = 0;
        if (!holding) p.vy = SHORT * 1.35;
        dust(PX + 2, p.y + PH);
      }

      const prevFeet = p.y + PH;
      p.vy += G;
      p.y += p.vy;
      const feet = p.y + PH;
      p.ground = false;

      for (const b of blds) {
        if (PX + PW - 1 <= b.x || PX + 1 >= b.x + b.w) continue;   // not over this building
        if (prevFeet <= b.roof + 0.5 && feet >= b.roof) {          // landed on the roof
          if (p.vy > 2.5) dust(PX + 4, b.roof);
          p.y = b.roof - PH; p.vy = 0; p.ground = true;
        } else if (feet > b.roof + 2) {                            // ran into the wall
          return die({ cause: 'wall', feet, roof: b.roof, bx: b.x, vy: p.vy });
        }
      }
      if (p.y > H + 4) return die({ cause: 'fall' });
    }

    for (const q of particles) { q.x += q.vx - (state === 'run' ? speed : 0); q.y += q.vy; q.vy += 0.08; q.life--; }
    particles = particles.filter((q) => q.life > 0);
    if (glitch > 0) glitch--;
  }

  let lastDeath = null;
  function die(info) {
    lastDeath = info || null;
    state = 'dead'; deadAt = performance.now(); glitch = 18;
    for (let i = 0; i < 24; i++) particles.push({ x: PX + 4, y: p.y + 6, vx: rnd(-1.5, 1.5), vy: rnd(-2.5, 0.5), life: rnd(20, 45), c: Math.random() < 0.5 ? C.cyan : C.pink });
    const m = Math.floor(dist / 10);
    if (m > hi) { hi = m; try { localStorage.setItem('nodegrid-runner-hi', String(hi)); } catch {} }
    hud();
    show(m >= hi && m > 0 ? `NEW RECORD ${m} m  ::  SPACE TO RUN AGAIN` : 'SIGNAL DROPPED  ::  SPACE TO RUN AGAIN');
  }

  function dust(x, y) {
    for (let i = 0; i < 5; i++) particles.push({ x, y, vx: rnd(-1, 0.3), vy: rnd(-0.9, -0.2), life: rnd(10, 18), c: '#5a6b80' });
  }

  function show(t) { $msg.textContent = t; $msg.hidden = !t; }
  function hud() {
    $score.textContent = String(Math.floor(dist / 10)).padStart(5, '0') + ' m';
    $hi.textContent = 'HI ' + String(hi).padStart(5, '0');
  }

  // ---- drawing ----
  const far = Array.from({ length: 30 }, (_, i) => ({ x: i * 22 + rnd(-4, 4), w: rnd(14, 24) | 0, h: rnd(18, 46) | 0 }));
  const mid = Array.from({ length: 22 }, (_, i) => ({ x: i * 30 + rnd(-6, 6), w: rnd(18, 30) | 0, h: rnd(14, 34) | 0, lit: Math.random() }));
  const rain = Array.from({ length: reduceMotion ? 0 : 45 }, () => ({ x: rnd(0, W), y: rnd(0, H), s: rnd(2.5, 4) }));

  function skyline(layer, par, color, lights) {
    const span = layer.length * (layer === far ? 22 : 30);
    const off = (dist * par) % span;
    ctx.fillStyle = color;
    for (const s of layer) {
      let x = s.x - off; if (x < -40) x += span;
      ctx.fillRect(x | 0, H - s.h, s.w, s.h);
      if (lights && s.lit > 0.5) { ctx.fillStyle = s.lit > 0.8 ? 'rgba(255,46,136,.35)' : 'rgba(0,229,255,.25)'; ctx.fillRect((x + 4) | 0, H - s.h + 4, 1, 1); ctx.fillRect((x + 9) | 0, H - s.h + 9, 1, 1); ctx.fillStyle = color; }
    }
  }

  function drawBuilding(b) {
    const x = Math.round(b.x);
    ctx.fillStyle = C.bld; ctx.fillRect(x, b.roof, b.w, H - b.roof);
    ctx.fillStyle = C.bldSide; ctx.fillRect(x, b.roof, 2, H - b.roof);
    // windows
    let i = 0;
    for (let r = 0; r * 6 + b.roof + 6 < H - 2; r++) for (let c = 0; c < b.cols; c++, i++) {
      ctx.fillStyle = b.wins[i] || C.win;
      ctx.fillRect(x + 4 + c * 5, b.roof + 6 + r * 6, 2, 3);
    }
    // neon roof edge
    ctx.fillStyle = 'rgba(0,229,255,.25)'; ctx.fillRect(x, b.roof - 1, b.w, 1);
    ctx.fillStyle = C.cyan; ctx.fillRect(x, b.roof, b.w, 1);
    // rooftop props (decoration only)
    for (const pr of b.props) {
      const px = x + Math.round(pr.x);
      if (pr.t === 'ac') { ctx.fillStyle = '#26314a'; ctx.fillRect(px, b.roof - 5, 9, 5); ctx.fillStyle = '#3a4866'; ctx.fillRect(px + 2, b.roof - 4, 5, 1); }
      if (pr.t === 'tank') { ctx.fillStyle = '#26314a'; ctx.fillRect(px, b.roof - 10, 12, 7); ctx.fillRect(px + 1, b.roof - 3, 1, 3); ctx.fillRect(px + 10, b.roof - 3, 1, 3); }
      if (pr.t === 'ant') {
        ctx.fillStyle = '#3a4866'; ctx.fillRect(px, b.roof - pr.h, 1, pr.h);
        ctx.fillStyle = ((frame + pr.ph) % 60) < 30 ? C.pink : '#4a1a30'; ctx.fillRect(px, b.roof - pr.h - 1, 1, 1);
      }
    }
  }

  // 8x12 sprites. c = cyan body, p = pink visor/scarf, w = white highlight
  const SPR = {
    run1: ['..cccc..', '.cccccc.', '.ccwppp.', '.cccccc.', '..cccc..', 'pp.cc...', '.pcccc..', '..cccc..', '..cccc..', '..c..c..', '.c....c.', 'c......c'],
    run2: ['..cccc..', '.cccccc.', '.ccwppp.', '.cccccc.', '..cccc..', '.pp.cc..', '..cccc..', '..cccc..', '..cccc..', '..c.c...', '..c.c...', '..cc.cc.'],
    jump: ['..cccc..', '.cccccc.', '.ccwppp.', '.cccccc.', '..cccc..', 'ppp.cc.c', '..ccccc.', 'c.cccc..', '..cccc..', '.cc..cc.', '.c....c.', '........'],
    idle: ['..cccc..', '.cccccc.', '.ccwppp.', '.cccccc.', '..cccc..', '...cc...', '.pcccc..', 'p.cccc..', '..cccc..', '..c..c..', '..c..c..', '.cc..cc.']
  };
  const COL = { c: C.cyan, p: C.pink, w: C.white };

  let debugShowDead = false;
  function drawPlayer() {
    if (state === 'dead' && !debugShowDead) return;
    const spr = state === 'idle' ? SPR.idle : !p.ground ? SPR.jump : (Math.floor(frame / 6) % 2 ? SPR.run1 : SPR.run2);
    const y = Math.round(p.y);
    ctx.fillStyle = 'rgba(0,229,255,.18)';                   // soft glow
    ctx.fillRect(PX - 1, y - 1, PW + 2, PH + 2);
    for (let r = 0; r < PH; r++) for (let c = 0; c < PW; c++) {
      const k = spr[r][c]; if (k === '.') continue;
      ctx.fillStyle = COL[k]; ctx.fillRect(PX + c, y + r, 1, 1);
    }
  }

  function draw() {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, C.sky1); g.addColorStop(1, C.sky2);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    // moon
    ctx.fillStyle = 'rgba(255,46,136,.12)'; ctx.beginPath(); ctx.arc(W - 46, 24, 13, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(255,46,136,.55)'; ctx.beginPath(); ctx.arc(W - 46, 24, 8, 0, 7); ctx.fill();

    skyline(far, 0.15, C.far, false);
    skyline(mid, 0.4, C.mid, true);

    ctx.fillStyle = 'rgba(0,229,255,.16)';
    for (const d of rain) {
      d.y += d.s; d.x -= d.s * 0.35 + (state === 'run' ? speed * 0.3 : 0);
      if (d.y > H) { d.y = -4; d.x = rnd(0, W + 30); }
      if (d.x < -2) d.x += W + 4;
      ctx.fillRect(d.x | 0, d.y | 0, 1, 3);
    }

    for (const b of blds) drawBuilding(b);
    drawPlayer();
    for (const q of particles) { ctx.fillStyle = q.c; ctx.fillRect(q.x | 0, q.y | 0, 1, 1); }

    if (glitch > 0) {                                        // glitch slices on death
      for (let i = 0; i < 4; i++) {
        const y = rnd(0, H) | 0, h = rnd(2, 8) | 0;
        ctx.drawImage(cv, 0, y, W, h, rnd(-6, 6) | 0, y, W, h);
      }
      ctx.fillStyle = glitch % 4 < 2 ? 'rgba(255,46,136,.10)' : 'rgba(0,229,255,.08)';
      ctx.fillRect(0, 0, W, H);
    }
  }

  // ---- loop: fixed 60 Hz steps, drawn once per frame ----
  let acc = 0, lastT = performance.now(), paused = false;
  function loop(now) {
    acc += Math.min(100, now - lastT); lastT = now;
    let n = 0;
    if (paused) acc = 0;
    while (acc >= 1000 / 60 && n++ < 6) { step(); acc -= 1000 / 60; }
    if (state === 'run') hud();
    draw();
    requestAnimationFrame(loop);
  }

  reset();
  requestAnimationFrame(loop);

  // Hook for automated testing only (lets a test bot play at full speed).
  window.__runner = {
    step, press, release, reset, draw,
    pause(v) { paused = v; hud(); },
    showDead(v) { debugShowDead = v; glitch = 0; particles = []; },
    K: { G, JUMP, SHORT, PX, PW, PH, H },
    get s() { return { state, dist, speed, p, blds, PX, PW, lastDeath }; }
  };
})();
