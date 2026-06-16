// Enable the GoPro's Wi-Fi access point over Bluetooth (Open GoPro BLE API) and
// read back its SSID + password, so the app can join that network itself —
// removing the need to use the GoPro phone app just to turn the Wi-Fi on.
//
// Flow: connect GATT → write the "AP Control: on" command (0x03 0x17 0x01 0x01)
// to the Command Request characteristic → read the SSID + password characteristics.
// The pure helpers (decodeBleString, AP_ON_COMMAND) are exported for unit tests;
// the connect flow needs a real Web Bluetooth stack (browser / Electron).

// Open GoPro BLE UUIDs.
const SVC_CONTROL = '0000fea6-0000-1000-8000-00805f9b34fb';      // Control & Query (advertised)
const SVC_WIFI = 'b5f90001-aa8d-11e3-9046-0002a5d5c51b';         // Wi-Fi Access Point service
const CHAR_COMMAND = 'b5f90072-aa8d-11e3-9046-0002a5d5c51b';     // Command Request (write)
const CHAR_WIFI_SSID = 'b5f90002-aa8d-11e3-9046-0002a5d5c51b';   // Wi-Fi AP SSID (read)
const CHAR_WIFI_PASSWORD = 'b5f90003-aa8d-11e3-9046-0002a5d5c51b';// Wi-Fi AP password (read)

// All GoPro services we may need to reach (must be declared so Web Bluetooth
// grants access to their characteristics).
const GOPRO_SERVICES = [SVC_CONTROL, SVC_WIFI, 'b5f90090-aa8d-11e3-9046-0002a5d5c51b'];

// Strip NUL / control bytes (0x00–0x1f, 0x7f) some firmware appends to the
// SSID/password values. Built via RegExp() to keep control bytes out of source.
const CTRL_BYTES = new RegExp('[\\x00-\\x1f\\x7f]', 'g');

const CHAR_SETTINGS = 'b5f90074-aa8d-11e3-9046-0002a5d5c51b';    // Settings Request (keep-alive)

// TLV command: [length=0x03][command id 0x17 = AP Control][param length 0x01][0x01 = on].
export const AP_ON_COMMAND = Uint8Array.of(0x03, 0x17, 0x01, 0x01);
// Shutter (record) command 0x01: param 0x01 = start, 0x00 = stop.
export const SHUTTER_ON = Uint8Array.of(0x03, 0x01, 0x01, 0x01);
export const SHUTTER_OFF = Uint8Array.of(0x03, 0x01, 0x01, 0x00);
// Keep-alive (setting 0x5B = 0x42), sent every ~3s so the camera doesn't sleep + drop BLE.
export const KEEP_ALIVE = Uint8Array.of(0x03, 0x5b, 0x01, 0x42);

