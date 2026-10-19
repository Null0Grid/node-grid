// Store kit helper: copies your Partner Center identity (store-identity.txt) into
// package.json and decides which optional parts go into the Store build.
// Usage: node store-apply.js <path to store-identity.txt>
const fs = require('fs');
const path = require('path');

const idFile = process.argv[2];
const v = {};
for (const raw of fs.readFileSync(idFile, 'utf8').split(/\r?\n/)) {
  const l = raw.trim();
  if (!l || l.startsWith('#') || !l.includes('=')) continue;
  const i = l.indexOf('=');
  v[l.slice(0, i).trim()] = l.slice(i + 1).trim();
}
for (const k of ['IDENTITY_NAME', 'PUBLISHER', 'PUBLISHER_DISPLAY_NAME']) {
  if (!v[k] || /PASTE/i.test(v[k])) { console.error(`store-identity.txt: fill in ${k}`); process.exit(2); }
}
if (!/^CN=/.test(v.PUBLISHER)) { console.error('store-identity.txt: PUBLISHER must start with CN='); process.exit(2); }

const pkgPath = path.join(__dirname, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.build.appx.identityName = v.IDENTITY_NAME;
pkg.build.appx.publisher = v.PUBLISHER;
pkg.build.appx.publisherDisplayName = v.PUBLISHER_DISPLAY_NAME;
if (v.DISPLAY_NAME) pkg.build.appx.displayName = v.DISPLAY_NAME;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

const yes = (x) => /^(yes|y|true|1)$/i.test(x || '');
const sim = yes(v.INCLUDE_SIM_GAME), yt = yes(v.INCLUDE_YOUTUBE_RADIO);
if (!sim) fs.rmSync(path.join(__dirname, 'doom'), { recursive: true, force: true });
fs.writeFileSync(path.join(__dirname, 'build-flags.json'), JSON.stringify({ store: true, noSim: !sim, noYouTubeRadio: !yt }, null, 2) + '\n');
console.log(`Store identity: ${v.IDENTITY_NAME} / ${v.PUBLISHER} / ${v.PUBLISHER_DISPLAY_NAME}`);
console.log(`SIM game: ${sim ? 'included' : 'left out'} :: YouTube radio: ${yt ? 'included' : 'left out'}`);
