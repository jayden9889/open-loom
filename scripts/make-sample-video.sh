#!/usr/bin/env bash
# Generate a 5s 1080p H.264/AAC test video (colour bars + 440Hz tone).
# Usage: scripts/make-sample-video.sh [output.mp4]
set -euo pipefail

OUT="${1:-test-assets/sample.mp4}"
mkdir -p "$(dirname "$OUT")"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "error: ffmpeg not found on PATH. Install it or run scripts/fetch-ffmpeg.mjs first." >&2
  exit 1
fi

ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "testsrc2=size=1920x1080:rate=30:duration=5" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=5" \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p \
  -c:a aac -b:a 128k \
  -movflags +faststart \
  "$OUT"

echo "wrote $OUT"
