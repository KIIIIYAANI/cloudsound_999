import { Engine, assemble } from './engine.js';
import { store } from './store.js';
import * as dsp from './dsp.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const engine = new Engine();
let ready = false;

const TRACK_COLORS = ['#e5412d', '#ff8a1f', '#f2b100', '#2f9a4a'];
const PAD_COLORS = ['#e5412d', '#ff8a1f', '#f2b100', '#2f9a4a', '#17a2a0', '#ff6b9a', '#8a5cd6', '#2a8fd6', '#c2410c'];
const BAND_RGB = { low: [217, 56, 30], mid: [228, 140, 0], high: [31, 150, 80] };

// ---------------- state ----------------
const S = {
  bpm: 92, metro: false, recLen: 0, src: 'mic', bayFilter: 'all',
  tracks: Array.from({ length: 4 }, () => ({ sampleId: null, vol: 0.9, mute: false, solo: false, loop: true, phase: 0 })),
  pads: Array.from({ length: 9 }, () => ({ sampleId: null, pitch: 0, gain: 1, mode: 'one', cut: true })),
  markers: {},
  settings: { deviceId: '', gain: 1, latMs: 0, monitor: false, countIn: true },
  tapeNo: 0
};
const samples = new Map();

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const dur = s => s.chs[0].length / s.sr;
const fmtDur = d => d < 10 ? d.toFixed(2) + 's' : d < 60 ? d.toFixed(1) + 's' : `${Math.floor(d / 60)}:${String(Math.floor(d % 60)).padStart(2, '0')}`;
const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let saveT;
function saveState() {
  clearTimeout(saveT);
  saveT = setTimeout(() => store.set('state', JSON.parse(JSON.stringify(S))).catch(e => console.warn(e)), 400);
}
function persistSample(s) {
  return store.putSample({ id: s.id, name: s.name, sr: s.sr, chs: s.chs, kind: s.kind, hidden: !!s.hidden, created: s.created })
    .catch(e => toast('Could not save audio: ' + (e.message || e)));
}
async function addSample({ name, chs, sr, kind = 'cut', hidden = false }) {
  const s = { id: newId(), name, chs, sr, kind, hidden, created: Date.now() };
  samples.set(s.id, s);
  await persistSample(s);
  want(s);
  if (!hidden) renderBay();
  return s;
}
function replaceData(s, chs, mapMarker) {
  s.chs = chs; s._buf = null; s._an = null; s._pk = null; s._q = false;
  const m = S.markers[s.id];
  if (m) S.markers[s.id] = mapMarker ? m.map(mapMarker).filter(p => p > 0 && p < chs[0].length).sort((a, b) => a - b) : [];
  persistSample(s); want(s); saveState();
  S.tracks.forEach((t, i) => { if (t.sampleId === s.id) loadTrack(i, s, true); });
  renderPads(); if (!s.hidden) renderBay();
}
function gc() {
  const used = new Set([...S.tracks.map(t => t.sampleId), ...S.pads.map(p => p.sampleId)]);
  for (const s of [...samples.values()]) {
    if (s.hidden && !used.has(s.id)) { samples.delete(s.id); delete S.markers[s.id]; store.delSample(s.id); }
  }
  saveState();
}

// lazily built per-sample caches
function bufOf(s) { if (!s._buf && ready) s._buf = engine.buffer(s.chs, s.sr); return s._buf; }
function pkOf(s) { if (!s._pk) s._pk = dsp.peaks(s.chs); return s._pk; }
function anOf(s) {
  if (!s._an) { s._an = dsp.analyse(s.chs, s.sr); bandMax(s); }
  return s._an;
}
function bandMax(s) {
  const m = {};
  for (const k of ['low', 'mid', 'high']) { let x = 1e-6; for (const v of s._an.energy[k]) if (v > x) x = v; m[k] = x; }
  s._bm = m;
}
const anQ = []; let pumping = false;
function want(s) {
  if (s._an || s._q) return;
  s._q = true; anQ.push(s);
  if (pumping) return;
  pumping = true;
  const run = () => {
    const x = anQ.shift();
    if (!x) { pumping = false; return; }
    if (samples.has(x.id) && !x._an) { anOf(x); onAnalysed(x); }
    setTimeout(run, 20);
  };
  setTimeout(run, 60);
}
function onAnalysed(s) {
  S.tracks.forEach((t, i) => { if (t.sampleId === s.id) cards[i].dirty = true; });
  const li = $(`#bayList li[data-id="${s.id}"] canvas`); if (li) drawMini(li, s);
  S.pads.forEach((p, i) => { if (p.sampleId === s.id) drawPadWave(i); });
  if (ed.s === s) ed.dirty = true;
}

