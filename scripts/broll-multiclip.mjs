// B-roll detection + sourcing for the assembled timeline (browser-driven).
//
// Input : JSON file (argv[2]) = {clips:[...], brollAssets:[{id,src,kind,label}]}
// Steps : 1) assemble transcript (shared, cached), 2) Gemini picks sparse B-roll
//         moments + a query + format, and assigns one of YOUR assets when it
//         fits, 3) anything left → Pexels (download top hit + keep alternatives).
// Output: public/broll.json = [{id,startMs,endMs,kind,mode,query,src,source,alternatives}]
import fs from 'node:fs';
import path from 'node:path';
import {gemini} from './gemini.mjs';
import {assembleWords} from './lib-transcribe.mjs';

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, 'public');
const BROLL_DIR = path.join(PUBLIC, 'broll');
fs.mkdirSync(BROLL_DIR, {recursive: true});

const progress = (pct, label) => console.log(`PROGRESS:${pct}:${label}`);

function pexelsKey() {
  const p = path.join(ROOT, '.env');
  if (!process.env.PEXELS_API_KEY && fs.existsSync(p)) {
    for (const l of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = l.match(/^([A-Z_]+)=(.*)$/);
      if (m) process.env[m[1]] = m[2].trim();
    }
  }
  return process.env.PEXELS_API_KEY;
}
const KEY = pexelsKey();

const {clips, brollAssets = []} = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!clips?.length) { console.error('no clips'); process.exit(1); }

progress(2, 'Starting');
const words = assembleWords(clips, (idx, total, clip) =>
  progress(3 + Math.round((idx / total) * 45), clip.batch ? clip.label : `Transcribing ${clip.label ?? clip.id} (${idx + 1}/${total})`),
);
const indexed = words.map((w, i) => `${i}:${w.word}`).join(' ');

progress(55, 'Planning B-roll');
const assetList = brollAssets.length
  ? brollAssets.map((a) => `${a.id}: "${a.label}" (${a.kind})`).join('\n')
  : '(none uploaded)';

const PROMPT = `You are a senior short-form video editor adding B-roll to a talking-head video.

Transcript (each word prefixed by index):
${indexed}

The creator's OWN B-roll assets (prefer these when one clearly fits the moment):
${assetList}

Pick moments where a visual genuinely strengthens the message. For each:
- Be SPARING: ~1 visual per 8-12s of speech. Too much looks cheap.
- Only for concrete, visualizable nouns/concepts (a thing, place, object, action) — never abstract filler.
- assetId: if one of the creator's OWN assets above clearly fits, put its id; otherwise "" (we'll fetch stock).
- query: 2-4 word concrete English stock search (used only when assetId is "").
- kind: "video" for actions/motion, "image" for static things.
- mode: "fullscreen" (cutaway hides face ~2s), "inset" (small corner, face stays), "top" (upper half).
- startIdx/endIdx: word-index range to show it over (~1.5-3s).`;

const schema = {
  type: 'OBJECT',
  properties: {
    broll: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          startIdx: {type: 'INTEGER'}, endIdx: {type: 'INTEGER'}, query: {type: 'STRING'},
          assetId: {type: 'STRING'}, kind: {type: 'STRING', enum: ['video', 'image']},
          mode: {type: 'STRING', enum: ['fullscreen', 'inset', 'top']}, reason: {type: 'STRING'},
        },
        required: ['startIdx', 'endIdx', 'query', 'kind', 'mode', 'reason'],
      },
    },
  },
  required: ['broll'],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let plan = [];
let planned = false;
for (let attempt = 0; attempt < 4 && !planned; attempt++) {
  try {
    const result = await gemini([{text: PROMPT}], schema);
    plan = result.broll.filter((b) => words[b.startIdx] && words[b.endIdx]);
    planned = true;
  } catch (e) {
    const msg = String(e);
    const transient = /\b(503|429|500|UNAVAILABLE|high demand)\b/i.test(msg);
    if (transient && attempt < 3) {
      const wait = 2000 * (attempt + 1);
      console.error(`B-roll planning attempt ${attempt + 1} failed (${msg.slice(0, 60)}…), retrying in ${wait}ms`);
      await sleep(wait);
      continue;
    }
    console.error('B-roll planning failed:', msg.slice(0, 200));
    fs.writeFileSync(path.join(PUBLIC, 'broll.json'), '[]');
    progress(100, 'No B-roll (planning failed)');
    process.exit(0);
  }
}

// --- Pexels ---
const headers = {Authorization: KEY};
async function searchPexels(query, kind) {
  if (!KEY) return [];
  const url = kind === 'video'
    ? `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=6&orientation=portrait`
    : `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=6&orientation=portrait`;
  try {
    const d = await fetch(url, {headers}).then((r) => r.json());
    if (kind === 'video') {
      // Output is 1080x1920, so take the smallest mp4 that is at least that tall
      // (usually the 1080p file, ~7 MB) instead of the 4K one (~30-100 MB): remote 4K
      // streams were failing mid-render and bloated the preview.
      return (d.videos ?? []).map((v) => {
        const files = (v.video_files ?? []).filter((f) => f.file_type === 'video/mp4' && f.height);
        const tall = files.filter((f) => f.height >= 1920).sort((a, b) => a.height - b.height);
        const pick = tall[0] ?? files.sort((a, b) => b.height - a.height)[0];
        return pick?.link;
      }).filter(Boolean);
    }
    return (d.photos ?? []).map((p) => p.src?.large2x || p.src?.large).filter(Boolean);
  } catch {
    return [];
  }
}
const assetById = Object.fromEntries(brollAssets.map((a) => [a.id, a]));
const out = [];
for (let i = 0; i < plan.length; i++) {
  const b = plan[i];
  progress(60 + Math.round((i / plan.length) * 38), `Sourcing ${b.query} (${i + 1}/${plan.length})`);
  const sw = words[b.startIdx];
  const ew = words[b.endIdx];
  // anchor to the start word's clip; store SOURCE-RELATIVE times (don't span clips)
  const base = {
    id: `b${i}`,
    clipId: sw.clipId,
    startMs: sw.srcStartMs,
    endMs: ew.clipId === sw.clipId ? ew.srcEndMs : sw.srcEndMs,
    kind: b.kind, mode: b.mode, query: b.query, reason: b.reason,
  };
  const own = b.assetId && assetById[b.assetId];
  if (own) {
    out.push({...base, kind: own.kind, src: own.src, source: 'own', alternatives: []});
    continue;
  }
  // Pexels URLs are used directly (Remotion loads remote URLs in preview + render).
  const urls = await searchPexels(b.query, b.kind);
  if (!urls.length) continue; // nothing found — skip this moment
  out.push({...base, src: urls[0], source: 'pexels', alternatives: urls.slice(0, 6)});
}

fs.writeFileSync(path.join(PUBLIC, 'broll.json'), JSON.stringify(out, null, 2));
progress(100, `Done — ${out.length} B-roll cues`);
