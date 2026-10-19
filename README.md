# NODE_GRID

The NODE_GRID desktop browser — part of the Null Grid suite (Null Search, Null Notes, Null Drive). Electron app with a vertical tab sidebar, favorites, hostname-only history, ad blocking, a login vault, a built-in radio player, burner tabs, dark-page forcing, an AI side panel, and a direct connection to your own Null Drive server.

## Running from source

```bash
npm install
npm start
```

## Building

```bash
npm run dist          # portable Windows build (electron-packager), dist/NODE_GRID-win32-x64/
npm run dist:linux     # Linux .deb (electron-builder), store-dist/
npm run store          # Microsoft Store .appx (electron-builder) — needs store-identity.txt filled
                       # in from Partner Center first; see STORE-STEPS.txt
```

## Null Drive

`null-drive.js` is the only place the app talks to Null Drive — the browser's main process makes the connection directly (handshake, search, view, download), never the web page. `window.nodegridDrive`, exposed by `tab-preload.js`, is the one bridge the search page can call, and only when it's running inside a NODE_GRID tab on the configured search origin. See `null-grid/node-grid-v3.0-drive-vault.md` in the Null Grid project for the full API contract and the three account states (normal, end-to-end encrypted, search-only token) this integration is tested against.

## Why this repo is public

`store-identity.txt` notes that NODE_GRID's built-in SIM game uses `doomgeneric` (GPL-2.0), and that shipping it requires NODE_GRID's own source to be publicly available — this repo is that source.

## License

No license file is included yet — add one before relying on this repo being public in a way that satisfies the GPL-2.0 obligation above.
