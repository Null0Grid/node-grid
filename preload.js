// Narrow bridge between the shell UI and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shell', {
  newTab:      ()   => ipcRenderer.send('tab:new'),
  closeTab:    (id) => ipcRenderer.send('tab:close', id),
  activate:    (id) => ipcRenderer.send('tab:activate', id),
  tabMenu:     (id) => ipcRenderer.send('tab:menu', id),
  back:        ()   => ipcRenderer.send('nav:back'),
  reload:      ()   => ipcRenderer.send('nav:reload'),
  home:        ()   => ipcRenderer.send('nav:home'),
  setViewport: (r)  => ipcRenderer.send('viewport', r),
  onState:          (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onToggleSidebar:  (cb) => ipcRenderer.on('toggle-sidebar', () => cb()),
  onPageHover:      (cb) => ipcRenderer.on('page-hover', () => cb()),
  // favorites
  toggleFav:   ()          => ipcRenderer.send('fav:toggle'),
  openFav:     (id, nt)    => ipcRenderer.send('fav:open', id, nt),
  favMenu:     (id)        => ipcRenderer.send('fav:menu', id),
  renameFav:   (id, title) => ipcRenderer.send('fav:rename', id, title),
  moveFav:     (id, to)    => ipcRenderer.send('fav:move', id, to),
  favOverflow: (ids)       => ipcRenderer.send('fav:overflow', ids),
  onFavRename:      (cb) => ipcRenderer.on('fav-rename', (_e, id) => cb(id)),
  onToggleFavbar:   (cb) => ipcRenderer.on('toggle-favbar', () => cb()),
  // history (hostnames only)
  openHist:    (host, nt) => ipcRenderer.send('hist:open', host, nt),
  removeHist:  (host)     => ipcRenderer.send('hist:remove', host),
  clearHist:   ()         => ipcRenderer.send('hist:clear'),
  onToggleHistory:  (cb) => ipcRenderer.on('toggle-history', () => cb()),
  onCorrupt:        (cb) => ipcRenderer.on('egg-corrupt', (_e, on) => cb(on)),
  // address bar
  go:          (text) => ipcRenderer.send('nav:go', text),
  onFocusAddress:   (cb) => ipcRenderer.on('focus-address', () => cb()),
  // find in page
  find:        (text, forward, findNext) => ipcRenderer.send('find:go', text, forward, findNext),
  stopFind:    ()   => ipcRenderer.send('find:stop'),
  onFindOpen:       (cb) => ipcRenderer.on('find-open', () => cb()),
  onFindResult:     (cb) => ipcRenderer.on('find-result', (_e, r) => cb(r)),
  // downloads (kept in memory only)
  dlOpen:      (id) => ipcRenderer.send('dl:open', id),
  dlShow:      (id) => ipcRenderer.send('dl:show', id),
  dlCancel:    (id) => ipcRenderer.send('dl:cancel', id),
  dlRemove:    (id) => ipcRenderer.send('dl:remove', id),
  dlClear:     ()   => ipcRenderer.send('dl:clear'),
  onDownloads:      (cb) => ipcRenderer.on('downloads', (_e, list) => cb(list)),
  onDownloadStarted:(cb) => ipcRenderer.on('download-started', (_e, d) => cb(d)),
  onDownloadDone:   (cb) => ipcRenderer.on('download-done', (_e, d) => cb(d)),
  onToggleDownloads:(cb) => ipcRenderer.on('toggle-downloads', () => cb()),
  // logins + ad blocking
  toggleVault: (rect) => ipcRenderer.send('vault:toggle', rect),
  openSim:     ()   => ipcRenderer.send('sim:open'),
  openSettings:()   => ipcRenderer.send('settings:open'),
  toggleReader:()   => ipcRenderer.send('reader:toggle'),
  togglePip:   ()   => ipcRenderer.send('pip:toggle'),
  openQr:      ()   => ipcRenderer.send('qr:open'),
  setDevMode:  (on) => ipcRenderer.send('dev:mode', !!on),
  // packet trail
  trailWatch:  (on) => ipcRenderer.send('trail:watch', !!on),
  onTrailOpen:      (cb) => ipcRenderer.on('trail-open', () => cb()),
  onTrail:          (cb) => ipcRenderer.on('trail', (_e, d) => cb(d)),
  // vault (saved pages, this PC only)
  saveVault:   ()        => ipcRenderer.send('saved:save'),
  savedOpen:   (id, nt)  => ipcRenderer.send('saved:open', id, !!nt),
  savedOffline:(id)      => ipcRenderer.send('saved:offline', id),
  savedMd:     (id)      => ipcRenderer.send('saved:md', id),
  savedRemove: (id)      => ipcRenderer.send('saved:remove', id),
  // loadouts
  loadoutSave:   (name)     => ipcRenderer.send('loadout:save', name),
  loadoutDeploy: (id, swap) => ipcRenderer.send('loadout:deploy', id, !!swap),
  loadoutRemove: (id)       => ipcRenderer.send('loadout:remove', id),
  // burner tabs
  openBurner:  ()   => ipcRenderer.send('burner:open'),
  burnerMenu:  ()   => ipcRenderer.send('burner:menu'),
  onToast:          (cb) => ipcRenderer.on('toast', (_e, t) => cb(t)),
  // AI side panel
  aiBounds:    (r)  => ipcRenderer.send('ai:bounds', r),
  // music player
  mediaCmd:    (c)  => ipcRenderer.send('media:cmd', c),
  ytCmd:       (c, a) => ipcRenderer.send('yt:cmd', c, a),
  radioCandidates: (st) => ipcRenderer.invoke('radio:candidates', st),
  radioHealth:     (list) => ipcRenderer.invoke('radio:health', list),
  onYtState:        (cb) => ipcRenderer.on('yt-state', (_e, s) => cb(s)),
  onMediaStarted:   (cb) => ipcRenderer.on('media-started', () => cb()),
  aiProvider:  (p)  => ipcRenderer.send('ai:provider', p),
  aiCustom:    (u)  => ipcRenderer.send('ai:custom', u),
  aiAction:    (a)  => ipcRenderer.send('ai:action', a),
  onAiToggle:       (cb) => ipcRenderer.on('ai-toggle', () => cb()),
  translate:   ()   => ipcRenderer.send('translate:go'),
  toggleDark:  ()   => ipcRenderer.send('dark:toggle'),
  darkMenu:    ()   => ipcRenderer.send('dark:menu'),
  translateMenu: () => ipcRenderer.send('translate:menu'),
  toggleAdblockSite: () => ipcRenderer.send('adblock:toggle-site'),
  platform: process.platform
});
