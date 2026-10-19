// Bridge for the "send to phone" QR pop-up (qr.html).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qr', {
  onShow:   (cb) => ipcRenderer.on('qr-show', (_e, d) => cb(d)),
  onEscape: (cb) => ipcRenderer.on('escape', () => cb()),
  close:    ()   => ipcRenderer.send('qr:close'),
  copy:     (t)  => ipcRenderer.send('qr:copy', t)
});
