# obs-overlay-mgr

Web-based overlay manager for OBS.

## `overlay-manager/` — edit an OBS overlay live

Edit the text/HTML shown in an OBS Browser Source and have it update without
touching OBS. One dependency-free Node process serves the viewer OBS points
at, a manager page you edit from, and a WebSocket that pushes updates. See
`overlay-manager/README.md`.

## `testfeed/` — synthetic video sources for testing

Overlays need something moving underneath them. `testfeed/` generates test video
locally so you don't need a camera or a live stream to work on the compositing —
or plug in an HDMI capture stick and feed one real signal to OBS and the browser
at the same time (see `testfeed/README.md`).

Three transports, in decreasing order of usefulness:

|            | URL            | Needs             | Latency                |
|------------|----------------|-------------------|------------------------|
| **WebRTC** | `/webrtc.html` | MediaMTX + ffmpeg | sub-second             |
| **Canvas** | `/`            | nothing           | n/a (rendered in-page) |
| **MJPEG**  | `/mjpeg.html`  | ffmpeg            | ~1s, single viewer     |

## Dependencies

```bash
sudo apt install ffmpeg

# MediaMTX is gitignored (53 MB) — fetch it once:
curl -sSL https://github.com/bluenviron/mediamtx/releases/download/v1.20.1/mediamtx_v1.20.1_linux_amd64.tar.gz \
  | tar -xz -C testfeed mediamtx
```

## Running it

1. `cd testfeed && ./start.sh` (`start.sh` runs MediaMTX.)
2. go to http://127.0.0.1:8000/webrtc.html
3. then, in OBS, add a Source > Media > 
    - uncheck "Local file"
    - paste "rtsp://127.0.0.1:8554/h264" in the "Input" field
    - set Network buffering to 0 MB
    - FFmpeg options: `rtsp_transport=tcp`

## Running the tests

```
node --test overlay-manager/test/
```

Add your own in `testfeed/mediamtx.yml`. Any ffmpeg `lavfi` source works:
`testsrc`, `smptebars`, `mandelbrot`, `life`.

## `/manager` Query Parameters

The manager page accepts these query-string options. Parameters can be
combined unless noted otherwise.

| URL or parameter | Effect | Default / notes |
|------------------|--------|----------------|
| `/manager` | Opens the manager with the camera panes shown as JPEG snapshots | Snapshot mode using the `cam` MediaMTX path |
| `/manager?path=test` | Selects the synthetic `test` MediaMTX path | Snapshot of `testsrc`, H.264 854x480@25 |
| `/manager?path=smooth` | Selects the synthetic `smooth` MediaMTX path | Snapshot of `testsrc`, H.264 640x360@30 |
| `/manager?path=mandelbrot` | Selects the synthetic `mandelbrot` MediaMTX path | Snapshot of the Mandelbrot source, H.264 854x480@25 |
| `/manager?path=h264` | Selects the synthetic `h264` MediaMTX path | Snapshot of `testsrc`, H.264 1280x720@30 |
| `/manager?path=cam` | Selects the full-resolution HDMI capture path | Snapshot by default; H.264 720p30 when live |
| `/manager?path=cam-preview` | Selects the low-resolution HDMI capture path | Snapshot by default; H.264 360p30 when live |
| `/manager?stream=1` | Replaces the JPEG snapshots with live WebRTC video | Uses `cam-preview` for the live panes |
| `/manager?stream=1&path=cam` | Shows live full-resolution camera video | Uses the `cam` path at 720p |
| `/manager?stream=1&path=test` | Shows live synthetic test video | Uses the selected MediaMTX path over WebRTC |
| `/manager?preview=off` | Hides the camera behind the staging overlay pane | The staging pane shows overlay content only |
| `/manager?path=test&preview=off` | Combines a selected snapshot source with the staging camera disabled | `stream=1` may also be added for live mode |

The `path` value selects a path configured in `testfeed/mediamtx.yml`. It can
refer to any valid MediaMTX path name, including paths added by you. Without
`stream=1`, the path is used as the source for the low-cost JPEG snapshot. With
`stream=1`, it is played as live WebRTC video. The manager targets Chromium;
H.264 WebRTC playback is not expected to work in Firefox.

The snapshot endpoint also accepts its own source parameter:

