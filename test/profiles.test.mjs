// Run: node test/profiles.test.mjs
// Guards the device-profile refactor: LS3_PROFILE must parse exactly like the
// raw parsePacket it wraps, and carry the expected LS3 identity/framing.
import { LS3_PROFILE, ENFORCER_PROFILE } from '../js/profiles.js';
import { parsePacket, UUID, CMD, PACKET_LEN, END_FLAG } from '../js/protocol.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') =>
  cond ? (pass++, console.log(`  ok  ${name}`))
       : (fail++, console.error(`FAIL  ${name}  ${detail}`));

// Same spec example packet as protocol.test.mjs.
const example = Uint8Array.from([
  0x52, 0x30, 0x30, 0x30, 0x2e, 0x36, 0x33, 0x5a, 0x2d, 0x33,
  0x32, 0x2e, 0x38, 0x34, 0x52, 0x4e, 0x53, 0x31, 0x30, 0x0d,
]);

// ---- LS3 profile: parse equivalence (the regression guardrail) ----
const viaProfile = LS3_PROFILE.parse(example);
const viaRaw = parsePacket(example);
check('LS3_PROFILE.parse === parsePacket', JSON.stringify(viaProfile) === JSON.stringify(viaRaw));
check('LS3 parsed value 0.63', Math.abs(viaProfile.value - 0.63) < 1e-9, `${viaProfile.value}`);

// ---- LS3 profile: identity + framing ----
check('LS3 deviceType', LS3_PROFILE.deviceType === 'ls3');
check('LS3 deviceLabel', LS3_PROFILE.deviceLabel === 'LineScale 3');
check('LS3 canSetUnit', LS3_PROFILE.canSetUnit === true);
check('LS3 service uuid', LS3_PROFILE.services[0] === UUID.service);
check('LS3 cmd map is CMD', LS3_PROFILE.cmd === CMD && !!LS3_PROFILE.cmd.ONLINE);
check('LS3 framing', LS3_PROFILE.endFlag === END_FLAG && LS3_PROFILE.packetLen === PACKET_LEN);
check('LS3 has startStream', typeof LS3_PROFILE.startStream === 'function');
check('LS3 not acceptAllDevices', !LS3_PROFILE.acceptAllDevices);

// ---- Enforcer profile: scaffold expectations ----
check('Enforcer deviceLabel', ENFORCER_PROFILE.deviceLabel === 'Rock Exotica Enforcer');
check('Enforcer is kN-only', ENFORCER_PROFILE.canSetUnit === false);
check('Enforcer ignores unknown cmds', ENFORCER_PROFILE.ignoreUnknownCmd === true);
check('Enforcer scans all devices', ENFORCER_PROFILE.acceptAllDevices === true);
check('Enforcer passthrough framing', ENFORCER_PROFILE.endFlag == null);
check('Enforcer parse callable', typeof ENFORCER_PROFILE.parse === 'function');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
