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

// Transcribe one source clip with WhisperX, cached per clip id. Word times are
// relative to the clip's own start.
export function transcribeClip(clip) {
  fs.mkdirSync(TRANSCRIPTS, {recursive: true});
  fs.mkdirSync(TMP, {recursive: true});
  const cache = path.join(TRANSCRIPTS, `${clip.id}.json`);
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));

  const srcMp4 = path.join(PUBLIC, clip.src);
  const wav = path.join(TMP, `${clip.id}.16k.wav`);
  const ff = spawnSync('ffmpeg', ['-y', '-i', srcMp4, '-ar', '16000', '-ac', '1', wav], {cwd: ROOT});
  if (ff.status !== 0) throw new Error(`ffmpeg failed for ${clip.id}`);

  const outDir = path.join(TMP, clip.id);
  fs.mkdirSync(outDir, {recursive: true});
  const wx = spawnSync(
    '.venv/bin/whisperx',
    [
      // 'medium' (multilingual, already cached) is noticeably more accurate than
      // small.en on accented English. --language en keeps it English-only.
      wav, '--model', 'medium', '--language', 'en', '--device', 'cpu', '--compute_type', 'int8',
      '--output_format', 'json', '--output_dir', outDir, '--vad_onset', '0.2', '--vad_offset', '0.2',
      '--initial_prompt', PROMPT_BIAS,
    ],
    {cwd: ROOT},
  );
  if (wx.status !== 0) throw new Error(`whisperx failed for ${clip.id}: ${wx.stderr?.toString().slice(-300)}`);

  const data = JSON.parse(fs.readFileSync(path.join(outDir, `${clip.id}.16k.json`), 'utf8'));
  const raw = data.segments.flatMap((s) => s.words ?? []);
  const words = raw
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

  fs.writeFileSync(cache, JSON.stringify(words, null, 2));
  return words;
}

// Assemble all clips' words onto the timeline, honoring trim (in/out) and order.
// onProgress(idx, total, clip) is called before each clip is transcribed.
export function assembleWords(clips, onProgress) {
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
