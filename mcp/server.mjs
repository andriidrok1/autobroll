#!/usr/bin/env node
// AutoBroll MCP server — lets Claude (Code / Desktop) drive the editor:
// read a project, edit clips / captions / B-roll / music, run the AI steps,
// render, and look at frames. Talks to the same backend as the browser UI
// (`npm start`, port 3333) so results are identical; pure edits also work
// with the backend down (written straight to public/projects/<id>.json).
//
//   claude mcp add autobroll -- node /path/to/autobroll/mcp/server.mjs
//
// Project model (see src/timeline.ts, src/captions.ts, src/Broll.tsx):
//   clips[]    ordered, back-to-back on the timeline; inSec/outSec trim the source
//   captions[] anchored to a clip, times are SOURCE-relative ms
//   brolls[]   same anchoring
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const PROJECTS = path.join(PUBLIC, 'projects');
const API = process.env.AUTOBROLL_API || 'http://localhost:3333';
const FPS = 30;

// ---------- .env ----------
const ENV = {};
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) ENV[m[1]] = m[2].trim();
  }
} catch {}

// ---------- project io ----------
const projFile = (id) => {
  if (!/^[\w-]+$/.test(id)) throw new Error(`bad project id: ${id}`);
  return path.join(PROJECTS, `${id}.json`);
};
function load(id) {
  const f = projFile(id);
  if (!fs.existsSync(f)) throw new Error(`project ${id} not found (use list_projects)`);
  const p = JSON.parse(fs.readFileSync(f, 'utf8'));
  p.clips ??= []; p.captions ??= []; p.brolls ??= []; p.brollAssets ??= []; p.music ??= null; p.accentColor ??= '#FFB020';
  return p;
}
async function save(id, p) {
  // prefer the backend (single writer, sets updatedAt the same way the UI does)
  try {
    const r = await fetch(`${API}/api/projects/${id}`, {method: 'POST', body: JSON.stringify(p)});
    if (r.ok) return (await r.json()).updatedAt;
  } catch {}
  const now = new Date().toISOString();
  fs.mkdirSync(PROJECTS, {recursive: true});
  fs.writeFileSync(projFile(id), JSON.stringify({...p, createdAt: p.createdAt || now, updatedAt: now}, null, 2));
  return now;
}
async function backendUp() {
  try { return (await fetch(`${API}/api/projects`)).ok; } catch { return false; }
}
const needBackend = async () => {
  if (!(await backendUp())) throw new Error(`AutoBroll backend is not running at ${API} — run \`npm start\` in the autobroll folder`);
};

// ---------- timeline math (mirrors src/timeline.ts) ----------
const clipDur = (c) => Math.max(0, (c.outSec - c.inSec) / (c.speed ?? 1));
function place(clips) {
  let acc = 0;
  return clips.map((clip) => {
    const durFrames = Math.max(1, Math.round(clipDur(clip) * FPS));
    const fromFrame = acc; acc += durFrames;
    return {clip, startMs: (fromFrame / FPS) * 1000, endMs: ((fromFrame + durFrames) / FPS) * 1000};
  });
}
const totalSec = (clips) => place(clips).at(-1)?.endMs / 1000 || 0;
// absolute timeline second → {clip, sourceSec}
function locate(p, atSec) {
  const ms = atSec * 1000;
  const pc = place(p.clips).find((x) => ms >= x.startMs && ms < x.endMs) ?? place(p.clips).at(-1);
  if (!pc) throw new Error('project has no clips');
  const speed = pc.clip.speed ?? 1;
  const sourceSec = pc.clip.inSec + ((ms - pc.startMs) / 1000) * speed;
  return {clip: pc.clip, sourceSec: Math.min(pc.clip.outSec, Math.max(pc.clip.inSec, sourceSec)), pc};
}
// source-relative ms on a clip → absolute seconds (null if trimmed away)
function toAbs(p, clipId, srcMs, clamp = false) {
  const pc = place(p.clips).find((x) => x.clip.id === clipId);
  if (!pc) return null;
  const inMs = pc.clip.inSec * 1000, outMs = pc.clip.outSec * 1000;
  if (clamp) srcMs = Math.min(outMs, Math.max(inMs, srcMs)); // ends may run past the clip (the player clips them)
  else if (srcMs < inMs || srcMs > outMs) return null;
  return (pc.startMs + (srcMs - inMs) / (pc.clip.speed ?? 1)) / 1000;
}
const f1 = (n) => (Math.round(n * 10) / 10).toFixed(1);
const capText = (c) => c.words.map((w) => (w.accent ? `*${w.text}*` : w.text)).join(' ');

