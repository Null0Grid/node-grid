'use strict';
// NODE_GRID updating itself in place (main process).
//
// The update check (main.js) finds a newer GitHub release. For copies that can
// replace their own files, this module downloads the release file that matches
// how NODE_GRID was installed, checks it against the SHA-256 GitHub publishes
// for that file (and its size), unpacks it next to the user's data, and swaps
// it in when NODE_GRID restarts or closes:
//
//   zip       Windows portable (.zip): a small PowerShell helper waits for
//             NODE_GRID to exit, copies the new files over the old folder
//             (robocopy, retried while files are still locked) and starts it.
//   tar       Linux .tar.gz in a folder you can write to: same, with /bin/sh.
//   appimage  the .AppImage file itself is replaced (rename over it).
//   deb, rpm  installed with dpkg / rpm through pkexec, which asks for your
//             password, then NODE_GRID restarts.
//
// Anything else is updated by something else (Microsoft Store, Flatpak, Snap)
// or can't be written to, and keeps the old behaviour: download the file /
// open the release page. Settings, logins, history and favorites live in the
// user-data folder, not next to the program, so they're never touched.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');

const SELF = new Set(['zip', 'tar', 'appimage', 'deb', 'rpm']);
// What the new version is started with: only a custom data folder and the
// no-sandbox switch carry over (not a link it was opened with, nor debug flags).
const relaunchArgs = () => process.argv.slice(1).filter((a) => /^--(user-data-dir=.+|no-sandbox)$/.test(a));
const exeDir = () => path.dirname(process.execPath);

function writable(dir) {
  try {
    const probe = path.join(dir, '.nodegrid-write-test-' + process.pid);
    fs.writeFileSync(probe, ''); fs.unlinkSync(probe);
    return true;
  } catch { return false; }
}
const quiet = (cmd, args) => { try { execFileSync(cmd, args, { stdio: 'ignore', timeout: 4000 }); return true; } catch { return false; } };

// How this copy was installed.
function installKind({ app, isStore }) {
  if (isStore) return 'store';
  if (!app.isPackaged) return 'dev';
  if (process.platform === 'win32') return writable(exeDir()) ? 'zip' : 'readonly';
  if (process.platform !== 'linux') return 'none';
  if (process.env.FLATPAK_ID) return 'flatpak';
  if (process.env.SNAP) return 'snap';
  if (process.env.APPIMAGE) return writable(path.dirname(process.env.APPIMAGE)) ? 'appimage' : 'readonly';
  if (quiet('dpkg', ['-S', process.execPath])) return 'deb';
  if (quiet('rpm', ['-qf', process.execPath])) return 'rpm';
  return writable(exeDir()) ? 'tar' : 'readonly';
}

// The release file for this kind of install and this processor.
function pickAsset(kind, assets) {
  const arm = process.arch === 'arm64';
  const archOk = (n) => (arm ? /arm64|aarch64/i.test(n) : !/arm64|aarch64/i.test(n));
  const by = (re) => assets.find((a) => re.test(a.name) && archOk(a.name)) || null;
  switch (kind) {
    case 'zip': case 'readonly-win': return assets.find((a) => /-win32-x64\.zip$/i.test(a.name)) || null;
    case 'appimage': return by(/\.AppImage$/i);
    case 'deb': return by(/\.deb$/i);
    case 'rpm': return by(/\.rpm$/i);
    case 'tar': return by(/\.tar\.gz$/i);
    default: return null;
  }
}

