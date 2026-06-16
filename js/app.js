// Application wiring: connects a Source (BLE or Simulator) to the Store and UI.

import { BLEConnection } from './connection.js';
import { ENFORCER_PROFILE } from './profiles.js';
import { Simulator } from './simulator.js';
import { EnforcerSimulator } from './enforcer-sim.js';
import { DiscoverySource } from './discovery.js';
import { tareEnforcer } from './enforcer.js';
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
const UNIT_CMD = { kN: 'UNIT_KN', kgf: 'UNIT_KGF', lbf: 'UNIT_LBF' };
let channels = [];     // [{ id, source, label, color, kind, unit, current, max, rate, battery, overloaded, name }]
let connection = null; // = channels[0]?.source
let nextChanId = 1;
let sampleTimer = null; // shared ~33 ms live-graph sampler

// Channels that have finished connecting — the only ones shown in the UI /
// charted / sampled (a connecting device isn't displayed until it succeeds).
function connectedChannels() { return channels.filter((c) => c.connected); }

let activeSessionId = null;
let recInfoTimer = null;
let recordingNamed = false; // did the user type a name for the active recording?
let recordingVideo = false; // is the camera feed being recorded with this session?
let recordingOnGoPro = false; // did we trigger on-camera (SD) recording for this session?
let recordingOnRecorder = false; // did we trigger the record-only (BLE) GoPro for this session?
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
  onConnect, onConnectEnforcer, onDiscover, onProbeWrite, onSimulate, onClearGraph,
  onDisconnectAll, onChannelDisconnect, onChannelLabel, onChannelCommand, onChannelReset, onChannelColor,
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
  refreshDeviceUI(); // empty state: red circle + "Connect Device" card
  ui.setFsSupported(fs.fsSupported());
  // ?sim=1 auto-starts the simulated device — do this before any storage await
  // so the live UI never waits on IndexedDB.
  const params = new URLSearchParams(location.search);
  if (params.has('sim')) onSimulate();
  if (params.has('simEnforcer')) onSimulateEnforcer();
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
  const kind = source.deviceLabel || 'Device';
  // Smallest unused number for this device kind, so removing #1 frees it for the
  // next device of that kind (instead of monotonically counting up).
  const usedNums = new Set(channels.filter((c) => c.kind === kind).map((c) => c.seq));
  let n = 1; while (usedNums.has(n)) n++;
  // Smallest unused line color across all current channels (kept distinct).
  const usedColors = new Set(channels.map((c) => c.color));
  const color = CHAN_COLORS.find((c) => !usedColors.has(c)) || CHAN_COLORS[channels.length % CHAN_COLORS.length];
  const ch = {
    id, source, seq: n,
    label: `${kind} #${n}`,
    color, kind, connected: false,
    unit: null, current: 0, max: 0, rate: null, battery: null, overloaded: false, name: '',
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

  // The device panel, chart series, and sampler only appear once the device
  // actually connects (see onChannelStatus) — not while connecting.
  try {
    await source.connect();
    // Force the new device to the global unit so all devices match. Devices that
    // can't switch units (e.g. the Enforcer) opt out via canSetUnit.
    if (source.canSetUnit !== false) {
      const cmd = UNIT_CMD[settings.unit] || 'UNIT_KN';
      source.send(cmd).catch(() => {});
    }
  } catch (err) {
    removeChannel(ch); // connect failed — undo the half-added channel
    ui.toast(err.message || 'Connection failed', true);
  }
}

