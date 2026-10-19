// Bridge for the floating Peek window's frame (peek.html). The previewed site itself
// gets nothing: it runs in a separate view with JavaScript switched off.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('peek', {
  layout:   (r) => ipcRenderer.send('peek:layout', r),
  close:    ()  => ipcRenderer.send('peek:close'),
  openReal: ()  => ipcRenderer.send('peek:open-real'),
  source:   ()  => ipcRenderer.send('peek:source'),
  onState:  (cb) => ipcRenderer.on('peek-state', (_e, s) => cb(s))
});
