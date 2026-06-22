const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { fileURLToPath } = require('url');
const fs = require('fs');
const http = require('http');
const https = require('https');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 720,
    titleBarStyle: 'hidden', // Frameless window for custom modern titlebar
    titleBarOverlay: {
      color: '#111113',
      symbolColor: '#f3f4f6',
      height: 40
    },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    backgroundColor: '#111113',
  });

  // In development, load from Vite server. In production, load the built index.html.
  const isDev = !app.isPackaged;
  if (isDev) {
    mainWindow.loadURL('http://localhost:5174');
    // Open the DevTools.
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC handlers for UI interactions
ipcMain.handle('select-directory', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (result.canceled) {
    return null;
  } else {
    return result.filePaths[0];
  }
});

ipcMain.handle('select-file', async (event, filters) => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: filters || []
  });
  if (result.canceled) {
    return null;
  } else {
    return result.filePaths[0];
  }
});

ipcMain.handle('select-files', async (event, filters) => {
  if (!mainWindow) return [];
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: filters || []
  });
  return result.canceled ? [] : result.filePaths;
});

function collectImageFilesFromDirectory(dirPath) {
  const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']);
  const output = [];
  const walk = (currentDir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    entries.forEach((entry) => {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile() && imageExtensions.has(path.extname(entry.name).toLowerCase())) output.push(fullPath);
    });
  };
  walk(dirPath);
  return output.sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
}

ipcMain.handle('select-image-directory', async () => {
  if (!mainWindow) return { canceled: true, filePaths: [] };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择图片文件夹',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true, filePaths: [] };
  const targetDir = result.filePaths[0];
  return { canceled: false, targetDir, filePaths: collectImageFilesFromDirectory(targetDir) };
});

function safeExportName(value, fallback) {
  const base = String(value || '').trim() || String(fallback || '').trim() || '未命名';
  return base
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 120) || '未命名';
}

function filePathFromMaybeFileUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^file:\/\//i.test(raw)) {
    try {
      return fileURLToPath(raw);
    } catch {
      try {
        return decodeURIComponent(new URL(raw).pathname);
      } catch {
        return raw.replace(/^file:\/\/+/, '/');
      }
    }
  }
  return raw;
}

function downloadToFile(url, destPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) { reject(new Error('too many redirects')); return; }
        const next = new URL(res.headers.location, url).toString();
        resolve(downloadToFile(next, destPath, redirectsLeft - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(destPath)));
      file.on('error', (err) => { fs.unlink(destPath, () => reject(err)); });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('download timeout')); });
  });
}

ipcMain.handle('export-videos', async (_event, payload) => {
  if (!mainWindow) return { ok: false, error: 'no window' };
  const { items = [], targetDir: presetDir } = payload || {};
  if (!items.length) return { ok: false, error: 'no items' };

  let targetDir = presetDir;
  if (!targetDir) {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择导出目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    targetDir = result.filePaths[0];
  }

  const results = [];
  const usedFileNames = new Set();
  for (const item of items) {
    const ext = (item.ext || 'mp4').replace(/^\./, '');
    const rawBaseName = safeExportName(item.name, item.index);
    let fileName = `${rawBaseName}.${ext}`;
    let suffix = 2;
    while (usedFileNames.has(fileName.toLowerCase()) || fs.existsSync(path.join(targetDir, fileName))) {
      fileName = `${rawBaseName}-${suffix++}.${ext}`;
    }
    usedFileNames.add(fileName.toLowerCase());
    const destPath = path.join(targetDir, fileName);
    try {
      const localPath = filePathFromMaybeFileUrl(item.localPath || '');
      if (localPath && fs.existsSync(localPath)) {
        fs.copyFileSync(localPath, destPath);
      } else if (item.url) {
        await downloadToFile(item.url, destPath);
      } else {
        throw new Error('没有可导出的本地文件或远程地址');
      }
      results.push({ index: item.index, name: rawBaseName, ok: true, path: destPath });
    } catch (e) {
      results.push({ index: item.index, name: rawBaseName, ok: false, error: e.message || String(e) });
    }
  }

  const okCount = results.filter(r => r.ok).length;
  return { ok: okCount > 0, targetDir, total: items.length, okCount, results };
});

