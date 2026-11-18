"""BPM + musical key for one audio file. Prints one JSON line.

Usage: python analyze.py <audio file> [ffmpeg path]

Uses Essentia (RhythmExtractor2013 + KeyExtractor) when it's installed, and otherwise a
NumPy fallback (onset autocorrelation for tempo, chroma + Krumhansl profiles for key).
Audio is decoded by ffmpeg to mono float PCM; long files (mixes, tapes) are analysed on
their first 8 minutes, so they get one overall value.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys

import numpy as np

SR = 44100
MAX_SECONDS = 900   # key/tempo from up to the first 15 minutes (mixes and tapes get one value)

NOTES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
ENHARMONIC = {"Db": "C#", "D#": "Eb", "Gb": "F#", "G#": "Ab", "A#": "Bb", "Cb": "B", "B#": "C", "E#": "F", "Fb": "E"}
CAMELOT_MAJOR = {"B": "1B", "F#": "2B", "C#": "3B", "Ab": "4B", "Eb": "5B", "Bb": "6B",
                 "F": "7B", "C": "8B", "G": "9B", "D": "10B", "A": "11B", "E": "12B"}
CAMELOT_MINOR = {"Ab": "1A", "Eb": "2A", "Bb": "3A", "F": "4A", "C": "5A", "G": "6A",
                 "D": "7A", "A": "8A", "E": "9A", "B": "10A", "F#": "11A", "C#": "12A"}


def decode(path: str, ffmpeg: str) -> np.ndarray:
    cmd = [ffmpeg, "-v", "error", "-nostdin", "-i", path, "-t", str(MAX_SECONDS),
           "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True, timeout=180).stdout
    x = np.frombuffer(raw, dtype=np.float32)
    if x.size < SR * 5:
        raise ValueError("too short to analyse")
    return x


def norm_key(k: str) -> str:
    k = k.strip()
    return ENHARMONIC.get(k, k)


def with_essentia(x: np.ndarray):
    import essentia
    import essentia.standard as es
    essentia.log.infoActive = False
    essentia.log.warningActive = False
    x = essentia.array(x)
    bpm, _beats, _conf, _est, _intervals = es.RhythmExtractor2013(method="multifeature")(x)
    key, scale, strength = es.KeyExtractor(sampleRate=SR)(x)
    return float(bpm), norm_key(key), scale, float(strength)


# ---- NumPy fallback
def _stft_mag(x: np.ndarray, n: int, hop: int) -> np.ndarray:
    frames = 1 + (len(x) - n) // hop
    idx = np.arange(n)[None, :] + hop * np.arange(frames)[:, None]
    win = np.hanning(n).astype(np.float32)
    return np.abs(np.fft.rfft(x[idx] * win, axis=1))


def basic_bpm(x: np.ndarray) -> float:
    y = x[::2]  # 22.05 kHz
    sr, hop = SR / 2, 256
    mag = _stft_mag(y, 1024, hop)
    flux = np.maximum(0, np.diff(np.log1p(mag), axis=0)).sum(axis=1)
    flux -= np.convolve(flux, np.ones(16) / 16, mode="same")
    flux = np.maximum(flux, 0)
    flux -= flux.mean()
    ac = np.correlate(flux, flux, mode="full")[len(flux) - 1:]
    fps = sr / hop
    lags = np.arange(len(ac))
    bpms = 60 * fps / np.maximum(lags, 1)
    ok = (bpms >= 60) & (bpms <= 200)
    # prefer tempos near 120 a little (log-gaussian weighting), as most tempo estimators do
    weight = np.exp(-0.5 * (np.log2(bpms / 120) / 0.9) ** 2)
    score = np.where(ok, ac * weight, -np.inf)
    lag = int(np.argmax(score))
    # parabolic refinement
    if 1 <= lag < len(ac) - 1:
        a, b, c = ac[lag - 1], ac[lag], ac[lag + 1]
        d = (a - c) / (2 * (a - 2 * b + c)) if (a - 2 * b + c) != 0 else 0
        lag = lag + d
    return float(60 * fps / lag)


MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def basic_key(x: np.ndarray):
    y = x[::2]
    sr, n = SR / 2, 8192
    mag = _stft_mag(y, n, 4096) ** 2
    freqs = np.fft.rfftfreq(n, 1 / sr)
    band = (freqs > 55) & (freqs < 2000)
    pc = np.round(12 * np.log2(freqs[band] / 261.6256)).astype(int) % 12
    chroma = np.zeros(12)
    e = mag[:, band].sum(axis=0)
    np.add.at(chroma, pc, e)
    chroma /= chroma.max() or 1
    best = (-2.0, 0, "major")
    for tonic in range(12):
        for prof, scale in ((MAJOR, "major"), (MINOR, "minor")):
            r = np.corrcoef(chroma, np.roll(prof, tonic))[0, 1]
            if r > best[0]:
                best = (r, tonic, scale)
    r, tonic, scale = best
    return NOTES[tonic], scale, float(max(r, 0))


# ---- tags written by DJ tools (Mixed In Key, rekordbox, Serato, Traktor, Mixxx…)
OPENKEY_TO_CAMELOT = {f"{n}{l}": f"{(n + 6) % 12 + 1}{'A' if l == 'm' else 'B'}" for n in range(1, 13) for l in "md"}
CAMELOT_TO_KEY = {v: (k, "minor") for k, v in CAMELOT_MINOR.items()} | {v: (k, "major") for k, v in CAMELOT_MAJOR.items()}


def parse_key(text: str):
    """'8A', '08A', '1m' (Open Key), 'Am', 'A min', 'A minor', 'Bbm', 'F#', 'C major' → (key, scale, camelot)."""
    t = (text or "").strip().replace("♯", "#").replace("♭", "b")
    if not t:
        return None
    m = re.fullmatch(r"0?(1[0-2]|[1-9])\s*([ABab])", t)
    if m:
        cam = f"{m.group(1)}{m.group(2).upper()}"
        key, scale = CAMELOT_TO_KEY[cam]
        return key, scale, cam
    m = re.fullmatch(r"(1[0-2]|[1-9])\s*([mdMD])", t)
    if m:
        cam = OPENKEY_TO_CAMELOT[f"{m.group(1)}{m.group(2).lower()}"]
        key, scale = CAMELOT_TO_KEY[cam]
        return key, scale, cam
    m = re.fullmatch(r"([A-Ga-g])([#b]?)\s*(m|min|minor|maj|major|M)?", t)
    if m:
        key = norm_key(m.group(1).upper() + m.group(2))
        scale = "minor" if (m.group(3) or "") in ("m", "min", "minor") else "major"
        cam = (CAMELOT_MINOR if scale == "minor" else CAMELOT_MAJOR).get(key)
        if cam:
            return key, scale, cam
    return None


def mp4_tmpo(path: str):
    """BPM from an MP4/M4A 'tmpo' atom (moov/udta/meta/ilst/tmpo/data), which ffprobe doesn't expose."""
    import struct

    def boxes(f, start, end):
        pos = start
        while pos + 8 <= end:
            f.seek(pos)
            hdr = f.read(8)
            if len(hdr) < 8:
                return
            size, typ = struct.unpack(">I4s", hdr)
            hlen = 8
            if size == 1:
                size = struct.unpack(">Q", f.read(8))[0]; hlen = 16
            elif size == 0:
                size = end - pos
            if size < hlen:
                return
            yield typ, pos + hlen, pos + size
            pos += size
    try:
        with open(path, "rb") as f:
            end = os.fstat(f.fileno()).st_size
            def find(start, stop, chain):
                for typ, a, b in boxes(f, start, stop):
                    if typ == chain[0]:
                        if typ == b"meta":
                            a += 4  # version + flags
                        if len(chain) == 1:
                            return a, b
                        r = find(a, b, chain[1:])
                        if r:
                            return r
                return None
            r = find(0, end, [b"moov", b"udta", b"meta", b"ilst", b"tmpo", b"data"])
            if not r:
                return None
            f.seek(r[0] + 8)  # type indicator + locale
            raw = f.read(r[1] - r[0] - 8)
            bpm = int.from_bytes(raw[:2], "big") if raw else 0
            return float(bpm) if 40 <= bpm <= 300 else None
    except (OSError, struct.error):
        return None


