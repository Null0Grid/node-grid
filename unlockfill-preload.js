// Bridge for the "unlock to fill" PIN box (unlockfill.html). It sends the PIN to
// the main process, which unlocks your logins and fills the page; no password
// ever comes back here.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('unlockfill', {
  info:     ()    => ipcRenderer.invoke('unlockfill:info'),
  onInfo:   (cb)  => ipcRenderer.on('unlockfill-info', (_e, i) => cb(i)),
  onEscape: (cb)  => ipcRenderer.on('escape', () => cb()),
  unlock:   (pin) => ipcRenderer.invoke('unlockfill:try', String(pin)),
  close:    ()    => ipcRenderer.send('unlockfill:close')
});
