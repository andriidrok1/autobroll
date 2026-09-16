// Shared per-clip transcription + assembly onto the trimmed/reordered timeline.
// Used by both the captions pipeline and the B-roll detector.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, 'public');
const TRANSCRIPTS = path.join(PUBLIC, 'clips', 'transcripts');
const TMP = path.join(ROOT, '.captions-tmp');

// load .env so AUTOBROLL_PROMPT works when scripts run standalone
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

// Whisper prompt bias: set AUTOBROLL_PROMPT in .env with YOUR domain words
// (topics, brands) to improve transcription accuracy on your videos.
const PROMPT_BIAS =
  process.env.AUTOBROLL_PROMPT ||
  'The following is a clear English talking-head narration. Proper nouns, product names and brands are capitalized.';

// ---- device selection ----
// AUTOBROLL_DEVICE=cpu|cuda forces it; default "auto" asks torch once per process.
// GPU: float16. CPU: int8. One whisperx process per BATCH (the model load is most
// of the wall time, so 3 clips on the GPU take ~10 s instead of ~20 s on CPU).
let DEVICE = null;
function pickDevice() {
  if (DEVICE) return DEVICE;
  const forced = (process.env.AUTOBROLL_DEVICE || 'auto').toLowerCase();
  if (forced === 'cpu' || forced === 'cuda') return (DEVICE = forced);
  const probe = spawnSync('.venv/bin/python', ['-c', 'import torch;print(int(torch.cuda.is_available()))'], {cwd: ROOT});
  DEVICE = probe.status === 0 && probe.stdout.toString().trim() === '1' ? 'cuda' : 'cpu';
  return DEVICE;
}
const computeType = (device) => (device === 'cuda' ? 'float16' : 'int8');

function runWhisperx(wavs, outDir, device) {
  return spawnSync(
    '.venv/bin/whisperx',
    [
      // 'medium' (multilingual, already cached) is noticeably more accurate than
      // small.en on accented English. --language en keeps it English-only.
      ...wavs, '--model', 'medium', '--language', 'en', '--device', device, '--compute_type', computeType(device),
      '--output_format', 'json', '--output_dir', outDir, '--vad_onset', '0.2', '--vad_offset', '0.2',
      '--initial_prompt', PROMPT_BIAS,
    ],
    {cwd: ROOT},
  );
}

// Word times are relative to the SOURCE file, so the cache is keyed by source:
// autocut segments and re-arranged copies of the same take never re-transcribe.
const sourceKey = (clip) => path.basename(clip.src).replace(/\.[^.]+$/, '');
const cacheFile = (clip) => path.join(TRANSCRIPTS, `${sourceKey(clip)}.json`);

function parseWhisperxJson(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const raw = data.segments.flatMap((s) => s.words ?? []);
  return raw
    .map((w, i) => {
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
      return {word: String(w.word).trim(), startMs: Math.round(start * 1000), endMs: Math.round(end * 1000)};
    })
    .filter((w) => w.word.length > 0);
}

