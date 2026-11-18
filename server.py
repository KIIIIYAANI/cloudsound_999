"""cloudsound_999 — local SoundCloud audio acquisition console.

FastAPI backend. Each download runs the `yt-dlp` CLI in its own process group
(so pause = SIGSTOP the whole group, including any ffmpeg child; resume =
SIGCONT, or a fresh `yt-dlp --continue` run if the app was restarted).
Progress is parsed from a machine-readable --progress-template line and pushed
to the browser over Server-Sent Events.
"""
from __future__ import annotations

import asyncio
import glob
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

IS_WIN = os.name == "nt"
FROZEN = bool(getattr(sys, "frozen", False))  # the packaged Windows app (PyInstaller)
# Windows: keep helper processes (yt-dlp, ffmpeg) from flashing console windows.
NO_WINDOW = {"creationflags": 0x08000000} if IS_WIN else {}  # CREATE_NO_WINDOW
TEXT_IO = {"text": True, "encoding": "utf-8", "errors": "replace"}

APP_DIR = Path(getattr(sys, "_MEIPASS", None) or Path(__file__).resolve().parent)
# The Mac app sets CS999_DATA_DIR (~/Library/Application Support/cloudsound_999) so the
# code can live read-only inside the .app bundle; ./run.sh from the folder keeps .state/ here.
DATA_DIR = Path(os.environ.get("CS999_DATA_DIR") or APP_DIR)
STATE_DIR = DATA_DIR / ".state"
APP_VERSION = (APP_DIR / "VERSION").read_text().strip() if (APP_DIR / "VERSION").exists() else "dev"
STATE_DIR.mkdir(parents=True, exist_ok=True)
SETTINGS_FILE = STATE_DIR / "settings.json"
JOBS_FILE = STATE_DIR / "jobs.json"

# CS999_TEST_HOSTS lets the automated build test download from a local test server.
TEST_HOSTS = {h.strip() for h in os.environ.get("CS999_TEST_HOSTS", "").split(",") if h.strip()}
AUDIO_FORMATS = ["original", "mp3", "m4a", "opus", "flac", "wav"]
DEFAULT_SETTINGS = {
    "output_dir": str(Path.home() / "Music" / "cloudsound_999"),
    "concurrency": 2,
    "audio_format": "original",
    "embed_thumbnail": True,
    "embed_metadata": True,
    "rate_limit_kb": 0,  # per-download cap in KB/s; 0 = unlimited
    "bpm_range": "78-155",  # detected tempos are doubled/halved into this range (like DJ software)
}
BPM_RANGES = ["70-140", "78-155", "88-175", "100-200", "off"]
ANALYSIS_VERSION = 2


def fold_bpm(bpm, rng: str):
    if not bpm:
        return bpm
    if rng == "off":
        return round(bpm, 1)
    lo, hi = (float(x) for x in rng.split("-"))
    while bpm < lo:
        bpm *= 2
    while bpm > hi:
        bpm /= 2
    return round(bpm, 1)

PROG_PREFIX = "CSPROG\t"
DONE_PREFIX = "CSDONE "
PROGRESS_TEMPLATE = PROG_PREFIX + "\t".join(
    "%(progress." + k + ")s"
    for k in ("downloaded_bytes", "total_bytes", "total_bytes_estimate", "speed", "eta", "status")
) + "\t%(info.title)s"

ACTIVE = {"downloading", "processing"}
POSTPROCESSORS = {"ExtractAudio", "Metadata", "EmbedThumbnail", "ThumbnailsConvertor", "FixupM4a", "Merger"}
FINAL = {"done", "error"}


# ---------------------------------------------------------------- utilities
def which(name: str) -> Optional[str]:
    # tools shipped next to the Windows app come first
    bundled = os.environ.get("CS999_TOOLS_DIR")
    if bundled:
        p = Path(bundled) / (name + (".exe" if IS_WIN else ""))
        if p.exists():
            return str(p)
    found = shutil.which(name)
    if found:
        return found
    for prefix in ("/opt/homebrew/bin", "/usr/local/bin"):
        p = Path(prefix) / name
        if p.exists():
            return str(p)
    return None


def tool_status() -> dict:
    out = {}
    for name, args in (("yt-dlp", ["--version"]), ("ffmpeg", ["-version"])):
        path = which(name)
        version = None
        if path:
            try:
                r = subprocess.run([path, *args], capture_output=True, timeout=10,
                                   stdin=subprocess.DEVNULL, **TEXT_IO, **NO_WINDOW)
                version = (r.stdout.strip().splitlines() or [""])[0]
            except Exception:
                version = "unknown"
        out[name] = {"found": bool(path), "path": path, "version": version}
    return out


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def atomic_write(path: Path, data) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(path)


