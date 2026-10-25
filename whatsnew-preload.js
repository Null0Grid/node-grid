// Bridge for the What's new card (whatsnew.html): the notes for the versions
// you haven't seen yet, and closing it.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('whatsnew', {
  info:     ()  => ipcRenderer.invoke('whatsnew:info'),
  onEscape: (cb) => ipcRenderer.on('escape', () => cb()),
  close:    ()  => ipcRenderer.send('whatsnew:close'),
  tour:     ()  => ipcRenderer.send('whatsnew:tour')
});
