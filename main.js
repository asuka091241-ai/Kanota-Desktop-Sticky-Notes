const { app, BrowserWindow, ipcMain, Menu, screen, Tray, dialog, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const updater = require('./updater');

const getDefaultDataDir = () => {
  const exeDir = path.dirname(app.getPath('exe'));
  // Dev mode: electron.exe is deep inside node_modules, fall back to project root
  if (exeDir.includes('node_modules')) return path.join(__dirname, 'data');
  // Packaged: data folder next to Kanota.exe
  return path.join(exeDir, 'data');
};

const DEFAULT_DATA_DIR = getDefaultDataDir();
let DATA_DIR = DEFAULT_DATA_DIR;

// Settings file always lives in default data dir (bootstrap)
const SETTINGS_FILE = path.join(DEFAULT_DATA_DIR, 'kanban-settings.json');

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
ensureDir(DEFAULT_DATA_DIR);

// Data/trash files follow DATA_DIR (which may be overridden)
function dataFile() { return path.join(DATA_DIR, 'kanban-data.json'); }
function trashFile() { return path.join(DATA_DIR, 'kanban-trash.json'); }

// Bootstrap: load settings to get custom dataPath
const _bootSettings = loadJSON(SETTINGS_FILE, {});
if (_bootSettings.dataPath && _bootSettings.dataPath !== DEFAULT_DATA_DIR) {
  DATA_DIR = _bootSettings.dataPath;
  ensureDir(DATA_DIR);
}
// One-time: migrate old AppData data to new default location
const OLD_DATA_DIR = app.getPath('userData');
if (fs.existsSync(path.join(OLD_DATA_DIR, 'kanban-data.json')) && !fs.existsSync(dataFile())) {
  ensureDir(DATA_DIR);
  for (const f of ['kanban-data.json', 'kanban-trash.json', 'kanban-settings.json']) {
    const src = path.join(OLD_DATA_DIR, f);
    if (fs.existsSync(src)) {
      const dst = f === 'kanban-settings.json' ? SETTINGS_FILE : (f === 'kanban-data.json' ? dataFile() : trashFile());
      try { fs.copyFileSync(src, dst); } catch (_) {}
    }
  }
}

let mainWindow = null;
let tray = null;
const stickyWindows = new Map(); // Map<cardId, BrowserWindow>

function loadJSON(file, def) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) {}
  return def;
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8'); return true; } catch (_) { return false; }
}

function readData() {
  return loadJSON(dataFile(), { todo: [], inProgress: [], done: [], _stickies: [] });
}
function writeData(data) {
  return saveJSON(dataFile(), data);
}

function addToTrash(card, sourceCol) {
  const trash = loadJSON(trashFile(), []);
  trash.push({
    id: card.id,
    title: card.title || '',
    desc: card.desc || '',
    time: card.time || '',
    noteColor: card.noteColor || null,
    _sourceCol: sourceCol || 'todo',
    _refId: card._refId || null,
    closedAt: new Date().toISOString()
  });
  saveJSON(trashFile(), trash);
  return trash;
}

