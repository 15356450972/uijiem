const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  selectFile: (filters) => ipcRenderer.invoke('select-file', filters),
  selectFiles: (filters) => ipcRenderer.invoke('select-files', filters),
  selectImageDirectory: () => ipcRenderer.invoke('select-image-directory'),
  exportVideos: (payload) => ipcRenderer.invoke('export-videos', payload),
  downloadGeneratedMedia: (payload) => ipcRenderer.invoke('download-generated-media', payload),
  saveMergedImage: (payload) => ipcRenderer.invoke('save-merged-image', payload),
  showItemInFolder: (filePath) => ipcRenderer.invoke('show-item-in-folder', filePath),
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  maximizeWindow: () => ipcRenderer.send('maximize-window'),
  closeWindow: () => ipcRenderer.send('close-window'),
  platform: process.platform
});
