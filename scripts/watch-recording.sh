#!/usr/bin/env bash
# extract frames from a screen recording so claude can Read them as images.
# usage: scripts/watch-recording.sh <video> [fps]
#   fps defaults to 1 (one frame per second). use 0.5 for one every 2s, 2 for two per second, etc.
# output: .donna/watch/<video-basename>/frame-0001.jpg ... + index.txt listing them.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <video> [fps]" >&2
  exit 1
fi

video=$1
fps=${2:-1}

if [[ ! -f $video ]]; then
  echo "not a file: $video" >&2
  exit 1
fi

base=$(basename "$video")
stem=${base%.*}
out=".donna/watch/$stem"
mkdir -p "$out"
rm -f "$out"/frame-*.jpg "$out"/index.txt

duration=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$video")

# scale long edge to 1280 to keep frames readable but small, jpg q=4 (~visually lossless-ish).
ffmpeg -hide_banner -loglevel error -i "$video" \
  -vf "fps=$fps,scale='if(gt(iw,ih),1280,-2)':'if(gt(iw,ih),-2,1280)'" \
  -q:v 4 "$out/frame-%04d.jpg"

count=$(ls "$out"/frame-*.jpg 2>/dev/null | wc -l | tr -d ' ')

{
  echo "source: $video"
  echo "duration_seconds: $duration"
  echo "fps: $fps"
  echo "frames: $count"
  echo
  i=1
  for f in "$out"/frame-*.jpg; do
    # frame i was sampled at t = (i-1)/fps seconds.
    t=$(awk -v i="$i" -v f="$fps" 'BEGIN{printf "%.2f", (i-1)/f}')
    echo "$f @ ${t}s"
    i=$((i+1))
  done
} > "$out/index.txt"

echo "wrote $count frames to $out"
echo "index: $out/index.txt"
