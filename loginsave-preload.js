// Bridge for the "save this login?" prompt (loginsave.html). It sees the site and
// username only; the password stays in the main process.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('loginsave', {
  info:     ()             => ipcRenderer.invoke('loginsave:info'),
  onInfo:   (cb)           => ipcRenderer.on('loginsave-info', (_e, i) => cb(i)),
  onEscape: (cb)           => ipcRenderer.on('escape', () => cb()),
  choose:   (choice, keep) => ipcRenderer.invoke('loginsave:choose', choice, !!keep)
});
