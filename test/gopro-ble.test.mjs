// Run: node test/gopro-ble.test.mjs
// Verifies the pure GoPro BLE helpers (command bytes + string decoding). The
// actual connect flow needs a real Web Bluetooth stack.
import { AP_ON_COMMAND, decodeBleString } from '../js/gopro-ble.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') =>
  cond ? (pass++, console.log(`  ok  ${name}`))
       : (fail++, console.error(`FAIL  ${name}  ${detail}`));

// AP Control "on": length=3, cmd=0x17, paramLen=1, value=1.
check('AP-on command bytes', AP_ON_COMMAND.length === 4 &&
  AP_ON_COMMAND[0] === 0x03 && AP_ON_COMMAND[1] === 0x17 &&
  AP_ON_COMMAND[2] === 0x01 && AP_ON_COMMAND[3] === 0x01, [...AP_ON_COMMAND].join(','));

const dv = (bytes) => new DataView(Uint8Array.from(bytes).buffer);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

check('decodes a plain SSID', decodeBleString(dv(ascii('GP24512345'))) === 'GP24512345');
check('strips trailing NULs', decodeBleString(dv([...ascii('GP123'), 0, 0, 0])) === 'GP123');
check('strips control bytes', decodeBleString(dv([...ascii('pass'), 0x0a, 0x0d])) === 'pass');
check('trims whitespace', decodeBleString(dv(ascii('  hello  '))) === 'hello');
check('accepts a Uint8Array directly', decodeBleString(Uint8Array.from(ascii('abc'))) === 'abc');
check('empty value -> empty string', decodeBleString(dv([])) === '');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
