#!/usr/bin/env bash
# Installs the local voiceover engine used by the Marketing Video Agent.
#
# Piper is MIT-licensed and runs entirely offline, so no product data leaves the
# platform. The voices are downloaded once into `vendor/piper/voices` (ignored by
# git); nothing here is committed and no paid service is involved.
#
# Usage:  scripts/install-tts.sh [target-dir]
set -euo pipefail

TARGET="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/packages/server/vendor/piper}"
PIPER_VERSION="2023.11.14-2"
PIPER_URL="https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_x86_64.tar.gz"
VOICES_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main"

# One voice per supported language. `ar-TN` is deliberately absent: no
# commercially licensed Tunisian voice exists (see docs/AI-FIRST-COMPLETION-06.md).
VOICES=(
  "ar/ar_JO/kareem/medium/ar_JO-kareem-medium"
  "fr/fr_FR/upmc/medium/fr_FR-upmc-medium"
  "en/en_US/lessac/medium/en_US-lessac-medium"
  "zh/zh_CN/huayan/medium/zh_CN-huayan-medium"
)

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1" >&2; exit 1; }; }
need curl
need tar
need ffmpeg
need ffprobe

mkdir -p "$TARGET"
cd "$TARGET"

if [ ! -x ./piper/piper ]; then
  echo "downloading piper ${PIPER_VERSION}"
  curl -fsSL -o piper.tar.gz "$PIPER_URL"
  tar xzf piper.tar.gz
  # The archive nests everything under piper/; the binary resolves its
  # espeak-ng data relative to itself, so keep them side by side.
  cp -a piper/. .
  rm -rf piper piper.tar.gz
fi

mkdir -p voices
for voice in "${VOICES[@]}"; do
  name="$(basename "$voice")"
  if [ -s "voices/${name}.onnx" ] && [ -s "voices/${name}.onnx.json" ]; then
    echo "voice present: ${name}"
    continue
  fi
  echo "downloading voice: ${name}"
  curl -fsSL -o "voices/${name}.onnx" "${VOICES_BASE}/${voice}.onnx"
  curl -fsSL -o "voices/${name}.onnx.json" "${VOICES_BASE}/${voice}.onnx.json"
done

echo "smoke test"
echo "Ceci est un test de la voix WASIT." | ./piper/piper -m voices/fr_FR-upmc-medium.onnx -f /tmp/piper-smoke.wav
ffprobe -v error -show_entries format=duration -of csv=p=0 /tmp/piper-smoke.wav
rm -f /tmp/piper-smoke.wav

echo "piper ready at $TARGET"