function summary(id, p) {
  const out = [];
  out.push(`Project "${p.name || 'Untitled project'}" (id ${id}) — ${f1(totalSec(p.clips))}s, ${p.clips.length} clips, ${p.captions.length} captions, ${p.brolls.length} B-roll, music ${p.music ? path.basename(p.music.src) + ` vol ${p.music.volume}` : 'none'}, accent ${p.accentColor}`);
  out.push('', 'CLIPS (timeline order):');
  place(p.clips).forEach((pc, i) => {
    const c = pc.clip;
    const extra = [c.speed && c.speed !== 1 ? `speed ${c.speed}x` : '', c.muted ? 'muted' : '', c.volume != null && c.volume !== 1 ? `vol ${c.volume}` : '', c.transform?.length ? `${c.transform.length} keyframes` : ''].filter(Boolean).join(', ');
    out.push(`  ${i + 1}. ${c.id}  @${f1(pc.startMs / 1000)}–${f1(pc.endMs / 1000)}s  source ${path.basename(c.src)} [${f1(c.inSec)}–${f1(c.outSec)} of ${f1(c.sourceDurationSec)}s]${extra ? '  ' + extra : ''}`);
  });
  out.push('', 'CAPTIONS (timeline time; *word* = accent):');
  const caps = p.captions.map((c) => ({c, at: c.clipId ? toAbs(p, c.clipId, c.startMs) : c.startMs / 1000})).filter((x) => x.at != null).sort((a, b) => a.at - b.at);
  for (const {c, at} of caps) out.push(`  ${c.id}  @${f1(at)}s  top ${c.topPct}%${c.scale && c.scale !== 1 ? ` scale ${c.scale}` : ''}  "${capText(c)}"`);
  const hidden = p.captions.length - caps.length;
  if (hidden) out.push(`  (+${hidden} captions on trimmed-away parts, not shown)`);
  out.push('', 'B-ROLL:');
  for (const b of p.brolls) {
    const at = b.clipId ? toAbs(p, b.clipId, b.startMs) : b.startMs / 1000;
    const end = b.clipId ? toAbs(p, b.clipId, b.endMs, true) : b.endMs / 1000;
    out.push(`  ${b.id}  @${at == null ? '?' : f1(at)}–${end == null ? '?' : f1(end)}s  ${b.mode} ${b.kind}${b.scale && b.scale !== 1 ? ` scale ${b.scale}` : ''}  ${b.query ? `"${b.query}"` : ''} ${b.source ?? ''} ${/^https?:/.test(b.src) ? '' : path.basename(b.src)}`.replace(/\s+/g, ' '));
  }
  if (!p.brolls.length) out.push('  none');
  if (p.brollAssets.length) out.push('', `OWN FOOTAGE (for B-roll): ${p.brollAssets.map((a) => `${a.id} (${a.kind}, ${a.label})`).join(', ')}`);
  return out.join('\n');
}

