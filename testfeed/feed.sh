#!/usr/bin/env bash
# Serves an ffmpeg-generated MJPEG stream on http://127.0.0.1:8090/feed.mjpg
# ffmpeg's -listen 1 serves a single client then exits, so loop it.
set -u
PATTERN="${1:-testsrc}"   # testsrc | smptebars | mandelbrot | life
SIZE="${2:-1280x720}"
RATE="${3:-30}"

command -v ffmpeg >/dev/null || { echo "ffmpeg not installed: sudo apt install ffmpeg" >&2; exit 1; }

echo "serving $PATTERN ${SIZE}@${RATE} on http://127.0.0.1:8090/feed.mjpg  (ctrl-c to stop)"
while true; do
  ffmpeg -hide_banner -loglevel warning \
    -re -f lavfi -i "${PATTERN}=size=${SIZE}:rate=${RATE}" \
    -f mpjpeg -q:v 5 \
    -listen 1 -content_type 'multipart/x-mixed-replace;boundary=ffmpeg' \
    "http://127.0.0.1:8090/feed.mjpg"
  sleep 0.5
done