// Decode a BLE string characteristic value (SSID/password). GoPro returns the raw
// UTF-8 string; trim any trailing control bytes.
export function decodeBleString(dataview) {
  const bytes = dataview instanceof Uint8Array
    ? dataview
    : new Uint8Array(dataview.buffer, dataview.byteOffset, dataview.byteLength);
  return new TextDecoder().decode(bytes).replace(CTRL_BYTES, '').trim();
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Web Bluetooth allows only ONE GATT operation at a time and throws a generic
// "GATT operation failed for unknown reason" on overlap or a transient glitch.
// Run each op through here: it labels the step (so a failure says exactly where)
// and retries once after a short pause. Never run two of these concurrently.
async function step(label, fn) {
  try { return await fn(); }
  catch (e1) {
    await delay(350);
    try { return await fn(); }
    catch (e2) { throw new Error(`${label} (${e2?.message || e2})`); }
  }
}

// Get the GoPro's primary services — getPrimaryServices() first, falling back to
// fetching the known service UUIDs individually if that's unsupported/empty.
async function getServices(server) {
  try { const s = await server.getPrimaryServices(); if (s && s.length) return s; } catch { /* fall back */ }
  const out = [];
  for (const uuid of GOPRO_SERVICES) { try { out.push(await server.getPrimaryService(uuid)); } catch { /* skip */ } }
  if (!out.length) throw new Error('no GoPro GATT services found');
  return out;
}

// Write using whichever write type the characteristic actually supports.
function writeChar(char, bytes) {
  const p = char.properties || {};
  if (p.write && char.writeValueWithResponse) return char.writeValueWithResponse(bytes);
  if (p.writeWithoutResponse && char.writeValueWithoutResponse) return char.writeValueWithoutResponse(bytes);
  return char.writeValue(bytes);
}

// Connect to a GoPro over BLE, enable its Wi-Fi AP, and return its credentials.
// onProgress(message) reports each step for UI feedback. Throws on failure
// (including the user cancelling the device chooser); the error names the step.
//
// GoPros tend to drop the link within ~1s of connecting unless they're bonded
// with this computer, so the connect→enable→read flow is retried a few times and
// the final error points the user at the camera's pairing mode.
export async function enableGoProWifi(onProgress = () => {}) {
  if (typeof navigator === 'undefined' || !navigator.bluetooth) {
    throw new Error('Web Bluetooth is not available here.');
  }
  onProgress('Select your GoPro…');
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ namePrefix: 'GoPro' }],
    optionalServices: GOPRO_SERVICES,
  });

  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await connectAndEnable(device, onProgress); }
    catch (e) {
      lastErr = e;
      if (e?.name === 'NotFoundError' || e?.name === 'AbortError') throw e; // user cancelled
      if (!/disconnect/i.test(e?.message || '') || attempt === 3) break;     // only retry drops
      onProgress(`GoPro dropped Bluetooth — retrying (${attempt + 1}/3)…`);
      try { device.gatt.disconnect(); } catch { /* ignore */ }
      await delay(900);
    }
  }
  if (/disconnect/i.test(lastErr?.message || '')) {
    throw new Error(`GoPro kept dropping the Bluetooth link. On the camera, go to Preferences → Connections → Connect Device (Quik App) to put it in pairing mode, then try again. (${lastErr.message})`);
  }
  throw lastErr;
}

// One connect→enable-Wi-Fi→read attempt. Writes as soon as possible after
// connecting (no settle delay) to beat the camera's drop timer.
async function connectAndEnable(device, onProgress) {
  onProgress(`Connecting to ${device.name || 'GoPro'} over Bluetooth…`);
  const server = await step('connect', () => device.gatt.connect());
  try {
    const services = await step('discover services', () => getServices(server));
    // The b5f9xxxx characteristics are split across a few GoPro services whose
    // grouping varies by model, so search all of them rather than hard-coding.
    const findChar = (uuid) => step(`find ${uuid.slice(0, 8)}`, async () => {
      for (const svc of services) { try { return await svc.getCharacteristic(uuid); } catch { /* not here */ } }
      throw new Error('characteristic not found');
    });

    onProgress('Turning on the GoPro Wi-Fi…');
    const cmd = await findChar(CHAR_COMMAND);
    await step('enable Wi-Fi', () => writeChar(cmd, AP_ON_COMMAND));
    await delay(1200); // give the camera a moment to bring the AP up

    onProgress('Reading the Wi-Fi name and password…');
    const ssidChar = await findChar(CHAR_WIFI_SSID);
    const passChar = await findChar(CHAR_WIFI_PASSWORD);
    const ssid = decodeBleString(await step('read SSID', () => ssidChar.readValue()));
    const password = decodeBleString(await step('read password', () => passChar.readValue()));
    if (!ssid) throw new Error('GoPro returned an empty Wi-Fi name.');
    return { name: device.name || 'GoPro', ssid, password };
  } finally {
    // The AP stays on after we drop BLE; disconnect to free the radio.
    try { server.disconnect(); } catch { /* ignore */ }
  }
}

