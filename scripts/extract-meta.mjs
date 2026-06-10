// Считает метаданные клипа (fps/размер/длительность) через ffprobe → public/meta.json.
// Раньше meta.json не генерировался ни одним скриптом (писался руками) — это чинит импорт
// произвольного видео: композиция/плеер берут размеры и длительность отсюда.
import {execSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const VIDEO = path.join(root, 'public', 'clip.mp4');
const OUT = path.join(root, 'public', 'meta.json');

if (!fs.existsSync(VIDEO)) throw new Error(`no video at ${VIDEO}`);

const probe = JSON.parse(
  execSync(
    `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate -show_entries format=duration -of json "${VIDEO}"`,
  ).toString(),
);

const stream = probe.streams[0];
const [num, den] = String(stream.r_frame_rate).split('/').map(Number);
const fps = Math.round((num / (den || 1)) * 1000) / 1000;
const durationS = parseFloat(probe.format.duration);

const meta = {
  durationInFrames: Math.max(1, Math.round(durationS * fps)),
  fps,
  width: stream.width,
  height: stream.height,
};

fs.writeFileSync(OUT, JSON.stringify(meta));
console.log(`DONE → ${OUT}`);
console.log(meta);
