# Security

## What's protected, and how

| Data | Where it lives | Protection |
|---|---|---|
| Saved logins (login vault) | this PC, in NODE_GRID's app data | `safeStorage` (Windows DPAPI / Linux keyring via libsecret), tied to this OS account. Optional 4–8 digit PIN, stored only as a salted `scrypt` hash, unlocks the vault for 5 minutes after each use |
| Null Drive API token | this PC, in NODE_GRID's app data | Same `safeStorage` encryption as logins. Never reaches the web page or Null Search's server — see below |
| Null Drive address + token | NODE_GRID's main process only | The main process makes the connection directly; `window.nodegridDrive` (exposed to pages by `tab-preload.js`) only reaches a page running inside a NODE_GRID tab on the configured search origin, and the main process re-checks the sender's origin on every call |
| History | this PC | Site names only — never full pages or search queries — last 100 sites, 7 days |
| Burner tabs | nowhere | Wiped on close; nothing they touch is kept |
| Site permissions, trusted self-signed certificates | this PC | Remembered per origin; a self-signed certificate is only ever trusted after you explicitly choose "Proceed anyway" once |
| Pages sent to the AI side panel | whichever AI provider you picked | NODE_GRID doesn't see or store this traffic beyond opening the panel; it's exactly the same as visiting that provider's site in a tab |

## Null Drive: the three account states

- **Normal account, Everything-scope token.** Handshake connects, search returns Drive matches, view and download both work.
- **End-to-end encrypted account.** Drive turns its search index off for that account; NODE_GRID shows "connected, but this account is end-to-end encrypted, so Drive can't search it," never an empty result list. Opening encrypted files isn't supported — search never returns a path to one, so there's nothing to open.
- **Search-only token.** Handshake and search succeed; view and download are refused (`403 insufficient_scope`) and NODE_GRID shows why, rather than failing silently.

See [docs/handoffs/node-grid-v3.0-drive-vault.md](docs/handoffs/node-grid-v3.0-drive-vault.md) for the full contract and how this is tested (`npm test`, `npm run test:ui`).

## Reporting a vulnerability

Please don't open a public issue. Email **luc.honz@proton.me** with the steps to reproduce, and you'll get an answer within a few days.
