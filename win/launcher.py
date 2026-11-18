"""cloudsound_999 for Windows: the entry point of cloudsound_999.exe (built with PyInstaller).

- Runs the local server on 127.0.0.1 and opens the UI in its own window (Microsoft Edge app mode,
  which every Windows 10/11 has; the default browser if Edge is missing).
- Quits about 20 seconds after the last window closes; unfinished downloads come back as Paused.
- Launching it again while it runs just opens another window. Links passed on the command line
  (e.g. dropped onto the .exe) are added to the queue.
- `cloudsound_999.exe --analyze <file> <ffmpeg> <out.json>` is the BPM/key worker the server starts.
- Bundled yt-dlp updates itself in the background at most once a week (SoundCloud changes often).

Environment: CS999_NO_WINDOW=1 starts the server without a window and without auto-quit (for tests).
"""
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

EXE_DIR = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "cloudsound_999"
PORTS = range(9990, 10000)
NO_WINDOW = 0x08000000


def analyze_mode():
    # a windowed .exe shows a dialog for uncaught errors; a file that can't be analysed should just fail quietly
    try:
        import analyze
        analyze.main(sys.argv[2:])
    except BaseException:  # noqa: BLE001
        os._exit(1)


def probe(port):
    """Return our server's health dict if cloudsound_999 is listening on this port."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1.5) as r:
            h = json.loads(r.read())
            return h if "formats" in h and "tools" in h else None
    except Exception:  # noqa: BLE001
        return None


def port_free(port):
    import socket
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def add_links(port, args):
    urls = [a for a in args if a.startswith(("http://", "https://"))]
    if urls:
        req = urllib.request.Request(f"http://127.0.0.1:{port}/api/add", json.dumps({"urls": urls}).encode(),
                                     {"Content-Type": "application/json"})
        try:
            urllib.request.urlopen(req, timeout=10).read()
        except Exception:  # noqa: BLE001
            pass


def edge_path():
    for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles"), os.environ.get("LOCALAPPDATA")):
        if base:
            p = Path(base) / "Microsoft" / "Edge" / "Application" / "msedge.exe"
            if p.exists():
                return str(p)
    return None


def open_window(port):
    url = f"http://127.0.0.1:{port}/"
    edge = edge_path()
    if edge:
        subprocess.Popen([edge, f"--app={url}", f"--user-data-dir={DATA_DIR / 'window'}", "--no-first-run",
                          "--no-default-browser-check", "--window-size=1280,860",
                          "--autoplay-policy=no-user-gesture-required"], creationflags=NO_WINDOW)
    else:
        webbrowser.open(url)


def update_ytdlp(tools):
    """yt-dlp -U once a week, so SoundCloud keeps working between app releases."""
    exe, mark = tools / "yt-dlp.exe", DATA_DIR / ".state" / "ytdlp-update.txt"
    try:
        if exe.exists() and time.time() - float(mark.read_text() if mark.exists() else 0) > 7 * 86400:
            subprocess.run([str(exe), "-U"], capture_output=True, timeout=300, creationflags=NO_WINDOW)
            mark.write_text(str(time.time()))
    except Exception:  # noqa: BLE001
        pass


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--analyze":
        return analyze_mode()

    # already running? open another window (and pass on any links), then leave
    for port in PORTS:
        if probe(port):
            add_links(port, sys.argv[1:])
            if not os.environ.get("CS999_NO_WINDOW"):
                open_window(port)
            return

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / ".state").mkdir(exist_ok=True)
    # a windowed .exe has no console: send output to a log file
    log = open(DATA_DIR / "server.log", "a", encoding="utf-8", buffering=1)
    sys.stdout = sys.stderr = log
    tools = EXE_DIR / "tools"
    os.environ["CS999_DATA_DIR"] = str(DATA_DIR)
    os.environ["CS999_TOOLS_DIR"] = str(tools)
    os.environ["PATH"] = str(tools) + os.pathsep + os.environ.get("PATH", "")

    port = next((p for p in PORTS if port_free(p)), None)
    if port is None:
        raise SystemExit("no free port in 9990-9999")

    import uvicorn
    import server  # noqa: F401  (imported here so its paths see the environment above)

    config = uvicorn.Config(server.app, host="127.0.0.1", port=port, log_level="warning",
                            timeout_graceful_shutdown=3, log_config=None)
    srv = uvicorn.Server(config)

    def after_start():
        while not srv.started:
            time.sleep(0.1)
        add_links(port, sys.argv[1:])
        if os.environ.get("CS999_NO_WINDOW"):
            return
        open_window(port)
        threading.Thread(target=update_ytdlp, args=(tools,), daemon=True).start()
        # quit once no window has been connected for a while (a reload reconnects within a second)
        started = time.time()
        while True:
            time.sleep(2)
            m = server.mgr
            idle = m.clients == 0 and time.time() - m.last_client > 20
            never = m.clients == 0 and m.last_client <= started and time.time() - started > 120
            if idle and (m.last_client > started or never):
                srv.should_exit = True
                return

    threading.Thread(target=after_start, daemon=True).start()
    print(f"cloudsound_999 on http://127.0.0.1:{port}  ({time.strftime('%Y-%m-%d %H:%M:%S')})")
    srv.run()


if __name__ == "__main__":
    main()
