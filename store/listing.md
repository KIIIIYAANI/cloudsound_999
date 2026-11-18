# Store listing — itch.io and Whop

Copy-paste text and settings for the download pages. Images are in `dist/store/` (made locally, not in git):

| File | Use |
|---|---|
| `cover-630x500.png` | itch.io cover image (exactly 630×500) |
| `hero-1920x1080.jpg` | Whop product banner / itch.io banner |
| `screenshot-*.jpg` (1920 wide) | gallery: one per skin, plus two Organize views |

Repository: https://github.com/KIIIIYAANI/cloudsound_999 · Downloads: https://github.com/KIIIIYAANI/cloudsound_999/releases/latest

---

## Title

cloudsound_999

## Tagline (short, ≤ 100 characters)

A local SoundCloud downloader and DJ-ready player for Mac and Windows, with seven retro skins.

## Short description

Paste SoundCloud links, watch them download in a torrent-style transfer list, then play, search and sort your tracks by BPM and Camelot key. Everything runs on your Mac. Free and open source.

## Long description

**cloudsound_999** is a desktop app for Mac and Windows that downloads SoundCloud tracks, playlists and profiles to a folder you choose, then helps you play and organize them.

**Download**
- Paste links, or drop them on the Dock icon or the window. Each row shows progress, speed and ETA, with pause, resume and remove.
- Choose the format: original, MP3, M4A, Opus, FLAC or WAV. Metadata and cover art are embedded.
- Set how many downloads run at once and an optional speed limit.

**Play**
- A built-in player with album art, a seek bar, previous/next, an auto-play toggle and media-key support.
- A live oscilloscope drawn in the style of whichever skin you're using.

**Organize (for DJs)**
- A tab listing title, artist, BPM and key, with colour-coded Camelot badges.
- Sort by any column. Key sorting follows the Camelot wheel, so compatible keys sit together.
- Search by name, BPM (`128`, `120-130`), Camelot key (`8A`) or key name (`Fm`).
- BPM and key come from your DJ software's tags when present (Mixed In Key, rekordbox, Serato, Traktor, Mixxx). Otherwise they're detected with Essentia, cross-checked by several algorithms; uncertain results are flagged with `?`.
- A BPM range setting fixes half- and double-time readings, with presets for hip-hop, house/techno, drum & bass and hardcore.

**Seven skins**
Matrix · LymeWire · Napsterr · HotFries · JoeKool · POSTAL · Noir. Switch with ⌘1–⌘7.

**Private by design**
No account, no tracking, no cloud. The app's server only listens on your own machine (`127.0.0.1`).

**Free and open source** (MIT). Source code: https://github.com/KIIIIYAANI/cloudsound_999

## Requirements

**Windows:** Windows 10 or 11, 64-bit. Nothing else to install.

**Mac:**
- macOS 12 Monterey or later, Apple Silicon or Intel
- [Homebrew](https://brew.sh), then in Terminal: `brew install python yt-dlp ffmpeg`
- About 200 MB of disk space for the app's Python packages (set up automatically on first launch)

## Install

**Windows:** extract `cloudsound_999-3.1.0-windows.zip`, open the folder, and double-click `cloudsound_999.exe`. If Windows says it protected your PC, click **More info → Run anyway**.

**Mac:**
1. Install the Homebrew packages above.
2. Download `cloudsound_999-3.1.0.dmg`, open it, and drag **cloudsound_999** into **Applications**.
3. Open the app. macOS blocks it the first time because it isn't notarized by Apple. Open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway**.
4. The first launch takes about a minute while the app installs its Python packages.

Prefer to check the download? Compare it against `SHA256SUMS.txt` with `shasum -a 256 cloudsound_999-3.1.0.dmg`.

## Use responsibly

Only download audio you have the right to: tracks the artist has made downloadable, Creative Commons work, or your own uploads. cloudsound_999 is an independent project. It isn't affiliated with or endorsed by SoundCloud or any other company whose era of software inspired a skin.

---

## itch.io settings

- **Kind of project:** Downloadable
- **Classification:** Tools
- **Pricing:** No payments, or *Donations* (pay what you want, $0 minimum)
- **Uploads:** `cloudsound_999-3.1.0.dmg` (tick *macOS*), `cloudsound_999-3.1.0-windows.zip` (tick *Windows*), plus `cloudsound_999-3.1.0-source.zip` (no platform; label it "Source (any OS, run with ./run.sh)")
- **Genre / tags:** `music`, `dj`, `audio`, `soundcloud`, `downloader`, `music-player`, `mac`, `windows`, `retro`, `open-source`, `y2k`
- **Release status:** Released
- **Community:** Comments on (useful for bug reports), or link the GitHub issues page
- **Visibility:** Draft first. Check the page, then switch to Public.

## Whop

See [whop.md](whop.md) for the full step-by-step guide, copy and images (`dist/whop/`).

## Changelog snippet (for an itch.io devlog / Whop update)

**3.1.0:** cloudsound_999 now runs on Windows 10/11, with everything included.

**3.0.1:** skins renamed (Matrix, LymeWire, Napsterr, JoeKool, POSTAL); the User menu closes after you pick a skin; selected tracks stay readable in every skin; README screenshots; MIT license.
