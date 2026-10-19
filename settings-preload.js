// Bridge for NODE_GRID's own settings page (settings.html). Only that page gets it.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:' && /\/settings\.html$/.test(location.pathname)) {
  contextBridge.exposeInMainWorld('ngSettings', {
    get: ()              => ipcRenderer.invoke('settings:get'),
    do:  (action, a, b)  => ipcRenderer.invoke('settings:do', action, a, b),
    feature: (key, on)   => ipcRenderer.invoke('settings:feature', key, !!on),
    onRefresh: (fn)      => ipcRenderer.on('settings-refresh', () => fn())
  });
}
