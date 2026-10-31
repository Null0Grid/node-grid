// Runs in the AI side panel. It only does something on Null Grid's own built-in
// local chat page (local-ai.html); websites like claude.ai or chatgpt.com get nothing.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:' && /\/local-ai\.html$/.test(location.pathname)) {
  contextBridge.exposeInMainWorld('localAI', {
    detect:  (url)       => ipcRenderer.invoke('localai:detect', url || ''),
    setKey:  (key)       => ipcRenderer.invoke('localai:setkey', key || ''),
    hasKey:  ()          => ipcRenderer.invoke('localai:haskey'),
    page:    ()          => ipcRenderer.invoke('localai:page'),
    chat:    (id, req)   => ipcRenderer.send('localai:chat', id, req),
    stop:    (id)        => ipcRenderer.send('localai:stop', id),
    onChunk: (cb) => ipcRenderer.on('localai-chunk', (_e, id, text) => cb(id, text)),
    onDone:  (cb) => ipcRenderer.on('localai-done', (_e, id, err) => cb(id, err))
  });
}