function createStickyWindow(cardData, screenX, screenY) {
  if (stickyWindows.has(cardData.id)) {
    const w = stickyWindows.get(cardData.id);
    if (w && !w.isDestroyed()) {
      w.focus();
      return w;
    }
    stickyWindows.delete(cardData.id);
  }

  const refId = cardData._refId || cardData.id;
  for (const [cid, win] of stickyWindows) {
    if (!win || win.isDestroyed()) {
      stickyWindows.delete(cid);
      continue;
    }
    if ((win.cardData && win.cardData._refId === refId) || (win.cardData && win.cardData.id === refId && cid !== cardData.id)) {
      return win;
    }
  }

  const SHADOW_PAD = 10;
  const x = screenX - 20 - SHADOW_PAD;
  const y = screenY - 16 - SHADOW_PAD;

  const stickyWin = new BrowserWindow({
    width: 340 + SHADOW_PAD * 2,
    height: 200 + SHADOW_PAD * 2,
    x, y,
    minWidth: 280,
    minHeight: 54,
    frame: false,
    transparent: true,
    alwaysOnTop: !cardData._pinned,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload-sticky.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  stickyWindows.set(cardData.id, stickyWin);
  // Respect "default collapsed" setting
  const settings = loadJSON(SETTINGS_FILE, {});
  if (settings._stickyCollapsed) {
    cardData._collapsed = true;
  } else {
    delete cardData._collapsed;
  }
  stickyWin.cardData = cardData;
  let ignoreClose = false;

  stickyWin.loadFile('sticky.html');

  // Clean up when closed
  stickyWin.on('closed', () => {
    stickyWindows.delete(cardData.id);
    if (ignoreClose) return;
    // Window closed by system - do NOT move to trash, just remove from _stickies
    const data = readData();
    const idx = (data._stickies || []).findIndex(c => c.id === cardData.id);
    if (idx >= 0) {
      data._stickies.splice(idx, 1);
      writeData(data);
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.webContents.send('sticky:removed', cardData.id); } catch (_) {}
      }
    }
  });

  stickyWin.on('moved', () => {
    const bounds = stickyWin.getBounds();
    const data = readData();
    const idx = (data._stickies || []).findIndex(c => c.id === cardData.id);
    if (idx >= 0) {
      data._stickies[idx]._stickyX = bounds.x + 20 + SHADOW_PAD;
      data._stickies[idx]._stickyY = bounds.y + 16 + SHADOW_PAD;
      writeData(data);
    }
  });

  stickyWin._closeNoTrash = () => {
    ignoreClose = true;
    try { stickyWin.close(); } catch (_) {}
  };

  return stickyWin;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100, height: 740, minWidth: 820, minHeight: 540,
    frame: false, titleBarStyle: 'hidden', backgroundColor: '#f5f5f7',
    title: 'Kanota — CaffYooO',
    resizable: true,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.loadFile('index.html');
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ===== Data IPC =====
ipcMain.handle('load-data', () => readData());
ipcMain.handle('save-data', (_, data) => writeData(data));
ipcMain.handle('load-settings', () => loadJSON(SETTINGS_FILE, { theme: 'light', alwaysOnTop: false }));
ipcMain.handle('save-settings', (_, s) => saveJSON(SETTINGS_FILE, s));
ipcMain.handle('broadcast-to-stickies', (_, msg) => {
  stickyWindows.forEach(w => {
    if (!w || w.isDestroyed()) return;
    w.webContents.send('sticky:message', msg);
  });
});
ipcMain.handle('sticky:loadSettings', () => loadJSON(SETTINGS_FILE, {}));

// ===== Updates =====
let latestRelease = null;

async function checkForUpdate(showDialog = true) {
  const result = await updater.checkForUpdates(!showDialog);
  if (result.upToDate) return;
  if (result.error) return;
  latestRelease = result.release;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:available', {
      version: result.latestVersion,
      current: result.currentVersion,
      notes: (result.release || {}).body || '',
    });
  }
  if (showDialog) {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: '发现新版本',
      message: `Kanota v${result.latestVersion} 可用（当前 v${result.currentVersion}）`,
      detail: ((result.release || {}).body || '').slice(0, 300),
      buttons: ['立即更新', '稍后'],
      defaultId: 0,
    });
    if (response === 0) {
      await updater.downloadAndInstall(result.release, mainWindow);
    }
  }
}

ipcMain.handle('check-update', async () => {
  const result = await updater.checkForUpdates(true);
  if (result.upToDate) return { upToDate: true, currentVersion: result.currentVersion };
  if (result.error) return { error: result.error, currentVersion: result.currentVersion };
  latestRelease = result.release;
  return { upToDate: false, currentVersion: result.currentVersion, latestVersion: result.latestVersion, notes: (result.release || {}).body || '' };
});

ipcMain.handle('download-update', async () => {
  if (!latestRelease) {
    const result = await updater.checkForUpdates(true);
    if (result.upToDate || result.error) return { ok: false };
    latestRelease = result.release;
  }
  await updater.downloadAndInstall(latestRelease, mainWindow);
  return { ok: true };
});

