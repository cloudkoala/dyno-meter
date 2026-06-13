// View layer: owns the DOM and the uPlot chart. Emits user intents via the
// `handlers` object; receives data via its update methods. Knows nothing about
// BLE or storage.

import { MultiSelect } from './multiselect.js';
import { asChannels } from './store.js';
import { CameraFeed } from './camera.js';
import { enableGoProWifi } from './gopro-ble.js';

// Colors for multi-channel session rendering / PNG export (mirrors app.js).
const CHAN_COLORS = ['#3fb6ff', '#ffb020', '#2ec36a', '#ff5252', '#b06fff', '#ff8f3f'];

// Display helper: material is a list; join for single-line display.
const matStr = (m) => (Array.isArray(m) ? m.join(', ') : (m || ''));

// Value of a session channel at time tMs (nearest sample at or before t).
// ch = { times: number[] (sorted ms), values: number[] }.
function valueAt(ch, tMs) {
  const t = ch.times;
  if (!t.length) return 0;
  if (tMs <= t[0]) return ch.values[0];
  if (tMs >= t[t.length - 1]) return ch.values[t.length - 1];
  let lo = 0, hi = t.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (t[mid] <= tMs) lo = mid; else hi = mid - 1; }
  return ch.values[lo];
}

// Format a readout value with a fixed-width sign slot so the layout never
// reflows when a value goes negative: U+2212 minus for negatives, U+2007 figure
// space (digit width) otherwise. Relies on tabular-nums on the value.
const SIGN_NEG = String.fromCharCode(0x2212); // minus sign
const SIGN_POS = String.fromCharCode(0x2007); // figure space (digit width)
const fmtSigned = (v) => (v < 0 ? SIGN_NEG : SIGN_POS) + Math.abs(v).toFixed(2);

// Step the trailing integer in a string by delta, preserving any prefix and
// zero-pad width (e.g. "01"->"02", "Beam-09"->"Beam-10"). Floors at 0; an empty
// value steps up to "1". Non-numeric text without a trailing number is unchanged.
function stepTrailingNumber(str, delta) {
  const s = String(str ?? '');
  const m = s.match(/^(.*?)(\d+)$/);
  if (!m) return s.trim() === '' ? (delta > 0 ? '1' : '') : s;
  const next = Math.max(0, parseInt(m[2], 10) + delta);
  return m[1] + String(next).padStart(m[2].length, '0');
}

const $ = (id) => document.getElementById(id);

const TRASH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
const SHARE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>';
const PENCIL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>';

export class UI {
  constructor(handlers) {
    this.h = handlers;
    this.viewMode = 'live'; // 'live' | 'session'
    this.lx = [];           // live x (seconds, relative to first sample)
    this.lys = [[]];        // live y per channel (parallel arrays); [0] is the primary
    this.channels = [];     // channel descriptors shown on the live chart [{id,label,color}]
    this.t0 = null;
    this._redrawQueued = false;
    this.chart = null;
    this.windowS = 60;      // live chart history window (seconds)
    this.unit = 'kN';       // unit currently shown on the chart
    this.paused = false;    // live graph frozen by the Pause button?
    this.autoPause = true;  // freeze live graph while cursor is over it?
    this.hoverPaused = false;// currently frozen because the cursor is over the chart
    this.sessionName = null;// name of the session being viewed, if any
    this.liveHeader = { id: 'Live', config: '', material: '' }; // live chart header
    this.camera = new CameraFeed(); // GoPro/webcam live feed + recording
    this._cameraUrl = 'ws://localhost:8088';
    this._cameraWanted = false; // user has the live feed turned on
    this._cameraSilent = false; // current connect is best-effort (auto-connect): suppress errors
    this._cameraGiveUp = null;  // give-up timer for a silent connect that never goes live
  }

  init() {
    // Top-bar connection circle: red when no device (click connects one);
    // green with a count when connected (click lists devices to disconnect).
    $('connCircle').onclick = (e) => { e.stopPropagation(); this._toggleDeviceList(); };
    $('addDeviceBtn').onclick = (e) => { e.stopPropagation(); this._toggleDeviceList(); };
    $('simulateBtn').onclick = () => this.h.onSimulate();
    $('discoverBtn').onclick = () => this.h.onDiscover();

    // Discovery/capture controls (debug panel).
    this._capRows = [];
    $('captureExport').onclick = () => this._exportCapture();
    $('captureClear').onclick = () => this._clearCapture();
    $('probeWriteBtn').onclick = () => this.h.onProbeWrite($('probeChar').value, $('probeHex').value);

    $('clearGraphBtn').onclick = () => this.h.onClearGraph();
    $('pauseBtn').onclick = () => this.togglePause();
    $('exportGraphBtn').onclick = () => this.h.onExportGraph();

    // Recording + persistent metadata fields
    $('recordBtn').onclick = () => this.h.onToggleRecord(this.recordFields());
    const fieldIds = { recTestId: 'testId', recSample: 'sample', recConfig: 'config' };
    for (const [id, key] of Object.entries(fieldIds)) {
      $(id).onchange = () => this.h.onRecordFieldChange(key, $(id).value.trim());
    }
    // +/- steppers for Test ID and Sample.
    document.querySelectorAll('.step').forEach((btn) => {
      btn.onclick = () => {
        const input = $(btn.dataset.field);
        input.value = stepTrailingNumber(input.value, Number(btn.dataset.delta));
        const key = btn.dataset.field === 'recTestId' ? 'testId' : 'sample';
        this.h.onRecordFieldChange(key, input.value.trim());
      };
    });
    // Material is a multi-select (tags + searchable picker). Options are
    // populated from saved sessions via setMaterialOptions(), not persisted here.
    this.materialSelect = new MultiSelect($('recMaterial'), {
      onChange: (vals) => this.h.onRecordFieldChange('material', vals),
    });
    $('liveBtn').onclick = () => this.showLive();

    // Camera live feed (fed by the local GoPro bridge). Connect/disconnect lives
    // in the top-bar "+" device menu alongside the LineScale/Enforcer options.
    this.camera.attach($('cameraVideo'));
    this.camera.onStatus((s) => this._onCameraStatus(s));
    // Video drives the session cursor + panels while playing (unless the mouse is
    // over the chart, in which case the graph is the master and scrubs the video).
    $('cameraVideo').addEventListener('timeupdate', () => {
      if (this.viewMode === 'session' && !this._overChart) this._setSessionTime($('cameraVideo').currentTime, true);
    });
    $('setCameraUrl').onchange = () => this.h.onSetting('cameraBridgeUrl', ($('setCameraUrl').value || '').trim());
    $('setCameraAuto').onchange = () => this.h.onSetting('cameraAutoConnect', $('setCameraAuto').checked);
    $('setVideoOffset').onchange = () => {
      this._videoOffsetMs = Number($('setVideoOffset').value) || 0;
      this.h.onSetting('videoOffsetMs', this._videoOffsetMs);
      // Re-apply at the current scrub position so the change is visible immediately.
      if (this.viewMode === 'session') this._setSessionTime(this._sessionT || 0, false);
    };

    // Saved-session search + sort
    $('sessionSearch').oninput = () => this.h.onSessionSearch($('sessionSearch').value);
    $('sessionSort').onchange = () => this.h.onSessionSort($('sessionSort').value);

    $('debugClear').onclick = () => { $('debugLog').textContent = ''; };

    // Settings popover
    $('settingsBtn').onclick = (e) => { e.stopPropagation(); this.toggleSettings(); };
    // Close any open popover when clicking outside it.
    document.addEventListener('click', (e) => {
      if (!$('settingsPanel').hidden && !e.target.closest('.settings-wrap')) this.toggleSettings(false);
      if (!$('deviceList').hidden && !e.target.closest('.conn-wrap')) this._toggleDeviceList(false);
      if (this._inlineAddMenu && !this._inlineAddMenu.hidden && !e.target.closest('.dev-add') && !e.target.closest('.device-list-inline')) this._inlineAddMenu.hidden = true;
      if (!e.target.closest('.share-wrap')) document.querySelectorAll('.share-menu').forEach((m) => { m.hidden = true; });
      if (!e.target.closest('.dev-gear-wrap')) document.querySelectorAll('.dev-menu').forEach((m) => { m.hidden = true; });
    });
    // App-pref inputs report changes via onSetting(key, value).
    $('setDebug').onchange = () => this.h.onSetting('debug', $('setDebug').checked);
    $('setResetOnRecord').onchange = () => this.h.onSetting('resetGraphOnRecord', $('setResetOnRecord').checked);
    $('setAutoPause').onchange = () => this.h.onSetting('autoPauseOnHover', $('setAutoPause').checked);
    $('setAutoSave').onchange = () => this.h.onSetting('autoSave', $('setAutoSave').checked);
    $('chooseFolderBtn').onclick = () => this.h.onChooseFolder();
    $('setWindow').onchange = () => this.h.onSetting('liveWindowS', Number($('setWindow').value));
    // Device-state inputs send commands via onDeviceSetting(key, value).
    $('setZeroMode').onchange = () => this.h.onDeviceSetting('zeroMode', $('setZeroMode').value);
    $('setUnit').onchange = () => this.h.onSetting('unit', $('setUnit').value);
    $('powerOffBtn').onclick = () => this.h.onPowerOff();

    // Web Bluetooth device picker — only under Electron (the browser shows its own).
    if (window.dynoNative?.isElectron) {
      window.dynoNative.onBleDevices((devices) => this._showBlePicker(devices));
      $('bleCancel').onclick = () => { window.dynoNative.cancelBle(); $('bleModal').hidden = true; };
    }

    this._buildChart();
    window.addEventListener('resize', () => this._resizeChart());
    // Re-fit the chart whenever its container changes width (e.g. the camera
    // video appearing/loading beside it shrinks the plot) so uPlot's canvas
    // never overflows over the video.
    if (window.ResizeObserver) new ResizeObserver(() => this._fitChartSoon()).observe($('chart'));
  }

