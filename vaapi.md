# VA-API hardware video decode on Intel Haswell (HD 4400)

Notes on why Chromium's live WebRTC preview (`/manager?stream=1`) can still
burn a full CPU core even though `chrome://gpu` reports "Video Decode:
Hardware accelerated", and how to actually fix it.

## Symptom

- `chrome://gpu` → **Video Decode: Hardware accelerated**.
- But launching Chromium from a terminal logs:
  ```
  libva error: /usr/lib/x86_64-linux-gnu/dri/iHD_drv_video.so init failed
  ```
- CPU usage while the live preview pane is open matches *software* decode,
  not hardware.

## Root cause

- The laptop's GPU is an **Intel HD 4400**, which is **Haswell / Gen 7.5**.
- `iHD_drv_video.so` is the **`intel-media-driver`** package. It only
  supports **Gen 8 (Broadwell) and later** — it was never meant to drive a
  Haswell chip, so it fails to initialize on this machine.
- `i965_drv_video.so` is the **older `i965-va-driver`** package (sometimes
  named `libva-intel-driver`), which is the correct VA-API driver for
  Haswell and earlier.
- Modern `libva` (2.x) auto-detects which driver `.so` to load based on the
  PCI device ID. On several distros that auto-detection incorrectly points
  Haswell at `iHD` instead of `i965`. libva tries `iHD`, fails (the error
  above), and **does not automatically retry `i965`** — it just gives up,
  and Chromium silently falls back to software decode for that session.
- `chrome://gpu`'s "Video Decode: Hardware accelerated" line is a *static*
  capability/blocklist check ("this GPU generation is allowed to attempt
  hardware decode"), **not** a live confirmation that the VAAPI call
  actually succeeded. That's why the status page and the real runtime log
  disagree.

## Verifying on the affected machine

`testfeed/camconfig.js` automatically performs this probe when `vainfo` is
installed. If `vainfo` is missing, it fails gracefully and generates a
software-encoding configuration; the commands below remain useful for
diagnosing a machine where VAAPI probing fails.

Run these **on the i3 laptop itself** (not on a dev machine — the fix is
specific to that GPU):

```bash
# 1. Confirm the GPU and that the correct driver package is installed
lspci -nnk | grep -A3 -i "vga\|display"
dpkg -l | grep -i va-driver   # or: rpm -qa | grep -i va-driver
# expect i965-va-driver (or libva-intel-driver) to be present;
# install it first if it's missing.

# 2. Reproduce the failure, then test the fix side by side
vainfo
echo "---- now forcing i965 ----"
LIBVA_DRIVER_NAME=i965 vainfo
```

The first `vainfo` run should reproduce the `iHD_drv_video.so init failed`
error. The second should succeed and print a driver string like
`vainfo: Driver version: ... Intel i965 driver`, followed by a profile list
including lines such as:

```
VAProfileH264Main    : VAEntrypointVLD
VAProfileH264High    : VAEntrypointVLD
```

`VAEntrypointVLD` = hardware decode supported for that profile.

## Applying the fix

```bash
LIBVA_DRIVER_NAME=i965 chromium --enable-features=VaapiVideoDecoder 2>&1 | grep -i vaapi
```

(substitute the actual binary name — `chromium-browser`, `google-chrome`,
etc.) Watch for VAAPI errors in the log, reopen `chrome://gpu` to sanity
check, then compare real CPU usage (`top`/`htop`) with the `/manager` live
preview pane open, against a run without the env var.

If CPU usage drops meaningfully, make it permanent by baking
`LIBVA_DRIVER_NAME=i965` into however Chromium gets launched on that
laptop:

- the `Exec=` line of its `.desktop` launcher, or
- `~/.profile` / `~/.bashrc` if it's launched from a terminal / i3 config
  `exec` line, or
- a `systemd --user` environment.d drop-in if launched via i3 autostart.

## If this doesn't fix it

If `i965` still doesn't give hardware decode (or the CPU win is too small),
the next cheapest option is **not** a full native rewrite of `/manager` —
it's swapping only the video pane for a native player with a mature VAAPI
path (`mpv`, or GStreamer's `vaapih264dec`/`vaapisink`), pointed directly at
the MediaMTX RTSP feed, while keeping the rest of `/manager` (presets,
layers, websocket reload) as the existing browser page. Electron/Tauri
wrappers would **not** help here — Electron embeds the same Chromium engine
with the same VA-API limitation, and Tauri's Linux webview (WebKitGTK) has
its own, also inconsistent, hardware decode story.