// ===== Data Path =====
ipcMain.handle('get-data-path', () => ({ current: DATA_DIR, default: DEFAULT_DATA_DIR }));
ipcMain.handle('set-data-path', async (_, newPath, migrate) => {
  if (!newPath || newPath === DATA_DIR) return { ok: true, path: DATA_DIR };
  const targetDir = path.resolve(newPath);
  if (targetDir === DEFAULT_DATA_DIR) {
    // Resetting to default — migrate back
    if (migrate && fs.existsSync(dataFile())) {
      const srcDir = DATA_DIR;
      DATA_DIR = DEFAULT_DATA_DIR;
      ensureDir(DATA_DIR);
      try { fs.copyFileSync(path.join(srcDir, 'kanban-data.json'), dataFile()); } catch (_) {}
      try { fs.copyFileSync(path.join(srcDir, 'kanban-trash.json'), trashFile()); } catch (_) {}
    } else {
      DATA_DIR = DEFAULT_DATA_DIR;
      ensureDir(DATA_DIR);
    }
  } else {
    ensureDir(targetDir);
    if (migrate && fs.existsSync(dataFile())) {
      try { fs.copyFileSync(dataFile(), path.join(targetDir, 'kanban-data.json')); } catch (_) {}
      try { fs.copyFileSync(trashFile(), path.join(targetDir, 'kanban-trash.json')); } catch (_) {}
    }
    DATA_DIR = targetDir;
  }
  // Persist the setting
  const s = loadJSON(SETTINGS_FILE, {});
  s.dataPath = DATA_DIR;
  saveJSON(SETTINGS_FILE, s);
  return { ok: true, path: DATA_DIR };
});

ipcMain.handle('pick-folder', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择数据存储文件夹',
  });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('load-trash', () => loadJSON(trashFile(), []));
ipcMain.handle('save-trash', (_, d) => saveJSON(trashFile(), d));

// ===== Drag out =====
let dragPollTimer = null;
let dragLastCx = 0, dragLastCy = 0, dragOutside = false;

ipcMain.handle('drag-start-tracking', () => {
  if (dragPollTimer) clearInterval(dragPollTimer);
  dragOutside = false;
  dragPollTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    dragLastCx = cursor.x;
    dragLastCy = cursor.y;
    const bounds = mainWindow.getBounds();
    const outside = cursor.x < bounds.x || cursor.x > bounds.x + bounds.width ||
                    cursor.y < bounds.y || cursor.y > bounds.y + bounds.height;
    if (outside) dragOutside = true;
  }, 30);
  return true;
});

ipcMain.handle('drag-stop-tracking', () => {
  if (dragPollTimer) {
    clearInterval(dragPollTimer);
    dragPollTimer = null;
  }
  const result = { x: dragLastCx, y: dragLastCy, outside: dragOutside };
  dragOutside = false;
  return result;
});

// ===== Window Controls =====
ipcMain.handle('minimize', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize(); return true; });
ipcMain.handle('maximize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  }
  return true;
});
ipcMain.handle('close', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return true;
  // Show styled dialog in renderer; the renderer will call quit-app or hide-to-tray
  try { mainWindow.webContents.send('show-close-dialog'); } catch (_) {}
  return true;
});
ipcMain.handle('hide-to-tray', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  return true;
});
ipcMain.handle('quit-app', () => {
  app.quit();
  return true;
});
ipcMain.handle('set-always-on-top', (_, v) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(v); return true; });

// ===== Autostart =====
ipcMain.handle('get-autostart', () => {
  return app.getLoginItemSettings().openAtLogin;
});
ipcMain.handle('set-autostart', (_, v) => {
  app.setLoginItemSettings({ openAtLogin: v });
  return true;
});

// ===== Sticky IPC =====
ipcMain.handle('open-sticky', (_, cardData, screenX, screenY) => {
  const w = createStickyWindow(cardData, screenX, screenY);
  return true;
});

ipcMain.handle('sticky:getData', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  return win.cardData || null;
});

ipcMain.on('sticky:toggleCollapse', (event, collapsed) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || !win.cardData) return;
  const data = readData();
  const idx = (data._stickies || []).findIndex(c => c.id === win.cardData.id);
  if (idx >= 0) {
    data._stickies[idx]._collapsed = collapsed;
    writeData(data);
    win.cardData._collapsed = collapsed;
    win.webContents.send('sticky:update', win.cardData);
  }
});

