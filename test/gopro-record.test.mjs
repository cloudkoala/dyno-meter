// Run: node test/gopro-record.test.mjs
// Verifies the record-only GoPro shutter command bytes and that GoProRecorder
// writes the right bytes. The live BLE connect flow needs real Web Bluetooth.
import { SHUTTER_ON, SHUTTER_OFF, KEEP_ALIVE, GoProRecorder } from '../js/gopro-ble.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') =>
  cond ? (pass++, console.log(`  ok  ${name}`))
       : (fail++, console.error(`FAIL  ${name}  ${detail}`));

const bytes = (u8) => [...u8];
check('shutter start = 03 01 01 01', bytes(SHUTTER_ON).join(',') === '3,1,1,1', bytes(SHUTTER_ON).join(','));
check('shutter stop  = 03 01 01 00', bytes(SHUTTER_OFF).join(',') === '3,1,1,0', bytes(SHUTTER_OFF).join(','));
check('keep-alive    = 03 5B 01 42', bytes(KEEP_ALIVE).join(',') === '3,91,1,66', bytes(KEEP_ALIVE).join(','));

// A mock Command characteristic that records what was written.
function mockChar() {
  const writes = [];
  return {
    writes,
    properties: { write: true },
    writeValueWithResponse(b) { writes.push([...new Uint8Array(b.buffer || b)]); return Promise.resolve(); },
  };
}

const rec = new GoProRecorder();
rec.server = { connected: true };
rec.cmd = mockChar();

check('record() refuses when not connected', await (async () => {
  const r = new GoProRecorder();
  try { await r.record(true); return false; } catch { return true; }
})());

await rec.record(true);
check('record(true) writes shutter-start', rec.cmd.writes.at(-1)?.join(',') === '3,1,1,1', JSON.stringify(rec.cmd.writes));
await rec.record(false);
check('record(false) writes shutter-stop', rec.cmd.writes.at(-1)?.join(',') === '3,1,1,0', JSON.stringify(rec.cmd.writes));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
