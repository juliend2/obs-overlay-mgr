#!/usr/bin/env bash
# Starts MediaMTX (WebRTC feed) + the PHP dev server, and stops both on ctrl-c.
set -u
cd "$(dirname "$0")"

command -v ffmpeg >/dev/null || { echo "ffmpeg not installed: sudo apt install ffmpeg" >&2; exit 1; }
[ -x ./mediamtx ] || { echo "./mediamtx missing" >&2; exit 1; }

pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null; }
trap cleanup EXIT INT TERM

./mediamtx ./mediamtx.yml & pids+=($!)
php -S 127.0.0.1:8000 -t . >/dev/null 2>&1 & pids+=($!)

cat <<MSG

  webrtc  http://127.0.0.1:8000/webrtc.html                  vp8 854x480@25
          http://127.0.0.1:8000/webrtc.html?path=smooth      vp8 640x360@30
          http://127.0.0.1:8000/webrtc.html?path=mandelbrot  vp8 854x480@25
  canvas  http://127.0.0.1:8000/
  mjpeg   http://127.0.0.1:8000/mjpeg.html           (needs ./feed.sh separately)

  obs     + > Media Source > Create new, then:
            Local File        unchecked
            Input             rtsp://127.0.0.1:8554/h264     h264 1280x720@30
            Network Buffering 0 MB   <- required, else the source renders black
            FFmpeg Options    rtsp_transport=tcp

  ctrl-c to stop
MSG

wait
