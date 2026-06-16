// Persisted app preferences (localStorage). Device-side state (scan rate, zero
// mode) is NOT stored here — it lives on the device and is reflected from the
// data stream.

const KEY = 'ls3-settings';

const DEFAULTS = {
  debug: false,               // show the diagnostics panel
  resetGraphOnRecord: true,   // clear the live graph when a recording starts
  autoPauseOnHover: true,     // freeze the live graph while the cursor is over it
  autoSave: true,             // save each recording (CSV + PNG + MP4) to a folder by default
  liveWindowS: 60,            // seconds of history shown on the live graph
  unit: 'kN',                 // global display unit (kN / kgf / lbf) — all devices forced to match
  cameraBridgeUrl: 'ws://localhost:8088', // GoPro bridge WebSocket (gopro-bridge/)
  cameraAutoConnect: false,   // auto-connect the camera feed on load
  videoOffsetMs: 300,         // session playback: shift video vs. graph to line them up (ms; +ve = video later)
  recordOnGoPro: false,       // also trigger recording on the GoPro's SD card while the app records
  // Persistent recording metadata (kept across recordings/reloads).
  testId: '',                 // stays the same across recordings unless changed
  sample: '01',               // auto-increments per recording; resets when testId changes
  config: '',                 // configuration (shown large/top-center on graphs)
  material: [],               // material(s) — list of tags (subtitle under configuration)
};

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}

// The video sync offset is a global calibration, not a per-user preference, so
// when its default changes we re-apply it (overriding any stored value) once.
const VIDEO_OFFSET_DEFAULT = 300;

export const settings = { ...DEFAULTS, ...load() };

if (settings.videoOffsetDefault !== VIDEO_OFFSET_DEFAULT) {
  settings.videoOffsetMs = VIDEO_OFFSET_DEFAULT;
  settings.videoOffsetDefault = VIDEO_OFFSET_DEFAULT;
  saveSettings();
}

export function saveSettings() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}
