// Application wiring: connects a Source (BLE or Simulator) to the Store and UI.

import { BLEConnection } from './connection.js';
import { Simulator } from './simulator.js';
import { Store, recordingToCSV } from './store.js';
import { UI } from './ui.js';
import { absoluteForce } from './protocol.js';
import { settings, saveSettings } from './settings.js';
import * as fs from './filesave.js';

const store = new Store();
let connection = null;
let sessionMax = 0;
let lastUnit = null;
let activeSessionId = null;
let recInfoTimer = null;
let recordingNamed = false; // did the user type a name for the active recording?
let existingNames = new Set(); // lowercased Test ID-Sample names of saved sessions
let folderHandle = null; // chosen session-library folder (File System Access API)

// A folder is the session library when auto-save is on and a folder is chosen.
function usingFolder() { return settings.autoSave && !!folderHandle; }
async function folderGranted(prompt = false) { return fs.ensurePermission(folderHandle, { prompt }); }
async function getSessionActive(id) {
  return usingFolder() ? fs.readSession(folderHandle, id) : store.get(id);
}

const ui = new UI({
  onConnectToggle, onSimulate, onCommand, onResetMax, onClearGraph,
  onToggleRecord, onSelectSession, onRenameSession, onExportSession, onExportSessionGraph, onDeleteSession,
  onSetting, onDeviceSetting, onPowerOff, onChooseFolder, onRecordFieldChange, onExportGraph,
  onSessionSearch, onSessionSort,
});

let allSessions = [];          // full session summary list (unfiltered)
let sessionQuery = '';         // current search text
let sessionSort = 'date-desc'; // current sort mode

// Build a "Test ID-Sample" label, tolerating either field being blank.
function idLabel(testId, sample) {
  const t = (testId || '').trim(), s = (sample || '').trim();
  return t && s ? `${t}-${s}` : (t || s || '');
}
function fmtDateTime(ms) { try { return new Date(ms).toLocaleString(); } catch { return ''; } }
// Material is a list; join for display on graphs.
function matStr(m) { return Array.isArray(m) ? m.join(', ') : (m || ''); }

// Graph annotation metadata for a saved recording / for the live view.
function metaForRec(rec) {
  return {
    config: rec.config || '', material: matStr(rec.material),
    idLabel: idLabel(rec.testId, rec.sample) || rec.name,
    datetime: fmtDateTime(rec.startedAt),
    filenameBase: rec.name,
  };
}
function metaForLive() {
  const label = idLabel(settings.testId, settings.sample);
  return {
    config: settings.config || '', material: matStr(settings.material),
    idLabel: label, datetime: fmtDateTime(Date.now()),
    filenameBase: label || 'LineScale',
  };
}
function graphBlobFor(rec) {
  return ui.graphBlob({
    xs: rec.samples.map((s) => s.t / 1000),
    ys: rec.samples.map((s) => s.value),
    unit: rec.unit,
    ...metaForRec(rec),
  });
}

async function main() {
  // Coerce legacy single-string material to a list.
  if (!Array.isArray(settings.material)) settings.material = settings.material ? [settings.material] : [];
  // Build the UI first so the app renders immediately, independent of storage.
  ui.init();
  ui.initSettings(settings);
  ui.setFsSupported(fs.fsSupported());
  // ?sim=1 auto-starts the simulated device — do this before any storage await
  // so the live UI never waits on IndexedDB.
  if (new URLSearchParams(location.search).has('sim')) onSimulate();
  // Restore the previously chosen session-library folder, if any.
  if (fs.fsSupported()) {
    try { folderHandle = (await fs.savedFolder()) || null; } catch { /* ignore */ }
    ui.setFolderName(folderHandle ? folderHandle.name : null);
  }
  // Browser storage is the fallback library; open it regardless for migration.
  try { await store.open(); } catch (err) {
    ui.toast('Saved sessions unavailable: ' + (err.message || err), true);
  }
  await refreshSessions();
}

// ---- connection ----------------------------------------------------------

function wire(source) {
  source.onStatus((s) => {
    ui.setStatus(s.state, s.name);
    if (s.state === 'connecting') {
      ui.resetDiag();
    } else if (s.state === 'connected') {
      sessionMax = 0; lastUnit = null;
      ui.clearLive();
      ui.setMax(0);
    } else if (s.state === 'disconnected') {
      connection = null;
      if (store.recording) stopRecording(); // flush any in-progress recording
    }
  });
  source.onReading(handleReading);
  if (source.onDiag) source.onDiag((d) => {
    ui.diag(d);
    if (d.line) console.debug('[LS3]', d.line);
    if (d.raw) console.debug('[LS3] raw', d.raw.hex, '·', d.raw.ascii);
  });
  return source;
}