ipcMain.handle('download-generated-media', async (_event, payload = {}) => {
  try {
    const { url, defaultName = 'generated', ext } = payload || {};
    if (!url || !/^https?:\/\//i.test(String(url))) return { ok: false, error: '没有可下载的远程地址' };
    const urlPath = (() => {
      try { return new URL(url).pathname || ''; } catch { return ''; }
    })();
    const inferredExt = String(ext || path.extname(urlPath).replace(/^\./, '') || (url.includes('image') ? 'png' : 'mp4')).toLowerCase();
    const safeExt = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm', 'mov', 'm4v'].includes(inferredExt) ? inferredExt : 'png';
    const targetDir = path.join(app.getPath('userData'), 'generated-media');
    fs.mkdirSync(targetDir, { recursive: true });
    const baseName = safeExportName(defaultName, `generated_${Date.now()}`);
    let fileName = `${baseName}.${safeExt}`;
    let suffix = 2;
    while (fs.existsSync(path.join(targetDir, fileName))) fileName = `${baseName}-${suffix++}.${safeExt}`;
    const filePath = path.join(targetDir, fileName);
    await downloadToFile(url, filePath);
    return { ok: true, filePath };
  } catch (e) {
    console.error('[download-generated-media] failed:', e);
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('save-merged-image', async (_event, payload = {}) => {
  try {
    const { bytes, ext = 'png', defaultDir, defaultName, silent = false } = payload || {};
    if (!bytes) return { ok: false, error: '没有可保存的数据' };
    const buffer = Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
    const cleanExt = String(ext || 'png').replace(/^\./, '').toLowerCase();
    const finalExt = ['png', 'jpg', 'jpeg'].includes(cleanExt) ? (cleanExt === 'jpeg' ? 'jpg' : cleanExt) : 'png';
    const baseName = safeExportName(String(defaultName || '').replace(/\.(png|jpe?g)$/i, ''), `merge_${Date.now()}`);
    const fallbackDir = path.join(app.getPath('temp'), 'uijiem-merged');
    const targetDirCandidate = defaultDir && String(defaultDir).trim() ? String(defaultDir) : fallbackDir;

    let targetPath;
    if (silent) {
      try { fs.mkdirSync(targetDirCandidate, { recursive: true }); } catch (_) { fs.mkdirSync(fallbackDir, { recursive: true }); }
      const dirToUse = fs.existsSync(targetDirCandidate) ? targetDirCandidate : fallbackDir;
      let fileName = `${baseName}.${finalExt}`;
      let suffix = 2;
      while (fs.existsSync(path.join(dirToUse, fileName))) fileName = `${baseName}-${suffix++}.${finalExt}`;
      targetPath = path.join(dirToUse, fileName);
    } else {
      try { fs.mkdirSync(targetDirCandidate, { recursive: true }); } catch (_) {}
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '保存合并图片',
        defaultPath: path.join(targetDirCandidate, `${baseName}.${finalExt}`),
        filters: finalExt === 'jpg'
          ? [{ name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] }, { name: 'PNG 图片', extensions: ['png'] }]
          : [{ name: 'PNG 图片', extensions: ['png'] }, { name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, canceled: true };
      targetPath = result.filePath;
    }

    fs.writeFileSync(targetPath, buffer);
    return { ok: true, filePath: targetPath };
  } catch (e) {
    console.error('[save-merged-image] failed:', e);
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('show-item-in-folder', async (_event, filePath) => {
  try {
    if (!filePath) return { ok: false, error: 'no path' };
    shell.showItemInFolder(filePath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

// Mocking some system commands for batch video actions
ipcMain.on('minimize-window', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('maximize-window', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('close-window', () => {
  if (mainWindow) mainWindow.close();
});
