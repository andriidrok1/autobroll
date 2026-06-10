// Оркестратор всего pipeline: video (public/clip.mp4) → субтитры в редакторе.
// Один вход для CLI (bin/autobroll.mjs) и сервера (/api/import).
// Печатает строки "STEP:<id>:<label>" — сервер парсит их в прогресс.
//
// Транскрипция: предпочитает WhisperX (точнее, нужен .venv с python), иначе
// падает на pure-Node whisper.cpp (без python — важно для `npx autobroll`).
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const hasWhisperX = fs.existsSync(path.join(root, '.venv', 'bin', 'whisperx'));

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, {cwd: root, stdio: 'inherit', env: process.env});
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} → exit ${r.status}`);
};

const step = (id, label) => console.log(`STEP:${id}:${label}`);

// 1. метаданные клипа (fps/размер/длительность)
step('meta', 'Reading video metadata');
run('node', ['scripts/extract-meta.mjs']);

// 2. транскрипт с word-таймкодами
if (hasWhisperX) {
  step('transcribe', 'Transcribing (WhisperX)');
  run('bash', ['scripts/transcribe-whisperx.sh']);
} else {
  step('transcribe', 'Transcribing (whisper.cpp)');
  run('node', ['scripts/transcribe.mjs']);
}

// 3. акценты (Gemini)
step('accents', 'Detecting accent words');
run('node', ['scripts/detect-accents.mjs']);

// 4. плейсмент субтитров по сценам (Gemini vision)
step('placement', 'Choosing caption placement');
run('node', ['scripts/detect-placement.mjs']);

step('done', 'Pipeline complete');
console.log('PIPELINE_OK');
