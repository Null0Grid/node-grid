'use strict';
// Renders walkthrough/src/tour.html into walkthrough/packet-tour.webm (shipped in
// the app), with the original lo-fi bed from lofi.py (needs Python + numpy/scipy) and, with --mp4, an .mp4 copy to share. Needs ffmpeg and Playwright's
// Chromium (or CHROMIUM_PATH=<a chrome binary>).
//   node walkthrough/src/render.js [--mp4 <file.mp4>] [--fps 30]
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const FPS = Number(opt('--fps', 30));
const MP4 = opt('--mp4', '');
const OUT = path.join(__dirname, '..', 'packet-tour.webm');

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto('file://' + path.join(__dirname, 'tour.html'));
  await page.waitForFunction(() => window.TOUR_READY === true);
  const seconds = await page.evaluate(() => window.TOUR_SECONDS);
  const frames = Math.round(seconds * FPS);
  const outs = ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '36', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-pix_fmt', 'yuv420p', OUT];
  if (MP4) outs.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', MP4);
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-', ...outs], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg exited ' + c)))));
  for (let f = 0; f < frames; f++) {
    await page.evaluate((t) => window.drawFrame(t), f / FPS);
    const png = await page.locator('#c').screenshot({ type: 'png' });
    if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once('drain', r));
    if (f % (FPS * 10) === 0) console.log(`frame ${f}/${frames}`);
  }
  ff.stdin.end();
  await done;
  // the music: lofi.py (original, synthesised) muxed in without re-encoding the picture
  const wav = OUT.replace(/\.webm$/, '.wav');
  const run = (cmd, a) => new Promise((res, rej) => spawn(cmd, a, { stdio: 'inherit' }).on('close', (c) => (c === 0 ? res() : rej(new Error(cmd + ' exited ' + c)))));
  await run('python3', [path.join(__dirname, 'lofi.py'), wav, String(seconds)]);
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', OUT, '-i', wav, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'libopus', '-b:a', '96k', '-shortest', OUT + '.tmp.webm']);
  require('fs').renameSync(OUT + '.tmp.webm', OUT);
  if (MP4) { await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', MP4, '-i', wav, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', MP4 + '.tmp.mp4']); require('fs').renameSync(MP4 + '.tmp.mp4', MP4); }
  require('fs').unlinkSync(wav);
  await browser.close();
  console.log(`wrote ${OUT}${MP4 ? ' and ' + MP4 : ''} (${seconds}s at ${FPS} fps)`);
})().catch((e) => { console.error(e); process.exit(1); });
