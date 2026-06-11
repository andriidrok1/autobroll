// Editor backend (port 3333):
//   projects   — multi-project library (list/get/save/delete)
//   add-clip   — upload video → remux/encode + thumbnail → return clip
//   music      — upload an audio track
//   captions   — per-clip WhisperX → accents → captions (job)
//   broll      — Gemini detect → own assets / Pexels (job)
//   arrange    — transcribe → Gemini orders clips (job)
//   render     — export the MultiClip composition to mp4 (job)
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

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
            thumbClipId: p.clips?.[0]?.id || null,
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

  // ---- generate captions for the current cut (per-clip WhisperX → accents) ----
  if (req.method === 'POST' && url.pathname === '/api/captions') {
    const id = String(Date.now());
    const clipsFile = path.join(ROOT, `.clips-${id}.json`);
    fs.writeFileSync(clipsFile, await body(req)); // {clips:[...]}
    captionJobs[id] = {status: 'running', progress: 0, label: 'Starting'};

    const child = spawn('node', ['scripts/captions-multiclip.mjs', clipsFile], {cwd: ROOT, env: process.env});
    const onChunk = (d) => {
      for (const m of String(d).matchAll(/PROGRESS:(\d+):([^\n]+)/g)) {
        captionJobs[id] = {status: 'running', progress: +m[1], label: m[2].trim()};
      }
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', (d) => {
      onChunk(d);
      process.stderr.write(d); // surface whisper/gemini errors in server logs
    });
    child.on('close', (code) => {
      fs.rmSync(clipsFile, {force: true});
      if (code === 0) captionJobs[id] = {status: 'done', progress: 100, label: 'Ready'};
      else captionJobs[id] = {status: 'error', error: `captions exited ${code} (see server logs)`};
    });
    return json(res, 200, {jobId: id});
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/captions/')) {
    const id = url.pathname.split('/').pop();
    return json(res, 200, captionJobs[id] ?? {status: 'unknown'});
  }

  // ---- auto-trim leading/trailing silence per clip (uses cached transcripts) ----
  if (req.method === 'POST' && url.pathname === '/api/trim-silence') {
    const id = String(Date.now());
    const inFile = path.join(ROOT, `.trim-${id}.json`);
    fs.writeFileSync(inFile, await body(req));
    trimJobs[id] = {status: 'running', progress: 0, label: 'Starting'};
    const child = spawn('node', ['scripts/trim-silence.mjs', inFile], {cwd: ROOT, env: process.env});
    const onChunk = (d) => {
      for (const m of String(d).matchAll(/PROGRESS:(\d+):([^\n]+)/g)) {
        trimJobs[id] = {status: 'running', progress: +m[1], label: m[2].trim()};
      }
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', (d) => { onChunk(d); process.stderr.write(d); });
    child.on('close', (code) => {
      fs.rmSync(inFile, {force: true});
      trimJobs[id] = code === 0 ? {status: 'done', progress: 100, label: 'Ready'} : {status: 'error', error: `trim exited ${code}`};
    });
    return json(res, 200, {jobId: id});
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/trim-silence/')) {
    const id = url.pathname.split('/').pop();
    return json(res, 200, trimJobs[id] ?? {status: 'unknown'});
  }

  // ---- auto-arrange clips into a coherent order (transcribe → Gemini order) ----
  if (req.method === 'POST' && url.pathname === '/api/arrange') {
    const id = String(Date.now());
    const inFile = path.join(ROOT, `.arrange-${id}.json`);
    fs.writeFileSync(inFile, await body(req)); // {clips}
    arrangeJobs[id] = {status: 'running', progress: 0, label: 'Starting'};
    const child = spawn('node', ['scripts/arrange-clips.mjs', inFile], {cwd: ROOT, env: process.env});
    const onChunk = (d) => {
      for (const m of String(d).matchAll(/PROGRESS:(\d+):([^\n]+)/g)) {
        arrangeJobs[id] = {status: 'running', progress: +m[1], label: m[2].trim()};
      }
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', (d) => { onChunk(d); process.stderr.write(d); });
    child.on('close', (code) => {
      fs.rmSync(inFile, {force: true});
      arrangeJobs[id] = code === 0 ? {status: 'done', progress: 100, label: 'Ready'} : {status: 'error', error: `arrange exited ${code}`};
    });
    return json(res, 200, {jobId: id});
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/arrange/')) {
    const id = url.pathname.split('/').pop();
    return json(res, 200, arrangeJobs[id] ?? {status: 'unknown'});
  }

  // ---- generate B-roll for the current cut (Gemini detect → own assets / Pexels) ----
  if (req.method === 'POST' && url.pathname === '/api/broll') {
    const id = String(Date.now());
    const inFile = path.join(ROOT, `.broll-${id}.json`);
    fs.writeFileSync(inFile, await body(req)); // {clips, brollAssets}
    brollJobs[id] = {status: 'running', progress: 0, label: 'Starting'};
    const child = spawn('node', ['scripts/broll-multiclip.mjs', inFile], {cwd: ROOT, env: process.env});
    const onChunk = (d) => {
      for (const m of String(d).matchAll(/PROGRESS:(\d+):([^\n]+)/g)) {
        brollJobs[id] = {status: 'running', progress: +m[1], label: m[2].trim()};
      }
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', (d) => { onChunk(d); process.stderr.write(d); });
    child.on('close', (code) => {
      fs.rmSync(inFile, {force: true});
      brollJobs[id] = code === 0 ? {status: 'done', progress: 100, label: 'Ready'} : {status: 'error', error: `broll exited ${code}`};
    });
    return json(res, 200, {jobId: id});
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/broll/')) {
    const id = url.pathname.split('/').pop();
    return json(res, 200, brollJobs[id] ?? {status: 'unknown'});
  }

  // ---- E9: запустить рендер ----
  if (req.method === 'POST' && url.pathname === '/api/render') {
    const props = await body(req); // {captions, accentColor}
    const id = String(Date.now());
    const propsFile = path.join(ROOT, `.props-${id}.json`);
    const outName = `edited-${id}.mp4`;
    const outFile = path.join(EXPORTS, outName);
    fs.writeFileSync(propsFile, props);
    renders[id] = {status: 'running', progress: 0};

    const child = spawn('npx', ['remotion', 'render', 'MultiClip', outFile, `--props=${propsFile}`], {cwd: ROOT});
    const onProgress = (d) => {
      const m = String(d).match(/Rendered\s+(\d+)\/(\d+)/);
      if (m) renders[id].progress = Math.round((+m[1] / +m[2]) * 100);
    };
    child.stdout.on('data', onProgress);
    child.stderr.on('data', onProgress);
    child.on('close', (code) => {
      fs.rmSync(propsFile, {force: true});
      if (code === 0) renders[id] = {status: 'done', progress: 100, file: `/exports/${outName}`};
      else renders[id] = {status: 'error', error: `render exited ${code}`};
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