def num(s: str) -> Optional[float]:
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def proc_tree(pid: int):
    """Windows: a process and all its children (yt-dlp plus its ffmpeg), via psutil."""
    import psutil
    p = psutil.Process(pid)
    return [p, *p.children(recursive=True)]


def signal_tree(pid: int, action: str) -> None:
    """stop / cont / term / kill a download's whole process tree (yt-dlp and any ffmpeg child)."""
    if not IS_WIN:
        sig = {"stop": signal.SIGSTOP, "cont": signal.SIGCONT, "term": signal.SIGTERM, "kill": signal.SIGKILL}[action]
        os.killpg(pid, sig)
        return
    import psutil
    try:
        procs = proc_tree(pid)
    except psutil.Error:
        return
    for p in procs:
        try:
            {"stop": p.suspend, "cont": p.resume, "term": p.kill, "kill": p.kill}[action]()
        except psutil.Error:
            pass


def reap_orphan(pid: int, url: str) -> None:
    """Kill a yt-dlp process group left behind by a previous (hard-killed) run."""
    if IS_WIN:
        try:
            import psutil
            if any("yt-dlp" in a for a in psutil.Process(pid).cmdline()) and url in " ".join(psutil.Process(pid).cmdline()):
                signal_tree(pid, "kill")
        except Exception:  # noqa: BLE001
            pass
        return
    try:
        r = subprocess.run(["ps", "-o", "command=", "-p", str(pid)], capture_output=True, text=True)
        if "yt-dlp" in r.stdout and url in r.stdout:
            os.killpg(pid, signal.SIGCONT)
            os.killpg(pid, signal.SIGKILL)
    except (OSError, ProcessLookupError):
        pass


# ---------------------------------------------------------------- job model
class Job:
    FIELDS = ("id", "url", "title", "title_guess", "status", "progress", "downloaded", "size",
              "speed", "eta", "error", "files", "final_path", "added", "output_dir", "pid",
              "artist", "bpm", "key", "camelot", "analysis", "bpm_manual",
              "bpm_raw", "bpm_conf", "bpm_src", "key_conf", "key_src", "analysis_v")

    def __init__(self, url: str, title: str = "", output_dir: str = ""):
        self.id = uuid.uuid4().hex[:10]
        self.url = url
        self.title = title or url
        self.title_guess = not title  # replaced by the real title once yt-dlp reports it
        self.status = "queued"  # queued|downloading|processing|paused|done|error
        self.progress = 0.0
        self.downloaded = 0
        self.size = None
        self.speed = None
        self.eta = None
        self.error = None
        self.files: list[str] = []  # every path yt-dlp told us it wrote
        self.final_path = None
        self.added = time.time()
        self.output_dir = output_dir
        self.pid = None  # last yt-dlp pid, so a hard-killed server can reap it next start
        self.artist = ""        # uploader, from the "Uploader - Title [id].ext" file name
        self.bpm = None         # tempo, from analyze.py (or set by hand)
        self.key = ""           # e.g. "F minor"
        self.camelot = ""       # e.g. "4A"
        self.analysis = ""      # "" (not yet) | "done" | "failed"
        self.bpm_manual = False
        self.bpm_raw = None     # detector output before folding into the BPM range
        self.bpm_conf = ""      # high | ok | low (two tempo estimators disagree)
        self.bpm_src = ""       # auto | tag | manual
        self.key_conf = ""      # high (3 key profiles agree) | ok (2) | low (none)
        self.key_src = ""       # auto | tag
        self.analysis_v = 0     # bumped when the analyser improves, so old results are redone
        self.proc: Optional[subprocess.Popen] = None
        self.stopping = False  # set when we kill the process on purpose

    def to_dict(self) -> dict:
        return {k: getattr(self, k) for k in self.FIELDS}

    @classmethod
    def from_dict(cls, d: dict) -> "Job":
        j = cls(d.get("url", ""))
        j.title_guess = False
        for k in cls.FIELDS:
            if k in d:
                setattr(j, k, d[k])
        return j


