# Null Grid: technical history

This file covers what's documented about how Null Grid's Null Drive integration works and was verified. Earlier version history (the sidebar, login vault, ad blocking, burner tabs, radio player, AI panel, and the rest of the shell) predates this file and isn't reconstructed here to avoid stating something that wasn't actually recorded at the time.

## 3.0.0: Null Drive connection

- `null-drive.js` (new): the browser's main process talks to Null Drive directly — never the web page, never Null Search's own server.
  - Handshake: `GET /api/v1/me` with `Authorization: Bearer <token>`. States: connected (as user), encrypted (end-to-end encrypted account, search off), token rejected, not a Null Drive, unreachable, untrusted certificate.
  - Search: `GET /api/v1/search?q=&limit=25`; honors the `X-NullDrive-Search: encrypted` response header.
  - View/download: `GET /api/v1/files/{path}` (each path segment URL-encoded). Needs an **Everything**-scope token — a search-only token gets `403 insufficient_scope`, surfaced to the user rather than failing silently.
  - Only paths a search this session actually returned can be opened or downloaded.
  - Self-signed HTTPS is accepted only for devices already trusted in Settings → Trusted local devices (the same fingerprint store used for web pages).
  - Downloads stream to the Downloads folder; name clashes become `name (1).ext`.
- Settings: the **NULL DRIVE** section — address + token, Enter to connect/handshake, a status line, Check again, Disconnect. The token is stored with `safeStorage`. The handshake re-runs on every launch.
- `tab-preload.js`: `window.nullgridDrive` (`status/search/view/download/showDownload`), exposed only to the top frame of a page on the configured search origin; the main process re-checks the sender's origin on every call, not just at exposure time.

## 5.0.0: verifying the connection end to end

A later pass checked `null-drive.js`'s handshake/search/view/download against the three documented Null Drive account states (normal account, end-to-end encrypted account, search-only token) and found the module itself already correct — `migrating` falls into the same `encrypted` bucket as `on` because the handshake only branches on `e2ee !== 'off'`, the `X-NullDrive-Search: encrypted` header is checked on every search response, and `insufficient_scope` is detected before falling through to the generic token-rejected case.

The actual gap was the UI side: nothing in the shipped app called `window.nullgridDrive` at all, so none of the three states had anywhere to show up. That's fixed now — see [docs/handoffs/null-grid-v3.0-drive-vault.md](handoffs/null-grid-v3.0-drive-vault.md) for the full account of what was found, what changed, and how it was verified live in the app for all three states (`tests/ui-drive.test.js`, `npm run test:ui`).

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

Extended the Linux packaging from x64-only to x64 + arm64 for all four existing formats (`.deb`, `.rpm`, `AppImage`, `.tar.gz`), and added `.flatpak` and `.snap` as electron-builder targets for both architectures. None of Null Grid's dependencies compile native code (`@ghostery/adblocker-electron` and `qrcode` are pure JS — confirmed by the absence of any `binding.gyp` or `.node` file in `node_modules`), so the arm64 builds are a straight repackage of the prebuilt arm64 Electron binary, not a cross-compile — no arm64 hardware or emulator needed. All eight arm64/x64 combinations of the four core formats were built and verified in this pass: `dpkg-deb -I` / `rpm -qip` confirm each package's declared architecture, and `file` confirms each AppImage's actual ELF machine type (x86-64 vs ARM aarch64) matches its name.

`.flatpak` and `.snap` couldn't be build-verified the same way — flatpak-builder needs the `org.electronjs.Electron2.BaseApp` / `org.freedesktop.{Platform,Sdk}` runtime from Flathub, and snap packaging needs a working snapcraft backend (lxd or multipass), neither of which was reachable from the sandbox this was built in (Flathub's host is outside the sandbox's allowed egress; snapd/lxd aren't present at all). The electron-builder config for both is in place and `npm run dist:linux:flatpak` / `:snap` will build them on a machine that has the tooling; the release workflow also tries both in their own best-effort CI jobs (`continue-on-error: true`) so a failure there doesn't block the rest of the release.

Two more formats are hand-maintained rather than built by electron-builder, since neither fits its model:

