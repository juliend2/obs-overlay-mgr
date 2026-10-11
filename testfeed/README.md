# testfeed — synthetic video sources for testing

Overlays need something moving underneath them. This directory generates test
video locally so you don't need a camera or a live stream to work on the
compositing. See the top-level README for dependencies and how to run it.

Three transports, in decreasing order of usefulness:

|            | URL            | Needs             | Latency                |
|------------|----------------|-------------------|------------------------|
| **WebRTC** | `/webrtc.html` | MediaMTX + ffmpeg | sub-second             |
| **Canvas** | `/`            | nothing           | n/a (rendered in-page) |
| **MJPEG**  | `/mjpeg.html`  | ffmpeg            | ~1s, single viewer     |

---

## Plugging in a real source: HDMI capture card

The test paths above are synthetic. If you plug an HDMI capture stick into the
machine (so a game console, camera, or another laptop can be the moving
backdrop), you can feed that signal to **OBS and the browser player at the same
time**. This section explains how — from zero.

### What plugging in the HDMI stick does

The stick turns the HDMI signal into something your computer can read. Linux
presents it as a "device file" — basically a file named `/dev/video0` that
continuously produces pictures. Any program that wants the video just reads
that file. Check the name with `v4l2-ctl --list-devices` (a stick often shows a
video device plus a metadata sibling — use the even-numbered one).

### The one problem: only one reader allowed

Cheap capture sticks are dumb hardware. Like a single-lane bridge, only *one*
program can read `/dev/video0` at a time. So if you point OBS directly at the
card, the browser can't also read it — and vice versa. They'd fight over it and
one would get an error.

### The fix: a middleman

That's what MediaMTX (already in this directory) is — think of it as a tiny
local TV station. One `ffmpeg` process (a universal converter program) is the
*single* reader of the card. ffmpeg takes the raw pictures and hands them to
the station once. The station then redistributes that same feed to anyone who
asks: OBS, your browser, five browsers, doesn't matter. One bridge crossing,
unlimited viewers.

```
HDMI card (/dev/video0) → ffmpeg → MediaMTX ─→ OBS Media Source (RTSP)
                                            └→ webrtc.html (WHEP)
```

### One codec, one copy

A "codec" is just a compression format for video. Both consumers here speak the
same one: **H.264**, which Chromium plays over WebRTC (`/webrtc.html`) and OBS
decodes natively over RTSP (Media Source). So a single `ffmpeg` process reads
the card and publishes **one** H.264 stream (path `cam`); everyone tunes into
that. (We assume Chromium — see "Codec" in the top-level README.)

### How to use it

1. Plug in the stick, note the device name (`/dev/video0` by default — adjust
   `testfeed/mediamtx.yml` if yours differs).
2. Start the feed as usual: `cd testfeed && ./start.sh`
3. OBS: add **+ → Media Source**
   - uncheck "Local file"
   - Input: `rtsp://127.0.0.1:8554/cam`
   - Network Buffering: `0` MB (required, see top-level README)
   - FFmpeg options: `rtsp_transport=tcp`
4. Browser: open `http://127.0.0.1:8000/webrtc.html?path=cam`

### "But is it running all the time?"

No. The `runOnDemand` setting means the station only spins up the converter
when someone actually tunes in, and shuts it down 10 seconds after the last
viewer leaves. Idle cost is near zero — which also means the card is free for
other apps when nobody's watching.

One quirk to expect: the feed starts when OBS activates its source (the
`runOnDemand` hook hangs off the `cam` path). If you open the browser page
*first*, you'll see "retrying…" for a moment until the converter is up — the
player already handles that automatically.