ipcMain.on('sticky:togglePin', (event, pinned) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || !win.cardData) return;
  win.setMovable(!pinned);
  win.setAlwaysOnTop(!pinned);
  const data = readData();
  const idx = (data._stickies || []).findIndex(c => c.id === win.cardData.id);
  if (idx >= 0) {
    data._stickies[idx]._pinned = pinned;
    if (pinned) {
      const bounds = win.getBounds();
      data._stickies[idx]._stickyX = bounds.x + 20 + 10; // SHADOW_PAD
      data._stickies[idx]._stickyY = bounds.y + 16 + 10;
    }
    writeData(data);
    win.cardData._pinned = pinned;
    win.webContents.send('sticky:update', win.cardData);
  }
});

ipcMain.on('sticky:changeStatus', (event, flow) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || !win.cardData) return;
  const data = readData();
  const idx = (data._stickies || []).findIndex(c => c.id === win.cardData.id);
  if (idx < 0) return;
  const d = data._stickies[idx];
  const refId = d._refId || d.id;
  let srcCol = d._sourceCol || 'todo';
  // Reset: move from done back to todo
  if (flow === 'reset') {
    const doneCol = data.done || [];
    const di = doneCol.findIndex(c => c.id === refId);
    if (di >= 0) {
      const [card] = doneCol.splice(di, 1);
      if (!data.todo) data.todo = [];
      data.todo.push(card);
      d._sourceCol = 'todo';
      d._stickyStatus = 'todo';
      win.cardData = { ...d };
      writeData(data);
      win.webContents.send('sticky:update', win.cardData);
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.webContents.send('sticky:statusChanged', d.id, 'todo'); } catch (_) {}
      }
    }
    return;
  }
  let srcIdx = -1;
  if (data[srcCol]) srcIdx = data[srcCol].findIndex(c => c.id === refId);
  if (srcIdx < 0) {
    for (const col of ['todo', 'inProgress', 'done']) {
      if (col === srcCol) continue;
      const i = (data[col] || []).findIndex(c => c.id === refId);
      if (i >= 0) { srcCol = col; srcIdx = i; break; }
    }
  }
  if (srcIdx >= 0) {
    const [card] = data[srcCol].splice(srcIdx, 1);
    // Carry sticky's timer / pomo stats to the kanban card before moving
    card._timerElapsed = d._timerElapsed ?? card._timerElapsed;
    card._pomoSessions = d._pomoSessions ?? card._pomoSessions;
    card._pomoTotalMin = d._pomoTotalMin ?? card._pomoTotalMin;
    const dstCol = srcCol === 'todo' ? 'inProgress' : 'done';
    if (!data[dstCol]) data[dstCol] = [];
    data[dstCol].push(card);
    d._sourceCol = dstCol;
    d._stickyStatus = dstCol;
    win.cardData = { ...d };
    writeData(data);
    win.webContents.send('sticky:update', win.cardData);
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('sticky:statusChanged', d.id, dstCol); } catch (_) {}
    }
  }
});

// ===== Drag: main process polls cursor at high rate, zero IPC per frame =====
ipcMain.on('sticky:dragInit', (event, screenX, screenY) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  const [wx, wy] = win.getPosition();
  const { width, height } = win.getBounds();
  const cx = screenX, cy = screenY;
  win._dPoll = setInterval(() => {
    if (!win || win.isDestroyed()) { clearInterval(win._dPoll); return; }
    const cur = screen.getCursorScreenPoint();
    win.setBounds({ x: wx + (cur.x - cx), y: wy + (cur.y - cy), width, height });
  }, 6); // ~160fps
});

ipcMain.on('sticky:dragEnd', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && win._dPoll) { clearInterval(win._dPoll); win._dPoll = null; }
});

// ===== Resize: main process polls cursor at high rate, zero IPC per frame =====
ipcMain.on('sticky:resizeInit', (event, screenX, screenY, direction) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  const SHADOW_PAD = 10;
  const MIN_W = 260 + SHADOW_PAD * 2;
  const MIN_H = 54 + SHADOW_PAD * 2;
  const init = win.getBounds();
  const sx = screenX, sy = screenY;
  win._rPoll = setInterval(() => {
    if (!win || win.isDestroyed()) { clearInterval(win._rPoll); return; }
    const cur = screen.getCursorScreenPoint();
    let { x, y, width, height } = init;
    if (direction === 'r' || direction === 'br') {
      width = Math.max(MIN_W, init.width + (cur.x - sx));
    }
    if (direction === 'b' || direction === 'br') {
      height = Math.max(MIN_H, init.height + (cur.y - sy));
    }
    win.setBounds({ x, y, width, height });
  }, 6);
});

