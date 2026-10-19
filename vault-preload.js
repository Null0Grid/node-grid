// Bridge for the key popover (vault.html). Passwords are filled and copied by the
// main process; this side only sees hosts and usernames (and a password only when
// the user clicks the eye to reveal it while editing).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vault', {
  onState:  (cb) => ipcRenderer.on('vault-state', (_e, s) => cb(s)),
  onEscape: (cb) => ipcRenderer.on('escape', () => cb()),
  close:    ()               => ipcRenderer.send('vault:close'),
  fill:     (id, force)      => ipcRenderer.invoke('vault:fill', id, !!force),
  copy:     (id, what)       => ipcRenderer.invoke('vault:copy', id, what),
  save:     (entry)          => ipcRenderer.invoke('vault:save', entry),
  remove:   (id)             => ipcRenderer.invoke('vault:delete', id),
  reveal:   (id)             => ipcRenderer.invoke('vault:reveal', id),
  grab:     ()               => ipcRenderer.invoke('vault:grab'),
  unlock:   (pin)            => ipcRenderer.invoke('vault:unlock', String(pin)),
  setPin:   (oldPin, newPin) => ipcRenderer.invoke('vault:setpin', String(oldPin || ''), String(newPin)),
  forgot:   ()               => ipcRenderer.invoke('vault:forgot'),
  lock:     ()               => ipcRenderer.send('vault:lock')
});
