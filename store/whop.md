# Listing cloudsound_999 on Whop

Everything to upload is in `dist/whop/` (built locally, not in git):

```
dist/whop/
  images/banner-1920x1080.jpg        product / store-page banner
  images/thumbnail-1280x720.jpg      product card image (same art, smaller)
  images/icon-512.png                logo / whop avatar
  images/alt-banner-matrix-1920x1080.jpg   plain screenshot banner, if you prefer it
  images/gallery/01…09-*.jpg         gallery (in display order)
  downloads/cloudsound_999-<v>.dmg                Mac download
  downloads/cloudsound_999-<v>-windows.zip        Windows download
  downloads/SHA256SUMS.txt                        checksums for both
```

Whop moves its menus around now and then, so names below may differ slightly.

## 1. Create the product

1. Sign in at whop.com and open your dashboard (create a whop/business first if you don't have one; name it e.g. *cloudsound_999*, upload `icon-512.png` as its logo).
2. **Products → Create product.**
   - **Name:** cloudsound_999
   - **Headline / short description:** the tagline below
   - **Pricing:** Free. To accept tips, use a one-time price with "customer chooses amount" / pay what you want, if your account offers it, or add a paid "Supporter" tier next to the free one.
3. **Description:** paste the long description below.
4. **Media:** upload `banner-1920x1080.jpg` as the main image and the `gallery/` images in order.

## 2. Deliver the downloads

Pick one:

- **Files app (download stays on Whop):** in the product, add the **Files** app, switch to admin view, and upload the `.dmg`, the `-windows.zip` and `SHA256SUMS.txt`. Name them "Mac (macOS 12+)" and "Windows 10/11 (64-bit)".
- **Link to GitHub (always the newest version):** add a link/"Website" app or put this in the welcome message:
  `https://github.com/KIIIIYAANI/cloudsound_999/releases/latest`
  With this option you never re-upload files for updates.

Using both is fine: files for convenience, the GitHub link for updates.

## 3. Welcome message (shown after someone claims it)

> Thanks for grabbing cloudsound_999!
>
> **Mac:** open the .dmg and drag the app to Applications. First launch: System Settings → Privacy & Security → *Open Anyway*. You also need Homebrew and `brew install python yt-dlp ffmpeg`.
>
> **Windows:** extract the zip, open the folder, double-click `cloudsound_999.exe`. If Windows says it protected your PC, click *More info* → *Run anyway*. Everything else is included.
>
> Updates: https://github.com/KIIIIYAANI/cloudsound_999/releases/latest
> Please only download audio you have the rights to.

## 4. Before publishing

- Preview the store page on desktop and phone.
- Claim the product yourself with a second account (or in preview) and test both downloads.
- Category: *Software* / *Tools* (or *Music*). Tags: music, DJ, SoundCloud, downloader, BPM, Mac, Windows, free.

---

## Copy

**Tagline:** SoundCloud downloader + DJ-ready player for Mac and Windows: BPM, Camelot keys, seven retro skins.

**Long description:**

cloudsound_999 downloads SoundCloud tracks, playlists and profiles to your computer, then helps you play and organize them like a DJ.

**Download:** paste links (or drop them on the window) and watch a torrent-style queue with progress, speed, pause and resume. Save as the original file, MP3, M4A, Opus, FLAC or WAV, with cover art and tags embedded.

**Play:** built-in player with album art, auto-play and a live oscilloscope that matches your skin.

**Organize:** a DJ tab listing title, artist, BPM and key as colour-coded Camelot badges. Sort by any column (key sorting follows the Camelot wheel), and search by name, BPM range or key. BPM and key written by Mixed In Key, rekordbox, Serato or Traktor are read first; otherwise the app detects them.

**Seven skins:** Matrix, LymeWire, Napsterr, HotFries, JoeKool, POSTAL and Noir.

**Private:** no account, no tracking. Everything runs on your own computer.

**Requirements:** macOS 12+ (Apple Silicon or Intel) with Homebrew, or Windows 10/11 64-bit (nothing else to install).

Free and open source (MIT): https://github.com/KIIIIYAANI/cloudsound_999

*Only download audio you have the rights to. Not affiliated with SoundCloud.*
