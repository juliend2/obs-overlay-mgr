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

The manager composites its preview and live panes over the HDMI capture card
by default — path `cam` (H.264) in Chromium, `cam-vp8` in Firefox, chosen by
probing the browser's real SDP offer. Append `?path=test` to `/manager` for the
synthetic pattern, or `?path=<name>` for any other path in
`testfeed/mediamtx.yml`. The card must be on a USB 3.0 port and fed a live HDMI
signal (see the top-level README).

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

