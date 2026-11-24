// Audio engine: master bus, 4 looping tracks, 9 pads, transport + metronome, input capture and master capture.

const TAP_WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.on = false; this.buf = null; this.n = 0; this.t0 = 0;
    this.port.onmessage = e => { if (e.data.on) { this.on = true; } else { this.on = false; this.flush(); this.port.postMessage({ done: true }); } }; }
  flush() { if (this.buf && this.n) { const out = this.buf.map(c => c.slice(0, this.n)); this.port.postMessage({ t: this.t0, chs: out }, out.map(c => c.buffer)); } this.buf = null; this.n = 0; }
  process(inputs) {
    const inp = inputs[0];
    if (!this.on || !inp || !inp.length) return true;
    const L = inp[0].length;
    if (this.buf && this.buf.length !== inp.length) this.flush();
    if (!this.buf) { this.buf = inp.map(() => new Float32Array(8192)); this.n = 0; }
    if (this.n === 0) this.t0 = currentFrame;
    for (let c = 0; c < inp.length; c++) this.buf[c].set(inp[c], this.n);
    this.n += L;
    if (this.n + L > 8192) this.flush();
    return true;
  }
}
registerProcessor('cs-tap', Tap);`;

class Capture {
  constructor(ctx, maxCh) {
    this.node = new AudioWorkletNode(ctx, 'cs-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: maxCh, channelCountMode: 'explicit' });
    this.chunks = []; this.on = false; this._done = null;
    this.node.port.onmessage = e => {
      if (e.data.done) { this._done && this._done(); this._done = null; return; }
      if (this.on) this.chunks.push(e.data);
    };
    const mute = ctx.createGain(); mute.gain.value = 0;
    this.node.connect(mute).connect(ctx.destination); // keeps the worklet pulled
  }
  start() { this.chunks = []; this.on = true; this.node.port.postMessage({ on: true }); }
  stop() {
    return new Promise(res => {
      this._done = () => { this.on = false; res(this.chunks); };
      this.node.port.postMessage({ on: false });
      setTimeout(() => { if (this._done) { this._done(); } }, 500);
    });
  }
}

// Lay recorded chunks out on the timeline [from, to) in frames.
export function assemble(chunks, from, to, nchMax = 2) {
  if (!chunks.length) return null;
  const nch = Math.min(nchMax, Math.max(...chunks.map(c => c.chs.length)));
  if (from == null) from = chunks[0].t;
  if (to == null) { const l = chunks[chunks.length - 1]; to = l.t + l.chs[0].length; }
  const len = Math.max(0, to - from);
  if (!len) return null;
  const out = Array.from({ length: nch }, () => new Float32Array(len));
  for (const ch of chunks) {
    const a = ch.t - from;
    for (let c = 0; c < nch; c++) {
      const src = ch.chs[Math.min(c, ch.chs.length - 1)];
      const s0 = Math.max(0, -a), s1 = Math.min(src.length, len - a);
      if (s1 > s0) out[c].set(src.subarray(s0, s1), a + s0);
    }
  }
  return out;
}

export class Engine {
  constructor() {
    this.bpm = 92; this.playing = false; this.t0 = 0; this.metro = false;
    this.countInUntil = 0; this.lastClick = -1;
    this.tracks = []; this.pads = [];
    this.stream = null; this.micSrc = null; this.source = 'mic';
    this.onTick = null;
  }

  async init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = this.ctx = new AC({ latencyHint: 'interactive' });
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
    const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);

    this.master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -8; comp.knee.value = 6; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.12;
    this.masterAn = ctx.createAnalyser(); this.masterAn.fftSize = 2048;
    this.master.connect(comp).connect(this.masterAn).connect(ctx.destination);
    this.masterCap = new Capture(ctx, 2);
    comp.connect(this.masterCap.node);

    this.padBus = ctx.createGain();
    this.padAn = ctx.createAnalyser(); this.padAn.fftSize = 1024;
    this.padBus.connect(this.padAn); this.padBus.connect(this.master);

    this.preview = ctx.createGain();
    this.previewAn = ctx.createAnalyser(); this.previewAn.fftSize = 1024;
    this.preview.connect(this.previewAn).connect(ctx.destination);

    this.clickBus = ctx.createGain(); this.clickBus.gain.value = 0.5;
    this.clickBus.connect(ctx.destination); // never recorded

    this.input = ctx.createGain();
    this.inAn = ctx.createAnalyser(); this.inAn.fftSize = 1024;
    this.monitor = ctx.createGain(); this.monitor.gain.value = 0;
    this.input.connect(this.inAn); this.input.connect(this.monitor).connect(this.master);
    this.micSel = ctx.createGain(); this.padSel = ctx.createGain(); this.padSel.gain.value = 0;
    this.inCap = new Capture(ctx, 2);
    this.input.connect(this.micSel).connect(this.inCap.node);
    this.padBus.connect(this.padSel).connect(this.inCap.node);

    for (let i = 0; i < 4; i++) {
      const g = ctx.createGain(), an = ctx.createAnalyser();
      an.fftSize = 1024; g.connect(an); g.connect(this.master);
      this.tracks.push({ g, an, buf: null, src: null, loop: true, vol: 0.9, mute: false, solo: false, phase: 0 });
    }
    setInterval(() => this._schedule(), 25);
  }

  resume() { return this.ctx.state !== 'running' ? this.ctx.resume() : Promise.resolve(); }
  get now() { return this.ctx.currentTime; }
  get beat() { return 60 / this.bpm; }
  get bar() { return 240 / this.bpm; }
  nextBar(t = this.now) { return this.t0 + Math.ceil((t - this.t0 + 0.03) / this.bar) * this.bar; }

  buffer(chs, sr) {
    const b = this.ctx.createBuffer(chs.length, chs[0].length, sr);
    chs.forEach((c, i) => b.copyToChannel(c, i));
    return b;
  }

  // ----- transport -----
  start(at) {
    if (this.playing) return;
    this.t0 = at ?? this.now + 0.06;
    this.playing = true; this.lastClick = Math.floor((this.now - this.t0) / this.beat) - 1;
    this.tracks.forEach((_, i) => this.startTrack(i, this.t0));
  }
  stop() {
    this.playing = false; this.countInUntil = 0;
    this.tracks.forEach((_, i) => this.stopTrack(i));
  }
  position() {
    if (!this.playing) return null;
    const b = (this.now - this.t0) / this.beat;
    return b < 0 ? null : { bar: Math.floor(b / 4) + 1, beat: Math.floor(b % 4) + 1 };
  }

  _schedule() {
    if (!this.playing) return;
    const ahead = this.now + 0.12;
    let k = Math.max(this.lastClick + 1, Math.ceil((this.now - 0.01 - this.t0) / this.beat));
    for (; this.t0 + k * this.beat < ahead; k++) {
      const t = this.t0 + k * this.beat;
      if (t >= this.now - 0.005 && (this.metro || t < this.countInUntil - 0.01)) this._click(t, k % 4 === 0);
      this.lastClick = k;
    }
  }
  _click(t, down) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.value = down ? 1760 : 1175; o.type = 'square';
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    o.connect(g).connect(this.clickBus); o.start(t); o.stop(t + 0.05);
  }

  // ----- tracks -----
  mixTracks() {
    const anySolo = this.tracks.some(t => t.solo && t.buf);
    for (const t of this.tracks) {
      const on = !t.mute && (!anySolo || t.solo);
      t.g.gain.setTargetAtTime(on ? t.vol : 0, this.now, 0.01);
    }
  }
  startTrack(i, when) {
    const t = this.tracks[i];
    this.stopTrack(i);
    if (!this.playing || !t.buf) return;
    when = Math.max(when ?? this.now, this.now + 0.01);
    const dur = t.buf.duration, rel = when - this.t0 - t.phase;
    let off;
    if (t.loop) off = ((rel % dur) + dur) % dur;
    else { if (rel >= dur) return; if (rel < 0) { when -= rel; off = 0; } else off = rel; }
    const s = this.ctx.createBufferSource();
    s.buffer = t.buf; s.loop = t.loop;
    if (t.loop) { s.loopStart = 0; s.loopEnd = dur; }
    s.connect(t.g); s.start(when, off);
    t.src = s; t.startedAt = when; t.startOff = off;
  }
  stopTrack(i) {
    const t = this.tracks[i];
    if (t.src) { try { t.src.stop(); } catch (e) {} t.src.disconnect(); t.src = null; }
  }
  trackPos(i) { // 0..1 playhead
    const t = this.tracks[i];
    if (!t.src || !t.buf) return null;
    const el = this.now - t.startedAt;
    if (el < 0) return null;
    const d = t.buf.duration, p = t.startOff + el;
    if (!t.loop && p > d) return null;
    return (p % d) / d;
  }

  // ----- pads -----
  playPad(i, pad, buf) {
    const p = this.pads[i] || (this.pads[i] = {});
    if (pad.cut !== false) this.releasePad(i, 0.012);
    const s = this.ctx.createBufferSource(), g = this.ctx.createGain();
    s.buffer = buf; s.playbackRate.value = Math.pow(2, (pad.pitch || 0) / 12);
    s.loop = pad.mode === 'loop';
    g.gain.value = (pad.gain ?? 1);
    s.connect(g).connect(this.padBus); s.start();
    p.voices = (p.voices || []).concat({ s, g });
    s.onended = () => { p.voices = (p.voices || []).filter(v => v.s !== s); g.disconnect(); };
  }
  releasePad(i, r = 0.03) {
    const p = this.pads[i]; if (!p || !p.voices) return;
    const t = this.now;
    for (const v of p.voices) {
      v.g.gain.cancelScheduledValues(t); v.g.gain.setValueAtTime(v.g.gain.value, t); v.g.gain.linearRampToValueAtTime(0, t + r);
      try { v.s.stop(t + r + 0.01); } catch (e) {}
    }
    p.voices = [];
  }

  // ----- preview / scrub -----
  stopPreview() { if (this.pv) { try { this.pv.stop(); } catch (e) {} this.pv = null; } }
  playPreview(buf, a = 0, b = buf.duration) {
    this.stopPreview();
    const s = this.ctx.createBufferSource(); s.buffer = buf; s.connect(this.preview);
    s.start(this.now + 0.005, a, Math.max(0.005, b - a));
    this.pv = s; this.pvInfo = { at: this.now + 0.005, a, b };
    s.onended = () => { if (this.pv === s) { this.pv = null; this.pvInfo = null; } };
  }
  previewPos() { if (!this.pvInfo) return null; const p = this.pvInfo.a + (this.now - this.pvInfo.at); return p <= this.pvInfo.b ? p : null; }
  grain(buf, pos, dur = 0.07) {
    const t = this.now, s = this.ctx.createBufferSource(), g = this.ctx.createGain();
    s.buffer = buf; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.9, t + 0.008); g.gain.linearRampToValueAtTime(0, t + dur);
    s.connect(g).connect(this.preview); s.start(t, Math.max(0, Math.min(pos, buf.duration - 0.01)), dur + 0.01);
  }

  // ----- input -----
  setSource(src) { this.source = src; this.micSel.gain.value = src === 'mic' ? 1 : 0; this.padSel.gain.value = src === 'pads' ? 1 : 0; }
  async openMic(deviceId) {
    if (this.stream && this.streamDev === (deviceId || '')) return;
    this.closeMic();
    try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch (e) {}
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } };
    if (deviceId) audio.deviceId = { exact: deviceId };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio });
    this.streamDev = deviceId || '';
    this.micSrc = this.ctx.createMediaStreamSource(this.stream);
    this.micSrc.connect(this.input);
    await this.resume();
  }
  closeMic() {
    if (this.micSrc) { this.micSrc.disconnect(); this.micSrc = null; }
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
  }
}
