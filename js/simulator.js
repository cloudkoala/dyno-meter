// Fake LS3 for testing without hardware. Generates spec-accurate 20-byte
// packets and runs them through the real parse pipeline, so the rest of the
// app can't tell it apart from a real device.

import { Source } from './connection.js';
import { encodePacket, parsePacket } from './protocol.js';

const KN_TO = { N: 1, G: 101.9716, B: 224.8089 }; // kN -> kN/kgf/lbf

export class Simulator extends Source {
  constructor() {
    super();
    this.deviceType = 'sim';
    this.deviceLabel = 'Simulated device';
    this.unitCode = 'N';
    this.speedCode = 'F';
    this.measureMode = 'N';
    this.refZero = 0;
    this.battery = 88;
    this._t = 0;
    this._timer = null;
  }

  static get supported() { return true; }

  async connect() {
    this._emitStatus({ state: 'connecting' });
    this._start();
    this._emitStatus({ state: 'connected', name: 'Simulated LS3' });
    return this;
  }

  async disconnect() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._emitStatus({ state: 'disconnected' });
  }

  _hz() { return this.speedCode === 'S' ? 10 : 40; }

  _start() {
    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(() => this._tick(), 1000 / this._hz());
  }

  async send(cmdName) {
    switch (cmdName) {
      case 'UNIT_KN': this.unitCode = 'N'; break;
      case 'UNIT_KGF': this.unitCode = 'G'; break;
      case 'UNIT_LBF': this.unitCode = 'B'; break;
      case 'SPEED_10HZ': this.speedCode = 'S'; this._start(); break;
      case 'SPEED_40HZ': this.speedCode = 'F'; this._start(); break;
      case 'ZERO': this.refZero = -this._baseKn(); this.measureMode = 'Z'; break;
      case 'SET_ABS_ZERO': this.measureMode = 'N'; this.refZero = 0; break;
      case 'ZERO_MODE_REL': this.measureMode = 'Z'; break;
      case 'ZERO_MODE_ABS': this.measureMode = 'N'; break;
      case 'OFFLINE': await this.disconnect(); break;
      // CLEAR_PEAK / ONLINE: nothing to do for the stream itself.
    }
  }

  // A plausible load curve in kN: drifting baseline + slow swell + occasional
  // pulls + a little noise. Deterministic-ish (no Math.random dependency on time).
  _baseKn() {
    const t = this._t / this._hz(); // seconds
    const swell = 2.2 + 1.6 * Math.sin(t * 0.5);
    const pull = Math.max(0, Math.sin(t * 0.13)) ** 6 * 4.0; // periodic hard pulls
    const noise = (Math.sin(t * 31.7) + Math.sin(t * 53.3)) * 0.05;
    return Math.max(0, swell + pull + noise);
  }

  _tick() {
    this._t++;
    const baseKn = this._baseKn();
    const displayKn = this.measureMode === 'Z' ? baseKn + this.refZero : baseKn;
    const value = displayKn * KN_TO[this.unitCode];
    const refZeroDisp = (this.measureMode === 'Z' ? this.refZero : 0) * KN_TO[this.unitCode];

    const bytes = encodePacket({
      workingMode: 'R',
      value,
      measureMode: this.measureMode,
      refZero: refZeroDisp,
      battery: this.battery,
      unitCode: this.unitCode,
      speedCode: this.speedCode,
    });
    const reading = parsePacket(bytes);
    if (reading) this._emitReading(reading);
  }
}
