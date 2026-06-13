// Run: node test/wifi.test.mjs
// Verifies the pure Wi-Fi-join helpers (macOS interface parsing, Windows profile
// XML + escaping). The actual networksetup/netsh calls need a real OS + adapter.
import wifi from '../electron/wifi.js';
const { parseWifiInterfaceMac, windowsWifiProfileXml, xmlEscape, joinWifi } = wifi;

let pass = 0, fail = 0;
const check = (name, cond, detail = '') =>
  cond ? (pass++, console.log(`  ok  ${name}`))
       : (fail++, console.error(`FAIL  ${name}  ${detail}`));

const macOut = `Hardware Port: Ethernet
Device: en1
Ethernet Address: a1:b2:c3:d4:e5:f6

Hardware Port: Wi-Fi
Device: en0
Ethernet Address: 11:22:33:44:55:66

Hardware Port: Bluetooth PAN
Device: en5
Ethernet Address: 00:00:00:00:00:00`;

check('finds the Wi-Fi device name', parseWifiInterfaceMac(macOut) === 'en0', parseWifiInterfaceMac(macOut));
check('handles legacy "AirPort" label', parseWifiInterfaceMac('Hardware Port: AirPort\nDevice: en2\n') === 'en2');
check('returns null when no Wi-Fi port', parseWifiInterfaceMac('Hardware Port: Ethernet\nDevice: en1\n') === null);
check('null/garbage input -> null', parseWifiInterfaceMac('') === null && parseWifiInterfaceMac(undefined) === null);

const xml = windowsWifiProfileXml('GP24512345', 'secretpass');
check('profile includes the SSID', xml.includes('<name>GP24512345</name>'));
check('profile includes the passphrase', xml.includes('<keyMaterial>secretpass</keyMaterial>'));
check('profile is WPA2PSK/AES', xml.includes('WPA2PSK') && xml.includes('AES'));

check('xmlEscape escapes special chars', xmlEscape(`a&b<c>"d'`) === 'a&amp;b&lt;c&gt;&quot;d&apos;');
const xml2 = windowsWifiProfileXml('My&Net', 'p<a>ss&"');
check('SSID with & is escaped in XML', xml2.includes('<name>My&amp;Net</name>'));
check('password with special chars is escaped', xml2.includes('<keyMaterial>p&lt;a&gt;ss&amp;&quot;</keyMaterial>'));

// joinWifi retries until the network appears (the GoPro AP boots slowly).
const ssidCreds = { ssid: 'GP24512345', password: 'pw' };
{
  let calls = 0;
  const _join = async () => { calls++; return calls >= 3 ? { ok: true, message: 'joined' } : { ok: false, message: 'could not find network' }; };
  const res = await joinWifi(ssidCreds, { attempts: 5, gapMs: 0, _join });
  check('retries until the AP appears, then succeeds', res.ok && calls === 3, `ok=${res.ok} calls=${calls}`);
}
{
  let calls = 0;
  const _join = async () => { calls++; return { ok: false, message: 'could not find network' }; };
  const res = await joinWifi(ssidCreds, { attempts: 4, gapMs: 0, _join });
  check('gives up after N attempts with the last error', !res.ok && calls === 4, `ok=${res.ok} calls=${calls}`);
}
{
  const _join = async () => { throw new Error('networksetup blew up'); };
  const res = await joinWifi(ssidCreds, { attempts: 2, gapMs: 0, _join });
  check('a throwing join is caught, not propagated', !res.ok && /blew up/.test(res.message));
}
check('missing SSID -> not ok, no attempt', (await joinWifi({}, { _join: async () => ({ ok: true }) })).ok === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
