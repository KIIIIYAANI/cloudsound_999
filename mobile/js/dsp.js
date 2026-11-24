// Signal helpers: FFT analysis, onset (slice) detection per frequency band, band split, WAV encoding.

export const BANDS = {
  full: [20, 20000],
  low: [20, 150],     // kicks, bass
  mid: [150, 2500],   // snares, vocals, keys
  high: [4000, 16000] // hats, cymbals, shakers
};

export function mono(chs) {
  if (chs.length === 1) return chs[0];
  const n = chs[0].length, out = new Float32Array(n), k = 1 / chs.length;
  for (const c of chs) for (let i = 0; i < n; i++) out[i] += c[i] * k;
  return out;
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

// Short-time analysis: per frame, energy and spectral flux in each band.
export function analyse(chs, sr) {
  const x = mono(chs), N = 1024, hop = 512;
  const frames = Math.max(1, Math.ceil(x.length / hop));
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const binHz = sr / N, half = N / 2;
  const range = {};
  for (const [k, [lo, hi]] of Object.entries(BANDS)) range[k] = [Math.max(1, Math.floor(lo / binHz)), Math.min(half - 1, Math.ceil(hi / binHz))];
  const out = { hop, N, sr, frames, energy: {}, flux: {} };
  for (const k in BANDS) { out.energy[k] = new Float32Array(frames); out.flux[k] = new Float32Array(frames); }
  const re = new Float32Array(N), im = new Float32Array(N);
  let prev = new Float32Array(half), cur = new Float32Array(half);
  for (let f = 0; f < frames; f++) {
    const off = f * hop - N / 2;
    for (let i = 0; i < N; i++) { const j = off + i; re[i] = j >= 0 && j < x.length ? x[j] * win[i] : 0; im[i] = 0; }
    fft(re, im);
    for (let b = 0; b < half; b++) cur[b] = Math.log1p(20 * Math.hypot(re[b], im[b]));
    for (const k in BANDS) {
      const [a, z] = range[k];
      let e = 0, fl = 0;
      for (let b = a; b <= z; b++) { e += cur[b]; const d = cur[b] - prev[b]; if (d > 0) fl += d; }
      out.energy[k][f] = e / (z - a + 1);
      out.flux[k][f] = fl / (z - a + 1);
    }
    const t = prev; prev = cur; cur = t;
  }
  return out;
}

// Pick onsets in one band. sens 0..1 (higher = more slices). Returns sample positions.
export function onsets(an, band, sens, data) {
  const fl = an.flux[band], n = fl.length;
  let max = 0; for (let i = 0; i < n; i++) if (fl[i] > max) max = fl[i];
  if (!max) return [];
  const w = 8, minGap = Math.round(0.07 * an.sr / an.hop);
  const base = 0.06 + 0.5 * Math.pow(1 - sens, 1.6);
  const res = [];
  let last = -1e9;
  for (let i = 1; i < n - 1; i++) {
    const v = fl[i] / max;
    if (v < base || fl[i] < fl[i - 1] || fl[i] < fl[i + 1]) continue;
    let s = 0, c = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) { s += fl[j]; c++; }
    if (fl[i] < (s / c) * (1.25 + 0.6 * (1 - sens))) continue;
    if (i - last < minGap) continue;
    last = i;
    // Frame i centres on i*hop; step back a little so the slice keeps the attack.
    let p = Math.max(0, i * an.hop - Math.round(an.hop * 0.75));
    res.push(snapZero(data, p, Math.round(an.sr * 0.003)));
  }
  return res.filter(p => p > an.sr * 0.01 && p < data.length - an.sr * 0.01);
}

export function grid(len, n) {
  const out = [];
  for (let i = 1; i < n; i++) out.push(Math.round(len * i / n));
  return out;
}

export function snapZero(x, p, r) {
  let best = p, bv = Infinity;
  for (let i = Math.max(1, p - r); i < Math.min(x.length, p + r); i++) {
    if ((x[i - 1] <= 0 && x[i] > 0) || (x[i - 1] >= 0 && x[i] < 0)) { const d = Math.abs(i - p); if (d < bv) { bv = d; best = i; } }
  }
  return best;
}

// Copy a region with tiny fades so cuts never click.
export function cut(chs, a, b, sr) {
  const n = Math.max(1, b - a), f = Math.min(Math.round(sr * 0.002), n >> 2);
  return chs.map(c => {
    const o = c.slice(a, b);
    for (let i = 0; i < f; i++) { const g = i / f; o[i] *= g; o[n - 1 - i] *= g; }
    return o;
  });
}

export function reverse(chs) { return chs.map(c => c.slice().reverse()); }

export function normalize(chs) {
  let m = 0;
  for (const c of chs) for (let i = 0; i < c.length; i++) { const v = Math.abs(c[i]); if (v > m) m = v; }
  if (!m) return chs.map(c => c.slice());
  const g = 0.97 / m;
  return chs.map(c => c.map(v => v * g));
}

export function peak(chs) {
  let m = 0;
  for (const c of chs) for (let i = 0; i < c.length; i += 4) { const v = Math.abs(c[i]); if (v > m) m = v; }
  return m;
}

// Split into low / mid / high samples with an offline filter render.
export async function splitBands(chs, sr) {
  const specs = {
    low: [['lowpass', 150], ['lowpass', 150]],
    mid: [['highpass', 150], ['highpass', 150], ['lowpass', 2500], ['lowpass', 2500]],
    high: [['highpass', 4000], ['highpass', 4000]]
  };
  const out = {};
  for (const [name, chain] of Object.entries(specs)) {
    const oc = new OfflineAudioContext(chs.length, chs[0].length, sr);
    const b = oc.createBuffer(chs.length, chs[0].length, sr);
    chs.forEach((c, i) => b.copyToChannel(c, i));
    const s = oc.createBufferSource(); s.buffer = b;
    let node = s;
    for (const [type, f] of chain) { const q = oc.createBiquadFilter(); q.type = type; q.frequency.value = f; q.Q.value = 0.707; node.connect(q); node = q; }
    node.connect(oc.destination); s.start();
    const r = await oc.startRendering();
    out[name] = Array.from({ length: r.numberOfChannels }, (_, i) => r.getChannelData(i).slice());
  }
  return out;
}

export function encodeWav(chs, sr) {
  const nch = chs.length, n = chs[0].length, bytes = n * nch * 2;
  const buf = new ArrayBuffer(44 + bytes), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nch, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * nch * 2, true); v.setUint16(32, nch * 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, bytes, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) {
    const s = Math.max(-1, Math.min(1, chs[c][i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// Min/max per block of 64 samples, for fast waveform drawing at any zoom.
export function peaks(chs) {
  const x = mono(chs), B = 64, n = Math.ceil(x.length / B);
  const mn = new Float32Array(n), mx = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let lo = 1, hi = -1;
    for (let j = i * B, e = Math.min(x.length, j + B); j < e; j++) { const v = x[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
    mn[i] = lo; mx[i] = hi;
  }
  return { B, mn, mx, x };
}