- **AUR**: `packaging/aur/PKGBUILD` (a `-bin` package, `nullgrid-browser-bin`, that downloads the released `.tar.gz`/`-arm64.tar.gz` rather than compiling) and `packaging/aur/.SRCINFO` (generated from it with a real `makepkg --printsrcinfo`, not hand-typed). The icon ships as a local file next to the PKGBUILD (`dev.nullgrid.nullgrid.png`, copied from `home/icon-512.png`) because the app's actual icon lives inside `app.asar` and isn't a loose file in the release tarball to install from directly. Verified end-to-end: `makepkg -d --nodeps` against the real locally-built 5.0.0 x64 tarball successfully produced a package with the binary at `/opt/nullgrid-browser/node-grid`, a `/usr/bin/node-grid` symlink, the `chrome-sandbox` helper with its setuid bit intact (`chmod 4755`, needed for Chromium's sandboxing to work when installed outside a user's home directory), the `.desktop` file, and the icon all in the right places.
- **Flathub submission manifest**: `packaging/flathub/dev.nullgrid.nullgrid.yml`, `.desktop`, and `.metainfo.xml` — the manifest a `github.com/flathub/dev.nullgrid.nullgrid` submission actually needs, which is a from-source build against the Freedesktop/Electron2 base app, not the same thing as the electron-builder `.flatpak` target above (that one just repackages the release build for direct download). Validated with `appstreamcli validate --no-net` (passed) and `desktop-file-validate` (passed) — both tools installed and run in this pass, not just inspected by eye. The manifest pins to a GitHub release tag for its source and leaves a placeholder checksum (`REPLACE_WITH_SHA256_OF_SOURCE_TARBALL_FOR_THIS_TAG`) to be filled in against the actual tagged source archive at submission time, since that hash can't be computed before the tag exists.

## 5.1.1 (continued): Masking, menus, Electron 45, updates, YouTube radio

### Masking

Right-click a page or a tab → **Masking** (a per-tab checkbox). Normal tabs identify as `… Chrome/130 … Electron/33 … Null Grid/5.1.1`, and some sites — WhatsApp Web is the one that prompted this — refuse browsers they don't recognise. A masked tab presents as the current Google Chrome instead: `webContents.setUserAgent()` sets the `User-Agent` header and `navigator.userAgent` for that tab only, and a CDP `Emulation.setUserAgentOverride` (same debugger approach as Mobile view) puts "Google Chrome" in `navigator.userAgentData.brands`. The OS part uses Chrome's frozen "reduced" strings (`Windows NT 10.0; Win64; x64`, `X11; Linux x86_64`, `Macintosh; Intel Mac OS X 10_15_7`). The version is computed from the date: Chrome 156 reached Stable on 2026-10-20 and Chrome ships a new major every two weeks, so the mask keeps up without updates. Toggling reloads the page, since sites check on load. Mobile view, when on, wins over the mask and restores it when turned off. If Inspect is open on the tab, the debugger is busy, so only the header and `navigator.userAgent` are masked, not the brands.

Verified live (`tests/ui-masking.test.js`, `npm run test:ui:masking`) through the real native right-click menu, driven with xdotool: unmasked tab says Electron; after picking Masking the echoed header, `navigator.userAgent` and brands all say Google Chrome; a second tab stays unmasked; picking it again restores the normal identity.

### Electron 45 (Chromium 156)

Upgraded from Electron 33 (Chromium 130) to Electron 45 (Chromium 156.0.8078.48, Node 24). Microsoft Store policy 10.2.1 requires a Chromium-based browser to be within two major versions of the latest Chromium; 130 was 26 behind. Electron 45 needs Node 22.12+ to install, so every workflow now uses Node 22. All test suites pass unchanged.

### Right-click menus regrouped

Page menu: navigate (Back/Forward/Reload) / this page (Translate, Reader mode, Picture in picture, Select all) / keep & share (favorites, copy address, Vault, send to phone, print, PDF) / Masking / developer (View page source, Packet trail, Recon, Mobile view, Inspect). Tab menu: new / this page / Masking / pin & sleep (and burner) / close. Link, image, text-box and spelling sections are unchanged at the top.

### Update checks and the update bot

