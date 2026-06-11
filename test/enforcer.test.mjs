// Run: node test/enforcer.test.mjs
// The Enforcer parser is a scaffold (real format TBD from captured bytes). These
// tests pin the contract: it never throws, and enforcerReading() yields the
// standard reading shape consumed by app.handleReading / store.appendChannel.
import { parseEnforcerReading, enforcerReading } from '../js/enforcer.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') =>
  cond ? (pass++, console.log(`  ok  ${name}`))
       : (fail++, console.error(`FAIL  ${name}  ${detail}`));

// ---- parser stub: robust against any input ----
let threw = false;
try {
  parseEnforcerReading(null);
  parseEnforcerReading(new Uint8Array(0));
  parseEnforcerReading(Uint8Array.from([0, 255, 13, 10, 65, 66, 67]));
} catch (e) { threw = true; }
check('parseEnforcerReading never throws', !threw);
check('parseEnforcerReading returns null for now', parseEnforcerReading(Uint8Array.from([1, 2, 3])) === null);

// ---- reading factory: standard shape ----
const r = enforcerReading(12.34, { battery: 80 });
check('value passes through', r.value === 12.34);
check('unit is kN', r.unit === 'kN' && r.unitCode === 'N');
check('battery passes through', r.battery === 80);
check('absolute measure mode', r.measureMode === 'N' && r.refZero === 0);
check('not overloaded by default', r.overloaded === false && r.workingMode === 'R');
check('overloaded flag works', enforcerReading(25, { overloaded: true }).workingMode === 'O');
check('battery defaults to null', enforcerReading(1).battery === null);
// Fields required by handleReading / appendChannel exist.
for (const k of ['workingMode', 'overloaded', 'value', 'measureMode', 'refZero', 'battery', 'unit', 'unitCode', 'speedHz', 'checksumOk']) {
  check(`has field ${k}`, k in r);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