class Manager:
    def __init__(self):
        self.lock = threading.RLock()
        self.settings = {**DEFAULT_SETTINGS, **load_json(SETTINGS_FILE, {})}
        self.jobs: dict[str, Job] = {}
        self.order: list[str] = []
        self.version = 0
        self.notice: Optional[str] = None
        self.clients = 0                 # open UI connections (/api/events)
        self.last_client = time.time()   # when one last connected or disconnected
        for d in load_json(JOBS_FILE, []):
            j = Job.from_dict(d)
            if j.pid:
                reap_orphan(j.pid, j.url)
                j.pid = None
            if j.status not in FINAL:  # processes died with the last run
                j.status = "paused"
                j.speed = j.eta = None
            self.jobs[j.id] = j
            self.order.append(j.id)
        self._last_save = 0.0
        threading.Thread(target=self._scheduler, daemon=True).start()

    # -- bookkeeping
    def touch(self, save: bool = False):
        with self.lock:
            self.version += 1
            now = time.time()
            if save or now - self._last_save > 2:
                self._last_save = now
                atomic_write(JOBS_FILE, [self.jobs[i].to_dict() for i in self.order])

    def snapshot(self) -> dict:
        with self.lock:
            jobs = [self.jobs[i].to_dict() for i in self.order]
            return {
                "version": self.version,
                "jobs": jobs,
                "settings": self.settings,
                "notice": self.notice,
                "analyzer": getattr(globals().get("analyzer"), "status", "checking"),
                "totals": {
                    "speed": sum(j["speed"] or 0 for j in jobs if j["status"] == "downloading"),
                    "active": sum(1 for j in jobs if j["status"] in ACTIVE),
                },
            }

    def update_settings(self, patch: dict):
        with self.lock:
            if "output_dir" in patch:
                d = os.path.expanduser(str(patch["output_dir"]).strip())
                if not d:
                    raise HTTPException(400, "Output folder can't be empty")
                Path(d).mkdir(parents=True, exist_ok=True)
                self.settings["output_dir"] = str(Path(d).resolve())
            if "concurrency" in patch:
                self.settings["concurrency"] = max(1, min(8, int(patch["concurrency"])))
            if "audio_format" in patch:
                if patch["audio_format"] not in AUDIO_FORMATS:
                    raise HTTPException(400, "Unknown audio format")
                self.settings["audio_format"] = patch["audio_format"]
            if "rate_limit_kb" in patch:
                self.settings["rate_limit_kb"] = max(0, int(patch["rate_limit_kb"] or 0))
            for k in ("embed_thumbnail", "embed_metadata"):
                if k in patch:
                    self.settings[k] = bool(patch[k])
            if "bpm_range" in patch:
                if patch["bpm_range"] not in BPM_RANGES:
                    raise HTTPException(400, "Unknown BPM range")
                self.settings["bpm_range"] = patch["bpm_range"]
                for j in self.jobs.values():  # re-fold detected tempos; hand-set and tagged ones stay
                    if j.bpm_src == "auto" and j.bpm_raw:
                        j.bpm = fold_bpm(j.bpm_raw, patch["bpm_range"])
            atomic_write(SETTINGS_FILE, self.settings)
            self.touch()

    # -- adding
    def add_urls(self, urls: list[str]) -> int:
        n = 0
        for raw in urls:
            url = raw.strip()
            if not url:
                continue
            if not re.match(r"^https?://", url):
                url = "https://" + url
            host = (urlparse(url).hostname or "").lower()
            if not (host == "soundcloud.com" or host.endswith(".soundcloud.com") or host == "snd.sc"
                    or host in TEST_HOSTS):
                self.notice = f"Skipped non-SoundCloud URL: {raw.strip()}"
                self.touch()
                continue
            threading.Thread(target=self._expand, args=(url,), daemon=True).start()
            n += 1
        return n

    def _expand(self, url: str):
        """Resolve a URL into one job per track (playlists/sets/likes expand)."""
        ytdlp = which("yt-dlp")
        placeholder = Job(url, "Resolving… " + url)
        placeholder.status = "resolving"
        with self.lock:
            self.jobs[placeholder.id] = placeholder
            self.order.append(placeholder.id)
        self.touch()
        entries: list[tuple[str, str]] = []
        err = None
        try:
            r = subprocess.run(
                [ytdlp, "--flat-playlist", "-J", "--no-warnings", *(["--encoding", "utf-8"] if IS_WIN else []), url],
                capture_output=True, timeout=120, stdin=subprocess.DEVNULL, **TEXT_IO, **NO_WINDOW,
            )
            if r.returncode != 0:
                err = (r.stderr.strip().splitlines() or ["yt-dlp failed"])[-1]
            else:
                info = json.loads(r.stdout)
                if info.get("_type") == "playlist":
                    for e in info.get("entries") or []:
                        u = e.get("webpage_url") or e.get("url")
                        if u:
                            entries.append((u, e.get("title") or ""))
                else:
                    entries.append((info.get("webpage_url") or url, info.get("title") or ""))
        except Exception as e:  # noqa: BLE001
            err = str(e)
        with self.lock:
            if placeholder.id not in self.order:  # user removed it while resolving
                return
            idx = self.order.index(placeholder.id)
            self.order.pop(idx)
            del self.jobs[placeholder.id]
            if err or not entries:
                placeholder.status = "error"
                placeholder.title = url
                placeholder.error = err or "No tracks found at this URL"
                self.jobs[placeholder.id] = placeholder
                self.order.insert(idx, placeholder.id)
            else:
                for k, (u, t) in enumerate(entries):
                    j = Job(u, t, self.settings["output_dir"])
                    self.jobs[j.id] = j
                    self.order.insert(idx + k, j.id)
        self.touch(save=True)

    # -- scheduler
    def _scheduler(self):
        while True:
            time.sleep(0.4)
            with self.lock:
                running = sum(1 for j in self.jobs.values() if j.status in ACTIVE)
                free = self.settings["concurrency"] - running
                if free <= 0:
                    continue
                for jid in self.order:
                    if free <= 0:
                        break
                    j = self.jobs[jid]
                    if j.status == "queued":
                        self._start(j)
                        free -= 1

    def _command(self, j: Job) -> list[str]:
        s = self.settings
        out_dir = j.output_dir or s["output_dir"]
        Path(out_dir).mkdir(parents=True, exist_ok=True)
        cmd = [
            which("yt-dlp"), "--newline", "--no-playlist", "--continue", "--no-overwrites",
            "--progress-template", PROGRESS_TEMPLATE,
            "-f", "bestaudio/best", "-x",
            "--audio-format", "best" if s["audio_format"] == "original" else s["audio_format"],
            "--audio-quality", "0",
            "-o", os.path.join(out_dir, "%(uploader)s - %(title)s [%(id)s].%(ext)s"),
            "--exec", "after_move:echo CSDONE {}",
        ]
        if IS_WIN:
            cmd += ["--encoding", "utf-8"]
        if s.get("rate_limit_kb"):
            cmd += ["--limit-rate", f"{int(s['rate_limit_kb'])}K"]
        ff = which("ffmpeg")
        if ff:
            cmd += ["--ffmpeg-location", ff]
            if s["embed_metadata"]:
                cmd += ["--embed-metadata"]
            if s["embed_thumbnail"] and s["audio_format"] not in ("wav", "opus"):
                cmd += ["--embed-thumbnail", "--convert-thumbnails", "jpg"]
        cmd.append(j.url)
        return cmd

    def _start(self, j: Job):
        if not which("yt-dlp"):
            j.status, j.error = "error", "yt-dlp not installed"
            self.touch(save=True)
            return
        j.status, j.error, j.stopping = "downloading", None, False
        env = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8"}
        group = {"creationflags": 0x08000000 | 0x00000200} if IS_WIN else {"start_new_session": True}  # NO_WINDOW | NEW_PROCESS_GROUP
        j.proc = subprocess.Popen(
            self._command(j), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
            bufsize=1, env=env, **TEXT_IO, **group,
        )
        j.pid = j.proc.pid
        threading.Thread(target=self._reader, args=(j, j.proc), daemon=True).start()
        self.touch(save=True)

    def _reader(self, j: Job, proc: subprocess.Popen):
        last_err = None
        for line in proc.stdout:  # type: ignore[union-attr]
            line = line.rstrip("\n")
            with self.lock:
                if line.startswith(PROG_PREFIX):
                    parts = line[len(PROG_PREFIX):].split("\t", 6)
                    if len(parts) == 7:
                        done, total, est, speed, eta, st, title = parts
                        total_b = num(total) or num(est)
                        done_b = num(done)
                        if done_b is not None:
                            j.downloaded = int(done_b)
                        if total_b:
                            j.size = int(total_b)
                            if done_b is not None:
                                j.progress = min(99.9, 100.0 * done_b / total_b)
                        j.speed = num(speed)
                        j.eta = num(eta)
                        if title and title != "NA" and j.title_guess:
                            j.title, j.title_guess = title, False
                        if st == "downloading" and j.status == "processing":
                            j.status = "downloading"  # thumbnail convert runs before the audio download
                        if st == "finished":
                            j.speed, j.eta = None, None
                    self.touch()
                elif line.startswith(DONE_PREFIX):
                    # Windows' echo keeps the quotes yt-dlp puts around paths with spaces
                    j.final_path = line[len(DONE_PREFIX):].strip().strip('"')
                    self._remember(j, j.final_path)
                else:
                    m = re.match(r"^\[(\w+)\] Destination: (.+)$", line)
                    if m:
                        self._remember(j, m.group(2))
                        if m.group(1) in POSTPROCESSORS:
                            j.status, j.speed, j.eta = "processing", None, None
                            self.touch()
                    m = re.match(r"^\[download\] (.+) has already been downloaded", line)
                    if m:
                        self._remember(j, m.group(1))
                    m = re.match(r"^\[(\w+)\]", line)
                    if m and m.group(1) in POSTPROCESSORS and j.status == "downloading":
                        j.status, j.speed, j.eta = "processing", None, None
                        self.touch()
                    if line.startswith("ERROR:"):
                        last_err = line[6:].strip()
        code = proc.wait()
        with self.lock:
            if j.proc is not proc:
                return
            j.proc = None
            j.pid = None
            j.speed = j.eta = None
            if j.stopping:
                pass  # paused/removed by the user; status already set
            elif code == 0:
                j.status, j.progress = "done", 100.0
                if not (j.final_path and os.path.exists(j.final_path)):
                    # the echoed path didn't survive the console code page: use the last file yt-dlp wrote
                    audio = [f for f in j.files if os.path.splitext(f)[1].lower() in AUDIO_TYPES and os.path.isfile(f)]
                    if audio:
                        j.final_path = audio[-1]
                if j.final_path and os.path.exists(j.final_path):
                    j.size = os.path.getsize(j.final_path)
                    j.artist = artist_from_path(j.final_path)
                j.analysis = ""
                if "analyzer" in globals():
                    analyzer.wake.set()
            else:
                j.status = "error"
                j.error = last_err or f"yt-dlp exited with code {code}"
            self.touch(save=True)

    def _remember(self, j: Job, path: str):
        path = path.strip()
        if path and path not in j.files:
            j.files.append(path)

    # -- transfer controls
    def _signal(self, j: Job, action: str):
        if j.proc and j.proc.poll() is None:
            try:
                signal_tree(j.proc.pid, action)
            except ProcessLookupError:
                pass

    def pause(self, ids: list[str]):
        with self.lock:
            for i in ids:
                j = self.jobs.get(i)
                if not j:
                    continue
                if j.status in ACTIVE and j.proc:
                    self._signal(j, "stop")  # suspend in place; resume is instant
                    j.status, j.speed, j.eta = "paused", None, None
                elif j.status == "queued":
                    j.status = "paused"
            self.touch(save=True)

    def resume(self, ids: list[str]):
        with self.lock:
            for i in ids:
                j = self.jobs.get(i)
                if not j or j.status not in ("paused", "error"):
                    continue
                if j.proc and j.proc.poll() is None:
                    self._signal(j, "cont")
                    j.status = "downloading"
                else:
                    # no live process (app restarted, or it errored): requeue;
                    # yt-dlp --continue picks up the .part / fragment files.
                    j.status, j.error = "queued", None
            self.touch(save=True)

    def remove(self, ids: list[str], delete_files: bool):
        with self.lock:
            for i in ids:
                j = self.jobs.pop(i, None)
                if not j:
                    continue
                self.order.remove(i)
                if j.proc and j.proc.poll() is None:
                    j.stopping = True
                    self._signal(j, "cont")
                    self._signal(j, "kill")
                if delete_files:
                    threading.Thread(target=self._delete_files, args=(j,), daemon=True).start()
            self.touch(save=True)

    def _delete_files(self, j: Job):
        if j.proc:
            try:
                j.proc.wait(timeout=5)
            except Exception:
                pass
        targets = set()
        for f in j.files + ([j.final_path] if j.final_path else []):
            targets.update({f, f + ".part", f + ".ytdl"})
            targets.update(glob.glob(glob.escape(f) + ".part-Frag*"))
            targets.update(glob.glob(glob.escape(f) + ".*.part"))
            stem = os.path.splitext(f)[0]
            for ext in (".jpg", ".png", ".webp", ".temp.mp3", ".temp.m4a"):
                targets.add(stem + ext)
        for t in targets:
            try:
                if os.path.isfile(t):
                    os.remove(t)
            except OSError:
                pass

    def shutdown(self):
        """Stop every yt-dlp process group; unfinished rows come back as Paused next run."""
        with self.lock:
            for j in self.jobs.values():
                if j.proc and j.proc.poll() is None:
                    j.stopping = True
                    self._signal(j, "cont")
                    self._signal(j, "term")
                    if j.status in ACTIVE or j.status == "queued":
                        j.status = "paused"
            self.touch(save=True)

    def clear_finished(self):
        with self.lock:
            for i in [i for i in self.order if self.jobs[i].status == "done"]:
                self.order.remove(i)
                del self.jobs[i]
            self.touch(save=True)


