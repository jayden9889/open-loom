#!/usr/bin/env bash
# Build whisper.cpp for Open Loom's local transcription engine (SPEC T1).
#
# What it does:
#   1. Clones whisper.cpp (pinned tag) into <dest>/whisper.cpp
#   2. Builds whisper-cli with cmake when available (Metal on macOS),
#      falling back to the classic Makefile build on older checkouts
#   3. Downloads the ggml-base.en model into <dest>/models from a pinned
#      HuggingFace commit and verifies its SHA256 before installing
#   4. Prints the resolved binary + model paths as OPENLOOM_WHISPER_BIN= /
#      OPENLOOM_WHISPER_MODEL= lines that the app reads to update Settings
#
# Usage: scripts/setup-whisper.sh [--dest <dir>] [--model <name>]
#   --dest   install root (default: the OpenLoom app-support dir)
#   --model  ggml model name (default: base.en)
#
# Tag choice: modern whisper.cpp requires cmake (its Makefile is a cmake
# wrapper). When cmake is missing we fall back to v1.5.5, the last tag with a
# self-contained Makefile, whose `main` binary speaks the same CLI flags.
set -euo pipefail

CMAKE_TAG="v1.7.4"
MAKE_TAG="v1.5.5"
MODEL="base.en"
DEST=""

# ggml model repo pinned to a specific commit (not the rolling /resolve/main/)
# so the downloaded weights are reproducible and can be checksum-verified.
WHISPER_MODEL_REPO="ggerganov/whisper.cpp"
WHISPER_MODEL_COMMIT="5359861c739e955e79d9a303bcbc70fb988958b1"

while [ $# -gt 0 ]; do
  case "$1" in
    --dest)  DEST="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$DEST" ]; then
  case "$(uname -s)" in
    Darwin) DEST="$HOME/Library/Application Support/OpenLoom/whisper" ;;
    *)      DEST="${XDG_DATA_HOME:-$HOME/.local/share}/OpenLoom/whisper" ;;
  esac
fi

REPO_DIR="$DEST/whisper.cpp"
MODEL_DIR="$DEST/models"
MODEL_FILE="$MODEL_DIR/ggml-$MODEL.bin"

if command -v cmake >/dev/null 2>&1; then
  BUILDER="cmake"
  WHISPER_TAG="$CMAKE_TAG"
else
  BUILDER="make"
  WHISPER_TAG="$MAKE_TAG"
fi

echo "Installing whisper.cpp ($WHISPER_TAG via $BUILDER, model $MODEL)"
echo "Destination: $DEST"

command -v git >/dev/null 2>&1 || { echo "error: git is required but was not found." >&2; exit 1; }
if ! command -v cc >/dev/null 2>&1 && ! command -v clang >/dev/null 2>&1 && ! command -v gcc >/dev/null 2>&1; then
  echo "error: no C compiler found. On macOS run: xcode-select --install" >&2
  exit 1
fi
if [ "$BUILDER" = "make" ] && ! command -v make >/dev/null 2>&1; then
  echo "error: neither cmake nor make was found. Install cmake (cmake.org or your package manager) and run this again." >&2
  exit 1
fi

mkdir -p "$DEST" "$MODEL_DIR"

# --- 1. clone (or reuse when it matches the wanted tag) -----------------------
if [ -d "$REPO_DIR/.git" ]; then
  CURRENT="$(git -C "$REPO_DIR" describe --tags --exact-match 2>/dev/null || echo none)"
  if [ "$CURRENT" = "$WHISPER_TAG" ]; then
    echo "Reusing existing checkout at $REPO_DIR"
  else
    echo "Existing checkout is $CURRENT; replacing with $WHISPER_TAG"
    rm -rf "$REPO_DIR"
  fi
fi
if [ ! -d "$REPO_DIR/.git" ]; then
  echo "Cloning whisper.cpp $WHISPER_TAG (shallow)"
  git clone --depth 1 --branch "$WHISPER_TAG" https://github.com/ggerganov/whisper.cpp "$REPO_DIR"
fi

# --- 2. build ----------------------------------------------------------------
JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
BIN=""

find_built_binary() {
  for candidate in \
    "$REPO_DIR/build/bin/whisper-cli" \
    "$REPO_DIR/whisper-cli" \
    "$REPO_DIR/build/bin/main" \
    "$REPO_DIR/main"; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

if [ "$BUILDER" = "cmake" ]; then
  echo "Building with cmake (-j$JOBS)"
  cmake -S "$REPO_DIR" -B "$REPO_DIR/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF
  cmake --build "$REPO_DIR/build" --config Release -j "$JOBS"
else
  echo "cmake not found; building $WHISPER_TAG with make (-j$JOBS)"
  make -C "$REPO_DIR" -j "$JOBS" main
fi

BIN="$(find_built_binary)" || {
  echo "error: the build finished but no whisper binary was produced. Check the output above." >&2
  exit 1
}
echo "Built: $BIN"

# --- 3. model ------------------------------------------------------------------
# Expected SHA256 per model (the git-lfs oid at $WHISPER_MODEL_COMMIT). Present
# entries are enforced; unknown models download but are not verified.
expected_model_sha256() {
  case "$1" in
    base.en) echo "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002" ;;
    *)       echo "" ;;
  esac
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo ""
  fi
}

if [ -s "$MODEL_FILE" ]; then
  echo "Model already present: $MODEL_FILE"
else
  MODEL_URL="https://huggingface.co/$WHISPER_MODEL_REPO/resolve/$WHISPER_MODEL_COMMIT/ggml-$MODEL.bin"
  echo "Downloading model ggml-$MODEL.bin (pinned @ ${WHISPER_MODEL_COMMIT:0:12})"
  if command -v curl >/dev/null 2>&1; then
    curl -L --fail --progress-bar -o "$MODEL_FILE.part" "$MODEL_URL"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$MODEL_FILE.part" "$MODEL_URL"
  else
    echo "error: curl or wget is required to download the model." >&2
    exit 1
  fi

  # Verify integrity before trusting the file: abort (and delete) on mismatch.
  EXPECTED_SHA="$(expected_model_sha256 "$MODEL")"
  if [ -n "$EXPECTED_SHA" ]; then
    ACTUAL_SHA="$(sha256_of "$MODEL_FILE.part")"
    if [ -z "$ACTUAL_SHA" ]; then
      echo "warning: no shasum/sha256sum tool found; skipping model checksum verification." >&2
    elif [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
      rm -f "$MODEL_FILE.part"
      echo "error: model checksum mismatch for ggml-$MODEL.bin" >&2
      echo "  expected $EXPECTED_SHA" >&2
      echo "  actual   $ACTUAL_SHA" >&2
      echo "Refusing to install: the download was corrupted or the upstream file changed." >&2
      exit 1
    else
      echo "Verified model SHA256 $ACTUAL_SHA"
    fi
  else
    echo "note: no pinned checksum for model '$MODEL'; skipping verification."
  fi

  mv "$MODEL_FILE.part" "$MODEL_FILE"
fi

# --- 4. sanity + report ---------------------------------------------------------
"$BIN" --help >/dev/null 2>&1 || echo "note: the binary did not answer --help cleanly; it may still work."

echo ""
echo "whisper.cpp is ready."
echo "OPENLOOM_WHISPER_BIN=$BIN"
echo "OPENLOOM_WHISPER_MODEL=$MODEL_FILE"
