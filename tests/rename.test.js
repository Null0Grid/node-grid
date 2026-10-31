'use strict';
// NODE_GRID was renamed Null Grid (5.2.0). This fails if the old name turns up
// anywhere in the repo (file contents or file names), except the few places
// listed below that keep it on purpose.
//
//   node tests/rename.test.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OLD = /node[-_ ]?grid/i;
// Kept on purpose. Each entry: file, a pattern the line must match, and why.
const ALLOWED = [
  // carrying data over from before the rename (main.js "renamed" section) + old loadout links + an old game score
  ['main.js', /LEGACY_NAME = 'NODE_GRID'|LEGACY_FLATPAK = 'dev\.nullgrid\.nodegrid'|renamed: NODE_GRID is now Null Grid|\['nodegrid-(ai|sim)', 'nullgrid-(ai|sim)'\]|nodegrid:\\\/\\\//, 'migration'],
  ['runner.js', /'nodegrid-runner-hi'/, 'migration'],
  ['package.json', /\.var\/app\/dev\.nullgrid\.nodegrid:ro/, 'migration: the old Flatpak\'s data'],
  // the Null Search site (another repo) still calls the Drive bridge by its old name
  ['tab-preload.js', /exposeInMainWorld\('nodegridDrive'/, 'Null Search site'],
  ['tests/fixtures/search-site/results.html', /nodegridDrive/, 'Null Search site'],
  // two-step rename: 5.2.0 keeps the program file names so older copies can update themselves
  ['package.json', /"executableName": "node-grid"|"desktopName": "node-grid\.desktop"|--executable-name=NODE_GRID/, 'program file name'],
  ['main.js', /node-grid\.desktop|StartupWMClass=node-grid/, 'program file name'],
  ['settings.js', /node-grid\.desktop/, 'program file name'],
  ['README.md', /node-grid\.desktop/, 'program file name'],
  ['packaging/aur/PKGBUILD', /node-grid/, 'program file name'],
  ['packaging/aur/.SRCINFO', /provides = node-grid/, 'program file name'],
  ['packaging/flathub/dev.nullgrid.nullgrid.desktop', /=node-grid/, 'program file name'],
  ['packaging/flathub/dev.nullgrid.nullgrid.yml', /command: node-grid/, 'program file name'],
  ['tests/selfupdate.test.js', /'NODE_GRID\.exe' : 'node-grid'/, 'program file name'],
  ['tests/ui-defaultbrowser.test.js', /node-grid\.desktop/, 'program file name'],
  // fixed by Microsoft for good: the Store app's id inside the package (part of its taskbar/Start identity)
  ['package.json', /"applicationId": "NODEGRID"/, 'Store id'],
  ['main.js', /!NODEGRID/, 'Store id'],
  // saying it was renamed, once
  ['README.md', /\(Formerly NODE_GRID\.\)/, 'rename note'],
  ['whats-new.json', /NODE_GRID is now/, 'rename note'],
  // the history of the rename itself, and of earlier versions' packaging (true for what they shipped)
  ['docs/HISTORY.md', /.*/, 'history'],
  // this test, and the test of updating from before the rename
  ['tests/rename.test.js', /.*/, 'this file'],
  ['tests/ui-rename.test.js', /.*/, 'migration test'],
];

const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
  .filter((f) => !f.startsWith('node_modules/') && fs.existsSync(path.join(ROOT, f)));
const bad = [];
for (const f of files) {
  if (OLD.test(f)) bad.push(`${f}: file name`);
  let txt;
  const buf = fs.readFileSync(path.join(ROOT, f));
  if (buf.includes(0)) continue;                      // binary
  txt = buf.toString('utf8');
  txt.split('\n').forEach((line, i) => {
    if (!OLD.test(line)) return;
    if (ALLOWED.some(([af, re]) => af === f && re.test(line))) return;
    bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 160)}`);
  });
}
// the shipped walkthrough video's text is drawn from walkthrough/src/tour.html (checked above)
if (bad.length) {
  console.log('[FAIL] the old name is still in ' + bad.length + ' place(s):\n  ' + bad.join('\n  '));
  console.log('RENAME TEST FAILED');
  process.exit(1);
}
console.log('[pass] no NODE_GRID / Node Grid / nodegrid / node-grid left (' + files.length + ' files checked, ' + ALLOWED.length + ' kept on purpose)');
console.log('ALL RENAME TESTS PASS');
