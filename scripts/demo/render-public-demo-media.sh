#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
CAPTURE_INPUT=${1:-"$REPO_ROOT/artifacts/media/supplysentry-demo"}
if [ -d "$CAPTURE_INPUT" ]; then
  CAPTURE_DIR=$CAPTURE_INPUT
else
  CAPTURE_DIR=$(CDPATH= cd -- "$(dirname -- "$CAPTURE_INPUT")" && pwd)
fi
ASSET_DIR="$REPO_ROOT/docs/assets"
REPORT_DIR="$REPO_ROOT/reports/demo"
MP4="$CAPTURE_DIR/supplysentry-walkthrough.mp4"
GIF="$ASSET_DIR/supplysentry-demo.gif"
POSTER="$ASSET_DIR/supplysentry-demo-poster.png"

command -v ffmpeg >/dev/null 2>&1 || { printf 'ffmpeg is required\n' >&2; exit 1; }
command -v ffprobe >/dev/null 2>&1 || { printf 'ffprobe is required\n' >&2; exit 1; }
command -v node >/dev/null 2>&1 || { printf 'node is required\n' >&2; exit 1; }
test -f "$CAPTURE_DIR/frames.ffconcat" || { printf 'Missing capture manifest frames\n' >&2; exit 1; }
test -f "$CAPTURE_DIR/capture-manifest.json" || { printf 'Missing capture manifest\n' >&2; exit 1; }

duration=$(node -e 'const fs=require("node:fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).durationSeconds;if(!Number.isFinite(value)||value<60||value>90)process.exit(2);process.stdout.write(String(value));' "$CAPTURE_DIR/capture-manifest.json")

mkdir -p "$ASSET_DIR" "$REPORT_DIR"

ffmpeg -hide_banner -loglevel error -y \
  -f concat -safe 0 -i "$CAPTURE_DIR/frames.ffconcat" \
  -t "$duration" \
  -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=white,fps=30" \
  -c:v libx264 -preset medium -crf 21 -pix_fmt yuv420p -movflags +faststart -map_metadata -1 "$MP4"

ffmpeg -hide_banner -loglevel error -y -ss 0 -t 18 -i "$MP4" \
  -filter_complex "fps=8,scale=1280:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" \
  -loop 0 "$GIF"

install -m 0644 "$CAPTURE_DIR/poster.png" "$POSTER"

gif_size=$(wc -c < "$GIF" | tr -d ' ')
test "$gif_size" -lt 8388608 || { printf 'GIF exceeds 8 MiB: %s bytes\n' "$gif_size" >&2; exit 1; }

ffprobe -v error -show_entries format=duration,size:stream=codec_name,width,height,pix_fmt -of json "$MP4"
ffprobe -v error -show_entries format=duration,size:stream=codec_name,width,height,pix_fmt -of json "$GIF"
printf 'Rendered %s, %s, and %s\n' "$MP4" "$GIF" "$POSTER"
