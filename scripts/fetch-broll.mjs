// Скачивает B-roll с Pexels по плану. Сохраняет в public/broll/, хранит
// альтернативы (для свапа в редакторе). public/broll-plan.json → public/broll.json
import fs from 'node:fs';
import path from 'node:path';

function loadEnv() {
  const p = path.join(process.cwd(), '.env');
  if (fs.existsSync(p)) for (const l of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = l.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
  if (!process.env.PEXELS_API_KEY) throw new Error('PEXELS_API_KEY not in .env');
  return process.env.PEXELS_API_KEY;
}
const KEY = loadEnv();
const DIR = 'public/broll';
fs.mkdirSync(DIR, {recursive: true});

const headers = {Authorization: KEY};

async function searchPexels(query, kind) {
  if (kind === 'video') {
    const r = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=6&orientation=portrait`, {headers});
    const d = await r.json();
    return (d.videos ?? []).map((v) => {
      const file = (v.video_files ?? []).filter((f) => f.file_type === 'video/mp4').sort((a, b) => (b.height || 0) - (a.height || 0))[0];
      return file?.link;
    }).filter(Boolean);
  }
  const r = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=6&orientation=portrait`, {headers});
  const d = await r.json();
  return (d.photos ?? []).map((p) => p.src?.large2x || p.src?.large).filter(Boolean);
}

async function download(url, dest) {
  const r = await fetch(url);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

const plan = JSON.parse(fs.readFileSync('public/broll-plan.json', 'utf8'));
const out = [];

for (const b of plan) {
  const urls = await searchPexels(b.query, b.kind);
  if (!urls.length) {
    console.log(`  ✗ no results for "${b.query}"`);
    continue;
  }
  const ext = b.kind === 'video' ? 'mp4' : 'jpg';
  const file = `${b.id}.${ext}`;
  await download(urls[0], path.join(DIR, file));
  out.push({...b, src: `/broll/${file}`, alternatives: urls.slice(0, 6)});
  console.log(`  ✓ ${b.id} "${b.query}" → ${file} (${urls.length} options)`);
}

fs.writeFileSync('public/broll.json', JSON.stringify(out, null, 2));
console.log(`DONE → public/broll.json (${out.length}/${plan.length} fetched)`);
