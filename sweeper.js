// NODE_GRID crashed-tab page: a little robot sweeping up the pieces along the bottom.
// Pure canvas pixel art, original design. Only runs on the crash page.
(() => {
  const cv = document.getElementById('sweeper');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const S = 4;                          // screen pixels per art pixel
  const H = 36;                         // art pixels tall
  const F = H - 3;                      // floor line (y of the ground surface)
  const RW = 18;                        // robot sprite width incl. broom
  const C = {
    floor: '#1f2a3a', line: '#00e5ff', body: '#10131b', head: '#161b26', visor: '#05050b',
    cyan: '#00e5ff', pink: '#ff2e88', green: '#39ff88', amber: '#ffb000', handle: '#a8770a',
    tread: '#2a3448', dust: '#5a6b80'
  };
  const SHARD_COLORS = ['#00e5ff', '#ff2e88', '#e6f6ff', '#39ff88', '#ffb000'];
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rnd = (a, b) => a + Math.random() * (b - a);

  let W = 200;
  function resize() {
    W = Math.max(60, Math.ceil(window.innerWidth / S));
    cv.width = W; cv.height = H;
    cv.style.width = W * S + 'px';
    cv.style.height = H * S + 'px';
  }
  resize();
  window.addEventListener('resize', () => {
    resize();
    bot.x = Math.min(bot.x, W - RW - 4);
    for (const s of shards) s.x = Math.min(s.x, W - 2);
  });

  // ---- the mess ----
  const shards = [];
  const dust = [];
  const hearts = [];
  function shard(x, y, fall) {
    shards.push({ x, y: fall ? y : 0, vx: 0, vy: 0, c: SHARD_COLORS[(Math.random() * SHARD_COLORS.length) | 0], big: Math.random() < 0.25, air: !!fall, h: fall ? y : 0 });
  }
  for (let i = 0; i < Math.min(40, W / 6); i++) shard(rnd(20, W - 4), 0, false);

  // ---- the robot ----
  const bot = { x: 4, dir: 1, speed: 0.32, pause: 0, t: 0, blink: 0 };

  function px(x, y, w, h, c) {             // sprite coords: x from the robot's back, y up from the floor
    const X = bot.dir > 0 ? bot.x + x : bot.x + (RW - x - w);
    ctx.fillStyle = c;
    ctx.fillRect(Math.round(X), F - y - h, w, h);
  }
  function box(x, y, w, h, fill, edge) {      // rounded: corner pixels left out
    px(x + 1, y, w - 2, h, edge);
    px(x, y + 1, w, h - 2, edge);
    px(x + 1, y + 1, w - 2, h - 2, fill);
  }

  function drawBot() {
    const t = bot.t;
    const moving = bot.pause <= 0;
    const bob = moving && Math.floor(t / 8) % 2 ? 1 : 0;
    const swish = moving ? Math.round(Math.sin(t * 0.28) * 1.5) : 0;

    // treads
    px(0, 0, 10, 3, C.tread);
    for (let i = 0; i < 3; i++) px(1 + i * 3, 1, 1, 1, (Math.floor(t / 6) + i) % 2 ? C.cyan : C.floor);
    // little body
    box(1, 3 + bob, 8, 5, C.body, C.cyan);
    px(4, 5 + bob, 2, 1, Math.floor(t / 30) % 2 ? C.green : '#1d5a3a');   // chest light
    // big head, visor, two eyes, pink cheeks
    box(0, 8 + bob, 11, 8, C.head, C.cyan);
    px(2, 10 + bob, 7, 4, C.visor);
    const look = moving ? 1 : Math.floor(t / 40) % 2 ? 0 : 1;          // glances around while resting
    if (bot.blink > 0) {
      px(3 + look, 11 + bob, 2, 1, C.cyan);
      px(6 + look, 11 + bob, 2, 1, C.cyan);
    } else {
      px(3 + look, 11 + bob, 2, 2, C.cyan);
      px(6 + look, 11 + bob, 2, 2, C.cyan);
      px(3 + look, 12 + bob, 1, 1, '#e6f6ff');                      // sparkle
      px(6 + look, 12 + bob, 1, 1, '#e6f6ff');
    }
    px(1, 10 + bob, 1, 1, C.pink);
    px(9, 10 + bob, 1, 1, C.pink);
    // antenna
    px(5, 16 + bob, 1, 2, C.dust);
    px(5, 18 + bob, 1, 1, Math.floor(t / 20) % 3 ? C.pink : '#5a1530');
    // arm + broom
    px(9, 5 + bob, 3, 1, C.cyan);
    const handle = [[12, 7], [12, 6], [13, 5], [13, 4], [14, 3], [14, 2]];
    for (const [hx, hy] of handle) px(hx + (hy < 4 ? swish : 0), hy + (hy > 5 ? bob : 0), 1, 1, C.handle);
    px(12 + swish, 0, 6, 2, C.amber);
    px(12 + swish, 0, 1, 1, '#c98a00');
    px(17 + swish, 0, 1, 1, '#c98a00');
    return swish;
  }

  // world x of the broom's leading edge
  const broomX = (swish) => bot.dir > 0 ? bot.x + 17 + swish : bot.x - swish;

  function step() {
    bot.t++;
    if (bot.blink > 0) bot.blink--;
    else if (Math.random() < 0.006) bot.blink = 8;

    const swish = bot.pause > 0 ? 0 : Math.round(Math.sin(bot.t * 0.28) * 1.5);
    if (bot.pause > 0) {
      bot.pause--;
      if (bot.pause === 0) bot.dir *= -1;
    } else {
      bot.x += bot.dir * bot.speed;
      if (bot.dir > 0 && bot.x + RW >= W - 5) { bot.x = W - 5 - RW; bot.pause = 70; hearts.push({ x: bot.x + RW / 2, y: F - 25, life: 60 }); }
      if (bot.dir < 0 && bot.x <= 4) { bot.x = 4; bot.pause = 70; hearts.push({ x: bot.x + RW / 2, y: F - 25, life: 60 }); }
      if (bot.t % 7 === 0) dust.push({ x: broomX(swish) - bot.dir * 2, y: F - 1, vx: -bot.dir * rnd(0, 0.15), vy: -rnd(0.05, 0.2), life: rnd(18, 30) });
    }

    // broom pushes shards ahead of it
    const bx = broomX(swish);
    for (const s of shards) {
      if (s.air) continue;
      const ahead = bot.dir > 0 ? s.x >= bx - 4 && s.x <= bx + 1 : s.x <= bx + 4 && s.x >= bx - 1;
      if (ahead && bot.pause <= 0) {
        s.vx = bot.dir * rnd(0.5, 1.4);
        s.h = rnd(0.5, 2);
        if (Math.random() < 0.3) dust.push({ x: s.x, y: F - 1, vx: bot.dir * rnd(0.05, 0.3), vy: -rnd(0.1, 0.4), life: rnd(16, 28) });
      }
    }
    for (const s of shards) {
      if (s.air) {                                   // falling crumbs from the broken page
        s.vy += 0.06; s.y += s.vy;
        if (s.y >= F - 1) { s.air = false; s.y = 0; s.h = 0; dust.push({ x: s.x, y: F - 1, vx: 0, vy: -0.2, life: 20 }); }
        continue;
      }
      s.x += s.vx;
      s.vx *= 0.9;
      if (Math.abs(s.vx) < 0.02) s.vx = 0;
      s.h = Math.max(0, s.h * 0.85 - 0.05);
      if (s.x < 1) { s.x = 1; s.vx = 0; }
      if (s.x > W - 2) { s.x = W - 2; s.vx = 0; }
    }
    // a new crumb drops in now and then; the oldest swept-up bits fade away
    if (bot.t % 200 === 0) shard(rnd(10, W - 10), rnd(0, 6), true);
    if (shards.length > 70) shards.shift();

    for (const d of dust) { d.x += d.vx; d.y += d.vy; d.life--; }
    for (let i = dust.length - 1; i >= 0; i--) if (dust[i].life <= 0) dust.splice(i, 1);
    for (const h of hearts) { h.y -= 0.15; h.life--; }
    for (let i = hearts.length - 1; i >= 0; i--) if (hearts[i].life <= 0) hearts.splice(i, 1);
  }

  function heart(x, y, alpha) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = C.pink;
    const X = Math.round(x) - 2, Y = Math.round(y);
    ctx.fillRect(X, Y, 2, 1); ctx.fillRect(X + 3, Y, 2, 1);
    ctx.fillRect(X, Y + 1, 5, 1);
    ctx.fillRect(X + 1, Y + 2, 3, 1);
    ctx.fillRect(X + 2, Y + 3, 1, 1);
    ctx.globalAlpha = 1;
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    // floor
    ctx.fillStyle = C.floor;
    ctx.fillRect(0, F, W, H - F);
    ctx.fillStyle = C.line;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(0, F, W, 1);
    ctx.globalAlpha = 1;

    // shards: stack up where they bunch together so piles form at the walls
    const cols = new Map();
    const sorted = shards.filter((s) => !s.air).sort((a, b) => a.x - b.x);
    for (const s of sorted) {
      const cx = Math.round(s.x);
      const n = cols.get(cx) || 0;
      cols.set(cx, n + (s.big ? 2 : 1));
      ctx.fillStyle = s.c;
      ctx.fillRect(cx, F - 1 - n - Math.round(s.h), s.big ? 2 : 1, s.big ? 2 : 1);
    }
    for (const s of shards) if (s.air) { ctx.fillStyle = s.c; ctx.fillRect(Math.round(s.x), Math.round(s.y), 1, 1); }

    drawBot();

    for (const d of dust) {
      ctx.globalAlpha = Math.max(0, Math.min(1, d.life / 25)) * 0.8;
      ctx.fillStyle = C.dust;
      ctx.fillRect(Math.round(d.x), Math.round(d.y), 1, 1);
    }
    ctx.globalAlpha = 1;
    for (const h of hearts) heart(h.x, h.y, Math.min(1, h.life / 30));
  }

  if (reduceMotion) { bot.x = Math.round(W / 2 - RW / 2); draw(); return; }

  let last = performance.now(), acc = 0;
  function loop(now) {
    acc += Math.min(100, now - last);
    last = now;
    while (acc >= 1000 / 60) { step(); acc -= 1000 / 60; }
    draw();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
