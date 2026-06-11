// Fake Rock Exotica Enforcer for testing the UI without hardware (or a decoded
// protocol). Emits readings in the standard shape via enforcerReading(), so the
// Enforcer-typed device bar, recording, CSV, and graph can be exercised now.

import { Source } from './connection.js';
import { enforcerReading } from './enforcer.js';

export class EnforcerSimulator extends Source {
  constructor() {
    super();
    this.deviceType = 'enforcer-sim';
    this.deviceLabel = 'Rock Exotica Enforcer (sim)';
    this.canSetUnit = false; // kN-only, like the real device
    this.battery = 75;
    this._t = 0;
    this._timer = null;
  }

  static get supported() { return true; }

  async connect() {
    this._emitStatus({ state: 'connecting' });
    this._start();
    this._emitStatus({ state: 'connected', name: 'Enforcer (sim)' });
    return this;
  }

  async disconnect() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._emitStatus({ state: 'disconnected' });
  }

  async send() { /* no commands defined yet */ }

  _start() {
    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(() => this._tick(), 33); // ~30 Hz live cadence
  }

  // A plausible load curve in kN within the Enforcer's 0–20 kN range.
  _valueKn() {
    const t = this._t / 30; // seconds
    const swell = 6 + 4 * Math.sin(t * 0.5);
    const pull = Math.max(0, Math.sin(t * 0.13)) ** 6 * 9.0;
    const noise = (Math.sin(t * 31.7) + Math.sin(t * 53.3)) * 0.15;
    return Math.max(0, Math.min(20, swell + pull + noise));
  }

  _tick() {
    this._t++;
    this._emitReading(enforcerReading(this._valueKn(), { battery: this.battery }));
  }
}
