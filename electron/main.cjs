const { app, BrowserWindow, ipcMain, dialog, session, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const { fileURLToPath } = require('url');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const http = require('http');
const https = require('https');

if (!app.isPackaged) {
  const devUserDataDir = path.join(__dirname, '..', '.electron-dev-user-data');
  app.setPath('userData', devUserDataDir);
}
if (process.env.UIJIEM_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
} else {
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
  app.commandLine.appendSwitch('enable-accelerated-video-decode');
  app.commandLine.appendSwitch('enable-features', [
    'PlatformHEVCDecoderSupport',
    'UseVideoToolboxForVideoDecoding',
  ].join(','));
}
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const WIZSTAR_PORT = 18765;
const WIZSTAR_BASE_URL = `http://127.0.0.1:${WIZSTAR_PORT}`;

// Download a remote URL to a local file path, following redirects.
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

async function fetchJson(url) {
  return await new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          if (res.statusCode >= 400) {
            const detail = parsed.detail || parsed.message || `HTTP ${res.statusCode}`;
            reject(new Error(detail));
            return;
          }
          resolve(parsed);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('request timeout'));
    });
  });
}

async function probeWizstarServer() {
  try {
    const health = await fetchJson(`${WIZSTAR_BASE_URL}/health`);
    try {
      await fetchJson(`${WIZSTAR_BASE_URL}/pixmax/config`);
      await fetchJson(`${WIZSTAR_BASE_URL}/dola/config`);
      return { running: true, compatible: true, health };
    } catch (e) {
      return { running: true, compatible: false, health, error: e.message || String(e) };
    }
  } catch (e) {
    return { running: false, compatible: false, error: e.message || String(e) };
  }
}

