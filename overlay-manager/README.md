# overlay-manager

Edit the text/HTML shown in an OBS Browser Source, and have it update live —
no need to touch OBS or reload the source manually.

One Node process, no dependencies, no build step:

- serves the **viewer** page (`/`) — put this URL in OBS's Browser Source
- serves the **manager** page (`/manager`) — open this in a normal browser tab to edit
- holds a WebSocket per connected viewer; when you save, it writes
  `overlay.html` to disk and pushes a `reload` message, and the viewer
  re-fetches the file and swaps it into the DOM (no full-page reload, so no
  flash/blank-frame in OBS)

### Quick start

Needs Node (any recent version — built with v26, but nothing here needs a
specific one). If `node -v` fails, install it either via nvm:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install --lts
```

or via apt:

```bash
sudo apt install nodejs
```

Then:

```bash
cd overlay-manager && ./start.sh
```

1. Open http://127.0.0.1:8081/manager , edit the text, click **Save & push**.
2. In OBS: **+ → Browser Source → Create new**, URL `http://127.0.0.1:8081/`,
   check **Shutdown source when not visible** *off* (so the WebSocket stays
   connected between scene switches), width/height to taste.

### Camera behind the overlay

The manager composites its preview and live panes over the HDMI capture card.
By default each pane shows a **~1 fps JPEG snapshot**, not a live video. This
box runs OBS *and* the manager browser on one shared Intel iGPU, and decoding
live video in the browser stole enough render time to show up as OBS
**"rendering lag"** (measured >5%). A snapshot is plenty to line overlays up and
costs almost no GPU (~0.08 core, no video decode in the browser at all).

`server.js` serves it at `GET /cam.jpg?src=<path>`, grabbed from the RTSP feed
by a small on-demand ffmpeg that decodes **keyframes only** (`-skip_frame
nokey`; `cam` is `-g 30`, so one frame a second). One grabber serves both panes;
it stops ~30 s after the manager goes quiet and is killed with the server, so it
never holds the capture card open.

**To get a real live video back**, append `?stream=1`:

| URL                          | What the panes show                                        |
|------------------------------|------------------------------------------------------------|
| `/manager`                   | snapshot of `cam` (default, cheapest)                      |
| `/manager?path=test`         | snapshot of the synthetic test pattern                     |
| `/manager?stream=1`          | live WebRTC video, low-res 360p (`cam-preview`, or `cam-preview-vp8` in Firefox) |
| `/manager?stream=1&path=cam` | live WebRTC video, full 720p                               |
| `/manager?preview=off`       | staging pane overlay-only (no camera)                      |

`?path=` picks any path in `testfeed/mediamtx.yml`: with `?stream=1` it is the
WebRTC feed, otherwise the snapshot source. The H.264/VP8 pick only matters when
streaming (Chromium offers H.264, Firefox only VP8).

Three env vars tune the grabber: `SNAPSHOT_PATH` (where the JPEG is written;
default `$TMPDIR/obs-overlay-cam.jpg`), `SNAPSHOT_SOURCE` (default source;
`rtsp://127.0.0.1:8554/cam`) and `SNAPSHOT_DISABLE=1` (don't grab — `/cam.jpg`
then just serves whatever is already at `SNAPSHOT_PATH`).

The card must be on a USB 3.0 port and fed a live HDMI signal (see the
top-level README).

### Files

| File          | Role                                                              |
|---------------|-------------------------------------------------------------------|
| `server.js`   | HTTP + WebSocket server (hand-rolled WS, no `ws` package needed)  |
| `viewer.html` | What OBS loads — transparent background, listens for `reload`     |
| `manager.html`| Textarea + save button                                            |
| `overlay.html`| The content itself — an HTML fragment, not a full page. This is what gets read/written; treat it as generated/scratch state, not source. |

### Notes

**`overlay.html` is a fragment, not a document.** It gets injected via
`innerHTML` into `viewer.html`, so don't put `<html>`/`<body>` tags in it —
just the markup you want on screen.

**Shared styles live in `components/common.css`, linked by the host page.**
`viewer.html`, `manager.html` and the `/test` wrapper link it once in
`<head>`; templates and presets must not carry a `<link>` themselves — a
stylesheet link inside the injected fragment is re-fetched on every reload
(`no-store`) and flashes unstyled text.

**WebSocket is hand-rolled, deliberately.** The protocol only ever needs one
message (`"reload"`, server → viewer), so pulling in the `ws` package for it
felt like overkill. `server.js` does the `Sec-WebSocket-Accept` handshake and
outgoing text-frame encoding itself and doesn't parse incoming frames at all
— the viewer never sends anything meaningful, so incoming bytes (pings,
close frames) are just drained and ignored.

**The viewer reconnects on its own.** If `server.js` restarts, `viewer.html`
retries the WebSocket every 2s, so you don't have to touch the Browser Source
in OBS afterwards.

**Port 8081**, not 8000, so it doesn't collide with `testfeed/`'s dev server
if you're running both at once.

