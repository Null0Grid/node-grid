// Bridge for the permission prompt (perm.html). It can only show a question and answer it.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('perm', {
  onShow:   (cb) => ipcRenderer.on('perm-show', (_e, p) => cb(p)),
  onEscape: (cb) => ipcRenderer.on('escape', () => cb()),
  answer:   (allow, remember) => ipcRenderer.send('perm:answer', !!allow, !!remember)
});
