// Autocut: remove silence at the ENDS and long pauses INSIDE each clip.
// Splits a clip into speech segments at gaps > GAP_THRESH and drops the gaps.
//
// Input : JSON (argv[2]) = {clips:[{id,src,inSec,outSec,sourceDurationSec,...}]}
// Output: public/trim-silence.json = {plan:[{id, segments:[{inSec,outSec}]}]}
// Uses the shared (cached) per-clip transcripts.
import fs from 'node:fs';
import path from 'node:path';
import {transcribeClip, transcribeClips} from './lib-transcribe.mjs';

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, 'public');
const progress = (pct, label) => console.log(`PROGRESS:${pct}:${label}`);

const GAP_THRESH = 600; // ms — pauses longer than this are cut out
const LEAD_PAD = 0.1; // s before the very first word
const TRAIL_PAD = 0.3; // s after the very last word
const INNER_PAD = 0.08; // s of breath kept on either side of an internal cut
const MIN_LEN = 0.35; // drop segments shorter than this

const {clips} = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!clips?.length) { console.error('no clips'); process.exit(1); }

progress(2, 'Starting');
transcribeClips(clips, (label) => progress(5, label)); // one whisperx run for all uncached sources
const plan = [];
clips.forEach((clip, i) => {
  progress(5 + Math.round((i / clips.length) * 92), `Analyzing ${clip.label ?? clip.id} (${i + 1}/${clips.length})`);
  let words;
  try {
    words = transcribeClip(clip);
  } catch (e) {
    console.error(`SKIP ${clip.id}: ${String(e).slice(0, 120)}`);
    return;
  }
  if (!words.length) return; // no speech → leave untouched (likely B-roll)

  const dur = clip.sourceDurationSec ?? clip.outSec;

  // build speech runs split at long gaps
  const runs = [];
  let runStart = words[0].startMs;
  for (let k = 0; k < words.length; k++) {
    const gapNext = words[k + 1] ? words[k + 1].startMs - words[k].endMs : Infinity;
    if (gapNext > GAP_THRESH) {
      runs.push([runStart, words[k].endMs]);
      if (words[k + 1]) runStart = words[k + 1].startMs;
    }
  }

  const segments = runs
    .map(([a, b], idx) => {
      const lead = idx === 0 ? LEAD_PAD : INNER_PAD;
      const trail = idx === runs.length - 1 ? TRAIL_PAD : INNER_PAD;
      return {inSec: Math.max(0, a / 1000 - lead), outSec: Math.min(dur, b / 1000 + trail)};
    })
    .filter((s) => s.outSec - s.inSec >= MIN_LEN);

  if (!segments.length) return;
  // skip clips that effectively don't change (one segment ≈ original)
  const unchanged =
    segments.length === 1 && Math.abs(segments[0].inSec - clip.inSec) < 0.05 && Math.abs(segments[0].outSec - clip.outSec) < 0.05;
  if (unchanged) return;
  plan.push({id: clip.id, segments});
});

fs.writeFileSync(path.join(PUBLIC, 'trim-silence.json'), JSON.stringify({plan}, null, 2));
const cuts = plan.reduce((n, p) => n + p.segments.length, 0);
progress(100, `Done — ${plan.length} clip(s), ${cuts} segment(s)`);
