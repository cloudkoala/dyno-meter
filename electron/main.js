// Electron main process for Dyno-Meter.
//
// - Serves the existing web app (index.html / js / css / vendor) over an internal
//   http://127.0.0.1 origin so ES modules, Web Bluetooth (secure context) and the
//   File System Access API behave exactly as they do under `python -m http.server`.
// - Runs the GoPro bridge in-process (bundled ffmpeg) so there's no separate launcher.
// - Handles Web Bluetooth device selection (Electron requires the app to pick).
//
// CommonJS so we can `require('electron')`/`require('ffmpeg-static')`; the ESM bridge
// module is loaded with dynamic import().

const { app, BrowserWindow, ipcMain, session } = require('electron');
const http = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const ffmpegStatic = require('ffmpeg-static');
const { joinWifi, currentWifi } = require('./wifi');

const ROOT = path.join(__dirname, '..'); // repo root = the renderer files
// Fixed port → stable origin (http://127.0.0.1:PORT) so localStorage/IndexedDB
// (settings, saved folder handle, sessions) persist across launches. A random
// port would change the origin every launch and lose all of it.
const PORT = 8123;
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};

let win = null;
let server = null;
let bridge = null;
let bleCallback = null; // pending Web Bluetooth device-selection callback

// Tiny static file server for the renderer (localhost only).
function startStaticServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer(async (req, res) => {
      try {
        let p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        if (p === '/') p = '/index.html';
        const filePath = path.normalize(path.join(ROOT, p));
        if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end(); return; } // no path traversal
        const body = await readFile(filePath);
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404); res.end('Not found');
      }
    });
    server.on('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(PORT));
  });
}

function createWindow(port) {
  win = new BrowserWindow({
    width: 1280,
    height: 880,
    backgroundColor: '#0e1116',
    title: 'Dyno-Meter',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(`http://127.0.0.1:${port}/`);

  // Web Bluetooth: webContents fires this (repeatedly, as devices are discovered) and
  // expects us to choose. Forward the list to the renderer's picker; it calls back
  // with a deviceId (or '' to cancel) via IPC.
  win.webContents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();
    bleCallback = callback;
    win.webContents.send('ble-devices', devices.map((d) => ({
      deviceId: d.deviceId, deviceName: d.deviceName || '(unnamed device)',
    })));
  });
  win.on('closed', () => { win = null; });
}

ipcMain.on('ble-select', (_e, deviceId) => { if (bleCallback) { bleCallback(deviceId || ''); bleCallback = null; } });
ipcMain.on('ble-cancel', () => { if (bleCallback) { bleCallback(''); bleCallback = null; } });

// Join the GoPro's Wi-Fi AP (SSID/password obtained over BLE in the renderer).
ipcMain.handle('join-wifi', async (_e, creds) => joinWifi(creds));
// The SSID this computer is currently on (to skip BLE if already on the GoPro AP).
ipcMain.handle('current-wifi', async () => currentWifi());

// Single instance only — a second instance would clash on the fixed ports (and split
// storage). Focus the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

  app.whenReady().then(async () => {
    // Trusted local app (its own 127.0.0.1 origin): auto-grant permissions so a
    // saved session folder reconnects on launch without a dialog, and the File
    // System Access / Bluetooth flows aren't blocked.
    session.defaultSession.setPermissionCheckHandler(() => true);
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
    const { startBridge } = await import('../gopro-bridge/bridge.js');
    const port = await startStaticServer();
    // Embedded GoPro bridge with bundled ffmpeg; serves ws://localhost:8088 like the CLI,
    // so js/camera.js connects to it unchanged.
    bridge = startBridge({ ffmpegPath: ffmpegStatic });
    createWindow(port);
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(port); });
  });
}

app.on('window-all-closed', () => app.quit());
app.on('quit', () => {
  try { bridge && bridge.stop(); } catch { /* ignore */ }
  try { server && server.close(); } catch { /* ignore */ }
});
