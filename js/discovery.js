// Discovery / capture mode — the in-app reverse-engineering tool. Connects to
// ANY BLE device, enumerates every primary service + characteristic, subscribes
// to all notifiable characteristics, and streams the raw bytes (timestamp · char
// · hex · ascii) to the debug panel for capture/export. Also writes arbitrary
// hex to a chosen characteristic to probe for commands.
//
// Used to capture the Rock Exotica Enforcer's traffic so its protocol can be
// decoded (see js/enforcer.js). Knows nothing device-specific.

import { Source } from './connection.js';
import { short, toHex, toAscii, charFlags, parseHex } from './ble-util.js';

// Web Bluetooth can only access services listed in optionalServices, even with
// acceptAllDevices. This curated list covers Nordic UART + common 16-bit serial
// services; the user can add the device's real UUID via the escape hatch.
const COMMON_SERVICES = [
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART Service
  0x1800, 0x1801, 0x180a, 0x180f,         // generic access/attribute, device info, battery
  0xffe0, 0xffe5, 0xfff0, 0xfff5, 0xfee0, // common vendor serial profiles
];

export class DiscoverySource extends Source {
  constructor(extraServices = []) {
    super();
    this.deviceType = 'discovery';
    this.deviceLabel = 'Discovery (capture)';
    this.canSetUnit = false;
    this.device = null;
    this.server = null;
    this._chars = new Map();   // char uuid -> BluetoothRemoteGATTCharacteristic
    this._notifying = [];
    this._t0 = null;
    this._optionalServices = [...COMMON_SERVICES, ...extraServices];
    this._onDisconnect = () => this._emitStatus({ state: 'disconnected' });
  }

  static get supported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  async connect() {
    if (!DiscoverySource.supported) {
      throw new Error('Web Bluetooth is not available. Use Chrome or Edge.');
    }
    this._emitStatus({ state: 'connecting' });
    this._log('Discovery mode — connect this as the only device, then capture below.');

    this.device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: this._optionalServices,
    });
    this._log(`device: ${this.device.name || '(unnamed)'} [${this.device.id}]`);
    this.device.addEventListener('gattserverdisconnected', this._onDisconnect);

    this.server = await this.device.gatt.connect();
    this._emitStatus({ state: 'connected', name: this.device.name || 'Discovery' });

    let services = [];
    try { services = await this.server.getPrimaryServices(); } catch (e) { this._log(`getPrimaryServices failed: ${e.message}`); }
    this._log(`found ${services.length} accessible primary service(s)`);

    const writable = [];
    for (const svc of services) {
      let chars = [];
      try { chars = await svc.getCharacteristics(); }
      catch (e) { this._log(`  service ${short(svc.uuid)}: ${e.message}`); continue; }
      this._log(`service ${short(svc.uuid)} — ${chars.length} characteristic(s):`);
      for (const c of chars) {
        const p = c.properties;
        this._log(`  • ${short(c.uuid)}  [${charFlags(p)}]`);
        this._chars.set(c.uuid, c);
        if (p.write || p.writeWithoutResponse) {
          writable.push({ uuid: c.uuid, label: `${short(svc.uuid)} / ${short(c.uuid)}` });
        }
        if (p.notify || p.indicate) {
          try {
            c.addEventListener('characteristicvaluechanged', (e) => this._onCapture(c.uuid, e));
            await c.startNotifications();
            this._notifying.push(c);
            this._log('    ↳ subscribed');
          } catch (e) { this._log(`    ↳ subscribe failed: ${e.message}`); }
        }
      }
    }
    this._diag({ chars: writable });
    if (!this._notifying.length) {
      this._log('⚠ no notifiable characteristics found — add the device service UUID and reconnect');
    }
    return this;
  }

  _onCapture(charUuid, event) {
    const view = event.target.value; // DataView
    const bytes = [];
    for (let i = 0; i < view.byteLength; i++) bytes.push(view.getUint8(i));
    if (this._t0 == null) this._t0 = performance.now();
    const ts = ((performance.now() - this._t0) / 1000).toFixed(3);
    const hex = toHex(bytes), ascii = toAscii(bytes);
    this._diag({ capture: { ts, char: short(charUuid), hex, ascii } });
    this._diag({ raw: { hex, ascii } });
  }

  // Write arbitrary hex bytes to a discovered characteristic (command probing).
  async writeHex(charUuid, hexString) {
    const c = this._chars.get(charUuid);
    if (!c) throw new Error('Choose a characteristic to write to');
    const bytes = parseHex(hexString);
    try {
      if (c.properties.write) await c.writeValue(bytes);
      else await c.writeValueWithoutResponse(bytes);
    } catch (e) {
      if (c.properties.write) await c.writeValueWithoutResponse(bytes);
      else await c.writeValue(bytes);
    }
    this._log(`wrote ${toHex([...bytes])} -> ${short(charUuid)}`);
  }

  async send() { /* discovery mode has no named commands */ }

  async disconnect() {
    for (const c of this._notifying) { try { await c.stopNotifications(); } catch { /* ignore */ } }
    this._notifying = [];
    try {
      if (this.server && this.server.connected) this.server.disconnect();
    } catch { /* ignore */ }
  }
}