function onChannelStatus(ch, s) {
  const isPrimary = ch === channels[0];
  if (s.state === 'connecting') {
    if (isPrimary) ui.resetDiag();
  } else if (s.state === 'connected') {
    ch.name = s.name || ch.kind;
    ch.connected = true; // now reveal it in the UI / chart / sampler
    if (isPrimary) { ch.max = 0; ch.unit = null; }
    ui.setChannels(connectedChannels());
    refreshDeviceUI();
    startSampler();
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
  ui.setChannels(connectedChannels());
  refreshDeviceUI();
  if (!connectedChannels().length) {
    stopSampler();
    if (store.recording) stopRecording(); // flush any in-progress recording
  }
}

// Reflect the channel set into the connection circle/list + per-channel strip.
function refreshDeviceUI() {
  ui.setDevices(connectedChannels().map((c) => ({ id: c.id, label: c.label, kind: c.kind })));
  renderChannelStrip();
}

function renderChannelStrip() {
  ui.renderChannels(connectedChannels().map((c) => ({
    id: c.id, label: c.label, color: c.color, kind: c.kind, type: c.source.deviceType,
    current: c.current, max: c.max, unit: c.unit || '',
    rate: c.rate, battery: c.battery, overloaded: c.overloaded,
  })));
}

// Shared live-graph sampler: ~30 Hz, appends one frame (shared time + each
// channel's latest value) so all lines stay aligned on a common x-axis.
function startSampler() {
  if (sampleTimer) return;
  sampleTimer = setInterval(() => {
    ui.sampleFrame(connectedChannels().map((c) => (c.unit === null ? null : c.current)));
  }, 33);
}
function stopSampler() {
  clearInterval(sampleTimer); sampleTimer = null;
}

async function onConnect() {
  await addChannel(new BLEConnection());
}

// Connect a Rock Exotica Enforcer (scaffold: pairs but won't stream until the
// protocol is captured/decoded — use Discovery mode to capture it first).
async function onConnectEnforcer() {
  await addChannel(new BLEConnection(ENFORCER_PROFILE));
}

// Discovery / capture mode: connect to any BLE device and dump its services,
// characteristics, and raw notifications to the debug panel for decoding.
async function onDiscover() {
  let extra = [];
  const entered = prompt(
    'Discovery mode\n\nOptional: paste the device service UUID(s) to expose ' +
    '(comma-separated). Web Bluetooth can only read services listed up front.\n\n' +
    'Leave blank to scan common services.',
  );
  if (entered) extra = entered.split(/[\s,]+/).filter(Boolean);
  await addChannel(new DiscoverySource(extra));
}

// Run the fake Enforcer (UI testing without hardware or a decoded protocol).
async function onSimulateEnforcer() {
  await addChannel(new EnforcerSimulator());
  ui.toast('Enforcer simulator running');
}

// Probe-write arbitrary hex to a characteristic on the connected Discovery device.
async function onProbeWrite(charUuid, hex) {
  const ch = channels.find((c) => typeof c.source.writeHex === 'function');
  if (!ch) { ui.toast('Connect Discovery mode first', true); return; }
  try { await ch.source.writeHex(charUuid, hex); }
  catch (e) { ui.toast(e.message || 'Write failed', true); }
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
  ui.setChannels(connectedChannels()); // updates the graph legend
}

// Per-channel device command (Zero / Tare / unit change). CLEAR_PEAK also
// clears that channel's app-side max so the two stay in sync.
async function onChannelCommand(id, cmd) {
  const ch = channels.find((c) => c.id === id);
  if (!ch) return;
  // The Enforcer has no device-side zero; Zero/Tare do a software tare instead
  // (subtract the current raw count as the new baseline, like the official app).
  if (ch.source.deviceType === 'enforcer' && (cmd === 'ZERO' || cmd === 'SET_ABS_ZERO')) {
    tareEnforcer();
    ch.max = 0;
    renderChannelStrip();
    ui.toast('Zeroed');
    return;
  }
  try {
    await ch.source.send(cmd);
    if (cmd === 'CLEAR_PEAK') { ch.max = 0; renderChannelStrip(); }
  } catch (err) {
    ui.toast(err.message || 'Command failed', true);
  }
}

// Per-channel "reset": clears that channel's app-side max and tells the device
// to clear its own peak-hold so the two stay in sync.
function onChannelReset(id) {
  const ch = channels.find((c) => c.id === id);
  if (!ch) return;
  ch.max = 0;
  renderChannelStrip();
  ch.source.send('CLEAR_PEAK').catch((e) => ui.toast(e.message || 'Reset failed', true));
}

// Change a channel's line color (from its bar's swatch picker): update state,
// recolor the chart line, and re-render the bars.
function onChannelColor(id, color) {
  const ch = channels.find((c) => c.id === id);
  if (!ch) return;
  ch.color = color;
  ui.setChannels(connectedChannels()); // recolor the chart line
  renderChannelStrip();      // update the swatch
}

function handleReading(ch, reading) {
  const isPrimary = ch === channels[0];
  // Reset this channel's max if its unit changed (old max is in the old unit).
  if (ch.unit !== null && reading.unit !== ch.unit) ch.max = 0;
  ch.unit = reading.unit;

  const abs = absoluteForce(reading);
  if (reading.value > ch.max) ch.max = reading.value;
  ch.current = reading.value;
  ch.rate = reading.speedHz ?? null;
  ch.battery = reading.battery;
  ch.overloaded = !!reading.overloaded;

  // Reflect the primary device's rate/zero-mode into the Settings selects.
  if (isPrimary) ui.reflectDeviceState(reading);
  // Record every channel that was present when recording started.
  if (store.recording && recChanIndex.has(ch.id)) {
    store.appendChannel(recChanIndex.get(ch.id), reading, abs);
  }
  renderChannelStrip();
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
  // Global unit: force every connected device to the chosen unit.
  if (key === 'unit') {
    const cmd = UNIT_CMD[value] || 'UNIT_KN';
    try { await Promise.all(channels.filter((c) => c.source.canSetUnit !== false).map((c) => c.source.send(cmd))); }
    catch (err) { ui.toast(err.message || 'Unit change failed', true); }
  }
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

// Device-state settings — sent as BLE commands to EVERY connected device.
async function onDeviceSetting(key, value) {
  if (!channels.length) return;
  let cmd = null;
  if (key === 'rate') cmd = value === '40' ? 'SPEED_40HZ' : 'SPEED_10HZ';
  else if (key === 'zeroMode') cmd = value === 'abs' ? 'ZERO_MODE_ABS' : 'ZERO_MODE_REL';
  if (!cmd) return;
  try {
    await Promise.all(channels.map((c) => c.source.send(cmd)));
  } catch (err) {
    ui.toast(err.message || 'Device command failed', true);
  }
}

function onPowerOff() {
  if (!channels.length) return;
  if (!confirm('Power off all connected devices? They will disconnect.')) return;
  for (const c of channels) c.source.send('POWER_OFF').catch(() => {});
}

// ---- recording ------------------------------------------------------------

async function onToggleRecord(fields) {
  if (store.recording) { await stopRecording(); return; }
  if (!connection) return;
  // Save to a folder by default: if that's on but no folder is chosen yet, ask now —
  // Start is a user gesture, so the directory picker is allowed. (Cancel → this
  // recording falls back to browser storage.)
  if (settings.autoSave && !folderHandle && fs.fsSupported()) {
    try {
      folderHandle = await fs.pickFolder();
      ui.setFolderName(folderHandle.name);
      await refreshSessions();
    } catch {
      ui.toast('No folder chosen — saving to browser storage', true);
    }
  }
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
  // Record the live camera feed too, but only when saving to a folder (video is
  // folder-only by design). The live feed still shows even without recording.
  recordingVideo = usingFolder() && ui.cameraLive() && ui.cameraStartRec();
  // Optionally trigger a full-res recording on the streaming GoPro's own SD card.
  recordingOnGoPro = settings.recordOnGoPro && ui.cameraLive() && ui.triggerCameraRecord(true);
  // A record-only (BLE) GoPro always records with the session when connected.
  recordingOnRecorder = ui.triggerRecorderRecord(true);
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
  // Stop video immediately (don't keep buffering while the name dialog is open).
  const videoBlob = recordingVideo ? ui.cameraStopRec() : null;
  recordingVideo = false;
  if (recordingOnGoPro) { ui.triggerCameraRecord(false); recordingOnGoPro = false; }
  if (recordingOnRecorder) { ui.triggerRecorderRecord(false); recordingOnRecorder = false; }
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
  if (videoBlob) rec.videoBlob = videoBlob;

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
  if (rec.videoBlob) files.mp4 = rec.videoBlob; // recorded camera clip, same base name
  const ok = folderHandle && (await fs.ensurePermission(folderHandle, { prompt: true }));
  if (ok) {
    try {
      const base = await fs.saveFiles(folderHandle, rec.name, files);
      ui.toast(`Saved ${base}.csv${pngBlob ? ' + .png' : ''}${rec.videoBlob ? ' + .mp4' : ''} to ${folderHandle.name}`);
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
    if (!(await folderGranted(false))) { armFolderReconnect(); return; }
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

// The File System Access API won't re-grant a restored folder handle without a
// user gesture, so we can't silently reconnect on load. Instead, re-grant on the
// user's FIRST interaction (any click/keypress) — one allow dialog at most, no
// hunting for a button. In Electron the permission is auto-granted, so this path
// usually isn't even reached. If the user denies, fall back to the manual prompt.
let folderReconnectArmed = false;
function armFolderReconnect() {
  ui.setFolderName(folderHandle.name); // keep showing which folder is configured
  if (folderReconnectArmed) return;
  folderReconnectArmed = true;
  const onGesture = async () => {
    window.removeEventListener('pointerdown', onGesture, true);
    window.removeEventListener('keydown', onGesture, true);
    folderReconnectArmed = false;
    if (await fs.ensurePermission(folderHandle, { prompt: true })) await refreshSessions();
    else ui.showReconnect(folderHandle.name, reconnectFolder); // denied — offer manual re-pick
  };
  window.addEventListener('pointerdown', onGesture, true);
  window.addEventListener('keydown', onGesture, true);
}

async function reconnectFolder() {
  // Re-pick the folder to restore access. requestPermission on a handle restored
  // across a reload can silently fail to prompt, so the directory picker is the
  // reliable path — it must be the first call in this click so the user gesture
  // is still live. Picking the same folder re-grants permission and refreshes
  // the stored handle.
  try {
    folderHandle = await fs.pickFolder();
    ui.setFolderName(folderHandle.name);
  } catch { return; } // user dismissed the picker
  await refreshSessions();
}

async function onSelectSession(id) {
  activeSessionId = id;
  if (id === null) { refreshDeviceUI(); await refreshSessions(); return; } // restore live device bars
  const rec = await getSessionActive(id);
  if (rec) {
    // Attach the recorded clip (folder mode) so the UI can play it back.
    if (usingFolder()) {
      try { rec.videoBlob = await fs.readFileBlob(folderHandle, `${id}.mp4`); } catch { /* no video */ }
    }
    ui.showSession(rec);
  }
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
      // Preserve the recorded video — deleteSession() also removes the .mp4, so
      // read it first and re-save it under the (possibly new) name. A File from
      // getFile() reads lazily from disk, so it must be materialized into memory
      // BEFORE the delete — otherwise the re-save reads a deleted file (0 bytes).
      let mp4Blob = null;
      try {
        const f = await fs.readFileBlob(folderHandle, `${id}.mp4`);
        mp4Blob = new Blob([await f.arrayBuffer()], { type: 'video/mp4' });
      } catch { /* no video */ }
      await fs.deleteSession(folderHandle, id); // remove old files (name may change)
      const files = pngBlob ? { csv: csvBlob, png: pngBlob } : { csv: csvBlob };
      if (mp4Blob) files.mp4 = mp4Blob;
      await fs.saveFiles(folderHandle, rec.name, files);
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