ipcMain.on('sticky:resizeEnd', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && win._rPoll) { clearInterval(win._rPoll); win._rPoll = null; }
});

ipcMain.on('sticky:resize', (event, height) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const h = Math.max(54, typeof height === 'number' ? height : 54);
  const SHADOW_PAD = 10;
  win.setBounds({ x: b.x, y: b.y, width: b.width, height: h + SHADOW_PAD * 2 });
});

ipcMain.handle('sticky:savePomoStats', (event, cardId, sessions, totalMin) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const data = readData();
  // Save to sticky data
  const idx = (data._stickies || []).findIndex(c => c.id === cardId);
  if (idx >= 0) {
    data._stickies[idx]._pomoSessions = sessions;
    data._stickies[idx]._pomoTotalMin = totalMin;
    if (win && !win.isDestroyed() && win.cardData) {
      win.cardData._pomoSessions = sessions;
      win.cardData._pomoTotalMin = totalMin;
    }
  }
  // Also save to kanban card
  const d = data._stickies[idx];
  if (d) {
    const refId = d._refId || d.id;
    for (const col of ['todo', 'inProgress', 'done']) {
      const card = (data[col] || []).find(c => c.id === refId);
      if (card) {
        card._pomoSessions = sessions;
        card._pomoTotalMin = totalMin;
        break;
      }
    }
  }
  writeData(data);
  return true;
});

// ===== Subtask Sync =====
ipcMain.handle('sticky:saveSubtasks', (_, cardId, subtasks) => {
  const data = readData();
  const sIdx = (data._stickies || []).findIndex(s => s.id === cardId);
  if (sIdx >= 0) data._stickies[sIdx].subtasks = subtasks;
  const d = data._stickies ? data._stickies[sIdx] : null;
  if (d) {
    const refId = d._refId || d.id;
    for (const col of ['todo', 'inProgress', 'done']) {
      const card = (data[col] || []).find(c => c.id === refId);
      if (card) { card.subtasks = subtasks; break; }
    }
  }
  writeData(data);
  const sw = stickyWindows.get(cardId);
  if (sw && !sw.isDestroyed() && sw.cardData) {
    sw.cardData.subtasks = subtasks;
    sw.webContents.send('sticky:update', sw.cardData);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('sticky:dataChanged', cardId); } catch (_) {}
  }
  return true;
});

// ===== Due Date Sync =====
ipcMain.handle('sticky:saveDueDate', (_, cardId, dueDate) => {
  const data = readData();
  const sIdx = (data._stickies || []).findIndex(s => s.id === cardId);
  if (sIdx >= 0) {
    data._stickies[sIdx].dueDate = dueDate;
    data._stickies[sIdx].dueReminded = false;
  }
  const d = data._stickies ? data._stickies[sIdx] : null;
  if (d) {
    const refId = d._refId || d.id;
    for (const col of ['todo', 'inProgress', 'done']) {
      const card = (data[col] || []).find(c => c.id === refId);
      if (card) { card.dueDate = dueDate; card.dueReminded = false; break; }
    }
  }
  writeData(data);
  const sw = stickyWindows.get(cardId);
  if (sw && !sw.isDestroyed() && sw.cardData) {
    sw.cardData.dueDate = dueDate;
    sw.cardData.dueReminded = false;
    sw.webContents.send('sticky:update', sw.cardData);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('sticky:dataChanged', cardId); } catch (_) {}
  }
  return true;
});

ipcMain.handle('sticky:showContextMenu', (event, payload = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return false;
  const send = (command) => {
    try { event.sender.send('sticky:context-command', command); } catch (_) {}
  };
  const menu = Menu.buildFromTemplate([
    {
      label: '更换颜色',
      submenu: [
        { label: '○ 默认', click: () => send({ type: 'color', color: null }) },
        { label: '🟡 黄色', click: () => send({ type: 'color', color: 'yellow' }) },
        { label: '🩷 粉色', click: () => send({ type: 'color', color: 'pink' }) },
        { label: '🔵 蓝色', click: () => send({ type: 'color', color: 'blue' }) },
        { label: '🟢 绿色', click: () => send({ type: 'color', color: 'green' }) },
        { label: '🟣 紫色', click: () => send({ type: 'color', color: 'purple' }) },
      ]
    },
    { type: 'separator' },
    { label: '从桌面移除', click: () => send({ type: 'remove' }) },
  ]);
  menu.popup({ window: win, x: payload.x, y: payload.y });
  return true;
});

