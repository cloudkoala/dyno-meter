// Connection layer. BLEConnection talks to a device over Web Bluetooth, driven
// by a device "profile" (js/profiles.js) so one backend serves many devices.
// All sources (BLE, the simulator, discovery mode) share the Source interface:
// connect(), disconnect(), send(cmdName), onReading(cb), onStatus(cb).
// Sources may also emit diagnostics via onDiag(cb) for the debug panel, and
// declare their identity via deviceType/deviceLabel/defaultUnit/canSetUnit.

import { LS3_PROFILE } from './profiles.js';
import { short, toHex, toAscii, charFlags } from './ble-util.js';

export class Source {
  constructor() {
    this._readingCbs = [];
    this._statusCbs = [];
    this._diagCbs = [];
    // Device identity (subclasses override). Used by app.js for naming, units.
    this.deviceType = 'device';
    this.deviceLabel = 'Device';
    this.defaultUnit = 'kN';
    this.canSetUnit = true;
  }
  onReading(cb) { this._readingCbs.push(cb); return this; }
  onStatus(cb) { this._statusCbs.push(cb); return this; }
  onDiag(cb) { this._diagCbs.push(cb); return this; }
  _emitReading(r) { for (const cb of this._readingCbs) cb(r); }
  _emitStatus(s) { for (const cb of this._statusCbs) cb(s); }
  _diag(d) { for (const cb of this._diagCbs) cb(d); }
  _log(line) { this._diag({ line }); }
}

export class BLEConnection extends Source {
  constructor(profile = LS3_PROFILE) {
    super();
    this.profile = profile;
    this.deviceType = profile.deviceType;
    this.deviceLabel = profile.deviceLabel;
    this.defaultUnit = profile.defaultUnit;
    this.canSetUnit = profile.canSetUnit !== false;
    this.device = null;
    this.server = null;
    this.writeChar = null;
    this.notifyChar = null;
    this._writeNoResp = false;
    this._buf = [];
    this._watchdog = null;
    this._startTries = 0;
    this.stats = { notifs: 0, bytes: 0, frames: 0, parsed: 0, failed: 0 };
    this._onDisconnect = this._handleDisconnect.bind(this);
    this._onData = this._handleData.bind(this);
  }

  static get supported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  async connect() {
    if (!BLEConnection.supported) {
      throw new Error('Web Bluetooth is not available. Use Chrome or Edge.');
    }
    this._emitStatus({ state: 'connecting' });

    const services = this.profile.services || [];
    this.device = await navigator.bluetooth.requestDevice(
      this.profile.acceptAllDevices
        ? { acceptAllDevices: true, optionalServices: services }
        : { filters: services.map((s) => ({ services: [s] })), optionalServices: services },
    );
    this._log(`device: ${this.device.name || '(unnamed)'} [${this.device.id}]`);
    this.device.addEventListener('gattserverdisconnected', this._onDisconnect);

    this.server = await this.device.gatt.connect();
    const service = await this.server.getPrimaryService(services[0]);

    // Enumerate the service's characteristics so we can confirm the expected
    // UUIDs and fall back to capability-based detection if they differ.
    const chars = await service.getCharacteristics();
    this._log(`service ${short(services[0])} has ${chars.length} characteristic(s):`);
    for (const c of chars) {
      this._log(`  • ${short(c.uuid)}  [${charFlags(c.properties)}]`);
    }

    this.notifyChar =
      chars.find((c) => c.uuid === this.profile.notifyUuid) ||
      chars.find((c) => c.properties.notify || c.properties.indicate);
    this.writeChar =
      chars.find((c) => c.uuid === this.profile.writeUuid) ||
      chars.find((c) => c.properties.write || c.properties.writeWithoutResponse);

    if (!this.notifyChar) throw new Error('No notify characteristic found on device');
    if (!this.writeChar) throw new Error('No writable characteristic found on device');
    this._writeNoResp =
      !this.writeChar.properties.write && this.writeChar.properties.writeWithoutResponse;
    this._log(`notify: ${short(this.notifyChar.uuid)} · write: ${short(this.writeChar.uuid)} (${this._writeNoResp ? 'no-response' : 'with-response'})`);

    this._buf = [];
    this.notifyChar.addEventListener('characteristicvaluechanged', this._onData);
    await this.notifyChar.startNotifications();
    this._log('notifications started');

    this._emitStatus({ state: 'connected', name: this.device.name || this.profile.deviceLabel });

    // Ask the device to begin streaming (profile-defined). If no data arrives,
    // the watchdog re-runs the start sequence a few times.
    await this._startStreaming();
    this._armWatchdog();
    return this;
  }

