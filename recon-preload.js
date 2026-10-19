// Bridge for the Recon popup (recon.html): receives lookup results, can close or copy.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('recon', {
  onPart:   (cb) => ipcRenderer.on('recon-part', (_e, key, data) => cb(key, data)),
  onEscape: (cb) => ipcRenderer.on('escape', () => cb()),
  close:    ()   => ipcRenderer.send('recon:close'),
  copy:     (t)  => ipcRenderer.send('recon:copy', t)
});
