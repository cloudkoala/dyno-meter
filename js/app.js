// Application wiring: connects a Source (BLE or Simulator) to the Store and UI.

import { BLEConnection } from './connection.js';
import { Simulator } from './simulator.js';
import { Store, recordingToCSV, asChannels } from './store.js';
import { UI } from './ui.js';
import { absoluteForce } from './protocol.js';
import { settings, saveSettings } from './settings.js';
import * as fs from './filesave.js';

const store = new Store();

// Multi-device "channels". Each channel wraps one Source plus its live state.
// channels[0] is the PRIMARY: it drives the hero readout, device controls,
// settings, and (for this stage) recording. `connection` always mirrors the
// primary source so the existing primary-only code keeps working.
const CHAN_COLORS = ['#3fb6ff', '#ffb020', '#2ec36a', '#ff5252', '#b06fff', '#ff8f3f'];
let channels = [];     // [{ id, source, label, color, unit, current, max, name }]
let connection = null; // = channels[0]?.source
let nextChanId = 1;
let sampleTimer = null; // shared ~33 ms live-graph sampler

let activeSessionId = null;
let recInfoTimer = null;
let recordingNamed = false; // did the user type a name for the active recording?
// Map from live-channel id -> recording-channel index, fixed when recording
// starts. Channels added mid-recording aren't in the map (ignored); removed
// channels simply stop appending.
let recChanIndex = new Map();
let existingNames = new Set(); // lowercased Test ID-Sample names of saved sessions
let folderHandle = null; // chosen session-library folder (File System Access API)

// A folder is the session library when auto-save is on and a folder is chosen.
function usingFolder() { return settings.autoSave && !!folderHandle; }
async function folderGranted(prompt = false) { return fs.ensurePermission(folderHandle, { prompt }); }
async function getSessionActive(id) {
  return usingFolder() ? fs.readSession(folderHandle, id) : store.get(id);
}

