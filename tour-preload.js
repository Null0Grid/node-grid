// Bridge for Packet's walkthrough (tour.html): only closing it.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('tour', {
  onEscape: (cb) => ipcRenderer.on('escape', () => cb()),
  close:    ()  => ipcRenderer.send('tour:close')
});
