// The tiny restore/close bar drawn over a video docked into the sidebar (pipdock.html).
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pipdock', {
  restore: () => ipcRenderer.send('pipdock:restore'),
  close: () => ipcRenderer.send('pipdock:close'),
});