// ---------------- drawing ----------------
function fit(cv) {
  const r = cv.getBoundingClientRect(), d = Math.min(window.devicePixelRatio || 1, 2.5);
  const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; return true; }
  return false;
}
function colorAt(s, idx) {
  const an = s._an; if (!an || !s._bm) return null;
  const f = Math.min(an.frames - 1, Math.floor(idx / an.hop));
  let wl = an.energy.low[f] / s._bm.low, wm = an.energy.mid[f] / s._bm.mid, wh = an.energy.high[f] / s._bm.high;
  wl *= wl * wl; wm *= wm * wm; wh *= wh * wh;
  const sum = wl + wm + wh;
  if (sum < 1e-4) return 'rgb(60,44,30)';
  const c = [0, 1, 2].map(j => Math.round((wl * BAND_RGB.low[j] + wm * BAND_RGB.mid[j] + wh * BAND_RGB.high[j]) / sum));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
function paintWave(g, W, H, s, a, b, color) {
  const pk = pkOf(s), n = Math.max(1, b - a), spp = n / W, mid = H / 2, amp = H / 2 * 0.94;
  for (let x = 0; x < W; x++) {
    const i0 = a + Math.floor(x * spp), i1 = Math.max(i0 + 1, a + Math.floor((x + 1) * spp));
    if (i0 >= pk.x.length) break;
    let lo = 1, hi = -1;
    if (spp >= pk.B) {
      for (let k = Math.floor(i0 / pk.B), e = Math.min(pk.mn.length, Math.ceil(i1 / pk.B)); k < e; k++) { if (pk.mn[k] < lo) lo = pk.mn[k]; if (pk.mx[k] > hi) hi = pk.mx[k]; }
    } else {
      for (let k = i0, e = Math.min(pk.x.length, i1 + 1); k < e; k++) { const v = pk.x[k]; if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    if (hi < lo) continue;
    g.fillStyle = colorAt(s, (i0 + i1) >> 1) || color;
    g.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
  }
}
function drawMini(cv, s, color = '#3b2a1a') {
  fit(cv);
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  if (s) paintWave(g, cv.width, cv.height, s, 0, s.chs[0].length, color);
}
function drawScope(g, an, W, H, color, buf, lw = 2) {
  an.getFloatTimeDomainData(buf);
  // start on a rising zero crossing so the trace holds still
  let st = 0;
  for (let i = 1; i < buf.length / 2; i++) if (buf[i - 1] <= 0 && buf[i] > 0) { st = i; break; }
  const n = Math.min(buf.length - st, buf.length / 2);
  g.strokeStyle = color; g.lineWidth = lw; g.lineJoin = 'round'; g.beginPath();
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const v = buf[st + i]; if (Math.abs(v) > peak) peak = Math.abs(v);
    const x = i / (n - 1) * W, y = H / 2 - v * H * 0.46;
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.stroke();
  return peak;
}
const scopeBuf = new Float32Array(2048);

// ---------------- tracks UI ----------------
const cards = [];
function buildTracks() {
  const root = $('#tracksView');
  root.innerHTML = '';
  S.tracks.forEach((t, i) => {
    const el = document.createElement('article');
    el.className = 'track'; el.style.setProperty('--tc', TRACK_COLORS[i]);
    el.innerHTML = `
      <div class="track-head">
        <span class="track-num">${i + 1}</span>
        <span class="track-name"></span>
        <span class="rec-sticker" hidden>REC</span>
        <button class="btn btn-xs t-more" aria-label="Track ${i + 1} options">•••</button>
      </div>
      <div class="track-wave"><canvas></canvas><div class="track-empty">EMPTY · TAP REC OR LOAD</div><div class="rec-progress"><i></i></div></div>
      <div class="track-ctl">
        <button class="btn btn-sm t-rec"><i class="dot"></i> REC</button>
        <button class="btn btn-xs t-loop" aria-pressed="true">LOOP</button>
        <button class="btn btn-xs t-mute" aria-pressed="false">M</button>
        <button class="btn btn-xs t-solo" aria-pressed="false">S</button>
        <input class="t-vol" type="range" min="0" max="100" aria-label="Track ${i + 1} volume">
      </div>`;
    root.appendChild(el);
    const c = { el, cv: $('canvas', el), layer: document.createElement('canvas'), dirty: true };
    cards[i] = c;
    $('.t-rec', el).onclick = () => toggleRec(i);
    $('.t-loop', el).onclick = () => { t.loop = !t.loop; if (ready) { engine.tracks[i].loop = t.loop; engine.startTrack(i); } updateCard(i); saveState(); };
    $('.t-mute', el).onclick = () => { t.mute = !t.mute; applyMix(); updateCard(i); saveState(); };
    $('.t-solo', el).onclick = () => { t.solo = !t.solo; applyMix(); S.tracks.forEach((_, j) => updateCard(j)); saveState(); };
    const vol = $('.t-vol', el);
    vol.value = Math.round(t.vol * 100);
    vol.oninput = () => { t.vol = vol.value / 100; applyMix(); saveState(); };
    $('.t-more', el).onclick = () => trackMenu(i);
    $('.track-wave', el).onclick = () => { const s = samples.get(t.sampleId); if (s) openEditor(s, i); else trackMenu(i); };
    updateCard(i);
  });
}
function updateCard(i) {
  const t = S.tracks[i], c = cards[i], s = samples.get(t.sampleId);
  $('.track-name', c.el).textContent = s ? `${s.name} · ${fmtDur(dur(s))}` : `TRACK ${i + 1}`;
  $('.track-empty', c.el).hidden = !!s || (rec && rec.i === i);
  $('.t-loop', c.el).setAttribute('aria-pressed', t.loop);
  $('.t-mute', c.el).setAttribute('aria-pressed', t.mute);
  $('.t-solo', c.el).setAttribute('aria-pressed', t.solo);
  const r = rec && rec.i === i;
  $('.t-rec', c.el).classList.toggle('live', !!r);
  $('.t-rec', c.el).innerHTML = r ? (rec.phase === 'wait' ? '<i class="dot"></i> WAIT' : '<i class="dot"></i> STOP') : '<i class="dot"></i> REC';
  $('.rec-sticker', c.el).hidden = !r;
  c.el.classList.toggle('recording', !!r);
  c.dirty = true;
}
function applyMix() {
  if (!ready) return;
  S.tracks.forEach((t, i) => Object.assign(engine.tracks[i], { vol: t.vol, mute: t.mute, solo: t.solo }));
  engine.mixTracks();
}
function loadTrack(i, s, keepPhase) {
  const t = S.tracks[i];
  t.sampleId = s ? s.id : null;
  if (!keepPhase) t.phase = 0;
  if (ready) {
    const et = engine.tracks[i];
    et.buf = s ? bufOf(s) : null; et.loop = t.loop; et.phase = t.phase;
    engine.startTrack(i);
    applyMix();
  }
  updateCard(i); gc();
}
function trackMenu(i) {
  const t = S.tracks[i], s = samples.get(t.sampleId);
  const items = [
    { label: 'IMPORT AUDIO FILE', fn: () => { importTarget = i; $('#trackImport').click(); } },
    { label: 'LOAD FROM SOUND BAY', fn: () => pickBay(`LOAD INTO TRACK ${i + 1}`, x => loadTrack(i, cloneHidden(x))) }
  ];
  if (s) items.push(
    { label: 'CHOP / EDIT', fn: () => openEditor(s, i) },
    { label: 'SEND WHOLE TRACK → BAY', fn: async () => { await addSample({ name: `T${i + 1} ${s.name}`, chs: s.chs.map(c => c.slice()), sr: s.sr, kind: 'cut' }); toast('Sent to the bay'); } },
    { label: 'SAVE / SHARE WAV', fn: () => share(s) },
    { label: 'CLEAR TRACK', danger: true, fn: () => loadTrack(i, null) }
  );
  actions(`TRACK ${i + 1}`, items);
}
function cloneHidden(x) {
  const s = { id: newId(), name: x.name, chs: x.chs.map(c => c.slice()), sr: x.sr, kind: 'rec', hidden: true, created: Date.now() };
  samples.set(s.id, s); persistSample(s); want(s);
  if (S.markers[x.id]) S.markers[s.id] = S.markers[x.id].slice();
  return s;
}

// ---------------- recording ----------------
let rec = null;
async function toggleRec(i) {
  if (!ready) return;
  if (rec) {
    if (rec.i !== i) { toast(`Track ${rec.i + 1} is recording`); return; }
    if (rec.phase === 'wait') { cancelRec(); return; }
    finishRec(engine.now);
    return;
  }
  await engine.resume();
  if (S.src === 'mic') {
    try { await engine.openMic(S.settings.deviceId); refreshDevices(); }
    catch (e) { toast(micError(e)); return; }
  }
  engine.setSource(S.src);
  const bars = S.recLen;
  rec = { i, bars, phase: 'wait' };
  engine.inCap.start();
  const now = engine.now;
  if (bars) {
    if (!engine.playing) {
      const t0 = now + 0.1; engine.start(t0); updatePlay();
      rec.start = S.settings.countIn ? t0 + engine.bar : t0;
      engine.countInUntil = rec.start;
    } else rec.start = engine.nextBar();
    rec.end = rec.start + bars * engine.bar;
    rec.timer = setTimeout(() => finishRec(rec.end), (rec.end - now + 0.3) * 1000);
  } else {
    rec.start = now; rec.phase = 'rec';
  }
  updateCard(i);
  status(bars ? `REC T${i + 1} · ${bars} BAR${bars > 1 ? 'S' : ''}` : `REC T${i + 1}`);
}
function cancelRec() {
  clearTimeout(rec.timer); engine.inCap.stop(); engine.countInUntil = 0;
  const i = rec.i; rec = null; updateCard(i); maybeCloseMic(); status('REC CANCELLED');
}
async function finishRec(end) {
  if (!rec || rec.finishing) return;
  rec.finishing = true; clearTimeout(rec.timer);
  const r = rec, sr = engine.ctx.sampleRate, lat = S.settings.latMs / 1000;
  if (r.bars && end < r.end && r.phase === 'rec') { /* stopped early: keep what we have, rounded to whole beats */
    const beats = Math.max(1, Math.round((end - r.start) / engine.beat)); end = r.start + beats * engine.beat;
    await new Promise(res => setTimeout(res, Math.max(0, (end - engine.now + 0.15) * 1000)));
  }
  const chunks = await engine.inCap.stop();
  rec = null; engine.countInUntil = 0;
  let chs = assemble(chunks, Math.round((r.start + lat) * sr), Math.round((end + lat) * sr));
  maybeCloseMic();
  if (!chs || chs[0].length < sr * 0.05) { updateCard(r.i); toast('Nothing recorded'); status('READY'); return; }
  chs = collapseMono(chs);
  if (dsp.peak(chs) < 0.0005) toast('That take is silent. Check the input in Settings.');
  const s = await addSample({ name: `T${r.i + 1} TAKE`, chs, sr, kind: 'rec', hidden: true });
  S.tracks[r.i].phase = engine.playing ? r.start - engine.t0 : 0;
  loadTrack(r.i, s, true);
  status(`T${r.i + 1} ${fmtDur(dur(s))}`);
}
function collapseMono(chs) {
  if (chs.length < 2) return chs;
  const [l, r] = chs;
  for (let i = 0; i < l.length; i += 7) if (Math.abs(l[i] - r[i]) > 1e-4) return chs;
  return [l];
}
function maybeCloseMic() { if (!inputOpen && !S.settings.monitor && !rec) engine.closeMic(); }
function micError(e) {
  if (!window.isSecureContext) return 'Mic needs a secure (https) page.';
  if (e && e.name === 'NotAllowedError') return 'Mic access was blocked. Allow the microphone for this site in your browser settings.';
  if (e && e.name === 'NotFoundError') return 'No microphone found.';
  if (e && e.name === 'OverconstrainedError') { S.settings.deviceId = ''; saveState(); return 'That input is gone. Switched back to the default mic, try again.'; }
  return 'Could not open the mic: ' + (e && (e.message || e.name));
}

let inputOpen = false;
async function toggleInput() {
  if (!ready) return;
  if (inputOpen) { inputOpen = false; maybeCloseMic(); }
  else {
    try { await engine.openMic(S.settings.deviceId); inputOpen = true; refreshDevices(); }
    catch (e) { toast(micError(e)); }
  }
  $('#inputBtn').setAttribute('aria-pressed', inputOpen);
}

let mrec = null;
async function toggleMasterRec() {
  if (!ready) return;
  await engine.resume();
  if (!mrec) {
    mrec = { at: engine.now }; engine.masterCap.start();
    $('#mrecBtn').classList.add('live'); status('MASTER REC');
    return;
  }
  $('#mrecBtn').classList.remove('live');
  const chunks = await engine.masterCap.stop(); mrec = null;
  const chs = assemble(chunks);
  if (!chs || chs[0].length < engine.ctx.sampleRate * 0.1) { toast('Tape too short'); return; }
  S.tapeNo++;
  const s = await addSample({ name: `TAPE ${String(S.tapeNo).padStart(3, '0')}`, chs, sr: engine.ctx.sampleRate, kind: 'tape' });
  saveState();
  toast(`${s.name} (${fmtDur(dur(s))}) saved to the Sound Bay`);
  status('TAPE SAVED');
}

// ---------------- transport ----------------
function updatePlay() {
  const b = $('#playBtn');
  b.classList.toggle('live', engine.playing);
  b.textContent = engine.playing ? '■ STOP' : '▶ PLAY';
}
async function togglePlay() {
  if (!ready) return;
  await engine.resume();
  if (engine.playing) {
    if (rec) { if (rec.phase === 'wait') cancelRec(); else await finishRec(engine.now); }
    engine.stop();
  } else { S.tracks.forEach((t, i) => engine.tracks[i].phase = t.phase); engine.start(); }
  updatePlay();
}
function setBpm(v, fromInput) {
  v = Math.max(40, Math.min(240, Math.round(v * 10) / 10));
  if (!isFinite(v)) return;
  S.bpm = v; if (ready) engine.bpm = v;
  if (!fromInput) $('#bpm').value = v;
  saveState();
}
let taps = [];
function tapTempo() {
  const t = performance.now();
  taps = taps.filter(x => t - x < 2500); taps.push(t);
  if (taps.length >= 2) {
    const iv = []; for (let i = 1; i < taps.length; i++) iv.push(taps[i] - taps[i - 1]);
    setBpm(60000 / (iv.reduce((a, b) => a + b) / iv.length));
  }
}

// ---------------- pads ----------------
let padEdit = false;
function buildPads() {
  const root = $('#pads');
  root.innerHTML = '';
  S.pads.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'pad'; b.style.setProperty('--pc', PAD_COLORS[i]);
    b.innerHTML = `<span class="pad-led"></span><span class="pad-num">${i + 1}</span><canvas></canvas><span class="pad-name"></span>`;
    let lp, held = false;
    b.addEventListener('pointerdown', e => {
      e.preventDefault();
      try { b.setPointerCapture(e.pointerId); } catch (_) {}
      if (padEdit) { openPad(i); return; }
      held = true; hitPad(i);
      lp = setTimeout(() => { if (held) openPad(i); }, 650);
    });
    const up = () => { clearTimeout(lp); if (!held) return; held = false; b.classList.remove('hit'); if (ready && S.pads[i].mode !== 'one') engine.releasePad(i); };
    b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
    b.addEventListener('contextmenu', e => e.preventDefault());
    root.appendChild(b);
  });
  renderPads();
}
function renderPads() {
  $$('#pads .pad').forEach((b, i) => {
    const s = samples.get(S.pads[i].sampleId);
    $('.pad-name', b).textContent = s ? s.name : '—';
    b.classList.toggle('empty', !s);
    drawPadWave(i);
  });
}
function drawPadWave(i) {
  const b = $$('#pads .pad')[i]; if (!b) return;
  const s = samples.get(S.pads[i].sampleId), cv = $('canvas', b);
  if (cv.getBoundingClientRect().width) drawMini(cv, s, '#3b2a1a');
}
async function hitPad(i) {
  const b = $$('#pads .pad')[i];
  b.classList.add('hit');
  if (S.pads[i].mode === 'one') setTimeout(() => b.classList.remove('hit'), 110);
  if (!ready) return;
  const s = samples.get(S.pads[i].sampleId); if (!s) return;
  if (engine.ctx.state !== 'running') await engine.resume();
  engine.playPad(i, S.pads[i], bufOf(s));
}
function assignPad(i, s) {
  S.pads[i].sampleId = s ? s.id : null;
  if (ready) engine.releasePad(i);
  renderPads(); saveState(); gc();
}
function pickPad(title, cb) {
  actions(title, S.pads.map((p, i) => {
    const s = samples.get(p.sampleId);
    return { label: String(i + 1), sub: s ? s.name : 'empty', cls: 'pad-pick', color: PAD_COLORS[i], fn: () => cb(i) };
  }), { grid: true });
}
let psI = 0;
function openPad(i) {
  psI = i;
  const p = S.pads[i], s = samples.get(p.sampleId);
  $('#psTitle').textContent = `PAD ${i + 1}`;
  $('#psName').textContent = s ? `${s.name} · ${fmtDur(dur(s))}` : 'empty, load a sound from the bay';
  $('#psPitch').value = p.pitch; $('#psPitchV').textContent = (p.pitch > 0 ? '+' : '') + p.pitch;
  $('#psGain').value = Math.round(p.gain * 100); $('#psGainV').textContent = Math.round(p.gain * 100);
  seg($('#psMode'), p.mode);
  $('#psCut').setAttribute('aria-pressed', p.cut); $('#psCut').textContent = p.cut ? 'CUT ON' : 'CUT OFF';
  openSheet('#padSheet');
  requestAnimationFrame(() => drawMini($('#psWave'), s, '#3b2a1a'));
}

let drawerOpen = false;
function setDrawer(open) {
  drawerOpen = open;
  $('#drawer').classList.toggle('open', open);
  document.body.classList.toggle('drawer-open', open);
  if (open) setTimeout(renderPads, 280);
}

// ---------------- sound bay ----------------
function bayKind(s) { return s.kind === 'band' ? 'cut' : s.kind; }
function renderBay() {
  const list = $('#bayList');
  const all = [...samples.values()].filter(s => !s.hidden).sort((a, b) => b.created - a.created);
  $('#bayCount').textContent = all.length;
  const vis = all.filter(s => S.bayFilter === 'all' || bayKind(s) === S.bayFilter);
  $('#bayEmpty').hidden = vis.length > 0;
  list.innerHTML = vis.map(s => `
    <li data-id="${s.id}" class="k-${bayKind(s)}">
      <button class="bay-play" aria-label="Play ${esc(s.name)}">▶</button>
      <div class="bay-body"><canvas></canvas><div class="bay-meta"><b>${esc(s.name)}</b><span>${fmtDur(dur(s))} · ${bayKind(s).toUpperCase()}</span></div></div>
      <button class="btn btn-xs bay-pad">→ PAD</button>
      <button class="btn btn-xs bay-more" aria-label="More">•••</button>
    </li>`).join('');
  if (!$('#bayView').hidden) $$('#bayList li').forEach(li => drawMini($('canvas', li), samples.get(li.dataset.id)));
}
function bayItemAction(e) {
  const li = e.target.closest('li'); if (!li) return;
  const s = samples.get(li.dataset.id); if (!s) return;
  if (e.target.closest('.bay-play')) { if (ready) { engine.resume(); engine.playPreview(bufOf(s)); } }
  else if (e.target.closest('.bay-pad')) pickPad(`LOAD "${s.name}" ONTO PAD`, i => { assignPad(i, s); toast(`Pad ${i + 1} ← ${s.name}`); });
  else if (e.target.closest('.bay-more')) bayMenu(s);
  else if (e.target.closest('.bay-body')) openEditor(s, null);
}
function bayMenu(s) {
  actions(s.name, [
    { label: 'LOAD ONTO PAD', fn: () => pickPad(`LOAD "${s.name}" ONTO PAD`, i => assignPad(i, s)) },
    { label: 'LOAD INTO TRACK', fn: () => actions('WHICH TRACK?', [0, 1, 2, 3].map(i => ({ label: `TRACK ${i + 1}`, fn: () => { loadTrack(i, cloneHidden(s)); toast(`Track ${i + 1} ← ${s.name}`); } }))) },
    { label: 'CHOP / EDIT', fn: () => openEditor(s, null) },
    { label: 'RENAME', fn: () => { const n = prompt('Name', s.name); if (n && n.trim()) { s.name = n.trim().slice(0, 40); persistSample(s); renderBay(); renderPads(); } } },
    { label: 'SAVE / SHARE WAV', fn: () => share(s) },
    { label: 'DELETE', danger: true, fn: () => deleteSample(s) }
  ]);
}
function deleteSample(s) {
  const onPads = S.pads.map((p, i) => p.sampleId === s.id ? i + 1 : 0).filter(Boolean);
  if (onPads.length && !confirm(`"${s.name}" is on pad ${onPads.join(', ')}. Delete it anyway?`)) return;
  S.pads.forEach(p => { if (p.sampleId === s.id) p.sampleId = null; });
  samples.delete(s.id); delete S.markers[s.id]; store.delSample(s.id);
  renderBay(); renderPads(); saveState();
}
function pickBay(title, cb) {
  const all = [...samples.values()].filter(s => !s.hidden).sort((a, b) => b.created - a.created);
  if (!all.length) { toast('The Sound Bay is empty'); return; }
  actions(title, all.map(s => ({ label: s.name, sub: `${fmtDur(dur(s))} · ${bayKind(s).toUpperCase()}`, fn: () => cb(s) })));
}

// ---------------- import / export ----------------
let importTarget = null;
async function decodeFile(f) {
  if (!ready) throw new Error('Tap start first');
  const ab = await f.arrayBuffer();
  const b = await new Promise((res, rej) => { const p = engine.ctx.decodeAudioData(ab, res, rej); if (p && p.catch) p.catch(rej); });
  const max = b.sampleRate * 600;
  const chs = Array.from({ length: Math.min(2, b.numberOfChannels) }, (_, i) => b.getChannelData(i).slice(0, max));
  if (b.length > max) toast('Long file: kept the first 10 minutes');
  return { chs: collapseMono(chs), sr: b.sampleRate, name: f.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'import' };
}
async function importFiles(files, track) {
  for (const f of files) {
    status('LOADING ' + f.name.slice(0, 14).toUpperCase());
    try {
      const d = await decodeFile(f);
      if (track != null) {
        const s = await addSample({ ...d, kind: 'import', hidden: true });
        loadTrack(track, s);
        toast(`Track ${track + 1} ← ${d.name}`);
      } else await addSample({ ...d, kind: 'import' });
    } catch (e) { toast(`Couldn't read ${f.name}. Try WAV, MP3 or M4A.`); }
  }
  status('READY');
}
async function share(s) {
  const blob = dsp.encodeWav(s.chs, s.sr);
  const file = new File([blob], s.name.replace(/[^\w\- ]+/g, '_') + '.wav', { type: 'audio/wav' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: s.name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 20000);
}

// ---------------- chop editor ----------------
const ed = { s: null, track: null, a: 0, b: 1, mode: 'play', band: 'full', sens: 55, sel: null, mark: -1, dirty: true, scrubAt: null };
function markers() { return S.markers[ed.s.id] || (S.markers[ed.s.id] = []); }
function regions() {
  const m = markers(), n = ed.s.chs[0].length, pts = [0, ...m, n], out = [];
  for (let i = 0; i < pts.length - 1; i++) if (pts[i + 1] > pts[i]) out.push([pts[i], pts[i + 1]]);
  return out;
}
function openEditor(s, track) {
  Object.assign(ed, { s, track, a: 0, b: s.chs[0].length, sel: null, mark: -1, dirty: true });
  $('#edName').textContent = track != null ? `TRACK ${track + 1}` : s.name;
  updateEdMeta();
  openSheet('#editor');
  if (!s._an) { status('ANALYSING'); setTimeout(() => { anOf(s); ed.dirty = true; status('READY'); }, 30); }
}
function updateEdMeta() {
  const n = markers().length + 1;
  $('#edMeta').textContent = `${fmtDur(dur(ed.s))} · ${n} slice${n > 1 ? 's' : ''}`;
  $('#edSelInfo').textContent = ed.sel ? `${fmtDur((ed.sel[1] - ed.sel[0]) / ed.s.sr)}` : '— tap a slice';
  ed.dirty = true;
}
function sensLabel() {
  $('#edSensLabel').textContent = ed.band === 'grid' ? `SLICES ${gridN()}` : `SENS ${ed.sens}`;
}
const gridN = () => [2, 4, 8, 12, 16, 24, 32][Math.min(6, Math.floor(ed.sens / 100 * 7))];
function chop() {
  const s = ed.s, n = s.chs[0].length;
  let m;
  if (ed.band === 'grid') m = dsp.grid(n, gridN()).map(p => dsp.snapZero(pkOf(s).x, p, Math.round(s.sr * 0.002)));
  else m = dsp.onsets(anOf(s), ed.band, ed.sens / 100, pkOf(s).x);
  S.markers[s.id] = m.slice(0, 63);
  ed.sel = null; updateEdMeta(); saveState();
  toast(m.length ? `${m.length + 1} slices` : 'No hits found. Raise SENS or try another band.');
}
function edX2i(x) { const r = $('#edWave').getBoundingClientRect(); return Math.round(ed.a + (x - r.left) / r.width * (ed.b - ed.a)); }
function edI2x(i) { const r = $('#edWave').getBoundingClientRect(); return (i - ed.a) / (ed.b - ed.a) * r.width; }
function clampView() {
  const n = ed.s.chs[0].length, minW = Math.min(n, Math.round(ed.s.sr * 0.02));
  let w = Math.max(minW, Math.min(n, ed.b - ed.a));
  let a = Math.max(0, Math.min(n - w, ed.a));
  ed.a = a; ed.b = a + w; ed.dirty = true;
}
function zoom(f, centerIdx) {
  const c = centerIdx ?? (ed.a + ed.b) / 2, w = (ed.b - ed.a) * f;
  ed.a = Math.round(c - (c - ed.a) * f); ed.b = Math.round(ed.a + w); clampView();
}
function edSelectAt(idx) {
  const r = regions().find(([a, b]) => idx >= a && idx < b);
  if (!r) return;
  ed.sel = r; updateEdMeta();
  if (ready) { engine.resume(); engine.playPreview(bufOf(ed.s), r[0] / ed.s.sr, r[1] / ed.s.sr); }
}
function setupEditorPointer() {
  const cv = $('#edWave'), pts = new Map();
  let drag = null, pinch = null, lastGrain = 0;
  cv.addEventListener('pointerdown', e => {
    e.preventDefault(); try { cv.setPointerCapture(e.pointerId); } catch (_) {}
    pts.set(e.pointerId, e.clientX);
    if (pts.size === 2) {
      const [x1, x2] = [...pts.values()];
      pinch = { d: Math.abs(x1 - x2) || 1, a: ed.a, b: ed.b, c: edX2i((x1 + x2) / 2) }; drag = null; return;
    }
    const idx = edX2i(e.clientX);
    let mk = -1;
    if (ed.mode === 'cut') {
      const m = markers(); let best = 18;
      m.forEach((p, j) => { const d = Math.abs(edI2x(p) - (e.clientX - cv.getBoundingClientRect().left)); if (d < best) { best = d; mk = j; } });
    }
    drag = { x0: e.clientX, a0: ed.a, b0: ed.b, mk, moved: false };
    if (mk >= 0) { ed.mark = mk; ed.dirty = true; }
    if (ed.mode === 'scrub') { scrubTo(idx); }
  });
  cv.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, e.clientX);
    if (pinch && pts.size >= 2) {
      const [x1, x2] = [...pts.values()], d = Math.abs(x1 - x2) || 1;
      const f = pinch.d / d, w = (pinch.b - pinch.a) * f;
      ed.a = Math.round(pinch.c - (pinch.c - pinch.a) * f); ed.b = Math.round(ed.a + w); clampView(); return;
    }
    if (!drag) return;
    const dx = e.clientX - drag.x0;
    if (Math.abs(dx) > 6) drag.moved = true;
    if (ed.mode === 'scrub') { const t = performance.now(); if (t - lastGrain > 35) { lastGrain = t; scrubTo(edX2i(e.clientX)); } return; }
    if (drag.mk >= 0) {
      const m = markers(), n = ed.s.chs[0].length;
      const lo = drag.mk > 0 ? m[drag.mk - 1] + 64 : 64, hi = drag.mk < m.length - 1 ? m[drag.mk + 1] - 64 : n - 64;
      m[drag.mk] = Math.max(lo, Math.min(hi, edX2i(e.clientX)));
      ed.dirty = true; return;
    }
    if (drag.moved && ed.b - ed.a < ed.s.chs[0].length) {
      const r = cv.getBoundingClientRect(), shift = -dx / r.width * (drag.b0 - drag.a0);
      ed.a = Math.round(drag.a0 + shift); ed.b = Math.round(drag.b0 + shift); clampView();
    }
  });
  const end = e => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pinch) { if (pts.size < 2) pinch = null; drag = null; return; }
    if (!drag) return;
    const d = drag; drag = null;
    if (ed.mode === 'scrub') { ed.scrubAt = null; ed.dirty = true; return; }
    if (d.mk >= 0) {
      if (d.moved) { const m = markers(); m[d.mk] = dsp.snapZero(pkOf(ed.s).x, m[d.mk], Math.round(ed.s.sr * 0.002)); saveState(); ed.sel = null; updateEdMeta(); }
      return;
    }
    if (d.moved || e.type === 'pointercancel') return;
    const idx = edX2i(e.clientX);
    if (ed.mode === 'cut') {
      const m = markers(), p = dsp.snapZero(pkOf(ed.s).x, idx, Math.round(ed.s.sr * 0.002));
      if (p > 32 && p < ed.s.chs[0].length - 32 && !m.includes(p)) { m.push(p); m.sort((a, b) => a - b); ed.mark = m.indexOf(p); }
      ed.sel = null; updateEdMeta(); saveState();
      if (ready) { engine.resume(); engine.grain(bufOf(ed.s), p / ed.s.sr, 0.12); }
    } else edSelectAt(idx);
  };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  cv.addEventListener('wheel', e => { e.preventDefault(); zoom(e.deltaY > 0 ? 1.25 : 0.8, edX2i(e.clientX)); }, { passive: false });
}
function scrubTo(idx) {
  ed.scrubAt = Math.max(0, Math.min(ed.s.chs[0].length - 1, idx)); ed.dirty = true;
  if (ready) { engine.resume(); engine.grain(bufOf(ed.s), ed.scrubAt / ed.s.sr); }
}
function drawEditor() {
  const cv = $('#edWave'); const resized = fit(cv);
  const pv = ready ? engine.previewPos() : null;
  if (!ed.dirty && !resized && pv == null && !ed.pvWas) return;
  ed.pvWas = pv != null; ed.dirty = false;
  const g = cv.getContext('2d'), W = cv.width, H = cv.height, s = ed.s, span = ed.b - ed.a;
  const X = i => (i - ed.a) / span * W;
  g.clearRect(0, 0, W, H);
  regions().forEach(([a, b], j) => { if (j % 2) { g.fillStyle = 'rgba(59,42,26,0.06)'; g.fillRect(X(a), 0, X(b) - X(a), H); } });
  if (ed.sel) { g.fillStyle = 'rgba(255,197,61,0.45)'; g.fillRect(X(ed.sel[0]), 0, X(ed.sel[1]) - X(ed.sel[0]), H); }
  g.fillStyle = 'rgba(59,42,26,0.25)'; g.fillRect(0, H / 2, W, 1);
  paintWave(g, W, H, s, ed.a, ed.b, '#3b2a1a');
  const dpr = W / cv.getBoundingClientRect().width;
  markers().forEach((p, j) => {
    if (p < ed.a || p > ed.b) return;
    const x = Math.round(X(p));
    g.fillStyle = j === ed.mark && ed.mode === 'cut' ? '#e5412d' : '#1d140c';
    g.fillRect(x - dpr, 0, 2 * dpr, H);
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 9 * dpr, 0); g.lineTo(x, 11 * dpr); g.fill();
    g.font = `${10 * dpr}px Bungee, sans-serif`; g.fillText(String(j + 2), x + 3 * dpr, H - 4 * dpr);
  });
  g.fillStyle = '#1d140c'; g.font = `${10 * dpr}px Bungee, sans-serif`; if (ed.a === 0) g.fillText('1', 3 * dpr, H - 4 * dpr);
  const ph = pv != null ? pv * s.sr : ed.scrubAt;
  if (ph != null) { g.fillStyle = '#e5412d'; g.fillRect(X(ph) - dpr, 0, 2 * dpr, H); }
  // overview strip when zoomed
  if (span < s.chs[0].length) {
    const n = s.chs[0].length; g.fillStyle = 'rgba(29,20,12,0.15)'; g.fillRect(0, 0, W, 4 * dpr);
    g.fillStyle = '#1d140c'; g.fillRect(ed.a / n * W, 0, Math.max(3, span / n * W), 4 * dpr);
  }
}
async function sliceToBay(r, label) {
  const s = ed.s;
  return addSample({ name: label, chs: dsp.cut(s.chs, r[0], r[1], s.sr), sr: s.sr, kind: 'cut' });
}
function sliceName(j) { return `${ed.track != null ? 'T' + (ed.track + 1) : ed.s.name.slice(0, 18)} CUT ${String(j + 1).padStart(2, '0')}`; }
function setupEditorButtons() {
  $('#edClose').onclick = () => { if (ready) engine.stopPreview(); closeSheets(); };
  seg($('#edMode'), ed.mode, v => {
    ed.mode = v; ed.dirty = true;
    $('#edHint').textContent = { play: 'Tap a slice to hear and select it. Drag to scroll, pinch to zoom.', cut: 'Tap to drop a cut. Drag a cut to move it. DEL MARK removes the red one.', scrub: 'Drag across the wave to scrub through the sound.' }[v];
  });
  seg($('#edBand'), ed.band, v => { ed.band = v; sensLabel(); });
  $('#edSens').oninput = e => { ed.sens = +e.target.value; sensLabel(); };
  $('#edZoomIn').onclick = () => zoom(0.5);
  $('#edZoomOut').onclick = () => zoom(2);
  $('#edFit').onclick = () => { ed.a = 0; ed.b = ed.s.chs[0].length; ed.dirty = true; };
  $('#edChop').onclick = chop;
  $('#edClear').onclick = () => { S.markers[ed.s.id] = []; ed.sel = null; updateEdMeta(); saveState(); };
  $('#edPlaySel').onclick = () => { const r = ed.sel || [0, ed.s.chs[0].length]; if (ready) { engine.resume(); engine.playPreview(bufOf(ed.s), r[0] / ed.s.sr, r[1] / ed.s.sr); } };
  const needSel = () => { if (!ed.sel) { toast('Select a slice first (SELECT mode, tap the wave)'); return false; } return true; };
  $('#edSelBay').onclick = async () => { if (!needSel()) return; const j = regions().findIndex(r => r[0] === ed.sel[0]); const c = await sliceToBay(ed.sel, sliceName(j)); toast(`${c.name} → bay`); };
  $('#edSelPad').onclick = () => {
    if (!needSel()) return;
    const sel = ed.sel, j = regions().findIndex(r => r[0] === sel[0]);
    pickPad('PUT THIS SLICE ON PAD', async i => { const c = await sliceToBay(sel, sliceName(j)); assignPad(i, c); toast(`Pad ${i + 1} ← ${c.name}`); });
  };
  $('#edCrop').onclick = () => {
    if (!needSel()) return;
    const [a, b] = ed.sel;
    replaceData(ed.s, dsp.cut(ed.s.chs, a, b, ed.s.sr), p => p - a);
    Object.assign(ed, { a: 0, b: ed.s.chs[0].length, sel: null }); updateEdMeta();
  };
  $('#edDelMark').onclick = () => {
    const m = markers();
    if (ed.mark < 0 || ed.mark >= m.length) { toast('Switch to CUT and tap a cut to pick it'); return; }
    m.splice(ed.mark, 1); ed.mark = -1; ed.sel = null; updateEdMeta(); saveState();
  };
  $('#edAllBay').onclick = async () => {
    const rs = regions();
    if (rs.length < 2) { toast('No cuts yet. CHOP first or add cuts by hand.'); return; }
    for (let j = 0; j < rs.length; j++) await sliceToBay(rs[j], sliceName(j));
    toast(`${rs.length} slices → bay`);
  };
  $('#edAllPads').onclick = async () => {
    const rs = regions();
    if (rs.length < 2) { toast('No cuts yet. CHOP first or add cuts by hand.'); return; }
    const k = Math.min(9, rs.length);
    for (let j = 0; j < k; j++) { const c = await sliceToBay(rs[j], sliceName(j)); S.pads[j].sampleId = c.id; }
    renderPads(); saveState(); gc();
    toast(`Slices 1–${k} on pads 1–${k}${rs.length > 9 ? ` (${rs.length - 9} more are in the bay via ALL → BAY)` : ''}`);
  };
  $('#edSplit').onclick = async () => {
    status('SPLITTING');
    const parts = await dsp.splitBands(ed.s.chs, ed.s.sr);
    const base = ed.track != null ? `T${ed.track + 1}` : ed.s.name.slice(0, 22);
    for (const k of ['low', 'mid', 'high']) await addSample({ name: `${base} ${k.toUpperCase()}`, chs: dsp.normalize(parts[k]), sr: ed.s.sr, kind: 'band' });
    status('READY'); toast('LOW · MID · HIGH layers → bay');
  };
  $('#edRev').onclick = () => { const n = ed.s.chs[0].length; replaceData(ed.s, dsp.reverse(ed.s.chs), p => n - p); ed.sel = null; updateEdMeta(); };
  $('#edNorm').onclick = () => { replaceData(ed.s, dsp.normalize(ed.s.chs), p => p); ed.dirty = true; toast('Normalized'); };
  $('#edBpm').onclick = () => {
    const d = dur(ed.s);
    let best = null;
    for (const bars of [0.5, 1, 2, 4, 8, 16]) { const b = 240 * bars / d; if (b >= 60 && b <= 200 && (!best || Math.abs(b - S.bpm) < Math.abs(best.b - S.bpm))) best = { b, bars }; }
    if (!best) { toast('Could not fit a tempo to this length'); return; }
    setBpm(best.b);
    if (ready && engine.playing) { engine.stop(); engine.start(); }
    toast(`${best.b.toFixed(1)} BPM (${best.bars} bar${best.bars === 1 ? '' : 's'})`);
  };
}

