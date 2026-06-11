// Auto-save recordings into a user-chosen local folder via the File System
// Access API (Chrome/Edge only). The chosen directory handle is persisted in
// its own IndexedDB so the folder is remembered across reloads. The browser
// re-asks permission once per session; we request it from a user gesture.

const DB = 'ls3-fs', STORE = 'handles', KEY = 'dir';

export function fsSupported() {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idb(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
  });
}

export async function pickFolder() {
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  await idb('readwrite', (s) => s.put(handle, KEY));
  return handle;
}

export function savedFolder() { return idb('readonly', (s) => s.get(KEY)); }

export async function ensurePermission(handle, { prompt = false } = {}) {
  if (!handle) return false;
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if (!prompt) return false;
  try { return (await handle.requestPermission(opts)) === 'granted'; }
  catch { return false; }
}

function safe(name) {
  return String(name).replace(/[\/\\:*?"<>|]+/g, '_').trim() || 'session';
}

async function fileExists(dir, filename) {
  try { await dir.getFileHandle(filename); return true; } catch { return false; }
}

// Pick a base name where none of base.<ext> already exist (avoids clobbering).
async function uniqueBase(dir, base, exts) {
  let candidate = base, n = 1;
  // eslint-disable-next-line no-await-in-loop
  while ((await Promise.all(exts.map((e) => fileExists(dir, `${candidate}.${e}`)))).some(Boolean)) {
    candidate = `${base} (${++n})`;
  }
  return candidate;
}

async function writeFile(dir, filename, blob) {
  const fh = await dir.getFileHandle(filename, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
}

// files = { csv: Blob, png: Blob, ... }. Writes each under a unique base name.
// Returns the base name used.
export async function saveFiles(dir, name, files) {
  const exts = Object.keys(files);
  const base = await uniqueBase(dir, safe(name), exts);
  for (const ext of exts) await writeFile(dir, `${base}.${ext}`, files[ext]);
  return base;
}

// ---- folder as a session library ----------------------------------------

// Parse a recording CSV (as written by store.recordingToCSV) back into a
// recording object. Pure — exported for testing.
export function parseSessionCsv(text, baseName) {
  const lines = text.split(/\r?\n/);
  let name = baseName, startedAt = 0, unit = 'kN', max = 0;
  let testId = '', sample = '', config = '', material = '', channelHdr = '';
  let format = null; // 'wide' | 'long' (detected from the column-header line)
  const dataLines = [];
  for (const line of lines) {
    if (!line) continue;
    if (line[0] === '#') {
      let m;
      if ((m = line.match(/^#\s*LineScale 3 recording:\s*(.*)$/))) name = m[1].trim() || baseName;
      else if ((m = line.match(/^#\s*test id:\s*(.*)$/))) testId = m[1].trim();
      else if ((m = line.match(/^#\s*sample:\s*(.*)$/))) sample = m[1].trim();
      else if ((m = line.match(/^#\s*configuration:\s*(.*)$/))) config = m[1].trim();
      else if ((m = line.match(/^#\s*material:\s*(.*)$/))) material = m[1].trim();
      else if ((m = line.match(/^#\s*channels:\s*(.*)$/))) channelHdr = m[1].trim();
      else if ((m = line.match(/^#\s*started:\s*(.*)$/))) { const d = Date.parse(m[1].trim()); if (!Number.isNaN(d)) startedAt = d; }
      else if ((m = line.match(/^#\s*unit:\s*(.*)$/))) unit = m[1].trim() || unit;
      else if ((m = line.match(/max:\s*([-\d.]+)/))) max = parseFloat(m[1]) || max;
      continue;
    }
    if (line.startsWith('time_s')) {
      // Detect format from the column-header line.
      format = /^time_s,channel,/.test(line) ? 'long' : 'wide';
      continue;
    }
    dataLines.push(line);
  }
  const materials = material ? material.split(';').map((x) => x.trim()).filter(Boolean) : [];

  let channels;
  if (format === 'long') {
    channels = parseLongRows(dataLines, channelHdr, unit);
  } else {
    // Wide (single channel) — preserve the original parsing exactly.
    const samples = [];
    for (const line of dataLines) {
      const p = line.split(',');
      const t = parseFloat(p[0]), v = parseFloat(p[1]);
      if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
      const a = p.length > 2 ? parseFloat(p[2]) : v;
      samples.push({ t: t * 1000, value: v, abs: Number.isFinite(a) ? a : v });
    }
    let cmax = 0;
    for (const s of samples) if (s.value > cmax) cmax = s.value;
    channels = [{ label: '', unit, max: cmax, samples }];
  }

  // Derived totals across channels.
  let lastT = 0, firstT = Infinity, peak = 0, count = 0;
  for (const c of channels) {
    if (c.max > peak) peak = c.max;
    count += c.samples.length;
    for (const s of c.samples) { if (s.t > lastT) lastT = s.t; if (s.t < firstT) firstT = s.t; }
  }
  if (!Number.isFinite(firstT)) firstT = 0;
  const duration = count ? lastT - firstT : 0;
  if (!max) max = peak; else if (peak > max) max = peak;

  // Single-channel return keeps the legacy flat fields the existing
  // code/tests rely on; channels[] is always present for uniform callers.
  const primary = channels[0];
  return {
    id: baseName, name, testId, sample, config, material: materials,
    startedAt, endedAt: startedAt + duration, unit, max, count, duration,
    channels, samples: primary.samples,
  };
}

// Parse long-format data rows into channels[], grouped/ordered by the
// `# channels:` header (which fixes label + order); rows for unlisted labels
// are appended in first-seen order.
function parseLongRows(dataLines, channelHdr, unit) {
  const labels = channelHdr ? channelHdr.split(';').map((x) => x.trim()).filter(Boolean) : [];
  const byLabel = new Map();
  const ensure = (label) => {
    let c = byLabel.get(label);
    if (!c) { c = { label, unit, max: 0, samples: [] }; byLabel.set(label, c); }
    return c;
  };
  for (const label of labels) ensure(label); // seed order from header
  for (const line of dataLines) {
    // value/abs are numeric; channel is everything between the first comma and
    // the last two commas (so labels containing commas would still need quoting,
    // but our labels are sanitized).
    const first = line.indexOf(',');
    if (first === -1) continue;
    const lastComma = line.lastIndexOf(',');
    const secondLast = line.lastIndexOf(',', lastComma - 1);
    const t = parseFloat(line.slice(0, first));
    const label = line.slice(first + 1, secondLast);
    const v = parseFloat(line.slice(secondLast + 1, lastComma));
    const a = parseFloat(line.slice(lastComma + 1));
    if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
    const c = ensure(label);
    const av = Number.isFinite(a) ? a : v;
    c.samples.push({ t: t * 1000, value: v, abs: av });
    if (v > c.max) c.max = v;
  }
  return [...byLabel.values()];
}

export async function listSessions(dir) {
  const out = [];
  for await (const entry of dir.values()) {
    if (entry.kind !== 'file' || !entry.name.toLowerCase().endsWith('.csv')) continue;
    const base = entry.name.replace(/\.csv$/i, '');
    try {
      const rec = parseSessionCsv(await (await entry.getFile()).text(), base);
      out.push({ id: base, name: rec.name, startedAt: rec.startedAt, endedAt: rec.endedAt,
        unit: rec.unit, max: rec.max, count: rec.count, duration: rec.duration,
        channelCount: rec.channels.length,
        config: rec.config, material: rec.material });
    } catch { /* skip unreadable files */ }
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

export async function readSession(dir, base) {
  const fh = await dir.getFileHandle(`${base}.csv`);
  return parseSessionCsv(await (await fh.getFile()).text(), base);
}

export async function readCsvBlob(dir, base) {
  return (await dir.getFileHandle(`${base}.csv`)).getFile();
}

// Return a File for an arbitrary entry in the directory (throws if missing).
export async function readFileBlob(dir, filename) {
  return (await dir.getFileHandle(filename)).getFile();
}

export async function hasSession(dir, name) {
  return fileExists(dir, `${safe(name)}.csv`);
}

export async function deleteSession(dir, base) {
  for (const ext of ['csv', 'png']) { try { await dir.removeEntry(`${base}.${ext}`); } catch { /* ignore */ } }
}

// Rename a session's files. Returns the new base name (filename, no extension).
export async function renameSession(dir, oldBase, newName) {
  if (safe(newName) === oldBase) return oldBase; // no change
  const newBase = await uniqueBase(dir, safe(newName), ['csv']);
  try {
    const text = await (await (await dir.getFileHandle(`${oldBase}.csv`)).getFile()).text();
    const updated = text.replace(/^#\s*LineScale 3 recording:.*$/m, `# LineScale 3 recording: ${newName}`);
    await writeFile(dir, `${newBase}.csv`, new Blob([updated], { type: 'text/csv' }));
    await dir.removeEntry(`${oldBase}.csv`);
  } catch { /* ignore */ }
  try {
    const png = await (await dir.getFileHandle(`${oldBase}.png`)).getFile();
    await writeFile(dir, `${newBase}.png`, png);
    await dir.removeEntry(`${oldBase}.png`);
  } catch { /* no png */ }
  return newBase;
}
