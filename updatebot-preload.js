// The update bot (updatebot.html): asks what's new, and passes on the person's choice.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('updbot', {
  info:  ()   => ipcRenderer.invoke('updbot:info'),
  onInfo: (fn) => ipcRenderer.on('updbot-info', (_e, i) => fn(i)),
  get:   ()   => ipcRenderer.send('updbot:get'),
  restart: () => ipcRenderer.send('updbot:restart'),
  notes: ()   => ipcRenderer.send('updbot:notes'),
  later: ()   => ipcRenderer.send('updbot:later'),
  gone:  ()   => ipcRenderer.send('updbot:gone')
});
