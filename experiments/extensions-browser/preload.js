const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('extensionLab', {
  navigate: (address) => ipcRenderer.send('lab:navigate', address),
  showExtension: (name) => ipcRenderer.send('lab:show-extension', name),
  hidePopup: () => ipcRenderer.send('lab:hide-popup'),
  onState: (callback) => ipcRenderer.on('lab:state', (_event, value) => callback(value))
})