async function onConnectToggle() {
  if (connection) { await connection.disconnect(); return; }
  try {
    connection = wire(new BLEConnection());
    await connection.connect();
  } catch (err) {
    connection = null;
    ui.setStatus('disconnected');
    ui.toast(err.message || 'Connection failed', true);
  }
}

async function onSimulate() {
  if (connection) await connection.disconnect();
  connection = wire(new Simulator());
  await connection.connect();
  ui.toast('Simulated device running');
}

function handleReading(reading) {
  // Reset max if the unit changed (old max is in the old unit).
  if (lastUnit !== null && reading.unit !== lastUnit) { sessionMax = 0; }
  lastUnit = reading.unit;

  const abs = absoluteForce(reading);
  if (reading.value > sessionMax) sessionMax = reading.value;

  ui.setReading(reading, abs, false);
  ui.setMax(sessionMax, reading.unit);
  ui.pushLive(reading.value);

  if (store.recording) {
    store.append(reading, abs);
  }
}

async function onCommand(cmdName) {
  if (!connection) return;
  try {
    await connection.send(cmdName);
    if (cmdName === 'CLEAR_PEAK') sessionMax = 0; // mirror the device peak clear
  } catch (err) {
    ui.toast(err.message || 'Command failed', true);
  }
}

// Single "reset": clears the app-side max and, if connected, tells the device
// to clear its own peak-hold so the two stay in sync.
function onResetMax() {
  sessionMax = 0;
  ui.setMax(0, lastUnit);
  if (connection) connection.send('CLEAR_PEAK').catch((e) => ui.toast(e.message || 'Reset failed', true));
}

function onClearGraph() { ui.clearLive(); }

// ---- settings -------------------------------------------------------------

// App preferences (persisted).
async function onSetting(key, value) {
  settings[key] = value;
  saveSettings();
  if (key === 'debug') ui.toggleDebug(value);
  if (key === 'autoPauseOnHover') ui.setAutoPause(value);
  if (key === 'liveWindowS') ui.setLiveWindow(value);
  // Switching the session library on/off (folder vs browser storage).
  if (key === 'autoSave') {
    if (value) { if (folderHandle) await activateFolder(); else await onChooseFolder(); }
    await refreshSessions(); // reflect the new source (folder or browser)
  }
}

async function onChooseFolder() {
  if (!fs.fsSupported()) { ui.toast('Folder auto-save needs Chrome or Edge', true); return; }
  try {
    folderHandle = await fs.pickFolder();
    ui.setFolderName(folderHandle.name);
  } catch {
    return; // user dismissed the picker
  }
  if (settings.autoSave) await activateFolder();
  else ui.toast(`Folder set: ${folderHandle.name}`);
}

// Device-state settings — sent as BLE commands, only when connected.
async function onDeviceSetting(key, value) {
  if (!connection) return;
  try {
    if (key === 'rate') await connection.send(value === '40' ? 'SPEED_40HZ' : 'SPEED_10HZ');
    else if (key === 'zeroMode') await connection.send(value === 'abs' ? 'ZERO_MODE_ABS' : 'ZERO_MODE_REL');
  } catch (err) {
    ui.toast(err.message || 'Device command failed', true);
  }
}

function onPowerOff() {
  if (!connection) return;
  if (!confirm('Power off the LineScale 3? It will disconnect.')) return;
  connection.send('POWER_OFF').catch(() => {});
}

// ---- recording ------------------------------------------------------------

async function onToggleRecord(fields) {
  if (store.recording) { await stopRecording(); return; }
  if (!connection) return;
  if (settings.resetGraphOnRecord) ui.clearLive(); // fresh graph for the new recording

  recordingNamed = !!(fields.testId && fields.testId.trim());
  // Persist the (possibly edited) metadata fields.
  Object.assign(settings, {
    testId: fields.testId, sample: fields.sample || '01',
    config: fields.config, material: fields.material,
  });
  saveSettings();

  store.startRecording({
    testId: fields.testId, sample: fields.sample, config: fields.config, material: fields.material,
    name: idLabel(fields.testId, fields.sample),
  }, lastUnit || 'kN');
  ui.setRecordingState(true);
  recInfoTimer = setInterval(updateRecInfo, 250);
  updateRecInfo();
  // Pre-authorize the folder now (Start is a user gesture) so the save on
  // Stop is silent even after a page reload.
  if (settings.autoSave && folderHandle) fs.ensurePermission(folderHandle, { prompt: true });
}

function updateRecInfo() {
  const rec = store.current;
  if (!rec) return;
  const dur = ((Date.now() - rec.startedAt) / 1000).toFixed(1);
  ui.setRecInfo(`recording · ${rec.samples.length} pts · ${dur}s`);
}