# ---------------------------------------------------------------- HTTP API
app = FastAPI(title="cloudsound_999")
mgr = Manager()


# ---------------------------------------------------------------- BPM / key analysis
def artist_from_path(path: str) -> str:
    base = re.sub(r"\s*\[[^\]]+\]$", "", Path(path).stem)
    return base.split(" - ", 1)[0].strip() if " - " in base else ""


class Analyzer:
    """Background worker: analyses finished tracks one at a time (niced subprocess running analyze.py).

    On first run it adds the analysis libraries to the app's own virtualenv: Essentia (best key/BPM),
    or NumPy alone for the built-in fallback if Essentia has no build for this Mac/Python.
    """
    MARK = STATE_DIR / "analyzer.json"

    def __init__(self, m: "Manager"):
        self.m = m
        self.status = "checking"   # checking | installing | essentia | basic | unavailable
        self.wake = threading.Event()
        threading.Thread(target=self._run, daemon=True).start()

    def _has(self, mod: str) -> bool:
        if FROZEN:  # packaged app: only what was bundled
            import importlib.util
            return importlib.util.find_spec(mod) is not None
        r = subprocess.run([sys.executable, "-c", f"import {mod}"], capture_output=True, stdin=subprocess.DEVNULL, **NO_WINDOW)
        return r.returncode == 0

    def _pip(self, *pkgs: str) -> bool:
        if FROZEN:
            return False
        try:
            r = subprocess.run([sys.executable, "-m", "pip", "install", "-q", "--only-binary=:all:", *pkgs],
                               capture_output=True, timeout=900, stdin=subprocess.DEVNULL, **NO_WINDOW)
            return r.returncode == 0
        except (subprocess.TimeoutExpired, OSError):
            return False

    def _set(self, st: str):
        self.status = st
        self.m.touch()

    def _ensure(self) -> str:
        if self._has("essentia"):
            return "essentia"
        mark = load_json(self.MARK, {})
        recently_tried = time.time() - mark.get("tried", 0) < 7 * 86400
        if not recently_tried and not IS_WIN:  # Essentia publishes no Windows builds
            self._set("installing")
            ok = self._pip("essentia")
            atomic_write(self.MARK, {"tried": time.time(), "essentia": ok})
            if ok and self._has("essentia"):
                return "essentia"
        if self._has("numpy") or (not recently_tried and self._pip("numpy") and self._has("numpy")):
            return "basic"
        return "unavailable"

    def _analyse(self, path: str, ff: str) -> Optional[dict]:
        """Run analyze.py in a low-priority child process; returns its JSON result."""
        if FROZEN:  # the packaged app runs itself in analysis mode and writes the result to a file
            out = STATE_DIR / "analysis.json"
            out.unlink(missing_ok=True)
            cmd = [sys.executable, "--analyze", path, ff, str(out)]
        else:
            cmd = [sys.executable, str(APP_DIR / "analyze.py"), path, ff]
        if IS_WIN:
            prio = {"creationflags": 0x08000000 | 0x00004000}  # NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS
        else:
            cmd, prio = ["nice", "-n", "10", *cmd], {}
        r = subprocess.run(cmd, capture_output=True, timeout=600, stdin=subprocess.DEVNULL, **TEXT_IO, **prio)
        if FROZEN:
            return load_json(out, None) if r.returncode == 0 else None
        line = (r.stdout.strip().splitlines() or [""])[-1]
        return json.loads(line) if r.returncode == 0 and line.startswith("{") else None

    def _next(self) -> Optional[Job]:
        with self.m.lock:
            for i in self.m.order:
                j = self.m.jobs[i]
                if j.status == "done" and j.final_path and not j.artist:
                    j.artist = artist_from_path(j.final_path)
                stale = j.analysis == "done" and (j.analysis_v or 0) < ANALYSIS_VERSION
                if j.status == "done" and (not j.analysis or stale) and j.final_path and os.path.isfile(j.final_path):
                    return j
        return None

    def _run(self):
        self._set(self._ensure())
        ff = which("ffmpeg")
        while True:
            j = self._next() if (self.status in ("essentia", "basic") and ff) else None
            if not j:
                with self.m.lock:
                    for i in self.m.order:   # artist names still get filled in without analysis
                        k = self.m.jobs[i]
                        if k.status == "done" and k.final_path and not k.artist:
                            k.artist = artist_from_path(k.final_path)
                self.wake.wait(5)
                self.wake.clear()
                continue
            res = None
            try:
                res = self._analyse(j.final_path, ff)
            except (subprocess.TimeoutExpired, OSError, ValueError):
                res = None
            with self.m.lock:
                if res:
                    j.bpm_raw, j.bpm_conf = res.get("bpm_raw"), res.get("bpm_conf", "")
                    if res.get("tag_bpm"):
                        j.bpm, j.bpm_src, j.bpm_manual = res["tag_bpm"], "tag", False
                    elif not j.bpm_manual:
                        j.bpm, j.bpm_src = fold_bpm(j.bpm_raw, self.m.settings.get("bpm_range", "78-155")), "auto"
                    if res.get("tag_key"):
                        j.key, j.camelot, j.key_src, j.key_conf = res["tag_key"], res["tag_camelot"], "tag", "high"
                    else:
                        j.key, j.camelot, j.key_src = res.get("key", ""), res.get("camelot", ""), "auto"
                        j.key_conf = res.get("key_conf", "")
                    if res.get("artist"):
                        j.artist = res["artist"]
                    j.analysis, j.analysis_v = "done", ANALYSIS_VERSION
                else:
                    j.analysis = "failed"
            self.m.touch(save=True)


