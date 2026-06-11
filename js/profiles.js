// Device profiles. A profile describes everything BLEConnection needs to talk
// to one kind of device, so a single generic backend serves many devices.
//
// Profile shape:
//   {
//     deviceType, deviceLabel, defaultUnit, canSetUnit,
//     services:   [uuid...],     // requestDevice filter + getPrimaryService
//     notifyUuid, writeUuid,     // preferred characteristics (capability fallback still applies)
//     cmd:        { name: Uint8Array },  // named command frames
//     parse:      (Uint8Array) => reading|null,
//     endFlag, packetLen,        // frame splitter; null/undefined => one notification = one frame
//     startStream:(conn, tries) => Promise,  // commands to begin streaming (optional)
//     ignoreUnknownCmd: bool,    // send() silently ignores unmapped commands
//     acceptAllDevices: bool,    // requestDevice scans all devices (unknown service UUID)
//   }

import { UUID, CMD, PACKET_LEN, END_FLAG, parsePacket } from './protocol.js';
import { parseEnforcerReading } from './enforcer.js';

// LineScale 3 — the original device. This makes the existing behaviour the
// "default profile" with no functional change.
export const LS3_PROFILE = {
  deviceType: 'ls3',
  deviceLabel: 'LineScale 3',
  defaultUnit: 'kN',
  canSetUnit: true,
  services: [UUID.service],
  notifyUuid: UUID.notify,
  writeUuid: UUID.write,
  cmd: CMD,
  parse: parsePacket,
  endFlag: END_FLAG,
  packetLen: PACKET_LEN,
  ignoreUnknownCmd: false,
  acceptAllDevices: false,
  async startStream(conn, tries) {
    conn._log(`sending start (A) + 40Hz (F)  [try ${tries}]`);
    await conn.send('ONLINE');
    await new Promise((r) => setTimeout(r, 120));
    await conn.send('SPEED_40HZ');
  },
};

// Rock Exotica Enforcer — SCAFFOLD. Service UUID, commands, and frame format are
// unknown until captured via Discovery mode (see js/enforcer.js). Connecting via
// this profile will pair but won't stream until those TODOs are filled.
export const ENFORCER_PROFILE = {
  deviceType: 'enforcer',
  deviceLabel: 'Rock Exotica Enforcer',
  defaultUnit: 'kN',
  canSetUnit: false,              // Enforcer is kN-only (likely)
  services: [],                   // TODO(capture): real service UUID
  notifyUuid: null,
  writeUuid: null,
  cmd: {},                        // TODO(capture): command frames
  parse: parseEnforcerReading,
  endFlag: null,                  // passthrough until framing is known
  packetLen: null,
  ignoreUnknownCmd: true,         // rate/zero-mode/unit broadcasts become no-ops
  acceptAllDevices: true,
  startStream: null,              // TODO(capture): may need the iOS app's init sequence
};
