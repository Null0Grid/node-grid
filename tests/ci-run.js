'use strict';
// CI helper: runs one test script, passes its output through unchanged, and turns
// each "[FAIL] ..." line (and a crash) into a GitHub annotation, so a failure can be
// read from the run's summary without opening the full log.
//   node tests/ci-run.js <npm script name>
const { spawn } = require('child_process');

const name = process.argv[2];
if (!name) { console.error('usage: node tests/ci-run.js <npm script>'); process.exit(2); }
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const p = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', '-s', name], { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
const tail = [];
let buf = '';
const onData = (d) => {
  process.stdout.write(d);
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    tail.push(line); if (tail.length > 15) tail.shift();
    if (/^\[FAIL\]/.test(line)) console.log(`::error title=${esc(name)}::${esc(line.slice(0, 900))}`);
  }
};
p.stdout.on('data', onData);
p.stderr.on('data', onData);
p.on('close', (code) => {
  if (code && !tail.some((l) => /^\[FAIL\]/.test(l))) console.log(`::error title=${esc(name)} (exit ${code})::${esc(tail.join('\n').slice(-1500))}`);
  process.exit(code || 0);
});
