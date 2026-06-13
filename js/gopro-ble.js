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
const CHAR_COMMAND_RESP = 'b5f90073-aa8d-11e3-9046-0002a5d5c51b';// Command Response (notify)
const CHAR_WIFI_SSID = 'b5f90002-aa8d-11e3-9046-0002a5d5c51b';   // Wi-Fi AP SSID (read)
const CHAR_WIFI_PASSWORD = 'b5f90003-aa8d-11e3-9046-0002a5d5c51b';// Wi-Fi AP password (read)

// All GoPro services we may need to reach (must be declared so Web Bluetooth
// grants access to their characteristics).
const GOPRO_SERVICES = [SVC_CONTROL, SVC_WIFI, 'b5f90090-aa8d-11e3-9046-0002a5d5c51b'];

// Strip NUL / control bytes (0x00–0x1f, 0x7f) some firmware appends to the
// SSID/password values. Built via RegExp() to keep control bytes out of source.
const CTRL_BYTES = new RegExp('[\\x00-\\x1f\\x7f]', 'g');

// TLV command: [length=0x03][command id 0x17 = AP Control][param length 0x01][0x01 = on].
export const AP_ON_COMMAND = Uint8Array.of(0x03, 0x17, 0x01, 0x01);

// Decode a BLE string characteristic value (SSID/password). GoPro returns the raw
// UTF-8 string; trim any trailing control bytes.
export function decodeBleString(dataview) {
  const bytes = dataview instanceof Uint8Array
    ? dataview
    : new Uint8Array(dataview.buffer, dataview.byteOffset, dataview.byteLength);
  return new TextDecoder().decode(bytes).replace(CTRL_BYTES, '').trim();
}

// Find a characteristic by UUID across all of the device's primary services
// (the b5f9xxxx characteristics are split across a few GoPro services, and the
// grouping varies by model — searching avoids hard-coding the wrong service).
async function findCharacteristic(server, charUuid) {
  const services = await server.getPrimaryServices();
  for (const svc of services) {
    try { return await svc.getCharacteristic(charUuid); } catch { /* not in this service */ }
  }
  throw new Error(`GoPro characteristic ${charUuid} not found`);
}

// Connect to a GoPro over BLE, enable its Wi-Fi AP, and return its credentials.
// onProgress(message) reports each step for UI feedback. Throws on failure
// (including the user cancelling the device chooser).
export async function enableGoProWifi(onProgress = () => {}) {
  if (typeof navigator === 'undefined' || !navigator.bluetooth) {
    throw new Error('Web Bluetooth is not available here.');
  }
  onProgress('Select your GoPro…');
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ namePrefix: 'GoPro' }],
    optionalServices: GOPRO_SERVICES,
  });

  onProgress(`Connecting to ${device.name || 'GoPro'} over Bluetooth…`);
  const server = await device.gatt.connect();
  try {
    const cmd = await findCharacteristic(server, CHAR_COMMAND);

    // Subscribe to the command response so we can confirm the AP turned on
    // (status byte 0x00 = success). Best-effort: some stacks reject notify.
    let resp = null;
    try { resp = await findCharacteristic(server, CHAR_COMMAND_RESP); } catch { /* optional */ }
    const ok = resp ? waitForCommandOk(resp, 0x17) : Promise.resolve();

    onProgress('Turning on the GoPro Wi-Fi…');
    await cmd.writeValueWithResponse(AP_ON_COMMAND);
    await Promise.race([ok, delay(3000)]); // don't hang forever if no notify

    onProgress('Reading the Wi-Fi name and password…');
    const ssid = decodeBleString(await (await findCharacteristic(server, CHAR_WIFI_SSID)).readValue());
    const password = decodeBleString(await (await findCharacteristic(server, CHAR_WIFI_PASSWORD)).readValue());
    if (!ssid) throw new Error('GoPro returned an empty Wi-Fi name.');
    return { name: device.name || 'GoPro', ssid, password };
  } finally {
    // The AP stays on after we drop BLE; disconnect to free the radio.
    try { server.disconnect(); } catch { /* ignore */ }
  }
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Resolve when the command-response characteristic reports success for `cmdId`.
function waitForCommandOk(respChar, cmdId) {
  return new Promise((resolve, reject) => {
    const onChange = (e) => {
      const v = e.target.value; // [length][command id][status]…
      if (v.byteLength >= 3 && v.getUint8(1) === cmdId) {
        cleanup();
        v.getUint8(2) === 0 ? resolve() : reject(new Error(`GoPro rejected AP-on (status ${v.getUint8(2)})`));
      }
    };
    const cleanup = () => { try { respChar.removeEventListener('characteristicvaluechanged', onChange); } catch {} };
    respChar.addEventListener('characteristicvaluechanged', onChange);
    respChar.startNotifications().catch(reject);
  });
}
