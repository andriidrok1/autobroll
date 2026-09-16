#!/usr/bin/env bash
# One-shot local setup: checks the toolchain, creates the WhisperX venv, seeds .env.
#   npm run setup            # GPU build of torch if you have an NVIDIA card (large, ~7 GB)
#   npm run setup -- --cpu   # CPU-only torch (~1 GB) — fine for short clips
set -euo pipefail
cd "$(dirname "$0")/.."

CPU_ONLY=0
for a in "$@"; do [ "$a" = "--cpu" ] && CPU_ONLY=1; done

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
miss() { printf '  \033[31m✗\033[0m %s\n' "$1"; }

echo "Checking tools"
if command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; then ok "node $(node -v)"; else miss "Node 20+ is required (https://nodejs.org)"; exit 1; fi
if command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null; then ok "ffmpeg $(ffmpeg -version | head -1 | awk '{print $3}')"; else miss "ffmpeg/ffprobe not found — apt install ffmpeg | brew install ffmpeg | winget install ffmpeg"; exit 1; fi
PY=""
for c in python3.12 python3.11 python3.10 python3; do command -v "$c" >/dev/null && PY="$c" && break; done
if [ -n "$PY" ]; then ok "$PY ($($PY -c 'import sys;print(".".join(map(str,sys.version_info[:2])))'))"; else miss "Python 3.10+ not found"; exit 1; fi

echo "Node packages"
[ -d node_modules ] || npm install --no-audit --no-fund
ok "node_modules"

echo "WhisperX (word-level transcription)"
if [ ! -x .venv/bin/whisperx ]; then
  [ -d .venv ] || "$PY" -m venv .venv
  .venv/bin/pip install -q --upgrade pip
  if [ "$CPU_ONLY" = 1 ]; then
    echo "  installing CPU-only torch…"
    .venv/bin/pip install -q torch torchaudio --index-url https://download.pytorch.org/whl/cpu
  fi
  echo "  installing whisperx (this pulls torch — a few minutes)…"
  .venv/bin/pip install -q whisperx
fi
DEV=$(.venv/bin/python -c 'import torch;print("cuda" if torch.cuda.is_available() else "cpu")' 2>/dev/null || echo cpu)
ok "whisperx ready — device: $DEV"

echo "API keys"
if [ ! -f .env ]; then cp .env.example .env; fi
if grep -q '^GEMINI_API_KEY=.\+' .env; then ok "GEMINI_API_KEY set"; else miss "GEMINI_API_KEY empty — paste a free key from https://aistudio.google.com/apikey into .env"; fi
if grep -q '^PEXELS_API_KEY=.\+' .env; then ok "PEXELS_API_KEY set"; else miss "PEXELS_API_KEY empty (optional) — https://www.pexels.com/api"; fi

echo
echo "Done. Start with:  npm start   → http://localhost:5173"