  // Reflect persisted preferences into the controls at startup.
  initSettings(s) {
    $('setDebug').checked = !!s.debug;
    $('setResetOnRecord').checked = !!s.resetGraphOnRecord;
    $('setAutoPause').checked = !!s.autoPauseOnHover;
    $('setAutoSave').checked = !!s.autoSave;
    $('setWindow').value = String(s.liveWindowS);
    $('setUnit').value = s.unit || 'kN';
    this._cameraUrl = s.cameraBridgeUrl || 'ws://localhost:8088';
    $('setCameraUrl').value = this._cameraUrl;
    $('setCameraAuto').checked = !!s.cameraAutoConnect;
    this._videoOffsetMs = Number(s.videoOffsetMs) || 0;
    $('setVideoOffset').value = String(this._videoOffsetMs);
    if (s.cameraAutoConnect) this._toggleCamera(true, { silent: true });
    this.setRecordField('testId', s.testId || '');
    this.setRecordField('sample', s.sample || '01');
    this.setRecordField('config', s.config || '');
    this.setRecordField('material', s.material || []); // options are set from saved sessions on refresh
    this.setAutoPause(!!s.autoPauseOnHover);
    this.setLiveWindow(s.liveWindowS);
    this.toggleDebug(!!s.debug);
  }

  toggleSettings(force) {
    const panel = $('settingsPanel');
    panel.hidden = force === undefined ? !panel.hidden : !force;
    $('settingsBtn').classList.toggle('active', !panel.hidden);
  }

  _toggleDeviceList(force) {
    const m = $('deviceList');
    m.hidden = force === undefined ? !m.hidden : !force;
  }

  // Folder auto-save controls are only relevant where the File System Access
  // API exists (Chrome/Edge).
  setFsSupported(supported) { $('autoSaveSettings').hidden = !supported; }
  setFolderName(name) { $('folderName').textContent = name || 'No folder chosen'; }

  setLiveWindow(seconds) {
    this.windowS = seconds;
    // Trim the existing buffer to the new window immediately.
    const cutoff = (this.lx[this.lx.length - 1] ?? 0) - seconds;
    while (this.lx.length > 2 && this.lx[0] < cutoff) { this.lx.shift(); for (const ys of this.lys) ys.shift(); }
    if (this.viewMode === 'live') this._queueRedraw();
  }

  // ---- chart -------------------------------------------------------------

  _chartWidth() {
    return Math.max(320, $('chart').clientWidth || 800);
  }

  // Live series spec: time + one line per channel. With no channels yet, fall
  // back to a single "load" series so the empty live chart looks unchanged.
  _liveSeries() {
    if (!this.channels.length) {
      return [{ label: 'time (s)' }, { label: 'load', stroke: '#3fb6ff', width: 1.6, points: { show: false } }];
    }
    return [
      { label: 'time (s)' },
      ...this.channels.map((c) => ({ label: c.label, stroke: c.color, width: 1.6, points: { show: false } })),
    ];
  }

  // The data tuple matching the current live series (time + each channel's y).
  _liveData() {
    if (!this.lx.length) return [[0], ...this.lys.map(() => [0])];
    return [this.lx, ...this.lys];
  }

  _buildChart(series, data) {
    const opts = {
      width: this._chartWidth(),
      height: 340,
      scales: { x: { time: false } },
      legend: { show: true },
      // Default cursor already snaps a point onto the series at the hovered x.
      cursor: { drag: { x: true, y: false } },
      series: series || this._liveSeries(),
      axes: [
        { stroke: '#8b97a6', grid: { stroke: '#2b3340', width: 1 }, ticks: { stroke: '#2b3340' } },
        { stroke: '#8b97a6', grid: { stroke: '#2b3340', width: 1 }, ticks: { stroke: '#2b3340' } },
      ],
      plugins: [this._tooltipPlugin()],
    };
    if (this.chart) this.chart.destroy();
    this.chart = new uPlot(opts, data || [[0], [0]], $('chart'));

    // Auto-pause: freeze the live graph while the cursor is over it so the
    // trace doesn't scroll out from under the pointer.
    this.chart.over.addEventListener('mouseenter', () => {
      this._overChart = true;
      if (this.autoPause && this.viewMode === 'live') { this.hoverPaused = true; this._setPauseBadge(true); }
      // In a session, hovering takes over scrubbing — pause any video playback.
      if (this.viewMode === 'session') { const v = $('cameraVideo'); if (v && !v.paused) v.pause(); }
    });
    this.chart.over.addEventListener('mouseleave', () => {
      this._overChart = false;
      if (this.hoverPaused) {
        this.hoverPaused = false;
        this._setPauseBadge(false);
        if (this.viewMode === 'live' && !this.paused) this._queueRedraw();
      }
    });
  }

  // Update the channel set (called by app.js when devices are added/removed).
  // Rebuilds the uPlot instance since the live series array changes, and
  // resizes the per-channel y buffers to match.
  setChannels(channels) {
    this.channels = channels.map((c) => ({ id: c.id, label: c.label, color: c.color }));
    // One y-buffer per channel (preserve existing buffers by index where possible).
    const n = this.channels.length || 1;
    const next = [];
    for (let i = 0; i < n; i++) next[i] = this.lys[i] || new Array(this.lx.length).fill(null);
    this.lys = next;
    if (this.viewMode === 'live') this._buildChart(this._liveSeries(), this._liveData());
  }

  setAutoPause(on) {
    this.autoPause = on;
    if (!on && this.hoverPaused) {
      this.hoverPaused = false;
      this._setPauseBadge(false);
      if (this.viewMode === 'live' && !this.paused) this._queueRedraw();
    }
  }

