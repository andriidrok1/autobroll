// Конвертер: WhisperX JSON → public/transcript.json [{word, startMs, endMs}]
// WhisperX words: {word, start, end, score}; у некоторых слов (числа и т.п.)
// может не быть start/end — интерполируем от соседей.
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const inPath = process.argv[2] ?? path.join(root, 'public', 'whisperx', 'clip.16k.json');
const outPath = path.join(root, 'public', 'transcript.json');

const data = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const raw = data.segments.flatMap((s) => s.words ?? []);

// интерполяция отсутствующих таймкодов
const words = raw.map((w, i) => {
  let start = w.start;
  let end = w.end;
  if (start == null) {
    const prev = raw.slice(0, i).reverse().find((x) => x.end != null);
    start = prev ? prev.end : 0;
  }
  if (end == null) {
    const next = raw.slice(i + 1).find((x) => x.start != null);
    end = next ? next.start : start + 0.3;
  }
  return {
    word: String(w.word).trim(),
    startMs: Math.round(start * 1000),
    endMs: Math.round(end * 1000),
  };
}).filter((w) => w.word.length > 0);

fs.writeFileSync(outPath, JSON.stringify(words, null, 2));
console.log(`DONE → ${outPath}`);
console.log(`words: ${words.length}`);
console.log('text:', words.map((w) => w.word).join(' '));