analyzer = Analyzer(mgr)


class AddBody(BaseModel):
    urls: list[str]


class IdsBody(BaseModel):
    ids: list[str]
    delete_files: bool = False


@app.on_event("shutdown")
def _shutdown():
    mgr.shutdown()


@app.get("/api/health")
def health():
    tools = tool_status()
    return {"tools": tools, "ok": tools["yt-dlp"]["found"], "platform": sys.platform,
            "formats": AUDIO_FORMATS, "version": APP_VERSION}


@app.get("/api/state")
def state():
    return mgr.snapshot()


@app.post("/api/add")
def add(body: AddBody):
    if not which("yt-dlp"):
        raise HTTPException(400, "yt-dlp is not installed")
    return {"added": mgr.add_urls(body.urls)}


class MetaBody(BaseModel):
    id: str
    bpm: Optional[float] = None
    reanalyze: bool = False


@app.post("/api/meta")
def set_meta(body: MetaBody):
    """Fix a track's BPM by hand (e.g. halve/double a half-time reading), or queue it for re-analysis."""
    with mgr.lock:
        j = mgr.jobs.get(body.id)
        if not j:
            raise HTTPException(404, "No such track")
        if body.bpm is not None:
            if not 20 <= body.bpm <= 400:
                raise HTTPException(400, "BPM must be between 20 and 400")
            j.bpm, j.bpm_manual, j.bpm_src = round(body.bpm, 1), True, "manual"
        if body.reanalyze:
            j.analysis, j.bpm_manual = "", False
            analyzer.wake.set()
    mgr.touch(save=True)
    return {"ok": True}


