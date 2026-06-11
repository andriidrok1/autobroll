// `npm start` — run the whole app with one command:
//   backend (port 3333) + editor frontend (vite, port 5173)
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
fs.mkdirSync(path.join(ROOT, 'public'), {recursive: true}); // vite needs it on a fresh clone

const procs = [
  spawn('node', ['server/index.mjs'], {cwd: ROOT, stdio: 'inherit'}),
  spawn('npx', ['vite'], {cwd: ROOT, stdio: 'inherit'}),
];

const killAll = () => procs.forEach((p) => { try { p.kill('SIGTERM'); } catch {} });
process.on('SIGINT', () => { killAll(); process.exit(0); });
process.on('SIGTERM', () => { killAll(); process.exit(0); });
// if either process dies, stop the other one too
procs.forEach((p) => p.on('exit', (code) => { killAll(); process.exit(code ?? 0); }));
