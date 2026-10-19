// The little settings gear in the bottom-right corner (gear.html): one job, open Settings.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('gear', { open: () => ipcRenderer.send('gear:open') });