@app.post("/api/reanalyze")
def reanalyze(body: IdsBody):
    """Analyse tracks again: re-reads BPM/key tags (e.g. after running them through a DJ tool)."""
    with mgr.lock:
        for i in body.ids:
            j = mgr.jobs.get(i)
            if j and j.status == "done":
                j.analysis, j.bpm_manual = "", False
    analyzer.wake.set()
    mgr.touch(save=True)
    return {"ok": True}


@app.post("/api/pause")
def pause(body: IdsBody):
    mgr.pause(body.ids)
    return {"ok": True}


@app.post("/api/resume")
def resume(body: IdsBody):
    mgr.resume(body.ids)
    return {"ok": True}


@app.post("/api/remove")
def remove(body: IdsBody):
    mgr.remove(body.ids, body.delete_files)
    return {"ok": True}


@app.post("/api/clear-finished")
def clear_finished():
    mgr.clear_finished()
    return {"ok": True}


@app.post("/api/dismiss-notice")
def dismiss_notice():
    mgr.notice = None
    mgr.touch()
    return {"ok": True}


@app.post("/api/settings")
def settings(patch: dict):
    mgr.update_settings(patch)
    return mgr.settings


@app.post("/api/choose-folder")
def choose_folder():
    """Native folder picker: AppleScript on macOS, the Windows folder dialog via PowerShell."""
    if IS_WIN:
        return _choose_folder_windows()
    if sys.platform != "darwin":
        raise HTTPException(501, "No native folder picker here; type a path instead")
    start = mgr.settings["output_dir"].replace('"', '\\"')
    script = (
        f'set d to POSIX file "{start}"\n'
        'try\n'
        '  set f to choose folder with prompt "cloudsound_999 — save audio to:" default location d\n'
        'on error\n'
        '  set f to choose folder with prompt "cloudsound_999 — save audio to:"\n'
        'end try\n'
        'POSIX path of f'
    )
    r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    if r.returncode != 0:
        return {"cancelled": True}
    mgr.update_settings({"output_dir": r.stdout.strip()})
    return {"cancelled": False, "output_dir": mgr.settings["output_dir"]}


