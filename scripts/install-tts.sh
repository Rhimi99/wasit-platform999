#!/usr/bin/env bash
# Installs and verifies the local voiceover engine used by the Marketing Video Agent.
#
# Piper is MIT-licensed and runs entirely offline, so no product data leaves the
# platform. The engine and the voices are downloaded once into
# `packages/server/vendor/piper` (git-ignored); nothing here is committed and no
# paid service is involved.
#
# Usage:  scripts/install-tts.sh [--check] [--force] [target-dir]
#   --check   verify an existing installation without downloading anything
#   --force   re-download the engine and every voice
#
# Prerequisites: curl, tar, node, and ffmpeg (system package, or the bundled
# ffmpeg-static that `npm run media:setup` installs). ffprobe is not required:
# WAV output is verified with `scripts/verify-wav.mjs`.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="install"
FORCE=0
TARGET=""
for arg in "$@"; do
  case "$arg" in
    --check) MODE="check" ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) TARGET="$arg" ;;
  esac
done
TARGET="${TARGET:-$REPO_ROOT/packages/server/vendor/piper}"

PIPER_VERSION="2023.11.14-2"
VOICES_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main"

# One voice per supported language. `ar-TN` is deliberately absent: no
# commercially licensed Tunisian voice exists (see docs/AI-FIRST-COMPLETION-06.md).
VOICES=(
  "ar/ar_JO/kareem/medium/ar_JO-kareem-medium"
  "fr/fr_FR/upmc/medium/fr_FR-upmc-medium"
  "en/en_US/lessac/medium/en_US-lessac-medium"
  "zh/zh_CN/huayan/medium/zh_CN-huayan-medium"
)

die() { echo "error: $*" >&2; exit 1; }
note() { echo "==> $*"; }

case "$(uname -m)" in
  x86_64|amd64) PIPER_ARCH="x86_64" ;;
  aarch64|arm64) PIPER_ARCH="aarch64" ;;
  armv7l) PIPER_ARCH="armv7l" ;;
  *) die "unsupported architecture $(uname -m): piper ${PIPER_VERSION} ships x86_64, aarch64 and armv7l builds only" ;;
esac
PIPER_URL="https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_${PIPER_ARCH}.tar.gz"

# --- ffmpeg -----------------------------------------------------------------
# The engine does not need ffmpeg, but the app converts and joins clips with it.
# Prefer a system ffmpeg; otherwise install and use the bundled one so a clean
# checkout works without root.
FFMPEG_BIN=""
resolve_ffmpeg() {
  if command -v ffmpeg >/dev/null 2>&1; then
    FFMPEG_BIN="$(command -v ffmpeg)"
    return 0
  fi
  if [ -x "$REPO_ROOT/node_modules/ffmpeg-static/ffmpeg" ]; then
    FFMPEG_BIN="$REPO_ROOT/node_modules/ffmpeg-static/ffmpeg"
    return 0
  fi
  if [ "$MODE" = "check" ]; then
    return 1
  fi
  note "no system ffmpeg; installing the bundled ffmpeg-static"
  node "$REPO_ROOT/scripts/setup-ffmpeg-static.mjs" || return 1
  FFMPEG_BIN="$REPO_ROOT/node_modules/ffmpeg-static/ffmpeg"
  [ -x "$FFMPEG_BIN" ] || return 1
}

command -v curl >/dev/null 2>&1 || die "missing required tool: curl"
command -v tar >/dev/null 2>&1 || die "missing required tool: tar"
command -v node >/dev/null 2>&1 || die "missing required tool: node"
resolve_ffmpeg || die "no ffmpeg found: install the system package (apt-get install ffmpeg) or run 'npm run media:setup'"
note "ffmpeg: $FFMPEG_BIN"

