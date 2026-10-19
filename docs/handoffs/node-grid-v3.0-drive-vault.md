# NODE_GRID 3.0.0 — Vault search from Null Drive (browser-side connection)

Status: **verified 2026-10-19** against the three documented Null Drive 0.8.3 scenarios (real NODE_GRID app under Xvfb, driven end-to-end through its actual UI, against a mock Null Drive server that reproduces each scenario's exact response shape). One real bug found and fixed in `results.html`; `null-drive.js` itself needed no changes. Still not run against a real Null Drive server or on Windows — see Open items.

## 2026-10-19 verification pass

Checked the three scenarios from the Drive 0.8.3 contract:

1. **Normal account, Everything token** — handshake → `connected`; search returns Drive matches; View and Download both succeed.
2. **Encrypted/migrating account** (`GET /api/v1/me` → `user.e2ee: "on"`) — search returns `[]` with `X-NullDrive-Search: encrypted`; the UI must show "encrypted, search off", not "no results". Opening encrypted files is out of scope by design (search never returns a path for one, so there's never anything to open).
3. **Search-only token** — handshake and search succeed; View and Download get `403 insufficient_scope`; the message must be shown, not swallowed.

**`null-drive.js` (handshake/search/view/download): correct as-is, no changes.** Read it end to end and wrote a standalone Node test (now `tests/drive.test.js` in this repo, no Electron dependency) that drives it against a mock server for all three scenarios — passes. It already does exactly what the contract says: `e2ee !== 'off'` → `state: 'encrypted'`; the `X-NullDrive-Search: encrypted` header is checked on every search response and returns `{ok:false, state:'encrypted'}` (not folded into empty results); `view()`/`download()` both detect `403` + `error.code === 'insufficient_scope'` and return `{ok:false, reason:'scope'}` before falling through to the generic 401/403 "token" case. `migrating` is not special-cased separately from `on` anywhere in this file — since the handshake only branches on `e2ee === 'off'` vs. anything else, `migrating` already falls into the same `encrypted` bucket as `on`, satisfying "treat it exactly like on" without needing an explicit check.

**Bug found and fixed: `results.html` (a different repo — Null Search's `node-grid-search`) never actually called the Drive bridge.** Despite this doc's "What changed" section below describing Vault Matches showing Drive results with a Download button, the shipped `results.html` still used a pre-3.0 implementation: a direct `fetch()` to a Drive URL/token read from `localStorage`, entered through the page's own old settings form. That directly contradicts this doc's own documented security model ("the browser, not the web page, makes the Drive connection") and meant:
- Search never went through `null-drive.js` at all, so Drive matches never appeared via the real connection — scenario 1's "search should return Drive matches" had no working path.
- The `encrypted` state had no UI surface — an encrypted account would have just shown "no vault matches", exactly the wrong message scenario 2 calls out.
- View/Download didn't exist as actions at all, so the `insufficient_scope` message had nowhere to appear — scenario 3's "check that the message is shown" had nothing to check.

Fixed by rewiring `results.html` to the real bridge: removed the `localStorage`-based `getDriveConfig`/`setDriveConfig`/direct-`fetch` code entirely; `fetchDriveItems()` now calls `window.nodegridDrive.search()` (present only inside a NODE_GRID tab; absent → Drive section simply doesn't appear on the plain website, which is correct — there is no bridge to call there). Drive result cards are no longer plain links: clicking one calls `.view()`, and a DOWNLOAD button on each calls `.download()`; both surface every failure reason `null-drive.js` can return (`scope`, `not-allowed`, `token`, `unreachable`, `cert`, `gone`, `big`, `encrypted`, `error`) as a message in a new `#driveStatus` line, styled like the existing vault-sync status line. An `encrypted` search result shows "connected, but this account is end-to-end encrypted, so Drive can't search it" (mirrors `settings.js`'s `DRIVE_STATE` text) instead of "no vault matches".

Verified live, not just read: scripted the real app through Settings → connect → search → view → download against each of the three mock scenarios. This repo's `tests/ui-drive.test.js` (`npm run test:ui`) is the same check, running against a minimal fixture search page (`tests/fixtures/search-site/`) since `results.html` lives in the `node-grid-search` repo rather than this one.
- Normal: Settings shows "Connected as luke"; search returns 1 Drive card; view succeeds silently; download shows "Drive: saved drive-sync-checklist.md to Downloads."
- Encrypted: Settings shows "Connected, but this account is end-to-end encrypted, so Drive can't search it"; search returns 0 Drive cards and `#driveStatus` shows the same message (not "no vault matches").
- Search-only token: search still returns 1 Drive card; clicking it (view) and its DOWNLOAD button both show "Drive: this token can only search. View and download need an Everything-scope token (Null Drive > Settings > Devices)."

**Known limitation left as-is (scoped out of this pass):** a successful `view()` currently just clears the status line rather than rendering the file's content inline — `note.html`'s `?drive=1&path=` viewer described below was never actually built either (confirmed: no reference to a `drive` param anywhere in `note.html`). "View ... should work" is satisfied (the call succeeds, the content comes back from `null-drive.js`), but there's no content viewer wired up yet. Flagging this rather than building it now, since it's new UI, not a correctness fix to the three documented behaviors.

## What changed (3.0.0, 2026-10-18)

**NODE_GRID browser (v3.0.0)**
- `null-drive.js` (new): the browser's main process talks to Null Drive directly.
  - Handshake: `GET /api/v1/me` with `Authorization: Bearer <token>`. States: connected (as user), encrypted (E2EE account, search off), token rejected, not a Null Drive, unreachable, untrusted cert.
  - Search: `GET /api/v1/search?q=&limit=25`; honours `X-NullDrive-Search: encrypted`.
  - View/download: `GET /api/v1/files/{path}` (segments URL-encoded). Needs an **Everything** token (search-only tokens get `403 insufficient_scope`, shown to the user).
  - Only paths returned by a search this session can be opened/downloaded.
  - Self-signed HTTPS accepted only for devices already trusted in Settings > Trusted local devices (same fingerprint store as web pages).
  - Downloads stream to the Downloads folder; name clashes become `name (1).ext`.
- Settings: new **NULL DRIVE** section — Address + Token, Enter = connect/handshake, status line, Check again, Disconnect. Token stored with `safeStorage`. Handshake re-runs on every launch.
- `tab-preload.js`: `window.nodegridDrive` bridge (`status/search/view/download/showDownload`), exposed only to the top frame of pages on the search origin; main process re-checks the sender origin.
- Sidebar: New Tab + burner buttons moved directly under the last tab.
- Privacy policy: Null Drive section added.

**Null Search server (node-grid-search — a different repo)**
- `results.html`: when the browser bridge reports a configured Drive, the Vault section shows Drive matches (badge `drive`, path, date, Download button) and the GitHub Sync button hides. Otherwise unchanged. *(As of 2026-10-19: this is now actually true — see verification pass above. It was written here in advance of the real implementation, which is how the gap went unnoticed until this pass.)*
- `server/index.js`: `/api/search?vault=0` skips the GitHub vault.
- `note.html`: `?drive=1&path=` opens Drive files — Markdown rendered (frontmatter hidden, Rendered/Raw), text, images; Download button. **Not actually built — see Open items.**

## Decisions
- Drive **replaces** the GitHub vault when configured; with no Drive set up, the GitHub vault still works.
- The browser, not the web page, makes the Drive connection (Drive is on the same PC or a homelab server; avoids Private Network Access/CORS and keeps the token off the web origin).
- The deployed search.nullgrid.dev matched the 2026-09-25 `node-grid-search` zip; the earlier Phase 4 Notes/Drive panels in `results.html` were never built.

## Open items
- Not tested against the real Null Drive or on Windows.
- `note.html`'s `?drive=1&path=` Markdown/text/image viewer was never built; `view()` currently only confirms success/failure, it doesn't render content. Needed before "Download button" per-file in a dedicated viewer makes sense; the Vault Matches card's own DOWNLOAD button works today without it.
- E2EE Drive accounts: search is off by design; viewing would need the chunk/manifest decrypt protocol (Null Drive's E2EE API docs).
- Privacy policy still has the placeholder contact email.
