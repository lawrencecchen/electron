const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('demo', {
  navigate: (address) => ipcRenderer.send('navigate', address),
  back: () => ipcRenderer.send('navigate-back'),
  forward: () => ipcRenderer.send('navigate-forward'),
  reload: () => ipcRenderer.send('reload'),
  toggleOverlay: () => ipcRenderer.send('toggle-overlay'),
  dismissOverlay: () => ipcRenderer.send('dismiss-overlay'),
  onBrowserState: (callback) => ipcRenderer.on('browser-state', (_event, value) => callback(value)),
  onOverlayState: (callback) => ipcRenderer.on('overlay-state', (_event, value) => callback(value)),
  onFocusAddress: (callback) => ipcRenderer.on('focus-address', callback)
})
