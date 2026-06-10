#!/usr/bin/env bash
# Milestone 3.5: WhisperX транскрипция — точные word-таймкоды (wav2vec2 alignment)
# + prompt-биасинг доменной лексикой.
set -euo pipefail
cd "$(dirname "$0")/.."

WAV="public/clip.16k.wav"
OUTDIR="public/whisperx"

# 16kHz mono wav из клипа (если ещё нет или клип новее)
if [ ! -f "$WAV" ] || [ "public/clip.mp4" -nt "$WAV" ]; then
  echo "extracting 16kHz wav..."
  ffmpeg -y -i public/clip.mp4 -ar 16000 -ac 1 "$WAV" 2>/dev/null
fi

mkdir -p "$OUTDIR"

# prompt-биасинг: нейтральный по умолчанию, переопределяется через $AUTOBROLL_PROMPT
# (доменная лексика повышает точность редких терминов/брендов в конкретном видео)
PROMPT="${AUTOBROLL_PROMPT:-The following is a talking-head video with clear English narration. Proper nouns, product names and brands are capitalized.}"

.venv/bin/whisperx "$WAV" \
  --model small.en \
  --language en \
  --device cpu \
  --compute_type int8 \
  --output_format json \
  --output_dir "$OUTDIR" \
  --vad_onset 0.2 \
  --vad_offset 0.2 \
  --initial_prompt "$PROMPT"

# конвертация в наш формат
node scripts/whisperx-to-transcript.mjs "$OUTDIR/clip.16k.json"