// A record-only GoPro: a persistent BLE connection that triggers on-camera (SD)
// recording on demand. No streaming — used as a second camera alongside the
// live/streamed one. Keeps the link alive so shutter commands are instant.
export class GoProRecorder {
  constructor() {
    this.device = null;
    this.server = null;
    this.cmd = null;       // Command Request characteristic (shutter)
    this.settings = null;  // Settings Request characteristic (keep-alive)
    this._statusCbs = [];
    this._keepAlive = null;
    this._onDisc = null;
    this._closing = false;
    this._reconnectTries = 0;
  }

  onStatus(cb) { this._statusCbs.push(cb); return this; }
  _status(s) { for (const cb of this._statusCbs) cb(s); }
  get name() { return (this.device && this.device.name) || 'GoPro'; }
  isConnected() { return !!(this.server && this.server.connected && this.cmd); }

  // Pick a GoPro and connect. Throws (incl. user-cancelled chooser).
  async connect(onProgress = () => {}) {
    if (typeof navigator === 'undefined' || !navigator.bluetooth) throw new Error('Web Bluetooth is not available here.');
    onProgress('Select your GoPro…');
    this.device = await navigator.bluetooth.requestDevice({ filters: [{ namePrefix: 'GoPro' }], optionalServices: GOPRO_SERVICES });
    this._closing = false;
    this._onDisc = () => this._handleDrop();
    this.device.addEventListener('gattserverdisconnected', this._onDisc);
    await this._open(onProgress);
  }

  async _open(onProgress = () => {}) {
    onProgress(`Connecting to ${this.name} over Bluetooth…`);
    this.server = await step('connect', () => this.device.gatt.connect());
    const services = await step('discover services', () => getServices(this.server));
    const find = (uuid) => step(`find ${uuid.slice(0, 8)}`, async () => {
      for (const svc of services) { try { return await svc.getCharacteristic(uuid); } catch { /* not here */ } }
      throw new Error('characteristic not found');
    });
    this.cmd = await find(CHAR_COMMAND);
    try { this.settings = await find(CHAR_SETTINGS); } catch { this.settings = null; }
    this._reconnectTries = 0;
    clearInterval(this._keepAlive);
    this._keepAlive = setInterval(() => this._keepAliveTick(), 3000);
    this._status({ state: 'connected', name: this.name });
  }

  async _keepAliveTick() {
    if (!this.isConnected()) return;
    try { await writeChar(this.settings || this.cmd, KEEP_ALIVE); } catch { /* best-effort */ }
  }

  // Start (on=true) / stop on-camera recording.
  async record(on) {
    if (!this.isConnected()) throw new Error('Record-only GoPro is not connected');
    await step('shutter', () => writeChar(this.cmd, on ? SHUTTER_ON : SHUTTER_OFF));
  }

  async _handleDrop() {
    this.cmd = null; this.settings = null;
    clearInterval(this._keepAlive); this._keepAlive = null;
    if (this._closing) return;
    // Camera slept or went out of range — try to reconnect a few times.
    if (this._reconnectTries < 5) {
      this._reconnectTries++;
      this._status({ state: 'reconnecting', name: this.name });
      await delay(1500);
      if (this._closing) return;
      try { await this._open(); return; } catch { /* fall through to retry/lost */ }
      if (this._reconnectTries >= 5) this._status({ state: 'lost', name: this.name });
    } else {
      this._status({ state: 'lost', name: this.name });
    }
  }

  disconnect() {
    this._closing = true;
    clearInterval(this._keepAlive); this._keepAlive = null;
    if (this.device && this._onDisc) { try { this.device.removeEventListener('gattserverdisconnected', this._onDisc); } catch {} }
    try { this.server && this.server.disconnect(); } catch { /* ignore */ }
    this.server = null; this.cmd = null; this.settings = null;
    this._status({ state: 'disconnected', name: this.name });
  }
}
