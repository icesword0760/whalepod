#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
for scene in cards dag import; do
  ffmpeg -hide_banner -loglevel error -y -framerate 10 -i "frames/$scene/%03d.png" \
    -filter_complex '[0:v]split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle' \
    -loop 0 "$scene.gif"
done