def read_tags(path: str, ffmpeg: str) -> dict:
    probe = os.path.join(os.path.dirname(ffmpeg), "ffprobe") if os.path.isabs(ffmpeg) else "ffprobe"
    try:
        r = subprocess.run([probe, "-v", "error", "-show_entries", "format_tags:stream_tags", "-of", "json", path],
                           capture_output=True, text=True, timeout=30)
        data = json.loads(r.stdout or "{}")
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return {}
    tags = {}
    for blob in [data.get("format", {})] + data.get("streams", []):
        for k, v in (blob.get("tags") or {}).items():
            tags.setdefault(k.lower(), str(v))
    out = {}
    if tags.get("artist") or tags.get("album_artist"):
        out["artist"] = (tags.get("artist") or tags.get("album_artist")).strip()
    for k in ("bpm", "tbpm", "tmpo", "beats per minute", "fbpm"):
        try:
            b = float(str(tags.get(k, "")).replace(",", ".").split()[0])
            if 40 <= b <= 300:
                out["bpm"] = b
                break
        except (ValueError, IndexError):
            continue
    if "bpm" not in out and path.lower().endswith((".m4a", ".mp4", ".m4b", ".aac", ".alac")):
        b = mp4_tmpo(path)
        if b:
            out["bpm"] = b
    for k in ("initialkey", "initial key", "tkey", "key"):
        pk = parse_key(tags.get(k, ""))
        if pk:
            out["key"] = pk
            break
    return out


