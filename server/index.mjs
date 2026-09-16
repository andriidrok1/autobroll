// Editor backend (port 3333):
//   projects   — multi-project library (list/get/save/delete)
//   add-clip   — upload video → remux/encode + thumbnail → return clip
//   music      — upload an audio track
//   captions   — per-clip WhisperX → accents → captions (job)
//   broll      — Gemini detect → own assets / Pexels (job)
//   arrange    — transcribe → Gemini orders clips (job)
//   render     — export the MultiClip composition to mp4 (job)
//   health     — environment checks for the Start screen (ffmpeg, WhisperX, keys)
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// run a command async, resolve {code, stdout, stderr}
const run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const c = spawn(cmd, args, {cwd: ROOT, ...opts});
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('close', (code) => resolve({code, stdout: out, stderr: err}));
    c.on('error', () => resolve({code: 1, stdout: out, stderr: err}));
  });

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const EXPORTS = path.join(PUBLIC, 'exports');
const PROJECTS_DIR = path.join(PUBLIC, 'projects');
fs.mkdirSync(EXPORTS, {recursive: true});
fs.mkdirSync(PROJECTS_DIR, {recursive: true});

const renders = {}; // jobId -> {status, progress, file, error}
const captionJobs = {}; // jobId -> {status, progress, label, error}
const brollJobs = {}; // jobId -> {status, progress, label, error}
const arrangeJobs = {}; // jobId -> {status, progress, label, error}
const trimJobs = {}; // jobId -> {status, progress, label, error}

const body = (req) =>
  new Promise((res) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => res(d));
  });

const json = (res, code, obj) => {
  res.writeHead(code, {'Content-Type': 'application/json'});
  res.end(JSON.stringify(obj));
};

const JOBS = {
  '/api/captions': {route: '/api/captions', name: 'Captions', prefix: 'clips', script: 'scripts/captions-multiclip.mjs', store: captionJobs},
  '/api/trim-silence': {route: '/api/trim-silence', name: 'Autocut', prefix: 'trim', script: 'scripts/trim-silence.mjs', store: trimJobs},
  '/api/arrange': {route: '/api/arrange', name: 'Auto-arrange', prefix: 'arrange', script: 'scripts/arrange-clips.mjs', store: arrangeJobs},
  '/api/broll': {route: '/api/broll', name: 'B-roll', prefix: 'broll', script: 'scripts/broll-multiclip.mjs', store: brollJobs},
};

