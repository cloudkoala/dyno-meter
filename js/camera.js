// Camera live feed + recording, fed by the local GoPro bridge (gopro-bridge/).
//
// The bridge sends fragmented MP4 over a WebSocket: a JSON "hello" with the codec, then
// binary messages tagged 0x00 = init segment, 0x01 = media fragment. We play it live via
// Media Source Extensions, and record by buffering the init segment + the fragments that
// arrive between start and stop into a single .mp4 Blob (the app then saves it to the
// session folder). Knows nothing about force data or storage.

// ---- minimal MP4 box helpers (rebase tfdt so a mid-stream recording starts at 0) --------
// A fragment (moof+mdat) has one tfdt per track (video + audio), each in its own
// timescale. We zero each track independently by its first-seen value (matched by
// ordinal position, which ffmpeg keeps consistent across fragments) — that keeps the
// tracks in sync and avoids a long blank lead in the saved file.
function tfdtBoxes(frag) {
  const out = [];
  for (let j = 0; j + 7 < frag.length; j++) {
    if (frag[j] === 0x74 && frag[j + 1] === 0x66 && frag[j + 2] === 0x64 && frag[j + 3] === 0x74) {
      out.push({ pos: j, version: frag[j + 4] }); // [type][version(1)+flags(3)][baseMediaDecodeTime]
      j += 4;
    }
  }
  return out;
}
function tfdtValue(frag, t) {
  const dv = new DataView(frag.buffer, frag.byteOffset, frag.byteLength);
  return t.version === 1 ? dv.getUint32(t.pos + 8) * 2 ** 32 + dv.getUint32(t.pos + 12) : dv.getUint32(t.pos + 8);
}
function tfdtWrite(frag, t, v) {
  v = Math.max(0, v);
  const dv = new DataView(frag.buffer, frag.byteOffset, frag.byteLength);
  if (t.version === 1) { dv.setUint32(t.pos + 8, Math.floor(v / 2 ** 32)); dv.setUint32(t.pos + 12, v >>> 0); }
  else dv.setUint32(t.pos + 8, v >>> 0);
}

export class CameraFeed {
  constructor() {
    this.video = null;
    this.url = null;
    this.ws = null;
    this.codec = null;
    this.initSeg = null;
    this.ms = null;
    this.sb = null;
    this.queue = [];          // fragments pending append to the SourceBuffer
    this.recording = false;
    this.recParts = null;     // [init, ...fragments] while recording
    this._recOffsets = null;  // per-track first tfdt values (rebased to 0)
    this._wantOpen = false;
    this._retry = null;
    this._statusCbs = [];
  }

  attach(videoEl) { this.video = videoEl; }
  onStatus(cb) { this._statusCbs.push(cb); return this; }
  _status(s) { for (const cb of this._statusCbs) cb(s); }

  isConnected() { return !!this.ws && this.ws.readyState === 1; }
  isLive() { return !!this.sb; }

  // ---- connection -----------------------------------------------------------
  connect(url) {
    this.url = url || this.url;
    this._wantOpen = true;
    this._open();
  }

  _open() {
    // Live feed: no controls — the scrub/seek bar is meaningless (and glitchy) on a
    // live stream. Saved-session playback re-enables controls in showBlob().
    if (this.video) { this.video.controls = false; this.video.autoplay = true; }
    try { this.ws = new WebSocket(this.url); }
    catch (e) { this._status({ state: 'error', message: e.message }); return; }
    this.ws.binaryType = 'arraybuffer';
    this._status({ state: 'connecting' });
    this.ws.onopen = () => this._status({ state: 'connected' });
    this.ws.onmessage = (ev) => this._onMessage(ev);
    this.ws.onerror = () => {}; // 'close' handles recovery
    this.ws.onclose = () => {
      this._teardownMedia();
      this._status({ state: 'disconnected' });
      if (this._wantOpen) { clearTimeout(this._retry); this._retry = setTimeout(() => this._wantOpen && this._open(), 2000); }
    };
  }

  disconnect() {
    this._wantOpen = false;
    clearTimeout(this._retry);
    if (this.ws) { this.ws.onclose = null; try { this.ws.close(); } catch {} this.ws = null; }
    this.recording = false; this.recParts = null;
    this._teardownMedia();
    this._status({ state: 'disconnected' });
  }

