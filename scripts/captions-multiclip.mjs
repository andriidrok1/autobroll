// In-browser caption generation for the assembled multi-clip timeline.
//
// Input : a JSON file (argv[2]) = {clips:[{id,src,inSec,outSec,...}]} — the
//         editor's CURRENT cut (trim + order).
// Steps : 1) transcribe each source clip with WhisperX (cached per clip),
//         2) map words onto the assembled/trimmed timeline,
//         3) Gemini accent detection,
//         4) build Caption[] → public/captions.multi.json
// Output: PROGRESS:<pct>:<label> lines on stdout for the server to relay.
import fs from 'node:fs';
import path from 'node:path';
import {gemini} from './gemini.mjs';
import {assembleWords} from './lib-transcribe.mjs';

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, 'public');

const progress = (pct, label) => console.log(`PROGRESS:${pct}:${label}`);

const clipsFile = process.argv[2];
const {clips} = JSON.parse(fs.readFileSync(clipsFile, 'utf8'));
if (!clips?.length) {
  console.error('no clips');
  process.exit(1);
}

// --- accents (Gemini) ---
async function detectAccents(words) {
  const indexed = words.map((w, i) => `${i}:${w.word}`).join(' ');
  const PROMPT = `You are a senior short-form video editor. Below is a transcript of a talking-head video, each word prefixed with its index.

Pick which words deserve an ACCENT (gold highlight) — like a human editor.
- Be VERY sparing: 5-12% of words max. Restraint looks human-made.
- Accent only MEANING words: bold claims, numbers, key features, emotional peaks, the punchline, CTAs, brand/product names.
- NEVER accent: articles, prepositions, fillers, pronouns, auxiliaries.
- Prefer 1 per sentence, max 2 for long ones. Some sentences get zero.

Transcript:
${indexed}

Return accents as JSON.`;
  const schema = {
    type: 'OBJECT',
    properties: {
      accents: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {index: {type: 'INTEGER'}, word: {type: 'STRING'}},
          required: ['index', 'word'],
        },
      },
    },
    required: ['accents'],
  };
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9%$]/gi, '');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // retry transient 503/429 (Gemini "high demand") with backoff
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const result = await gemini([{text: PROMPT}], schema);
      return result.accents.filter((a) => words[a.index] && norm(words[a.index].word) === norm(a.word)).map((a) => a.index);
    } catch (e) {
      const msg = String(e);
      const transient = /\b(503|429|500|UNAVAILABLE|high demand)\b/i.test(msg);
      if (transient && attempt < 3) {
        const wait = 2000 * (attempt + 1);
        console.error(`accent attempt ${attempt + 1} failed (${msg.slice(0, 60)}…), retrying in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      console.error('accent detection failed, continuing without accents:', msg.slice(0, 200));
      return [];
    }
  }
  return [];
}

// --- buildCaptions (phrase-aware grouping) ---
const MAX_WORDS = 5;
const GAP_MS = 450; // break on natural pauses (sentence rhythm)
const DEFAULT_TOP = 58;
const PUNCT_ONLY = /^[.,!?;:()\-—]+$/;
const SENT_END = /[.!?]$/;
const CLAUSE_END = /[,;:]$/; // soft break after a clause
const toDisplay = (w) => w.replace(/[.,;:]+$/g, '').replace(/^[.,;:]+/g, '');
// function/glue words we should never leave dangling at the end of a line
const GLUE = new Set([
  'a', 'an', 'the', 'of', 'to', 'and', 'or', 'but', 'in', 'on', 'at', 'for', 'with', 'from', 'by',
  'is', 'was', 'are', 'were', 'be', 'been', 'that', 'this', 'it', 'its', 'as', 'so', 'my', 'your',
  'i', 'we', 'you', 'they', 'he', 'she', 'has', 'have', 'had', 'will', "it's", 'about', 'into',
]);

function buildCaptions(words, accentIdx) {
  const acc = new Set(accentIdx);
  const pages = [];
  let cur = [];
  let curClip = null;
  let skipParen = false;
  // store SOURCE-RELATIVE times (srcStartMs/srcEndMs) + clipId so captions stay
  // anchored to their clip; absolute positions come from projectCaptions later.
  const flush = () => {
    if (cur.length) {
      pages.push({clipId: curClip, words: cur, start: cur[0].startMs, end: cur[cur.length - 1].endMs});
      cur = [];
    }
  };
  words.forEach((w, i) => {
    if (w.word === '(') { skipParen = true; flush(); return; }
    if (w.word === ')') { skipParen = false; return; }
    if (skipParen || PUNCT_ONLY.test(w.word)) return;
    const display = toDisplay(w.word);
    if (!display) return;

    if (curClip !== null && w.clipId !== curClip) flush(); // never span two clips
    curClip = w.clipId;
    cur.push({text: display, startMs: w.srcStartMs, endMs: w.srcEndMs, accent: acc.has(i)});

    const lastGlue = GLUE.has(display.toLowerCase());
    const next = words[i + 1];
    const sameClipNext = next && next.clipId === w.clipId;
    const gapAfter = sameClipNext && next.startMs - w.endMs > GAP_MS; // gap in absolute time
    if (SENT_END.test(w.word)) flush();
    else if (next && !sameClipNext) flush(); // clip boundary
    else if (!lastGlue && (cur.length >= MAX_WORDS || gapAfter || CLAUSE_END.test(w.word))) flush();
    else if (cur.length >= MAX_WORDS + 2) flush();
  });
  flush();
  // merge 1-word orphans into the previous line (same clip, tight in time)
  for (let k = pages.length - 1; k > 0; k--) {
    const p = pages[k];
    const prev = pages[k - 1];
    if (p.words.length === 1 && p.clipId === prev.clipId && p.start - prev.end < 350 && prev.words.length <= MAX_WORDS) {
      prev.words.push(...p.words);
      prev.end = p.end;
      pages.splice(k, 1);
    }
  }
  return pages.map((p, i) => ({id: `c${i}`, clipId: p.clipId, words: p.words, startMs: p.start, endMs: p.end, topPct: DEFAULT_TOP}));
}

// --- run ---
progress(2, 'Starting');
const words = assembleWords(clips, (idx, total, clip) =>
  progress(5 + Math.round((idx / total) * 75), `Transcribing ${clip.label ?? clip.id} (${idx + 1}/${total})`),
);
progress(82, 'Detecting accents');
const accents = await detectAccents(words);
const captions = buildCaptions(words, accents);
fs.writeFileSync(path.join(PUBLIC, 'captions.multi.json'), JSON.stringify(captions, null, 2));
progress(100, `Done — ${captions.length} captions, ${accents.length} accents`);