// Download to <dir>/<name>, checking size and SHA-256 as it streams.
async function download(net, asset, dir, onProgress) {
  fs.mkdirSync(dir, { recursive: true });
  const name = path.basename(asset.name).replace(/[^\w.+-]/g, '_');
  const file = path.join(dir, name), part = file + '.part';
  const res = await net.fetch(asset.url, { headers: { 'User-Agent': 'NODE_GRID', Accept: 'application/octet-stream' } });
  if (!res.ok || !res.body) throw new Error('the download failed (HTTP ' + res.status + ')');
  const total = asset.size || Number(res.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(part);
  let failed = null; out.on('error', (e) => { failed = e; });
  let got = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (failed) throw failed;
      hash.update(value); got += value.length;
      if (asset.size && got > asset.size) throw new Error('the download is bigger than GitHub says it should be');
      if (!out.write(value)) await new Promise((r) => out.once('drain', r));
      onProgress(got, total);
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    if (failed) throw failed;
    if (asset.size && got !== asset.size) throw new Error('the download was cut short');
    if (hash.digest('hex') !== asset.sha256) throw new Error("the download doesn't match GitHub's checksum, so it was thrown away");
    fs.renameSync(part, file);
    return file;
  } catch (e) {
    out.destroy(); try { fs.unlinkSync(part); } catch {}
    throw e;
  }
}

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { windowsHide: true, maxBuffer: 1 << 20, ...opts }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr: String(stderr || '') })) : resolve(String(stdout || ''))));
});
const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} };

