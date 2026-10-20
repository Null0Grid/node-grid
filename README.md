# NODE_GRID

**A vertical-tab desktop browser with ad blocking, a login vault, and a direct line to your own files.** It's part of **[Null Grid](https://nullgrid.dev)**, alongside Null Search and Null Drive.

![Settings → Null Drive, connected](docs/screenshots/null-drive-settings.png)

## Features

- **Vertical tab sidebar** — tabs, favorites, hostname-only history (no pages, no searches, last 100 sites / 7 days), and a **login vault** (`safeStorage`-encrypted).
- **Ad + tracker blocking** (`@ghostery/adblocker-electron`), pausable per site.
- **Burner tabs** — throwaway, wipe-itself storage; nothing they touch is kept.
- **Dark pages**, forced on any site, bright or not.
- **A built-in radio player** in the sidebar, playable from any tab.
- **An AI side panel** — Claude by default, or your own pick (ChatGPT, Gemini, Grok, a local model).
- **Null Search integration** — the start page searches through Null Search, with Vault Matches merging your own notes and Drive files right into web results.
- **A direct Null Drive connection.** The browser itself — not the web page — handshakes with your Null Drive, so your address and token never reach the search origin. See [How it connects to Null Grid](#how-it-connects-to-null-grid).

## Install

- **Windows:** [Microsoft Store](https://apps.microsoft.com/detail/9NW82T0G35QF), or the portable build from [Releases](../../releases).
- **Linux, any distro, no install needed:** download the `.AppImage` from [Releases](../../releases), then
  ```
  chmod +x NODE_GRID-5.1.0.AppImage
  ./NODE_GRID-5.1.0.AppImage
  ```
- **Ubuntu 24.04+ / Debian 13+:** download the `.deb` from [Releases](../../releases), then
  ```
  sudo apt install ./nullgrid-browser_5.1.0_amd64.deb
  ```
- **Fedora / openSUSE / RHEL:** download the `.rpm` from [Releases](../../releases), then
  ```
  sudo rpm -i nullgrid-browser-5.1.0.x86_64.rpm
  ```
- **Any other Linux:** download the `.tar.gz` from [Releases](../../releases), unpack it, and run the `node-grid` binary inside.

## How it connects to Null Grid

NODE_GRID's main process is the only thing that ever talks to Null Drive — never the web page, and never Null Search's own server. `null-drive.js` does the handshake (`GET /api/v1/me`), search, view and download; `window.nodegridDrive`, exposed by `tab-preload.js`, is the one bridge a page can call, and only when it's running inside a NODE_GRID tab on the configured search origin.

1. Settings → **NULL DRIVE** → enter your address and an API token (Null Drive: Settings → Devices → Add device → Create an API token, scope **Everything** — needed to view and download files; a search-only token can search but not open or download).
2. **If your Drive account is end-to-end encrypted:** Drive turns its search index off for that account by design — NODE_GRID shows "connected, but this account is end-to-end encrypted, so Drive can't search it," not an empty result list. Opening encrypted files isn't supported (search never surfaces a path to one, so there's nothing to open).
3. Connected, your Drive files show up in Vault Matches on the Null Search results page (badge `drive`), right alongside your Null Search vault and Null Notes.

See [docs/handoffs/node-grid-v3.0-drive-vault.md](docs/handoffs/node-grid-v3.0-drive-vault.md) for the full API contract and how all three account states are tested.

## Build from source

```bash
npm install
npm start
```

**Tests:**
```bash
npm test        # null-drive.js against the three documented Drive account states (no Electron)
npm run test:ui # the same three states, live in the real app (needs a display; xvfb-run -a npm run test:ui on Linux without one)
```

**Packages:**
```bash
npm run dist         # portable Windows build (electron-packager), dist/NODE_GRID-win32-x64/
npm run dist:linux   # Linux .deb, .rpm, AppImage, .tar.gz (electron-builder), store-dist/
npm run store        # Microsoft Store .appx (electron-builder) — needs store-identity.txt
                      # filled in from Partner Center first; see STORE-STEPS.txt
```

Pushing a tag like `5.0.1` or `v5.0.1` runs [the release workflow](.github/workflows/release.yml), which builds all of them and attaches them to the GitHub release. For a tag that already exists: Actions → Release → Run workflow.

**Try Null Drive without a real server:**
```bash
node tools/mock-drive.js 8081 normal      # or: encrypted, scope
```
Then connect to `127.0.0.1:8081` in Settings → NULL DRIVE with any token.

## Repository layout

| Path | What |
|---|---|
| `main.js` | the main process: window + tab chrome, all IPC handlers |
| `null-drive.js` | the only place the app talks to Null Drive — handshake, search, view, download |
| `tab-preload.js` | per-tab preload; exposes `window.nodegridDrive` only on the configured search origin |
| `shell.html` / `shell.css` / `shell.js` | the browser chrome: sidebar, tabs, AI panel, radio player |
| `settings.html` / `settings.js` / `settings.css` | the native Settings page, including the NULL DRIVE section |
| `home/` | the bundled start page |
| `doom/` | the NODE_GRID SIM mini-game (`doomgeneric`, GPL-2.0 — see below) |
| `packaging/`, `build/` | Microsoft Store (MSIX) assets and manifest |
| `tools/mock-drive.js` | a stand-in Null Drive server for the three account states, used by tests and for trying Drive by hand |
| `tests/` | `drive.test.js` (backend, no Electron) and `ui-drive.test.js` (live in the app, via Playwright) |
| `docs/HISTORY.md` | technical history, phase by phase |
| `docs/handoffs/` | handoff notes for the Null Grid apps |

## Why this repo is public

`store-identity.txt` notes that NODE_GRID's built-in SIM game uses `doomgeneric` (GPL-2.0), and that shipping it requires NODE_GRID's own source to be publicly available — this repo is that source.

## Security

See [SECURITY.md](SECURITY.md) for what's encrypted where, and how to report a problem.

## License

No license file is included yet — add one before relying on this repo being public in a way that satisfies the GPL-2.0 obligation above.
