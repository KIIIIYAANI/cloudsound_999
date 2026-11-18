@echo off
rem cloudsound_999 from source on Windows: double-click, or run "run.bat" in a terminal.
rem Needs Python 3.9+ (python.org or "winget install Python.Python.3.12"), yt-dlp and ffmpeg
rem ("winget install yt-dlp.yt-dlp Gyan.FFmpeg"). Most people want the packaged
rem cloudsound_999-windows.zip instead, which includes everything.
setlocal
cd /d "%~dp0"
if "%PORT%"=="" set PORT=9990
where py >nul 2>nul && (set PY=py -3) || (set PY=python)
if not exist ".venv\Scripts\python.exe" (
  echo * creating virtualenv...
  %PY% -m venv .venv || (echo Python 3 not found. Install it from python.org & pause & exit /b 1)
)
".venv\Scripts\python.exe" -c "import fastapi, uvicorn, psutil" 2>nul || (
  echo * installing Python dependencies...
  ".venv\Scripts\python.exe" -m pip install -q -r requirements.txt
)
echo * cloudsound_999 -^> http://127.0.0.1:%PORT%   (close this window to stop)
start "" http://127.0.0.1:%PORT%
".venv\Scripts\python.exe" -m uvicorn server:app --host 127.0.0.1 --port %PORT% --log-level warning