  _onMessage(ev) {
    if (typeof ev.data === 'string') {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === 'hello') this.codec = m.codec;
        else if (m.type === 'status') this._status({ state: 'bridge', level: m.level, message: m.message });
      } catch {}
      return;
    }
    const bytes = new Uint8Array(ev.data);
    const payload = bytes.subarray(1);
    if (bytes[0] === 0) this._onInit(payload); else this._onFragment(payload);
  }

  _onInit(payload) {
    this.initSeg = payload.slice();
    this._setupMedia();
  }

  _setupMedia() {
    if (!this.video || !this.codec || !this.initSeg) return;
    const mime = `video/mp4; codecs="${this.codec}"`;
    if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(mime)) {
      this._status({ state: 'error', message: `Unsupported codec ${this.codec}` });
      return;
    }
    this._teardownMedia();
    this.ms = new MediaSource();
    this.video.src = URL.createObjectURL(this.ms);
    this.video.muted = true;
    this.ms.addEventListener('sourceopen', () => {
      try {
        this.sb = this.ms.addSourceBuffer(mime);
        this.sb.mode = 'sequence';
        this.sb.addEventListener('updateend', () => { this._flush(); this._snapLive(); });
        this.queue = [this.initSeg];
        this._flush();
        this.video.play?.().catch(() => {});
        this._status({ state: 'live' });
      } catch (e) { this._status({ state: 'error', message: e.message }); }
    }, { once: true });
  }

  _onFragment(payload) {
    const buf = payload.slice();
    if (this.sb) { this.queue.push(buf); this._flush(); }
    if (this.recording) {
      const r = buf.slice();
      const boxes = tfdtBoxes(r);
      if (this._recOffsets === null) this._recOffsets = boxes.map((t) => tfdtValue(r, t));
      boxes.forEach((t, k) => tfdtWrite(r, t, tfdtValue(r, t) - (this._recOffsets[k] || 0)));
      this.recParts.push(r);
    }
  }

  _flush() {
    if (!this.sb || this.sb.updating || !this.queue.length) return;
    try { this.sb.appendBuffer(this.queue.shift()); }
    catch (e) { if (e.name === 'QuotaExceededError') this._evict(); }
  }

  // Keep the live playhead glued to the newest data for minimum latency. If it
  // drifts more than ~0.12s behind the live edge (stall or buffer build-up), jump
  // to within ~2 frames of it. Only for the live stream (this.sb), never during
  // saved-clip playback. The 0.12/0.06 pair is the playback-side latency knob:
  // smaller = lower lag but more risk of micro-stalls when frames arrive late.
  _snapLive() {
    if (!this.sb || !this.video || this.video.seeking) return;
    const b = this.video.buffered;
    if (!b.length) return;
    const end = b.end(b.length - 1);
    if (end - this.video.currentTime > 0.12) {
      try { this.video.currentTime = Math.max(0, end - 0.06); } catch { /* ignore */ }
    }
  }

  _evict() {
    try {
      const b = this.video.buffered;
      if (b.length) { const end = b.end(b.length - 1); if (end > 12 && !this.sb.updating) this.sb.remove(0, end - 8); }
    } catch {}
  }

  _teardownMedia() {
    try { if (this.video) { this.video.removeAttribute('src'); this.video.load(); } } catch {}
    this.ms = null; this.sb = null; this.queue = [];
  }

  // ---- recording ------------------------------------------------------------
  // Records the fMP4 we're already receiving. Returns true if it could start.
  startRecording() {
    if (!this.initSeg) return false;
    this.recParts = [this.initSeg.slice()];
    this._recOffsets = null;
    this.recording = true;
    return true;
  }

  // Returns a Blob('video/mp4'), or null if nothing was captured.
  stopRecording() {
    if (!this.recording) return null;
    this.recording = false;
    const parts = this.recParts;
    this.recParts = null;
    if (!parts || parts.length < 2) return null; // init only, no media
    return new Blob(parts, { type: 'video/mp4' });
  }

  // ---- saved-session playback ----------------------------------------------
  // Show a recorded clip (independent of the live socket).
  showBlob(blob) {
    this.disconnect();
    if (!this.video) return;
    this._objUrl && URL.revokeObjectURL(this._objUrl);
    this._objUrl = URL.createObjectURL(blob);
    this.video.autoplay = false; // don't auto-play a saved clip — let the user press play
    this.video.muted = false;
    this.video.controls = true;
    this.video.src = this._objUrl;
  }

  clearPlayback() {
    this._objUrl && URL.revokeObjectURL(this._objUrl);
    this._objUrl = null;
    this._teardownMedia();
  }
}
