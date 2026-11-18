# Changelog

## 3.0.1

- Skins renamed: **Matrix** (was 2001), **LymeWire**, **Napsterr**, **JoeKool**, **POSTAL**. A skin you already picked carries over automatically.
- The User menu closes as soon as you pick a skin.
- The selected and playing track's title stays readable in every skin (it was hard to see in Napsterr and Noir).
- The page accepts `?skin=`, `?view=` and `?play=1` link parameters.
- Screenshots in the README.
- Released under the MIT license.

## 3.0.0 — first public release

cloudsound_999 is a local SoundCloud downloader and DJ-minded player for macOS.

**Download**
- Queue SoundCloud tracks, playlists, sets and profiles. Each row shows progress, speed and ETA, with pause, resume and remove (optionally deleting the files).
- Drop links onto the Dock icon or the window, or use right-click → Services → *Add to cloudsound_999 Queue*.
- Choose the output folder, the number of simultaneous downloads, a speed limit and the audio format (original, MP3, M4A, Opus, FLAC or WAV). Metadata and cover art are embedded.

**Play**
- A built-in player for finished tracks: play, pause, previous and next, with a seek bar, album art and an **Auto** toggle for auto-play. Space plays and pauses, and the media keys work.
- A live oscilloscope drawn in each skin's own style.

**Organize (for DJs)**
- A tab listing title, artist, BPM and key, with keys shown as colour-coded Camelot badges.
- Sort by any column. Sorting by Key follows the Camelot wheel, so compatible keys sit together.
- Search (⌘F) by name, BPM (`128`, `120-130`), Camelot key (`8A`) or key name (`Fm`, `Abmaj`).

**BPM and key accuracy**
- Values already written by a DJ tool are used first. That covers Mixed In Key, rekordbox, Serato, Traktor and Mixxx, in MP3, M4A and other tag formats, including Open Key notation.
- Otherwise the app detects them with Essentia. Tempo is cross-checked by two independent estimators, and key is voted on by three key profiles (general, electronic and KeyFinder's).
- `?` marks results the detectors disagreed on, and `TAG` marks values that came from the file's tags.
- A **BPM range** setting (like DJ software) fixes half- and double-speed readings. There are presets for hip-hop, general, drum & bass and hardcore.
- Hover a BPM to use ½ / ×2, double-click it to type a value, or use *Analyse BPM/key again* to re-read tags after running files through a DJ tool.

**Skins**
- Matrix (Y2K techno), LymeWire, Napsterr, HotFries, JoeKool, POSTAL and Noir.
- Switch with ⌘1–⌘7 or the User menu.

**Requirements**
- macOS 12 or later, on Apple Silicon or Intel.
- Homebrew packages: `python`, `yt-dlp` and `ffmpeg`.
- On first launch the app adds its Python packages, plus Essentia (about 60 MB), to its own folder in `~/Library/Application Support/cloudsound_999`.
