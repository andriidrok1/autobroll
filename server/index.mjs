// Мини-backend редактора:
//   E8  сохранение/загрузка проекта на диск (project.json)
//   E9  рендер в mp4
//   E10 импорт видео: загрузка клипа → весь pipeline → авто-субтитры
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const EXPORTS = path.join(PUBLIC, 'exports');
const PROJECT = path.join(PUBLIC, 'project.json');
const CLIP = path.join(PUBLIC, 'clip.mp4');
fs.mkdirSync(EXPORTS, {recursive: true});

const renders = {}; // jobId -> {status, progress, file, error}
const imports = {}; // jobId -> {status, step, label, progress, error}

// шаги pipeline для оценки прогресса импорта
const IMPORT_STEPS = ['meta', 'transcribe', 'accents', 'placement', 'done'];

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

  // ---- E8: сохранить / загрузить проект (на диск) ----
  if (req.method === 'POST' && url.pathname === '/api/save') {
    fs.writeFileSync(PROJECT, await body(req));
    return json(res, 200, {ok: true});
  }
  if (req.method === 'GET' && url.pathname === '/api/project') {
    if (!fs.existsSync(PROJECT)) return json(res, 404, {error: 'no project'});
    return json(res, 200, JSON.parse(fs.readFileSync(PROJECT, 'utf8')));
  }

  // ---- E10: импорт видео + запуск pipeline ----
  if (req.method === 'POST' && url.pathname === '/api/import') {
    const id = String(Date.now());
    imports[id] = {status: 'uploading', step: 'upload', label: 'Uploading video', progress: 0};

    // бинарно-безопасная запись загружаемого видео в public/clip.mp4
    const ws = fs.createWriteStream(CLIP);
    req.pipe(ws);
    req.on('error', () => (imports[id] = {status: 'error', error: 'upload failed'}));
    ws.on('error', () => (imports[id] = {status: 'error', error: 'write failed'}));
    ws.on('finish', () => {
      // свежий клип → старый проект больше не релевантен
      fs.rmSync(PROJECT, {force: true});
      imports[id] = {status: 'running', step: 'meta', label: 'Reading video metadata', progress: 5};

      const child = spawn('node', ['scripts/pipeline.mjs'], {cwd: ROOT, env: process.env});
      const onChunk = (d) => {
        for (const m of String(d).matchAll(/STEP:(\w+):([^\n]+)/g)) {
          const [, sid, label] = m;
          const idx = IMPORT_STEPS.indexOf(sid);
          imports[id] = {
            ...imports[id],
            status: 'running',
            step: sid,
            label: label.trim(),
            progress: idx >= 0 ? Math.round(((idx + 1) / IMPORT_STEPS.length) * 100) : imports[id].progress,
          };
        }
      };
      child.stdout.on('data', onChunk);
      child.stderr.on('data', onChunk);
      child.on('close', (code) => {
        if (code === 0) imports[id] = {status: 'done', step: 'done', label: 'Ready', progress: 100};
        else imports[id] = {status: 'error', error: `pipeline exited ${code} (see server logs)`};
      });
    });
    return json(res, 200, {jobId: id});
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/import/')) {
    const id = url.pathname.split('/').pop();
    return json(res, 200, imports[id] ?? {status: 'unknown'});
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

    const child = spawn('npx', ['remotion', 'render', 'Captioned', outFile, `--props=${propsFile}`], {cwd: ROOT});
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

server.listen(3333, () => console.log('editor backend → http://localhost:3333'));
