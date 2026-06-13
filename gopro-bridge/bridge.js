// GoPro live-feed bridge.
//
// A browser can't read the GoPro's wireless preview (a UDP MPEG-TS stream) directly.
// This:
//   1. (optionally) tells the GoPro to start streaming over its HTTP API + keeps it alive,
//   2. runs ffmpeg to read the UDP MPEG-TS and transcode it to fragmented MP4 (fMP4),
//   3. serves that fMP4 to the web app over a WebSocket — the app plays it live (MSE) and
//      records it by buffering the same bytes.
//
// Usable two ways:
//   • Standalone CLI (`node bridge.js`) for the plain web app — config via env vars
//     (WS_PORT, UDP_PORT, GOPRO, GOPRO_IP, KEYFRAME_S). Set GOPRO=0 + feed your own UDP
//     MPEG-TS (e.g. an ffmpeg test pattern) for development. See README.md.
//   • Embedded in the Electron app via `import { startBridge }` (ffmpeg path injected,
//     lifecycle managed by the main process). startBridge() never exits the process.

import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import os from 'node:os';

// When a GoPro is plugged in over USB it appears as a USB-ethernet interface on
// the GoPro subnet 172.2X.1YZ.0/24 (X,Y,Z from the camera serial); the camera
// itself is host .51. Given this machine's IPv4 addresses, derive the camera's
// USB IP (or null). Pure + exported for tests. Avoids needing the serial number.
export function usbGoProIp(addresses) {
  for (const addr of addresses || []) {
    if (/^172\.2\d\.1\d\d\.\d+$/.test(addr)) return addr.replace(/\.\d+$/, '.51');
  }
  return null;
}
function findUsbGoProIp() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return usbGoProIp(out);
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

// Build the MSE codec string from the init segment (e.g. avc1.42E01F[, mp4a.40.2]).
function codecFromInit(init) {
  const i = init.indexOf('avcC', 0, 'latin1');
  let video = 'avc1.42E01E';
  if (i >= 0) {
    const p = i + 4; // avcC payload: [version][profile][compat][level]...
    const hex = (b) => b.toString(16).padStart(2, '0');
    video = `avc1.${hex(init[p + 1])}${hex(init[p + 2])}${hex(init[p + 3])}`.toUpperCase().replace('AVC1', 'avc1');
  }
  const hasAudio = init.indexOf('mp4a', 0, 'latin1') >= 0; // advertise AAC-LC if present
  return hasAudio ? `${video}, mp4a.40.2` : video;
}

/**
 * Start the bridge. Returns { stop() } to tear it down (used by the Electron main process).
 * Options default to env vars so the standalone CLI behaves as before.
 */