# --- engine -----------------------------------------------------------------
verify_engine() {
  local bin="$TARGET/piper"
  [ -f "$bin" ] || { echo "piper binary missing at $bin" >&2; return 1; }
  [ -x "$bin" ] || { echo "piper binary is not executable at $bin" >&2; return 1; }
  local reported
  reported="$("$bin" --version 2>/dev/null | head -n 1)" || true
  case "$reported" in
    1.*) ;;
    *) echo "piper does not run (reported '${reported:-nothing}'); the build may not match $(uname -m)" >&2; return 1 ;;
  esac
  local lib
  for lib in libonnxruntime.so libpiper_phonemize.so libespeak-ng.so; do
    [ -e "$TARGET/$lib" ] || { echo "missing shared library $lib next to piper" >&2; return 1; }
  done
  [ -d "$TARGET/espeak-ng-data" ] || { echo "missing espeak-ng-data directory" >&2; return 1; }
  echo "piper ${reported} (${PIPER_ARCH})"
}

if [ "$MODE" = "install" ]; then
  mkdir -p "$TARGET"
  if [ "$FORCE" = "1" ] || [ ! -x "$TARGET/piper" ]; then
    note "downloading piper ${PIPER_VERSION} (${PIPER_ARCH})"
    tmp="$(mktemp -d)"
    curl -fsSL -o "$tmp/piper.tar.gz" "$PIPER_URL"
    size=$(wc -c < "$tmp/piper.tar.gz")
    [ "$size" -gt 1000000 ] || die "piper archive is only ${size} bytes — download truncated"
    # The archive nests everything under piper/. Strip that level while
    # extracting so the binary lands at ./piper next to the espeak-ng data and
    # shared libraries it resolves relative to itself — the layout the app
    # expects (vendor/piper/piper). Flattening afterwards with `cp -a piper/. .`
    # cannot work: the archive's `piper` entry collides with its own directory.
    rm -rf "$TARGET/piper"
    tar xzf "$tmp/piper.tar.gz" -C "$TARGET" --strip-components=1
    chmod +x "$TARGET/piper"
    rm -rf "$tmp"
  fi
elif [ ! -d "$TARGET" ]; then
  die "no voiceover engine at $TARGET (run scripts/install-tts.sh)"
fi

note "engine: $(verify_engine)"

# --- voices -----------------------------------------------------------------
mkdir -p "$TARGET/voices"
for voice in "${VOICES[@]}"; do
  name="$(basename "$voice")"
  model="$TARGET/voices/${name}.onnx"
  config="$TARGET/voices/${name}.onnx.json"
  if [ "$MODE" = "install" ] && { [ "$FORCE" = "1" ] || [ ! -s "$model" ] || [ ! -s "$config" ]; }; then
    note "downloading voice: ${name}"
    curl -fsSL -o "$model" "${VOICES_BASE}/${voice}.onnx"
    curl -fsSL -o "$config" "${VOICES_BASE}/${voice}.onnx.json"
  fi
  [ -s "$model" ] || die "voice model missing: $model"
  [ -s "$config" ] || die "voice config missing: $config"
  bytes=$(wc -c < "$model")
  [ "$bytes" -gt 1000000 ] || die "voice model ${name} is only ${bytes} bytes — download truncated"
  node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$config" \
    || die "voice config ${name}.onnx.json is not valid JSON"
done

# --- proof: every voice must actually speak ---------------------------------
# A model file on disk is not evidence; each voice is asked to speak a real
# sentence and the resulting WAV is checked for PCM format, duration and level.
smoke_dir="$(mktemp -d)"
trap 'rm -rf "$smoke_dir"' EXIT
for voice in "${VOICES[@]}"; do
  name="$(basename "$voice")"
  wav="$smoke_dir/${name}.wav"
  case "$name" in
    ar_JO-*) line="هذا اختبار لصوت وسيط." ; min=0.8 ;;
    fr_FR-*) line="Ceci est un test de la voix WASIT." ; min=1.0 ;;
    en_US-*) line="This is a WASIT voice test." ; min=0.8 ;;
    zh_CN-*) line="这是 WASIT 语音测试。" ; min=0.5 ;;
    *) line="Test." ; min=0.3 ;;
  esac
  printf '%s\n' "$line" | "$TARGET/piper" -m "$TARGET/voices/${name}.onnx" -f "$wav" 2>/dev/null >/dev/null \
    || die "voice ${name} could not synthesize speech"
  printf '    %s -> ' "$name"
  node "$REPO_ROOT/scripts/verify-wav.mjs" "$wav" --min-seconds "$min" --expect-rate 22050 \
    || die "voice ${name} produced invalid audio"
done

note "voiceover engine ready at $TARGET"