ipcMain.handle('sticky:updateColor', (_, id, color) => {
  const data = readData();
  const idx = (data._stickies || []).findIndex(c => c.id === id);
  if (idx < 0) return false;
  const d = data._stickies[idx];
  const refId = d._refId || d.id;
  for (const col of ['todo', 'inProgress', 'done']) {
    const i = (data[col] || []).findIndex(c => c.id === refId);
    if (i >= 0) data[col][i].noteColor = color;
  }
  for (const s of data._stickies || []) {
    if (s.id !== id && (s._refId === refId || s.id === refId)) {
      s.noteColor = color;
      const w = stickyWindows.get(s.id);
      if (w && !w.isDestroyed()) {
        w.cardData = { ...s };
        try { w.webContents.send('sticky:update', w.cardData); } catch (_) {}
      }
    }
  }
  d.noteColor = color;
  writeData(data);
  const selfWin = stickyWindows.get(id);
  if (selfWin && !selfWin.isDestroyed()) {
    selfWin.cardData = { ...d };
    selfWin.webContents.send('sticky:update', selfWin.cardData);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('sticky:colorChanged', refId, color); } catch (_) {}
  }
  return true;
});

const removeFromDesktopHandler = (_, id) => {
  const win = stickyWindows.get(id);
  if (win && !win.isDestroyed()) {
    stickyWindows.delete(id);
    win._closeNoTrash();
  }
  const data = readData();
  const idx = (data._stickies || []).findIndex(c => c.id === id);
  if (idx >= 0) {
    data._stickies.splice(idx, 1);
    writeData(data);
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('sticky:removed', id); } catch (_) {}
    }
  }
  return true;
};

ipcMain.handle('sticky:removeFromDesktop', removeFromDesktopHandler);
ipcMain.handle('sticky-remove-from-desktop', removeFromDesktopHandler);
ipcMain.handle('sticky:getWindowState', (_, id) => {
  const win = stickyWindows.get(id);
  if (!win) return { exists: false, destroyed: true };
  return { exists: true, destroyed: win.isDestroyed() };
});

// ===== Pomodoro Time Sync =====
ipcMain.on('sticky:addPomoTime', (_, cardId, ms) => {
  const data = readData();
  for (const col of ['todo', 'inProgress', 'done']) {
    const card = (data[col] || []).find(c => c.id === cardId);
    if (card) {
      card._timerElapsed = (card._timerElapsed || 0) + ms;
      // Also sync to sticky entry
      const sIdx = (data._stickies || []).findIndex(s => s.id === cardId);
      if (sIdx >= 0) data._stickies[sIdx]._timerElapsed = card._timerElapsed;
      writeData(data);
      // Update the sticky window's in-memory data if it's open
      const sw = stickyWindows.get(cardId);
      if (sw && !sw.isDestroyed() && sw.cardData) {
        sw.cardData._timerElapsed = card._timerElapsed;
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.webContents.send('sticky:addPomoTimeResult', cardId, card._timerElapsed); } catch (_) {}
      }
      break;
    }
  }
});

// ===== Legacy IPC (keep for index.html compatibility) =====
ipcMain.handle('delete-sticky', (_, stickyId) => {
  const data = readData();
  const idx = (data._stickies || []).findIndex(c => c.id === stickyId);
  if (idx < 0) return false;
  const d = data._stickies[idx];
  const refId = d._refId || d.id;
  for (let i = data._stickies.length - 1; i >= 0; i--) {
    const s = data._stickies[i];
    if (s._refId === refId || s.id === refId || s.id === stickyId) {
      const w = stickyWindows.get(s.id);
      if (w && !w.isDestroyed()) w._closeNoTrash();
      addToTrash(s, s._sourceCol || 'todo');
      data._stickies.splice(i, 1);
    }
  }
  let origCol = null, origIdx = -1;
  for (const col of ['todo', 'inProgress', 'done']) {
    const i = (data[col] || []).findIndex(c => c.id === refId);
    if (i >= 0) { origCol = col; origIdx = i; break; }
  }
  if (origCol && origIdx >= 0) {
    const [orig] = data[origCol].splice(origIdx, 1);
    addToTrash(orig, origCol);
  }
  writeData(data);
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('kanban:cardDeleted', refId, origCol || 'todo'); } catch (_) {}
  }
  return true;
});

