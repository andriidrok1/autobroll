// Milestone 2: расшифровка речи с word-level таймкодами.
// video → 16kHz wav (ffmpeg) → whisper.cpp → public/transcript.json
import {installWhisperCpp, downloadWhisperModel, transcribe, toCaptions} from '@remotion/install-whisper-cpp';
import {execSync} from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const root = process.cwd();
const whisperDir = path.join(root, 'whisper.cpp');
const model = 'base.en'; // англ. видео; для мультиязычного → 'base'/'small'
const input = path.join(root, 'public', 'clip.mp4');
const wav = path.join(root, 'public', 'clip.16k.wav');
const out = path.join(root, 'public', 'transcript.json');

console.log('1/4 installing whisper.cpp (make build)...');
await installWhisperCpp({to: whisperDir, version: '1.5.5'});

console.log('2/4 downloading model:', model);
await downloadWhisperModel({model, folder: whisperDir});

console.log('3/4 extracting 16kHz mono wav...');
execSync(`ffmpeg -y -i "${input}" -ar 16000 -ac 1 "${wav}"`, {stdio: 'ignore'});

console.log('4/4 transcribing...');
const result = await transcribe({
  inputPath: wav,
  whisperPath: whisperDir,
  whisperCppVersion: '1.5.5',
  model,
  tokenLevelTimestamps: true,
});

const {captions} = toCaptions({whisperCppOutput: result});
const words = captions
  .map((c) => ({word: c.text.trim(), startMs: c.startMs, endMs: c.endMs}))
  .filter((w) => w.word.length > 0);

fs.writeFileSync(out, JSON.stringify(words, null, 2));
console.log(`\nDONE → ${out}`);
console.log(`words: ${words.length}`);
console.log('preview:', words.slice(0, 12).map((w) => w.word).join(' '));