// Transcribe every not-yet-cached source among `clips` in ONE whisperx run.
// onBatch(label) is called once before the run (for progress UI).
export function transcribeClips(clips, onBatch) {
  fs.mkdirSync(TRANSCRIPTS, {recursive: true});
  fs.mkdirSync(TMP, {recursive: true});
  const pending = new Map(); // key -> clip
  for (const c of clips) if (!fs.existsSync(cacheFile(c))) pending.set(sourceKey(c), c);
  if (!pending.size) return;

  const wavs = [];
  for (const [key, clip] of pending) {
    const wav = path.join(TMP, `${key}.16k.wav`);
    const ff = spawnSync('ffmpeg', ['-y', '-i', path.join(PUBLIC, clip.src), '-ar', '16000', '-ac', '1', wav], {cwd: ROOT});
    if (ff.status !== 0) console.error(`ffmpeg failed for ${key}`);
    else wavs.push(wav);
  }
  if (!wavs.length) return;

  if (!fs.existsSync(path.join(ROOT, '.venv', 'bin', 'whisperx'))) {
    throw new Error('WhisperX is not installed (.venv/bin/whisperx missing) — run `npm run setup`');
  }
  let device = pickDevice();
  onBatch?.(`Transcribing ${wavs.length} clip${wavs.length === 1 ? '' : 's'} (${device === 'cuda' ? 'GPU' : 'CPU'})`);
  const outDir = path.join(TMP, `batch-${Date.now()}`);
  fs.mkdirSync(outDir, {recursive: true});
  let wx = runWhisperx(wavs, outDir, device);
  if (wx.status !== 0 && device === 'cuda') {
    // e.g. CUDA out of memory / driver mismatch → fall back for this process
    console.error(`whisperx on cuda failed (${wx.stderr?.toString().trim().split('\n').pop()?.slice(0, 160)}); retrying on cpu`);
    DEVICE = device = 'cpu';
    onBatch?.(`Transcribing ${wavs.length} clip${wavs.length === 1 ? '' : 's'} (CPU fallback)`);
    wx = runWhisperx(wavs, outDir, device);
  }
  if (wx.error) throw new Error(`whisperx could not start: ${wx.error.message}`);
  if (wx.status !== 0) {
    const tail = (wx.stderr?.toString() || wx.stdout?.toString() || '').trim().split('\n').filter(Boolean).slice(-3).join(' | ');
    throw new Error(`whisperx failed (exit ${wx.status}): ${tail.slice(-300) || 'no output'}`);
  }

  for (const key of pending.keys()) {
    const out = path.join(outDir, `${key}.16k.json`);
    if (!fs.existsSync(out)) continue; // ffmpeg failed for this one → transcribeClip will throw
    fs.writeFileSync(path.join(TRANSCRIPTS, `${key}.json`), JSON.stringify(parseWhisperxJson(out), null, 2));
  }
}

// Words for one clip (source-relative times). Uses the cache; transcribes on miss.
export function transcribeClip(clip) {
  const cache = cacheFile(clip);
  if (!fs.existsSync(cache)) transcribeClips([clip]);
  if (!fs.existsSync(cache)) throw new Error(`transcription failed for ${clip.id}`);
  return JSON.parse(fs.readFileSync(cache, 'utf8'));
}

// Assemble all clips' words onto the timeline, honoring trim (in/out) and order.
// onProgress(idx, total, clip) is called before each clip is transcribed.
export function assembleWords(clips, onProgress) {
  // one whisperx run for everything not cached yet
  transcribeClips(clips, (label) => onProgress?.(0, clips.length, {id: label, label, batch: true}));
  const out = [];
  let offsetMs = 0;
  clips.forEach((clip, idx) => {
    onProgress?.(idx, clips.length, clip);
    let words;
    try {
      words = transcribeClip(clip);
    } catch (e) {
      // one bad clip shouldn't kill the whole job — skip it, keep its slot
      console.error(`SKIP clip ${clip.id}: ${String(e).slice(0, 160)}`);
      offsetMs += (clip.outSec - clip.inSec) * 1000;
      return;
    }
    const inMs = clip.inSec * 1000;
    const outMs = clip.outSec * 1000;
    for (const w of words) {
      if (w.endMs <= inMs || w.startMs >= outMs) continue;
      const s = Math.max(w.startMs, inMs) - inMs + offsetMs;
      const e = Math.min(w.endMs, outMs) - inMs + offsetMs;
      out.push({
        word: w.word,
        startMs: Math.round(s), // absolute timeline (current cut)
        endMs: Math.round(e),
        clipId: clip.id, // anchor
        srcStartMs: w.startMs, // relative to the clip's own source start
        srcEndMs: w.endMs,
      });
    }
    offsetMs += (clip.outSec - clip.inSec) * 1000;
  });
  // persist for reuse (e.g. B-roll detection without re-running)
  fs.writeFileSync(path.join(PUBLIC, 'words.multi.json'), JSON.stringify(out, null, 2));
  return out;
}
