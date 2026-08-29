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

```bash
sudo apt install nodejs   # only if `node -v` fails

cd overlay-manager && ./start.sh
```

Then:
1. Open http://127.0.0.1:8081/manager , edit the text, click **Save & push**.
2. In OBS: **+ → Browser Source → Create new**, URL `http://127.0.0.1:8081/`,
   check **Shutdown source when not visible** *off* (so the WebSocket stays
   connected between scene switches), width/height to taste.

### Files

| File          | Role                                                             |
|---------------|-------------------------------------------------------------------|
| `server.js`   | HTTP + WebSocket server (hand-rolled WS, no `ws` package needed) |
| `viewer.html` | What OBS loads — transparent background, listens for `reload`   |
| `manager.html`| Textarea + save button                                          |
| `overlay.html`| The content itself — an HTML fragment, not a full page. This is what gets read/written; treat it as generated/scratch state, not source. |

### Notes

**`overlay.html` is a fragment, not a document.** It gets injected via
`innerHTML` into `viewer.html`, so don't put `<html>`/`<body>` tags in it —
just the markup you want on screen.

**WebSocket is hand-rolled, deliberately.** The protocol only ever needs one
message (`"reload"`, server → viewer), so pulling in the `ws` package for it
felt like overkill. `server.js` does the `Sec-WebSocket-Accept` handshake and
outgoing text-frame encoding itself and doesn't parse incoming frames at all
— the viewer never sends anything meaningful, so incoming bytes (pings,
close frames) are just drained and ignored.

**The viewer reconnects on its own.** If `server.js` restarts, `viewer.html`
retries the WebSocket every 2s, so you don't have to touch the Browser Source
in OBS afterwards.