// ---------------- sheets, segs, toast ----------------
function openSheet(sel) {
  closeSheets(true);
  $(sel).hidden = false; $('#scrim').hidden = $(sel).classList.contains('full');
  requestAnimationFrame(() => $(sel).classList.add('show'));
}
function closeSheets(instant) {
  $$('.sheet').forEach(s => { s.classList.remove('show'); s.hidden = true; });
  $('#scrim').hidden = true;
}
function actions(title, items, opt = {}) {
  $('#actTitle').textContent = title;
  const list = $('#actList');
  list.className = 'act-list' + (opt.grid ? ' grid' : '');
  list.innerHTML = '';
  const back = !$('#editor').hidden ? '#editor' : null;
  items.forEach(it => {
    const b = document.createElement('button');
    b.className = 'act' + (it.danger ? ' danger' : '') + (it.cls ? ' ' + it.cls : '');
    if (it.color) b.style.setProperty('--pc', it.color);
    b.innerHTML = `<b>${esc(it.label)}</b>${it.sub ? `<span>${esc(it.sub)}</span>` : ''}`;
    b.onclick = () => { closeAct(back); it.fn(); };
    list.appendChild(b);
  });
  $('#actions').dataset.back = back || '';
  $('#actions').hidden = false; $('#scrim').hidden = false;
  requestAnimationFrame(() => $('#actions').classList.add('show'));
}
function closeAct() {
  $('#actions').classList.remove('show'); $('#actions').hidden = true;
  if ($('#padSheet').hidden && $('#settings').hidden) $('#scrim').hidden = true;
}
function seg(el, val, onChange) {
  $$('button', el).forEach(b => b.classList.toggle('on', b.dataset.v === String(val)));
  if (onChange) el.onclick = e => { const b = e.target.closest('button'); if (!b) return; seg(el, b.dataset.v); onChange(b.dataset.v); };
}
let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600);
}
let statusT;
function status(msg) {
  $('#status').textContent = msg;
  clearTimeout(statusT);
  if (msg !== 'READY') statusT = setTimeout(() => { if (!rec && !mrec) $('#status').textContent = 'READY'; }, 4000);
}