| URL | Effect |
|-----|--------|
| `/cam.jpg` | Serves the latest snapshot from the configured default source |
| `/cam.jpg?src=cam` | Captures the `cam` MediaMTX path |
| `/cam.jpg?src=test` | Captures the `test` MediaMTX path |
| `/cam.jpg?src=<path>` | Captures any path name containing only letters, numbers, `_`, or `-` |

Invalid `src` values fall back to the configured `SNAPSHOT_SOURCE`. The
snapshot grabber stops after roughly 30 seconds without requests.

### Ports

| Port      |                                   |
|-----------|-----------------------------------|
| 8081/tcp  | Node app                          |
| 8554/tcp  | RTSP ingest (ffmpeg → MediaMTX)   |
| 8889/tcp  | WebRTC / WHEP playback            |
| 8189/udp  | WebRTC ICE                        |
| 8090/tcp  | MJPEG, only while `feed.sh` runs  |

## Codec

Everything is **H.264**, and we assume **Chromium** as the browser. Chromium
plays H.264 over WebRTC (`/webrtc.html` and the manager's `stream=1` mode), and OBS's
Media Source decodes it natively over RTSP. H.264 is also much cheaper to encode
than VP8 at the same resolution, which matters on a 2-core box — so there is a
single copy of each feed, with no VP8 fallback. (Firefox will not accept H.264
over WebRTC, which is why the fallback used to exist; it is no longer a target.)

## Notes

**MediaMTX config is trimmed.** RTMP, SRT, HLS, MoQ, API and metrics are off.
RTSP keeps both UDP and TCP transports, because an RTSP reader that defaults to
UDP (OBS's Media Source) otherwise gets `461 Unsupported Transport` and has to
retry over TCP. The default RTP ports are moved to :8100/:8101.

**ffmpeg only runs while someone is watching.** Each path uses `runOnDemand`, so
the encoder spawns on the first viewer and is killed 10s after the last one
leaves. Idle cost is just MediaMTX at ~40 MB RSS.

**MJPEG needs an explicit content type.** ffmpeg's `mpjpeg` muxer writes correct
multipart data but the HTTP layer defaults to `application/octet-stream`, which
no browser renders in an `<img>`. Hence `-content_type
'multipart/x-mixed-replace;boundary=ffmpeg'` in `feed.sh`. Also, `-listen 1`
serves one client and exits when it disconnects — that's why the script loops,
and why nothing is bound to :8090 while a viewer is connected.

## Using it in OBS

OBS is not in this repo's dependencies; install it first:

```bash
flatpak install flathub com.obsproject.Studio
```

**Media Source over RTSP** is the way in. OBS's Media Source is ffmpeg-based and
decodes H.264 natively — use the `h264` test path (or the `cam` card feed).

1. **+ → Media Source → Create new**
2. Uncheck **Local File**
3. **Input:** `rtsp://127.0.0.1:8554/h264`
4. **Input Format:** leave empty
5. **Network Buffering:** `0` MB — **required**, not a tuning preference. At any
   higher value OBS completes the RTSP handshake and then never reads from the
   socket: the source stays 0x0 and renders black, with nothing logged as an
   error. The stream is fine; only this setting is wrong.
6. **FFmpeg Options:** `rtsp_transport=tcp`

MediaMTX spawns the encoder on demand, so the feed starts when OBS activates the
source and stops ~10s after it goes inactive.

**Browser Source** works too, for the canvas page or the WebRTC player — point it
at `http://127.0.0.1:8000/` or `.../webrtc.html`. Use this when you want to test
the overlay markup itself rather than just a moving backdrop.

### Performance

The test feed's encoder and OBS's own output encoder compete for the same
machine, so background load matters more than it looks: x264 throughput on the
720p path varies by more than 2x purely with what else is running. If OBS drops
frames, use the `smooth` path from the `/manager` query-parameter table above
(640x360) or free up capacity first.

Note that a black source in OBS is almost never a performance problem — check
**Network Buffering** first, per the steps above.

## Plugging in an HDMI capture card

A USB HDMI stick (game console, camera, or another laptop going in) shows up as
a device file — `/dev/video0` — that continuously produces pictures. Only one
program can read it at a time, so nothing reads it directly: one ffmpeg reads
the card and publishes to MediaMTX, which fans the feed out to OBS and the
browser simultaneously. The `cam` path in `testfeed/mediamtx.yml` is set up for
this; see `testfeed/README.md` for the full explanation.

For the quick path, run `make camconfig`. It detects the Elgato Cam Link,
checks the USB link speed, probes VAAPI when `vainfo` is available, and updates
only the generated camera section of `testfeed/mediamtx.yml`. If `vainfo` is
missing or no usable GPU encoder is found, it generates a software encoding
configuration instead. It does not restart MediaMTX; restart `testfeed/start.sh`
after reviewing the generated config.

1. **Identify the device** (one-time): run `v4l2-ctl --list-devices`
   (`sudo apt install v4l-utils` if missing). A stick lists a video device plus
   a metadata sibling. The `cam` path reads the stable by-id alias
   (`/dev/v4l/by-id/usb-Elgato_Cam_Link_4K_*-video-index0`) rather than
   `/dev/video0`, so plug order and port don't matter — re-point it there
   (`ls /dev/v4l/by-id/`) if you swap to a different card. **Use a USB 3.0
   port.** On a USB 2.0 port (480 Mbps) the card still enumerates and reports
   its modes, but never delivers a frame — check the negotiated speed with
   `lsusb -t` (you want `5000M`, not `480M`).
2. **Start the feed:** `cd testfeed && ./start.sh`
3. **In OBS: + → Media Source**
   - uncheck **Local File**
   - **Input:** `rtsp://127.0.0.1:8554/cam`
   - **Network Buffering:** `0` MB — required, same trap as above
   - **FFmpeg Options:** `rtsp_transport=tcp`

   Activating the source starts the encoder.
4. **In the browser:** open `http://127.0.0.1:8000/webrtc.html` and select a
   MediaMTX path with its `path` query parameter as documented by that player.
    The `/manager` page shows the card automatically as a ~1 fps JPEG snapshot,
    so it doesn't steal iGPU time from OBS (see "Troubleshooting rendering
    lag"). See `/manager Query Parameters` above for alternate paths and live
    video mode.

Both watch at once. The encoder starts with the first `cam` viewer, so a
browser page opened before OBS shows "retrying…" for a moment until it's up —
the player retries automatically. When nobody is watching, ffmpeg stops and
the card is free for other apps.

## What this does *not* do

It does not create a `/dev/video*` device. If you need OBS to list the feed
under **Video Capture Device (V4L2)**, that requires the `v4l2loopback` kernel
module, which on this machine means a kernel upgrade (headers for the running
6.12.43 are no longer in the Debian archive) plus MOK enrollment for Secure
Boot. The pages here are consumable as OBS **Browser Sources** instead.

## Troubleshooting rendering lag

"Rendering lag" in OBS means the GPU render thread can't keep up. On this box
the usual cause is that the iGPU is *shared*: OBS, Chromium (the `/manager`
tab) and the ffmpeg encoders all run on the same Intel HD 4400. What helps, in
order:

- **Keep `/manager` on its default snapshot view.** It shows the camera as a
  1 fps JPEG (~0.08 core, effectively no GPU) instead of a live video, because
  decoding live video in the browser was worth >5% rendering lag on its own.
  Only enable the manager's live `stream=1` mode if you need motion; prefer its
  default low-resolution live path over `stream=1&path=cam` (720p).
- **Turn off OBS's own preview panes.** Studio Mode renders the scene twice
  (preview + program) and the normal preview adds a second render on top; you
  already have `/manager` for that. Right-click the preview → uncheck *Enable
  Preview*; the Studio Mode button is bottom-right.
- **Run `/manager` on another machine on the LAN** when you can — it's just a
  web page at `http://192.168.100.162:8081/manager`, so a laptop/tablet removes
  Chromium from this box entirely. Biggest single win.
- The `cam-preview` transcode only runs for the manager's live `stream=1` mode; with the default
  snapshot it costs nothing.

## TODO

- [x] faire une animation de transition quand on 'go live' avec un preset pour
  que ce soit smooth
- [ ] reduire le delay pour le double click a 200ms ou moins
- [ ] p-e reduire la taille de texte des presets quand ils ont au dessus d'un
  threshold de nombre de lignes, pour que ca rentre dans le viewport
- [ ] ajouter un undo pour quand on Delete un preset par erreur
