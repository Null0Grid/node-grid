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

## 5.1.0: more Linux packages, Store build fixes, sidebar picture-in-picture

- Linux builds now come in four formats: `.deb` (as before), AppImage (any distro, no install), `.rpm` (Fedora / openSUSE / RHEL) and `.tar.gz`. `npm run dist:linux` builds all four, and the release workflow attaches all four.
- Microsoft Store package: the release build now applies `store-identity.txt` before packaging (it previously built with placeholder identity values), and a separate **Store package** workflow builds just the `.appx` and fails if its name or identity don't match `store-identity.txt`.

### Picture-in-picture docked in the sidebar

Every tab is its own `WebContentsView`; all of them sit on top of `win.contentView` at the same bounds (`tabBounds(t)`), and `activate(id)` just re-adds a view to bring it to the top of the stack — nothing is ever hidden or torn down on switch. That meant a tab's bounds could be redirected anywhere on screen, including into the sidebar's `.tabspacer` strip (the gap above the music player, below the tab list), without touching playback or process state at all.

Docking works by shrinking the *entire* docked tab down to that strip's rect and injecting a scoped stylesheet that hides everything on the page except the chosen `<video>`, stretched to fill the tab's now-tiny view (`visibility: hidden` on everything else, `position: fixed; inset: 0; object-fit: contain` on the video). The tab keeps running exactly as it was — same process, same playback position — only its visual bounds moved. A small overlay view (`pipdock.html`/`pipdock-preload.js`, the same pattern as the existing `gear.html` overlay) draws a restore/close bar on top of it.

`shell.js` reports `#tabspacer`'s live rect to main (`setPipDockBounds`, mirroring the existing `#viewport` → `setViewport` reporting), so collapsing the sidebar, or any other panel covering it, is detected the same way and falls back to a normal floating PiP window automatically (`dockRoomy()` — collapsing or no room both land here, not just one deliberate case). Toggling PiP again on the docked tab restores it to the foreground tab; closing the dock's own `X` leaves focus where it was.

A separate Settings toggle (`pipdock`, defaulting on) controls this independently of the master `pip` toggle — turning it off always gives the OS's own floating PiP window instead.

Verified live in the app (`tests/ui-pipdock.test.js`, `npm run test:ui:pipdock`) against a tiny local video fixture: dock pulls focus to the remaining tab while keeping the docked tab alive, restore brings it back to the foreground, close drops the overlay without switching focus, and collapsing the sidebar with no room to dock removes the overlay on its own. Assertions are made the same way a person would judge it from the UI — which tab carries `.active`, whether the `pipdock.html` overlay window exists — not through any main-process backdoor. (Playwright's own page-level `screenshot()` can't be used for this: it only captures one `WebContentsView`'s own paint, not the other views Electron composites alongside it at the window level — a real limitation of the test tooling, not of the feature.)

## 5.1.1: arm64, Flatpak, Snap, AUR

Extended the Linux packaging from x64-only to x64 + arm64 for all four existing formats (`.deb`, `.rpm`, `AppImage`, `.tar.gz`), and added `.flatpak` and `.snap` as electron-builder targets for both architectures. None of NODE_GRID's dependencies compile native code (`@ghostery/adblocker-electron` and `qrcode` are pure JS — confirmed by the absence of any `binding.gyp` or `.node` file in `node_modules`), so the arm64 builds are a straight repackage of the prebuilt arm64 Electron binary, not a cross-compile — no arm64 hardware or emulator needed. All eight arm64/x64 combinations of the four core formats were built and verified in this pass: `dpkg-deb -I` / `rpm -qip` confirm each package's declared architecture, and `file` confirms each AppImage's actual ELF machine type (x86-64 vs ARM aarch64) matches its name.

`.flatpak` and `.snap` couldn't be build-verified the same way — flatpak-builder needs the `org.electronjs.Electron2.BaseApp` / `org.freedesktop.{Platform,Sdk}` runtime from Flathub, and snap packaging needs a working snapcraft backend (lxd or multipass), neither of which was reachable from the sandbox this was built in (Flathub's host is outside the sandbox's allowed egress; snapd/lxd aren't present at all). The electron-builder config for both is in place and `npm run dist:linux:flatpak` / `:snap` will build them on a machine that has the tooling; the release workflow also tries both in their own best-effort CI jobs (`continue-on-error: true`) so a failure there doesn't block the rest of the release.

Two more formats are hand-maintained rather than built by electron-builder, since neither fits its model:

- **AUR**: `packaging/aur/PKGBUILD` (a `-bin` package, `nullgrid-browser-bin`, that downloads the released `.tar.gz`/`-arm64.tar.gz` rather than compiling) and `packaging/aur/.SRCINFO` (generated from it with a real `makepkg --printsrcinfo`, not hand-typed). The icon ships as a local file next to the PKGBUILD (`dev.nullgrid.nodegrid.png`, copied from `home/icon-512.png`) because the app's actual icon lives inside `app.asar` and isn't a loose file in the release tarball to install from directly. Verified end-to-end: `makepkg -d --nodeps` against the real locally-built 5.0.0 x64 tarball successfully produced a package with the binary at `/opt/nullgrid-browser/node-grid`, a `/usr/bin/node-grid` symlink, the `chrome-sandbox` helper with its setuid bit intact (`chmod 4755`, needed for Chromium's sandboxing to work when installed outside a user's home directory), the `.desktop` file, and the icon all in the right places.
- **Flathub submission manifest**: `packaging/flathub/dev.nullgrid.nodegrid.yml`, `.desktop`, and `.metainfo.xml` — the manifest a `github.com/flathub/dev.nullgrid.nodegrid` submission actually needs, which is a from-source build against the Freedesktop/Electron2 base app, not the same thing as the electron-builder `.flatpak` target above (that one just repackages the release build for direct download). Validated with `appstreamcli validate --no-net` (passed) and `desktop-file-validate` (passed) — both tools installed and run in this pass, not just inspected by eye. The manifest pins to a GitHub release tag for its source and leaves a placeholder checksum (`REPLACE_WITH_SHA256_OF_SOURCE_TARBALL_FOR_THIS_TAG`) to be filled in against the actual tagged source archive at submission time, since that hash can't be computed before the tag exists.
