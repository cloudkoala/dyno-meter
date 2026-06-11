// Small BLE/byte formatting helpers, shared by the connection backend and the
// discovery/capture mode. Pure functions — no I/O.

// 0000XXXX-0000-1000-8000-00805f9b34fb -> 0xXXXX (the 16-bit short form),
// otherwise the full uuid unchanged.
export function short(uuid) {
  const m = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/i.exec(uuid);
  return m ? `0x${m[1]}` : uuid;
}

export function toHex(bytes) {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

export function toAscii(bytes) {
  return bytes.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '·')).join('');
}

// Parse a hex string ("41 0d 0a 58", "410d0a58", "0x41,0x0d") into a Uint8Array.
// Throws on any non-hex-byte token so the caller can surface a clear error.
export function parseHex(text) {
  const tokens = String(text).trim().split(/[\s,]+/).filter(Boolean);
  const out = [];
  for (let tok of tokens) {
    tok = tok.replace(/^0x/i, '');
    if (!/^[0-9a-f]{1,2}$/i.test(tok)) throw new Error(`Bad hex byte: "${tok}"`);
    out.push(parseInt(tok, 16));
  }
  if (!out.length) throw new Error('No hex bytes to write');
  return Uint8Array.from(out);
}

// Build the "[notify,write,…]" capability flag string for a characteristic.
export function charFlags(props) {
  return [
    props.notify && 'notify', props.indicate && 'indicate', props.read && 'read',
    props.write && 'write', props.writeWithoutResponse && 'writeNoResp',
  ].filter(Boolean).join(',');
}
