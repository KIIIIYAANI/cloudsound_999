# cloudsound_999 · pocket sampler (mobile)

A phone sampler that runs in the browser and installs to your home screen. It has no server and stores nothing in the cloud: audio is saved on the phone (IndexedDB).

## What it does

- **4 tracks.** Record from the phone mic or a plugged-in mic or interface, or import an audio file. Each track loops in sync with the transport and has mute, solo, volume and a live oscilloscope over its waveform.
- **Record length:** FREE (tap to start and stop) or 1/2/4/8 bars, which starts on the next bar, with an optional 1-bar count-in. Source: **MIC**, or **PADS** to resample what you play on the pads.
- **Master record:** captures everything coming out of the mix (tracks + pads) as a "tape" in the Sound Bay.
- **Chop editor:** tap a track's waveform to open it. The waveform is coloured by frequency: **red = low** (kicks, bass), **gold = mid** (snares, vocals), **green = high** (hats).
  - **Auto chop** finds hits in ALL HZ, only LOW, only MID or only HIGH, or cuts an even GRID. SENS sets how many.
  - **Manual:** SELECT taps a slice to hear it, CUT drops or drags cut points, SCRUB drags through the sound. Pinch or +/− zoom in.
  - Selected slice: PLAY, → BAY, → PAD, CROP. Whole sample: ALL → BAY, **ALL → PADS 1-9**, **SPLIT HZ → BAY** (low/mid/high layers as separate samples), REVERSE, NORMALIZE, BPM FROM LOOP.
- **Sound Bay:** every cut, tape and import lives here. Play it, put it on a pad or a track, chop it further, rename it, save/share it as WAV, or delete it.
- **9 pads** in the pull-up drawer (tap or swipe the PADS bar). Hold a pad, or turn on EDIT, to set pitch (±24 semitones), gain, ONE SHOT / GATE / LOOP and CUT (retrigger chokes itself). Keys 1–9 play pads on a computer keyboard.

## Run it

The mic only works on **https** pages (or `localhost`).

- **GitHub Pages (phone):** `.github/workflows/mobile-pages.yml` publishes this folder when `main` changes. In the repo, open Settings → Pages and set **Source: GitHub Actions**. The app is then at `https://<user>.github.io/<repo>/`. Open it on the phone, then:
  - iPhone: Share → **Add to Home Screen**
  - Android: ⋮ → **Install app**
- **Desktop app:** while cloudsound_999 is running, open http://127.0.0.1:9990/mobile/
- **Any static server:** serve this folder, e.g. `python3 -m http.server -d mobile 8080`, then open http://localhost:8080

## Tips

- **External mics:** plug the mic in, open ⚙ Settings, tap **Rescan inputs** and pick it. iPhone uses the most recently connected mic.
- Turn on **Monitor** only with headphones, or the speaker will feed back.
- If recordings land late compared to the beat, raise **Rec latency fix** in Settings (try 40–120 ms on Bluetooth-free setups, more with Bluetooth).
- On iPhone, flip the ring/silent switch off if you hear nothing on older iOS versions.