  async _startStreaming() {
    this._startTries++;
    if (this.profile.startStream) await this.profile.startStream(this, this._startTries);
  }

  _armWatchdog() {
    clearInterval(this._watchdog);
    this._watchdog = setInterval(async () => {
      if (this.stats.frames > 0) { clearInterval(this._watchdog); this._watchdog = null; return; }
      if (this._startTries >= 5) {
        clearInterval(this._watchdog); this._watchdog = null;
        this._log('⚠ still no data after several attempts — see characteristic list above');
        this._diag({ noData: true });
        return;
      }
      this._log('no data yet — retrying start command');
      try { await this._startStreaming(); } catch (e) { this._log('retry failed: ' + e.message); }
    }, 1500);
  }

  async send(cmdName) {
    const frame = this.profile.cmd[cmdName];
    if (!frame) {
      if (this.profile.ignoreUnknownCmd) return; // device has no such command
      throw new Error(`Unknown command: ${cmdName}`);
    }
    if (!this.writeChar) throw new Error('Not connected');
    try {
      if (this._writeNoResp) await this.writeChar.writeValueWithoutResponse(frame);
      else await this.writeChar.writeValue(frame);
    } catch (e) {
      // Fall back to the other write method if the chosen one is unsupported.
      try {
        if (this._writeNoResp) await this.writeChar.writeValue(frame);
        else await this.writeChar.writeValueWithoutResponse(frame);
      } catch (e2) {
        this._log(`write ${cmdName} failed: ${e2.message || e.message}`);
        throw e2;
      }
    }
  }

  async disconnect() {
    clearInterval(this._watchdog); this._watchdog = null;
    try {
      if (this.writeChar && this.profile.cmd.OFFLINE) await this.send('OFFLINE').catch(() => {});
      if (this.notifyChar) await this.notifyChar.stopNotifications().catch(() => {});
    } finally {
      if (this.server && this.server.connected) this.server.disconnect();
    }
  }

  _handleDisconnect() {
    clearInterval(this._watchdog); this._watchdog = null;
    this.server = null;
    this.writeChar = null;
    this.notifyChar = null;
    this._emitStatus({ state: 'disconnected' });
  }

  _handleData(event) {
    const view = event.target.value; // DataView
    const bytes = [];
    for (let i = 0; i < view.byteLength; i++) bytes.push(view.getUint8(i));
    this.stats.notifs++;
    this.stats.bytes += bytes.length;
    this._diag({ raw: { hex: toHex(bytes), ascii: toAscii(bytes) } });
    if (this.profile.endFlag == null) {
      // Passthrough: each notification is a frame (framing unknown).
      this._consumeFrame(bytes);
      this._diag({ stats: { ...this.stats } });
    } else {
      this._buf.push(...bytes);
      this._drainFrames();
    }
  }

  _consumeFrame(frame) {
    this.stats.frames++;
    const reading = this.profile.parse(Uint8Array.from(frame));
    if (reading) { this.stats.parsed++; this._emitReading(reading); }
    else { this.stats.failed++; this._diag({ parseFail: toAscii(frame) }); }
  }

  // Split the rolling byte buffer into packetLen-byte frames terminated by the
  // profile's endFlag, tolerating BLE chunking and the occasional stray byte.
  _drainFrames() {
    const { endFlag, packetLen } = this.profile;
    let end;
    while ((end = this._buf.indexOf(endFlag)) !== -1) {
      const frameLen = end + 1;
      let frame = null;
      if (frameLen === packetLen) {
        frame = this._buf.slice(0, packetLen);
      } else if (frameLen > packetLen) {
        // Leading garbage: keep the last packetLen bytes up to and incl. the flag.
        frame = this._buf.slice(frameLen - packetLen, frameLen);
      }
      this._buf = this._buf.slice(frameLen); // drop consumed bytes either way
      if (frame) this._consumeFrame(frame);
    }
    this._diag({ stats: { ...this.stats } });
    // Guard against unbounded growth if no end flag ever arrives.
    if (this._buf.length > 4 * packetLen) {
      this._buf = this._buf.slice(this._buf.length - packetLen);
    }
  }
}
