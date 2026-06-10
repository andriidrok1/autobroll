// Адаптивный плейсмент: ffmpeg находит склейки → кадр из середины каждой
// сцены → Gemini vision выбирает зону для субтитров → public/placement.json
// Формат: [{fromMs, toMs, topPct}]
import {execSync} from 'node:child_process';
import fs from 'node:fs';
import {gemini} from './gemini.mjs';

const VIDEO = 'public/clip.mp4';
const TMP = 'out/scenes';
fs.mkdirSync(TMP, {recursive: true});

// 1. длительность
const durationS = parseFloat(
  execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${VIDEO}"`).toString(),
);

// 2. склейки (scene change > 0.3)
const log = execSync(
  `ffmpeg -i "${VIDEO}" -vf "select='gt(scene,0.3)',showinfo" -f null - 2>&1 | grep showinfo | grep -o "pts_time:[0-9.]*" || true`,
).toString();
const cuts = log.split('\n').filter(Boolean).map((l) => parseFloat(l.replace('pts_time:', '')));

// 3. сцены = интервалы между склейками
const bounds = [0, ...cuts, durationS];
const scenes = [];
for (let i = 0; i < bounds.length - 1; i++) {
  if (bounds[i + 1] - bounds[i] > 0.4) scenes.push({start: bounds[i], end: bounds[i + 1]});
}
console.log(`scenes: ${scenes.length} (cuts at: ${cuts.map((c) => c.toFixed(1)).join(', ') || 'none'})`);

// 4. кадр из середины каждой сцены (уменьшенный — для vision хватает)
scenes.forEach((s, i) => {
  const mid = (s.start + s.end) / 2;
  execSync(`ffmpeg -y -ss ${mid} -i "${VIDEO}" -frames:v 1 -vf scale=540:-1 ${TMP}/scene${i}.jpg 2>/dev/null`);
});

// 5. Gemini vision: зона для каждой сцены
const ZONES = {center: 50, chest: 66, lower: 78};

const PROMPT = `You are a short-form video editor deciding where to place captions in each shot.

I will show you ${scenes.length} frames, one per scene of a vertical (9:16) video, in order.

For each frame, pick the best caption zone:
- "center" — middle of the screen (50% height). Use when the middle is visually calm/empty.
- "chest" — chest level (66% height). Use for talking-head shots where the face occupies the upper half.
- "lower" — lower area (78% height). Use when both center and chest would cover important content (faces, text on screen, UI being demonstrated).

Rules:
- NEVER place captions over a face or over on-screen text/numbers the viewer needs to read.
- For screen recordings (terminals, charts, tables): pick the zone with the least important content.
- Prefer consistency: if two adjacent shots are similar, give them the same zone.

Return one entry per frame, in order.`;

const schema = {
  type: 'OBJECT',
  properties: {
    placements: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          scene: {type: 'INTEGER'},
          zone: {type: 'STRING', enum: ['center', 'chest', 'lower']},
          reason: {type: 'STRING'},
        },
        required: ['scene', 'zone', 'reason'],
      },
    },
  },
  required: ['placements'],
};

const parts = [{text: PROMPT}];
scenes.forEach((_, i) => parts.push({imagePath: `${TMP}/scene${i}.jpg`}));

const result = await gemini(parts, schema);

const placement = scenes.map((s, i) => {
  const p = result.placements.find((x) => x.scene === i) ?? result.placements[i];
  const zone = p?.zone ?? 'chest';
  console.log(`  scene ${i} [${s.start.toFixed(1)}-${s.end.toFixed(1)}s] → ${zone} — ${p?.reason ?? 'fallback'}`);
  return {fromMs: Math.round(s.start * 1000), toMs: Math.round(s.end * 1000), topPct: ZONES[zone]};
});

fs.writeFileSync('public/placement.json', JSON.stringify(placement, null, 2));
console.log(`DONE → public/placement.json (${placement.length} scenes)`);
