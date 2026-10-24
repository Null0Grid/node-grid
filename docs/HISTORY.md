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

## Next release: Masking, menus, Electron 45, updates, YouTube radio

### Masking

Right-click a page or a tab → **Masking** (a per-tab checkbox). Normal tabs identify as `… Chrome/130 … Electron/33 … NODE_GRID/5.1.1`, and some sites — WhatsApp Web is the one that prompted this — refuse browsers they don't recognise. A masked tab presents as the current Google Chrome instead: `webContents.setUserAgent()` sets the `User-Agent` header and `navigator.userAgent` for that tab only, and a CDP `Emulation.setUserAgentOverride` (same debugger approach as Mobile view) puts "Google Chrome" in `navigator.userAgentData.brands`. The OS part uses Chrome's frozen "reduced" strings (`Windows NT 10.0; Win64; x64`, `X11; Linux x86_64`, `Macintosh; Intel Mac OS X 10_15_7`). The version is computed from the date: Chrome 156 reached Stable on 2026-10-20 and Chrome ships a new major every two weeks, so the mask keeps up without updates. Toggling reloads the page, since sites check on load. Mobile view, when on, wins over the mask and restores it when turned off. If Inspect is open on the tab, the debugger is busy, so only the header and `navigator.userAgent` are masked, not the brands.

Verified live (`tests/ui-masking.test.js`, `npm run test:ui:masking`) through the real native right-click menu, driven with xdotool: unmasked tab says Electron; after picking Masking the echoed header, `navigator.userAgent` and brands all say Google Chrome; a second tab stays unmasked; picking it again restores the normal identity.

### Electron 45 (Chromium 156)

Upgraded from Electron 33 (Chromium 130) to Electron 45 (Chromium 156.0.8078.48, Node 24). Microsoft Store policy 10.2.1 requires a Chromium-based browser to be within two major versions of the latest Chromium; 130 was 26 behind. Electron 45 needs Node 22.12+ to install, so every workflow now uses Node 22. All test suites pass unchanged.

### Right-click menus regrouped

Page menu: navigate (Back/Forward/Reload) / this page (Translate, Reader mode, Picture in picture, Select all) / keep & share (favorites, copy address, Vault, send to phone, print, PDF) / Masking / developer (View page source, Packet trail, Recon, Mobile view, Inspect). Tab menu: new / this page / Masking / pin & sleep (and burner) / close. Link, image, text-box and spelling sections are unchanged at the top.

### Update checks and the update bot

`main.js` › updates asks `api.github.com/repos/Null0Grid/node-grid/releases/latest` 8 s after launch and then once a day (Settings › FEATURES › "Check GitHub for new versions", on by default), and any time from Settings › UPDATES › CHECK FOR UPDATES. A newer `tag_name` than the app's version brings out the update bot: a transparent `WebContentsView` (`updatebot.html`) along the bottom-left of the page, where the crashed-tab page's robot (without its broom) runs in, hops twice and offers GET IT / WHAT'S NEW / LATER. GET IT downloads the release file that fits the computer through the normal Downloads panel (Windows zip; on Linux the AppImage if running from one, else `.deb`/`.rpm`/`.tar.gz` by distro), or opens the release page. LATER remembers the version so the daily check doesn't bring it back for that one; CHECK FOR UPDATES always does. Microsoft Store copies check too but can't replace themselves with a GitHub download (Windows keeps Store apps and their data separate), so for them the bot says the Store update is on its way. The release workflow's `store-submit` job sends each release's `.appx` to Partner Center with the Microsoft Store CLI once the Partner Center secrets are set (STORE-STEPS.txt). Tested live with a stand-in GitHub (`tests/ui-updates.test.js`); the test caught that the robot's canvas covered the bubble's buttons, now `pointer-events: none`.

### YouTube radio, visible

YouTube stations used to play in a hidden 1×1 player, which YouTube's terms don't allow, so Store builds left them out. The player now sits on top of a 213×200 box in the radio panel (`#plvideo`; YouTube requires embedded players to be at least 200×200 with nothing covering them), reported by the shell like `#viewport`. When the box can't be seen (player minimised, sidebar collapsed) the main process pauses YouTube and resumes when it's back, and playback never starts while hidden. With that, `INCLUDE_YOUTUBE_RADIO=yes` for Store builds. Tested live (`tests/ui-ytradio.test.js`) with a stand-in embed page: the box's on-screen centre pixel is the test video's red, and minimise/restore pauses and resumes it.

### Smaller

- Settings › FEATURES › "Expand the shrunk sidebar when you hover over it" (on by default).
- The settings icon is now an 8-tooth cog.

