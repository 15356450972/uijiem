const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  selectFile: (filters) => ipcRenderer.invoke('select-file', filters),
  selectFiles: (filters) => ipcRenderer.invoke('select-files', filters),
  selectImageDirectory: () => ipcRenderer.invoke('select-image-directory'),
  exportVideos: (payload) => ipcRenderer.invoke('export-videos', payload),
  downloadGeneratedMedia: (payload) => ipcRenderer.invoke('download-generated-media', payload),
  prepareImageDrag: (payload) => ipcRenderer.invoke('prepare-image-drag', payload),
  startImageDrag: (payload) => ipcRenderer.send('start-image-drag', payload),
  onImageDragError: (callback) => {
    const listener = (_event, message) => callback?.(message);
    ipcRenderer.on('image-drag-error', listener);
    return () => ipcRenderer.removeListener('image-drag-error', listener);
  },
  openWizstarBrowser: (accountId) => ipcRenderer.invoke('open-wizstar-browser', accountId),
  saveMergedImage: (payload) => ipcRenderer.invoke('save-merged-image', payload),
  showItemInFolder: (filePath) => ipcRenderer.invoke('show-item-in-folder', filePath),
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  maximizeWindow: () => ipcRenderer.send('maximize-window'),
  closeWindow: () => ipcRenderer.send('close-window'),
  wizstarServerStatus: () => ipcRenderer.invoke('wizstar-server-status'),
  dolaGoogleLogin: (payload) => ipcRenderer.invoke('dola-google-login', payload),
  dolaBatchLogin: (payload) => ipcRenderer.invoke('dola-batch-login', payload),
  onDolaLoginProgress: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on('dola-login-progress', listener);
    return () => ipcRenderer.removeListener('dola-login-progress', listener);
  },
  onDolaBatchProgress: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on('dola-batch-progress', listener);
    return () => ipcRenderer.removeListener('dola-batch-progress', listener);
  },
  platform: process.platform
});