  // uPlot plugin: a floating label that snaps to the load value at the cursor's
  // x position (the marker rides the line, the label shows force + time).
  _tooltipPlugin() {
    const self = this;
    let tip;
    return {
      hooks: {
        init: (u) => {
          tip = document.createElement('div');
          tip.className = 'u-tooltip';
          tip.style.display = 'none';
          u.over.appendChild(tip);
        },
        setCursor: (u) => {
          const idx = u.cursor.idx;
          const xVal = idx == null ? null : u.data[0][idx];
          const yVal = idx == null ? null : u.data[1][idx];
          // Floating readout (rides the primary line).
          if (xVal == null || yVal == null) { tip.style.display = 'none'; }
          else {
            tip.style.display = 'block';
            tip.textContent = `${yVal.toFixed(2)} ${self.unit} · ${xVal.toFixed(1)} s`;
            tip.style.left = u.valToPos(xVal, 'x') + 'px';
            tip.style.top = u.valToPos(yVal, 'y') + 'px';
          }
          // Session scrub: when the user moves the cursor over a saved session,
          // drive the device panels + video from the cursor time (xVal). Skipped
          // for programmatic cursor moves (video-driven) to avoid a feedback loop.
          if (self.viewMode === 'session' && self._overChart && !self._cursorProgrammatic && xVal != null) {
            self._setSessionTime(xVal, false);
          }
        },
      },
    };
  }

  _resizeChart() {
    if (this.chart) this.chart.setSize({ width: this._chartWidth(), height: 340 });
  }

  // Re-fit the chart after a layout change (e.g. the camera panel showing/hiding
  // beside it changes the chart's width) — uPlot only auto-resizes on window resize.
  _fitChartSoon() { requestAnimationFrame(() => this._resizeChart()); }

  // Append one sampled frame: a shared timestamp plus each channel's latest
  // value (null before a channel has produced data). Called on a fixed timer
  // by app.js, replacing the old per-reading pushLive.
  sampleFrame(values) {
    const now = performance.now() / 1000;
    if (this.t0 === null) this.t0 = now;
    const t = now - this.t0;
    this.lx.push(t);
    for (let i = 0; i < this.lys.length; i++) this.lys[i].push(values[i] ?? null);
    // Trim every buffer to the rolling window in lockstep.
    const cutoff = t - this.windowS;
    while (this.lx.length > 2 && this.lx[0] < cutoff) {
      this.lx.shift();
      for (const ys of this.lys) ys.shift();
    }
    if (this.viewMode === 'live' && !this.paused && !this.hoverPaused) this._queueRedraw();
  }

  togglePause(force) {
    this.paused = force === undefined ? !this.paused : force;
    const btn = $('pauseBtn');
    btn.textContent = this.paused ? '▶ Play' : '⏸ Pause';
    btn.classList.toggle('active', this.paused);
    if (!this.paused && !this.hoverPaused && this.viewMode === 'live') this._queueRedraw();
  }

  _queueRedraw() {
    if (this._redrawQueued) return;
    this._redrawQueued = true;
    requestAnimationFrame(() => {
      this._redrawQueued = false;
      if (this.viewMode === 'live' && this.chart) this.chart.setData(this._liveData());
    });
  }

  // Header zones: Test ID-Sample (top-left), Configuration + Material (centered).
  _renderHeader({ id, config, material }) {
    $('chartId').textContent = id || '';
    $('chartConfig').textContent = config || '';
    $('chartMaterial').textContent = material || '';
  }

  showSession(rec) {
    this.viewMode = 'session';
    const channels = asChannels(rec);
    this.unit = channels[0]?.unit || rec.unit;
    this.sessionName = rec.name;
    this._setPauseBadge(false);

    // One line per channel. Channels are recorded on a shared clock but their
    // sample timestamps may differ slightly, so build a union x-axis (sorted
    // unique times) and align each channel's y onto it (null where it has no
    // sample at that time — uPlot just leaves a gap, which is fine here).
    const single = channels.length < 2;
    // Use the recorded device name on the chart too (e.g. "LineScale 3 #1"),
    // falling back to "load" only for legacy single-channel sessions with no label.
    const label = (c, i) => ((c.label && c.label.trim()) || (single ? 'load' : `Channel ${i + 1}`));
    const color = (i) => (single ? '#3fb6ff' : CHAN_COLORS[i % CHAN_COLORS.length]);

    const xset = new Set();
    for (const c of channels) for (const s of c.samples) xset.add(s.t);
    const xs = [...xset].sort((a, b) => a - b);
    const series = [{ label: 'time (s)' }];
    const data = [xs.length ? xs.map((t) => t / 1000) : [0]];
    channels.forEach((c, i) => {
      const m = new Map(c.samples.map((s) => [s.t, s.value]));
      const ys = xs.map((t) => (m.has(t) ? m.get(t) : null));
      // spanGaps: each channel only has points at its own timestamps (null at
      // the other channels'), so connect across those nulls to get a solid line.
      series.push({ label: label(c, i), stroke: color(i), width: 1.6, points: { show: false }, spanGaps: true });
      data.push(ys.length ? ys : [0]);
    });
    if (data.length === 1) data.push([0]); // no channels: keep a placeholder series
    this._buildChart(series, data);

    // Precompute the session's channels for the scrubbable device panels: per
    // channel a sorted times[]/values[] (for valueAt) + the fixed peak (MAX).
    this._sessionChannels = channels.map((c, i) => {
      const times = c.samples.map((s) => s.t);
      const values = c.samples.map((s) => s.value);
      const peak = Number.isFinite(c.max) && c.max ? c.max : (values.length ? Math.max(...values) : 0);
      const nm = (c.label && c.label.trim()) || (single ? 'Load' : `Channel ${i + 1}`);
      return { label: nm, color: color(i), unit: c.unit || this.unit, times, values, peak };
    });
    this._barSig = null;          // force a rebuild into session panels
    this._renderSessionPanels(0); // initial position at t=0

    this._renderHeader({ id: rec.name, config: rec.config, material: matStr(rec.material) });
    $('liveBtn').hidden = false;
    // In a saved session, only Back-to-Live + Export apply.
    $('pauseBtn').hidden = true;
    $('clearGraphBtn').hidden = true;
    // Show the session's recorded clip (if any) in the camera panel; otherwise
    // stop the live feed display while viewing history.
    if (rec.videoBlob) this.playSessionVideo(rec.videoBlob);
    else { this.camera.suspendLive(); $('chartCam').hidden = true; this._fitChartSoon(); } // keep the live socket open
  }

  showLive() {
    this.viewMode = 'live';
    this.sessionName = null;
    this._sessionChannels = null; // leave session-scrubbing mode
    this._renderHeader(this.liveHeader);
    $('liveBtn').hidden = true;
    $('pauseBtn').hidden = false;
    $('clearGraphBtn').hidden = false;
    // Rebuild for the live (multi-)series; session view used a single series.
    this._buildChart(this._liveSeries(), this._liveData());
    // Restore the live camera feed. If the socket stayed open during the session,
    // resumeLive re-attaches instantly; otherwise it (re)connects.
    if (this._cameraWanted) this.camera.resumeLive();
    else { this.camera.clearPlayback(); $('chartCam').hidden = true; }
    this._fitChartSoon();
    this.h.onSelectSession(null);
  }

  // ---- camera feed -------------------------------------------------------
  // silent: best-effort auto-connect — suppress "can't reach" toasts and give up
  // quietly (so the bridge goes idle) if no video arrives. Explicit user connects
  // are not silent: they report errors and keep retrying.
  _toggleCamera(forceOn, { silent = false } = {}) {
    clearTimeout(this._cameraGiveUp);
    if (!forceOn && this.camera.isConnected()) {
      this._cameraWanted = false; this._cameraSilent = false;
      this.camera.disconnect();
    } else {
      this._cameraWanted = true; this._cameraSilent = silent;
      this.camera.connect(this._cameraUrl);
      if (silent) {
        this._cameraGiveUp = setTimeout(() => {
          if (!this.camera.isLive()) { this._cameraWanted = false; this.camera.disconnect(); }
        }, 12000);
      }
    }
  }

