#!/usr/bin/env node
'use strict';
// A stand-in Null Drive server for testing Null Grid's Drive connection
// without a real server. Implements just the three endpoints null-drive.js
// calls (GET /api/v1/me, /api/v1/search, /api/v1/files/{path}) in one of
// three modes, matching the three account states documented in
// docs/handoffs/null-grid-v3.0-drive-vault.md:
//
//   normal     - e2ee off, search returns matches, view/download succeed
//   encrypted  - e2ee on, search returns [] with X-NullDrive-Search: encrypted
//   scope      - handshake/search succeed, view/download get 403 insufficient_scope
//
// Usage:
//   node tools/mock-drive.js [port] [mode]
//   node tools/mock-drive.js 8081 encrypted
//
// Then in Null Grid's Settings > NULL DRIVE, connect to 127.0.0.1:<port>
// with any token (mode "scope" expects you to pretend it's a search-only
// token; the mock doesn't actually check scope by token, only by mode).
const http = require('http');

function startMockDrive({ port = 0, mode = 'normal' } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/v1/me') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ user: { name: 'luke', e2ee: mode === 'encrypted' ? 'on' : 'off' } }));
        return;
      }
      if (url.pathname === '/api/v1/search') {
        res.setHeader('Content-Type', 'application/json');
        if (mode === 'encrypted') { res.setHeader('X-NullDrive-Search', 'encrypted'); res.end('[]'); return; }
        res.end(JSON.stringify([
          { id: 'd1', title: 'Drive Sync Checklist', path: 'AI/drive-sync-checklist.md', snippet: 'checklist synced to Null Drive', modified: new Date().toISOString().slice(0, 10) },
        ]));
        return;
      }
      if (url.pathname.startsWith('/api/v1/files/')) {
        if (mode === 'scope') {
          res.statusCode = 403;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: { code: 'insufficient_scope' } }));
          return;
        }
        res.setHeader('Content-Type', 'text/markdown');
        res.end('# Drive Sync Checklist\n\n- one\n- two\n');
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { startMockDrive };

if (require.main === module) {
  const port = Number(process.argv[2]) || 8081;
  const mode = process.argv[3] || 'normal';
  if (!['normal', 'encrypted', 'scope'].includes(mode)) {
    console.error('mode must be one of: normal, encrypted, scope');
    process.exit(1);
  }
  startMockDrive({ port, mode }).then((server) => {
    const addr = server.address();
    console.log(`mock Null Drive (${mode}) listening on 127.0.0.1:${addr.port}`);
  });
}