async function killProcessOnPort(port) {
  if (process.platform !== 'win32') {
    return await new Promise((resolve) => {
      execFile('lsof', ['-ti', `tcp:${port}`], (listError, stdout) => {
        if (listError || !stdout.trim()) {
          resolve(false);
          return;
        }
        const pids = stdout.split(/\s+/).map((pid) => Number(pid)).filter(Boolean).filter((pid) => pid !== process.pid);
        if (pids.length === 0) {
          resolve(false);
          return;
        }
        let remaining = pids.length;
        let killed = false;
        pids.forEach((pid) => {
          execFile('kill', ['-TERM', String(pid)], (killError) => {
            if (!killError) killed = true;
            remaining -= 1;
            if (remaining === 0) resolve(killed);
          });
        });
      });
    });
  }

  return await new Promise((resolve) => {
    execFile('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `$owners = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; foreach ($owner in $owners) { if ($owner -and $owner -ne $PID) { Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue } }`,
    ], { windowsHide: true }, (error) => {
      if (error) {
        console.error(`[wizstar] failed to clear port ${port}: ${error.message}`);
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setWizstarCookie(targetSession, name, value) {
  if (!value) return;
  await targetSession.cookies.set({
    url: 'https://wizstar.com',
    name,
    value: String(value),
    domain: '.wizstar.com',
    path: '/',
    secure: true,
    httpOnly: false,
    sameSite: 'no_restriction',
    expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
  });
}

async function openWizstarAccountWindow(accountId) {
  const result = await fetchJson(`${WIZSTAR_BASE_URL}/accounts/${accountId}`);
  const account = result.data;
  if (!account) throw new Error('account not found');

  const partition = `persist:wizstar-account-${accountId}`;
  const accountSession = session.fromPartition(partition);

  await setWizstarCookie(accountSession, 'osduss', account.osduss);
  await setWizstarCookie(accountSession, 'passOsRefreshTk', account.pass_os_refresh_tk);
  await setWizstarCookie(accountSession, 'uid', account.uid);

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    title: `Wizstar - ${account.email}`,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition,
    },
    backgroundColor: '#111113',
  });

  await win.loadURL('https://wizstar.com/tools/generate_video');
  return { ok: true };
}

let mainWindow;
let pythonProcess = null;

async function startPythonServer() {
  const serverProbe = await probeWizstarServer();

  if (serverProbe.compatible) {
    console.log(`[wizstar] compatible server already running on port ${WIZSTAR_PORT}, skipping spawn`);
    return;
  }

  if (serverProbe.running) {
    console.warn(`[wizstar] incompatible server found on port ${WIZSTAR_PORT} (${serverProbe.error || 'missing pixmax API'}), replacing it`);
    const cleared = await killProcessOnPort(WIZSTAR_PORT);
    if (cleared) {
      await sleep(800);
    }
  }

  // Production: launch the bundled, self-contained backend exe (no system Python needed).
  // Dev: fall back to `python -m wizstar.wizstar serve` from the repo.
  const getOiiOiiEnv = () => {
    const sdkDir = app.isPackaged
      ? path.join(process.resourcesPath, 'oiioii-sdk')
      : path.join(__dirname, '..', 'oiioii-sdk');
    const dolaDir = app.isPackaged
      ? path.join(process.resourcesPath, 'dola-video-standalone')
      : path.join(__dirname, '..', 'dola-video-standalone');
    const devDataDir = path.join(__dirname, '..', '_wizstar_data_test');

    const env = {
      ...process.env,
      WIZSTAR_PORT: String(WIZSTAR_PORT),
      OIIOII_SDK_DIR: sdkDir,
      DOLA_STANDALONE_DIR: dolaDir,
      WIZSTAR_HOME: app.isPackaged ? process.env.WIZSTAR_HOME : devDataDir,
    };

    if (app.isPackaged) {
      env.OIIOII_NODE_BIN = process.execPath;
      env.DOLA_NODE_BIN = process.execPath;
      env.ELECTRON_RUN_AS_NODE = '1';
    }

    return env;
  };

  if (app.isPackaged) {
    const exePath = path.join(process.resourcesPath, 'backend', 'wizstar-server', 'wizstar-server.exe');
    if (!fs.existsSync(exePath)) {
      console.error(`[wizstar] bundled backend not found at ${exePath}`);
      return;
    }
    pythonProcess = spawn(exePath, [], {
      cwd: path.dirname(exePath),
      env: getOiiOiiEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
  } else {
    const pythonBin = process.env.PYTHON || 'python3';
    pythonProcess = spawn(pythonBin, ['-m', 'wizstar.wizstar', 'serve', '--port', String(WIZSTAR_PORT)], {
      cwd: path.join(__dirname, '..'),
      env: getOiiOiiEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
  }

  pythonProcess.stdout.on('data', (data) => {
    console.log(`[wizstar] ${data.toString().trim()}`);
  });

  pythonProcess.stderr.on('data', (data) => {
    console.error(`[wizstar] ${data.toString().trim()}`);
  });

  pythonProcess.on('close', (code) => {
    console.log(`[wizstar] process exited with code ${code}`);
    pythonProcess = null;
  });

  pythonProcess.on('error', (err) => {
    console.error(`[wizstar] failed to start: ${err.message}`);
    pythonProcess = null;
  });
}

function stopPythonServer() {
  if (pythonProcess) {
    pythonProcess.kill();
    pythonProcess = null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 720,
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      webSecurity: false,
      backgroundThrottling: false,
    },
    backgroundColor: '#111113',
  });

  Menu.setApplicationMenu(null);

  const revealMainWindow = () => {
    if (!mainWindow) return;
    app.focus({ steal: true });
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.moveTop();
    mainWindow.focus();
    mainWindow.setAlwaysOnTop(true);
    setTimeout(() => {
      if (!mainWindow) return;
      mainWindow.setAlwaysOnTop(false);
      mainWindow.focus();
    }, 300);
  };

  mainWindow.once('ready-to-show', revealMainWindow);

  // In development, load from Vite server. In production, load the built index.html.
  const isDev = !app.isPackaged;
  if (isDev) {
    mainWindow.loadURL('http://localhost:5174').then(revealMainWindow).catch((e) => console.error('[window] failed to load dev URL:', e));
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html')).then(revealMainWindow).catch((e) => console.error('[window] failed to load file:', e));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  await startPythonServer();
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

app.on('before-quit', () => {
  stopPythonServer();
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
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: filters || [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'] }]
  });
  if (result.canceled) {
    return [];
  } else {
    return result.filePaths;
  }
});

function collectImageFilesFromDirectory(dirPath) {
  const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']);
  const collected = [];

  const walk = (currentDir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && imageExtensions.has(path.extname(entry.name).toLowerCase())) {
        collected.push(fullPath);
      }
    }
  };

  walk(dirPath);
  return collected.sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true }));
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

function extFromImageSource(source = '') {
  const clean = String(source || '').split('?')[0].split('#')[0];
  const ext = path.extname(clean).toLowerCase().replace(/^\./, '');
  return ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'].includes(ext) ? ext : 'png';
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

const preparedDragFiles = new Map();

function dragPayloadKey(payload = {}) {
  return [payload.localPath || '', payload.src || payload.url || '', payload.name || ''].join('|');
}

async function prepareImageDragFile(payload = {}) {
  const src = String(payload.src || payload.url || '').trim();
  const localPath = filePathFromMaybeFileUrl(payload.localPath || src);
  if (localPath && !/^https?:\/\//i.test(localPath) && !/^data:image\//i.test(localPath) && fs.existsSync(localPath)) {
    return localPath;
  }

  const safeName = safeExportName(payload.name, 'image');
  const tempDir = path.join(app.getPath('temp'), 'uijiem-drag-images');
  fs.mkdirSync(tempDir, { recursive: true });

  if (/^data:image\//i.test(src)) {
    const match = src.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
    if (!match) throw new Error('图片 data-url 格式无效');
    const extMap = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
    const ext = extMap[match[1].toLowerCase()] || 'png';
    const filePath = path.join(tempDir, `${safeName}-${Date.now()}.${ext}`);
    fs.writeFileSync(filePath, Buffer.from(match[2], 'base64'));
    return filePath;
  }

  if (/^https?:\/\//i.test(src)) {
    const ext = extFromImageSource(src);
    const filePath = path.join(tempDir, `${safeName}-${Date.now()}.${ext}`);
    await downloadToFile(src, filePath);
    return filePath;
  }

  throw new Error('没有可拖出的图片文件');
}

// Prepare remote/data-url images before dragstart; native dragging needs a real local file immediately.
ipcMain.handle('prepare-image-drag', async (_event, payload) => {
  try {
    const key = dragPayloadKey(payload || {});
    if (preparedDragFiles.has(key)) {
      const cached = preparedDragFiles.get(key);
      if (cached && fs.existsSync(cached)) return { ok: true, file: cached };
      preparedDragFiles.delete(key);
    }
    const file = await prepareImageDragFile(payload || {});
    preparedDragFiles.set(key, file);
    return { ok: true, file };
  } catch (e) {
    console.error('[prepare-image-drag] failed:', e);
    return { ok: false, error: e.message || String(e) };
  }
});

// Start native OS file drag for images so materials can be dragged into other apps.
ipcMain.on('start-image-drag', (event, payload) => {
  try {
    const key = dragPayloadKey(payload || {});
    const candidate = payload?.preparedFile || preparedDragFiles.get(key) || payload?.localPath || payload?.src || payload?.url || '';
    const file = filePathFromMaybeFileUrl(candidate);
    if (!file || /^https?:\/\//i.test(file) || /^data:image\//i.test(file) || !fs.existsSync(file)) {
      throw new Error('图片还没有准备好，请按住图片稍等一下再拖出');
    }
    const icon = nativeImage.createFromPath(file).resize({ width: 64, height: 64 });
    event.sender.startDrag({
      file,
      icon: icon.isEmpty() ? nativeImage.createEmpty() : icon,
    });
  } catch (e) {
    console.error('[drag-image] failed:', e);
    event.sender.send('image-drag-error', e.message || String(e));
  }
});

// Export a list of remote materials into a chosen folder, named by sequence index.
// items: [{ url, index, ext }]; when targetDir omitted, prompts for a folder.
ipcMain.handle('export-videos', async (event, payload) => {
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

// Save merged image bytes (PNG/JPEG) from renderer-side canvas to a local file.
// payload: {
//   bytes: Uint8Array | number[] | ArrayBuffer,
//   ext: 'png' | 'jpg',
//   defaultDir?: string,         // 优先目录；不存在会自动创建
//   defaultName?: string,        // 默认文件名（带或不带扩展）
//   silent?: boolean,            // true: 不弹保存对话框，直接写到 defaultDir
// }
ipcMain.handle('save-merged-image', async (_event, payload = {}) => {
  try {
    const { bytes, ext = 'png', defaultDir, defaultName, silent = false } = payload || {};
    if (!bytes) return { ok: false, error: '没有可保存的数据' };

    const buffer = Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);

    const cleanExt = String(ext || 'png').replace(/^\./, '').toLowerCase();
    const finalExt = ['png', 'jpg', 'jpeg'].includes(cleanExt) ? (cleanExt === 'jpeg' ? 'jpg' : cleanExt) : 'png';

    const baseName = safeExportName(
      String(defaultName || '').replace(/\.(png|jpe?g)$/i, ''),
      `merge_${Date.now()}`,
    );

    const fallbackDir = path.join(app.getPath('temp'), 'uijiem-merged');
    const targetDirCandidate = defaultDir && String(defaultDir).trim() ? String(defaultDir) : fallbackDir;

    let targetPath;
    if (silent) {
      try {
        fs.mkdirSync(targetDirCandidate, { recursive: true });
      } catch (e) {
        fs.mkdirSync(fallbackDir, { recursive: true });
      }
      const dirToUse = fs.existsSync(targetDirCandidate) ? targetDirCandidate : fallbackDir;
      let fileName = `${baseName}.${finalExt}`;
      let suffix = 2;
      while (fs.existsSync(path.join(dirToUse, fileName))) {
        fileName = `${baseName}-${suffix++}.${finalExt}`;
      }
      targetPath = path.join(dirToUse, fileName);
    } else {
      try {
        fs.mkdirSync(targetDirCandidate, { recursive: true });
      } catch (_) {}
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

// Reveal a file in the OS file explorer.
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

ipcMain.handle('open-wizstar-browser', async (event, accountId) => {
  try {
    return await openWizstarAccountWindow(accountId);
  } catch (e) {
    console.error('[wizstar-browser] failed:', e);
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('wizstar-server-status', async () => {
  try {
    return await new Promise((resolve) => {
      const req = http.get(`${WIZSTAR_BASE_URL}/health`, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({ running: true, ...JSON.parse(data) });
          } catch {
            resolve({ running: true });
          }
        });
      });
      req.on('error', () => resolve({ running: false }));
      req.setTimeout(3000, () => { req.destroy(); resolve({ running: false }); });
    });
  } catch {
    return { running: false };
  }
});
