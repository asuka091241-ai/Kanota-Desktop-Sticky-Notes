// GitHub auto-updater for Kanota portable
// Downloads zip, extracts, swaps entire app folder (keeps data/), restarts
const { app, dialog, shell } = require('electron');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const REPO_OWNER = 'asuka091241-ai';
const REPO_NAME = 'Kanota';
const CACHE_FILE = path.join(app.getPath('userData'), 'update-cache.json');

function loadCache() {
  try { if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')); } catch (_) {}
  return {};
}
function saveCache(c) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(c), 'utf-8'); } catch (_) {}
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'Kanota-Updater/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return httpGet(res.headers.location).then(resolve).catch(reject);
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))));
    }).on('error', reject);
  });
}

function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'Kanota-Updater/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return download(res.headers.location, dest, onProgress).then(resolve).catch(reject);
      if (res.statusCode !== 200) return reject(new Error('Download HTTP ' + res.statusCode));
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let done = 0;
      const file = fs.createWriteStream(dest);
      res.on('data', c => { done += c.length; if (onProgress && total) onProgress(Math.floor(done * 100 / total)); });
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', reject);
    }).on('error', reject);
  });
}

function cmpVersion(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

function isPackaged() {
  return app.isPackaged && !process.defaultApp;
}

function extractZip(zipPath, outDir) {
  return new Promise((resolve, reject) => {
    exec('powershell -NoProfile -Command "Expand-Archive -Path \'' + zipPath + '\' -DestinationPath \'' + outDir + '\' -Force"', (err) => {
      if (err) return reject(new Error('extract failed: ' + (err.message || '')));
      resolve();
    });
  });
}

function findAppDir(unpackedRoot) {
  // walk down into the extracted dir to find where Kanota.exe lives
  function walk(d) {
    let items;
    try { items = fs.readdirSync(d); } catch (_) { return null; }
    for (const name of items) {
      const full = path.join(d, name);
      if (name === 'Kanota.exe') return d;
      try { if (fs.statSync(full).isDirectory()) { const f = walk(full); if (f) return f; } } catch (_) {}
    }
    return null;
  }
  return walk(unpackedRoot);
}

function copyDir(src, dest) {
  // robocopy for whole folder copy
  return new Promise((resolve, reject) => {
    exec('robocopy "' + src + '" "' + dest + '" /E /XD data /IS /IT /NFL /NDL', (err, stdout, stderr) => {
      // robocopy exit code < 8 is success
      if (err && err.code >= 8) return reject(new Error('copy failed'));
      resolve();
    });
  });
}

function getAppDir() { return path.dirname(app.getPath('exe')); }

async function checkForUpdates(silent) {
  try {
    const currentVersion = app.getVersion();
    const cache = loadCache();
    const now = Date.now();
    if (cache.lastCheck && (now - cache.lastCheck) < 3600000 && silent) {
      return { currentVersion, latestVersion: cache.latestVersion, upToDate: true, cached: true };
    }
    const release = await httpGet('https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/releases/latest');
    const latestVersion = (release.tag_name || '').replace(/^v/i, '');
    if (!latestVersion) return { currentVersion, error: 'no version found' };
    saveCache({ lastCheck: now, latestVersion });
    if (cmpVersion(latestVersion, currentVersion) <= 0) {
      if (!silent) {
        await dialog.showMessageBox({ type: 'info', title: 'Kanota', message: 'v' + currentVersion + ' is the latest', buttons: ['OK'] });
      }
      return { currentVersion, latestVersion, upToDate: true };
    }
    return { currentVersion, latestVersion, upToDate: false, release };
  } catch (e) {
    if (!silent) {
      await dialog.showMessageBox({ type: 'error', title: 'Update Check Failed', message: e.message || 'Network error', buttons: ['OK'] });
    }
    return { currentVersion: app.getVersion(), error: e.message };
  }
}

async function downloadAndInstall(release, win) {
  const tmpDir = app.getPath('temp');
  const asset = (release.assets || []).find(a => a.name && a.name.toLowerCase().endsWith('.zip'));
  if (!asset) throw new Error('No .zip found in release assets');

  const zipFile = path.join(tmpDir, asset.name);
  const extractDir = path.join(tmpDir, 'kanota-extract-' + release.tag_name);
  const appDir = getAppDir();
  const appName = path.basename(appDir);
  const appParent = path.dirname(appDir);
  // New folder next to current app dir
  const newDir = path.join(appParent, appName + '_new');

  if (win && !win.isDestroyed()) {
    win.setProgressBar(0.01);
    win.webContents.send('update:progress', 0);
    win.webContents.send('update:status', 'Downloading...');
  }

  try {
    // 1. Download
    await download(asset.browser_download_url, zipFile, (pct) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('update:progress', Math.floor(pct * 0.7));
        win.setProgressBar(pct / 100);
      }
    });

    // 2. Extract
    if (win && !win.isDestroyed()) {
      win.webContents.send('update:status', 'Extracting...');
      win.webContents.send('update:progress', 75);
      win.setProgressBar(0.75);
    }
    if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });
    await extractZip(zipFile, extractDir);

    // 3. Find the actual app folder inside extracted contents
    const sourceDir = findAppDir(extractDir);
    if (!sourceDir) throw new Error('Kanota.exe not found in extracted files');
    // Clean zip early
    try { fs.unlinkSync(zipFile); } catch (_) {}

    // 4. Copy new app files to newDir (next to current app)
    if (win && !win.isDestroyed()) {
      win.webContents.send('update:status', 'Preparing...');
      win.webContents.send('update:progress', 82);
      win.setProgressBar(0.82);
    }
    if (fs.existsSync(newDir)) fs.rmSync(newDir, { recursive: true, force: true });
    await copyDir(sourceDir, newDir);

    // Clean extract temp
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (_) {}

    if (!isPackaged()) {
      await dialog.showMessageBox({
        type: 'info', title: 'Download Complete',
        message: release.tag_name + ' ready',
        detail: 'Dev mode. New version at:\n' + newDir + '\n\nCurrent app at:\n' + appDir,
        buttons: ['Open new version', 'OK'],
      }).then(({ response }) => { if (response === 0) shell.openPath(newDir); });
      if (win && !win.isDestroyed()) win.setProgressBar(-1);
      return;
    }

    // 5. Write batch: swap folders (atomic rename) + restart
    const exe = app.getPath('exe');
    const batchFile = path.join(tmpDir, 'kanota-update.bat');
    const bakDir = path.join(appParent, appName + '_bak');
    const bat = [
      '@echo off',
      'chcp 65001 >nul',
      'set "APP_DIR=' + appDir + '"',
      'set "NEW_DIR=' + newDir + '"',
      'set "BAK_DIR=' + bakDir + '"',
      'set "EXE=' + exe + '"',
      '',
      'echo Kanota updating...',
      ':wait',
      'timeout /t 2 /nobreak >nul',
      'if exist "%EXE%" goto :wait',
      '',
      'echo Swapping to new version...',
      // Move current → bak, new → current
      'if exist "%BAK_DIR%" rmdir /s /q "%BAK_DIR"',
      'rename "%APP_DIR%" "' + appName + '_bak"',
      'if %errorlevel% neq 0 goto :fail',
      'rename "%NEW_DIR%" "' + appName + '"',
      'if %errorlevel% neq 0 (',
      '  rename "%BAK_DIR%" "' + appName + '"',
      '  echo Rolled back!',
      '  goto :fail',
      ')',
      // Copy data back from bak
      'echo Restoring user data...',
      'if exist "%BAK_DIR%\\data" robocopy "%BAK_DIR%\\data" "%APP_DIR%\\data" /E /IS /IT /NFL /NDL >nul',
      'rmdir /s /q "%BAK_DIR%" 2>nul',
      'echo Update complete! Starting Kanota...',
      'start "" "%EXE%"',
      'del /f /q "%~f0"',
      'exit /b 0',
      '',
      ':fail',
      'echo Update failed! Please download manually.',
      'pause',
      'del /f /q "%~f0"',
      'exit /b 1',
    ].join('\r\n');
    fs.writeFileSync(batchFile, bat, 'utf-8');

    if (win && !win.isDestroyed()) {
      win.webContents.send('update:status', 'Restarting...');
      win.webContents.send('update:progress', 100);
      win.setProgressBar(1);
    }

    exec('start "" cmd /c "' + batchFile + '"', { detached: true, stdio: 'ignore' });
    app.quit();
  } catch (e) {
    try { if (fs.existsSync(zipFile)) fs.unlinkSync(zipFile); } catch (_) {}
    try { if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true }); } catch (_) {}
    try { if (fs.existsSync(newDir)) fs.rmSync(newDir, { recursive: true, force: true }); } catch (_) {}
    if (win && !win.isDestroyed()) win.setProgressBar(-1);
    throw e;
  }
}

module.exports = { checkForUpdates, downloadAndInstall, cmpVersion };