def _choose_folder_windows():
    ps = (
        "Add-Type -AssemblyName System.Windows.Forms;"
        "$o = New-Object System.Windows.Forms.Form -Property @{TopMost=$true; ShowInTaskbar=$false};"
        "$d = New-Object System.Windows.Forms.FolderBrowserDialog;"
        "$d.Description = 'cloudsound_999: save audio to';"
        "$d.SelectedPath = $env:CS999_START;"
        "if ($d.ShowDialog($o) -eq 'OK') { [Console]::OutputEncoding = [Text.Encoding]::UTF8; $d.SelectedPath }"
    )
    env = {**os.environ, "CS999_START": mgr.settings["output_dir"]}
    r = subprocess.run(["powershell", "-NoProfile", "-STA", "-Command", ps], capture_output=True,
                       stdin=subprocess.DEVNULL, env=env, **TEXT_IO, **NO_WINDOW)
    path = r.stdout.strip()
    if r.returncode != 0 or not path:
        return {"cancelled": True}
    mgr.update_settings({"output_dir": path})
    return {"cancelled": False, "output_dir": mgr.settings["output_dir"]}


@app.post("/api/reveal")
def reveal(body: IdsBody):
    j = mgr.jobs.get(body.ids[0]) if body.ids else None
    target = (j.final_path if j and j.final_path and os.path.exists(j.final_path) else None)
    if sys.platform == "darwin":
        if target:
            subprocess.run(["open", "-R", target])
        else:
            subprocess.run(["open", mgr.settings["output_dir"]])
    elif IS_WIN:
        if target:
            subprocess.Popen(f'explorer /select,"{os.path.normpath(target)}"')
        elif os.path.isdir(mgr.settings["output_dir"]):
            os.startfile(mgr.settings["output_dir"])  # type: ignore[attr-defined]
    return {"ok": True}