// Turn a stderr tail into one line a user can act on.
function explainFailure(tail, fallback) {
  const lines = tail.split('\n').map((l) => l.trim()).filter(Boolean).filter((l) => !/^PROGRESS:/.test(l));
  const known = [
    [/GEMINI_API_KEY not found/i, 'GEMINI_API_KEY is missing — add it to .env (free key: aistudio.google.com/apikey)'],
    [/Gemini 4(00|03)/i, 'Gemini rejected the API key — check GEMINI_API_KEY in .env'],
    [/Gemini (503|429)/i, 'Gemini is overloaded right now (503/429) — retry in a minute'],
    [/WhisperX is not installed|whisperx could not start|spawnSync \.venv\/bin\/whisperx/i, 'WhisperX is not installed — run `npm run setup` (creates .venv and installs whisperx)'],
    [/whisperx failed \(exit/i, null], // keep the script's own message (has the real whisperx error)
    [/ffmpeg.*(ENOENT|not found)|spawnSync ffmpeg/i, 'ffmpeg is not on PATH — install it (apt install ffmpeg / brew install ffmpeg)'],
    [/CUDA out of memory/i, 'GPU ran out of memory — set AUTOBROLL_DEVICE=cpu in .env'],
    [/no clips/i, 'No clips on the timeline'],
  ];
  for (const l of lines) for (const [re, msg] of known) if (re.test(l)) return msg ?? l.replace(/^.*?Error: /, '').slice(0, 220);
  const meaningful = [...lines].reverse().find((l) => /error|failed|exception|traceback|not found|denied/i.test(l));
  return (meaningful || lines.at(-1) || fallback).replace(/\s+/g, ' ').slice(0, 220);
}

// ---- environment health (Start screen shows what is missing) ----
function readEnvFile() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch {}
  return out;
}
let gpuProbe = null; // resolved once: 'cuda' | 'cpu' | null (no venv)
async function health() {
  const env = {...readEnvFile(), ...process.env};
  const ff = await run('ffmpeg', ['-version']);
  const fp = await run('ffprobe', ['-version']);
  const venv = fs.existsSync(path.join(ROOT, '.venv', 'bin', 'whisperx'));
  if (venv && gpuProbe === null) {
    const r = await run('.venv/bin/python', ['-c', 'import torch;print("cuda" if torch.cuda.is_available() else "cpu")']);
    gpuProbe = r.code === 0 ? r.stdout.trim() : 'cpu';
  }
  const forced = (env.AUTOBROLL_DEVICE || '').toLowerCase();
  const checks = [
    {id: 'node', ok: +process.versions.node.split('.')[0] >= 20, label: `Node ${process.versions.node}`, hint: 'Node 20 or newer is required'},
    {id: 'ffmpeg', ok: ff.code === 0 && fp.code === 0, label: ff.code === 0 ? `ffmpeg ${ff.stdout.match(/version (\S+)/)?.[1] ?? ''}` : 'ffmpeg', hint: 'Install ffmpeg (apt install ffmpeg / brew install ffmpeg) — needed for uploads, waveforms, exports'},
    {id: 'whisperx', ok: venv, label: venv ? `WhisperX (${forced || gpuProbe || 'cpu'})` : 'WhisperX', hint: 'Run `npm run setup` to create .venv and install WhisperX — needed for captions, autocut, arrange'},
    {id: 'gemini', ok: !!env.GEMINI_API_KEY, label: 'Gemini API key', hint: 'Add GEMINI_API_KEY to .env (free: aistudio.google.com/apikey) — needed for arrange, accents, B-roll'},
    {id: 'pexels', ok: !!env.PEXELS_API_KEY, label: 'Pexels API key', hint: 'Add PEXELS_API_KEY to .env (free: pexels.com/api) — optional, Auto B-roll falls back to your own footage only', optional: true},
  ];
  return {ok: checks.every((c) => c.ok || c.optional), checks};
}