// ---------- backend jobs ----------
async function runJob(route, body, maxSec = 1800) {
  await needBackend();
  const {jobId, error} = await fetch(`${API}${route}`, {method: 'POST', body: JSON.stringify(body)}).then((r) => r.json());
  if (!jobId) throw new Error(error || `${route} did not start`);
  const t0 = Date.now();
  for (;;) {
    const s = await fetch(`${API}${route}/${jobId}`).then((r) => r.json());
    if (s.status === 'done') return s;
    if (s.status === 'error') throw new Error(s.error || `${route} failed`);
    if (s.status === 'unknown') throw new Error('job vanished (backend restarted?)');
    if ((Date.now() - t0) / 1000 > maxSec) throw new Error(`${route} timed out`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}
const readPublic = (f) => JSON.parse(fs.readFileSync(path.join(PUBLIC, f), 'utf8'));

// mirrors store.applyAutocut
function applyAutocut(p, plan) {
  const byId = new Map(plan.map((x) => [x.id, x.segments]));
  const newClips = []; const remap = []; const taken = new Set(p.clips.map((c) => c.id));
  const uniq = (base) => { let id = base, n = 1; while (taken.has(id)) id = `${base}-c${n++}`; taken.add(id); return id; };
  for (const c of p.clips) {
    const segs = byId.get(c.id);
    if (!segs?.length) { newClips.push(c); continue; }
    segs.forEach((seg, k) => {
      const id = k === 0 ? c.id : uniq(`${c.id}-c${k}`);
      newClips.push({...c, id, inSec: seg.inSec, outSec: seg.outSec});
      remap.push({origId: c.id, segId: id, inMs: seg.inSec * 1000, outMs: seg.outSec * 1000});
    });
  }
  const reanchor = (items) => items.map((it) => {
    if (!it.clipId) return it;
    const segs = remap.filter((r) => r.origId === it.clipId);
    if (!segs.length) return it;
    const inside = segs.find((r) => it.startMs >= r.inMs && it.startMs < r.outMs);
    const target = inside ?? segs.reduce((best, r) => (Math.abs(r.inMs - it.startMs) < Math.abs(best.inMs - it.startMs) ? r : best), segs[0]);
    return {...it, clipId: target.segId};
  });
  return {...p, clips: newClips, captions: reanchor(p.captions), brolls: reanchor(p.brolls)};
}
// mirrors Editor.generateCaptions merge: keep existing (incl. manual edits), add fresh for uncovered clips
function mergeCaptions(p, fresh) {
  const clipById = new Map(p.clips.map((c) => [c.id, c]));
  const visible = (c) => { if (!c.clipId) return true; const cl = clipById.get(c.clipId); return !!cl && c.startMs < cl.outSec * 1000 && c.endMs > cl.inSec * 1000; };
  const kept = p.captions.filter((c) => !c.clipId || clipById.has(c.clipId));
  const covered = new Set(kept.filter(visible).map((c) => c.clipId).filter(Boolean));
  const added = fresh.filter((c) => c.clipId && !covered.has(c.clipId));
  return {captions: [...kept, ...added].map((c, i) => ({...c, id: `c${i}`})), added: added.length};
}
const renumber = (items, prefix) => items.map((x, i) => ({...x, id: `${prefix}${i}`}));

// retime new words evenly across the old page span
function retext(cap, text) {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) throw new Error('empty caption text');
  const span = cap.endMs - cap.startMs;
  const step = span / words.length;
  return {...cap, words: words.map((t, i) => ({text: t, startMs: Math.round(cap.startMs + i * step), endMs: Math.round(cap.startMs + (i + 1) * step), accent: false}))};
}
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9%$]/gi, '');

// ---------- Pexels ----------
async function pexels(query, kind, count) {
  const key = ENV.PEXELS_API_KEY || process.env.PEXELS_API_KEY;
  if (!key) throw new Error('PEXELS_API_KEY missing in .env');
  const url = kind === 'video'
    ? `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=${count}&orientation=portrait`
    : `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${count}&orientation=portrait`;
  const d = await fetch(url, {headers: {Authorization: key}}).then((r) => r.json());
  if (kind === 'video') {
    return (d.videos ?? []).map((v) => {
      const files = (v.video_files ?? []).filter((f) => f.file_type === 'video/mp4' && f.height);
      const tall = files.filter((f) => f.height >= 1920).sort((a, b) => a.height - b.height);
      const pick = tall[0] ?? files.sort((a, b) => b.height - a.height)[0];
      return pick ? {src: pick.link, duration: v.duration, size: `${pick.width}x${pick.height}`, page: v.url} : null;
    }).filter(Boolean);
  }
  return (d.photos ?? []).map((ph) => ({src: ph.src?.large2x || ph.src?.large, alt: ph.alt, page: ph.url})).filter((x) => x.src);
}

// ---------- server ----------
const server = new McpServer({name: 'autobroll', version: '0.4.0'});
const text = (s) => ({content: [{type: 'text', text: s}]});
const pid = z.string().describe('project id from list_projects (e.g. "p-1789542691547")');
const sec = (d) => z.number().describe(d);

server.registerTool('list_projects', {description: 'List AutoBroll projects (id, name, clip count, last update).', inputSchema: {}}, async () => {
  fs.mkdirSync(PROJECTS, {recursive: true});
  const rows = fs.readdirSync(PROJECTS).filter((f) => f.endsWith('.json')).map((f) => {
    try { const p = JSON.parse(fs.readFileSync(path.join(PROJECTS, f), 'utf8')); return {id: f.slice(0, -5), name: p.name || 'Untitled project', clips: p.clips?.length ?? 0, updatedAt: p.updatedAt}; } catch { return null; }
  }).filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return text(rows.length ? rows.map((r) => `${r.id}  "${r.name}"  ${r.clips} clips  updated ${r.updatedAt ?? '?'}`).join('\n') : 'No projects yet — drop clips into the editor (npm start → http://localhost:5173) or use add_clips.');
});