ipcMain.handle('delete-kanban-card', (_, cardId, sourceCol) => {
  const data = readData();
  const col = sourceCol || 'todo';
  let deletedCard = null;
  if (data[col]) {
    const i = data[col].findIndex(c => c.id === cardId);
    if (i >= 0) [deletedCard] = data[col].splice(i, 1);
  }
  for (let i = data._stickies.length - 1; i >= 0; i--) {
    const s = data._stickies[i];
    if (s._refId === cardId || s.id === cardId) {
      const w = stickyWindows.get(s.id);
      if (w && !w.isDestroyed()) {
        try { w._closeNoTrash(); } catch (_) {}
      }
      addToTrash(s, s._sourceCol || 'todo');
      data._stickies.splice(i, 1);
    }
  }
  if (deletedCard) addToTrash(deletedCard, col);
  writeData(data);
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('kanban:cardDeleted', cardId, col); } catch (_) {}
  }
  return true;
});

ipcMain.handle('kanban:showContextMenu', (event, payload = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return false;
  const { cardId, col } = payload;
  const send = (command) => {
    try { event.sender.send('kanban:context-command', { cardId, col, ...command }); } catch (_) {}
  };
  const menu = Menu.buildFromTemplate([
    { label: '打开详情', click: () => { try { event.sender.send('kanban:openCardDetail', cardId, col); } catch (_) {} } },
    {
      label: '更换颜色',
      submenu: [
        { label: '○ 默认', click: () => send({ type: 'color', color: null }) },
        { label: '🟡 黄色', click: () => send({ type: 'color', color: 'yellow' }) },
        { label: '🩷 粉色', click: () => send({ type: 'color', color: 'pink' }) },
        { label: '🔵 蓝色', click: () => send({ type: 'color', color: 'blue' }) },
        { label: '🟢 绿色', click: () => send({ type: 'color', color: 'green' }) },
        { label: '🟣 紫色', click: () => send({ type: 'color', color: 'purple' }) },
      ]
    },
    { type: 'separator' },
    { label: '删除', click: () => send({ type: 'delete' }) },
  ]);
  menu.popup({ window: win, x: payload.x, y: payload.y });
  return true;
});

ipcMain.handle('ui-remove-sticky', (_, cardId) => {
  const w = stickyWindows.get(cardId);
  if (w && !w.isDestroyed()) w._closeNoTrash();
  return true;
});

ipcMain.handle('sync-sticky-data', (_, cardData) => {
  let w = stickyWindows.get(cardData.id);
  // Fallback: search by _refId if direct ID lookup misses
  if (!w || w.isDestroyed()) {
    for (const [, sWin] of stickyWindows) {
      if (!sWin || sWin.isDestroyed()) continue;
      if (sWin.cardData && (sWin.cardData._refId === cardData.id || sWin.cardData._refId === cardData._refId)) {
        w = sWin; break;
      }
    }
  }
  if (!w || w.isDestroyed()) return false;

  const data = readData();
  const stickyId = w.cardData ? w.cardData.id : cardData.id;
  const sIdx = (data._stickies || []).findIndex(s => s.id === stickyId);
  if (sIdx >= 0) {
    const s = data._stickies[sIdx];
    s.title = cardData.title;
    s.desc = cardData.desc;
    s.noteColor = cardData.noteColor;
    s._timerElapsed = cardData._timerElapsed;
    s._pomoSessions = cardData._pomoSessions;
    s._pomoTotalMin = cardData._pomoTotalMin;
    // Use explicit target column if provided, otherwise search
    if (cardData._toCol && ['todo', 'inProgress', 'done'].includes(cardData._toCol)) {
      s._sourceCol = cardData._toCol;
      s._stickyStatus = cardData._toCol;
    }
    s.time = cardData.time || s.time;
    s.subtasks = cardData.subtasks || s.subtasks || [];
    s.dueDate = cardData.dueDate || s.dueDate || null;
    s.dueReminded = cardData.dueReminded !== undefined ? cardData.dueReminded : s.dueReminded;
    writeData(data);
    w.cardData = { ...s };
    w.webContents.send('sticky:update', w.cardData);
  }
  return true;
});

