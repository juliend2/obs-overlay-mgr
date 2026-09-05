# obs-overlay-mgr

Web-based overlay manager for OBS.

## `overlay-manager/` — edit an OBS overlay live

Edit the text/HTML shown in an OBS Browser Source and have it update without
touching OBS. One dependency-free Node process serves the viewer OBS points
at, a manager page you edit from, and a WebSocket that pushes updates. See
`overlay-manager/README.md`.

## `testfeed/` — synthetic video sources for testing

Overlays need something moving underneath them. `testfeed/` generates test video
locally so you don't need a camera or a live stream to work on the compositing.

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



### Paths

| Path                    | Source       | Format                                                |
|-------------------------|--------------|-------------------------------------------------------|
| `?path=test` (default)  | `testsrc`    | VP8 854x480@25                                        |
| `?path=smooth`          | `testsrc`    | VP8 640x360@30                                        |
| `?path=mandelbrot`      | `mandelbrot` | VP8 854x480@25                                        |
| `?path=h264`            | `testsrc`    | H.264 720p30 — **not playable in Firefox**, see below |

Add your own in `testfeed/mediamtx.yml`. Any ffmpeg `lavfi` source works:
`testsrc`, `smptebars`, `mandelbrot`, `life`.

### Ports

| Port      |                                   |
|-----------|-----------------------------------|
| 8081/tcp  | Node app                          |
| 8554/tcp  | RTSP ingest (ffmpeg → MediaMTX)   |
| 8889/tcp  | WebRTC / WHEP playback            |
| 8189/udp  | WebRTC ICE                        |
| 8090/tcp  | MJPEG, only while `feed.sh` runs  |

## Codec and hardware constraints

The VP8 / 854x480 defaults are not arbitrary — they're forced by a pincer
between the browser and the CPU on the dev box.

**Firefox will not accept H.264 over WebRTC here.** Its SDP offer contains no
H.264 payload type at all, only VP8/VP9/rtx/ulpfec/red. This holds even though
the OpenH264 2.6.0 GMP is installed and registered — `getCapabilities()`
advertises `H264 42e01f`, but it never reaches the offer. Publishing H.264 gets
you `closed: codecs not supported by client` from MediaMTX and a `400` in the
browser.

**The CPU is slow at the codec Firefox does accept.** On a 2-core Celeron N3000
@ 1.04 GHz, measured libvpx VP8 realtime factors:

| Resolution        | Realtime factor        |
|-------------------|------------------------|
| 1280x720@30       | 0.50x — cannot keep up |
| 960x540@20        | 1.35x                  |
| **854x480@25**    | **1.33x** ← default    |
| 640x360@30        | 1.58x                  |

Meanwhile H.264 encodes at 3.3x realtime in software, and the iGPU has VAAPI
H.264 encode (but *not* VP8 — `vp8_vaapi` produces no packets). So the hardware
is fast at exactly the codec the browser refuses.

Two ways out, if 854x480 isn't enough:

- **Install Chromium.** It accepts H.264, which unlocks 720p30 at ~30% CPU, or
  near-free via VAAPI. Use `?path=h264`.
- **Switch to HLS.** Firefox decodes H.264 fine in `<video>`/MSE — that path
  uses system decoders, not the OpenH264 GMP — so 720p becomes cheap. Costs
  ~2-6s latency instead of sub-second.

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
decodes H.264 natively, so the Firefox codec limitation above does not apply —
use the full-resolution `h264` path, not the downscaled VP8 ones.

1. **+ → Media Source → Create new**
2. Uncheck **Local File**
3. **Input:** `rtsp://127.0.0.1:8554/h264`
4. **Input Format:** leave empty
5. Check **Restart playback when source becomes active**
6. Drop **Network Buffering** to the minimum for lower latency

MediaMTX spawns the encoder on demand, so the feed starts when OBS activates the
source and stops ~10s after it goes inactive.

**Browser Source** works too, for the canvas page or the WebRTC player — point it
at `http://127.0.0.1:8000/` or `.../webrtc.html`. Use this when you want to test
the overlay markup itself rather than just a moving backdrop.

### Performance

Encoding 720p H.264 and running OBS on a 2-core N3000 is tight, and OBS's own
output encoder will also be x264 — `h264_vaapi` aborts on this iGPU
(`i965_encoder.c: assertion 'encoder_context->mfc_context' failed`), so there is
no hardware encode path. Measured x264 720p30 throughput swings between 3.3x and
1.5x realtime purely with background load, and this box idles at a load average
near 6 with k3s running. If OBS drops frames, use `?path=smooth` (640x360) or
free up CPU first.

## What this does *not* do

It does not create a `/dev/video*` device. If you need OBS to list the feed
under **Video Capture Device (V4L2)**, that requires the `v4l2loopback` kernel
module, which on this machine means a kernel upgrade (headers for the running
6.12.43 are no longer in the Debian archive) plus MOK enrollment for Secure
Boot. The pages here are consumable as OBS **Browser Sources** instead.