// Unpack a zip / tar.gz into <dir>/stage and return the folder holding the new
// program (the archive's single top folder), after checking it really is one.
async function unpack(kind, file, dir) {
  const stage = path.join(dir, 'stage');
  rmrf(stage); fs.mkdirSync(stage, { recursive: true });
  if (kind === 'zip') {
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');   // Windows 10 1803+ ships bsdtar, which reads zips
    try { await run(tar, ['-xf', file, '-C', stage]); }
    catch { await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force', file, stage]); }
  } else {
    await run('tar', ['-xzf', file, '-C', stage]);
  }
  const top = fs.readdirSync(stage);
  const src = top.length === 1 && fs.statSync(path.join(stage, top[0])).isDirectory() ? path.join(stage, top[0]) : stage;
  const exe = path.basename(process.execPath);
  if (!fs.existsSync(path.join(src, exe)) || !fs.existsSync(path.join(src, 'resources', 'app.asar'))) {
    rmrf(stage);
    throw new Error("the download doesn't contain " + exe);
  }
  return { stage, src };
}

// Its settings come from a JSON file next to it: PowerShell would read a
// command-line value starting with "-" (like --user-data-dir=...) as a switch.
const PS_HELPER = `param($ConfigPath)
$c = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$ProcId = [int]$c.pid; $Src = $c.src; $Dst = $c.dst; $Stage = $c.stage; $Log = $c.log; $Exe = $c.exe; $Relaunch = $c.relaunch; $ArgLine = $c.argLine
function Say($m) { Add-Content -LiteralPath $Log -Value $m }
try {
  Set-Content -LiteralPath $Log -Value 'waiting'
  $p = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
  if ($p) { $null = $p.WaitForExit(90000) }
  # every NODE_GRID process from this folder (renderers, GPU, crash reporter) has to be gone too
  $exeName = [System.IO.Path]::GetFileNameWithoutExtension($Exe)
  for ($i = 0; $i -lt 60; $i++) {
    $left = @(Get-Process -Name $exeName -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($Dst, [System.StringComparison]::OrdinalIgnoreCase) })
    if ($left.Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
  }
  Say 'copying'
  $ok = $false; $code = -1
  for ($i = 0; $i -lt 15 -and -not $ok; $i++) {
    & robocopy.exe $Src $Dst /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    $code = $LASTEXITCODE
    if ($code -lt 8) { $ok = $true } else { Say ('robocopy ' + $code); Start-Sleep -Seconds 1 }
  }
  if ($ok) { Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue; Set-Content -LiteralPath $Log -Value 'ok' }
  else { Set-Content -LiteralPath $Log -Value ('copy failed (robocopy ' + $code + ')') }
} catch { Say ('error: ' + $_) }
if ($Relaunch -eq '1') { if ($ArgLine) { Start-Process -FilePath $Exe -ArgumentList $ArgLine } else { Start-Process -FilePath $Exe } }
`;
const SH_HELPER = `#!/bin/sh
# NODE_GRID update helper: $1 pid  $2 new files  $3 program folder  $4 stage  $5 log  $6 program  $7 relaunch  $8... its arguments
pid=$1; src=$2; dst=$3; stage=$4; log=$5; exe=$6; again=$7; shift 7
i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 300 ]; do sleep 0.3; i=$((i+1)); done
sleep 0.5
if cp -a "$src"/. "$dst"/; then rm -rf "$stage"; echo ok > "$log"; else echo "copy failed" > "$log"; fi
if [ "$again" = 1 ]; then setsid "$exe" "$@" >/dev/null 2>&1 < /dev/null & fi
exit 0
`;

// Swap the new version in. zip/tar/appimage are synchronous (safe to call while
// quitting); deb/rpm return a promise (they wait for pkexec). The caller quits
// (and, with relaunch, relaunches) afterwards.
function applyNow(kind, ready, { dir, relaunch }) {
  const log = path.join(dir, 'last-update.log');
  rmrf(log);
  if (kind === 'zip' || kind === 'tar') {
    const exe = process.execPath, dst = exeDir();
    if (kind === 'zip') {
      const ps1 = path.join(dir, 'apply-update.ps1'), cfg = path.join(dir, 'apply-update.json');
      fs.writeFileSync(ps1, PS_HELPER);
      fs.writeFileSync(cfg, JSON.stringify({ pid: process.pid, src: ready.src, dst, stage: ready.stage, log, exe, relaunch: relaunch ? '1' : '0',
        argLine: relaunchArgs().map((a) => '"' + a.replace(/"/g, '') + '"').join(' ') }));
      // Started through WMI (Win32_Process.Create), so the helper isn't a child of
      // NODE_GRID and isn't closed along with it; a plain detached child as fallback.
      const cmd = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${ps1}" "${cfg}"`;
      try {
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:NG_UPDATE_CMD }; if ($r.ReturnValue -ne 0) { exit 1 }'],
          { env: { ...process.env, NG_UPDATE_CMD: cmd }, stdio: 'ignore', windowsHide: true, timeout: 30000 });
      } catch {
        spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps1, cfg],
          { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      }
    } else {
      const sh = path.join(dir, 'apply-update.sh');
      fs.writeFileSync(sh, SH_HELPER, { mode: 0o755 });
      spawn('/bin/sh', [sh, String(process.pid), ready.src, dst, ready.stage, log, exe, relaunch ? '1' : '0', ...relaunchArgs()], { detached: true, stdio: 'ignore' }).unref();
    }
    return { ok: true, relaunchSelf: false };
  }
  if (kind === 'appimage') {
    const dst = process.env.APPIMAGE, tmp = dst + '.new';
    fs.copyFileSync(ready.file, tmp);
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, dst);                // a running AppImage keeps its old (unlinked) file until it exits
    rmrf(ready.file);
    fs.writeFileSync(log, 'ok');
    return { ok: true, relaunchSelf: relaunch, execPath: dst, args: relaunchArgs() };
  }
  if (kind === 'deb' || kind === 'rpm') {
    const args = kind === 'deb' ? ['dpkg', '-i', ready.file] : ['rpm', '-U', '--replacepkgs', ready.file];
    return new Promise((resolve) => {
      let p;
      try { p = spawn('pkexec', args, { stdio: 'ignore' }); } catch { resolve({ ok: false, reason: 'no-pkexec' }); return; }
      p.on('error', () => resolve({ ok: false, reason: 'no-pkexec' }));
      p.on('exit', (code) => {
        if (code === 0) { fs.writeFileSync(log, 'ok'); rmrf(ready.file); resolve({ ok: true, relaunchSelf: relaunch, args: relaunchArgs() }); }
        else resolve({ ok: false, reason: code === 126 || code === 127 ? 'cancelled' : 'install', code });
      });
    });
  }
  return { ok: false, reason: 'kind' };
}

function lastLog(dir) { try { return fs.readFileSync(path.join(dir, 'last-update.log'), 'utf8').trim(); } catch { return ''; } }
function cleanup(dir) { for (const f of ['stage', 'apply-update.ps1', 'apply-update.json', 'apply-update.sh']) rmrf(path.join(dir, f)); try { for (const f of fs.readdirSync(dir)) if (/\.(part|zip|gz|AppImage|deb|rpm)$/i.test(f)) rmrf(path.join(dir, f)); } catch {} }

module.exports = { SELF, installKind, pickAsset, download, unpack, applyNow, lastLog, cleanup };
