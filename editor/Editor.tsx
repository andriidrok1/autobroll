import React, {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {Player, type PlayerRef} from '@remotion/player';
import {MultiClipVideo} from '../src/MultiClipVideo';
import {placeClips, sampleTransform} from '../src/timeline';
import {projectCaptions} from '../src/captions';
import {useEditor} from './store';
import {Timeline} from './Timeline';
import {AssetsSidebar} from './AssetsSidebar';
import {Inspector} from './Inspector';

const fmt = (sec: number) => {
  const s = Math.max(0, sec);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

// Premounted (upcoming) clips are in the DOM but invisible — they must not win
// hit-tests or selection-box measurement.
const isVisibleNode = (el: HTMLElement | null): boolean => {
  let n = el;
  while (n) {
    const cs = getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
    n = n.parentElement;
  }
  return true;
};

// Poll a background job to completion with dead-job (server restart) + timeout guards.
function pollJob(
  base: string,
  jobId: string,
  onProgress: (s: {label?: string; progress?: number}) => void,
  onDone: () => void,
  onFail: (msg: string) => void,
  maxAttempts = 600, // ×1.5s ≈ 15 min (exports pass a higher cap)
) {
  let attempts = 0;
  let netFails = 0;
  const poll = setInterval(async () => {
    attempts++;
    let s: {status?: string; label?: string; progress?: number; error?: string};
    try {
      s = await fetch(`${base}/${jobId}`).then((x) => x.json());
      netFails = 0;
    } catch {
      if (++netFails > 5) { clearInterval(poll); onFail('Lost connection to the server'); }
      return;
    }
    if (s.status === 'running') {
      onProgress(s);
      if (attempts > maxAttempts) { clearInterval(poll); onFail('Timed out'); }
      return;
    }
    clearInterval(poll);
    if (s.status === 'done') onDone();
    else onFail(s.error || (s.status === 'unknown' ? 'Job not found (server restarted?)' : 'Failed'));
  }, 1500);
}

export const Editor: React.FC<{onBackToStart: () => void}> = ({onBackToStart}) => {
  const {
    meta, projectId, projectName, clips, music, captions, brolls, accentColor, selectedId, currentFrame, past, future,
    brollAssets, dupSuggestion, selectedClipId, select, selectClip, setCurrentFrame, setTopPct, setCaptionScale, setBrollScale, setKeyframe, removeKeyframe, setCaptions, setBrolls, setClipOrder, applyAutocut, removeClips, setDupSuggestion, setProjectName, pushHistory, undo, redo,
  } = useEditor();
  const playerRef = useRef<PlayerRef>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [exp, setExp] = useState<{status: string; progress?: number; file?: string} | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genLabel, setGenLabel] = useState('');
  const [brollGen, setBrollGen] = useState(false);
  const [brollLabel, setBrollLabel] = useState('');
  const [arranging, setArranging] = useState(false);
  const [arrangeLabel, setArrangeLabel] = useState('');
  const [trimming, setTrimming] = useState(false);
  const [trimLabel, setTrimLabel] = useState('');
  const [playing, setPlaying] = useState(false);
  const [boxRect, setBoxRect] = useState<{left: number; top: number; w: number; h: number} | null>(null);
  const [notice, setNotice] = useState<{msg: string; kind: 'error' | 'ok'} | null>(null);
  const notify = (msg: string, kind: 'error' | 'ok') => {
    setNotice({msg, kind});
    window.setTimeout(() => setNotice(null), kind === 'error' ? 6000 : 3000);
  };

  // Stable Player props: rebuild ONLY when the data changes, never on the
  // per-frame currentFrame updates — otherwise the Player re-syncs the video
  // every frame and stutters/repeats a fraction of a second.
  const inputProps = useMemo(
    () => ({clips, music, captions, brolls, accentColor}),
    [clips, music, captions, brolls, accentColor],
  );

  // (project load + Start/Editor routing live in App.tsx)

  // autosave the whole project to its own file (debounced). Note: no clips.length
  // guard — deleting the last clip must persist too (init() nulls projectId, so a
  // freshly cleared state never overwrites another project).
  useEffect(() => {
    if (!meta || !projectId) return;
    const t = setTimeout(() => {
      fetch('/api/projects/' + projectId, {
        method: 'POST',
        body: JSON.stringify({name: projectName, clips, music, captions, brolls, brollAssets, accentColor}),
      }).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [meta, projectId, projectName, clips, music, captions, brolls, brollAssets, accentColor]);

  // undo/redo keyboard (not while typing)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault(); // play/pause, not page scroll
        playerRef.current?.toggle();
        return;
      }
      if (e.key.toLowerCase() === 's' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault(); // split clip at playhead (read fresh frame from store)
        const st = useEditor.getState();
        st.splitClipAtFrame(st.currentFrame);
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // sync playhead + play state from the player
  useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    const onFrame = (e: {detail: {frame: number}}) => setCurrentFrame(e.detail.frame);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    p.addEventListener('frameupdate', onFrame);
    p.addEventListener('play', onPlay);
    p.addEventListener('pause', onPause);
    return () => {
      p.removeEventListener('frameupdate', onFrame);
      p.removeEventListener('play', onPlay);
      p.removeEventListener('pause', onPause);
    };
  }, [meta, setCurrentFrame]);

  // Measure the selected caption/b-roll element in the preview DOM and draw a
  // selection box over it. Runs every render (guarded) so the box tracks the
  // element as it moves/scales. Remotion Player renders real DOM → queryable.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) { if (boxRect) setBoxRect(null); return; }
    // a selected clip wins; otherwise a selected caption/b-roll
    let sel: {kind: string; id: string} | null = null;
    if (selectedClipId) sel = {kind: 'clip', id: selectedClipId};
    else if (selectedId && captions.some((c) => c.id === selectedId)) sel = {kind: 'cap', id: selectedId};
    else if (selectedId && brolls.some((b) => b.id === selectedId)) sel = {kind: 'broll', id: selectedId};
    if (!sel) { if (boxRect) setBoxRect(null); return; }
    const node = document.querySelector(`[data-ab="${sel.kind}:${sel.id}"]`) as HTMLElement | null;
    // hide the box when the element isn't actually on screen (premounted/out of playhead)
    if (!node || !isVisibleNode(node)) { if (boxRect) setBoxRect(null); return; }
    const r = node.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    const nb = {left: r.left - s.left, top: r.top - s.top, w: r.width, h: r.height};
    setBoxRect((prev) =>
      prev && Math.abs(prev.left - nb.left) < 0.5 && Math.abs(prev.top - nb.top) < 0.5 && Math.abs(prev.w - nb.w) < 0.5 && Math.abs(prev.h - nb.h) < 0.5 ? prev : nb,
    );
  });

  const exportVideo = async (draft = false) => {
    setExp({status: 'running', progress: 0});
    try {
      const r = await fetch('/api/render', {method: 'POST', body: JSON.stringify({clips, music, captions, brolls, accentColor, draft})}).then((x) => x.json());
      pollJob(
        '/api/render', r.jobId,
        (s) => setExp({status: 'running', progress: s.progress ?? 0}),
        async () => {
          const s = await fetch('/api/render/' + r.jobId).then((x) => x.json());
          setExp(s);
          notify('Export ready', 'ok');
        },
        (msg) => { setExp({status: 'error'}); notify('Export failed: ' + msg, 'error'); },
        2400, // renders can take a while — allow up to ~1h
      );
    } catch {
      setExp({status: 'error'});
      notify('Could not start export', 'error');
    }
  };

  const generateCaptions = async () => {
    setGenerating(true);
    setGenLabel('Starting…');
    try {
      const {jobId} = await fetch('/api/captions', {method: 'POST', body: JSON.stringify({clips})}).then((x) => x.json());
      pollJob(
        '/api/captions', jobId,
        (s) => setGenLabel(`${s.label ?? ''} ${s.progress ?? 0}%`),
        async () => {
          const fresh = await fetch(`/captions.multi.json?_=${Date.now()}`).then((x) => x.json()).catch(() => []);
          // MERGE: keep existing captions (incl. manual edits); only add for clips without any.
          const have = new Set(captions.map((c) => c.clipId).filter(Boolean));
          const added = (Array.isArray(fresh) ? fresh : []).filter((c) => c.clipId && !have.has(c.clipId));
          const merged = [...captions, ...added].map((c, i) => ({...c, id: `c${i}`}));
          pushHistory();
          setCaptions(merged);
          setGenerating(false);
          notify(added.length ? `Captions ready (+${added.length})` : 'Captions up to date', 'ok');
        },
        (msg) => { setGenerating(false); notify('Captions failed: ' + msg, 'error'); },
      );
    } catch {
      setGenerating(false);
      notify('Could not start caption generation', 'error');
    }
  };

  const generateBroll = async () => {
    setBrollGen(true);
    setBrollLabel('Starting…');
    try {
      const {jobId} = await fetch('/api/broll', {method: 'POST', body: JSON.stringify({clips, brollAssets})}).then((x) => x.json());
      pollJob(
        '/api/broll', jobId,
        (s) => setBrollLabel(`${s.label ?? ''} ${s.progress ?? 0}%`),
        async () => {
          const items = await fetch(`/broll.json?_=${Date.now()}`).then((x) => x.json()).catch(() => []);
          setBrolls(Array.isArray(items) ? items : []);
          setBrollGen(false);
          notify(`B-roll ready (${Array.isArray(items) ? items.length : 0} cues)`, 'ok');
        },
        (msg) => { setBrollGen(false); notify('B-roll failed: ' + msg, 'error'); },
      );
    } catch {
      setBrollGen(false);
      notify('Could not start B-roll', 'error');
    }
  };

  // Auto-trim leading/trailing silence on every clip (uses cached transcripts).
  const trimSilence = async () => {
    setTrimming(true);
    setTrimLabel('Starting…');
    try {
      const {jobId} = await fetch('/api/trim-silence', {method: 'POST', body: JSON.stringify({clips})}).then((x) => x.json());
      pollJob(
        '/api/trim-silence', jobId,
        (s) => setTrimLabel(`${s.label ?? ''} ${s.progress ?? 0}%`),
        async () => {
          const {plan} = await fetch(`/trim-silence.json?_=${Date.now()}`).then((x) => x.json()).catch(() => ({plan: null}));
          if (Array.isArray(plan) && plan.length) applyAutocut(plan);
          setTrimming(false);
          const cuts = Array.isArray(plan) ? plan.reduce((n, p) => n + (p.segments?.length ?? 0), 0) : 0;
          notify(Array.isArray(plan) && plan.length ? `Autocut — ${plan.length} clip(s) → ${cuts} segment(s)` : 'Nothing to cut', 'ok');
        },
        (msg) => { setTrimming(false); notify('Autocut failed: ' + msg, 'error'); },
      );
    } catch {
      setTrimming(false);
      notify('Could not start silence trim', 'error');
    }
  };

  // AI listens to every clip and reorders them into a coherent sequence.
  // Transcripts are cached, so Generate Captions afterwards won't re-transcribe.
  const arrangeClips = async () => {
    setArranging(true);
    setArrangeLabel('Starting…');
    try {
      const {jobId} = await fetch('/api/arrange', {method: 'POST', body: JSON.stringify({clips})}).then((x) => x.json());
      pollJob(
        '/api/arrange', jobId,
        (s) => setArrangeLabel(`${s.label ?? ''} ${s.progress ?? 0}%`),
        async () => {
          const {order, best} = await fetch(`/clip-order.json?_=${Date.now()}`).then((x) => x.json()).catch(() => ({order: null, best: null}));
          setArranging(false);
          if (!Array.isArray(order)) { notify('Arrange failed', 'error'); return; }
          setClipOrder(order); // reorder only (keep all) — pushes its own history
          const removeIds = Array.isArray(best) ? order.filter((id: string) => !best.includes(id)) : [];
          setDupSuggestion(removeIds); // non-destructive: user confirms in the banner
          notify(removeIds.length ? `Arranged — ${removeIds.length} duplicate take(s) can be removed` : 'Clips arranged', 'ok');
        },
        (msg) => { setArranging(false); notify('Arrange failed: ' + msg, 'error'); },
      );
    } catch {
      setArranging(false);
      notify('Could not start auto-arrange', 'error');
    }
  };

  if (!meta) return <Center>Loading…</Center>;

  const totalSec = meta.durationInFrames / meta.fps;
  const nowMs = (currentFrame / meta.fps) * 1000;
  // captions are clip-anchored → project to absolute for hit-testing the preview
  const projCaps = projectCaptions(captions, clips, meta.fps);
  const visibleCaption = projCaps.find((c, i) => {
    const nextStart = projCaps[i + 1]?.startMs ?? Infinity;
    const visEnd = Math.min(nextStart, c.endMs + 700, c.holdMaxMs ?? Infinity);
    return nowMs >= c.startMs && nowMs < visEnd;
  });

  // keyframe context for the selected clip at the current playhead
  const clipKfCtx = (clipId: string) => {
    const clip = clips.find((c) => c.id === clipId);
    const pc = placeClips(clips, meta.fps).find((p) => p.clip.id === clipId);
    if (!clip || !pc) return null;
    const sourceSec = Math.min(clip.outSec, Math.max(clip.inSec, clip.inSec + ((currentFrame - pc.fromFrame) / meta.fps) * (clip.speed ?? 1)));
    return {clip, sourceSec, cur: sampleTransform(clip.transform, sourceSec)};
  };

  // drag the selection box corner to scale: clip → zoom keyframe; caption/b-roll → static scale
  const startResize = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const isClip = !!selectedClipId;
    const id = (selectedClipId || selectedId)!;
    if (!id) return;
    const kind = isClip ? 'clip' : captions.some((c) => c.id === id) ? 'cap' : 'broll';
    const node = document.querySelector(`[data-ab="${kind}:${id}"]`);
    if (!node) return;
    const r = node.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const startDist = Math.hypot(e.clientX - cx, e.clientY - cy) || 1;
    const ctx = isClip ? clipKfCtx(id) : null;
    const startScale = isClip ? ctx?.cur.scale ?? 1 : (kind === 'cap' ? captions.find((c) => c.id === id) : brolls.find((b) => b.id === id))?.scale ?? 1;
    let snapped = false; // push history once, only when the drag actually moves
    const move = (ev: PointerEvent) => {
      if (!snapped && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) > 2) { pushHistory(); snapped = true; }
      if (!snapped) return;
      const dist = Math.hypot(ev.clientX - cx, ev.clientY - cy);
      const ns = Math.min(4, Math.max(0.3, (startScale * dist) / startDist));
      if (isClip && ctx) setKeyframe(id, ctx.sourceSec, {scale: ns, x: ctx.cur.x, y: ctx.cur.y});
      else if (kind === 'cap') setCaptionScale(id, ns);
      else setBrollScale(id, ns);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // add (or toggle off) a keyframe at the playhead, pinning the clip's current transform
  const toggleKeyframe = () => {
    if (!selectedClipId) return;
    const ctx = clipKfCtx(selectedClipId);
    if (!ctx) return;
    const existing = (ctx.clip.transform ?? []).find((k) => Math.abs(k.t - ctx.sourceSec) < 0.06);
    if (existing) {
      removeKeyframe(selectedClipId, ctx.sourceSec); // pushes its own history step
    } else {
      pushHistory();
      setKeyframe(selectedClipId, ctx.sourceSec, ctx.cur);
    }
  };

  // clip boundaries for skip prev/next
  const bounds = placeClips(clips, meta.fps).map((p) => p.fromFrame);
  const skip = (dir: -1 | 1) => {
    const sorted = [...bounds, meta.durationInFrames].sort((a, b) => a - b);
    const target = dir < 0
      ? [...sorted].reverse().find((f) => f < currentFrame - 2) ?? 0
      : sorted.find((f) => f > currentFrame + 2) ?? meta.durationInFrames;
    playerRef.current?.seekTo(target);
  };

  // topmost VISIBLE composition element (clip/b-roll/caption) under a screen point
  const elementAt = (x: number, y: number): {kind: string; id: string} | null => {
    let found: {kind: string; id: string} | null = null;
    document.querySelectorAll('[data-ab]').forEach((n) => {
      const el = n as HTMLElement;
      if (!isVisibleNode(el)) return; // skip premounted/hidden sequences
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        const [kind, id] = (el.dataset.ab || '').split(':');
        if (id) found = {kind, id}; // last match wins ≈ topmost (captions render above b-roll)
      }
    });
    return found;
  };

  // click the preview to select what's under the cursor.
  //   caption → vertical drag to reposition · b-roll → select · clip → select + pan (x/y keyframe)
  const onStagePointerDown = (e: React.PointerEvent) => {
    const rect = stageRef.current?.getBoundingClientRect();
    const hit = elementAt(e.clientX, e.clientY);
    if (!hit || !rect) { playerRef.current?.toggle(); return; }

    if (hit.kind === 'cap') {
      select(hit.id);
      const cap = captions.find((c) => c.id === hit.id);
      if (!cap) return;
      const startY = e.clientY;
      const startTop = cap.topPct;
      let snapped = false;
      const move = (ev: PointerEvent) => {
        const dPct = ((ev.clientY - startY) / rect.height) * 100;
        if (Math.abs(ev.clientY - startY) > 3 && !snapped) { pushHistory(); snapped = true; }
        setTopPct(hit.id, Math.min(88, Math.max(5, startTop + dPct)));
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      return;
    }

    if (hit.kind === 'broll') { select(hit.id); return; }

    // clip: select + drag to pan (writes an x/y keyframe at the playhead)
    selectClip(hit.id);
    const ctx = clipKfCtx(hit.id);
    if (!ctx) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const cur = ctx.cur;
    let snapped = false;
    const move = (ev: PointerEvent) => {
      const dx = ((ev.clientX - startX) / rect.width) * 100;
      const dy = ((ev.clientY - startY) / rect.height) * 100;
      if ((Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - startY) > 3) && !snapped) { pushHistory(); snapped = true; }
      if (snapped) setKeyframe(hit.id, ctx.sourceSec, {scale: cur.scale, x: cur.x + dx, y: cur.y + dy});
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-background text-on-surface">
      {/* toast */}
      {notice && (
        <div
          className={`fixed top-3 left-1/2 -translate-x-1/2 z-[100] px-4 py-2 rounded-lg text-body-md font-medium shadow-lg border ${
            notice.kind === 'error' ? 'bg-error-container text-on-error-container border-error/40' : 'bg-surface-container-high text-on-surface border-outline-variant'
          }`}
        >
          {notice.msg}
        </div>
      )}
      {/* Top bar */}
      <header className="bg-surface-container border-b border-outline-variant flex justify-between items-center h-12 px-4 z-50 shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={onBackToStart} title="Back to projects" className="flex items-center gap-1 text-on-surface-variant hover:text-on-surface transition-colors">
            <span className="material-symbols-outlined text-[20px]">arrow_back</span>
            <span className="text-headline-md font-headline-md font-bold">AutoBroll</span>
          </button>
          <div className="h-4 w-px bg-outline-variant" />
          <input
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            className="bg-transparent text-primary font-bold text-body-md border-b border-transparent focus:border-primary focus:outline-none px-1 max-w-[220px]"
            placeholder="Untitled project"
          />
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 mr-2">
            <HdrIcon icon="undo" title="Undo (⌘Z)" onClick={undo} disabled={!past.length} />
            <HdrIcon icon="redo" title="Redo (⇧⌘Z)" onClick={redo} disabled={!future.length} />
          </div>
          <button
            onClick={arrangeClips}
            disabled={arranging || clips.length < 2}
            title="Let AI listen and order the clips"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-outline-variant text-on-surface-variant hover:bg-surface-variant disabled:opacity-40 transition-colors text-body-md font-bold"
          >
            <span className={`material-symbols-outlined text-[18px] ${arranging ? 'animate-spin' : ''}`}>{arranging ? 'progress_activity' : 'sort'}</span>
            {arranging ? (arrangeLabel || 'Arranging…') : 'Auto-arrange'}
          </button>
          <button
            onClick={trimSilence}
            disabled={trimming || !clips.length}
            title="Cut silence at the ends AND long pauses inside every clip"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-outline-variant text-on-surface-variant hover:bg-surface-variant disabled:opacity-40 transition-colors text-body-md font-bold"
          >
            <span className={`material-symbols-outlined text-[18px] ${trimming ? 'animate-spin' : ''}`}>{trimming ? 'progress_activity' : 'cut'}</span>
            {trimming ? (trimLabel || 'Cutting…') : 'Autocut'}
          </button>
          {exp?.status === 'running' && <span className="text-body-sm text-on-surface-variant">Rendering… {exp.progress ?? 0}%</span>}
          {exp?.status === 'done' && exp.file && <a href={exp.file} download className="text-body-sm text-[#39d98a]">↓ Download mp4</a>}
          {exp?.status === 'error' && <span className="text-body-sm text-error">Render error</span>}
          <button
            onClick={() => exportVideo(true)}
            disabled={exp?.status === 'running'}
            title="Half resolution, fastest encode — for a quick check (~40% faster)"
            className="px-3 py-1.5 rounded-lg border border-outline-variant text-on-surface-variant hover:bg-surface-variant disabled:opacity-40 transition-colors text-body-md font-bold"
          >
            Draft
          </button>
          <button onClick={() => exportVideo(false)} disabled={exp?.status === 'running'} className="bg-primary-container text-on-primary-container px-4 py-1.5 rounded-lg font-bold text-body-md hover:brightness-110 active:scale-95 disabled:opacity-40 transition-all">
            Export mp4
          </button>
        </div>
      </header>

      {/* Auto-arrange duplicate-removal suggestion (non-destructive until confirmed) */}
      {dupSuggestion.length > 0 && (
        <div className="flex items-center justify-between gap-3 px-4 py-2 bg-primary-container/20 border-b border-primary/30 text-body-md shrink-0">
          <span className="text-on-surface">
            <span className="material-symbols-outlined text-[16px] align-middle mr-1 text-primary">auto_awesome</span>
            AI grouped your takes — remove <b>{dupSuggestion.length}</b> duplicate take(s), keeping the best of each? (⌘Z undoes)
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={() => setDupSuggestion([])} className="px-3 py-1 rounded-lg text-on-surface-variant hover:bg-surface-variant font-bold">Keep all</button>
            <button
              onClick={() => { const n = dupSuggestion.length; removeClips(dupSuggestion); notify(`Removed ${n} duplicate take(s)`, 'ok'); }}
              className="px-3 py-1 rounded-lg bg-primary-container text-on-primary-container font-bold hover:brightness-110"
            >
              Remove duplicates
            </button>
          </div>
        </div>
      )}

      <main className="flex-1 flex overflow-hidden">
        <AssetsSidebar playerRef={playerRef} />

        {/* Preview + transport */}
        <section className="flex-1 bg-surface-dim flex flex-col min-w-0">
          <div className="flex-1 flex items-center justify-center p-6 min-h-0">
            <div className="relative h-full" style={{aspectRatio: `${meta.width} / ${meta.height}`}}>
              <Player
                ref={playerRef}
                component={MultiClipVideo}
                inputProps={inputProps}
                durationInFrames={meta.durationInFrames}
                fps={meta.fps}
                compositionWidth={meta.width}
                compositionHeight={meta.height}
                style={{width: '100%', height: '100%', borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(70,69,84,0.3)'}}
              />
              <div ref={stageRef} onPointerDown={onStagePointerDown} className="absolute inset-0" style={{cursor: selectedClipId ? 'move' : visibleCaption ? 'grab' : 'default'}} />

              {/* selection box + corner resize handle (caption / b-roll / clip) */}
              {boxRect && (
                <>
                  <div
                    className="absolute border-2 border-primary rounded-sm pointer-events-none z-20"
                    style={{left: boxRect.left, top: boxRect.top, width: boxRect.w, height: boxRect.h}}
                  />
                  <div
                    onPointerDown={startResize}
                    title="Drag to resize"
                    className="absolute z-30 w-4 h-4 -ml-2 -mt-2 bg-primary border-2 border-white rounded-sm cursor-nwse-resize hover:scale-110 transition-transform"
                    style={{left: boxRect.left + boxRect.w, top: boxRect.top + boxRect.h}}
                  />
                </>
              )}

              {/* clip keyframe (flag) control — appears when a clip is selected */}
              {selectedClipId && (
                <button
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={toggleKeyframe}
                  title="Add/remove a keyframe at the playhead (then move + resize to animate)"
                  className="absolute z-30 top-2 left-2 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-surface-container-high/95 border border-outline-variant text-on-surface text-body-sm font-bold hover:bg-surface-variant"
                >
                  <span className="material-symbols-outlined text-[16px] text-primary" style={{fontVariationSettings: "'FILL' 1"}}>diamond</span>
                  Keyframe
                </button>
              )}
            </div>
          </div>

          {/* transport */}
          <div className="h-14 bg-surface-container-low border-t border-outline-variant flex items-center justify-between px-6 shrink-0">
            <span className="font-mono text-mono-label text-primary">{fmt(currentFrame / meta.fps)} / {fmt(totalSec)}</span>
            <div className="flex items-center gap-6">
              <button onClick={() => skip(-1)} className="material-symbols-outlined text-on-surface-variant hover:text-primary transition-colors">skip_previous</button>
              <button onClick={() => playerRef.current?.toggle()} className="w-10 h-10 rounded-full bg-on-surface text-surface flex items-center justify-center hover:scale-105 active:scale-95 transition-all">
                <span className="material-symbols-outlined text-[26px]" style={{fontVariationSettings: "'FILL' 1"}}>{playing ? 'pause' : 'play_arrow'}</span>
              </button>
              <button onClick={() => skip(1)} className="material-symbols-outlined text-on-surface-variant hover:text-primary transition-colors">skip_next</button>
            </div>
            <button onClick={() => playerRef.current?.requestFullscreen()} className="material-symbols-outlined text-on-surface-variant hover:text-primary transition-colors text-[20px]">fullscreen</button>
          </div>
        </section>

        <Inspector
          playerRef={playerRef}
          onGenerate={generateCaptions}
          generating={generating}
          progressLabel={genLabel}
          onGenerateBroll={generateBroll}
          brollGenerating={brollGen}
          brollLabel={brollLabel}
        />
      </main>

      {/* Timeline */}
      <footer className="bg-surface-container-lowest border-t border-outline-variant z-50 shrink-0" style={{height: 300}}>
        <Timeline playerRef={playerRef} />
      </footer>
    </div>
  );
};

const HdrIcon: React.FC<{icon: string; title: string; onClick: () => void; disabled?: boolean}> = ({icon, title, onClick, disabled}) => (
  <button
    title={title}
    onClick={onClick}
    disabled={disabled}
    className="p-1.5 rounded-lg hover:bg-surface-variant transition-colors text-on-surface-variant disabled:opacity-30"
  >
    <span className="material-symbols-outlined text-[20px]">{icon}</span>
  </button>
);

const Center: React.FC<{children: React.ReactNode}> = ({children}) => (
  <div className="flex h-screen items-center justify-center text-on-surface-variant">{children}</div>
);
