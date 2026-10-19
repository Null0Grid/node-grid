// NODE_GRID animated tab icon.
// Draws the "//" mark to an offscreen canvas on a loop — the slashes pulse
// brightness and a soft pink glow breathes behind them, matching the site's
// existing pulse/blink motifs (status dots, the hero cursor) — then pushes
// each frame into the <link rel="icon"> as a data: URL. Bookmarks still use
// the static favicon.ico/icon-512.png files; this only affects the live tab.
(function () {
  "use strict";

  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }

  var SIZE = 64;
  var canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  var ctx = canvas.getContext("2d");
  if (!ctx) return;

  var iconLink = null;
  function getIconLink() {
    if (iconLink && document.head.contains(iconLink)) return iconLink;
    iconLink = document.querySelector('link[rel="icon"][sizes="any"]');
    if (!iconLink) {
      iconLink = document.createElement("link");
      iconLink.rel = "icon";
      iconLink.setAttribute("sizes", "any");
      document.head.appendChild(iconLink);
    }
    return iconLink;
  }

  // slash endpoints, in the 512x512 design space (matches public/favicon.ico's source)
  var SLASHES = [
    { x1: 168, y1: 412, x2: 240, y2: 100 },
    { x1: 288, y1: 412, x2: 360, y2: 100 }
  ];

  function drawFrame(t) {
    var scale = SIZE / 512;

    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = "#080b0c";
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.lineCap = "round";

    // breathing pink glow behind the slashes
    var glowPulse = (Math.sin(t / 900) + 1) / 2; // 0..1
    var glowAlpha = 0.14 + glowPulse * 0.22;
    var glowWidth = (70 + glowPulse * 16) * scale;
    ctx.strokeStyle = "rgba(255,46,136," + glowAlpha.toFixed(3) + ")";
    ctx.lineWidth = glowWidth;
    for (var i = 0; i < SLASHES.length; i++) {
      var s = SLASHES[i];
      ctx.beginPath();
      ctx.moveTo(s.x1 * scale, s.y1 * scale);
      ctx.lineTo(s.x2 * scale, s.y2 * scale);
      ctx.stroke();
    }

    // crisp cyan slashes, subtle brightness pulse (offset phase)
    var cyanPulse = (Math.sin(t / 900 + Math.PI / 2) + 1) / 2;
    var cyanAlpha = 0.75 + cyanPulse * 0.25;
    ctx.strokeStyle = "rgba(0,229,255," + cyanAlpha.toFixed(3) + ")";
    ctx.lineWidth = Math.max(3, 46 * scale);
    for (var j = 0; j < SLASHES.length; j++) {
      var sl = SLASHES[j];
      ctx.beginPath();
      ctx.moveTo(sl.x1 * scale, sl.y1 * scale);
      ctx.lineTo(sl.x2 * scale, sl.y2 * scale);
      ctx.stroke();
    }
  }

  var lastUpdate = 0;
  var FRAME_MS = 150; // browsers throttle favicon repaints anyway

  function loop(t) {
    if (t - lastUpdate >= FRAME_MS) {
      drawFrame(t);
      getIconLink().href = canvas.toDataURL("image/png");
      lastUpdate = t;
    }
    window.requestAnimationFrame(loop);
  }

  window.requestAnimationFrame(loop);
})();