// ---------------- settings ----------------
async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
  const sel = $('#setDevice');
  sel.innerHTML = '<option value="">Default input</option>' + devs.filter(d => d.deviceId && d.deviceId !== 'default').map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || `Input ${i + 1}`)}</option>`).join('');
  sel.value = S.settings.deviceId || '';
  if (sel.value !== (S.settings.deviceId || '')) sel.value = '';
}
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('#setInstall').hidden = false; });
function setupSettings() {
  $('#settingsBtn').onclick = async () => {
    openSheet('#settings'); refreshDevices();
    const st = $('#setStorage');
    if (navigator.storage?.estimate) { const e = await navigator.storage.estimate(); st.textContent = `Using ${(e.usage / 1048576).toFixed(1)} MB.`; }
    if (/iPhone|iPad|iPod/.test(navigator.userAgent) && !navigator.standalone) st.textContent += ' To install: Share → Add to Home Screen.';
  };
  $('#setClose').onclick = () => closeSheets();
  $('#setRescan').onclick = async () => {
    try { await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop())); } catch (e) { toast(micError(e)); }
    await refreshDevices(); toast('Inputs rescanned');
  };
  $('#setDevice').onchange = async e => {
    S.settings.deviceId = e.target.value; saveState();
    if (ready && engine.stream) { try { engine.closeMic(); await engine.openMic(S.settings.deviceId); } catch (err) { toast(micError(err)); } }
  };
  const gain = $('#setGain'); gain.value = Math.round(S.settings.gain * 100); $('#setGainV').textContent = gain.value;
  gain.oninput = () => { S.settings.gain = gain.value / 100; $('#setGainV').textContent = gain.value; if (ready) engine.input.gain.value = S.settings.gain; saveState(); };
  const lat = $('#setLat'); lat.value = S.settings.latMs; $('#setLatV').textContent = lat.value;
  lat.oninput = () => { S.settings.latMs = +lat.value; $('#setLatV').textContent = lat.value; saveState(); };
  $('#setMonitor').checked = S.settings.monitor;
  $('#setMonitor').onchange = async e => {
    S.settings.monitor = e.target.checked; saveState();
    if (!ready) return;
    engine.monitor.gain.value = S.settings.monitor ? 1 : 0;
    if (S.settings.monitor) { try { await engine.openMic(S.settings.deviceId); } catch (err) { toast(micError(err)); } } else maybeCloseMic();
  };
  $('#setCountIn').checked = S.settings.countIn;
  $('#setCountIn').onchange = e => { S.settings.countIn = e.target.checked; saveState(); };
  $('#setInstall').onclick = async () => { if (installEvt) { installEvt.prompt(); installEvt = null; $('#setInstall').hidden = true; } };
  $('#setWipe').onclick = async () => {
    if (!confirm('Erase every track, pad and sample on this phone?')) return;
    clearTimeout(saveT); await store.wipe(); location.reload();
  };
}

// ---------------- frame loop ----------------
function frame() {
  requestAnimationFrame(frame);
  if (document.hidden || !ready) return;
  const pos = engine.position();
  if (rec && rec.phase === 'wait' && engine.now >= rec.start) { rec.phase = 'rec'; updateCard(rec.i); }
  $('#pos').textContent = rec && rec.phase === 'wait' && engine.playing
    ? `-${Math.max(1, Math.ceil((rec.start - engine.now) / engine.beat))}`
    : pos ? `${pos.bar}.${pos.beat}` : '1.1';

  const ms = $('#masterScope'); fit(ms);
  const mg = ms.getContext('2d'); mg.clearRect(0, 0, ms.width, ms.height);
  mg.fillStyle = 'rgba(36,48,15,0.15)'; for (let x = 0; x < ms.width; x += ms.width / 16) mg.fillRect(Math.round(x), 0, 1, ms.height);
  drawScope(mg, engine.masterAn, ms.width, ms.height, '#24300f', scopeBuf, Math.max(1.5, ms.height / 30));

  S.tracks.forEach((t, i) => {
    const c = cards[i], s = samples.get(t.sampleId), isRec = rec && rec.i === i;
    const live = engine.playing || isRec;
    const resized = fit(c.cv);
    if (!live && !c.dirty && !resized && !c.wasLive) return;
    c.wasLive = live;
    const W = c.cv.width, H = c.cv.height, g = c.cv.getContext('2d');
    if (c.dirty || resized || c.layer.width !== W || c.layer.height !== H) {
      c.layer.width = W; c.layer.height = H;
      const lg = c.layer.getContext('2d'); lg.clearRect(0, 0, W, H);
      if (s) {
        paintWave(lg, W, H, s, 0, s.chs[0].length, '#3b2a1a');
        lg.fillStyle = 'rgba(29,20,12,.55)';
        (S.markers[s.id] || []).forEach(p => lg.fillRect(Math.round(p / s.chs[0].length * W), 0, 1, H));
      }
      c.dirty = false;
    }
    g.clearRect(0, 0, W, H);
    g.drawImage(c.layer, 0, 0);
    if (isRec) {
      g.fillStyle = 'rgba(255,241,208,0.6)'; g.fillRect(0, 0, W, H);
      drawScope(g, S.src === 'pads' ? engine.padAn : engine.inAn, W, H, '#e5412d', scopeBuf, 2.5);
      const prog = $('.rec-progress i', c.el);
      if (rec.end && rec.phase === 'rec') prog.style.width = `${Math.min(100, (engine.now - rec.start) / (rec.end - rec.start) * 100)}%`;
      else if (rec.phase === 'rec') prog.style.width = '100%';
      else prog.style.width = '0%';
    } else {
      $('.rec-progress i', c.el).style.width = '0%';
      if (s && engine.playing) {
        drawScope(g, engine.tracks[i].an, W, H, 'rgba(29,20,12,0.85)', scopeBuf, 2);
        const p = engine.trackPos(i);
        if (p != null) { g.fillStyle = '#e5412d'; g.fillRect(Math.round(p * W) - 1, 0, 3, H); }
      }
    }
  });

  if (drawerOpen) {
    const ps = $('#padScope'); fit(ps);
    const pg = ps.getContext('2d'); pg.clearRect(0, 0, ps.width, ps.height);
    drawScope(pg, engine.padAn, ps.width, ps.height, '#fff1d0', scopeBuf, 2);
  }
  if (engine.stream) {
    engine.inAn.getFloatTimeDomainData(scopeBuf);
    let m = 0; for (let i = 0; i < 1024; i++) m = Math.max(m, Math.abs(scopeBuf[i]));
    $('#meterFill').style.height = `${Math.min(100, Math.sqrt(m) * 100)}%`;
    $('#meterFill').classList.toggle('clip', m > 0.98);
  } else $('#meterFill').style.height = '0%';
  if (!$('#editor').hidden && ed.s) drawEditor();
}

// ---------------- boot ----------------
async function load() {
  try {
    const st = await store.get('state');
    if (st) {
      Object.assign(S, { ...st, settings: { ...S.settings, ...(st.settings || {}) } });
      S.tracks = S.tracks.map(t => ({ vol: 0.9, mute: false, solo: false, loop: true, phase: 0, ...t }));
      S.pads = S.pads.map(p => ({ pitch: 0, gain: 1, mode: 'one', cut: true, ...p }));
      S.markers = S.markers || {};
    }
    for (const r of await store.allSamples()) samples.set(r.id, r);
  } catch (e) { console.warn('load failed', e); }
  S.tracks.forEach(t => { if (t.sampleId && !samples.has(t.sampleId)) t.sampleId = null; });
  S.pads.forEach(p => { if (p.sampleId && !samples.has(p.sampleId)) p.sampleId = null; });
  [...samples.values()].sort((a, b) => (a.hidden ? 0 : 1) - (b.hidden ? 0 : 1)).forEach(want);
}

async function start() {
  if (ready) return;
  $('#startBtn').textContent = 'LOADING…';
  try {
    await engine.init();
    await engine.resume();
  } catch (e) {
    $('#startBtn').textContent = 'TAP TO START';
    toast('Audio could not start: ' + (e.message || e)); return;
  }
  ready = true;
  engine.bpm = S.bpm;
  engine.input.gain.value = S.settings.gain;
  engine.monitor.gain.value = S.settings.monitor ? 1 : 0;
  engine.setSource(S.src);
  S.tracks.forEach((t, i) => { const s = samples.get(t.sampleId); Object.assign(engine.tracks[i], { buf: s ? bufOf(s) : null, loop: t.loop, phase: t.phase }); });
  applyMix();
  if (S.settings.monitor) engine.openMic(S.settings.deviceId).catch(() => {});
  navigator.storage?.persist?.();
  $('#splash').classList.add('gone');
  setTimeout(() => $('#splash').remove(), 500);
  // iOS suspends audio when the app is backgrounded
  document.addEventListener('visibilitychange', () => { if (!document.hidden) engine.resume(); });
}

function wire() {
  $('#startBtn').onclick = start;
  $('#playBtn').onclick = togglePlay;
  $('#mrecBtn').onclick = toggleMasterRec;
  $('#metroBtn').onclick = () => { S.metro = !S.metro; engine.metro = S.metro; $('#metroBtn').setAttribute('aria-pressed', S.metro); saveState(); };
  $('#tapBtn').onclick = tapTempo;
  $('#bpm').value = S.bpm;
  $('#bpm').onchange = e => setBpm(+e.target.value);
  $('#inputBtn').onclick = toggleInput;
  seg($('#srcSeg'), S.src, v => { S.src = v; if (ready) engine.setSource(v); saveState(); });
  seg($('#lenSeg'), String(S.recLen), v => { S.recLen = +v; saveState(); });
  $('#metroBtn').setAttribute('aria-pressed', S.metro); engine.metro = S.metro;

  $$('.tabs button').forEach(b => b.onclick = () => {
    $$('.tabs button').forEach(x => x.classList.toggle('on', x === b));
    $('#tracksView').hidden = b.dataset.tab !== 'tracks';
    $('#bayView').hidden = b.dataset.tab !== 'bay';
    if (b.dataset.tab === 'bay') renderBay(); else cards.forEach(c => c.dirty = true);
  });
  seg($('#bayChips'), S.bayFilter);
  $('#bayChips').onclick = e => { const b = e.target.closest('button'); if (!b) return; S.bayFilter = b.dataset.f; $$('#bayChips button').forEach(x => x.classList.toggle('on', x === b)); renderBay(); saveState(); };
  $$('#bayChips button').forEach(x => x.classList.toggle('on', x.dataset.f === S.bayFilter));
  $('#bayList').onclick = bayItemAction;
  $('#bayImport').onchange = e => { importFiles([...e.target.files]); e.target.value = ''; };
  $('#trackImport').onchange = e => { const f = e.target.files[0]; if (f) importFiles([f], importTarget); e.target.value = ''; };

  // drawer: tap or swipe the handle
  const h = $('#drawerHandle'); let y0 = null;
  h.addEventListener('pointerdown', e => { if (e.target.closest('button')) return; y0 = e.clientY; });
  h.addEventListener('pointerup', e => {
    if (y0 == null) return;
    const dy = e.clientY - y0; y0 = null;
    if (Math.abs(dy) < 8) setDrawer(!drawerOpen); else setDrawer(dy < 0);
  });
  $('#padEditBtn').onclick = () => { padEdit = !padEdit; $('#padEditBtn').setAttribute('aria-pressed', padEdit); $('#drawer').classList.toggle('editing', padEdit); };

  // pad sheet
  $('#psClose').onclick = () => closeSheets();
  $('#psPitch').oninput = e => { S.pads[psI].pitch = +e.target.value; $('#psPitchV').textContent = (e.target.value > 0 ? '+' : '') + e.target.value; saveState(); };
  $('#psGain').oninput = e => { S.pads[psI].gain = e.target.value / 100; $('#psGainV').textContent = e.target.value; saveState(); };
  seg($('#psMode'), 'one', v => { S.pads[psI].mode = v; if (ready) engine.releasePad(psI); saveState(); });
  $('#psCut').onclick = () => { const p = S.pads[psI]; p.cut = !p.cut; $('#psCut').setAttribute('aria-pressed', p.cut); $('#psCut').textContent = p.cut ? 'CUT ON' : 'CUT OFF'; saveState(); };
  $('#psPick').onclick = () => { const i = psI; pickBay(`LOAD ONTO PAD ${i + 1}`, s => { assignPad(i, s); openPad(i); }); };
  $('#psEdit').onclick = () => { const s = samples.get(S.pads[psI].sampleId); if (s) openEditor(s, null); else toast('Pad is empty'); };
  $('#psClear').onclick = () => { assignPad(psI, null); openPad(psI); };
  $('#psWave').addEventListener('pointerdown', () => hitPad(psI));

  $('#actClose').onclick = () => { const back = $('#actions').dataset.back; closeAct(back); };
  $('#scrim').onclick = () => { if (!$('#actions').hidden) closeAct($('#actions').dataset.back); else closeSheets(); };

  setupSettings();
  setupEditorPointer();
  setupEditorButtons();
  sensLabel();

  // computer keyboard: 1-9 pads, space play
  window.addEventListener('keydown', e => {
    if (e.target.matches('input, select, textarea') || e.repeat) return;
    if (e.key >= '1' && e.key <= '9') hitPad(+e.key - 1);
    else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  });
  window.addEventListener('keyup', e => {
    if (e.key >= '1' && e.key <= '9') { const i = +e.key - 1; $$('#pads .pad')[i]?.classList.remove('hit'); if (ready && S.pads[i].mode !== 'one') engine.releasePad(i); }
  });
  window.addEventListener('resize', () => { cards.forEach(c => c.dirty = true); ed.dirty = true; });
}

window.__cs999 = { engine, S, samples }; // handy for debugging from the console

(async function boot() {
  await load();
  buildTracks(); buildPads(); wire(); renderBay();
  requestAnimationFrame(frame);
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
