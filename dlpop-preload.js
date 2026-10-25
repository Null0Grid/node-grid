// Bridge for the downloads pop-over (dlpop.html), opened from the toolbar's
// download button. Only file names, sizes and states come through.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('dlpop', {
  onList:   (cb) => ipcRenderer.on('dlpop-list', (_e, l) => cb(l)),
  onEscape: (cb) => ipcRenderer.on('escape', () => cb()),
  ready:    ()   => ipcRenderer.send('dlpop:ready'),
  focus:    ()   => ipcRenderer.send('dlpop:focus'),
  open:     (id) => ipcRenderer.send('dlpop:open', id),
  show:     (id) => ipcRenderer.send('dlpop:show', id),
  cancel:   (id) => ipcRenderer.send('dlpop:cancel', id),
  remove:   (id) => ipcRenderer.send('dlpop:remove', id),
  clear:    ()   => ipcRenderer.send('dlpop:clear'),
  folder:   ()   => ipcRenderer.send('dlpop:folder'),
  close:    (blur) => ipcRenderer.send('dlpop:close', !!blur)
});