const ui = new UI({
  onConnect, onSimulate, onCommand, onResetMax, onClearGraph,
  onDisconnectAll, onChannelDisconnect, onChannelLabel,
  onToggleRecord, onSelectSession, onRenameSession, onExportSession, onExportSessionGraph, onDeleteSession,
  onSetting, onDeviceSetting, onPowerOff, onChooseFolder, onRecordFieldChange, onExportGraph,
  onSessionSearch, onSessionSort, onEditSession,
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

// Live chart header from the current record metadata.
function updateLiveTitle() {
  ui.setLiveHeader({
    id: idLabel(settings.testId, settings.sample) || 'Live',
    config: settings.config || '',
    material: matStr(settings.material),
  });
}

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
// Build graphBlob/exportGraphPNG options for a recording, using the channels
// normalizer so legacy single-channel recs keep the original single-series look
// and multi-channel recs render one colored, labeled line each.
function graphOptsFor(rec) {
  const chans = asChannels(rec);
  const unit = chans[0]?.unit || rec.unit;
  if (chans.length < 2) {
    const s = chans[0].samples;
    return { xs: s.map((x) => x.t / 1000), ys: s.map((x) => x.value), unit, ...metaForRec(rec) };
  }
  return {
    unit,
    channels: chans.map((c, i) => ({
      label: c.label || `Channel ${i + 1}`,
      color: CHAN_COLORS[i % CHAN_COLORS.length],
      xs: c.samples.map((x) => x.t / 1000),
      ys: c.samples.map((x) => x.value),
    })),
    ...metaForRec(rec),
  };
}
function graphBlobFor(rec) {
  return ui.graphBlob(graphOptsFor(rec));
}

async function main() {
  // Coerce legacy single-string material to a list.
  if (!Array.isArray(settings.material)) settings.material = settings.material ? [settings.material] : [];
  // Build the UI first so the app renders immediately, independent of storage.
  ui.init();
  ui.initSettings(settings);
  updateLiveTitle();
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

// ---- channels / connection ------------------------------------------------

// Add a new channel for the given source, wire its events, and connect it.
async function addChannel(source) {
  const id = nextChanId++;
  const idx = channels.length;
  const ch = {
    id, source,
    label: `Channel ${idx + 1}`,
    color: CHAN_COLORS[idx % CHAN_COLORS.length],
    unit: null, current: 0, max: 0, name: '',
  };
  channels.push(ch);
  if (channels.length === 1) connection = source; // first device is the primary

  source.onStatus((s) => onChannelStatus(ch, s));
  source.onReading((r) => handleReading(ch, r));
  if (source.onDiag) source.onDiag((d) => {
    if (ch !== channels[0]) return; // diagnostics follow the primary only
    ui.diag(d);
    if (d.line) console.debug('[LS3]', d.line);
    if (d.raw) console.debug('[LS3] raw', d.raw.hex, '·', d.raw.ascii);
  });

  ui.setChannels(channels);
  renderChannelStrip();
  startSampler();
  try {
    await source.connect();
  } catch (err) {
    removeChannel(ch); // connect failed — undo the half-added channel
    ui.toast(err.message || 'Connection failed', true);
  }
}

function onChannelStatus(ch, s) {
  const isPrimary = ch === channels[0];
  if (isPrimary) ui.setStatus(s.state, s.name);
  if (s.state === 'connecting') {
    if (isPrimary) ui.resetDiag();
  } else if (s.state === 'connected') {
    ch.name = s.name || 'LineScale 3';
    if (isPrimary) { ch.max = 0; ch.unit = null; ui.setMax(0); }
    refreshDeviceUI();
  } else if (s.state === 'disconnected') {
    removeChannel(ch);
  }
}

// Remove a channel (its source disconnected or failed). Re-points the primary
// and stops any in-progress recording when the last device goes away.
function removeChannel(ch) {
  const i = channels.indexOf(ch);
  if (i === -1) return;
  channels.splice(i, 1);
  connection = channels[0]?.source || null;
  ui.setChannels(channels);
  refreshDeviceUI();
  if (!channels.length) {
    stopSampler();
    ui.setStatus('disconnected');
    if (store.recording) stopRecording(); // flush any in-progress recording
  }
}

// Reflect the channel set into the device pill + per-channel strip.
function refreshDeviceUI() {
  ui.setDeviceSummary(channels.length, channels[0]?.name);
  renderChannelStrip();
}

function renderChannelStrip() {
  ui.renderChannels(channels.map((c) => ({
    id: c.id, label: c.label, color: c.color,
    current: c.current, max: c.max, unit: c.unit || '',
  })));
}

// Shared live-graph sampler: ~30 Hz, appends one frame (shared time + each
// channel's latest value) so all lines stay aligned on a common x-axis.
function startSampler() {
  if (sampleTimer) return;
  sampleTimer = setInterval(() => {
    ui.sampleFrame(channels.map((c) => (c.unit === null ? null : c.current)));
  }, 33);
}
function stopSampler() {
  clearInterval(sampleTimer); sampleTimer = null;
}

async function onConnect() {
  await addChannel(new BLEConnection());
}

async function onSimulate() {
  await addChannel(new Simulator());
  ui.toast('Simulated device running');
}

async function onDisconnectAll() {
  for (const ch of [...channels]) await ch.source.disconnect();
}

async function onChannelDisconnect(id) {
  const ch = channels.find((c) => c.id === id);
  if (ch) await ch.source.disconnect();
}

function onChannelLabel(id, label) {
  const ch = channels.find((c) => c.id === id);
  if (!ch) return;
  ch.label = label;
  ui.setChannels(channels); // updates the graph legend
}

function handleReading(ch, reading) {
  const isPrimary = ch === channels[0];
  // Reset this channel's max if its unit changed (old max is in the old unit).
  if (ch.unit !== null && reading.unit !== ch.unit) ch.max = 0;
  ch.unit = reading.unit;

  const abs = absoluteForce(reading);
  if (reading.value > ch.max) ch.max = reading.value;
  ch.current = reading.value;

  if (isPrimary) {
    ui.setReading(reading, abs, false);
    ui.setMax(ch.max, reading.unit);
  }
  // Record every channel that was present when recording started.
  if (store.recording && recChanIndex.has(ch.id)) {
    store.appendChannel(recChanIndex.get(ch.id), reading, abs);
  }
  renderChannelStrip();
}

async function onCommand(cmdName) {
  if (!connection) return;
  try {
    await connection.send(cmdName);
    if (cmdName === 'CLEAR_PEAK' && channels[0]) channels[0].max = 0; // mirror the device peak clear
  } catch (err) {
    ui.toast(err.message || 'Command failed', true);
  }
}

// Single "reset": clears the primary's app-side max and, if connected, tells
// the device to clear its own peak-hold so the two stay in sync.
function onResetMax() {
  if (channels[0]) channels[0].max = 0;
  ui.setMax(0, channels[0]?.unit);
  renderChannelStrip();
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
  updateLiveTitle();

  // Snapshot the currently-connected channels: one recording channel each, in
  // channel order, with a live-id -> recording-index map for handleReading.
  const snapshot = [...channels];
  recChanIndex = new Map();
  const specs = snapshot.map((c, i) => {
    recChanIndex.set(c.id, i);
    return { label: c.label, unit: c.unit || channels[0]?.unit || 'kN' };
  });
  store.startRecording({
    testId: fields.testId, sample: fields.sample, config: fields.config, material: fields.material,
    name: idLabel(fields.testId, fields.sample),
  }, specs);
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
  const pts = rec.channels.reduce((n, c) => n + c.samples.length, 0);
  ui.setRecInfo(`recording · ${pts} pts · ${dur}s`);
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
  if (usingFolder()) { if (rec.count) await saveSessionToFolder(rec); }
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
  updateLiveTitle();
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

// Download a copy of the session's CSV (the saved file in folder mode, else
// generated from the record).
async function onExportSession(id) {
  if (usingFolder()) {
    try { ui._download(await fs.readFileBlob(folderHandle, `${id}.csv`), `${id}.csv`); return; } catch { /* fall through */ }
  }
  const rec = await getSessionActive(id);
  if (!rec) return;
  ui._download(new Blob([recordingToCSV(rec)], { type: 'text/csv' }), `${ui._safeName(rec.name)}.csv`);
}

// Download a copy of the session's graph PNG (the saved file in folder mode,
// else rendered from the record).
async function onExportSessionGraph(id) {
  if (usingFolder()) {
    try { ui._download(await fs.readFileBlob(folderHandle, `${id}.png`), `${id}.png`); return; } catch { /* fall through */ }
  }
  const rec = await getSessionActive(id);
  const hasData = rec && asChannels(rec).some((c) => c.samples.length);
  if (!hasData) { ui.toast('No data in this session', true); return; }
  ui.exportGraphPNG(graphOptsFor(rec));
}

// Edit a saved session's Test ID / Sample / Material / Config.
async function onEditSession(id) {
  const rec = await getSessionActive(id);
  if (!rec) return;
  const edited = await ui.openEditModal(rec);
  if (!edited) return;
  rec.testId = edited.testId;
  rec.sample = edited.sample;
  rec.config = edited.config;
  rec.material = edited.material;
  rec.name = idLabel(rec.testId, rec.sample) || rec.name;

  if (usingFolder()) {
    if (!(await folderGranted(true))) { ui.toast('Folder not authorized', true); return; }
    try {
      const csvBlob = new Blob([recordingToCSV(rec)], { type: 'text/csv' });
      let pngBlob = null;
      try { pngBlob = await graphBlobFor(rec); } catch { /* csv only */ }
      await fs.deleteSession(folderHandle, id); // remove old files (name may change)
      await fs.saveFiles(folderHandle, rec.name, pngBlob ? { csv: csvBlob, png: pngBlob } : { csv: csvBlob });
    } catch (e) { ui.toast('Edit save failed: ' + (e.message || e), true); }
  } else {
    await store.persist(rec); // IndexedDB id unchanged
  }
  if (activeSessionId === id) { activeSessionId = null; ui.showLive(); }
  await refreshSessions();
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
  updateLiveTitle();
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
