# NODE_GRID: technical history

This file covers what's documented about how NODE_GRID's Null Drive integration works and was verified. Earlier version history (the sidebar, login vault, ad blocking, burner tabs, radio player, AI panel, and the rest of the shell) predates this file and isn't reconstructed here to avoid stating something that wasn't actually recorded at the time.

## 3.0.0: Null Drive connection

- `null-drive.js` (new): the browser's main process talks to Null Drive directly — never the web page, never Null Search's own server.
  - Handshake: `GET /api/v1/me` with `Authorization: Bearer <token>`. States: connected (as user), encrypted (end-to-end encrypted account, search off), token rejected, not a Null Drive, unreachable, untrusted certificate.
  - Search: `GET /api/v1/search?q=&limit=25`; honors the `X-NullDrive-Search: encrypted` response header.
  - View/download: `GET /api/v1/files/{path}` (each path segment URL-encoded). Needs an **Everything**-scope token — a search-only token gets `403 insufficient_scope`, surfaced to the user rather than failing silently.
  - Only paths a search this session actually returned can be opened or downloaded.
  - Self-signed HTTPS is accepted only for devices already trusted in Settings → Trusted local devices (the same fingerprint store used for web pages).
  - Downloads stream to the Downloads folder; name clashes become `name (1).ext`.
- Settings: the **NULL DRIVE** section — address + token, Enter to connect/handshake, a status line, Check again, Disconnect. The token is stored with `safeStorage`. The handshake re-runs on every launch.
- `tab-preload.js`: `window.nodegridDrive` (`status/search/view/download/showDownload`), exposed only to the top frame of a page on the configured search origin; the main process re-checks the sender's origin on every call, not just at exposure time.

## 5.0.0: verifying the connection end to end

A later pass checked `null-drive.js`'s handshake/search/view/download against the three documented Null Drive account states (normal account, end-to-end encrypted account, search-only token) and found the module itself already correct — `migrating` falls into the same `encrypted` bucket as `on` because the handshake only branches on `e2ee !== 'off'`, the `X-NullDrive-Search: encrypted` header is checked on every search response, and `insufficient_scope` is detected before falling through to the generic token-rejected case.

The actual gap was the UI side: nothing in the shipped app called `window.nodegridDrive` at all, so none of the three states had anywhere to show up. That's fixed now — see [docs/handoffs/node-grid-v3.0-drive-vault.md](handoffs/node-grid-v3.0-drive-vault.md) for the full account of what was found, what changed, and how it was verified live in the app for all three states (`tests/ui-drive.test.js`, `npm run test:ui`).

A pure-Node test (`tests/drive.test.js`, `npm test`) exercises `null-drive.js` directly against the same three states without needing Electron at all, using the mock Drive server in `tools/mock-drive.js`.

## 5.1.0: more Linux packages and Store build fixes

- Linux builds now come in four formats: `.deb` (as before), AppImage (any distro, no install), `.rpm` (Fedora / openSUSE / RHEL) and `.tar.gz`. `npm run dist:linux` builds all four, and the release workflow attaches all four.
- Microsoft Store package: the release build now applies `store-identity.txt` before packaging (it previously built with placeholder identity values), and a separate **Store package** workflow builds just the `.appx` and fails if its name or identity don't match `store-identity.txt`.
