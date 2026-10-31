'use strict';
// Backend tests for null-drive.js against the three documented Null Drive
// account states (see docs/handoffs/null-grid-v3.0-drive-vault.md). Plain
// Node, no Electron — null-drive.js has no Electron dependency itself, so
// this runs the same on Linux and Windows in CI.
const assert = require('assert');
const path = require('path');
const createDrive = require(path.join(__dirname, '..', 'null-drive.js'));
const { startMockDrive } = require(path.join(__dirname, '..', 'tools', 'mock-drive.js'));

function makeDrive() {
  let settings = { nullDrive: {} };
  return createDrive({
    getSettings: () => settings,
    saveSettings: () => {},
    enc: (t) => 'enc:' + t,
    dec: (b) => String(b).replace(/^enc:/, ''),
    canEncrypt: () => true,
    downloadsDir: () => require('os').tmpdir(),
    onChange: () => {},
  });
}

async function withMockDrive(mode, fn) {
  const server = await startMockDrive({ mode });
  try {
    const port = server.address().port;
    await fn(makeDrive(), port);
  } finally {
    server.close();
  }
}

async function testNormalAccount() {
  await withMockDrive('normal', async (drive, port) => {
    const connectRes = await drive.connect('127.0.0.1:' + port, 'everything_tok');
    assert.strictEqual(connectRes.ok, true, 'connect should succeed');
    assert.strictEqual(drive.status().state, 'connected', 'handshake should report connected');

    const searchRes = await drive.search('checklist');
    assert.strictEqual(searchRes.ok, true, 'search should succeed');
    assert.strictEqual(searchRes.items.length, 1, 'search should return Drive matches');

    const viewRes = await drive.view('AI/drive-sync-checklist.md');
    assert.strictEqual(viewRes.ok, true, 'view should succeed with an Everything-scope token, got reason=' + viewRes.reason);

    const dlRes = await drive.download('AI/drive-sync-checklist.md');
    assert.strictEqual(dlRes.ok, true, 'download should succeed with an Everything-scope token, got reason=' + dlRes.reason);
  });
  console.log('[pass] normal account: connected, search returns matches, view+download OK');
}

async function testEncryptedAccount() {
  await withMockDrive('encrypted', async (drive, port) => {
    await drive.connect('127.0.0.1:' + port, 'everything_tok');
    assert.strictEqual(drive.status().state, 'encrypted', 'handshake should report encrypted when user.e2ee is "on"');

    const searchRes = await drive.search('checklist');
    assert.strictEqual(searchRes.ok, false, 'search should not report ok on an encrypted account');
    assert.strictEqual(searchRes.state, 'encrypted', 'search should report state=encrypted, not folded into empty results');

    // Opening encrypted files isn't supported and isn't needed: search never
    // returns a path for one, so nothing is ever in the allowed-paths map.
    const viewRes = await drive.view('AI/anything.md');
    assert.strictEqual(viewRes.ok, false);
    assert.strictEqual(viewRes.reason, 'not-allowed');
  });
  console.log('[pass] encrypted account: handshake=encrypted, search reports state=encrypted (not "no results")');
}

async function testSearchOnlyToken() {
  await withMockDrive('scope', async (drive, port) => {
    await drive.connect('127.0.0.1:' + port, 'search_only_tok');
    assert.strictEqual(drive.status().state, 'connected', 'handshake should still succeed with a search-only token');

    const searchRes = await drive.search('checklist');
    assert.strictEqual(searchRes.ok, true, 'search should still work with a search-only token');

    const viewRes = await drive.view('AI/drive-sync-checklist.md');
    assert.strictEqual(viewRes.ok, false);
    assert.strictEqual(viewRes.reason, 'scope', 'view with a search-only token should report reason=scope (403 insufficient_scope)');

    const dlRes = await drive.download('AI/drive-sync-checklist.md');
    assert.strictEqual(dlRes.ok, false);
    assert.strictEqual(dlRes.reason, 'scope', 'download with a search-only token should report reason=scope (403 insufficient_scope)');
  });
  console.log('[pass] search-only token: handshake+search OK, view/download -> reason=scope');
}

(async () => {
  try {
    await testNormalAccount();
    await testEncryptedAccount();
    await testSearchOnlyToken();
    console.log('ALL DRIVE TESTS PASS');
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exitCode = 1;
  }
})();
