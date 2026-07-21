const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  selectFile: (filters) => ipcRenderer.invoke('select-file', filters),
  selectFiles: (filters) => ipcRenderer.invoke('select-files', filters),
  selectImageDirectory: () => ipcRenderer.invoke('select-image-directory'),
  persistLocalImage: (filePath) => ipcRenderer.invoke('persist-local-image', filePath),
  exportVideos: (payload) => ipcRenderer.invoke('export-videos', payload),
  downloadGeneratedMedia: (payload) => ipcRenderer.invoke('download-generated-media', payload),
  prepareImageDrag: (payload) => ipcRenderer.invoke('prepare-image-drag', payload),
  startImageDrag: (payload) => ipcRenderer.send('start-image-drag', payload),
  prepareVideoDrag: (payload) => ipcRenderer.invoke('prepare-video-drag', payload),
  startVideoDrag: (payload) => ipcRenderer.send('start-video-drag', payload),
  onImageDragError: (callback) => {
    const listener = (_event, message) => callback?.(message);
    ipcRenderer.on('image-drag-error', listener);
    return () => ipcRenderer.removeListener('image-drag-error', listener);
  },
  onVideoDragError: (callback) => {
    const listener = (_event, message) => callback?.(message);
    ipcRenderer.on('video-drag-error', listener);
    return () => ipcRenderer.removeListener('video-drag-error', listener);
  },
  openWizstarBrowser: (accountId) => ipcRenderer.invoke('open-wizstar-browser', accountId),
  wizstarGoogleLogin: (mailboxId) => ipcRenderer.invoke('wizstar-google-login', mailboxId),
  wizstarBatchLogin: (payload) => ipcRenderer.invoke('wizstar-batch-login', payload),
  onWizstarLoginProgress: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on('wizstar-login-progress', listener);
    return () => ipcRenderer.removeListener('wizstar-login-progress', listener);
  },
  onWizstarBatchProgress: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on('wizstar-batch-progress', listener);
    return () => ipcRenderer.removeListener('wizstar-batch-progress', listener);
  },
  saveMergedImage: (payload) => ipcRenderer.invoke('save-merged-image', payload),
  showItemInFolder: (filePath) => ipcRenderer.invoke('show-item-in-folder', filePath),
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  maximizeWindow: () => ipcRenderer.send('maximize-window'),
  closeWindow: () => ipcRenderer.send('close-window'),
  wizstarServerStatus: () => ipcRenderer.invoke('wizstar-server-status'),
  oreateaiRegisterLogin: (payload) => ipcRenderer.invoke('oreateai-register-login', payload),
  oreateaiOpenCapture: (accountId) => ipcRenderer.invoke('oreateai-open-capture', accountId),
  oreateaiVideoCapabilities: (payload) => ipcRenderer.invoke('oreateai-video-capabilities', payload),
  oreateaiSelectAssets: (payload) => ipcRenderer.invoke('oreateai-select-assets', payload),
  oreateaiGenerateVideo: (payload) => ipcRenderer.invoke('oreateai-generate-video', payload),
  oreateaiDownloadVideo: (payload) => ipcRenderer.invoke('oreateai-download-video', payload),
  onOreateaiVideoProgress: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on('oreateai-video-progress', listener);
    return () => ipcRenderer.removeListener('oreateai-video-progress', listener);
  },
  onOreateaiCaptureProgress: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on('oreateai-capture-progress', listener);
    return () => ipcRenderer.removeListener('oreateai-capture-progress', listener);
  },
  onOreateaiLoginProgress: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on('oreateai-login-progress', listener);
    return () => ipcRenderer.removeListener('oreateai-login-progress', listener);
  },
  lovartGoogleLogin: (payload) => ipcRenderer.invoke('lovart-google-login', payload),
  lovartBatchLogin: (payload) => ipcRenderer.invoke('lovart-batch-login', payload),
  dolaGoogleLogin: (payload) => ipcRenderer.invoke('dola-google-login', payload),
  dolaBatchLogin: (payload) => ipcRenderer.invoke('dola-batch-login', payload),
  onLovartLoginProgress: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on('lovart-login-progress', listener);
    return () => ipcRenderer.removeListener('lovart-login-progress', listener);
  },
  onLovartBatchProgress: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on('lovart-batch-progress', listener);
    return () => ipcRenderer.removeListener('lovart-batch-progress', listener);
  },
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