async function stopRecording() {
  clearInterval(recInfoTimer);
  // Stop accumulating immediately so readings don't keep appending while the
  // name dialog is open (finalize without persisting yet).
  const rec = await store.stop({ persist: false });
  ui.setRecordingState(false);
  if (!rec) { await refreshSessions(); return; }

  // Prompt for a Test ID if none was given (Skip keeps the auto name).
  if (!recordingNamed) {
    const entered = await ui.promptName(rec.testId || '', 'Test ID');
    if (entered) {
      rec.testId = entered;
      settings.testId = entered; saveSettings(); ui.setRecordField('testId', entered);
    }
  }
  // Name = Test ID - Sample (falls back to the auto name when both are blank).
  rec.name = idLabel(rec.testId, rec.sample) || rec.name;

  // Save to the active library: the folder, or browser storage.
  if (usingFolder()) { if (rec.samples.length) await saveSessionToFolder(rec); }
  else await store.persist(rec);

  ui.setRecInfo(`saved “${rec.name}” (${rec.count} pts)`);
  advanceSample();
  await refreshSessions();
}

// Bump the sample number for the next recording (e.g. 01 -> 02).
function advanceSample() {
  const n = parseInt(settings.sample, 10);
  const next = String((Number.isFinite(n) ? n : 0) + 1).padStart(2, '0');
  settings.sample = next; saveSettings(); ui.setRecordField('sample', next);
}

// Write a finished recording's CSV + PNG to the chosen folder. Falls back to a
// normal download if permission is declined or the write fails.
async function saveSessionToFolder(rec) {
  if (!fs.fsSupported()) return;
  const csvBlob = new Blob([recordingToCSV(rec)], { type: 'text/csv' });
  let pngBlob = null;
  try { pngBlob = await graphBlobFor(rec); } catch { /* keep CSV even if the graph fails */ }

  const files = pngBlob ? { csv: csvBlob, png: pngBlob } : { csv: csvBlob };
  const ok = folderHandle && (await fs.ensurePermission(folderHandle, { prompt: true }));
  if (ok) {
    try {
      const base = await fs.saveFiles(folderHandle, rec.name, files);
      ui.toast(`Saved ${base}.csv${pngBlob ? ' + .png' : ''} to ${folderHandle.name}`);
      return;
    } catch (e) {
      ui.toast('Folder save failed (' + (e.message || e) + ') — downloaded instead', true);
    }
  } else {
    ui.toast('Folder not authorized — downloaded instead', true);
  }
  // Fallback: regular downloads so the data is never lost.
  for (const [ext, blob] of Object.entries(files)) ui._download(blob, `${ui._safeName(rec.name)}.${ext}`);
}

// ---- sessions -------------------------------------------------------------

async function refreshSessions() {
  let list;
  if (usingFolder()) {
    if (!(await folderGranted(false))) { ui.showReconnect(folderHandle.name, reconnectFolder); return; }
    list = await fs.listSessions(folderHandle);
  } else {
    list = await store.list();
  }
  ui.setMaterialOptions(materialsFromSessions(list));
  existingNames = new Set(list.map((s) => (s.name || '').toLowerCase()));
  checkDuplicate();
  allSessions = list;
  applySessionView();
}