export function startBridge(opts = {}) {
  const wsPort = Number(opts.wsPort ?? process.env.WS_PORT ?? 8088);
  const udpPort = Number(opts.udpPort ?? process.env.UDP_PORT ?? 8554);
  const gopro = opts.gopro ?? (process.env.GOPRO !== '0');
  const goproIp = opts.goproIp ?? process.env.GOPRO_IP ?? '10.5.5.9';
  // Keyframe = fragment interval (s) — the main lever on live latency. Lower = lower
  // latency + more CPU/bitrate; 0.033 ≈ every frame (all-intra). 0.066 ≈ every ~2
  // frames at 30fps — a balance between low lag and CPU/smoothness.
  const keyframeS = Math.max(0.02, Number(opts.keyframeS ?? process.env.KEYFRAME_S ?? 0.066));
  const ffmpegPath = opts.ffmpegPath || 'ffmpeg';
  const log = (...a) => console.log('[bridge]', ...a);

  let stopped = false;
  let ff = null;
  let ffRestartTimer = null;
  let keepAlive = null;
  let initSeg = null;
  let codec = 'avc1.42E01E';
  let streamSeen = false;       // have we ever produced an init segment (real video flowing)?
  let noStreamTimer = null;
  let lastStatus = null;        // latest diagnostic, replayed to each new client
  let lastFrameAt = 0;          // ms timestamp of the last media fragment (stream liveness)
  let lastReviveAt = 0;         // rate-limits recovery attempts while video is down
  let lastStartAt = 0;          // when ffmpeg last (re)started — used as a warm-up grace
  let liveness = null;          // periodic "is video still flowing?" watchdog

  // Video is considered flowing if a fragment arrived in the last few seconds.
  const flowing = () => Date.now() - lastFrameAt < 3000;

  // Push a diagnostic to every connected client, and remember it so a client
  // that connects later still learns the current state (set before any client
  // connects). The app surfaces these so a blank feed isn't a silent mystery.
  function setStatus(level, message) {
    if (lastStatus && lastStatus.level === level && lastStatus.message === message) return; // unchanged — don't re-toast
    lastStatus = { type: 'status', level, message };
    const s = JSON.stringify(lastStatus);
    for (const ws of wss.clients) if (ws.readyState === 1) ws.send(s);
  }

  // If no video has arrived a few seconds after asking the GoPro to stream, tell
  // the user (covers an unreachable camera or one that's on but not streaming).
  function armNoStreamWatchdog() {
    clearTimeout(noStreamTimer);
    noStreamTimer = setTimeout(() => {
      if (!streamSeen && lastStatus?.level !== 'error') {
        setStatus('warn', `No video from the GoPro yet — make sure it's connected (USB or Wi-Fi) and streaming.`);
      }
    }, 8000);
  }

  // GoPro control (best-effort; failures are non-fatal so dev/test still works).
  // Safe to call again (e.g. when a viewer connects) — it clears any prior keep-alive.
  // Tries a USB-tethered camera first (if one's plugged in), then the Wi-Fi AP, then
  // the legacy gpControl API. Whichever responds becomes the keep-alive target.
  // Open GoPro (Hero 9+) serves HTTP on :8080; legacy (Hero 4–8) on :80. fetch()
  // only rejects on network errors, NOT on a 404/500 — so check r.ok explicitly,
  // else a wrong-endpoint 404 looks like success and we'd silently never stream.
  async function goproStart() {
    if (!gopro) { log('GoPro control disabled — expecting an external UDP source'); return; }
    clearInterval(keepAlive);
    const ensureOk = (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r; };
    const get = (url) => fetch(url, { signal: AbortSignal.timeout(4000) }).then(ensureOk);

    const usbIp = findUsbGoProIp();
    // Priority order: USB (most reliable) → Wi-Fi AP → legacy gpControl.
    const candidates = [];
    if (usbIp) candidates.push({ base: `http://${usbIp}:8080`, wired: true, label: `USB ${usbIp}` });
    candidates.push({ base: `http://${goproIp}:8080`, wired: false, label: `Wi-Fi ${goproIp}` });

    let chosen = null;
    for (const c of candidates) {
      try {
        if (c.wired) await get(`${c.base}/gopro/camera/control/wired_usb?p=1`); // enable wired control
        await get(`${c.base}/gopro/camera/stream/start`);
        chosen = c; break;
      } catch (e) { log(`GoPro ${c.label} not available (${e.message})`); }
    }
    if (!chosen) {
      try {
        await get(`http://${goproIp}/gp/gpControl/execute?p1=gpStream&a1=proto_v2&c1=restart`);
        chosen = { base: `http://${goproIp}`, label: 'legacy gpControl' };
      } catch { /* fall through to error */ }
    }

    if (chosen) {
      log(`GoPro stream start via ${chosen.label}`);
      if (!streamSeen) setStatus('ok', `GoPro stream requested (${chosen.label}) — waiting for video…`);
      // Keep-alive: the preview stops after a few seconds without periodic pings.
      keepAlive = setInterval(() => {
        fetch(`${chosen.base}/gopro/camera/keep_alive`, { signal: AbortSignal.timeout(2000) }).catch(() => {});
      }, 2500);
    } else {
      const msg = `Can't reach the GoPro — plug it in via USB, or join its Wi-Fi and enable wireless, then re-add the camera.`;
      log(`⚠ ${msg}`);
      setStatus('error', msg);
    }
    armNoStreamWatchdog();
  }

  // ffmpeg: UDP MPEG-TS -> fMP4 on stdout.
  function startFfmpeg(onData, onExit) {
    const gop = Math.max(1, Math.round(keyframeS * 30)); // GOP in frames (assume ~30fps)
    const args = [
      '-hide_banner', '-loglevel', 'warning',
      // discardcorrupt: drop the corrupt/out-of-order packets that show up right
      // after a Wi-Fi gap instead of wedging the demuxer.
      '-fflags', '+nobuffer+discardcorrupt', '-flags', 'low_delay',
      '-i', `udp://@:${udpPort}?overrun_nonfatal=1&fifo_size=50000000`,
      // Map only the first video + (optional) audio — GoPro TS also carries a
      // telemetry/data stream that ffmpeg otherwise trips over on each restart.
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
      '-profile:v', 'baseline', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', // include audio if the source has it
      '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
      '-force_key_frames', `expr:gte(t,n_forced*${keyframeS})`,
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset',
      '-flush_packets', '1',
      '-f', 'mp4', 'pipe:1',
    ];
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', onData);
    proc.stderr.on('data', (d) => process.stderr.write(d));
    proc.on('exit', (code) => { if (!stopped) log(`ffmpeg exited (${code})`); onExit(code); });
    proc.on('error', (e) => { log(`ffmpeg failed to start: ${e.message}. Is ffmpeg installed?`); onExit(1); });
    return proc;
  }

  // Stop the current ffmpeg without triggering its auto-restart-on-exit (used when
  // we intentionally restart it ourselves).
  function killFfmpeg() {
    const p = ff; ff = null;
    if (!p) return;
    p.removeAllListeners('exit');
    try { p.kill('SIGKILL'); } catch { /* ignore */ }
  }

  function startPipeline() {
    if (stopped) return;
    clearTimeout(ffRestartTimer);
    killFfmpeg();
    lastStartAt = Date.now();
    initSeg = null;
    const split = makeBoxSplitter(onInit, onFragment);
    ff = startFfmpeg(split, () => {
      ff = null;
      if (!stopped) { log('ffmpeg exited; restarting in 2s…'); ffRestartTimer = setTimeout(startPipeline, 2000); }
    });
  }

  // Recover a dead/stalled feed: restart ffmpeg fresh (so it re-reads UDP without
  // the post-gap corrupt timestamps) and re-ask the GoPro to stream. Rate-limited
  // so a down camera doesn't get hammered. Called on (re)connect and by the
  // liveness watchdog — this is what makes the feed come back after a Wi-Fi change
  // without restarting the whole app.
  function reviveStream(reason) {
    if (stopped || Date.now() - lastReviveAt < 4000) return;
    // ffmpeg can take several seconds to emit its first frame (it waits for an
    // input keyframe). Don't kill a still-warming encoder, or it never produces.
    if (Date.now() - lastStartAt < 10000) return;
    lastReviveAt = Date.now();
    log(`reviving stream (${reason})`);
    startPipeline();
    if (gopro) goproStart();
  }

  // Stand down when no one is watching: stop ffmpeg + GoPro keep-alive and clear
  // state so we don't ping the camera (or surface "can't reach GoPro") until a
  // viewer actually asks for the feed again.
  function goDormant() {
    clearInterval(keepAlive); keepAlive = null;
    clearTimeout(noStreamTimer);
    clearTimeout(ffRestartTimer);
    killFfmpeg();
    initSeg = null;
    streamSeen = false;
    lastFrameAt = 0;
    lastStartAt = 0;
    lastReviveAt = 0;
    lastStatus = null;
    log('no viewers — bridge idle');
  }

  // WebSocket server.
  const tagged = (tag, payload) => Buffer.concat([Buffer.from([tag]), payload]); // 0=init, 1=fragment
  const wss = new WebSocketServer({ port: wsPort });
  wss.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      log(`⚠ port ${wsPort} is already in use — another bridge is probably already running.`);
      log('  Close the other one (or set WS_PORT to a different port), then retry.');
    } else {
      log('WebSocket server error: ' + e.message);
    }
    opts.onFatal?.(e);
  });
  wss.on('connection', (ws) => {
    log(`client connected (${wss.clients.size} total)`);
    ws.send(JSON.stringify({ type: 'hello', codec }));
    if (lastStatus) ws.send(JSON.stringify(lastStatus));
    // If video is currently flowing, hand the viewer the live init segment to join.
    // Otherwise the feed is stale/dead (first launch, or a Wi-Fi change while the
    // app stayed open) — revive it rather than sending a frozen init segment.
    if (flowing() && initSeg) ws.send(tagged(0, initSeg));
    else reviveStream('viewer connected, no live video'); // starts the pipeline (+ GoPro if enabled)
    ws.on('close', () => {
      log(`client disconnected (${wss.clients.size} total)`);
      if (![...wss.clients].some((c) => c.readyState === 1)) goDormant(); // last viewer left
    });
    ws.on('error', () => {});
  });

  const onInit = (init) => {
    initSeg = init;
    codec = codecFromInit(init);
    streamSeen = true;
    clearTimeout(noStreamTimer);
    if (lastStatus?.level !== 'live') setStatus('live', 'Live video streaming.');
    log(`init segment ready (${init.length} B), codec ${codec}`);
    for (const ws of wss.clients) {
      if (ws.readyState !== 1) continue;
      ws.send(JSON.stringify({ type: 'hello', codec }));
      ws.send(tagged(0, init));
    }
  };
  const onFragment = (frag) => {
    lastFrameAt = Date.now();
    for (const ws of wss.clients) if (ws.readyState === 1) ws.send(tagged(1, frag));
  };

  // Liveness watchdog: while a viewer is connected but no video is flowing, keep
  // (re)starting the stream. When the GoPro Wi-Fi comes back, the next attempt
  // succeeds and the feed resumes on its own — no app restart needed.
  liveness = setInterval(() => {
    if (stopped || !gopro || wss.clients.size === 0 || flowing()) return;
    reviveStream('no live video while a viewer is waiting');
  }, 2000);

  log(`WebSocket server: ws://localhost:${wsPort}`);
  log(`reading UDP MPEG-TS on udp://@:${udpPort}`);
  // Stay idle until a viewer connects — don't poke the GoPro at launch (the
  // embedded bridge starts with the app, before anyone has asked for the feed).
  log('idle — the stream starts when a viewer connects');

  return {
    stop() {
      stopped = true;
      clearInterval(keepAlive);
      clearInterval(liveness);
      clearTimeout(noStreamTimer);
      clearTimeout(ffRestartTimer);
      killFfmpeg();
      try { wss.close(); } catch { /* ignore */ }
    },
  };
}

// ---- run as a standalone CLI when invoked directly (node bridge.js) --------------------
const invokedDirectly = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();
if (invokedDirectly) startBridge({ onFatal: () => process.exit(1) });
