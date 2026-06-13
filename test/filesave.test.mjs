// Run: node test/filesave.test.mjs
// Verifies parseSessionCsv reproduces a recording written by recordingToCSV
// (the round-trip that the folder-as-library feature relies on).
import { recordingToCSV } from '../js/store.js';
import { parseSessionCsv } from '../js/filesave.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') =>
  cond ? (pass++, console.log(`  ok  ${name}`))
       : (fail++, console.error(`FAIL  ${name}  ${detail}`));

const rec = {
  name: 'Beam-03',
  testId: 'Beam',
  sample: '03',
  config: '2-bolt lap joint',
  material: ['6061-T6 aluminium', 'epoxy'],
  startedAt: Date.UTC(2026, 5, 10, 12, 30, 0),
  unit: 'kN',
  max: 5.1,
  samples: [
    { t: 0, value: 1.0, abs: 0.9 },
    { t: 250, value: 5.1, abs: 5.0 },
    { t: 500, value: 0.4, abs: 0.3 },
  ],
};

const csv = recordingToCSV(rec);
const back = parseSessionCsv(csv, 'Beam-03');

check('name round-trips', back.name === 'Beam-03', back.name);
check('testId round-trips', back.testId === 'Beam', back.testId);
check('sample round-trips', back.sample === '03', back.sample);
check('config round-trips', back.config === '2-bolt lap joint', back.config);
check('material round-trips as list', Array.isArray(back.material) && back.material.join('|') === '6061-T6 aluminium|epoxy', JSON.stringify(back.material));
check('unit round-trips', back.unit === 'kN', back.unit);
check('max round-trips', back.max === 5.1, `${back.max}`);
check('count round-trips', back.count === 3, `${back.count}`);
check('startedAt round-trips', back.startedAt === rec.startedAt, `${back.startedAt} vs ${rec.startedAt}`);
check('duration = last t', back.duration === 500, `${back.duration}`);
check('sample t in ms', back.samples[1].t === 250, `${back.samples[1].t}`);
check('sample value', back.samples[1].value === 5.1, `${back.samples[1].value}`);
check('sample abs', back.samples[1].abs === 5.0, `${back.samples[1].abs}`);
check('single-channel returns channels[] of length 1', Array.isArray(back.channels) && back.channels.length === 1, `${back.channels?.length}`);
check('single-channel CSV stays wide', /\btime_s,value_kN,absolute_kN\b/.test(csv));

// A single-device recording carries its device label through the wide CSV so
// the session view knows which device was used (regression: was dropped).
const labeled = {
  name: 'Solo-01', testId: 'Solo', sample: '01', config: '', material: [],
  startedAt: Date.UTC(2026, 5, 12, 8, 0, 0), unit: 'kN',
  channels: [{ label: 'LineScale 3 #1', unit: 'kN', max: 3.2, samples: [
    { t: 0, value: 0.5, abs: 0.4 }, { t: 250, value: 3.2, abs: 3.0 },
  ] }],
};
const lcsv = recordingToCSV(labeled);
const lback = parseSessionCsv(lcsv, 'Solo-01');
check('single-channel CSV stays wide (labeled)', /\btime_s,value_kN,absolute_kN\b/.test(lcsv), lcsv);
check('single-channel device label round-trips', lback.channels[0].label === 'LineScale 3 #1', lback.channels[0].label);
check('labelless single-channel stays empty', parseSessionCsv(csv, 'x').channels[0].label === '', `"${parseSessionCsv(csv, 'x').channels[0].label}"`);

// ---- multi-channel long-format round-trip ------------------------------
const multi = {
  name: 'Pull-07',
  testId: 'Pull',
  sample: '07',
  config: 'symmetric rig',
  material: ['Dyneema'],
  startedAt: Date.UTC(2026, 5, 11, 9, 0, 0),
  channels: [
    { label: 'Left', unit: 'kN', max: 4.0, samples: [
      { t: 0, value: 0.41, abs: 0.39 }, { t: 250, value: 4.0, abs: 3.8 }, { t: 500, value: 0.2, abs: 0.1 },
    ] },
    { label: 'Right', unit: 'kN', max: 7.0, samples: [
      { t: 0, value: 0.39, abs: 0.37 }, { t: 250, value: 7.0, abs: 6.8 }, { t: 500, value: 0.3, abs: 0.2 },
    ] },
  ],
};
const mcsv = recordingToCSV(multi);
const mlines = mcsv.split('\n');
const mhdr = mlines.find((l) => l.startsWith('time_s'));
check('multi CSV header is long', mhdr === 'time_s,channel,value,absolute', mhdr);
// Rows sorted by time ascending; ties keep channel order (Left before Right).
const mdata = mlines.slice(mlines.indexOf(mhdr) + 1).filter(Boolean);
check('rows sorted/grouped by time then channel', mdata[0] === '0.000,Left,0.41,0.39' && mdata[1] === '0.000,Right,0.39,0.37', `${mdata[0]} | ${mdata[1]}`);
check('time ascending across channels', mdata[2].startsWith('0.250,Left') && mdata[3].startsWith('0.250,Right'));

const mback = parseSessionCsv(mcsv, 'Pull-07');
check('multi: two channels parsed', mback.channels.length === 2, `${mback.channels.length}`);
check('multi: labels round-trip in order', mback.channels[0].label === 'Left' && mback.channels[1].label === 'Right');
check('multi: units round-trip', mback.channels[0].unit === 'kN' && mback.channels[1].unit === 'kN');
check('multi: per-channel maxes', mback.channels[0].max === 4.0 && mback.channels[1].max === 7.0, `${mback.channels[0].max}/${mback.channels[1].max}`);
check('multi: top-level peak across channels', mback.max === 7.0, `${mback.max}`);
check('multi: total count', mback.count === 6, `${mback.count}`);
check('multi: samples grouped correctly', mback.channels[0].samples.length === 3 && mback.channels[1].samples[1].value === 7.0);
check('multi: sample t in ms', mback.channels[0].samples[1].t === 250, `${mback.channels[0].samples[1].t}`);
check('multi: sample abs preserved', mback.channels[1].samples[1].abs === 6.8, `${mback.channels[1].samples[1].abs}`);
check('multi: metadata round-trips', mback.testId === 'Pull' && mback.sample === '07' && mback.config === 'symmetric rig');
check('multi: duration from data', mback.duration === 500, `${mback.duration}`);

// Missing max header -> recomputed from data.
const noMax = csv.replace(/^#.*max:.*$/m, '# samples: 3');
check('max recomputed when header absent', parseSessionCsv(noMax, 'x').max === 5.1);

// Name falls back to the file's base name when the header is absent.
const noName = csv.replace(/^# LineScale 3 recording:.*$/m, '# x');
check('name falls back to base', parseSessionCsv(noName, 'fallback-base').name === 'fallback-base');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
