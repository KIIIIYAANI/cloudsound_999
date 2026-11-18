"use strict";
const $ = (s, el = document) => el.querySelector(s);
const SKINS = [
  ["matrix", "Matrix"],
  ["lymewire", "LymeWire"],
  ["napsterr", "Napsterr"],
  ["hotfries", "HotFries"],
  ["joekool", "JoeKool"],
  ["postal", "POSTAL"],
  ["noir", "Noir"],
];
// skin ids used before 3.0.1, so a saved choice carries over
const LEGACY_SKINS = { "2001": "matrix", limewire: "lymewire", napster: "napsterr", cameljoe: "joekool", usps: "postal" };
const FILTERS = [
  ["all", "All", () => true],
  ["downloading", "Downloading", (j) => ["downloading", "processing", "resolving"].includes(j.status)],
  ["queued", "Queued", (j) => j.status === "queued"],
  ["paused", "Paused", (j) => j.status === "paused"],
  ["done", "Completed", (j) => j.status === "done"],
  ["error", "Errored", (j) => j.status === "error"],
  ["organize", "Organize", (j) => j.status === "done"],
];
const STATUS_LABEL = {
  resolving: "Resolving", queued: "Queued", downloading: "Downloading",
  processing: "Processing", paused: "Paused", done: "Completed", error: "Error",
};

let state = { jobs: [], settings: {}, totals: {} };
// Native bridge when running inside the cloudsound_999 Mac app (absent in a normal browser).
const NATIVE = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.cs999;
const toNative = (msg) => { try { NATIVE && NATIVE.postMessage(msg); } catch {} };
function pickFolderNative() {
  return new Promise((resolve) => {
    window.__cs999Folder = (p) => { window.__cs999Folder = null; resolve(p); };
    toNative({ type: "chooseFolder", current: (state.settings && state.settings.output_dir) || "" });
  });
}
let lastActive = -1;
let health = null;
let filter = "all";
const selected = new Set();
let lastClicked = null;
let query = "";
let sort = { by: null, dir: 1 };   // by: title | artist | bpm | key | size | status

