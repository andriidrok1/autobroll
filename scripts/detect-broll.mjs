// Детекция B-roll моментов через Gemini.
// transcript.json → Gemini (где визуал усилит + что искать + формат) → public/broll-plan.json
import fs from 'node:fs';
import {gemini} from './gemini.mjs';

const words = JSON.parse(fs.readFileSync('public/transcript.json', 'utf8'));
const indexed = words.map((w, i) => `${i}:${w.word}`).join(' ');

const PROMPT = `You are a senior short-form video editor adding B-roll (stock footage/images) to a talking-head video.

Transcript (each word prefixed by index):
${indexed}

Pick moments where a visual would genuinely strengthen the message — like a great editor. For each, give a Pexels search query.

Rules (follow strictly):
- Be SPARING: roughly 1 visual per 8-12 seconds of speech. Too much B-roll looks cheap.
- Only when a concrete, visualizable noun/concept is mentioned (a thing, place, object, action) — NOT abstract filler.
- query: 2-4 words, concrete, in English, what stock footage to search (e.g. "stock market chart", "person coding laptop").
- kind: "video" for dynamic concepts/actions, "image" for static things.
- mode: "fullscreen" (cutaway, hides face ~2s), "inset" (small corner, face stays), "top" (upper half). Choose what fits the moment; prefer "fullscreen" for strong cutaways, "inset" when face matters.
- startIdx/endIdx: word index range to show the visual over (keep it ~1.5-3s of words).`;

const schema = {
  type: 'OBJECT',
  properties: {
    broll: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          startIdx: {type: 'INTEGER'},
          endIdx: {type: 'INTEGER'},
          query: {type: 'STRING'},
          kind: {type: 'STRING', enum: ['video', 'image']},
          mode: {type: 'STRING', enum: ['fullscreen', 'inset', 'top']},
          reason: {type: 'STRING'},
        },
        required: ['startIdx', 'endIdx', 'query', 'kind', 'mode', 'reason'],
      },
    },
  },
  required: ['broll'],
};

const result = await gemini([{text: PROMPT}], schema);

const plan = result.broll
  .filter((b) => words[b.startIdx] && words[b.endIdx])
  .map((b, i) => ({
    id: `b${i}`,
    startMs: words[b.startIdx].startMs,
    endMs: words[b.endIdx].endMs,
    query: b.query,
    kind: b.kind,
    mode: b.mode,
    reason: b.reason,
  }));

fs.writeFileSync('public/broll-plan.json', JSON.stringify(plan, null, 2));
console.log(`DONE → public/broll-plan.json (${plan.length} visuals)`);
plan.forEach((b) => console.log(`  ${(b.startMs / 1000).toFixed(1)}s [${b.kind}/${b.mode}] "${b.query}" — ${b.reason}`));