AUDIO_TYPES = {".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".aac": "audio/aac",
               ".opus": "audio/ogg", ".ogg": "audio/ogg", ".flac": "audio/flac", ".wav": "audio/wav"}


@app.get("/api/audio/{job_id}")
def audio(job_id: str):
    """Stream a finished track to the built-in player (FileResponse handles Range requests)."""
    j = mgr.jobs.get(job_id)
    if not j or j.status != "done" or not j.final_path or not os.path.isfile(j.final_path):
        raise HTTPException(404, "File not found on disk")
    ext = os.path.splitext(j.final_path)[1].lower()
    return FileResponse(j.final_path, media_type=AUDIO_TYPES.get(ext, "application/octet-stream"))


ART_DIR = STATE_DIR / "art"


@app.get("/api/art/{job_id}")
def art(job_id: str):
    """Cover art for the player: the image embedded in the finished file, extracted once with ffmpeg and cached."""
    j = mgr.jobs.get(job_id)
    if not j or not j.final_path or not os.path.isfile(j.final_path):
        raise HTTPException(404, "No file")
    if not re.fullmatch(r"[0-9a-f]{6,32}", job_id):
        raise HTTPException(404, "No art")
    ART_DIR.mkdir(parents=True, exist_ok=True)
    out, none = ART_DIR / f"{job_id}.jpg", ART_DIR / f"{job_id}.none"
    if not out.exists() and not none.exists():
        ff = which("ffmpeg")
        ok = False
        if ff:
            try:
                r = subprocess.run([ff, "-v", "error", "-y", "-i", j.final_path, "-an", "-map", "0:v:0",
                                    "-frames:v", "1", "-vf", "scale=300:-2", str(out)],
                                   capture_output=True, timeout=20, stdin=subprocess.DEVNULL, **NO_WINDOW)
                ok = r.returncode == 0 and out.exists() and out.stat().st_size > 0
            except (subprocess.TimeoutExpired, OSError):
                ok = False
        if not ok:
            out.unlink(missing_ok=True)
            none.touch()
    if out.exists():
        return FileResponse(out, media_type="image/jpeg")
    raise HTTPException(404, "No embedded art")


@app.get("/api/events")
async def events():
    async def gen():
        mgr.clients += 1
        mgr.last_client = time.time()
        try:
            async for chunk in _events():
                yield chunk
        finally:
            mgr.clients -= 1
            mgr.last_client = time.time()

    async def _events():
        seen = -1
        idle = 0
        while True:
            if mgr.version != seen:
                seen = mgr.version
                yield f"data: {json.dumps(mgr.snapshot())}\n\n"
                idle = 0
            else:
                idle += 1
                if idle > 60:  # keep-alive every ~15s
                    yield ": ping\n\n"
                    idle = 0
            await asyncio.sleep(0.25)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache"})


@app.middleware("http")
async def no_stale_ui(request, call_next):
    """Always revalidate the UI files so an updated app never runs an old cached app.js/css."""
    resp = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/")
def index():
    return FileResponse(APP_DIR / "static" / "index.html")


app.mount("/static", StaticFiles(directory=APP_DIR / "static"), name="static")
