// GoPro live-feed bridge.
//
// A browser can't read the GoPro's wireless preview (a UDP MPEG-TS stream) directly.
// This helper:
//   1. (optionally) tells the GoPro to start streaming over its HTTP API + keeps it alive,
//   2. runs ffmpeg to read the UDP MPEG-TS and transcode it to fragmented MP4 (fMP4),
//   3. serves that fMP4 to the web app over a WebSocket — the app plays it live (MSE) and
//      records it by buffering the same bytes.
//
// No GoPro? Set GOPRO=0 and feed your own UDP MPEG-TS (e.g. an ffmpeg test pattern) to
// UDP_PORT — handy for development. See README.md.
//
// Config (env vars): WS_PORT=8088  UDP_PORT=8554  GOPRO=1  GOPRO_IP=10.5.5.9

import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';

const WS_PORT = Number(process.env.WS_PORT || 8088);
const UDP_PORT = Number(process.env.UDP_PORT || 8554);
const GOPRO = process.env.GOPRO !== '0';
const GOPRO_IP = process.env.GOPRO_IP || '10.5.5.9';

const log = (...a) => console.log('[bridge]', ...a);

// ---- GoPro control (best-effort; failures are non-fatal so dev/test still works) -------
async function goproStart() {
  if (!GOPRO) { log('GoPro control disabled (GOPRO=0) — expecting an external UDP source'); return; }
  const base = `http://${GOPRO_IP}`;
  try {
    // Open GoPro: start the wired/wireless preview stream.
    const r = await fetch(`${base}/gopro/camera/stream/start`, { signal: AbortSignal.timeout(4000) });
    log(`GoPro stream/start -> ${r.status}`);
  } catch (e) {
    // Fall back to the legacy endpoint used by older models.
    try {
      await fetch(`${base}/gp/gpControl/execute?p1=gpStream&a1=proto_v2&c1=restart`, { signal: AbortSignal.timeout(4000) });
      log('GoPro legacy gpStream restart sent');
    } catch (e2) {
      log(`⚠ could not reach the GoPro at ${GOPRO_IP} (${e2.message || e.message}). ` +
          'Join the GoPro Wi-Fi and enable wireless, or run with GOPRO=0 for a test source.');
    }
  }
  // Keep-alive: the preview stops after a few seconds without periodic pings.
  setInterval(() => {
    fetch(`${base}/gopro/camera/keep_alive`, { signal: AbortSignal.timeout(2000) }).catch(() => {});
  }, 2500);
}

// ---- fMP4 box splitter: separates the init segment (ftyp+moov) from media fragments -----
// (moof+mdat). Each fragment begins on a keyframe (ffmpeg frag_keyframe) so the app can
// start recording at any fragment boundary and produce a valid file.
function makeBoxSplitter(onInit, onFragment) {
  let buf = Buffer.alloc(0);
  let initDone = false;
  let initParts = [];
  let fragParts = [];

  function handleBox(type, box) {
    if (!initDone) {
      if (type === 'moof') { initDone = true; onInit(Buffer.concat(initParts)); initParts = null; fragParts = [box]; }
      else initParts.push(box); // ftyp, moov, (styp/sidx)
    } else if (type === 'moof') {
      if (fragParts.length) onFragment(Buffer.concat(fragParts));
      fragParts = [box];
    } else {
      fragParts.push(box);
      if (type === 'mdat') { onFragment(Buffer.concat(fragParts)); fragParts = []; } // moof+mdat complete
    }
  }

  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 8) {
      let size = buf.readUInt32BE(0);
      const type = buf.toString('latin1', 4, 8);
      if (size === 1) { // 64-bit largesize
        if (buf.length < 16) break;
        size = buf.readUInt32BE(8) * 2 ** 32 + buf.readUInt32BE(12);
      } else if (size === 0) {
        break; // box to end-of-stream — not expected in fMP4; wait for more
      }
      if (size < 8 || buf.length < size) break;
      handleBox(type, buf.subarray(0, size));
      buf = buf.subarray(size);
    }
  };
}

// Build the MSE codec string from the avcC box in the init segment (e.g. avc1.42E01F),
// so the browser's SourceBuffer is created with the exact profile/level ffmpeg produced.
function codecFromInit(init) {
  const i = init.indexOf('avcC', 0, 'latin1');
  let video = 'avc1.42E01E';
  if (i >= 0) {
    const p = i + 4; // avcC payload: [version][profile][compat][level]...
    const hex = (b) => b.toString(16).padStart(2, '0');
    video = `avc1.${hex(init[p + 1])}${hex(init[p + 2])}${hex(init[p + 3])}`.toUpperCase().replace('AVC1', 'avc1');
  }
  // If the init segment carries an audio track (mp4a), advertise AAC-LC too.
  const hasAudio = init.indexOf('mp4a', 0, 'latin1') >= 0;
  return hasAudio ? `${video}, mp4a.40.2` : video;
}

// ---- ffmpeg: UDP MPEG-TS -> fMP4 on stdout ---------------------------------------------
function startFfmpeg(onData, onExit) {
  const args = [
    '-hide_banner', '-loglevel', 'warning',
    '-fflags', 'nobuffer', '-flags', 'low_delay',
    '-i', `udp://@:${UDP_PORT}?overrun_nonfatal=1&fifo_size=50000000`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-profile:v', 'baseline', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', // include audio if the source has it
    '-g', '30', '-force_key_frames', 'expr:gte(t,n_forced*1)', // keyframe ~every 1s
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset',
    '-flush_packets', '1', // emit each fragment to the pipe immediately (low latency)
    '-f', 'mp4', 'pipe:1',
  ];
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  ff.stdout.on('data', onData);
  ff.stderr.on('data', (d) => process.stderr.write(d)); // surface ffmpeg warnings/errors
  ff.on('exit', (code) => { log(`ffmpeg exited (${code})`); onExit(code); });
  ff.on('error', (e) => { log(`ffmpeg failed to start: ${e.message}. Is ffmpeg installed?`); onExit(1); });
  return ff;
}

// ---- WebSocket server ------------------------------------------------------------------
const wss = new WebSocketServer({ port: WS_PORT });
let initSeg = null;
let codec = 'avc1.42E01E';

const tagged = (tag, payload) => Buffer.concat([Buffer.from([tag]), payload]); // 0=init, 1=fragment

wss.on('connection', (ws) => {
  log(`client connected (${wss.clients.size} total)`);
  ws.send(JSON.stringify({ type: 'hello', codec }));
  if (initSeg) ws.send(tagged(0, initSeg));
  ws.on('close', () => log(`client disconnected (${wss.clients.size} total)`));
  ws.on('error', () => {});
});

function broadcast(buf) {
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(buf);
}

const onInit = (init) => {
  initSeg = init;
  codec = codecFromInit(init);
  log(`init segment ready (${init.length} B), codec ${codec}`);
  for (const ws of wss.clients) {
    if (ws.readyState !== 1) continue;
    ws.send(JSON.stringify({ type: 'hello', codec }));
    ws.send(tagged(0, init));
  }
};
const onFragment = (frag) => broadcast(tagged(1, frag));

// ---- wire it together ------------------------------------------------------------------
function startPipeline() {
  const split = makeBoxSplitter(onInit, onFragment);
  initSeg = null;
  startFfmpeg(split, (code) => {
    if (code !== 0) { log('restarting ffmpeg in 2s…'); setTimeout(startPipeline, 2000); }
  });
}

log(`WebSocket server: ws://localhost:${WS_PORT}`);
log(`reading UDP MPEG-TS on udp://@:${UDP_PORT}`);
await goproStart();
startPipeline();
