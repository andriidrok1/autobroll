// Auto-arrange clips into a coherent narrative order by listening to each clip.
//
// Input : JSON file (argv[2]) = {clips:[{id,src,...}]}
// Steps : transcribe every clip (cached — same cache the captions pipeline uses,
//         so we never transcribe twice) → Gemini orders them into one coherent
//         story, grouping retakes of the same line next to each other.
// Output: public/clip-order.json = {order:[clipId,...]}
import fs from 'node:fs';
import path from 'node:path';
import {gemini} from './gemini.mjs';
import {transcribeClip, transcribeClips} from './lib-transcribe.mjs';

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, 'public');
const progress = (pct, label) => console.log(`PROGRESS:${pct}:${label}`);

const {clips} = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!clips?.length) { console.error('no clips'); process.exit(1); }

progress(2, 'Starting');
transcribeClips(clips, (label) => progress(5, label)); // one whisperx run for all uncached sources
// transcribe each clip (populates the shared cache → captions reuse it)
const texts = clips.map((clip, i) => {
  progress(5 + Math.round((i / clips.length) * 80), `Listening to ${clip.label ?? clip.id} (${i + 1}/${clips.length})`);
  try {
    const words = transcribeClip(clip);
    return {id: clip.id, text: words.map((w) => w.word).join(' ').trim()};
  } catch (e) {
    console.error(`SKIP clip ${clip.id}: ${String(e).slice(0, 160)}`);
    return {id: clip.id, text: ''};
  }
});

progress(88, 'Ordering clips');
const listing = texts.map((t, i) => `[${i}] (${t.id}): ${t.text || '(no speech)'}`).join('\n');
const PROMPT = `You are a senior short-form video editor. Below are raw clips from ONE talking-head video, each with its transcript. Many are RETAKES of the same line (the creator recorded a sentence several times).

Clips:
${listing}

Order ALL clips into a single coherent narrative — the natural flow of the script from hook to conclusion. Put retakes of the SAME line next to each other. Keep every clip exactly once.

Also: for each GROUP of retakes of the same line/beat, pick the SINGLE best take — the most fluent one, no false starts, no mid-sentence restarts/repeats, most complete delivery. List those winners in "best" (one per distinct beat). A beat recorded only once is its own best.

Return:
- "order": array of clip indices in the new narrative order (a permutation of 0..${texts.length - 1}).
- "best": array of clip indices to KEEP (the winning take per beat). Subset of order.`;

const schema = {
  type: 'OBJECT',
  properties: {
    order: {type: 'ARRAY', items: {type: 'INTEGER'}},
    best: {type: 'ARRAY', items: {type: 'INTEGER'}},
  },
  required: ['order', 'best'],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let order = null;
let best = null;
for (let attempt = 0; attempt < 4 && !order; attempt++) {
  try {
    const result = await gemini([{text: PROMPT}], schema);
    const idx = result.order;
    // validate: must be a permutation of all indices
    const valid = Array.isArray(idx) && idx.length === texts.length && new Set(idx).size === texts.length && idx.every((n) => n >= 0 && n < texts.length);
    if (!valid) throw new Error('not a permutation: ' + JSON.stringify(idx));
    order = idx.map((n) => texts[n].id);
    const bestIdx = Array.isArray(result.best) ? result.best.filter((n) => n >= 0 && n < texts.length) : idx;
    best = [...new Set(bestIdx)].map((n) => texts[n].id);
    if (!best.length) best = order; // safety: never suggest removing everything
  } catch (e) {
    const msg = String(e);
    if (/\b(503|429|500|UNAVAILABLE|high demand)\b/i.test(msg) && attempt < 3) {
      const wait = 2000 * (attempt + 1);
      console.error(`ordering attempt ${attempt + 1} failed (${msg.slice(0, 60)}…), retry in ${wait}ms`);
      await sleep(wait);
      continue;
    }
    console.error('ordering failed, keeping original order:', msg.slice(0, 200));
    order = clips.map((c) => c.id); // fallback: unchanged
    best = order;
  }
}

fs.writeFileSync(path.join(PUBLIC, 'clip-order.json'), JSON.stringify({order, best}, null, 2));
progress(100, `Done — ${order.length} ordered, ${best.length} best`);