`main.js` › updates asks `api.github.com/repos/Null0Grid/null-grid/releases/latest` 8 s after launch and then once a day (Settings › FEATURES › "Check GitHub for new versions", on by default), and any time from Settings › UPDATES › CHECK FOR UPDATES. A newer `tag_name` than the app's version brings out the update bot: a transparent `WebContentsView` (`updatebot.html`) along the bottom-left of the page, where the crashed-tab page's robot (without its broom) runs in, hops twice and offers GET IT / WHAT'S NEW / LATER. GET IT downloads the release file that fits the computer through the normal Downloads panel (Windows zip; on Linux the AppImage if running from one, else `.deb`/`.rpm`/`.tar.gz` by distro), or opens the release page. LATER remembers the version so the daily check doesn't bring it back for that one; CHECK FOR UPDATES always does. Microsoft Store copies check too but can't replace themselves with a GitHub download (Windows keeps Store apps and their data separate), so for them the bot says the Store update is on its way. The release workflow's `store-submit` job sends each release's `.appx` to Partner Center with the Microsoft Store CLI once the Partner Center secrets are set (STORE-STEPS.txt). Tested live with a stand-in GitHub (`tests/ui-updates.test.js`); the test caught that the robot's canvas covered the bubble's buttons, now `pointer-events: none`.

### YouTube radio, visible

YouTube stations used to play in a hidden 1×1 player, which YouTube's terms don't allow, so Store builds left them out. The player now sits on top of a 213×200 box in the radio panel (`#plvideo`; YouTube requires embedded players to be at least 200×200 with nothing covering them), reported by the shell like `#viewport`. When the box can't be seen (player minimised, sidebar collapsed) the main process pauses YouTube and resumes when it's back, and playback never starts while hidden. With that, `INCLUDE_YOUTUBE_RADIO=yes` for Store builds. Tested live (`tests/ui-ytradio.test.js`) with a stand-in embed page: the box's on-screen centre pixel is the test video's red, and minimise/restore pauses and resumes it.

### Smaller

- Settings › FEATURES › "Expand the shrunk sidebar when you hover over it" (on by default).
- The settings icon is now an 8-tooth cog.

## 5.1.2: closing tabs from the shrunk sidebar, pinned tabs fixed