  _onCameraStatus(s) {
    // Diagnostics relayed from the bridge (e.g. "can't reach the GoPro") — surface
    // them so a blank feed isn't a silent mystery. Doesn't change connection state.
    if (s.state === 'bridge') {
      if (!this._cameraSilent && (s.level === 'error' || s.level === 'warn')) this.toast(s.message, true);
      return;
    }
    if (s.state === 'lost' && !this._cameraSilent) this.toast(s.message || 'GoPro feed lost', true); // disconnect() fires next to clean up
    if (s.state === 'live') {
      clearTimeout(this._cameraGiveUp); this._cameraSilent = false; // it connected — treat normally from now on
      $('chartCam').hidden = false; this._fitChartSoon();
    } else if ((s.state === 'disconnected' || s.state === 'error' || s.state === 'lost') && this.viewMode !== 'session') {
      $('chartCam').hidden = true; this._fitChartSoon();
    }
    if (s.state === 'error' && !this._cameraSilent) this.toast(s.message || 'Camera bridge not reachable', true);
    this._renderDeviceMenu(); // reflect connect/disconnect in the "+" menu
  }

  connectCamera() { this._toggleCamera(true); }

  // "GoPro Camera → Wi-Fi": if we're already on a GoPro access point, skip the
  // Bluetooth setup and just connect the feed. Otherwise run the BLE enable +
  // auto-join flow (Electron), or — in a browser build — connect the bridge and
  // let the user join the GoPro Wi-Fi themselves.
  async _connectGoProWifi() {
    try {
      const cur = await window.dynoNative?.currentWifi?.();
      if (cur && /^gp/i.test(cur.ssid || '')) {
        this.toast(`Already on ${cur.ssid} — connecting…`);
        this._toggleCamera(true);
        return;
      }
    } catch { /* couldn't read SSID — fall through to setup */ }
    if (window.dynoNative?.joinWifi) this._setupGoProWifi();
    else this._toggleCamera(true);
  }

  // One-tap GoPro Wi-Fi setup (Electron): enable the camera's Wi-Fi AP over
  // Bluetooth, read its credentials, join that network, then connect the feed —
  // replacing the manual phone-app + macOS Wi-Fi-picker dance.
  async _setupGoProWifi() {
    this._goproBleActive = true; // tells _showBlePicker to show the GoPro pairing note
    try {
      const creds = await enableGoProWifi((msg) => this.toast(msg));
      this.toast(`Waiting for "${creds.ssid}" and joining (this can take a few seconds)…`);
      const res = await window.dynoNative.joinWifi({ ssid: creds.ssid, password: creds.password });
      if (!res || !res.ok) { this.toast(res?.message || 'Could not join the GoPro Wi-Fi', true); return; }
      this.toast(res.message || `Joined ${creds.ssid}`);
      // Give the network a moment to come up before the bridge tries to reach the GoPro.
      setTimeout(() => this._toggleCamera(true), 1500);
    } catch (e) {
      if (e && (e.name === 'NotFoundError' || e.name === 'AbortError')) return; // user cancelled the chooser
      this.toast(e?.message || 'GoPro Bluetooth setup failed', true);
    } finally {
      this._goproBleActive = false;
    }
  }

  // Electron Web Bluetooth picker: main forwards the (live-updating) device list here;
  // selecting one calls back via dynoNative.selectBle. Cancel is wired in init().
  _showBlePicker(devices) {
    const list = $('bleList');
    $('bleModal').hidden = false;
    $('bleGoproNote').hidden = !this._goproBleActive; // pairing note is GoPro-only
    list.innerHTML = '';
    if (!devices.length) { list.innerHTML = '<div class="muted">Scanning…</div>'; return; }
    for (const d of devices) {
      const b = document.createElement('button');
      b.className = 'ble-item';
      b.textContent = d.deviceName;
      b.onclick = () => { window.dynoNative.selectBle(d.deviceId); $('bleModal').hidden = true; };
      list.append(b);
    }
  }

  // For app.js recording integration:
  cameraLive() { return this.camera.isLive(); }
  cameraStartRec() { return this.camera.startRecording(); }
  cameraStopRec() { return this.camera.stopRecording(); }

  // Play a saved session's recorded clip beside the chart.
  playSessionVideo(blob) {
    this.camera.showBlob(blob);
    $('chartCam').hidden = false;
    this._renderDeviceMenu();
    this._fitChartSoon();
  }

  // Live header (Test ID-Sample + config/material). Applied only while viewing
  // the live feed, so it doesn't overwrite a loaded session's header.
  setLiveHeader(obj) {
    this.liveHeader = obj || { id: 'Live', config: '', material: '' };
    if (this.viewMode === 'live') this._renderHeader(this.liveHeader);
  }

  _setPauseBadge(on) { $('pauseBadge').hidden = !on; }

  clearLive() {
    this.lx = []; this.t0 = null;
    this.lys = (this.channels.length ? this.channels : [0]).map(() => []);
    if (this.viewMode === 'live') this.chart.setData(this._liveData());
  }

  // Data currently shown on the chart (for the live Export button). Exports the
  // primary/first channel's series for now.
  currentData() {
    const d = this.chart && this.chart.data;
    return { xs: Array.from((d && d[0]) || []), ys: Array.from((d && d[1]) || []), unit: this.unit };
  }

  // Read / set the recording metadata input fields.
  recordFields() {
    return {
      testId: $('recTestId').value.trim(),
      sample: $('recSample').value.trim(),
      config: $('recConfig').value.trim(),
      material: this.materialSelect.getValues(),
    };
  }
  setRecordField(key, val) {
    if (key === 'material') { this.materialSelect.setValues(val); return; }
    const map = { testId: 'recTestId', sample: 'recSample', config: 'recConfig' };
    if (map[key]) $(map[key]).value = val;
  }
  setMaterialOptions(options) {
    this._materialOptions = options;
    this.materialSelect.setOptions(options);
    if (this.editMaterialSelect) this.editMaterialSelect.setOptions(options);
  }

  // Render the given series to a standalone PNG and download it. Used by the
  // chart's Export button and per-session graph export (no loading).
  exportGraphPNG(opts) {
    this.graphBlob(opts)
      .then((blob) => { this._download(blob, `${this._safeName(opts.filenameBase || opts.idLabel || 'graph')}.png`); this.toast('Graph exported'); })
      .catch((e) => this.toast('Export failed: ' + (e.message || e), true));
  }

