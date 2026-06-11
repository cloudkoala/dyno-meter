// Rock Exotica Enforcer load cell — protocol decoder.
//
// STATUS: SCAFFOLD. The Enforcer's BLE protocol is undocumented (no public SDK,
// API, or reverse-engineering). The real frame format must be CAPTURED from the
// device using the app's Discovery/capture mode, then decoded here.
//
// Until then `parseEnforcerReading` returns null (no value), so the rest of the
// pipeline runs unchanged. It must NEVER throw on arbitrary bytes.

// Build a reading in the standard shape consumed by app.handleReading and
// store.appendChannel. Shared by the (future) real parser and the simulator so
// the field set stays in one place. The Enforcer reads in kN (0–20 kN).
export function enforcerReading(value, { battery = null, overloaded = false } = {}) {
  return {
    workingMode: overloaded ? 'O' : 'R',
    overloaded,
    value,
    measureMode: 'N',   // absolute; the Enforcer has no relative-zero notion yet
    refZero: 0,
    battery,            // 0..100 or null when unknown
    unit: 'kN',
    unitCode: 'N',
    speedHz: null,      // unknown until the live cadence is characterised
    checksumOk: true,
  };
}

/**
 * Parse one Enforcer BLE notification into a reading.
 * @param {Uint8Array} bytes raw notification payload
 * @returns {object|null} reading (see enforcerReading), or null if undecodable.
 *
 * TODO(capture): once real frames are captured via Discovery mode, decode the
 * force value (scale to kN, 0–20 kN range), battery, and any status flags, and
 * set ENFORCER_PROFILE.endFlag/packetLen (or a custom drainer) in profiles.js.
 */
export function parseEnforcerReading(bytes) {
  if (!bytes || !bytes.length) return null;
  // No format known yet — decline to invent one.
  return null;
}