// ===== Stats & Due Checks =====
function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

ipcMain.handle('kanban:getStatsData', () => {
  const data = readData();
  const now = new Date();
  const todayStr = now.toLocaleDateString('zh-CN');
  const allCards = [...(data.todo || []), ...(data.inProgress || []), ...(data.done || [])];
  const todayDone = (data.done || []).filter(c => c.time === todayStr).length;
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  weekStart.setHours(0, 0, 0, 0);
  const weekDone = (data.done || []).filter(c => {
    const d = parseDate(c.time);
    return d && d >= weekStart;
  }).length;
  let pomoSessions = 0, pomoTotalMin = 0;
  for (const c of allCards) {
    pomoSessions += c._pomoSessions || 0;
    pomoTotalMin += c._pomoTotalMin || 0;
  }
  const dueSoon = allCards.filter(c => {
    if (!c.dueDate) return false;
    const due = new Date(c.dueDate);
    return due > now && (due - now) < 24 * 60 * 60 * 1000;
  }).length;
  const overdue = allCards.filter(c => {
    if (!c.dueDate) return false;
    return new Date(c.dueDate) <= now;
  }).length;
  return {
    todo: (data.todo || []).length,
    inProgress: (data.inProgress || []).length,
    done: (data.done || []).length,
    todayDone, weekDone,
    stickies: (data._stickies || []).length,
    pomoSessions, pomoTotalMin,
    dueSoon, overdue,
  };
});

// ===== App =====
app.whenReady().then(() => {
  // Set app-level icon for taskbar
  const iconPath = path.join(__dirname, 'icon.png');
  if (fs.existsSync(iconPath)) {
    app.setAppUserModelId('kanota');
  }

  // Create tray
  try {
    const trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    tray = new Tray(trayIcon);
    tray.setToolTip('Kanota — by CaffYooO');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
      { label: '检查更新', click: () => checkForUpdate(true) },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]));
    tray.on('double-click', () => {
      if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    });
  } catch (_) { /* tray creation may fail */ }

  createMainWindow();

  // ===== Due date reminder polling (every 60s) =====
  setInterval(() => {
    const data = readData();
    const now = new Date();
    const allCards = [...(data.todo || []), ...(data.inProgress || []), ...(data.done || [])];
    for (const card of allCards) {
      if (!card.dueDate || card.dueReminded) continue;
      const due = new Date(card.dueDate);
      if (due <= now) {
        card.dueReminded = true;
        const sIdx = (data._stickies || []).findIndex(s => s._refId === card.id);
        if (sIdx >= 0) data._stickies[sIdx].dueReminded = true;
        writeData(data);
        if (Notification.isSupported()) {
          new Notification({
            title: '任务到期',
            body: '"' + (card.title || '无标题') + '" 已到截止时间',
            urgency: 'critical',
          }).show();
        }
      }
    }
  }, 60 * 1000);

  const data = readData();
  const seen = new Set();
  const stickies = (data._stickies || []).filter(c => {
    if (!c || !c.id || seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
  data._stickies = stickies;
  writeData(data);
  for (const card of stickies) {
    const sx = card._stickyX || 200;
    const sy = card._stickyY || 200;
    const win = createStickyWindow(card, sx, sy);
    if (card._pinned && win) {
      win.setMovable(false);
      win.setAlwaysOnTop(false);
    }
  }
  app.on('activate', () => { if (!mainWindow) createMainWindow(); });
});

app.on('window-all-closed', () => {
  if (stickyWindows.size === 0 && process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  // Clear desktop stickies from data so they don't persist across restarts
  try {
    const data = readData();
    data._stickies = [];
    writeData(data);
  } catch (_) {}
  for (const w of stickyWindows.values()) {
    try { w.destroy(); } catch (_) {}
  }
  stickyWindows.clear();
  if (tray) { try { tray.destroy(); } catch (_) {}; tray = null; }
});
