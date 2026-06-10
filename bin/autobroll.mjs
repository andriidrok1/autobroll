#!/usr/bin/env node
// AutoBroll CLI:  autobroll <video> [out.mp4]
// Прогоняет видео через весь pipeline (транскрипт → акценты → плейсмент) и
// рендерит mp4 с авто-субтитрами. Для интерактивной правки — `npm run editor`.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PKG = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);

if (!args[0] || args[0] === '-h' || args[0] === '--help') {
  console.log(`AutoBroll — auto-caption a talking-head video.

Usage:
  autobroll <video> [out.mp4]

What it does:
  1. transcribes the video (word-level timecodes)
  2. picks accent words + caption placement (Gemini)
  3. renders an mp4 with clean, human-looking captions

Then open the editor to tweak by hand:  npm run editor

Requirements: ffmpeg on PATH, GEMINI_API_KEY in .env.`);
  process.exit(args[0] ? 0 : 1);
}

const input = path.resolve(process.cwd(), args[0]);
if (!fs.existsSync(input)) {
  console.error(`✗ video not found: ${input}`);
  process.exit(1);
}
const out = path.resolve(process.cwd(), args[1] ?? 'autobroll-out.mp4');

const clip = path.join(PKG, 'public', 'clip.mp4');
fs.mkdirSync(path.dirname(clip), {recursive: true});
console.log(`→ ${path.basename(input)}`);
fs.copyFileSync(input, clip);
// свежий клип → старый сохранённый проект больше не релевантен
fs.rmSync(path.join(PKG, 'public', 'project.json'), {force: true});

const run = (cmd, cmdArgs) => {
  const r = spawnSync(cmd, cmdArgs, {cwd: PKG, stdio: 'inherit', env: process.env});
  if (r.status !== 0) {
    console.error(`✗ failed: ${cmd} ${cmdArgs.join(' ')}`);
    process.exit(r.status ?? 1);
  }
};

run('node', ['scripts/pipeline.mjs']);
console.log('→ rendering…');
run('npx', ['remotion', 'render', 'Captioned', out]);

console.log(`\n✓ done → ${out}`);
