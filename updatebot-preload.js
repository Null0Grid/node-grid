// The update bot (updatebot.html): asks what's new, and passes on the person's choice.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('updbot', {
  info:  ()   => ipcRenderer.invoke('updbot:info'),
  onInfo: (fn) => ipcRenderer.on('updbot-info', (_e, i) => fn(i)),
  get:   ()   => ipcRenderer.send('updbot:get'),
  notes: ()   => ipcRenderer.send('updbot:notes'),
  later: ()   => ipcRenderer.send('updbot:later'),
  gone:  ()   => ipcRenderer.send('updbot:gone')
});