def essentia_analysis(x: np.ndarray):
    """Tempo: RhythmExtractor2013 (multifeature), cross-checked with PercivalBpmEstimator; when the two
    disagree the tempo is flagged as uncertain.
    Key: three key profiles vote (bgate = general music, edma = electronic, shaath = KeyFinder's).
    Agreement between them is used as the confidence."""
    import essentia
    import essentia.standard as es
    essentia.log.infoActive = False
    essentia.log.warningActive = False
    x = essentia.array(x)
    bpm, _beats, bconf, _est, _intervals = es.RhythmExtractor2013(method="multifeature")(x)
    # second, independent opinion; octave-related answers count as agreeing on the pulse
    perc = float(es.PercivalBpmEstimator(sampleRate=SR)(x))
    tempo_agree = perc > 0 and any(abs(bpm / (perc * m) - 1) <= 0.025 for m in (0.5, 1, 2))
    votes = []
    for profile in ("bgate", "edma", "shaath"):
        key, scale, strength = es.KeyExtractor(sampleRate=SR, profileType=profile)(x)
        key = norm_key(key)
        cam = (CAMELOT_MINOR if scale == "minor" else CAMELOT_MAJOR).get(key, "")
        votes.append((cam, key, scale, float(strength)))
    tally = {}
    for v in votes:
        tally.setdefault(v[0], []).append(v)
    best = max(tally.values(), key=lambda vs: (len(vs), sum(v[3] for v in vs)))
    key_agree = len(best)
    cam, key, scale, _ = best[0]
    return {"bpm_raw": float(bpm), "bpm_conf": ("high" if bconf >= 1.5 else "ok") if tempo_agree else "low",
            "key": f"{key} {scale}", "camelot": cam,
            "key_conf": "high" if key_agree == 3 else "ok" if key_agree == 2 else "low",
            "key_votes": [v[0] for v in votes], "engine": "essentia"}


def basic_analysis(x: np.ndarray):
    bpm = basic_bpm(x)
    key, scale, strength = basic_key(x)
    cam = (CAMELOT_MINOR if scale == "minor" else CAMELOT_MAJOR).get(key, "")
    return {"bpm_raw": bpm, "bpm_conf": "low", "key": f"{key} {scale}", "camelot": cam,
            "key_conf": "ok" if strength > 0.75 else "low", "engine": "basic"}


def main():
    path = sys.argv[1]
    ffmpeg = sys.argv[2] if len(sys.argv) > 2 else "ffmpeg"
    tags = read_tags(path, ffmpeg)
    x = decode(path, ffmpeg)
    try:
        res = essentia_analysis(x)
    except ImportError:
        res = basic_analysis(x)
    res["bpm_raw"] = round(res["bpm_raw"], 2)
    # values written by a dedicated DJ tool win over our own detection
    if "bpm" in tags:
        res.update(tag_bpm=round(tags["bpm"], 2))
    if "key" in tags:
        k, sc, cam = tags["key"]
        res.update(tag_key=f"{k} {sc}", tag_camelot=cam)
    if "artist" in tags:
        res["artist"] = tags["artist"]
    print(json.dumps(res))


if __name__ == "__main__":
    main()
