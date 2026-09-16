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
import {spawnSync} from 'node:child_process';
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

// --- face-aware placement (Gemini vision on one frame per source clip) ---
// Captions default to 58% down the frame, which on a talking head lands on the
// mouth. Ask Gemini where the face is and put the block just under the chin,
// or above the head when the face sits low. Cached per source file.
// Disable with AUTOBROLL_FACE_AWARE=0 in .env.
const FACES_DIR = path.join(PUBLIC, 'clips', 'faces');
const TMP = path.join(ROOT, '.captions-tmp');
const BLOCK_PCT = 9; // ≈ two caption lines at 62px on a 1920px frame
const MIN_TOP = 8;
const MAX_TOP = 72; // block bottom ≤ ~81%: stays clear of the Reels/TikTok UI strip
const sourceKey = (clip) => path.basename(clip.src).replace(/\.[^.]+$/, '');

function faceToTop(face) {
  if (!face?.found) return DEFAULT_TOP;
  const top = face.top * 100;
  const bottom = face.bottom * 100;
  const below = bottom + 5; // a little under the chin (Gemini's box tends to end at the lip line)
  if (below <= MAX_TOP) return Math.round(Math.max(MIN_TOP, below));
  const above = top - 4 - BLOCK_PCT; // face sits low → go above the head
  return Math.round(Math.min(MAX_TOP, Math.max(MIN_TOP, above)));
}

async function detectFaces(clips) {
  if ((process.env.AUTOBROLL_FACE_AWARE ?? '1') === '0') return {};
  fs.mkdirSync(FACES_DIR, {recursive: true});
  fs.mkdirSync(TMP, {recursive: true});
  const bySource = new Map();
  for (const c of clips) if (!bySource.has(sourceKey(c))) bySource.set(sourceKey(c), c);
  const result = {};
  const pending = [];
  for (const [key, clip] of bySource) {
    const cache = path.join(FACES_DIR, `${key}.json`);
    if (fs.existsSync(cache)) { result[key] = JSON.parse(fs.readFileSync(cache, 'utf8')); continue; }
    // a frame from the middle of the clip's current trim window
    const mid = clip.inSec + Math.max(0, (clip.outSec - clip.inSec) / 2);
    const jpg = path.join(TMP, `${key}.face.jpg`);
    const ff = spawnSync('ffmpeg', ['-y', '-ss', String(mid), '-i', path.join(PUBLIC, clip.src), '-frames:v', '1', '-vf', 'scale=540:-2', '-q:v', '4', jpg], {cwd: ROOT});
    if (ff.status === 0 && fs.existsSync(jpg)) pending.push({key, jpg});
  }
  if (!pending.length) return result;

  const parts = [{text: `You are given ${pending.length} video frame(s) from talking-head clips, in order, labelled F1..F${pending.length}.
For each frame report whether a human face is clearly visible and, if so, its bounding box as fractions of the frame height/width
(top = forehead/hairline, bottom = chin), so a caption can be placed where it will NOT cover the face.
If several faces, use the largest. Return one entry per frame, same order.`}];
  pending.forEach((p, i) => { parts.push({text: `F${i + 1}:`}); parts.push({imagePath: p.jpg}); });
  const schema = {
    type: 'OBJECT',
    properties: {
      frames: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            frame: {type: 'STRING'},
            found: {type: 'BOOLEAN'},
            top: {type: 'NUMBER'}, bottom: {type: 'NUMBER'}, left: {type: 'NUMBER'}, right: {type: 'NUMBER'},
          },
          required: ['frame', 'found'],
        },
      },
    },
    required: ['frames'],
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = await gemini(parts, schema);
      const frames = Array.isArray(out.frames) ? out.frames : [];
      pending.forEach((p, i) => {
        const f = frames.find((x) => String(x.frame).toUpperCase().replace(/\s/g, '') === `F${i + 1}`) ?? frames[i];
        const sane = f?.found && f.top >= 0 && f.bottom <= 1 && f.bottom > f.top;
        const face = sane ? {found: true, top: f.top, bottom: f.bottom, left: f.left, right: f.right} : {found: false};
        result[p.key] = face;
        fs.writeFileSync(path.join(FACES_DIR, `${p.key}.json`), JSON.stringify(face));
      });
      return result;
    } catch (e) {
      const msg = String(e);
      if (/\b(503|429|500|UNAVAILABLE)\b/i.test(msg) && attempt < 2) { await sleep(2000 * (attempt + 1)); continue; }
      console.error('face detection failed, using default caption position:', msg.slice(0, 160));
      return result; // uncached sources fall back to DEFAULT_TOP (not cached, so next run retries)
    }
  }
  return result;
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

function buildCaptions(words, accentIdx, topByClip = {}) {
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
  return pages.map((p, i) => ({id: `c${i}`, clipId: p.clipId, words: p.words, startMs: p.start, endMs: p.end, topPct: topByClip[p.clipId] ?? DEFAULT_TOP}));
}

// --- run ---
progress(2, 'Starting');
const words = assembleWords(clips, (idx, total, clip) =>
  progress(5 + Math.round((idx / total) * 75), clip.batch ? clip.label : `Transcribing ${clip.label ?? clip.id} (${idx + 1}/${total})`),
);
progress(80, 'Finding faces');
const faces = await detectFaces(clips);
const topByClip = Object.fromEntries(clips.map((c) => [c.id, faceToTop(faces[sourceKey(c)])]));
progress(84, 'Detecting accents');
const accents = await detectAccents(words);
const captions = buildCaptions(words, accents, topByClip);
fs.writeFileSync(path.join(PUBLIC, 'captions.multi.json'), JSON.stringify(captions, null, 2));
progress(100, `Done — ${captions.length} captions, ${accents.length} accents`);
