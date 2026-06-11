// Recording storage. Live readings are appended to an in-memory recording
// while one is active; on stop it's persisted to IndexedDB so sessions survive
// page reloads. Each recording keeps its full sample series for graphing/export.

const DB_NAME = 'ls3-logger';
const DB_VERSION = 1;
const STORE = 'recordings';

function idb(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class Store {
  constructor() {
    this.db = null;
    this.current = null; // active recording, or null
    this._startWall = 0;
  }

  async open() {
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this;
  }

  _tx(mode) {
    return this.db.transaction(STORE, mode).objectStore(STORE);
  }

  get recording() { return this.current !== null; }

  // Start a multi-channel recording. `specs` is an array of channel specs
  // [{ label, unit }] — one per channel being recorded. A single-device caller
  // passes one spec; legacy callers may pass a bare unit string (back-compat).
  // Session metadata lives top-level; per-channel data lives in `channels[]`.
  startRecording(meta, specs) {
    const m = meta || {};
    // Back-compat: a bare unit string -> one unlabeled channel.
    if (typeof specs === 'string') specs = [{ label: '', unit: specs }];
    if (!Array.isArray(specs) || !specs.length) specs = [{ label: '', unit: 'kN' }];
    this._startWall = Date.now();
    const channels = specs.map((s) => ({
      label: (s.label || '').trim(),
      unit: s.unit || 'kN',
      max: 0,
      samples: [], // { t: ms since start, value, abs }
    }));
    this.current = {
      id: `rec-${this._startWall}`,
      testId: (m.testId || '').trim(),
      sample: (m.sample || '').trim(),
      config: (m.config || '').trim(),
      material: Array.isArray(m.material) ? m.material : (m.material ? [m.material] : []),
      name: m.name && m.name.trim() ? m.name.trim() : `Session ${new Date(this._startWall).toLocaleString()}`,
      startedAt: this._startWall,
      endedAt: null,
      channels,
      // Derived top-level fields (kept in sync on append / finalized on stop).
      unit: channels[0].unit,
      max: 0,
      min: 0,
      samples: channels[0].samples, // alias: primary channel (back-compat)
    };
    return this.current;
  }

  // Append a live reading to a specific channel of the active recording.
  // No-op if not recording or the index is out of range.
  appendChannel(index, reading, absValue) {
    if (!this.current) return;
    const ch = this.current.channels[index];
    if (!ch) return;
    const t = Date.now() - this._startWall;
    ch.samples.push({ t, value: reading.value, abs: absValue });
    if (reading.value > ch.max) ch.max = reading.value;
    ch.unit = reading.unit;
    // Keep derived top-level peak + unit in sync.
    if (reading.value > this.current.max) this.current.max = reading.value;
    if (reading.value < this.current.min) this.current.min = reading.value;
    this.current.unit = this.current.channels[0].unit;
  }

  // Back-compat single-channel append (appends to channel 0).
  append(reading, absValue) { this.appendChannel(0, reading, absValue); }

  // Finalize the active recording. Persists to IndexedDB unless persist:false
  // (used when a folder is the session library and the file is written there).
  async stop({ persist = true } = {}) {
    if (!this.current) return null;
    const rec = this.current;
    rec.endedAt = Date.now();
    // Recompute derived totals across all channels.
    rec.max = peakOf(rec.channels);
    rec.unit = rec.channels[0]?.unit || rec.unit;
    rec.count = rec.channels.reduce((n, c) => n + c.samples.length, 0);
    rec.duration = rec.endedAt - rec.startedAt;
    if (persist) await idb(this._tx('readwrite').put(rec));
    this.current = null;
    return rec;
  }

  // Persist a finalized recording (used when naming happens after stopping).
  async persist(rec) {
    await idb(this._tx('readwrite').put(rec));
  }

  async list() {
    const all = await idb(this._tx('readonly').getAll());
    return all
      .map((r) => {
        const chans = asChannels(r);
        return {
          id: r.id, name: r.name, startedAt: r.startedAt, endedAt: r.endedAt,
          unit: chans[0]?.unit || r.unit,
          max: peakOf(chans),
          count: chans.reduce((n, c) => n + c.samples.length, 0),
          channelCount: chans.length,
          duration: r.duration ?? (r.endedAt - r.startedAt),
          config: r.config || '',
          material: Array.isArray(r.material) ? r.material : (r.material ? [r.material] : []),
        };
      })
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  async get(id) {
    return idb(this._tx('readonly').get(id));
  }

  async rename(id, name) {
    const rec = await this.get(id);
    if (!rec) return;
    rec.name = name;
    await idb(this._tx('readwrite').put(rec));
  }

  async remove(id) {
    await idb(this._tx('readwrite').delete(id));
  }

  async toCSV(id) {
    const rec = await this.get(id);
    return rec ? recordingToCSV(rec) : '';
  }
}

// Normalize any recording (legacy or new) to a channels array. Legacy recs
// (top-level samples/unit/max, no channels) become one unlabeled channel.
export function asChannels(rec) {
  if (rec && Array.isArray(rec.channels) && rec.channels.length) return rec.channels;
  return [{ label: '', unit: rec?.unit || 'kN', max: rec?.max || 0, samples: rec?.samples || [] }];
}

// Peak value across all channels.
export function peakOf(channels) {
  let max = 0;
  for (const c of channels) if (c.max > max) max = c.max;
  return max;
}

// Pure CSV serialization (no I/O) — exported for testing and reuse.
// Single channel -> the original WIDE format (byte-for-byte unchanged).
// Two or more channels -> the LONG format (one row per channel per sample).
export function recordingToCSV(rec) {
  const channels = asChannels(rec);
  const unit = channels[0].unit;
  return channels.length >= 2
    ? recordingToLongCSV(rec, channels, unit)
    : recordingToWideCSV(rec, channels[0], unit);
}

function metaHeader(rec) {
  return [
    `# LineScale 3 recording: ${rec.name}`,
    `# test id: ${rec.testId || ''}`,
    `# sample: ${rec.sample || ''}`,
    `# configuration: ${rec.config || ''}`,
    `# material: ${(Array.isArray(rec.material) ? rec.material : (rec.material ? [rec.material] : [])).join('; ')}`,
    `# started: ${new Date(rec.startedAt).toISOString()}`,
  ];
}

function recordingToWideCSV(rec, ch, unit) {
  const lines = [
    ...metaHeader(rec),
    `# unit: ${unit}`,
    `# samples: ${ch.samples.length}  max: ${ch.max}`,
    `time_s,value_${unit},absolute_${unit}`,
  ];
  for (const s of ch.samples) lines.push(`${(s.t / 1000).toFixed(3)},${s.value},${s.abs}`);
  return lines.join('\n');
}

function recordingToLongCSV(rec, channels, unit) {
  const labels = channels.map((c, i) => c.label || `Channel ${i + 1}`);
  const total = channels.reduce((n, c) => n + c.samples.length, 0);
  const lines = [
    ...metaHeader(rec),
    `# channels: ${labels.join('; ')}`,
    `# unit: ${unit}`,
    `# samples: ${total}  max: ${peakOf(channels)}`,
    'time_s,channel,value,absolute',
  ];
  // Flatten to rows, then sort by time ascending (ties keep channel order).
  const rows = [];
  channels.forEach((c, ci) => {
    for (const s of c.samples) rows.push({ t: s.t, ci, label: labels[ci], value: s.value, abs: s.abs });
  });
  rows.sort((a, b) => (a.t - b.t) || (a.ci - b.ci));
  for (const r of rows) lines.push(`${(r.t / 1000).toFixed(3)},${r.label},${r.value},${r.abs}`);
  return lines.join('\n');
}