// Filter (search) + sort the full session list, then render.
function applySessionView() {
  const q = sessionQuery.trim().toLowerCase();
  let view = allSessions;
  if (q) {
    view = view.filter((s) => {
      const hay = [s.name, s.config, ...(Array.isArray(s.material) ? s.material : [])]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }
  view = sortSessions(view, sessionSort);
  ui.renderSessions(view, activeSessionId);
  ui.setSessionsEmptyText(allSessions.length ? 'No sessions match your search.' : 'No saved sessions yet.');
}

function sortSessions(list, mode) {
  const by = {
    'date-desc': (a, b) => b.startedAt - a.startedAt,
    'date-asc': (a, b) => a.startedAt - b.startedAt,
    'max-desc': (a, b) => b.max - a.max,
    'max-asc': (a, b) => a.max - b.max,
    'dur-desc': (a, b) => b.duration - a.duration,
    'name-asc': (a, b) => (a.name || '').localeCompare(b.name || ''),
  };
  return [...list].sort(by[mode] || by['date-desc']);
}

function onSessionSearch(q) { sessionQuery = q; applySessionView(); }
function onSessionSort(mode) { sessionSort = mode; applySessionView(); }

// Material dropdown options come solely from materials used in saved sessions.
// (Typing a brand-new material adds it to the current recording; it becomes a
// selectable option once a session using it has been saved.) This set is also
// the basis for future material-based filtering/search of the session list.
function materialsFromSessions(list) {
  const set = new Set();
  for (const s of list) for (const m of (Array.isArray(s.material) ? s.material : [])) set.add(m);
  return [...set];
}

async function reconnectFolder() {
  if (await folderGranted(true)) await refreshSessions();
}

async function onSelectSession(id) {
  activeSessionId = id;
  if (id === null) { await refreshSessions(); return; }
  const rec = await getSessionActive(id);
  if (rec) ui.showSession(rec);
  await refreshSessions();
}

async function onRenameSession(id, name) {
  if (usingFolder()) {
    const newId = await fs.renameSession(folderHandle, id, name);
    if (activeSessionId === id) activeSessionId = newId;
  } else {
    await store.rename(id, name);
  }
  await refreshSessions();
}

// Open an already-saved file from the folder in a new browser tab (no
// download). A web app can't hand it to an OS app, so this is the closest.
// Opens a blank tab synchronously (within the click gesture) to dodge popup
// blocking, then points it at the file. Returns false if the file is absent.
async function openSessionFile(base, ext, isImage) {
  const win = window.open('', '_blank');
  try {
    const file = await fs.readFileBlob(folderHandle, `${base}.${ext}`);
    const blob = isImage ? file : new Blob([await file.text()], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    if (win) win.location.href = url; else window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return true;
  } catch {
    if (win) win.close();
    return false;
  }
}

// CSV icon: open the file in folder mode, else download a copy.
async function onExportSession(id) {
  if (usingFolder() && (await openSessionFile(id, 'csv', false))) return;
  const rec = await getSessionActive(id);
  if (!rec) return;
  ui._download(new Blob([recordingToCSV(rec)], { type: 'text/csv' }), `${ui._safeName(rec.name)}.csv`);
}

// Graph icon: open the saved PNG in folder mode, else render + download one.
async function onExportSessionGraph(id) {
  if (usingFolder() && (await openSessionFile(id, 'png', true))) return;
  const rec = await getSessionActive(id);
  if (!rec || !rec.samples.length) { ui.toast('No data in this session', true); return; }
  ui.exportGraphPNG({
    xs: rec.samples.map((s) => s.t / 1000),
    ys: rec.samples.map((s) => s.value),
    unit: rec.unit,
    ...metaForRec(rec),
  });
}

// Export the live view (or delegate to the loaded session's export).
async function onExportGraph() {
  if (activeSessionId) { await onExportSessionGraph(activeSessionId); return; }
  const d = ui.currentData();
  if (d.xs.length < 2) { ui.toast('Nothing to export yet', true); return; }
  ui.exportGraphPNG({ xs: d.xs, ys: d.ys, unit: d.unit, ...metaForLive() });
}

// Persist an edited metadata field; changing the Test ID resets the sample.
function onRecordFieldChange(key, value) {
  if (key === 'sample') value = normalizeSample(value);
  settings[key] = value;
  if (key === 'sample') ui.setRecordField('sample', value);
  if (key === 'testId') { settings.sample = '01'; ui.setRecordField('sample', '01'); }
  saveSettings();
  if (key === 'testId' || key === 'sample') checkDuplicate();
}

// Warn when the current Test ID-Sample already names a saved session.
function checkDuplicate() {
  const name = idLabel(settings.testId, settings.sample);
  const dup = name && existingNames.has(name.toLowerCase());
  ui.setRecordWarning(dup ? `“${name}” already exists in saved sessions` : '');
}

function normalizeSample(v) {
  const t = (v || '').trim();
  if (!t) return '01';
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? String(n).padStart(2, '0') : t;
}

async function onDeleteSession(id) {
  if (!confirm('Delete this session? This cannot be undone.')) return;
  if (usingFolder()) await fs.deleteSession(folderHandle, id);
  else await store.remove(id);
  if (activeSessionId === id) { activeSessionId = null; ui.showLive(); }
  await refreshSessions();
}

// Make the chosen folder the active library: copy any browser-cached sessions
// into it (skipping ones already present), then list from the folder.
async function activateFolder() {
  if (!folderHandle) return;
  if (!(await folderGranted(true))) { ui.toast('Folder not authorized', true); return; }
  let migrated = 0;
  try {
    for (const s of await store.list()) {
      if (await fs.hasSession(folderHandle, s.name)) continue;
      const rec = await store.get(s.id);
      if (!rec || !rec.samples.length) continue;
      const csvBlob = new Blob([recordingToCSV(rec)], { type: 'text/csv' });
      let pngBlob = null;
      try { pngBlob = await graphBlobFor(rec); } catch { /* csv only */ }
      await fs.saveFiles(folderHandle, rec.name, pngBlob ? { csv: csvBlob, png: pngBlob } : { csv: csvBlob });
      migrated++;
    }
  } catch (e) { ui.toast('Migration error: ' + (e.message || e), true); }
  if (migrated) ui.toast(`Copied ${migrated} session${migrated > 1 ? 's' : ''} into ${folderHandle.name}`);
  await refreshSessions();
}

main();
