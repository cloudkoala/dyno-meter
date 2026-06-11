// Run: node test/store.test.mjs
// Verifies the recording accumulation + CSV logic (the parts independent of
// IndexedDB persistence, which is a thin standard CRUD wrapper).
import { Store, recordingToCSV } from '../js/store.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') =>
  cond ? (pass++, console.log(`  ok  ${name}`))
       : (fail++, console.error(`FAIL  ${name}  ${detail}`));

const store = new Store();
store.startRecording({ testId: 'Pull', sample: '01', name: 'Pull-01' }, 'kN');
check('starts recording', store.recording === true);
check('names from meta', store.current.name === 'Pull-01', store.current.name);
check('default-named when blank', store.startRecording({}, 'kN').name.startsWith('Session'));

// Re-start clean for the accumulation test, with full metadata.
store.startRecording({ testId: 'Pull', sample: '01', config: 'lap joint', material: 'Al', name: 'Pull-01' }, 'kN');
const samples = [1.0, 3.5, 2.2, 5.1, 0.4];
for (const v of samples) store.append({ value: v, unit: 'kN' }, v - 0.1 /* abs */);

check('one channel for single-device start', store.current.channels.length === 1);
check('counts samples', store.current.samples.length === 5);
check('channel samples == primary alias', store.current.channels[0].samples.length === 5);
check('tracks max', store.current.max === 5.1, `got ${store.current.max}`);
check('tracks channel max', store.current.channels[0].max === 5.1, `got ${store.current.channels[0].max}`);
check('tracks min', store.current.min === 0, `got ${store.current.min}`); // starts at 0
check('sample shape', store.current.samples[0].value === 1.0 && 'abs' in store.current.samples[0]);

const csv = recordingToCSV(store.current);
const lines = csv.split('\n');
const headerIdx = lines.findIndex((l) => l.startsWith('time_s'));
const dataRows = lines.slice(headerIdx + 1).filter(Boolean);

// Single channel MUST keep the original WIDE format byte-for-byte.
check('CSV column header present (wide)', lines[headerIdx] === 'time_s,value_kN,absolute_kN', lines[headerIdx]);
check('CSV has all data rows', dataRows.length === samples.length, `got ${dataRows.length}`);
check('CSV first data row value', dataRows[0].split(',')[1] === '1', dataRows[0]);
check('CSV carries absolute col', dataRows[0].split(',')[2] === '0.9', dataRows[0]);
check('CSV unit + max metadata', csv.includes('# unit: kN') && csv.includes('max: 5.1'));
check('CSV new metadata fields', csv.includes('# test id: Pull') && csv.includes('# configuration: lap joint') && csv.includes('# material: Al'));
check('single-channel CSV has NO channels header', !csv.includes('# channels:'));

// ---- multi-channel start / append --------------------------------------
const m = store.startRecording(
  { testId: 'Pull', sample: '02', name: 'Pull-02' },
  [{ label: 'Left', unit: 'kN' }, { label: 'Right', unit: 'kN' }],
);
check('two channels created', m.channels.length === 2, `${m.channels.length}`);
check('channel labels kept', m.channels[0].label === 'Left' && m.channels[1].label === 'Right');
store.appendChannel(0, { value: 1.0, unit: 'kN' }, 0.9);
store.appendChannel(1, { value: 2.0, unit: 'kN' }, 1.9);
store.appendChannel(0, { value: 4.0, unit: 'kN' }, 3.9);
store.appendChannel(1, { value: 7.0, unit: 'kN' }, 6.9);
check('per-channel samples', m.channels[0].samples.length === 2 && m.channels[1].samples.length === 2);
check('per-channel max', m.channels[0].max === 4.0 && m.channels[1].max === 7.0);
check('derived peak across channels', m.max === 7.0, `${m.max}`);

const longCsv = recordingToCSV(m);
const llines = longCsv.split('\n');
const lhdr = llines.findIndex((l) => l.startsWith('time_s'));
check('multi-channel uses LONG header', llines[lhdr] === 'time_s,channel,value,absolute', llines[lhdr]);
check('multi-channel has channels header', longCsv.includes('# channels: Left; Right'));
check('long peak across channels', longCsv.includes('max: 7'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