With the sidebar shrunk and Settings › FEATURES › "Expand the shrunk sidebar when you hover over it" off, the tabs' close buttons are hidden and the sidebar never expands. Resting the mouse on a tab's icon for 350 ms now turns it into a pink close X; clicking it closes the tab. A quick click on the icon still switches to the tab (it used to do nothing: the icon was excluded from the tab's click handler, a leftover from when it was a close button). That same leftover made **pinned tabs impossible to open** in 5.1.1: a pinned tab is little more than its icon, so clicks on it went nowhere. Fixed by the same change; `tests/ui-pinned.test.js` pins a tab through the real right-click menu and opens it (fails on 5.1.1, passes now). With hover-to-expand on, nothing changes. Tested live (`tests/ui-railclose.test.js`).

## 5.1.2: Settings tidied

- Sections in order of use: Start page search, Appearance + language, Tabs, AI side panel, Features, Privacy + blocking, Site permissions + devices, Saved logins, Null Drive, Updates, About. The jump bar uses each section's own short name (it used to cut names to their first word: START, NULL, SITE, SAVED).
- FEATURES grouped (Browsing, Tabs + sidebar, Media, Tools, and Developer only in developer mode), each switch a short name with a one-line hint, so the tiles are the same height.
- "Wipe burner tabs" moved from Privacy to Tabs.
- Wording that said Windows on every system now matches the system (saved logins' encryption, the footer, the Drive token error). "SAVED LOGINS (KEY BUTTON)" is "SAVED LOGINS", with the key button named in its description. PIN boxes no longer cut off their placeholder.

## 5.1.2: site icons that wouldn't show

Some sites serve their tab icon with `Cross-Origin-Resource-Policy: same-origin` or `same-site` (GitHub's asset site, `github.githubassets.com`, among them). The sidebar is Null Grid's own page, so Chromium refused to load those icons there and the tab showed the empty-square placeholder. The main process now fetches each tab's icon through that tab's own session (its cookies, ad blocking and certificate trust; 8 s timeout, 256 KB cap, first of up to four declared icons that loads, cached) and passes the sidebar a `data:` URL, so the sidebar never contacts websites itself. Tested live (`tests/ui-favicons.test.js`): PNG/SVG, same-site and separate asset site, script-swapped icons, and both CORP variants all show their icon; a page without one shows the placeholder.

## 5.1.2: Null Grid as your default browser

- **Opens the links it's handed.** A link or web file on the command line (how Windows, `xdg-open` and Omarchy hand links to the default browser) opens in a tab: at launch instead of the start page, or, when Null Grid is already open, in a new tab of the running window (`second-instance`). Flags are never taken for links. Tested live (`tests/ui-openlinks.test.js`).
- **Linux.** The `.deb`/`.rpm` launcher entry is `node-grid.desktop` (`desktopName` + `linux.syncDesktopName`, so it also matches the window's app id on Wayland/Hyprland), in `Network;WebBrowser`, declaring `x-scheme-handler/http`, `x-scheme-handler/https`, `text/html` and `application/xhtml+xml`. Settings › DEFAULT BROWSER › MAKE DEFAULT sets it with `xdg-settings` / `xdg-mime`; an AppImage or `.tar.gz` copy first writes the same launcher entry for the user. Flatpak and Snap are left to the desktop's own settings. Tested live in a throwaway home folder (`tests/ui-defaultbrowser.test.js`).
- **Windows Store.** `build/appx-manifest.xml` (electron-builder's template plus the `uap3` namespace) and `packaging/appx/browser-extensions.xml` register `http`, `https` and `.htm`/`.html`/`.xhtml`/`.shtml`, the way Firefox's Store package does, so Null Grid appears in Settings › Apps › Default apps. Store apps can't make themselves the default; Settings › DEFAULT BROWSER opens Default apps so the person picks it. Minimum Windows version is now 10.0.17763 (1809).

## 5.1.3: Flatpak and Snap builds fixed

Both best-effort jobs had failed on every release. Flatpak stopped at setup: `flatpak remote-add` ran without `--user` on a non-root runner. Now Flathub is added per user and the runtimes are installed explicitly, on **25.08** (23.08 is end-of-life; the Flathub manifest moves to 25.08 too). Both jobs also tried arm64 on an x64 runner, which needs emulation they didn't have; Flatpak and Snap now build for x64 only (the .deb/.rpm/AppImage/.tar.gz stay x64 + arm64). The x64 snap builds cleanly without snapcraft (electron-builder's template), checked locally; Confirmed on the 5.1.3 release run: the .flatpak and .snap both built and are attached to the release.


## 5.1.3: updates install themselves; full check, 25 bugs fixed

Every setting and feature re-checked, plus two independent code reviews (main process; pages and UI). Fixed:

- **Security.** Null Drive checked the server certificate only after sending the token; the TLS handshake and certificate check now happen first, and an untrusted server receives nothing. Tab icons from `file://` are read only for local pages (never `file://host/` network shares). Right-click open link / image / search from a burner tab stays burner, and only web links open. Every PIN check (unlock, change, remove) shares the 5-tries / 30-second lockout.
- **Data.** Loadout "Swap" no longer closes (and forgets) pinned tabs. Settings are written to a temp file and renamed, so a crash mid-save can't wipe them.
- **Features.** "Get it" downloads updates even with a Peek or burner tab in front. A docked video's tab never sleeps. A new custom AI address shows in the open panel. "sudo …" searches on the start page are searched (a bare "sudo" is still the joke). Clearing the local AI chat mid-answer starts clean. Small built-in views (gear, Packet's bubble, docked-video controls) could take keyboard focus on load so shortcuts did nothing until a click; they pass keys through now.
- **UI.** Reader and picture-in-picture buttons hide on pages without an article or video. Logins popup: Enter on a row's button no longer fills the page; an expired unlock shows the lock screen. The Dark pages switch shows the saved value. Settings refreshes when developer mode changes. A press on a shrunk-sidebar icon that started before the close X appeared no longer closes the tab. A slow icon from the previous page can't land on the next one; local pages show their own icons. Encryption wording no longer says "Windows" on Linux and macOS.
- **Default browser.** The portable Windows zip says it can't be listed (install from the Store); the Linux launcher entry escapes unusual install paths per the Desktop Entry spec and reports a failed write.

**Updates install themselves.** When a newer version is out, Packet's UPDATE (or Settings › UPDATES › UPDATE TO …) downloads the file that matches how this copy was installed, checks its size and the SHA-256 GitHub publishes for it (a mismatch is thrown away and nothing changes), and unpacks it next to your data. RESTART NOW swaps it in and reopens Null Grid with the tabs you had; or keep browsing and it installs the next time you close Null Grid. The next start says "Updated to Null Grid x" (or that it didn't install, and why). `self-update.js`:
- **Windows portable .zip:** a small PowerShell helper waits for Null Grid to exit, copies the new files over the folder with robocopy (retried while files are still locked), and starts it.
- **Linux .tar.gz:** the same with `/bin/sh`. **AppImage:** the file is replaced in place. **.deb / .rpm:** installed with `dpkg -i` / `rpm -U` through `pkexec`, which asks for your password, on RESTART only.
- **Microsoft Store, Flatpak, Snap:** those update the app themselves, so nothing changes there; a copy in a folder you can't write to still downloads the file for you to install.
- Settings, logins, history and favorites live in the user-data folder, never next to the program, so an update never touches them.
- Tested end to end with two real packaged builds (`tests/selfupdate.test.js`: bad checksum refused, restart-to-update, install-on-close), on Linux and, in CI, on Windows.

The copy you have before 5.1.3 doesn't have this yet, so 5.1.3 itself installs the usual way; updates after it install themselves.

New tests: `ui-settings` (every section, switch and dropdown, saved and applied), `ui-core` (keyboard shortcuts, dark pages, reader, QR) and `ui-fixes` (a check per fix above, which fails on 5.1.2). All 14 suites pass.

## 5.1.4: shrunk-sidebar close X moved to the corner

The 5.1.2 shrunk-sidebar close turned the whole icon into an X after 350 ms, so the usual hover-then-click closed tabs you meant to switch to. Now the icon always switches tabs; hovering a tab for 2 seconds shows a small close X on the icon's top-right corner, and only that closes it. Tested live (`tests/ui-railclose.test.js`).

## 5.1.4: download button in the toolbar

Like Firefox: once something has been downloaded, a download arrow appears in the toolbar (next to the key), with a thin progress line under it while downloads run and a short flash when one finishes. Clicking it opens a list of this session's downloads, newest first, with size and state. Click a finished file to open it; the folder icon shows it in its folder; a running one can be cancelled; CLEAR empties the list (the files stay) and the button goes away again. Escape, or clicking anywhere else, closes the list. The sidebar's Downloads panel is still there. Tested live (`tests/ui-downloads.test.js`).

## 5.1.5: easier on the eyes, and you stay signed in

- **Theme:** Settings › APPEARANCE › Theme: Dark (as before), Light, or Match my computer (follows the system light/dark mode, live). Null Grid's own pages (sidebar, toolbar, Settings, pop-overs, start page, error page) get `data-theme` from the main process as they load and whenever it changes; their CSS has a light palette. Native menus and websites' light/dark preference follow through `nativeTheme`. The window's title-bar buttons are recoloured too.
- **Sidebar size:** Normal, Large, Extra large: bigger tab icons, text, buttons and a wider sidebar, for easier reading.
- **Save logins as you sign in:** when you sign in to a site (a form submit, Enter, or a sign-in button, including username-first logins like Google's), a prompt by the key icon asks SAVE / NOT NOW / NEVER FOR THIS SITE (UPDATE when the password changed). Saved logins go into the encrypted vault. Never in burner tabs or Peek. Settings › SAVED LOGINS: switches for offering and for auto-fill, and the never-list.
- **Auto-fill:** when a site with exactly one saved login shows its sign-in form, the login is filled in (never over what you typed; not while logins are PIN-locked).
- **Stay signed in on sites you choose:** right-click a page › "Keep me signed in on …", or the box on the save prompt. Normal tabs stay in the in-memory session until you keep a site; from then on they use a session on disk (`persist:nullgrid-kept`) that is wiped of every site you didn't keep at each start and each quit (`session.clearData({ excludeOrigins })`; cookies are kept per site, storage like WhatsApp's per exact origin). A tab you keep is reopened in that session with its cookies carried over. Settings › PRIVACY lists the sites, with SIGN OUT + REMOVE.
- **Pinned tabs remember Masking** (`settings.pinnedMasked`), applied before the first request at launch.
- **What's new:** after an update, the first time the start page shows, a card lists what's new and fixed for every version since the one you had (`whats-new.json`, bundled). Settings › ABOUT › WHAT'S NEW shows it any time.
- **Packet's walkthrough:** a 78-second video (12 scenes, original lo-fi jazz bed, all synthesised in `walkthrough/src/lofi.py`) plays the first time Null Grid is opened; SKIP closes it, Settings › ABOUT replays it. Rendered from `walkthrough/src/tour.html` by `walkthrough/src/render.js` (Playwright + ffmpeg), so it can be re-rendered as features change.
- Fixed: a pinned tab with Masking on could get stuck loading at startup.

Tests: `ui-515` (save prompt, auto-fill, never, kept vs. wiped across a restart, pinned Masking, theme and size) and `ui-whatsnew` (card after an update, not again, About, first start plays the walkthrough).

## 5.1.6: security release (two independent reviews of 5.1.5)

**Security**
- **Not-secure warning:** a tab heading to a plain `http://` page (anything but this computer itself: localhost, 127.x) stops at `insecure.html` first. CLOSE never goes in (back to the previous page, or the tab closes); PROCEED, DON'T TRUST opens it for the rest of this run with logins never saved or filled; PROCEED, I TRUST IT remembers the site (`settings.httpTrusted`, listed in Settings › PRIVACY) and lets logins be saved and filled there like on https. The address bar shows the site, and Back skips the warning. Tested live (`tests/ui-insecure.test.js`).
- Null Grid's own frame and pop-overs can't be navigated or open windows (`will-navigate` / `will-frame-navigate` / `will-redirect` prevented, window opens denied for every non-tab app page), and the frame's bridge (`preload.js`) only exists on `shell.html`. Before, a link dragged onto the sidebar could load a website into the frame with its privileged bridge (open tabs, downloads that open, the key popover's passwords).
- Logins: saved and filled only on https pages; auto-fill only into password/username fields that are actually visible on screen, never on pages with more than one password box; manual fill matches the site or its subdomains only. The sign-in capture counts only real key presses and clicks (a page's scripts can't fake a submit), only the active tab, and a saved password can't be replaced while logins are locked. Change-password forms offer the new password.
- Unlock to fill: with logins locked, a small PIN box by the key icon opens when a site's sign-in form shows; the right PIN fills the login.
- Keep me signed in, redesigned: the first kept site moves every open normal tab into the kept session at once (cookies carried over), so sessions are never split; sites are kept with their port; the box starts unticked; signing out of one site clears its data and only the cookies no other kept site shares; opening Null Grid while it's still wiping on quit starts it again right after.
- Updater: a .deb/.rpm is hashed again right before pkexec installs it; the .tar.gz helper waits for every process from the folder and retries the copy; NULLGRID_* test switches are removed in installed builds (except a loopback test update server); release builds only get `contents: read`, the attach job `write`.
- "Open an app": the prompt names the app (link scheme), answers are per app, and risky Windows schemes (ms-msdt, search-ms, ms-officecmd...) are always refused. Pop-ups from websites open only http(s) addresses.
- Null Drive warns when the token goes over plain http to a network name (nas.lan), not just to outside addresses.

**Fixes**
- Update files for copies that can't update themselves go through the Downloads list.
- Light theme: readable burner tabs and the address bar's grey text; tabs no longer flash black.
- The What's new card and the walkthrough don't take the keyboard while you're typing; upgraders see only the notes since the version they had.
- The start page's dashboard button is now a setting (Settings > Start page search); no built-in address.
- Privacy policy: real contact address; kept sites and saved logins described.

Tests: `ui-515` adds https-only, faked sign-ins, the PIN box, and frame/pop-over navigation.

## 5.1.7: tabs across the top, YouTube radio fills its box

- Settings → APPEARANCE → **Tabs**: *On the side* (default) or *Across the top* (`settings.tabsPos = 'top'`, sent to the shell as `state.tabsPos`; action `tabs-pos`).
  - The shell moves `#pins`, `#tabs` and `#tabrow` into `#topstrip` above the toolbar (the same elements, so every click, menu and middle-click handler carries over). On Windows the strip keeps room for the window buttons; on macOS it clears the traffic lights.
  - The sidebar becomes a rail one icon wide (`body.collapsed`, set by `syncRail()` without touching the saved side-mode choice). It opens to full width while a rail panel (history, downloads, vault, loadouts, packet trail) is showing, or on hover when hover-to-expand is on. The collapse button is hidden in this mode.
  - The vertical mouse wheel scrolls the strip sideways; the active tab is kept in view.
  - Test: `tests/ui-tabstop.test.js` (switching, using the top tabs, the rail panel, restart, switching back).
- YouTube radio: YouTube letterboxes a 16:9 video inside the 200×200 minimum box, leaving black bars above and below. `YT_FILL_CSS` is inserted into the embed on `dom-ready` so the video covers the box (the sides are trimmed slightly). `tests/ui-ytradio.test.js` now uses a letterboxed stand-in and checks the top and bottom edges are video, not black.
- App icon: cropped to the blue frame (squared up with plain rows inside the frame, transparent outside its rounded corners), so it fills the taskbar slot like other apps instead of sitting in a black square. Written to `icon.png`, `icon.ico`, `home/icon-512.png`, the start-page favicons, the AUR icon, and the Store's `Square44x44Logo` / `StoreLogo`. The Store package also gets `Square44x44Logo.targetsize-{16,24,32,48,256}` with `_altform-unplated` / `_altform-lightunplated` variants, which is what the Windows taskbar uses, so no coloured plate is drawn behind the icon.
- Windows taskbar: a popped-out video (Chromium's picture-in-picture window) showed as a second Null Grid button. Electron stamps its app ID only on the main window, and the PiP window got the process's ID, so Windows grouped them apart (on the Store build the PiP even joined the pinned tile while the main window didn't). `app.setAppUserModelId()` now sets one ID for the whole process: the package's `<family>!NODEGRID` when installed from the Store (worked out from the install folder name), otherwise `electron.app.Null Grid`, which is the ID Electron was already using on the main window, so existing pins keep working.

## 5.2.0: more than one window

- **How it's built.** Most of `main.js` is written against "the window": `win`, `tabs`, `activeId`, `viewport`, `overlays`, the Peek/AI/radio/PiP-dock views and the rest. Each window now has a record (`newCtx()`), and those variables always hold one window's state, `cur`. `use(ctx)` swaps them (`saveCur()` + `use()` list every per-window variable). Every way into the code switches to the right window first:
  - events from a window's pages and pop-overs: each webContents' `emit` is wrapped as it's created (`web-contents-created`), so its events, its window-open handler and its IPC messages run as the window that owns it (`ctxOfWc()` finds it among the window records, so a tab that moved to another window follows);
  - `ipcMain.on/handle` are wrapped the same way (by `e.sender`);
  - right-click menus: `popup()` wraps each click to run as the window the menu opened in;
  - each BrowserWindow's own `emit` is wrapped;
  - session callbacks (permission prompts, downloads) switch to the page's window by hand.
  - Work that carries on later (timers, `await`, `.then`) carries on in the window it started in: an `async_hooks` hook stamps every async resource with the current window at `init` and switches back to it in `before`.
- **Shared:** settings, favorites, history, logins, the Vault, loadouts, downloads (each window's list shows them all), burner groups, update state, developer mode. `pushState()` redraws every window (`pushStateHere()` for one), which also names each window after its active tab for the taskbar and Alt+Tab.
- **One of each:** the Settings tab and the SIM tab. Opening them from another window jumps to that tab's window (`showTab()`). The update bot appears in the window you used last.
- **New window:** Ctrl+N, the tab menu (**New window**, **Move to new window**, **Move to window ▸**) and a right-click on NEW TAB. A tab dragged out of the window (`dragend` with no drop target, outside the window) moves to a new window opened where it was let go. A tab dropped on another window's tab list or sidebar (`text/x-nullgrid-tab`) moves there. `moveTab()` moves the live WebContentsView, so the page keeps running. A window whose last tab leaves or closes closes itself while other windows stay; the only window still never goes empty.
- **Closing a window** closes its tabs, pop-overs, AI panel and radio, answers its pending permission prompts with no, wipes burner groups that no longer have a tab anywhere, and drops its pinned tabs from the pinned list (unless Null Grid is quitting).
- **Update restart:** `restoreWindows` holds every window's tabs (the first window first; it also gets the pinned tabs back). `restoreTabs` is still written for older versions.
- `state:refresh` lets a frame ask for its whole state again (used by the test that attaches to new windows).
- Test: `tests/ui-windows.test.js`: Ctrl+N, separate browsing, shared favorites, window titles, moving a tab out and back in (still the same page), one Settings tab, a window closing with its last tab or its X, and the update-restart restore.

## 5.2.0: NODE_GRID is now Null Grid

- **Everything you see is Null Grid:** window and taskbar titles, the sidebar, start page, Settings, pop-overs, error/warning pages, menus, Packet's update bot and walkthrough (re-rendered), Start menu / app list names (`productName`, Store `displayName`), README and docs. Credit lines say Null Labs. The browser's own pages are `nullgrid://home`, `nullgrid://settings`, `nullgrid://doom`. Test switches are `NULLGRID_*`. The Flatpak ID is `dev.nullgrid.nullgrid` (not on Flathub yet). Download names: `Null-Grid-<version>-x86_64.AppImage` / `-arm64.AppImage`, `Null-Grid-<version>-win32-x64.zip` (`.deb`/`.rpm`/`.tar.gz` keep `nullgrid-browser`). Websites see `NullGrid/<version>` in the user agent. The GitHub repo is `Null0Grid/null-grid` (GitHub redirects the old address, so older copies still find updates).
- **Carried over on update** (`main.js`, "renamed" section, runs before anything opens the data folder):
  - The old data folder (`<appData>/NODE_GRID`) moves into `<appData>/Null Grid`. Electron may already have made an empty new folder for its crash reporter, so the old folder is first renamed to `NODE_GRID.moving`; Windows refuses that while the old version still has it open, and then the old folder is used where it is until the next start. Its contents are then moved in one by one. A Flatpak copies from the old Flatpak's folder (`--filesystem=~/.var/app/dev.nullgrid.nodegrid:ro`, untested: Flatpak builds only in CI).
  - `Partitions/nodegrid-ai` and `nodegrid-sim` become `nullgrid-ai` / `nullgrid-sim` (AI panel sign-in, game saves). Loadouts saved with `nodegrid://` links are read as `nullgrid://`. The error-page game's best score is read from its old key.
  - **Linux keyring.** Electron files the key that encrypts saved logins, the Drive token and cookies (kept sign-ins, the AI panel) in the desktop keyring under the app's name (`application` attribute; checked against a real gnome-keyring: renaming made `safeStorage.decryptString` fail). A copy carried over from the old folder gets a `legacy-keyring` marker. With it, Null Grid calls `app.setName('NODE_GRID')` before `ready`, so the keyring entry it reads at startup is the old one, then `app.setName('Null Grid')` at `ready` (the key stays read for the whole run). Fresh installs never use the old name. Windows keeps its key in the data folder (DPAPI), which moves with it.
- **Two-step rename of the program file.** Copies older than 5.2.0 update themselves (portable `.zip`, Linux `.tar.gz`) only to a download that has a program file of the same name. So 5.2.0 still ships `NODE_GRID.exe` (`--executable-name=NODE_GRID`) and `node-grid` (with `node-grid.desktop`, `StartupWMClass=node-grid`, the AUR `/usr/bin/node-grid`, the Flatpak `command`). 5.2.0's updater (`self-update.js`) accepts a download with the next name (`Null Grid.exe` / `null-grid`), copies it in, deletes the old program file and starts the new one. Tested with real packaged Linux builds, a normal update and a renamed program file. **Next release:** rename those, and move the Linux default-browser registration from `node-grid.desktop` to `null-grid.desktop`.
- **Kept on purpose:** the Store's identity `NULLGRID.NullSearch` and its application id `NODEGRID` (part of the Store app's taskbar/Start identity). `window.nodegridDrive`, as an alias of `window.nullgridDrive`, because the Null Search site (another repo) still calls it. "NODE_GRID is now Null Grid" once in What's new, and "(Formerly NODE_GRID.)" in the README.
- Tests: `tests/rename.test.js` fails if the old name turns up anywhere except the places above. `tests/ui-rename.test.js` updates a NODE_GRID 5.1.x data folder (logins encrypted under the old name, an AI panel cookie), with `KEYRING=1` against a real desktop keyring, and checks a fresh install.