// download remote B-roll srcs into public/broll/ and rewrite props in place
const BROLL_DIR = path.join(PUBLIC, 'broll');
async function localizeRemoteBrolls(props) {
  const items = Array.isArray(props?.brolls) ? props.brolls : [];
  fs.mkdirSync(BROLL_DIR, {recursive: true});
  for (const b of items) {
    if (!/^https?:\/\//.test(b.src ?? '')) continue;
    const ext = b.kind === 'video' ? 'mp4' : (b.src.match(/\.(jpe?g|png|webp)(\?|$)/i)?.[1] ?? 'jpg');
    const name = `px-${Buffer.from(b.src).toString('base64url').slice(-24).replace(/[^\w-]/g, '')}.${ext}`;
    const file = path.join(BROLL_DIR, name);
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
      const r = await fetch(b.src);
      if (!r.ok) throw new Error(`B-roll download ${r.status}: ${b.src}`);
      const tmp = file + '.part';
      fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
      if (ext === 'mp4') {
        // Remotion's compositor fails on 4K sources ("Could not extract frame ...
        // Request closed"); the output is 1080x1920 anyway, so cap the height.
        const probe = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'csv=p=0', tmp]);
        const h = parseInt(probe.stdout, 10) || 0;
        if (h > 1920) {
          const small = file + '.small.mp4';
          const enc = await run('ffmpeg', ['-y', '-i', tmp, '-vf', 'scale=-2:1920', '-c:v', 'libx264', '-preset', 'veryfast',
            '-crf', '20', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', small]);
          if (enc.code !== 0) throw new Error(`B-roll downscale failed: ${enc.stderr.slice(-200)}`);
          fs.rmSync(tmp, {force: true});
          fs.renameSync(small, file);
        } else fs.renameSync(tmp, file);
      } else fs.renameSync(tmp, file);
    }
    b.src = `broll/${name}`;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, await health());

  // ---- multi-project library ----
  if (req.method === 'GET' && url.pathname === '/api/projects') {
    const list = fs.readdirSync(PROJECTS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const p = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, f), 'utf8'));
          return {
            id: f.replace(/\.json$/, ''),
            name: p.name || 'Untitled project',
            clips: p.clips?.length || 0,
            updatedAt: p.updatedAt || null,
            // thumbs are stored per SOURCE file (segments share their source's thumb)
            thumb: p.clips?.[0]?.src ? '/clips/thumbs/' + path.basename(p.clips[0].src).replace(/\.\w+$/, '.jpg') : null,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return json(res, 200, list);
  }
  if (url.pathname.startsWith('/api/projects/')) {
    const id = url.pathname.split('/').pop();
    if (!id || !/^[\w-]+$/.test(id)) return json(res, 400, {error: 'bad id'});
    const file = path.join(PROJECTS_DIR, `${id}.json`);
    if (req.method === 'GET') {
      if (!fs.existsSync(file)) return json(res, 404, {error: 'not found'});
      return json(res, 200, JSON.parse(fs.readFileSync(file, 'utf8')));
    }
    if (req.method === 'POST') {
      let incoming;
      try {
        incoming = JSON.parse((await body(req)) || '{}');
      } catch {
        return json(res, 400, {error: 'bad json'});
      }
      let prev = {};
      try {
        prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
      } catch {
        /* corrupt previous file — overwrite */
      }
      const now = new Date().toISOString();
      const saved = {...incoming, createdAt: prev.createdAt || now, updatedAt: now};
      fs.writeFileSync(file, JSON.stringify(saved, null, 2));
      return json(res, 200, {ok: true, updatedAt: now});
    }
    if (req.method === 'DELETE') {
      fs.rmSync(file, {force: true});
      return json(res, 200, {ok: true});
    }
  }

  // ---- upload a music track → public/music/ ----
  if (req.method === 'POST' && url.pathname === '/api/music') {
    const safe = (url.searchParams.get('name') || 'track.mp3').replace(/[^\w.\-]/g, '_');
    const dir = path.join(PUBLIC, 'music');
    fs.mkdirSync(dir, {recursive: true});
    const ws = fs.createWriteStream(path.join(dir, safe));
    req.pipe(ws);
    ws.on('finish', () => json(res, 200, {src: `music/${safe}`}));
    ws.on('error', () => json(res, 500, {error: 'write failed'}));
    return;
  }

  // ---- audio waveform peaks for a local media file (cached) ----
  if (req.method === 'GET' && url.pathname === '/api/waveform') {
    const src = url.searchParams.get('src') || '';
    if (!/^[\w\-./]+$/.test(src) || src.includes('..')) return json(res, 400, {error: 'bad src'});
    const abs = path.join(PUBLIC, src);
    if (!fs.existsSync(abs)) return json(res, 404, {error: 'not found'});
    const dir = path.join(PUBLIC, 'waveforms');
    fs.mkdirSync(dir, {recursive: true});
    const cache = path.join(dir, src.replace(/[^\w]/g, '_') + '.json');
    if (fs.existsSync(cache) && fs.statSync(cache).mtimeMs >= fs.statSync(abs).mtimeMs) {
      return json(res, 200, JSON.parse(fs.readFileSync(cache, 'utf8')));
    }
    // decode to mono 8kHz PCM and take max-abs peaks over ~1000 buckets
    const child = spawn('ffmpeg', ['-v', 'error', '-i', abs, '-ac', '1', '-ar', '8000', '-f', 's16le', '-']);
    const bufs = [];
    child.stdout.on('data', (d) => bufs.push(d));
    child.on('close', (code) => {
      if (code !== 0 || !bufs.length) return json(res, 500, {error: 'ffmpeg failed'});
      const buf = Buffer.concat(bufs);
      const samples = Math.floor(buf.length / 2);
      const N = 1000;
      const per = Math.max(1, Math.floor(samples / N));
      const peaks = new Array(N).fill(0);
      for (let i = 0; i < N; i++) {
        let m = 0;
        const start = i * per;
        const end = Math.min(samples, start + per);
        for (let j = start; j < end; j++) {
          const v = Math.abs(buf.readInt16LE(j * 2));
          if (v > m) m = v;
        }
        peaks[i] = Math.round((m / 32768) * 100) / 100;
      }
      const out = {peaks, durationSec: samples / 8000};
      fs.writeFileSync(cache, JSON.stringify(out));
      json(res, 200, out);
    });
    return;
  }

  // ---- add a B-roll asset (own footage/photo): upload → encode/thumbnail ----
  if (req.method === 'POST' && url.pathname === '/api/add-broll-asset') {
    const rawName = url.searchParams.get('name') || 'asset';
    const kind = url.searchParams.get('kind') === 'image' ? 'image' : 'video';
    const base = rawName.replace(/\.[^.]+$/, '').replace(/[^\w\-]/g, '_').slice(0, 40) || 'asset';
    const dir = path.join(PUBLIC, 'broll-assets');
    const thumbs = path.join(dir, 'thumbs');
    fs.mkdirSync(thumbs, {recursive: true});
    let id = base;
    let n = 2;
    const ext = kind === 'image' ? 'jpg' : 'mp4';
    while (fs.existsSync(path.join(dir, `${id}.${ext}`))) id = `${base}-${n++}`;

    const tmp = path.join(ROOT, `.upload-broll-${id}.bin`);
    const ws = fs.createWriteStream(tmp);
    req.pipe(ws);
    req.on('error', () => { try { fs.rmSync(tmp, {force: true}); } catch {} json(res, 500, {error: 'upload failed'}); });
    ws.on('finish', async () => {
      try {
        const out = path.join(dir, `${id}.${ext}`);
        const thumb = path.join(thumbs, `${id}.jpg`);
        if (kind === 'image') {
          // normalize to jpg (handles png/heic/webp) + a thumbnail
          await run('ffmpeg', ['-y', '-i', tmp, '-vf', 'scale=1080:-1', out]);
          await run('ffmpeg', ['-y', '-i', out, '-vf', 'scale=160:-1', thumb]);
        } else {
          const probe = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt', '-of', 'json', tmp]);
          let codec = '', pix = '';
          try { const p = JSON.parse(probe.stdout); codec = p.streams?.[0]?.codec_name ?? ''; pix = p.streams?.[0]?.pix_fmt ?? ''; } catch {}
          const compatible = codec === 'h264' && pix.startsWith('yuv420');
          const enc = compatible
            ? await run('ffmpeg', ['-y', '-i', tmp, '-c', 'copy', '-movflags', '+faststart', out])
            : await run('ffmpeg', ['-y', '-i', tmp, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', out]);
          if (enc.code !== 0) { fs.rmSync(tmp, {force: true}); return json(res, 500, {error: 'transcode failed'}); }
          await run('ffmpeg', ['-y', '-ss', '0.3', '-i', out, '-frames:v', '1', '-vf', 'scale=160:-1', thumb]);
        }
        fs.rmSync(tmp, {force: true});
        return json(res, 200, {id, src: `broll-assets/${id}.${ext}`, kind, label: rawName.replace(/\.[^.]+$/, ''), thumb: `/broll-assets/thumbs/${id}.jpg`});
      } catch (e) {
        try { fs.rmSync(tmp, {force: true}); } catch {}
        return json(res, 500, {error: String(e).slice(0, 200)});
      }
    });
    return;
  }

  // ---- add a clip to the timeline: upload → remux/encode → thumbnail ----
  if (req.method === 'POST' && url.pathname === '/api/add-clip') {
    const rawName = url.searchParams.get('name') || 'clip.mp4';
    const base = rawName.replace(/\.[^.]+$/, '').replace(/[^\w\-]/g, '_').slice(0, 40) || 'clip';
    const clipsDir = path.join(PUBLIC, 'clips');
    const thumbsDir = path.join(clipsDir, 'thumbs');
    fs.mkdirSync(thumbsDir, {recursive: true});

    // unique id (avoid clobbering existing clips)
    let id = base;
    let n = 2;
    while (fs.existsSync(path.join(clipsDir, `${id}.mp4`))) id = `${base}-${n++}`;

    const tmp = path.join(ROOT, `.upload-${id}.bin`);
    const ws = fs.createWriteStream(tmp);
    req.pipe(ws);
    req.on('error', () => { try { fs.rmSync(tmp, {force: true}); } catch {} json(res, 500, {error: 'upload failed'}); });

    ws.on('finish', async () => {
      try {
        const out = path.join(clipsDir, `${id}.mp4`);
        // probe codec / pixel format / duration
        const probe = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
          '-show_entries', 'stream=codec_name,pix_fmt:format=duration', '-of', 'json', tmp]);
        let codec = '', pix = '', duration = 0;
        try {
          const p = JSON.parse(probe.stdout);
          codec = p.streams?.[0]?.codec_name ?? '';
          pix = p.streams?.[0]?.pix_fmt ?? '';
          duration = parseFloat(p.format?.duration ?? '0');
        } catch {}

        // h264 + yuv420p → fast remux; otherwise re-encode for browser/Remotion
        const compatible = codec === 'h264' && pix.startsWith('yuv420');
        const enc = compatible
          ? await run('ffmpeg', ['-y', '-i', tmp, '-c', 'copy', '-movflags', '+faststart', out])
          : await run('ffmpeg', ['-y', '-i', tmp, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
              '-c:a', 'aac', '-movflags', '+faststart', out]);
        if (enc.code !== 0) {
          fs.rmSync(tmp, {force: true});
          return json(res, 500, {error: 'transcode failed', detail: enc.stderr.slice(-300)});
        }

        // re-probe duration from the output (authoritative)
        const dp = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of',
          'default=noprint_wrappers=1:nokey=1', out]);
        const dur = parseFloat(dp.stdout) || duration || 0;

        // thumbnail
        await run('ffmpeg', ['-y', '-ss', String(Math.min(0.5, dur / 2)), '-i', out, '-frames:v', '1',
          '-vf', 'scale=160:-1', path.join(thumbsDir, `${id}.jpg`)]);

        fs.rmSync(tmp, {force: true});
        return json(res, 200, {
          id, src: `clips/${id}.mp4`, label: rawName.replace(/\.[^.]+$/, ''),
          inSec: 0, outSec: dur, sourceDurationSec: dur,
        });
      } catch (e) {
        try { fs.rmSync(tmp, {force: true}); } catch {}
        return json(res, 500, {error: String(e).slice(0, 200)});
      }
    });
    return;
  }

  // ---- AI jobs: captions / autocut / arrange / B-roll ----
  // Each spawns one pipeline script with the request body as its input file and
  // relays PROGRESS lines; on failure the LAST meaningful stderr line is returned
  // to the UI instead of "see server logs".
  const job = JOBS[url.pathname];
  if (req.method === 'POST' && job) {
    const id = String(Date.now());
    const inFile = path.join(ROOT, `.${job.prefix}-${id}.json`);
    fs.writeFileSync(inFile, await body(req));
    job.store[id] = {status: 'running', progress: 0, label: 'Starting'};
    const child = spawn('node', [job.script, inFile], {cwd: ROOT, env: process.env});
    let errTail = '';
    const onChunk = (d) => {
      for (const m of String(d).matchAll(/PROGRESS:(\d+):([^\n]+)/g)) {
        job.store[id] = {status: 'running', progress: +m[1], label: m[2].trim()};
      }
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', (d) => {
      onChunk(d);
      errTail = (errTail + d).slice(-4000);
      process.stderr.write(d);
    });
    child.on('close', (code) => {
      fs.rmSync(inFile, {force: true});
      job.store[id] = code === 0
        ? {status: 'done', progress: 100, label: 'Ready'}
        : {status: 'error', error: explainFailure(errTail, `${job.name} exited ${code}`)};
    });
    return json(res, 200, {jobId: id});
  }
  const statusJob = Object.values(JOBS).find((j) => url.pathname.startsWith(j.route + '/'));
  if (req.method === 'GET' && statusJob) {
    const id = url.pathname.split('/').pop();
    return json(res, 200, statusJob.store[id] ?? {status: 'unknown'});
  }

  // ---- E9: запустить рендер ----
  if (req.method === 'POST' && url.pathname === '/api/render') {
    let raw = await body(req); // {clips, music, captions, brolls, accentColor, draft?}
    let draft = false;
    try {
      const props = JSON.parse(raw);
      draft = !!props.draft;
      // Remote (Pexels) B-roll is fetched by headless Chrome during the render and
      // that fetch was failing mid-way on big files. Download every remote asset
      // once into public/broll/ and render from disk instead.
      await localizeRemoteBrolls(props);
      raw = JSON.stringify(props);
    } catch (e) {
      console.error('render: could not prepare props:', e);
    }
    const id = String(Date.now());
    const propsFile = path.join(ROOT, `.props-${id}.json`);
    const outName = `edited-${id}${draft ? '-draft' : ''}.mp4`;
    const outFile = path.join(EXPORTS, outName);
    fs.writeFileSync(propsFile, raw);
    renders[id] = {status: 'running', progress: 0};

    // tuned for a many-core machine: higher concurrency + faster x264 preset +
    // a big OffthreadVideo cache (lots of trimmed segments seek the sources a lot).
    // Draft: half resolution + ultrafast — for quick checks, ~40% faster.
    // scale to the machine: leave 2 cores for the browser/encoder, cap the
    // OffthreadVideo cache at a quarter of RAM (max 4 GB)
    const concurrency = Math.max(2, Math.min(16, os.cpus().length - 2));
    const cacheBytes = Math.min(4e9, Math.max(5e8, Math.floor(os.totalmem() / 4)));
    const args = [
      'remotion', 'render', 'MultiClip', outFile, `--props=${propsFile}`,
      `--concurrency=${concurrency}`,
      `--x264-preset=${draft ? 'ultrafast' : 'veryfast'}`,
      `--offthreadvideo-cache-size-in-bytes=${cacheBytes}`,
      ...(draft ? ['--scale=0.5'] : []),
    ];
    const child = spawn('npx', args, {cwd: ROOT});
    let errTail = ''; // keep the tail of output so failures show a real message
    const onProgress = (d) => {
      const s = String(d);
      const m = s.match(/Rendered\s+(\d+)\/(\d+)/);
      if (m) renders[id].progress = Math.round((+m[1] / +m[2]) * 100);
      errTail = (errTail + s).slice(-2000);
    };
    child.stdout.on('data', onProgress);
    child.stderr.on('data', onProgress);
    child.on('close', (code) => {
      fs.rmSync(propsFile, {force: true});
      if (code === 0) renders[id] = {status: 'done', progress: 100, file: `/exports/${outName}`};
      else {
        const line = errTail.split('\n').reverse().find((l) => /error|Error/.test(l))?.trim().slice(0, 200);
        console.error(`render ${id} failed:\n${errTail.slice(-1200)}`);
        renders[id] = {status: 'error', error: line || `render exited ${code}`};
      }
    });
    return json(res, 200, {jobId: id});
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/render/')) {
    const id = url.pathname.split('/').pop();
    return json(res, 200, renders[id] ?? {status: 'unknown'});
  }

  json(res, 404, {error: 'not found'});
});

// a single bad request/job must not kill the whole backend
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

server.listen(3333, () => console.log('editor backend → http://localhost:3333'));