server.registerTool('get_project', {description: 'Full readable state of a project: clips on the timeline, every caption with its text/accents/position, B-roll cues, music. Call this before editing and again after to verify.', inputSchema: {project_id: pid}}, async ({project_id}) => text(summary(project_id, load(project_id))));

server.registerTool('duplicate_project', {description: 'Copy a project under a new id/name (safe sandbox for experiments).', inputSchema: {project_id: pid, name: z.string().optional()}}, async ({project_id, name}) => {
  const p = load(project_id); const id = `p-${Date.now()}`;
  await save(id, {...p, name: name || `${p.name || 'Untitled project'} (copy)`, createdAt: undefined});
  return text(`Created ${id} "${name || (p.name || 'Untitled project') + ' (copy)'}"`);
});

server.registerTool('rename_project', {description: 'Rename a project.', inputSchema: {project_id: pid, name: z.string()}}, async ({project_id, name}) => { const p = load(project_id); p.name = name; await save(project_id, p); return text(`Renamed to "${name}"`); });

server.registerTool('set_accent_color', {description: 'Set the caption accent (highlight) color, hex like #FFB020.', inputSchema: {project_id: pid, color: z.string().regex(/^#[0-9a-fA-F]{6}$/)}}, async ({project_id, color}) => { const p = load(project_id); p.accentColor = color; await save(project_id, p); return text(`Accent color ${color}`); });

server.registerTool('add_clips', {description: 'Add video files to a project (absolute paths on this machine). Uploads through the backend (remux + thumbnail). New project if project_id is omitted.', inputSchema: {project_id: pid.optional(), files: z.array(z.string()).min(1), name: z.string().optional()}}, async ({project_id, files, name}) => {
  await needBackend();
  const id = project_id || `p-${Date.now()}`;
  const p = project_id ? load(project_id) : {name: name || 'Untitled project', clips: [], captions: [], brolls: [], brollAssets: [], music: null, accentColor: '#FFB020'};
  const added = [];
  for (const f of files) {
    if (!fs.existsSync(f)) throw new Error(`file not found: ${f}`);
    const r = await fetch(`${API}/api/add-clip?name=${encodeURIComponent(path.basename(f))}`, {method: 'POST', body: fs.readFileSync(f)}).then((x) => x.json());
    if (!r.id) throw new Error(`upload failed for ${f}: ${r.error ?? ''}`);
    p.clips.push(r); added.push(`${r.id} (${f1(r.outSec)}s)`);
  }
  await save(id, p);
  return text(`Project ${id}: added ${added.join(', ')}\n\n${summary(id, p)}`);
});

server.registerTool('reorder_clips', {description: 'Set the timeline order. Clips not listed keep their relative order after the listed ones.', inputSchema: {project_id: pid, clip_ids: z.array(z.string()).min(1)}}, async ({project_id, clip_ids}) => {
  const p = load(project_id); const byId = new Map(p.clips.map((c) => [c.id, c]));
  for (const id of clip_ids) if (!byId.has(id)) throw new Error(`no clip ${id}`);
  p.clips = [...clip_ids.map((id) => byId.get(id)), ...p.clips.filter((c) => !clip_ids.includes(c.id))];
  await save(project_id, p); return text(summary(project_id, p));
});

server.registerTool('trim_clip', {description: 'Change where a clip starts/ends inside its source file (seconds, source time). Captions and B-roll on trimmed-away parts disappear automatically.', inputSchema: {project_id: pid, clip_id: z.string(), in_sec: sec('new start inside the source').optional(), out_sec: sec('new end inside the source').optional()}}, async ({project_id, clip_id, in_sec, out_sec}) => {
  const p = load(project_id); const c = p.clips.find((x) => x.id === clip_id); if (!c) throw new Error(`no clip ${clip_id}`);
  if (in_sec != null) c.inSec = Math.max(0, in_sec); if (out_sec != null) c.outSec = Math.min(c.sourceDurationSec, out_sec);
  if (c.outSec - c.inSec < 0.2) throw new Error('clip would be shorter than 0.2 s');
  await save(project_id, p); return text(`${clip_id}: ${f1(c.inSec)}–${f1(c.outSec)}s (${f1(clipDur(c))}s on the timeline)`);
});

server.registerTool('set_clip', {description: 'Per-clip playback: speed (0.25–4), volume (0–2), muted.', inputSchema: {project_id: pid, clip_id: z.string(), speed: z.number().min(0.25).max(4).optional(), volume: z.number().min(0).max(2).optional(), muted: z.boolean().optional()}}, async ({project_id, clip_id, speed, volume, muted}) => {
  const p = load(project_id); const c = p.clips.find((x) => x.id === clip_id); if (!c) throw new Error(`no clip ${clip_id}`);
  if (speed != null) c.speed = speed; if (volume != null) c.volume = volume; if (muted != null) c.muted = muted;
  await save(project_id, p); return text(`${clip_id}: speed ${c.speed ?? 1}x, volume ${c.volume ?? 1}, ${c.muted ? 'muted' : 'audio on'}`);
});

server.registerTool('delete_clips', {description: 'Remove clips from the timeline (their captions/B-roll go with them).', inputSchema: {project_id: pid, clip_ids: z.array(z.string()).min(1)}}, async ({project_id, clip_ids}) => {
  const p = load(project_id); const gone = new Set(clip_ids);
  p.clips = p.clips.filter((c) => !gone.has(c.id)); p.captions = p.captions.filter((c) => !c.clipId || !gone.has(c.clipId)); p.brolls = p.brolls.filter((b) => !b.clipId || !gone.has(b.clipId));
  await save(project_id, p); return text(summary(project_id, p));
});

server.registerTool('split_clip', {description: 'Split the clip under a timeline time into two (like pressing S at the playhead). To cut a moment out: split twice, then delete_clips the middle piece.', inputSchema: {project_id: pid, at_sec: sec('timeline time in seconds')}}, async ({project_id, at_sec}) => {
  const p = load(project_id); const {clip, sourceSec} = locate(p, at_sec);
  if (sourceSec - clip.inSec < 0.2 || clip.outSec - sourceSec < 0.2) throw new Error('too close to the clip edge (min 0.2 s each side)');
  const newId = `${clip.id}-s${Date.now().toString(36)}`;
  const a = {...clip, outSec: sourceSec, transform: clip.transform?.filter((k) => k.t < sourceSec)};
  const b = {...clip, id: newId, inSec: sourceSec, transform: clip.transform?.filter((k) => k.t >= sourceSec)};
  p.clips = p.clips.flatMap((c) => (c.id === clip.id ? [a, b] : [c]));
  const re = (items) => items.map((it) => (it.clipId === clip.id && it.startMs >= sourceSec * 1000 ? {...it, clipId: newId} : it));
  p.captions = re(p.captions); p.brolls = re(p.brolls);
  await save(project_id, p); return text(`Split ${clip.id} at ${f1(at_sec)}s → ${clip.id} + ${newId}\n\n${summary(project_id, p)}`);
});

server.registerTool('set_keyframes', {description: 'Replace a clip\'s zoom/pan keyframes. t = source-time seconds; scale 1 = none; x/y = pan in px of the 1080x1920 frame. Empty list removes the animation. Two keyframes = smooth move between them.', inputSchema: {project_id: pid, clip_id: z.string(), keyframes: z.array(z.object({t: z.number(), scale: z.number().min(0.5).max(4), x: z.number().default(0), y: z.number().default(0)}))}}, async ({project_id, clip_id, keyframes}) => {
  const p = load(project_id); const c = p.clips.find((x) => x.id === clip_id); if (!c) throw new Error(`no clip ${clip_id}`);
  c.transform = keyframes.length ? [...keyframes].sort((a, b) => a.t - b.t) : undefined;
  await save(project_id, p); return text(`${clip_id}: ${keyframes.length} keyframes`);
});

server.registerTool('edit_caption', {description: 'Edit one caption page: new text (words are re-timed evenly across the page), which words to accent (gold), vertical position top_pct (0–100, % from top), size scale (1 = default).', inputSchema: {project_id: pid, caption_id: z.string(), text: z.string().optional(), accent_words: z.array(z.string()).optional().describe('exact words to highlight; [] clears accents'), top_pct: z.number().min(0).max(95).optional(), scale: z.number().min(0.5).max(2).optional()}}, async ({project_id, caption_id, text: t, accent_words, top_pct, scale}) => {
  const p = load(project_id); const i = p.captions.findIndex((c) => c.id === caption_id); if (i < 0) throw new Error(`no caption ${caption_id}`);
  let cap = p.captions[i];
  if (t != null) cap = retext(cap, t);
  if (accent_words) { const set = new Set(accent_words.map(norm)); cap = {...cap, words: cap.words.map((w) => ({...w, accent: set.has(norm(w.text))}))}; }
  if (top_pct != null) cap.topPct = top_pct; if (scale != null) cap.scale = scale;
  p.captions[i] = cap; await save(project_id, p);
  return text(`${caption_id}: "${capText(cap)}" top ${cap.topPct}%${cap.scale ? ` scale ${cap.scale}` : ''}`);
});

server.registerTool('add_caption', {description: 'Add a caption page at a timeline time (seconds) lasting duration_sec.', inputSchema: {project_id: pid, at_sec: sec('timeline start'), duration_sec: z.number().min(0.3).default(2), text: z.string(), accent_words: z.array(z.string()).optional(), top_pct: z.number().min(0).max(95).optional()}}, async ({project_id, at_sec, duration_sec, text: t, accent_words, top_pct}) => {
  const p = load(project_id); const {clip, sourceSec} = locate(p, at_sec);
  const startMs = Math.round(sourceSec * 1000); const endMs = Math.round(Math.min(clip.outSec, sourceSec + duration_sec * (clip.speed ?? 1)) * 1000);
  let cap = retext({id: 'x', clipId: clip.id, startMs, endMs, topPct: top_pct ?? p.captions.find((c) => c.clipId === clip.id)?.topPct ?? 58, words: []}, t);
  if (accent_words) { const set = new Set(accent_words.map(norm)); cap.words = cap.words.map((w) => ({...w, accent: set.has(norm(w.text))})); }
  p.captions = renumber([...p.captions, cap], 'c'); await save(project_id, p);
  return text(`Added caption on ${clip.id} @${f1(at_sec)}s: "${capText(cap)}" (id ${p.captions.at(-1).id})`);
});

server.registerTool('delete_captions', {description: 'Delete caption pages by id.', inputSchema: {project_id: pid, caption_ids: z.array(z.string()).min(1)}}, async ({project_id, caption_ids}) => {
  const p = load(project_id); const gone = new Set(caption_ids); const before = p.captions.length;
  p.captions = p.captions.filter((c) => !gone.has(c.id)); await save(project_id, p);
  return text(`Deleted ${before - p.captions.length} caption(s); ${p.captions.length} left (ids unchanged)`);
});

server.registerTool('search_stock', {description: 'Search Pexels for portrait stock video/photos to use as B-roll. Returns URLs for add_broll / edit_broll.', inputSchema: {query: z.string(), kind: z.enum(['video', 'image']).default('video'), count: z.number().min(1).max(10).default(5)}}, async ({query, kind, count}) => {
  const rows = await pexels(query, kind, count);
  return text(rows.length ? rows.map((r, i) => `${i + 1}. ${r.src}${r.duration ? `  ${r.duration}s ${r.size}` : r.alt ? `  "${r.alt}"` : ''}`).join('\n') : 'nothing found');
});

server.registerTool('add_broll', {description: 'Overlay B-roll from at_sec for duration_sec. src = Pexels URL (from search_stock), a path inside public/ (e.g. "broll/x.mp4"), or an absolute file path (copied in). mode: fullscreen | top (upper 45%) | inset (small card top-right).', inputSchema: {project_id: pid, at_sec: sec('timeline start'), duration_sec: z.number().min(0.3), src: z.string(), kind: z.enum(['video', 'image']), mode: z.enum(['fullscreen', 'top', 'inset']).default('inset'), label: z.string().optional()}}, async ({project_id, at_sec, duration_sec, src, kind, mode, label}) => {
  const p = load(project_id); const {clip, sourceSec} = locate(p, at_sec);
  let s = src;
  if (!/^https?:/.test(src) && path.isAbsolute(src)) {
    if (!fs.existsSync(src)) throw new Error(`file not found: ${src}`);
    const dir = path.join(PUBLIC, 'broll'); fs.mkdirSync(dir, {recursive: true});
    const name = path.basename(src).replace(/[^\w.\-]/g, '_'); fs.copyFileSync(src, path.join(dir, name)); s = `broll/${name}`;
  } else if (!/^https?:/.test(src) && !fs.existsSync(path.join(PUBLIC, src))) throw new Error(`not found in public/: ${src}`);
  const b = {id: 'x', clipId: clip.id, startMs: Math.round(sourceSec * 1000), endMs: Math.round(Math.min(clip.outSec, sourceSec + duration_sec * (clip.speed ?? 1)) * 1000), kind, mode, src: s, source: /^https?:/.test(s) ? 'pexels' : 'own', query: label, alternatives: []};
  p.brolls = renumber([...p.brolls, b], 'b'); await save(project_id, p);
  return text(`Added B-roll ${p.brolls.at(-1).id} on ${clip.id} @${f1(at_sec)}s (${mode} ${kind})`);
});

server.registerTool('edit_broll', {description: 'Change a B-roll cue: mode, size scale, source URL/path, or move/resize it on the timeline (seconds).', inputSchema: {project_id: pid, broll_id: z.string(), mode: z.enum(['fullscreen', 'top', 'inset']).optional(), scale: z.number().min(0.3).max(3).optional(), src: z.string().optional(), start_sec: sec('new timeline start').optional(), end_sec: sec('new timeline end').optional()}}, async ({project_id, broll_id, mode, scale, src, start_sec, end_sec}) => {
  const p = load(project_id); const b = p.brolls.find((x) => x.id === broll_id); if (!b) throw new Error(`no B-roll ${broll_id}`);
  if (mode) b.mode = mode; if (scale != null) b.scale = scale; if (src) { b.src = src; b.source = /^https?:/.test(src) ? 'pexels' : 'own'; }
  if (start_sec != null) { const {clip, sourceSec} = locate(p, start_sec); b.clipId = clip.id; const len = b.endMs - b.startMs; b.startMs = Math.round(sourceSec * 1000); b.endMs = Math.min(Math.round(clip.outSec * 1000), b.startMs + len); }
  if (end_sec != null) { const {clip, sourceSec} = locate(p, end_sec); if (clip.id !== b.clipId) throw new Error('end must be on the same clip as the start'); b.endMs = Math.max(b.startMs + 300, Math.round(sourceSec * 1000)); }
  await save(project_id, p); return text(`${broll_id}: ${b.mode} ${b.kind}${b.scale ? ` scale ${b.scale}` : ''} @${f1(toAbs(p, b.clipId, b.startMs, true) ?? 0)}–${f1(toAbs(p, b.clipId, b.endMs, true) ?? 0)}s`);
});

server.registerTool('delete_brolls', {description: 'Delete B-roll cues by id.', inputSchema: {project_id: pid, broll_ids: z.array(z.string()).min(1)}}, async ({project_id, broll_ids}) => {
  const p = load(project_id); const gone = new Set(broll_ids); const before = p.brolls.length;
  p.brolls = p.brolls.filter((b) => !gone.has(b.id)); await save(project_id, p); return text(`Deleted ${before - p.brolls.length} B-roll cue(s)`);
});

server.registerTool('set_music', {description: 'Set or remove the music track. file = absolute path (copied into public/music) or "music/<name>" already there. volume 0–1, fade_out_sec, duck = lower under speech.', inputSchema: {project_id: pid, file: z.string().nullable(), volume: z.number().min(0).max(1).default(0.25), fade_out_sec: z.number().min(0).default(1.5), duck: z.boolean().default(true)}}, async ({project_id, file, volume, fade_out_sec, duck}) => {
  const p = load(project_id);
  if (file === null) { p.music = null; await save(project_id, p); return text('Music removed'); }
  let src = file;
  if (path.isAbsolute(file)) { if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`); const dir = path.join(PUBLIC, 'music'); fs.mkdirSync(dir, {recursive: true}); const name = path.basename(file).replace(/[^\w.\-]/g, '_'); fs.copyFileSync(file, path.join(dir, name)); src = `music/${name}`; }
  else if (!fs.existsSync(path.join(PUBLIC, file))) throw new Error(`not found in public/: ${file}`);
  p.music = {src, volume, startSec: 0, fadeOutSec: fade_out_sec, duck, duckLevel: 0.25}; await save(project_id, p);
  return text(`Music ${src} vol ${volume}, fade ${fade_out_sec}s, duck ${duck}`);
});

server.registerTool('run_ai_step', {description: 'Run one AI step on the project exactly like the editor buttons, and apply the result. arrange = transcribe + order takes (returns duplicate-take suggestion, does not delete); autocut = remove silence/pauses (splits clips into segments); captions = WhisperX + accents + face-aware placement (keeps existing captions on clips that already have them); broll = plan + source B-roll (replaces current cues). Needs the backend (npm start).', inputSchema: {project_id: pid, step: z.enum(['arrange', 'autocut', 'captions', 'broll'])}}, async ({project_id, step}) => {
  let p = load(project_id); if (!p.clips.length) throw new Error('project has no clips');
  if (step === 'arrange') {
    await runJob('/api/arrange', {clips: p.clips}); const {order, best} = readPublic('clip-order.json');
    if (Array.isArray(order)) { const byId = new Map(p.clips.map((c) => [c.id, c])); p.clips = [...order.map((id) => byId.get(id)).filter(Boolean), ...p.clips.filter((c) => !order.includes(c.id))]; }
    await save(project_id, p);
    const dup = Array.isArray(best) && best.length < p.clips.length ? p.clips.filter((c) => !best.includes(c.id)).map((c) => c.id) : [];
    return text(`Arranged.${dup.length ? ` Suggested duplicate takes to remove: ${dup.join(', ')} (use delete_clips if you agree).` : ''}\n\n${summary(project_id, p)}`);
  }
  if (step === 'autocut') {
    await runJob('/api/trim-silence', {clips: p.clips}); const {plan} = readPublic('trim-silence.json');
    if (!Array.isArray(plan) || !plan.length) return text('Nothing to cut');
    p = applyAutocut(p, plan); await save(project_id, p);
    return text(`Autocut: ${plan.reduce((n, x) => n + (x.segments?.length ?? 0), 0)} segments\n\n${summary(project_id, p)}`);
  }
  if (step === 'captions') {
    await runJob('/api/captions', {clips: p.clips}); const fresh = readPublic('captions.multi.json');
    const {captions, added} = mergeCaptions(p, Array.isArray(fresh) ? fresh : []); p.captions = captions; await save(project_id, p);
    return text(`Captions: +${added} new (${p.captions.length} total)\n\n${summary(project_id, p)}`);
  }
  await runJob('/api/broll', {clips: p.clips, brollAssets: p.brollAssets}); const items = readPublic('broll.json');
  p.brolls = Array.isArray(items) ? items : []; await save(project_id, p);
  return text(`B-roll: ${p.brolls.length} cues\n\n${summary(project_id, p)}`);
});

server.registerTool('render', {description: 'Export the project to mp4 (1080x1920). draft = half resolution, fast. Returns the file path.', inputSchema: {project_id: pid, draft: z.boolean().default(false)}}, async ({project_id, draft}) => {
  const p = load(project_id); if (!p.clips.length) throw new Error('project has no clips');
  const r = await runJob('/api/render', {clips: p.clips, music: p.music, captions: p.captions, brolls: p.brolls, accentColor: p.accentColor, draft});
  const file = path.join(PUBLIC, r.file.replace(/^\//, ''));
  return text(`Rendered ${draft ? '(draft) ' : ''}→ ${file}  (${(fs.statSync(file).size / 1e6).toFixed(1)} MB, ${f1(totalSec(p.clips))}s)`);
});

server.registerTool('frame_at', {description: 'Look at a frame. Without `video`: the raw source frame at that timeline time (no captions/B-roll). With `video` = a rendered mp4 path from render: the finished frame with everything on it.', inputSchema: {project_id: pid, at_sec: sec('timeline time in seconds'), video: z.string().optional()}}, async ({project_id, at_sec, video}) => {
  const p = load(project_id);
  let file, t;
  if (video) { file = video; t = at_sec; } else { const {clip, sourceSec} = locate(p, at_sec); file = path.join(PUBLIC, clip.src); t = sourceSec; }
  if (!fs.existsSync(file)) throw new Error(`not found: ${file}`);
  const out = path.join(ROOT, '.captions-tmp', `mcp-frame-${Date.now()}.jpg`); fs.mkdirSync(path.dirname(out), {recursive: true});
  const ff = spawnSync('ffmpeg', ['-y', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=540:-2', '-q:v', '4', out]);
  if (ff.status !== 0 || !fs.existsSync(out)) throw new Error('ffmpeg could not extract the frame');
  const data = fs.readFileSync(out).toString('base64'); fs.rmSync(out, {force: true});
  return {content: [{type: 'text', text: `${video ? 'rendered' : 'source'} frame @${f1(at_sec)}s`}, {type: 'image', data, mimeType: 'image/jpeg'}]};
});

server.registerTool('health', {description: 'Check the AutoBroll environment (backend, ffmpeg, WhisperX, API keys).', inputSchema: {}}, async () => {
  if (!(await backendUp())) return text(`Backend not running at ${API}. Run \`npm start\` in ${ROOT}. Pure edits still work; AI steps and render need it.`);
  const h = await fetch(`${API}/api/health`).then((r) => r.json());
  return text(h.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.label}${c.ok ? '' : ' — ' + c.hint}`).join('\n'));
});

await server.connect(new StdioServerTransport());
