"""End-to-end test against a running cloudsound_999 server (macOS, Windows or Linux). Stdlib only.

It makes a 120 BPM click track with ffmpeg, serves it from a local web server, and drives the app's API:
download (rate-limited) → pause (bytes stop growing) → resume → done → BPM analysis → playback → remove + delete.

The app must be started with CS999_TEST_HOSTS=127.0.0.1 so it accepts the local URL.
Usage: python tests/e2e.py <app url> <ffmpeg path>
"""
import functools
import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

APP, FFMPEG = sys.argv[1].rstrip("/"), sys.argv[2]


def api(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(APP + path, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b"null")


def job():
    jobs = api("/api/state")["jobs"]
    return jobs[0] if jobs else None


def wait(pred, what, timeout=120):
    end = time.time() + timeout
    while time.time() < end:
        j = job()
        if j and pred(j):
            return j
        time.sleep(0.25)
    raise SystemExit(f"FAIL: timed out waiting for {what}; last state: {json.dumps(job(), indent=1)}")


def main():
    work = tempfile.mkdtemp(prefix="cs999-e2e-")
    serve, out = os.path.join(work, "serve"), os.path.join(work, "out")
    os.makedirs(serve)
    # 60 s of a 120 BPM click (a short 1 kHz burst every 0.5 s) over quiet noise
    subprocess.run([FFMPEG, "-v", "error", "-y", "-nostdin", "-f", "lavfi",
                    "-i", "sine=f=1000:d=60,volume='if(lt(mod(t,0.5),0.04),1,0)':eval=frame",
                    "-f", "lavfi", "-i", "anoisesrc=d=60:a=0.01", "-filter_complex", "amix=inputs=2:normalize=0",
                    "-ac", "1", "-ar", "44100", os.path.join(serve, "click120.wav")], check=True)

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass

    class Server(http.server.ThreadingHTTPServer):
        def handle_error(self, *a):  # yt-dlp hangs up early while probing; not an error
            pass

    srv = Server(("127.0.0.1", 0), functools.partial(Quiet, directory=serve))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_address[1]}/click120.wav"

    health = api("/api/health")
    assert health["tools"]["yt-dlp"]["found"] and health["tools"]["ffmpeg"]["found"], health
    print("health ok:", health["platform"], health["version"], health["tools"]["yt-dlp"]["version"])

    api("/api/settings", {"output_dir": out, "rate_limit_kb": 250, "audio_format": "original"})
    assert api("/api/add", {"urls": [url]})["added"] == 1

    j = wait(lambda j: j["status"] == "downloading" and (j["downloaded"] or 0) > 200_000, "download to start")
    api("/api/pause", {"ids": [j["id"]]})
    time.sleep(1.0)
    a = job()["downloaded"]
    time.sleep(2.5)
    b = job()
    assert b["status"] == "paused", b
    assert b["downloaded"] == a, f"bytes kept growing while paused: {a} -> {b['downloaded']}"
    print(f"pause ok: held at {a} bytes")

    api("/api/resume", {"ids": [j["id"]]})
    api("/api/settings", {"rate_limit_kb": 0})
    j = wait(lambda j: j["status"] in ("done", "error"), "download to finish")
    assert j["status"] == "done", j
    assert j["final_path"] and os.path.isfile(j["final_path"]), j
    print("download ok:", os.path.basename(j["final_path"]), os.path.getsize(j["final_path"]), "bytes")

    j = wait(lambda j: j.get("analysis") in ("done", "failed"), "analysis", timeout=300)
    assert j["analysis"] == "done", j
    # a synthetic click is a crude test signal; this checks the analysis pipeline, not fine accuracy
    assert j["bpm"] and abs(j["bpm"] - 120) <= 5, f"BPM {j['bpm']} (raw {j.get('bpm_raw')})"
    print(f"analysis ok: {j['bpm']} BPM, key {j.get('key')} ({j.get('camelot')})")

    with urllib.request.urlopen(urllib.request.Request(APP + f"/api/audio/{j['id']}", headers={"Range": "bytes=0-1023"})) as r:
        assert r.status == 206 and len(r.read()) == 1024
    print("playback ok: range request served")

    api("/api/remove", {"ids": [j["id"]], "delete_files": True})
    time.sleep(2)
    assert not os.path.exists(j["final_path"]), "file not deleted"
    print("remove ok\nALL PASSED")


if __name__ == "__main__":
    main()