  // Render the given series to an annotated PNG and resolve with a Blob.
  // meta: { config, material, idLabel, datetime } drawn in a header band.
  // Accepts EITHER a single series ({ xs, ys, unit }) — unchanged look — OR
  // multiple channels ({ channels: [{ label, color, xs, ys }], unit }) drawn as
  // colored lines with a legend and per-channel max in the header.
  graphBlob({ xs, ys, unit, channels, config = '', material = '', idLabel = '', datetime = '' }) {
    // Normalize to a channels array. Single-series call -> one channel that
    // renders with the original styling (filled blue line, no legend).
    const single = !channels || channels.length < 2;
    const chans = (channels && channels.length)
      ? channels
      : [{ label: '', color: '#3fb6ff', xs: xs || [], ys: ys || [] }];

    return new Promise((resolve, reject) => {
      if (!chans.some((c) => c.xs && c.xs.length)) { reject(new Error('No data to graph')); return; }
      const W = 1200, H = 600;
      const holder = document.createElement('div');
      holder.style.cssText = `position:fixed;left:-99999px;top:0;width:${W}px;height:${H}px;`;
      document.body.appendChild(holder);

      // Build a union x-axis so every channel aligns on one time scale.
      const xset = new Set();
      for (const c of chans) for (const x of c.xs) xset.add(x);
      const ux = [...xset].sort((a, b) => a - b);
      const series = [{}];
      const data = [ux];
      chans.forEach((c, i) => {
        const m = new Map(c.xs.map((x, j) => [x, c.ys[j]]));
        data.push(ux.map((x) => (m.has(x) ? m.get(x) : null)));
        series.push(single
          ? { stroke: c.color, width: 2, fill: 'rgba(63,182,255,0.12)', points: { show: false } }
          : { stroke: c.color || CHAN_COLORS[i % CHAN_COLORS.length], width: 2, points: { show: false }, spanGaps: true });
      });

      let u;
      try {
        u = new uPlot({
          width: W, height: H, scales: { x: { time: false } }, legend: { show: false }, cursor: { show: false },
          series,
          axes: [
            { stroke: '#8b97a6', grid: { stroke: '#2b3340', width: 1 } },
            { stroke: '#8b97a6', grid: { stroke: '#2b3340', width: 1 } },
          ],
        }, data, holder);
      } catch (e) {
        holder.remove();
        reject(e);
        return;
      }

      // uPlot finishes drawing on a later frame; composite once it has rendered.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        try {
          const src = holder.querySelector('canvas');
          const dpr = src.width / W;
          const maxOf = (c) => { let mx = -Infinity; for (const v of c.ys) if (v != null && v > mx) mx = v; return mx; };
          const peak = Math.max(...chans.map(maxOf));

          const out = document.createElement('canvas');
          out.width = src.width; out.height = src.height;
          const ctx = out.getContext('2d');
          ctx.fillStyle = '#0e1116'; ctx.fillRect(0, 0, out.width, out.height);
          ctx.drawImage(src, 0, 0);

          const font = (px, weight = '') => `${weight} ${Math.round(px * dpr)}px -apple-system, sans-serif`.trim();
          let dur = 0;
          for (const c of chans) if (c.xs.length) dur = Math.max(dur, c.xs[c.xs.length - 1]);

          // Translucent header band across the top for legibility.
          ctx.fillStyle = 'rgba(10,13,18,0.72)';
          ctx.fillRect(0, 0, out.width, 96 * dpr);

          // Left: MAX readout (peak across channels) + duration.
          ctx.textAlign = 'left';
          ctx.fillStyle = '#8b97a6'; ctx.font = font(13); ctx.fillText('MAX', 18 * dpr, 26 * dpr);
          ctx.fillStyle = '#ffb020'; ctx.font = font(30, '700'); ctx.fillText(`${peak.toFixed(2)} ${unit}`, 18 * dpr, 60 * dpr);
          ctx.fillStyle = '#8b97a6'; ctx.font = font(12); ctx.fillText(`${dur.toFixed(1)} s`, 18 * dpr, 82 * dpr);

          // Center: Configuration (large) + Material (subtitle).
          ctx.textAlign = 'center';
          const cx = out.width / 2;
          if (config) { ctx.fillStyle = '#e6edf3'; ctx.font = font(26, '700'); ctx.fillText(config, cx, 42 * dpr); }
          if (material) { ctx.fillStyle = '#8b97a6'; ctx.font = font(15); ctx.fillText(material, cx, 70 * dpr); }

          // Right: Test ID - Sample, then date/time.
          ctx.textAlign = 'right';
          const rx = out.width - 18 * dpr;
          if (idLabel) { ctx.fillStyle = '#e6edf3'; ctx.font = font(20, '700'); ctx.fillText(idLabel, rx, 38 * dpr); }
          if (datetime) { ctx.fillStyle = '#8b97a6'; ctx.font = font(13); ctx.fillText(datetime, rx, 62 * dpr); }
          ctx.textAlign = 'left';

          // Multi-channel: a legend of colored labels + per-channel max,
          // bottom-left so it doesn't collide with the header band.
          if (!single) {
            let ly = out.height - (18 + 18 * (chans.length - 1)) * dpr;
            ctx.textAlign = 'left';
            chans.forEach((c, i) => {
              const col = c.color || CHAN_COLORS[i % CHAN_COLORS.length];
              ctx.fillStyle = col;
              ctx.fillRect(18 * dpr, ly - 9 * dpr, 12 * dpr, 12 * dpr);
              ctx.font = font(13, '600');
              const mx = maxOf(c);
              const txt = `${c.label || `Channel ${i + 1}`} — ${(mx === -Infinity ? 0 : mx).toFixed(2)} ${unit}`;
              ctx.fillStyle = '#e6edf3';
              ctx.fillText(txt, 36 * dpr, ly + 2 * dpr);
              ly += 18 * dpr;
            });
          }

          out.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encode failed'))));
        } catch (e) {
          reject(e);
        } finally {
          u.destroy();
          holder.remove();
        }
      }));
    });
  }

  _download(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  _safeName(name) { return String(name).replace(/[^\w\-]+/g, '_'); }

  // ---- readouts ----------------------------------------------------------

  // Connection circle + device menu. `devices` = [{ id, label, kind }].
  setDevices(devices) {
    this._devices = devices;
    this._renderDeviceMenu();
  }

  // The add-device options (LineScale 3 / Enforcer / GoPro Camera twirl-down),
  // shared by the top-bar "+" menu and the big in-body "Connect Device" card.
  // closeMenu() is invoked after a choice to dismiss whichever menu opened it.
  _buildAddGroup(closeMenu) {
    const addGroup = document.createElement('div');
    addGroup.className = 'device-add-group';
    const mkAdd = (label, fn) => {
      const b = document.createElement('button');
      b.className = 'device-add-btn';
      b.innerHTML = `<span class="device-add-plus">+</span><span>${label}</span>`;
      b.onclick = (e) => { e.stopPropagation(); closeMenu(); fn(); };
      return b;
    };
    // A collapsible parent row that twirls open to reveal sub-options.
    const mkGroup = (label, subButtons) => {
      const wrap = document.createElement('div');
      const head = document.createElement('button');
      head.className = 'device-add-btn';
      head.innerHTML = `<span class="device-add-plus">+</span><span>${label}</span><span class="device-add-twirl">▸</span>`;
      const sub = document.createElement('div');
      sub.className = 'device-add-sub'; sub.hidden = true;
      sub.append(...subButtons);
      head.onclick = (e) => {
        e.stopPropagation();
        sub.hidden = !sub.hidden;
        head.querySelector('.device-add-twirl').textContent = sub.hidden ? '▸' : '▾';
      };
      wrap.append(head, sub);
      return wrap;
    };
    addGroup.append(
      mkAdd('LineScale 3', () => this.h.onConnect()),
      mkAdd('Rock Exotica Enforcer', () => this.h.onConnectEnforcer()),
    );
    if (!this.camera.isLive()) {
      // GoPro Camera twirls open to Wi-Fi / USB. Both connect the bridge (which
      // auto-detects USB); the Wi-Fi path adds BLE setup + auto-join when needed.
      addGroup.append(mkGroup('GoPro Camera', [
        mkAdd('Wi-Fi', () => this._connectGoProWifi()),
        mkAdd('USB', () => this._toggleCamera(true)),
      ]));
    }
    return addGroup;
  }

  // Build the connection menu: add options (LineScale 3 / Rock Exotica Enforcer /
  // Camera) and the list of connected things — force devices and the camera —
  // each with a red × to disconnect. The circle shows "+" when nothing's
  // connected, otherwise the count. Re-rendered on device OR camera changes.
  _renderDeviceMenu() {
    const devices = this._devices || [];
    const n = devices.length;                 // force devices — gate recording/settings
    // Count the camera as connected when video is live, or when it's only paused
    // for saved-session playback (socket still open) — but not merely when the
    // bridge WebSocket is open with no GoPro (which would falsely show on launch).
    const camOn = this.camera.isLive() || this.camera.isSuspendedLive();
    const total = n + (camOn ? 1 : 0);

    const circle = $('connCircle');
    circle.textContent = total > 0 ? String(total) : '+';
    circle.title = total > 0 ? 'Devices' : 'Connect a device';
    // When something's connected, show the count + a small "+" to its left to add
    // more (the big in-body "Connect Device" card only appears when nothing is yet).
    $('addDeviceBtn').hidden = total === 0;

    const menu = $('deviceList');
    menu.innerHTML = '';
    menu.append(this._buildAddGroup(() => this._toggleDeviceList(false)));

    if (total) {
      const hdr = document.createElement('div');
      hdr.className = 'device-list-hdr';
      hdr.textContent = 'Connected';
      menu.append(hdr);
      const mkRow = (label, kind, onX) => {
        const row = document.createElement('div'); row.className = 'device-row';
        const info = document.createElement('div');
        const nm = document.createElement('div'); nm.className = 'device-name'; nm.textContent = label;
        const k = document.createElement('div'); k.className = 'device-kind'; k.textContent = kind || '';
        info.append(nm, k);
        const x = document.createElement('button');
        x.className = 'device-x'; x.textContent = '×'; x.title = 'Disconnect';
        x.onclick = (e) => { e.stopPropagation(); onX(); };
        row.append(info, x); menu.append(row);
      };
      for (const d of devices) mkRow(d.label, d.kind, () => this.h.onChannelDisconnect(d.id));
      if (camOn) mkRow('Camera', 'GoPro feed', () => this._toggleCamera());
    }

    document.querySelectorAll('.device-setting').forEach((el) => (el.disabled = n === 0));
    $('recordBtn').disabled = n === 0;
  }

  // Reflect the primary device's live zero mode into the Settings select. Refresh
  // rate is now a per-device control (each LineScale's gear menu); units are global.
  reflectDeviceState(reading) {
    if (reading.measureMode === 'N' || reading.measureMode === 'Z')
      $('setZeroMode').value = reading.measureMode === 'N' ? 'abs' : 'rel';
  }

  // Render one large horizontal readout bar per connected device, plus an
  // add-device bar. Called on every reading, so the DOM structure (buttons,
  // color pickers!) is only rebuilt when the channel set or labels change;
  // otherwise we just update the live value text. Rebuilding every frame would
  // recreate the controls mid-click and they'd never fire.
  // chans: [{ id, label, color, kind, current, max, unit, rate, battery, overloaded }].
  // Public entry (live devices, from app.js). In session view the panels are
  // driven from the session instead, so live readings must not clobber them.
  renderChannels(chans) {
    if (this.viewMode === 'session') return;
    this._renderBars(chans);
  }

  // Render/update the device bars (used for both live devices and session panels).
  _renderBars(chans) {
    // Rebuild the DOM only when the channel set or labels change; otherwise just
    // update values so controls stay clickable across ~40 Hz updates.
    const sig = chans.length + '#' + chans.map((c) => `${c.id}:${c.label}`).join('|');
    if (sig !== this._barSig) { this._buildDeviceBars(chans); this._barSig = sig; }
    for (const c of chans) {
      const refs = this._bars && this._bars.get(c.id);
      if (!refs) continue;
      refs.cur.textContent = fmtSigned(c.current);
      refs.curUnit.textContent = c.unit || '';
      refs.max.textContent = fmtSigned(c.max);
      refs.maxUnit.textContent = c.unit || '';
      if (refs.rate) refs.rate.textContent = c.rate ?? '–';
      // Keep the gear-menu rate select in sync with the live rate (unless the user
      // is actively changing it).
      if (refs.rateSel && (c.rate === 10 || c.rate === 40) && document.activeElement !== refs.rateSel) {
        refs.rateSel.value = String(c.rate);
      }
      if (refs.batt) refs.batt.textContent = (c.battery ?? '–') + '%';
      if (refs.overload) refs.overload.hidden = !c.overloaded;
    }
  }

  // Render the session's device panels with CURRENT at time tMs (MAX = peak).
  _renderSessionPanels(tMs) {
    if (!this._sessionChannels) return;
    this._renderBars(this._sessionChannels.map((ch, i) => ({
      id: 's' + i, type: 'session', label: ch.label, color: ch.color,
      unit: ch.unit, current: valueAt(ch, tMs), max: ch.peak,
    })));
  }

  // ---- session scrubbing time hub ---------------------------------------
  // Move to time tSec in the session. From the graph (fromVideo=false): update
  // panels + scrub the video to match. From the video (fromVideo=true): update
  // panels + move the graph cursor to match.
  _setSessionTime(tSec, fromVideo) {
    // videoOffsetMs lets the user line up the recorded video with the force graph
    // (the live feed lagged reality, so the saved video trails the data). Panels +
    // cursor track graph/force time; the video sits at graph time + offset.
    const off = (this._videoOffsetMs || 0) / 1000;
    if (fromVideo) {
      const g = tSec - off;                       // video time -> graph/force time
      this._sessionT = g;
      this._renderSessionPanels(g * 1000);
      this._seekCursorTo(g);
    } else {
      this._sessionT = tSec;                       // tSec is graph/force time
      this._renderSessionPanels(tSec * 1000);
      const v = $('cameraVideo');
      if (v && v.src && !$('chartCam').hidden) {
        if (!v.paused) v.pause();                 // hover takes over playback
        const target = Math.max(0, tSec + off);   // graph/force time -> video time
        if (Math.abs(v.currentTime - target) > 0.04) { try { v.currentTime = target; } catch { /* ignore */ } }
      }
    }
  }

  // Position the chart cursor at time tSec without retriggering the scrub logic.
  _seekCursorTo(tSec) {
    if (!this.chart) return;
    this._cursorProgrammatic = true;
    try { this.chart.setCursor({ left: this.chart.valToPos(tSec, 'x') }); } catch { /* ignore */ }
    this._cursorProgrammatic = false;
  }

  _buildDeviceBars(chans) {
    const wrap = $('deviceBars');
    wrap.innerHTML = '';
    this._bars = new Map();

    for (const c of chans) {
      // Session panels are read-only history (no live controls, no rate/battery).
      const isSession = c.type === 'session';
      const bar = document.createElement('div');
      bar.className = 'device-bar';

      // Left: color swatch (color picker) + editable name + device type.
      const ident = document.createElement('div');
      ident.className = 'dev-ident';
      const sw = document.createElement('input');
      sw.type = 'color';
      sw.className = 'dev-swatch';
      sw.value = c.color;
      if (isSession) { sw.disabled = true; }
      else { sw.title = 'Line color'; sw.oninput = () => this.h.onChannelColor(c.id, sw.value); }
      const idText = document.createElement('div');
      idText.className = 'dev-idtext';
      // Editable name as a contenteditable div so a long name can wrap to two
      // lines (an <input> can't), freeing horizontal room for the readouts.
      const label = document.createElement('div');
      label.className = 'dev-name';
      if (!isSession) { label.contentEditable = 'true'; label.spellcheck = false; }
      label.textContent = c.label;
      if (!isSession) {
        label.title = 'Rename device';
        label.onblur = () => this.h.onChannelLabel(c.id, label.textContent.trim() || c.label);
        label.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); label.blur(); } };
      }
      const kind = document.createElement('div');
      kind.className = 'dev-kind';
      kind.textContent = c.kind || '';
      idText.append(label, kind);
      ident.append(sw, idText);

      // Big readouts: CURRENT, MAX, RATE, battery.
      const readouts = document.createElement('div');
      readouts.className = 'dev-readouts';
      const mkRO = (cls, labelTxt) => {
        const box = document.createElement('div');
        box.className = 'dev-ro ' + cls;
        const lab = document.createElement('div'); lab.className = 'dev-ro-label'; lab.textContent = labelTxt;
        const val = document.createElement('div'); val.className = 'dev-ro-value';
        box.append(lab, val);
        return { box, val };
      };
      const curRO = mkRO('dev-ro-cur', 'Current');
      const cur = document.createElement('span'); cur.className = 'dev-cur-num';
      const curUnit = document.createElement('span'); curUnit.className = 'unit';
      curRO.val.append(cur, curUnit);
      const overload = document.createElement('div'); overload.className = 'overload'; overload.textContent = '⚠ OVERLOAD'; overload.hidden = true;
      curRO.box.append(overload);

      const maxRO = mkRO('dev-ro-max', 'Max');
      const max = document.createElement('span'); max.className = 'dev-max-num';
      const maxUnit = document.createElement('span'); maxUnit.className = 'unit';
      maxRO.val.append(max, maxUnit);

      // Rate (+ Battery, when the device reports it) stacked vertically. Session
      // panels are historical, so they have no rate/battery meta column.
      let rate = null, batt = null, meta = null;
      if (!isSession) {
        meta = document.createElement('div');
        meta.className = 'dev-ro-meta';
        const rateRO = mkRO('dev-ro-rate', 'Rate');
        rate = document.createElement('span'); rate.className = 'dev-rate-num';
        rateRO.val.append(rate, document.createTextNode(' Hz'));
        meta.append(rateRO.box);
        // The Enforcer has no battery telemetry — omit that readout for it.
        if (!String(c.type || '').startsWith('enforcer')) {
          const battRO = mkRO('dev-ro-batt', 'Battery');
          batt = document.createElement('span'); batt.className = 'dev-batt-num';
          battRO.val.append(batt);
          meta.append(battRO.box);
        }
      }

      // Thin partial divider between adjacent sections. The one before the
      // rate/battery column is tagged so it hides together with that column.
      const mkDiv = (extra) => { const d = document.createElement('div'); d.className = 'dev-divider' + (extra ? ' ' + extra : ''); return d; };
      if (meta) readouts.append(curRO.box, mkDiv(), maxRO.box, mkDiv('dev-div-meta'), meta);
      else readouts.append(curRO.box, mkDiv(), maxRO.box);

      bar.append(ident, mkDiv(), readouts);
      this._bars.set(c.id, { cur, curUnit, max, maxUnit, rate, batt, overload });

      // Session panels are read-only — no controls. Live devices get the gear
      // menu (Zero / Tare / Reset) + disconnect ×.
      if (isSession) { wrap.append(bar); continue; }

      // Controls: settings gear (Zero / Tare / Reset menu) + disconnect ×.
      const ctl = document.createElement('div');
      ctl.className = 'dev-ctl';

      const gearWrap = document.createElement('div');
      gearWrap.className = 'dev-gear-wrap';
      const gear = document.createElement('button');
      gear.className = 'dev-gear';
      gear.title = 'Device controls';
      gear.setAttribute('aria-label', 'Device controls');
      gear.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
      const menu = document.createElement('div');
      menu.className = 'dev-menu';
      menu.hidden = true;
      gear.onclick = (e) => {
        e.stopPropagation();
        document.querySelectorAll('.dev-menu').forEach((m) => { if (m !== menu) m.hidden = true; });
        menu.hidden = !menu.hidden;
      };
      const mkMenuItem = (text, title, fn) => {
        const b = document.createElement('button');
        b.className = 'dev-menu-item';
        b.textContent = text; b.title = title;
        b.onclick = () => { menu.hidden = true; fn(); };
        return b;
      };
      menu.append(
        mkMenuItem('Zero', 'Zero the current reading', () => this.h.onChannelCommand(c.id, 'ZERO')),
        mkMenuItem('Tare', 'Set current value as absolute zero', () => this.h.onChannelCommand(c.id, 'SET_ABS_ZERO')),
        mkMenuItem('Reset', 'Reset max (and clear the device peak)', () => this.h.onChannelReset(c.id)),
      );
      // Refresh rate is a per-device setting (LineScale only) — each device sets
      // it independently, so it lives in its own gear menu rather than global Settings.
      let rateSel = null;
      if (c.type === 'ls3') {
        const row = document.createElement('label');
        row.className = 'dev-menu-rate';
        row.append(Object.assign(document.createElement('span'), { textContent: 'Refresh rate' }));
        rateSel = document.createElement('select');
        rateSel.innerHTML = '<option value="10">10 Hz</option><option value="40">40 Hz</option>';
        rateSel.value = String(c.rate === 10 || c.rate === 40 ? c.rate : 40);
        rateSel.onclick = (e) => e.stopPropagation(); // keep the menu open while choosing
        rateSel.onchange = (e) => {
          e.stopPropagation();
          this.h.onChannelCommand(c.id, rateSel.value === '40' ? 'SPEED_40HZ' : 'SPEED_10HZ');
        };
        row.append(rateSel);
        menu.append(row);
      }
      gearWrap.append(gear, menu);

      const close = document.createElement('button');
      close.className = 'dev-close';
      close.textContent = '×';
      close.title = 'Disconnect this device';
      close.onclick = () => this.h.onChannelDisconnect(c.id);
      ctl.append(gearWrap, close);
      bar.append(ctl);
      wrap.append(bar);
      if (rateSel) { const e = this._bars.get(c.id); if (e) e.rateSel = rateSel; }
    }

    // Big "Connect Device" card only as the initial prompt (no devices yet). Once
    // something is connected, adding more is done via the top-bar "+" button.
    if (!chans.length) {
      const add = document.createElement('button');
      add.className = 'dev-add';
      add.innerHTML = '<span class="dev-add-icon">+</span><span class="dev-add-text">Connect Device</span>';
      // The options drop down directly under this card (not the top-right menu),
      // and clicking the card again closes them.
      const inlineMenu = document.createElement('div');
      inlineMenu.className = 'device-list-menu device-list-inline';
      inlineMenu.hidden = true;
      inlineMenu.append(this._buildAddGroup(() => { inlineMenu.hidden = true; }));
      // Pop up at the click point; clicking the card again closes it. Clamp to the
      // viewport so it never spills off-screen.
      add.onclick = (e) => {
        e.stopPropagation();
        if (!inlineMenu.hidden) { inlineMenu.hidden = true; return; }
        inlineMenu.hidden = false;
        const r = inlineMenu.getBoundingClientRect();
        const x = Math.min(e.clientX, window.innerWidth - r.width - 8);
        const y = Math.min(e.clientY, window.innerHeight - r.height - 8);
        inlineMenu.style.left = `${Math.max(8, x)}px`;
        inlineMenu.style.top = `${Math.max(8, y)}px`;
      };
      this._inlineAddMenu = inlineMenu;
      wrap.append(add, inlineMenu);
    } else {
      this._inlineAddMenu = null;
    }
  }

  setRecordingState(isRecording) {
    const btn = $('recordBtn');
    btn.classList.toggle('recording', isRecording);
    btn.innerHTML = isRecording ? '■ Stop Recording' : '<span class="rec-dot">●</span> Start Recording';
    // Red outlines on the graph + device bars while a recording is active.
    document.body.classList.toggle('is-recording', isRecording);
    // Grey out / lock the recording metadata inputs (incl. the +/- steppers).
    ['recTestId', 'recSample', 'recConfig'].forEach((id) => { $(id).disabled = isRecording; });
    document.querySelectorAll('.record-bar .step').forEach((b) => { b.disabled = isRecording; });
    this.materialSelect.setDisabled(isRecording);
  }

  setRecInfo(text) { $('recInfo').textContent = text; }
  setSessionsEmptyText(text) { $('noSessions').textContent = text; }
  setRecordWarning(text) {
    const el = $('recWarn');
    el.hidden = !text;
    el.textContent = text ? `⚠ ${text}` : '';
  }

  // ---- session list ------------------------------------------------------

  renderSessions(list, activeId) {
    const ul = $('sessionList');
    ul.innerHTML = '';
    $('noSessions').hidden = list.length > 0;
    const mk = (cls, text) => { const el = document.createElement('span'); el.className = cls; el.textContent = text; return el; };
    for (const s of list) {
      const li = document.createElement('li');
      li.className = 'session-item' + (s.id === activeId ? ' active' : '');
      li.title = s.id === activeId ? 'Click to deselect' : 'Click to view';
      li.onclick = () => (s.id === activeId ? this.showLive() : this.h.onSelectSession(s.id));
      const d = new Date(s.startedAt);

      // Date / time (two lines).
      const when = document.createElement('div');
      when.className = 'sess-when';
      when.append(mk('', d.toLocaleDateString()), mk('', d.toLocaleTimeString()));

      // Configuration / material (centered, prominent). Falls back to the
      // session name when neither is set.
      const id = document.createElement('div');
      id.className = 'sess-id';
      const mat = matStr(s.material);
      id.append(mk('sess-config', s.config || (mat ? '' : s.name)), mk('sess-material', mat));

      // Max load / Test ID - Sample.
      const stats = document.createElement('div');
      stats.className = 'sess-stats';
      const nameTxt = s.channelCount > 1 ? `${s.name} · ${s.channelCount} ch` : s.name;
      stats.append(mk('sess-max', `${s.max.toFixed(2)} ${s.unit}`), mk('sess-dur', nameTxt));

      const actions = document.createElement('div');
      actions.className = 'session-actions';
      actions.append(
        this._iconBtn(PENCIL_SVG, () => this.h.onEditSession(s.id), false, { html: true, title: 'Edit' }),
        this._shareMenu(s.id),
        this._iconBtn(TRASH_SVG, () => this.h.onDeleteSession(s.id), true, { html: true, title: 'Delete' }),
      );

      li.append(when, id, stats, actions);
      ul.append(li);
    }
  }

  // Show a "reconnect folder" prompt in the sessions area (needed after a
  // reload, when the browser must re-grant folder permission via a gesture).
  showReconnect(folderName, onReconnect) {
    $('noSessions').hidden = true;
    const ul = $('sessionList');
    ul.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'session-item';
    const meta = document.createElement('span');
    meta.className = 'session-meta';
    meta.textContent = `Folder “${folderName}” needs permission again — re-select it to restore your sessions.`;
    const btn = document.createElement('button');
    btn.className = 'icon-btn';
    btn.textContent = 'Reconnect folder';
    btn.onclick = onReconnect;
    li.append(meta, btn);
    ul.append(li);
  }

  // Modal text prompt. Resolves to a trimmed value, or null if skipped/empty.
  promptName(defaultValue, title = 'Name this session') {
    return new Promise((resolve) => {
      const modal = $('nameModal'), input = $('nameModalInput');
      const save = $('nameModalSave'), cancel = $('nameModalCancel');
      $('nameModalTitle').textContent = title;
      input.value = '';
      input.placeholder = defaultValue || title;
      modal.hidden = false;
      input.focus();
      const done = (val) => {
        modal.hidden = true;
        save.onclick = cancel.onclick = input.onkeydown = null;
        resolve(val && val.trim() ? val.trim() : null);
      };
      save.onclick = () => done(input.value);
      cancel.onclick = () => done(null);
      input.onkeydown = (e) => {
        if (e.key === 'Enter') done(input.value);
        else if (e.key === 'Escape') done(null);
      };
    });
  }

  // Edit a session's metadata. Resolves to {testId, sample, config, material} or null.
  openEditModal(rec) {
    return new Promise((resolve) => {
      if (!this.editMaterialSelect) {
        this.editMaterialSelect = new MultiSelect($('editMaterial'), {});
      }
      this.editMaterialSelect.setOptions(this._materialOptions || []);
      this.editMaterialSelect.setValues(rec.material);
      $('editTestId').value = rec.testId || '';
      $('editSample').value = rec.sample || '';
      $('editConfig').value = rec.config || '';
      const modal = $('editModal');
      modal.hidden = false;
      $('editTestId').focus();
      const save = $('editSave'), cancel = $('editCancel');
      const done = (val) => { modal.hidden = true; save.onclick = cancel.onclick = null; resolve(val); };
      save.onclick = () => done({
        testId: $('editTestId').value.trim(),
        sample: $('editSample').value.trim(),
        config: $('editConfig').value.trim(),
        material: this.editMaterialSelect.getValues(),
      });
      cancel.onclick = () => done(null);
    });
  }

  _iconBtn(label, fn, danger, opts = {}) {
    const b = document.createElement('button');
    b.className = 'icon-btn' + (danger ? ' danger' : '') + (opts.html ? ' icon-btn-svg' : '');
    if (opts.html) b.innerHTML = label; else b.textContent = label;
    if (opts.title) b.title = opts.title;
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    return b;
  }

  // A share icon that opens a small menu to download the session's PNG / CSV.
  _shareMenu(id) {
    const wrap = document.createElement('div');
    wrap.className = 'share-wrap';
    wrap.onclick = (e) => e.stopPropagation(); // don't select the row
    const btn = this._iconBtn(SHARE_SVG, () => {}, false, { html: true, title: 'Share / download' });
    const menu = document.createElement('div');
    menu.className = 'share-menu';
    menu.hidden = true;
    const item = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => { menu.hidden = true; fn(); };
      return b;
    };
    menu.append(
      item('Download graph (PNG)', () => this.h.onExportSessionGraph(id)),
      item('Download CSV', () => this.h.onExportSession(id)),
    );
    btn.onclick = () => {
      const open = menu.hidden;
      document.querySelectorAll('.share-menu').forEach((m) => { m.hidden = true; });
      menu.hidden = !open;
    };
    wrap.append(btn, menu);
    return wrap;
  }

  toast(msg, isErr) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (isErr ? ' err' : '');
    t.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => (t.hidden = true), 3200);
  }

  // ---- diagnostics -------------------------------------------------------

  toggleDebug(force) {
    const panel = $('debugPanel');
    panel.hidden = force === undefined ? !panel.hidden : !force;
    $('setDebug').checked = !panel.hidden; // keep the settings toggle in sync
  }

  _logLine(text) {
    const el = $('debugLog');
    el.textContent += text + '\n';
    // Cap the log so it can't grow without bound.
    const lines = el.textContent.split('\n');
    if (lines.length > 300) el.textContent = lines.slice(-300).join('\n');
    el.scrollTop = el.scrollHeight;
  }

  diag(d) {
    if (d.line) this._logLine(d.line);
    if (d.raw) { $('debugRaw').textContent = d.raw.hex; $('debugAscii').textContent = d.raw.ascii; }
    if (d.parseFail) this._logLine('parse-fail: ' + d.parseFail);
    if (d.stats) {
      const s = d.stats;
      $('debugStats').textContent =
        `notifs ${s.notifs} · ${s.bytes}B · frames ${s.frames} · parsed ${s.parsed} · failed ${s.failed}`;
    }
    if (d.noData) {
      this.toggleDebug(true);
      this.toast('Connected, but no data received from the device — see Debug panel', true);
    }
    // Discovery mode: a captured notification, and the list of writable chars.
    if (d.capture) this._captureRow(d.capture);
    if (d.chars) this._setProbeChars(d.chars);
  }

  // Append one captured BLE notification to the capture table (capped) and keep
  // the raw row for export. Auto-opens the debug panel on first capture.
  _captureRow(c) {
    if (!this._capRows) this._capRows = [];
    this._capRows.push(c);
    const el = $('captureLog');
    const row = document.createElement('div');
    row.className = 'cap-row';
    row.innerHTML =
      `<span class="cap-ts">${c.ts}</span>` +
      `<span class="cap-char">${c.char}</span>` +
      `<span class="cap-hex">${c.hex}</span>` +
      `<span class="cap-ascii">${c.ascii}</span>`;
    el.append(row);
    while (el.childElementCount > 500) el.firstElementChild.remove();
    el.scrollTop = el.scrollHeight;
    $('captureCount').textContent = `${this._capRows.length} rows`;
    if (this._capRows.length === 1) this.toggleDebug(true);
  }

  _setProbeChars(chars) {
    const sel = $('probeChar');
    sel.innerHTML = '';
    if (!chars.length) {
      sel.innerHTML = '<option value="">(no writable characteristics)</option>';
      return;
    }
    for (const c of chars) {
      const o = document.createElement('option');
      o.value = c.uuid; o.textContent = c.label;
      sel.append(o);
    }
  }

  _clearCapture() {
    this._capRows = [];
    $('captureLog').innerHTML = '';
    $('captureCount').textContent = '0 rows';
  }

  _exportCapture() {
    if (!this._capRows || !this._capRows.length) { this.toast('No capture to export', true); return; }
    const header = 'ts_s,char,hex,ascii';
    const lines = this._capRows.map((c) => `${c.ts},${c.char},${c.hex},"${c.ascii.replace(/"/g, '""')}"`);
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv' });
    this._download(blob, 'ble-capture.csv');
    this.toast(`Exported ${this._capRows.length} rows`);
  }

  resetDiag() {
    $('debugStats').textContent = 'waiting…';
    $('debugRaw').textContent = '—';
    $('debugAscii').textContent = '—';
  }
}