// ---------------------------------------------------------------- search + sort
// Search: every word must match. Words match title/artist/key text; a number also matches
// BPM within ±1.5; "120-130" is a BPM range; "8A" is a Camelot key; "Fm", "F#min", "Abmaj" are keys.
const NOTE_ALIAS = { db: "c#", "d#": "eb", gb: "f#", "g#": "ab", "a#": "bb" };
function keyToken(t) {
  const m = t.replace("♯", "#").replace("♭", "b").match(/^([a-g])([#b]?)(m|min|minor|maj|major)?$/);
  if (!m) return null;
  let note = m[1] + m[2];
  note = NOTE_ALIAS[note] || note;
  const scale = m[3] ? (m[3].startsWith("maj") ? "major" : "minor") : null;
  return { note, scale };
}
function matches(j, q) {
  if (!q) return true;
  const hay = [j.title, j.artist, j.key, j.camelot, j.bpm != null ? String(j.bpm) : ""].join(" ").toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => {
    if (hay.includes(t)) return true;
    let m = t.match(/^(\d{2,3}(?:\.\d+)?)-(\d{2,3}(?:\.\d+)?)$/);
    if (m) return j.bpm != null && j.bpm >= +m[1] && j.bpm <= +m[2];
    if (/^\d{2,3}(\.\d+)?$/.test(t)) return j.bpm != null && Math.abs(j.bpm - +t) <= 1.5;
    if (/^(1[0-2]|[1-9])[ab]$/.test(t)) return (j.camelot || "").toLowerCase() === t;
    const k = keyToken(t);
    if (k && j.key) {
      const [note, scale] = j.key.toLowerCase().split(" ");
      return note === k.note && (!k.scale || scale === k.scale);
    }
    return false;
  });
}
const camelotRank = (c) => { const m = /^(\d+)([AB])$/.exec(c || ""); return m ? +m[1] * 2 + (m[2] === "B" ? 1 : 0) : Infinity; };
const STATUS_ORDER = ["downloading", "processing", "resolving", "queued", "paused", "error", "done"];
function sortVal(j, by) {
  switch (by) {
    case "title": return (j.title || "").toLowerCase();
    case "artist": return (j.artist || "").toLowerCase() || null;
    case "bpm": return j.bpm ?? null;
    case "key": return j.camelot ? camelotRank(j.camelot) : null;
    case "size": return j.size ?? null;
    case "status": return STATUS_ORDER.indexOf(j.status);
  }
  return 0;
}
function sortJobs(list) {
  if (!sort.by) return list;
  const by = sort.by, d = sort.dir;
  return list.map((j, i) => [j, sortVal(j, by), i]).sort((a, b) => {
    if (a[1] == null && b[1] == null) return a[2] - b[2];
    if (a[1] == null) return 1;          // missing values always last
    if (b[1] == null) return -1;
    if (a[1] < b[1]) return -d;
    if (a[1] > b[1]) return d;
    return a[2] - b[2];
  }).map((x) => x[0]);
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

// ---------------------------------------------------------------- formatting
function fmtBytes(n) {
  if (n == null || isNaN(n)) return "—";
  const u = ["B", "KB", "MB", "GB"]; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(n < 10 ? 2 : 1) : n) + " " + u[i];
}
const fmtSpeed = (n) => (n ? fmtBytes(n) + "/s" : "—");
function fmtEta(s) {
  if (s == null || !isFinite(s)) return "∞";
  s = Math.round(s);
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m " + (s % 60) + "s";
  return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m";
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------------------------------------------------------------- API
async function api(path, body) {
  const r = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

// ---------------------------------------------------------------- Matrix digital rain
// Canvas glyph rain behind the Matrix skin. Runs only while that skin is active and the
// window is visible; draws a single still frame when Reduce Motion is on.
const Rain = (() => {
  const GLYPHS = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜ0123456789ABCDEF<>/=+*:";
  const FS = 16;
  let cv, ctx, drops = [], timer = null, w = 0, h = 0;
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  function size() {
    if (!cv) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    w = innerWidth; h = innerHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cols = Math.ceil(w / FS);
    drops = Array.from({ length: cols }, (_, i) => drops[i] ?? Math.floor(Math.random() * -h / FS));
  }
  function frame() {
    ctx.fillStyle = "rgba(1, 6, 4, 0.14)";
    ctx.fillRect(0, 0, w, h);
    ctx.font = FS + "px 'Share Tech Mono', ui-monospace, monospace";
    for (let i = 0; i < drops.length; i++) {
      const y = drops[i] * FS;
      if (y > 0) {
        const r = Math.random();
        ctx.fillStyle = r < 0.02 ? "#ff2bd6" : r < 0.05 ? "#00f0ff" : r < 0.12 ? "#d8ffe8" : "#19ff8c";
        ctx.fillText(GLYPHS[(Math.random() * GLYPHS.length) | 0], i * FS, y);
      }
      if (y > h && Math.random() > 0.975) drops[i] = Math.floor(Math.random() * -20);
      drops[i]++;
    }
  }
  function start() {
    if (!cv) { cv = document.querySelector(".scene-rain"); if (!cv) return; ctx = cv.getContext("2d"); size(); addEventListener("resize", size); }
    if (timer) return;
    if (reduced()) { for (let k = 0; k < 40; k++) frame(); return; }
    timer = setInterval(frame, 55);
  }
  function stop() {
    clearInterval(timer); timer = null;
    if (ctx) ctx.clearRect(0, 0, w, h);
  }
  function sync() {
    const on = document.documentElement.dataset.skin === "matrix" && !document.hidden;
    on ? start() : stop();
  }
  document.addEventListener("visibilitychange", sync);
  return { sync };
})();

// ---------------------------------------------------------------- player
// Plays completed tracks in transfer-list order: play, pause, previous, next.
// Auto-play (toggle, remembered) moves on to the next track when one ends.
const Player = (() => {
  const a = new Audio();
  a.preload = "auto";
  let cur = null;      // job id
  let lastIdx = -1;    // position in the playlist, kept in case the current row is removed
  let seeking = false;
  let auto = store.get("cs999.autoplay") !== "0";
  const list = () => {
    const vis = visibleJobs().filter((j) => j.status === "done" && j.final_path);
    return vis.length ? vis : sortJobs(state.jobs.filter((j) => j.status === "done" && j.final_path));
  };
  const fmt = (t) => { if (!isFinite(t)) return "0:00"; t = Math.floor(t); return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0"); };
  // Files are saved as "Uploader - Title [id].ext": the uploader is the part before the first " - ".
  function who(j) {
    const base = (j.final_path || "").split("/").pop().replace(/\.[^.]+$/, "").replace(/\s*\[[^\]]+\]$/, "");
    const i = base.indexOf(" - ");
    return i > 0 ? base.slice(0, i) : "";
  }
  function setArt(j) {
    const img = $("#artImg");
    if (!j) { img.hidden = true; img.removeAttribute("src"); return; }
    img.hidden = true;
    img.onload = () => { img.hidden = false; };
    img.onerror = () => { img.hidden = true; };
    img.src = "/api/art/" + encodeURIComponent(j.id);
  }
  function meta(j) {
    if (!("mediaSession" in navigator) || !window.MediaMetadata) return;
    navigator.mediaSession.metadata = j ? new MediaMetadata({
      title: j.title, artist: who(j), album: "cloudsound_999",
      artwork: [{ src: "/api/art/" + encodeURIComponent(j.id), sizes: "300x300", type: "image/jpeg" }],
    }) : null;
  }
  function load(j) {
    cur = j.id; lastIdx = list().findIndex((x) => x.id === j.id);
    a.src = "/api/audio/" + encodeURIComponent(j.id);
    setArt(j); meta(j);
    Scope.attach(a);
    a.play().catch((e) => { if (e.name !== "AbortError") toast("Can't play: " + e.message); });
    ui();
  }
  function play(id) {
    const l = list();
    if (id) { const j = l.find((x) => x.id === id); if (j) return load(j); }
    if (cur && a.src && a.paused) { Scope.attach(a); a.play().catch(() => {}); return; }
    if (cur && !a.paused) return;
    if (!l.length) { toast("No completed tracks to play yet."); return; }
    load(l.find((j) => selected.has(j.id)) || l[0]);
  }
  function pause() { a.pause(); }
  function toggle() { a.paused ? play() : pause(); }
  function step(d) {
    const l = list(); if (!l.length) return;
    let i = l.findIndex((x) => x.id === cur);
    if (i < 0) i = d > 0 ? lastIdx - 1 : lastIdx;  // current row gone: continue from where it was
    const n = i + d;
    if (n >= l.length) { stop(); return; }
    load(l[Math.max(0, n)]);
  }
  function prev() { if (a.currentTime > 3) { a.currentTime = 0; return; } step(-1); }
  function next() { step(1); }
  function stop() { a.pause(); a.removeAttribute("src"); a.load(); cur = null; setArt(null); meta(null); ui(); }
  function setAuto(v) { auto = v; store.set("cs999.autoplay", v ? "1" : "0"); ui(); }
  function ui() {
    const j = state.jobs.find((x) => x.id === cur);
    const playing = !!cur && !a.paused;
    $("#npTitle").textContent = cur ? (j ? j.title : "—") : "Nothing playing";
    $("#npTitle").title = $("#npTitle").textContent;
    $("#npSub").textContent = cur ? (j ? who(j) || "Unknown artist" : "Removed from the list") : `Finished downloads play here · auto-play ${auto ? "on" : "off"}`;
    document.querySelector('[data-pl="play"]').classList.toggle("on", playing);
    document.querySelector('[data-pl="pause"]').classList.toggle("on", !!cur && a.paused);
    const ab = document.querySelector('[data-pl="auto"]');
    ab.setAttribute("aria-pressed", String(auto));
    ab.title = auto ? "Auto-play is on: the next track starts when one ends" : "Auto-play is off: playback stops after each track";
    document.documentElement.classList.toggle("is-playing", playing);
    $("#npSeek").disabled = !cur;
    time();
    document.querySelectorAll("#rows tr").forEach((tr) => tr.classList.toggle("playing", tr.dataset.id === cur));
  }
  function time() {
    $("#npCur").textContent = fmt(a.currentTime);
    $("#npDur").textContent = fmt(a.duration);
    if (!seeking) $("#npSeek").value = a.duration ? Math.round((a.currentTime / a.duration) * 1000) : 0;
  }
  a.addEventListener("timeupdate", time);
  a.addEventListener("loadedmetadata", time);
  a.addEventListener("play", () => { ui(); Scope.run(); });
  a.addEventListener("pause", () => { ui(); Scope.idle(); });
  a.addEventListener("ended", () => {
    if (auto) next(); else { a.currentTime = 0; ui(); }
  });
  a.addEventListener("error", () => {
    if (!cur || !a.getAttribute("src")) return;
    toast("Couldn't play “" + ((state.jobs.find((x) => x.id === cur) || {}).title || "track") + "”." + (auto ? " Skipping." : ""));
    if (auto) next(); else stop();
  });
  function wire() {
    document.querySelectorAll("[data-pl]").forEach((b) => b.addEventListener("click", () =>
      ({ play: () => play(), pause, prev, next, auto: () => setAuto(!auto) })[b.dataset.pl]()));
    const sk = $("#npSeek");
    sk.addEventListener("input", () => { seeking = true; if (a.duration) $("#npCur").textContent = fmt(sk.value / 1000 * a.duration); });
    sk.addEventListener("change", () => { if (a.duration) a.currentTime = sk.value / 1000 * a.duration; seeking = false; });
    if ("mediaSession" in navigator) {
      const ms = navigator.mediaSession;
      [["play", () => play()], ["pause", pause], ["previoustrack", prev], ["nexttrack", next]].forEach(([k, f]) => { try { ms.setActionHandler(k, f); } catch {} });
    }
    ui();
  }
  return { play, pause, toggle, prev, next, ui, wire, get current() { return cur; } };
})();

// ---------------------------------------------------------------- oscilloscope
// Web Audio analyser on the player. Its look comes from the skin's --scope-* CSS tokens:
// colours, glow, line width, phosphor trail, a flame fill, a print-offset ghost line, pixel steps.
const Scope = (() => {
  let ctx, an, src, buf, cv, g, raf = 0, st = {}, w = 0, h = 0;
  const num = (v, d) => { const n = parseFloat(v); return isFinite(n) ? n : d; };
  function readStyle() {
    const cs = getComputedStyle(document.documentElement);
    const v = (k) => cs.getPropertyValue("--scope-" + k).trim();
    st = {
      bg: v("bg") || "#000", line: v("line") || "#fff", line2: v("line2"), offset: num(v("offset"), 0),
      glow: num(v("glow"), 0), glowColor: v("glow-color"), width: num(v("width"), 1.5), grid: v("grid"),
      trail: num(v("trail"), 1), fill: v("fill"), pixel: num(v("pixel"), 0), center: v("center"), double: num(v("double"), 0),
    };
    if (!/^(#|rgb|hsl)/.test(st.bg)) st.bg = "#000";
  }
  function size() {
    if (!cv) return;
    const r = cv.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
    w = Math.max(1, r.width); h = Math.max(1, r.height);
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!raf) draw(true);
  }
  function init() {
    if (cv) return;
    cv = $("#scope"); g = cv.getContext("2d");
    readStyle();
    new ResizeObserver(size).observe(cv);
    size();
  }
  function attach(audio) {
    init();
    try {
      if (!ctx) {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        an = ctx.createAnalyser(); an.fftSize = 2048; an.smoothingTimeConstant = 0.6;
        src = ctx.createMediaElementSource(audio);
        src.connect(an); an.connect(ctx.destination);
        buf = new Float32Array(an.fftSize);
      }
      if (ctx.state === "suspended") ctx.resume();
    } catch (e) { an = null; } // no Web Audio: the scope just stays idle, playback is unaffected
  }
  function trace(data, color, dy, lw) {
    const n = data.length, step = w / (n - 1), mid = h / 2, amp = h * 0.42, px = st.pixel;
    g.beginPath();
    for (let i = 0; i < n; i++) {
      let x = i * step, y = mid + dy - data[i] * amp;
      if (px) { x = Math.round(x / px) * px; y = Math.round(y / px) * px; }
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.strokeStyle = color; g.lineWidth = lw; g.lineJoin = "round"; g.lineCap = "round";
    g.stroke();
  }
  function grid() {
    if (st.grid && st.grid !== "none") {
      g.strokeStyle = st.grid; g.lineWidth = 1; g.beginPath();
      for (let i = 1; i < 8; i++) { const x = Math.round(w * i / 8) + .5; g.moveTo(x, 0); g.lineTo(x, h); }
      for (let i = 1; i < 4; i++) { const y = Math.round(h * i / 4) + .5; g.moveTo(0, y); g.lineTo(w, y); }
      g.stroke();
    }
    if (st.center) {
      g.strokeStyle = st.center; g.lineWidth = 1; g.beginPath();
      const m = Math.round(h / 2) + .5;
      if (st.double) { g.moveTo(0, m - 2); g.lineTo(w, m - 2); g.moveTo(0, m + 2); g.lineTo(w, m + 2); }
      else { g.moveTo(0, m); g.lineTo(w, m); }
      g.stroke();
    }
  }
  const IDLE = new Float32Array(256);
  function draw(still) {
    if (!g) return;
    const live = !still && an;
    let data = IDLE;
    if (live) { an.getFloatTimeDomainData(buf); data = buf; }
    else { const t = performance.now() / 900; for (let i = 0; i < IDLE.length; i++) IDLE[i] = 0.015 * Math.sin(i / 9 + t); }
    // background, with a phosphor-style trail when --scope-trail < 1
    g.save(); g.shadowBlur = 0;
    g.globalAlpha = live ? Math.min(1, st.trail) : 1;
    g.fillStyle = st.bg; g.fillRect(0, 0, w, h);
    g.globalAlpha = 1;
    grid();
    // decimate to ~1 point per css px
    const stepN = Math.max(1, Math.floor(data.length / w));
    const pts = stepN > 1 ? Float32Array.from({ length: Math.floor(data.length / stepN) }, (_, i) => data[i * stepN]) : data;
    if (st.fill && st.fill !== "none") {
      const n = pts.length, mid = h / 2, amp = h * 0.42;
      const grad = g.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, st.line); grad.addColorStop(.5, st.fill); grad.addColorStop(1, "rgba(255,30,0,0)");
      g.beginPath(); g.moveTo(0, h);
      for (let i = 0; i < n; i++) g.lineTo(i * w / (n - 1), mid - pts[i] * amp);
      g.lineTo(w, h); g.closePath(); g.globalAlpha = .45; g.fillStyle = grad; g.fill(); g.globalAlpha = 1;
    }
    if (st.line2 && st.line2 !== "none") trace(pts, st.line2, st.offset, st.width);
    if (st.glow) { g.shadowBlur = st.glow; g.shadowColor = st.glowColor || st.line; }
    trace(pts, st.line, 0, st.width);
    g.restore();
  }
  function loop() { draw(false); raf = requestAnimationFrame(loop); }
  function run() { init(); if (!raf && !document.hidden) loop(); }
  function idle() { cancelAnimationFrame(raf); raf = 0; draw(true); }
  function restyle() { if (!cv) init(); readStyle(); if (!raf) draw(true); }
  document.addEventListener("visibilitychange", () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else if (src && !src.mediaElement.paused) run(); });
  return { attach, run, idle, restyle };
})();

// ---------------------------------------------------------------- drag & drop links
// Drop links (or text containing them) anywhere on the window to queue them.
function extractUrls(text) {
  return [...new Set((String(text || "").match(/https?:\/\/[^\s<>"']+/g) || []).map((u) => u.replace(/[),.;]+$/, "")))];
}
async function addUrls(urls) {
  if (!urls.length) { toast("No links found in what was dropped."); return; }
  try {
    const r = await api("/api/add", { urls });
    toast(r.added ? `Added ${r.added} link${r.added === 1 ? "" : "s"} to the queue.` : "Nothing new to add.");
  } catch (e) { toast(e.message); }
}
window.__cs999AddUrls = (urls) => addUrls(urls || []);
function wireDrop() {
  const dz = $("#dropZone");
  let depth = 0;
  const hasLink = (e) => [...(e.dataTransfer?.types || [])].some((t) => /uri-list|text\/plain|url/i.test(t));
  addEventListener("dragenter", (e) => { if (!hasLink(e)) return; e.preventDefault(); depth++; dz.hidden = false; });
  addEventListener("dragover", (e) => { if (!hasLink(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
  addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; dz.hidden = true; } });
  addEventListener("drop", (e) => {
    e.preventDefault(); depth = 0; dz.hidden = true;
    if (e.target.closest && e.target.closest("input, textarea") && e.target.id !== "urlInput") return;
    const dt = e.dataTransfer;
    addUrls(extractUrls([dt.getData("text/uri-list"), dt.getData("text/plain"), dt.getData("URL")].join("\n")));
  });
}

// ---------------------------------------------------------------- skins
function applySkin(id) {
  id = LEGACY_SKINS[id] || id;
  if (!SKINS.some(([k]) => k === id)) id = "matrix";
  document.documentElement.dataset.skin = id;
  store.set("cs999.skin", id);
  toNative({ type: "skin", skin: id });
  Rain.sync();
  requestAnimationFrame(() => Scope.restyle());
  document.querySelectorAll("#skinList .menu-item").forEach((b) =>
    b.setAttribute("aria-checked", b.dataset.skin === id ? "true" : "false"));
}
function buildSkinMenu() {
  $("#skinList").innerHTML = SKINS.map(([id, name]) =>
    `<button class="menu-item skin-item" role="menuitemradio" data-skin="${id}"><span class="swatch sw-${id}"></span>${name}</button>`).join("");
  applySkin(document.documentElement.dataset.skin);
}

// ---------------------------------------------------------------- rendering
function visibleJobs() {
  const f = FILTERS.find(([k]) => k === filter)[2];
  return sortJobs(state.jobs.filter((j) => f(j) && matches(j, query)));
}
const fmtBpm = (b) => (b == null ? "" : Number.isInteger(b) ? String(b) : b.toFixed(1));

function renderOrg(jobs) {
  const tbody = $("#orgRows");
  const existing = new Map([...tbody.children].map((tr) => [tr.dataset.id, tr]));
  jobs.forEach((j, i) => {
    let tr = existing.get(j.id);
    if (!tr) {
      tr = document.createElement("tr");
      tr.dataset.id = j.id;
      tr.innerHTML = `<td class="o-num"></td><td class="o-title"><button class="ic o-play" data-org="play" title="Play">▶&#xFE0E;</button><span class="nm"></span></td>
        <td class="o-artist"></td>
        <td class="o-bpm"><span class="bpm-v" title="Double-click to type a BPM"></span><span class="bpm-x"><button class="ic" data-org="half" title="Halve BPM">½</button><button class="ic" data-org="double" title="Double BPM">×2</button></span></td>
        <td class="o-key"><span class="cam"></span><span class="key-name"></span></td>
        <td class="o-act"><button class="ic" data-org="reanalyze" title="Analyse again">↻</button></td>`;
    }
    existing.delete(j.id);
    if (tbody.children[i] !== tr) tbody.insertBefore(tr, tbody.children[i] || null);
    const set = (q, v, prop = "textContent") => { const el = tr.querySelector(q); if (el[prop] !== v) el[prop] = v; };
    tr.className = selected.has(j.id) ? "sel" : "";
    tr.classList.toggle("playing", Player.current === j.id);
    set(".o-num", String(i + 1));
    set(".nm", j.title);
    tr.querySelector(".o-title").title = j.title;
    set(".o-artist", j.artist || "—");
    const pending = !j.analysis;
    const bv = j.bpm != null ? fmtBpm(j.bpm) : pending ? "…" : "—";
    set(".bpm-v", bv);
    const bEl = tr.querySelector(".bpm-v");
    const bsrc = j.bpm_manual ? "manual" : j.bpm_src || "";
    bEl.classList.toggle("manual", bsrc === "manual");
    bEl.classList.toggle("tag", bsrc === "tag");
    bEl.classList.toggle("unsure", bsrc === "auto" && j.bpm_conf === "low");
    bEl.title = bsrc === "tag" ? "From the file's tags (written by a DJ tool)"
      : bsrc === "manual" ? "Set by hand · double-click to change"
      : j.bpm_conf === "low" ? `Uncertain: the two tempo detectors disagreed (raw ${j.bpm_raw ?? "?"}) · double-click to type a BPM`
      : j.bpm_raw && j.bpm_raw !== j.bpm ? `Detected ${j.bpm_raw}, fitted to your BPM range · double-click to change` : "Double-click to type a BPM";
    set(".cam", j.camelot || (pending ? "…" : "—"));
    const cam = /^(\d+)([AB])$/.exec(j.camelot || "");
    tr.querySelector(".cam").style.setProperty("--h", cam ? ((+cam[1] - 1) * 30 + 0) : "");
    tr.querySelector(".cam").classList.toggle("none", !cam);
    tr.querySelector(".cam").classList.toggle("major", !!cam && cam[2] === "B");
    set(".key-name", j.key || (pending ? "analysing" : ""));
    const kc = tr.querySelector(".o-key");
    kc.classList.toggle("tag", j.key_src === "tag");
    kc.classList.toggle("unsure", j.key_src !== "tag" && j.key_conf === "low");
    kc.title = j.key_src === "tag" ? "From the file's tags (written by a DJ tool)"
      : j.key_conf === "high" ? "All three key profiles agree"
      : j.key_conf === "ok" ? "Two of three key profiles agree"
      : j.key_conf === "low" ? "Uncertain: the key profiles disagreed" : "";
  });
  existing.forEach((tr) => tr.remove());
}

function render() {
  const jobs = visibleJobs();
  const ids = new Set(state.jobs.map((j) => j.id));
  for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);

  $("#filterList").innerHTML = FILTERS.map(([k, label, fn]) =>
    `<li><button data-filter="${k}" class="${k === filter ? "on" : ""}">${label}<span class="count">${state.jobs.filter(fn).length}</span></button></li>`).join("");

  const org = filter === "organize";
  $("#grid").hidden = org;
  $("#orgGrid").hidden = !org;
  document.querySelectorAll(".listscroll th.sortable").forEach((th) =>
    th.setAttribute("aria-sort", th.dataset.sort === sort.by ? (sort.dir > 0 ? "ascending" : "descending") : "none"));
  if (org) renderOrg(jobs);
  else {
  // Patch rows in place (no innerHTML rebuild) so clicks aren't lost mid-update.
  const tbody = $("#rows");
  const existing = new Map([...tbody.children].map((tr) => [tr.dataset.id, tr]));
  jobs.forEach((j, i) => {
    let tr = existing.get(j.id);
    if (!tr) {
      tr = document.createElement("tr");
      tr.dataset.id = j.id;
      tr.innerHTML = `<td class="c-sel"><input type="checkbox" aria-label="Select"></td><td class="c-num"></td>
        <td class="c-name"><span class="nm"></span><span class="err"></span></td><td class="c-size"></td>
        <td class="c-prog"><div class="bar"><div class="fill"></div><span class="pct"></span></div></td>
        <td class="c-status"><span class="dot"></span><span class="lbl"></span></td><td class="c-speed"></td><td class="c-eta"></td><td class="c-act"></td>`;
    }
    existing.delete(j.id);
    if (tbody.children[i] !== tr) tbody.insertBefore(tr, tbody.children[i] || null);
    const pct = j.status === "done" ? 100 : (j.progress || 0);
    const active = j.status === "downloading" || j.status === "processing";
    const sel = selected.has(j.id);
    const set = (q, v, prop = "textContent") => { const el = tr.querySelector(q); if (el[prop] !== v) el[prop] = v; };
    tr.className = `st-${j.status}${sel ? " sel" : ""}`;
    tr.querySelector(".c-sel input").checked = sel;
    set(".c-num", String(i + 1));
    set(".nm", j.title_guess ? decodeURIComponent(j.url.split("?")[0].replace(/\/+$/, "").split("/").pop()) : j.title);
    set(".err", j.status === "error" ? (j.error || "") : "");
    tr.querySelector(".c-name").title = j.status === "error" && j.error ? `${j.title}\n${j.error}` : j.title;
    set(".c-size", fmtBytes(j.size));
    tr.querySelector(".bar").classList.toggle("live", active);
    tr.querySelector(".fill").style.setProperty("--p", (pct / 100).toFixed(4));
    set(".pct", pct.toFixed(1) + "%");
    set(".lbl", STATUS_LABEL[j.status] || j.status);
    set(".c-speed", j.status === "downloading" ? fmtSpeed(j.speed) : "—");
    set(".c-eta", j.status === "downloading" ? fmtEta(j.eta) : j.status === "done" ? "done" : "—");
    const canResume = j.status === "paused" || j.status === "error";
    const canPause = active || j.status === "queued";
    set(".c-act",
      (j.status === "done" ? `<button class="ic" data-row="play" title="Play">▶&#xFE0E;</button>` : "") +
      (canResume ? `<button class="ic" data-row="resume" title="Resume download">⇣</button>` : "") +
      (canPause ? `<button class="ic" data-row="pause" title="Pause download">‖</button>` : "") +
      `<button class="ic" data-row="remove" title="Remove">✕</button>`, "innerHTML");
  });
  existing.forEach((tr) => tr.remove());
  }
  Player.ui();

  $("#empty").hidden = jobs.length > 0;
  $("#empty p").textContent = query ? `No tracks match “${query}”.`
    : org ? "No finished tracks yet." : state.jobs.length ? "Nothing in this view." : "The queue is empty.";
  const an = state.analyzer, todo = state.jobs.filter((j) => j.status === "done" && !j.analysis).length;
  $("#sbAnalyzer").textContent = { installing: "BPM/key: installing analyser…", unavailable: "BPM/key: unavailable", checking: "" }[an]
    ?? (todo ? `BPM/key: analysing ${todo}…` : `BPM/key: ${an === "essentia" ? "Essentia" : "basic"}`);
  const all = $("#selAll");
  all.checked = jobs.length > 0 && jobs.every((j) => selected.has(j.id));
  all.indeterminate = !all.checked && jobs.some((j) => selected.has(j.id));

  const s = state.settings || {};
  $("#sbFolder").textContent = "⌂ " + (s.output_dir || "");
  $("#sbConf").textContent = `${s.concurrency ?? "?"} at once · ${s.audio_format || "original"}${s.rate_limit_kb ? ` · ≤${s.rate_limit_kb} KB/s` : ""}`;
  $("#sbSpeed").textContent = "↓ " + fmtSpeed(state.totals?.speed || 0);
  document.documentElement.classList.toggle("is-active", (state.totals?.active || 0) > 0);
  const act = state.totals?.active || 0;
  if (act !== lastActive) { lastActive = act; toNative({ type: "status", active: act }); }

  const n = $("#notice");
  n.hidden = !state.notice;
  if (state.notice) n.innerHTML = `${esc(state.notice)} <button class="btn small" id="dismissNotice">Dismiss</button>`;
}

function renderHealth() {
  const t = health.tools;
  $("#sbTools").textContent = `yt-dlp ${t["yt-dlp"].found ? t["yt-dlp"].version : "missing"} · ffmpeg ${t.ffmpeg.found ? "ok" : "missing"}`;
  const missing = Object.entries(t).filter(([, v]) => !v.found).map(([k]) => k);
  const b = $("#depsBanner");
  b.hidden = missing.length === 0;
  if (missing.length) {
    const brew = `brew install ${missing.join(" ")}`;
    b.innerHTML = `<strong>Missing: ${missing.join(", ")}.</strong> ` +
      (missing.includes("yt-dlp") ? "Downloads can't start without yt-dlp. " : "Without ffmpeg, audio can't be converted and cover art can't be embedded. ") +
      `Install with Homebrew: <code>${brew}</code> (or <code>pipx install yt-dlp</code>), then reload this page.`;
  }
}

// ---------------------------------------------------------------- actions
function targetIds() {
  return [...selected];
}
async function cmd(name, ids) {
  ids = ids || targetIds();
  try {
    switch (name) {
      case "resume": if (ids.length) await api("/api/resume", { ids }); break;
      case "pause": if (ids.length) await api("/api/pause", { ids }); break;
      case "resume-all": await api("/api/resume", { ids: state.jobs.map((j) => j.id) }); break;
      case "pause-all": await api("/api/pause", { ids: state.jobs.map((j) => j.id) }); break;
      case "clear": await api("/api/clear-finished", {}); break;
      case "folder": await chooseFolder(); break;
      case "reveal": await api("/api/reveal", { ids }); break;
      case "play": if (ids.length) Player.play(ids[0]); break;
      case "reanalyze": if (ids.length) { await api("/api/reanalyze", { ids }); toast(`Analysing ${ids.length} track${ids.length === 1 ? "" : "s"} again…`); } break;
      case "copy": {
        const j = state.jobs.find((x) => x.id === ids[0]);
        if (j) await navigator.clipboard.writeText(j.url).catch(() => {});
        break;
      }
      case "remove": if (ids.length) await confirmRemove(ids); break;
    }
  } catch (e) { toast(e.message); }
}

function confirmRemove(ids) {
  const dlg = $("#removeDlg");
  const one = state.jobs.find((j) => j.id === ids[0]);
  $("#removeText").textContent = ids.length === 1 && one ? `Remove “${one.title}” from the list?` : `Remove ${ids.length} transfers from the list?`;
  $("#removeFiles").checked = false;
  return new Promise((res) => {
    dlg.onclose = async () => {
      if (dlg.returnValue === "ok") {
        await api("/api/remove", { ids, delete_files: $("#removeFiles").checked });
        ids.forEach((i) => selected.delete(i));
      }
      res();
    };
    dlg.showModal();
  });
}

async function chooseFolder() {
  if (NATIVE) {
    const p = await pickFolderNative();
    if (p) { try { await api("/api/settings", { output_dir: p }); toast("Saving to " + p); } catch (e) { toast(e.message); } }
    return;
  }
  try {
    const r = await api("/api/choose-folder", {});
    if (!r.cancelled) toast("Saving to " + r.output_dir);
  } catch (e) {
    openSettings(); // non-mac: type the path
  }
}

async function openSettings() {
  if (!state.settings || !state.settings.output_dir) {
    try { state = await api("/api/state"); } catch {}
  }
  const s = state.settings || {};
  $("#setFolder").value = s.output_dir || "";
  $("#setConc").value = s.concurrency || 2;
  $("#setFormat").value = s.audio_format || "original";
  $("#setRate").value = s.rate_limit_kb || 0;
  $("#setMeta").checked = !!s.embed_metadata;
  $("#setThumb").checked = !!s.embed_thumbnail;
  $("#setBpmRange").value = s.bpm_range || "78-155";
  const dlg = $("#settingsDlg");
  dlg.onclose = async () => {
    if (dlg.returnValue !== "ok") return;
    try {
      await api("/api/settings", {
        output_dir: $("#setFolder").value,
        concurrency: +$("#setConc").value,
        audio_format: $("#setFormat").value,
        rate_limit_kb: +$("#setRate").value || 0,
        embed_metadata: $("#setMeta").checked,
        embed_thumbnail: $("#setThumb").checked,
        bpm_range: $("#setBpmRange").value,
      });
    } catch (e) { toast(e.message); }
  };
  dlg.showModal();
}

let toastTimer;
function toast(msg) {
  let t = $("#toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; document.body.append(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 3500);
}

// ---------------------------------------------------------------- events
function wire() {
  $("#addForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const urls = $("#urlInput").value.split(/\s+/).filter(Boolean);
    if (!urls.length) return;
    try {
      const r = await api("/api/add", { urls });
      if (r.added) $("#urlInput").value = "";
    } catch (err) { toast(err.message); }
  });

  document.querySelectorAll(".toolbar [data-cmd]").forEach((b) => b.addEventListener("click", () => cmd(b.dataset.cmd)));

  $("#filterList").addEventListener("click", (e) => {
    const b = e.target.closest("[data-filter]");
    if (b) { filter = b.dataset.filter; store.set("cs999.filter", filter); render(); }
  });

  const rows = $("#rows");
  rows.addEventListener("click", (e) => {
    const tr = e.target.closest("tr"); if (!tr) return;
    const id = tr.dataset.id;
    const rb = e.target.closest("[data-row]");
    if (rb) { cmd(rb.dataset.row, [id]); return; }
    if (e.target.matches("input[type=checkbox]")) {
      e.target.checked ? selected.add(id) : selected.delete(id);
    } else if (e.shiftKey && lastClicked) {
      const vis = visibleJobs().map((j) => j.id);
      const [a, b] = [vis.indexOf(lastClicked), vis.indexOf(id)].sort((x, y) => x - y);
      vis.slice(a, b + 1).forEach((x) => selected.add(x));
    } else if (e.metaKey || e.ctrlKey) {
      selected.has(id) ? selected.delete(id) : selected.add(id);
    } else {
      selected.clear(); selected.add(id);
    }
    lastClicked = id;
    render();
  });
  rows.addEventListener("dblclick", (e) => {
    const tr = e.target.closest("tr"); if (!tr || e.target.closest("button,input")) return;
    const j = state.jobs.find((x) => x.id === tr.dataset.id);
    if (!j) return;
    if (j.status === "done") Player.play(j.id);
    else cmd(["paused", "error"].includes(j.status) ? "resume" : "pause", [j.id]);
  });
  rows.addEventListener("contextmenu", (e) => {
    const tr = e.target.closest("tr"); if (!tr) return;
    e.preventDefault();
    if (!selected.has(tr.dataset.id)) { selected.clear(); selected.add(tr.dataset.id); render(); }
    const m = $("#ctx");
    m.hidden = false;
    m.style.left = Math.min(e.clientX, innerWidth - m.offsetWidth - 8) + "px";
    m.style.top = Math.min(e.clientY, innerHeight - m.offsetHeight - 8) + "px";
  });
  $("#ctx").addEventListener("click", (e) => {
    const b = e.target.closest("[data-cmd]"); if (!b) return;
    $("#ctx").hidden = true; cmd(b.dataset.cmd);
  });

  // search box: type to filter, Esc clears; ⌘F focuses it
  const search = $("#search");
  search.addEventListener("input", () => { query = search.value.trim(); render(); });
  search.addEventListener("keydown", (e) => { if (e.key === "Escape") { search.value = ""; query = ""; render(); search.blur(); } });

  // sortable headers: asc → desc → off
  document.querySelectorAll(".listscroll th.sortable").forEach((th) => th.addEventListener("click", () => {
    const by = th.dataset.sort;
    if (sort.by !== by) sort = { by, dir: 1 };
    else if (sort.dir > 0) sort.dir = -1;
    else sort = { by: null, dir: 1 };
    store.set("cs999.sort", JSON.stringify(sort));
    render();
  }));

  // organize view rows
  const org = $("#orgRows");
  org.addEventListener("click", async (e) => {
    const tr = e.target.closest("tr"); if (!tr) return;
    const id = tr.dataset.id, j = state.jobs.find((x) => x.id === id);
    const b = e.target.closest("[data-org]");
    if (b && j) {
      try {
        if (b.dataset.org === "play") Player.play(id);
        if (b.dataset.org === "half" && j.bpm) await api("/api/meta", { id, bpm: j.bpm / 2 });
        if (b.dataset.org === "double" && j.bpm) await api("/api/meta", { id, bpm: j.bpm * 2 });
        if (b.dataset.org === "reanalyze") { await api("/api/meta", { id, reanalyze: true }); toast("Analysing again…"); }
      } catch (err) { toast(err.message); }
      return;
    }
    if (e.metaKey || e.ctrlKey) selected.has(id) ? selected.delete(id) : selected.add(id);
    else { selected.clear(); selected.add(id); }
    render();
  });
  org.addEventListener("dblclick", (e) => {
    const tr = e.target.closest("tr"); if (!tr || e.target.closest("button")) return;
    const v = e.target.closest(".bpm-v");
    if (v) { editBpm(tr.dataset.id, v); return; }
    Player.play(tr.dataset.id);
  });
  org.addEventListener("contextmenu", (e) => {
    const tr = e.target.closest("tr"); if (!tr) return;
    e.preventDefault();
    if (!selected.has(tr.dataset.id)) { selected.clear(); selected.add(tr.dataset.id); render(); }
    const m = $("#ctx");
    m.hidden = false;
    m.style.left = Math.min(e.clientX, innerWidth - m.offsetWidth - 8) + "px";
    m.style.top = Math.min(e.clientY, innerHeight - m.offsetHeight - 8) + "px";
  });

  $("#selAll").addEventListener("change", (e) => {
    visibleJobs().forEach((j) => (e.target.checked ? selected.add(j.id) : selected.delete(j.id)));
    render();
  });

  const menu = $("#menu"), menuBtn = $("#menuBtn");
  const setMenu = (open) => { menu.hidden = !open; menuBtn.setAttribute("aria-expanded", String(open)); };
  menuBtn.addEventListener("click", (e) => { e.stopPropagation(); setMenu(menu.hidden); });
  menu.addEventListener("click", (e) => {
    const s = e.target.closest(".skin-item");
    if (s) { applySkin(s.dataset.skin); setMenu(false); return; }
    const a = e.target.closest("[data-act]");
    if (!a) return;
    setMenu(false);
    if (a.dataset.act === "settings") openSettings();
    if (a.dataset.act === "open-folder") cmd("reveal", []);
    if (a.dataset.act === "about") {
      $("#aboutVersion").textContent = health && health.version ? `Version ${health.version}` : "";
      $("#aboutDlg").showModal();
    }
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#menu, #menuBtn")) setMenu(false);
    if (!e.target.closest("#ctx")) $("#ctx").hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { setMenu(false); $("#ctx").hidden = true; }
    if (document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if ((e.key === "Delete" || e.key === "Backspace") && selected.size) { e.preventDefault(); cmd("remove"); }
    if (e.key === " " && !e.metaKey && !e.ctrlKey && !(document.activeElement && document.activeElement.closest("button, dialog"))) { e.preventDefault(); Player.toggle(); }
    if ((e.metaKey || e.ctrlKey) && e.key === "f") { e.preventDefault(); $("#search").focus(); $("#search").select(); }
    if ((e.metaKey || e.ctrlKey) && e.key === "a") { e.preventDefault(); visibleJobs().forEach((j) => selected.add(j.id)); render(); }
  });

  $("#browseBtn").addEventListener("click", async () => {
    if (NATIVE) { const p = await pickFolderNative(); if (p) $("#setFolder").value = p; return; }
    try {
      const r = await api("/api/choose-folder", {});
      if (!r.cancelled) $("#setFolder").value = r.output_dir;
    } catch (e) { toast(e.message); }
  });
  $("#notice").addEventListener("click", (e) => {
    if (e.target.id === "dismissNotice") api("/api/dismiss-notice", {});
  });
}

// Inline BPM edit: double-click the value, type, Enter saves, Esc cancels.
function editBpm(id, span) {
  const j = state.jobs.find((x) => x.id === id); if (!j) return;
  const inp = document.createElement("input");
  inp.type = "number"; inp.min = 20; inp.max = 400; inp.step = 0.1; inp.className = "bpm-edit";
  inp.value = j.bpm ?? "";
  span.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    inp.replaceWith(span);
    if (save && inp.value && +inp.value !== j.bpm) {
      try { await api("/api/meta", { id, bpm: +inp.value }); } catch (err) { toast(err.message); }
    }
  };
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); e.stopPropagation(); });
  inp.addEventListener("blur", () => finish(true));
}

function connect() {
  const es = new EventSource("/api/events");
  es.onmessage = (e) => { state = JSON.parse(e.data); render(); };
  es.onerror = () => { $("#sbSpeed").textContent = "reconnecting…"; };
}

async function main() {
  filter = store.get("cs999.filter") || "all";
  try { const sv = JSON.parse(store.get("cs999.sort") || "null"); if (sv && sv.by) sort = sv; } catch {}
  if (!FILTERS.some(([k]) => k === filter)) filter = "all";
  buildSkinMenu();
  wire();
  Player.wire();
  wireDrop();
  try { health = await api("/api/health"); renderHealth(); } catch {}
  state = await api("/api/state");
  // optional link parameters: ?skin=noir&view=organize&play=1
  const qp = new URLSearchParams(location.search);
  if (qp.get("skin")) applySkin(qp.get("skin"));
  if (FILTERS.some(([k]) => k === qp.get("view"))) filter = qp.get("view");
  render();
  connect();
  if (qp.get("play")) Player.play();
}
main();
