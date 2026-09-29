import React, {useEffect, useRef, useState} from 'react';
import type {PlayerRef} from '@remotion/player';
import {useEditor} from './store';
import {placeClips, clipDurationSec} from '../src/timeline';
import {projectCaptions} from '../src/captions';
import {projectBrolls} from '../src/Broll';
import {IconButton} from './IconButton';
import {focusIsFromKeyboard} from './modality';

// Unified multi-track timeline (Obsidian Edit design): Captions / Video / Audio
// share one ruler, playhead, horizontal scroll and zoom.
//   Captions — drag block = move, drag edges = retime, click = select+seek
//   Video    — clips back-to-back; drag edges = trim; ◀▶ reorder; click = select+seek
//   Audio    — music track (trim/volume in inspector)
// Keyboard: every block is a focusable button (Tab), Enter/Space selects it and
// seeks there; ←/→ nudge the playhead, Delete removes the selected clip (global
// handler in Editor.tsx).

const TRACK_H = 48;
const LABELS_W = 112;

const fmt = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

type WaveData = {peaks: number[]; durationSec: number};

// Enter always activates a block. Space activates it only when it was reached
// by keyboard (Tab) — after a mouse click Space keeps meaning play/pause (the
// window handler in Editor.tsx picks it up).
const keyActivate = (fn: () => void) => (e: React.KeyboardEvent<HTMLElement>) => {
  if (e.key === 'Enter' || (e.key === ' ' && focusIsFromKeyboard())) {
    e.preventDefault();
    e.stopPropagation();
    fn();
  }
};
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

// audio waveform (centered bars), stretched to the parent box
const Wave: React.FC<{peaks: number[]; color?: string}> = ({peaks, color = 'rgba(255,255,255,0.55)'}) => {
  if (!peaks.length) return null;
  const H = 32;
  let d = '';
  peaks.forEach((p, i) => {
    const h = Math.max(1, p * H);
    d += `M${i + 0.5} ${(H - h) / 2} v${h} `;
  });
  return (
    <svg viewBox={`0 0 ${peaks.length} ${H}`} preserveAspectRatio="none" className="absolute inset-0 w-full h-full pointer-events-none">
      <path d={d} stroke={color} strokeWidth={0.6} fill="none" />
    </svg>
  );
};

// slice the full-source peaks down to the clip's trimmed [inSec, outSec] window
const slicePeaks = (w: WaveData | undefined, inSec: number, outSec: number): number[] => {
  if (!w || !w.peaks.length || w.durationSec <= 0) return [];
  const n = w.peaks.length;
  const a = Math.max(0, Math.floor((inSec / w.durationSec) * n));
  const b = Math.min(n, Math.ceil((outSec / w.durationSec) * n));
  return w.peaks.slice(a, Math.max(a + 1, b));
};

export const Timeline: React.FC<{playerRef: React.RefObject<PlayerRef | null>}> = ({playerRef}) => {
  const {
    meta, captions, clips, music, brolls, selectedId, selectedClipId, currentFrame, dupSuggestion,
    select, selectClip, deleteClip, moveClipTo, trimClip, splitClipAtFrame, pushHistory,
  } = useEditor();
  const [pxPerSec, setPxPerSec] = useState(70);
  const [trimP, setTrimP] = useState<{id: string; side: 'left' | 'right'; dSec: number} | null>(null);
  const [drag, setDrag] = useState<{id: string; dx: number; targetIdx: number} | null>(null);
  const [waves, setWaves] = useState<Record<string, WaveData>>({});
  const wavesInflight = useRef<Set<string>>(new Set());
  const canvasRef = useRef<HTMLDivElement>(null);

  // fetch audio peaks for every local media on the timeline (cached server-side)
  const waveSrcs = [...new Set([...clips.map((c) => c.src), ...(music ? [music.src] : [])])].filter((s) => !/^https?:/.test(s));
  useEffect(() => {
    for (const src of waveSrcs) {
      if (waves[src] || wavesInflight.current.has(src)) continue;
      wavesInflight.current.add(src);
      fetch(`/api/waveform?src=${encodeURIComponent(src)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d?.peaks) setWaves((prev) => ({...prev, [src]: d})); })
        .catch(() => {})
        .finally(() => wavesInflight.current.delete(src));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waveSrcs.join('|')]);

  if (!meta) return null;

  const fps = meta.fps;
  const placed = placeClips(clips, fps);
  const totalSec = Math.max(meta.durationInFrames / fps, 1);
  const trackWidth = totalSec * pxPerSec;
  const pxPerMs = pxPerSec / 1000;
  const playheadX = (currentFrame / fps) * pxPerSec;
  const seekMs = (ms: number) => playerRef.current?.seekTo(Math.max(0, Math.round((ms / 1000) * fps)));
  const seekFrame = (f: number) => playerRef.current?.seekTo(Math.max(0, Math.round(f)));
  // captions + b-roll are clip-anchored → project for display (follow trims/reorders)
  const projCaps = projectCaptions(captions, clips, fps);
  const projBrolls = projectBrolls(brolls, clips, fps);

  // scrub the playhead: click anywhere on empty timeline + drag. Clip/caption/
  // b-roll blocks stopPropagation, so they don't trigger scrubbing.
  const scrubStart = (e: React.PointerEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const toMs = (clientX: number) => Math.max(0, (clientX - rect.left + (canvasRef.current?.scrollLeft ?? 0)) / pxPerMs);
    seekMs(toMs(e.clientX));
    const move = (ev: PointerEvent) => seekMs(toMs(ev.clientX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // clip trim. Packed timeline can't move the left edge live, so we preview the
  // edge under the cursor during the drag and commit (which re-packs) on release.
  const trimDrag = (e: React.PointerEvent, id: string, mode: 'left' | 'right', orig: {inSec: number; outSec: number; sourceDurationSec: number; speed: number}) => {
    e.stopPropagation();
    e.preventDefault();
    selectClip(id);
    const startX = e.clientX;
    let dSec = 0;
    let snapped = false; // push history once, and only if the drag actually moved
    const move = (ev: PointerEvent) => {
      if (!snapped && Math.abs(ev.clientX - startX) > 2) { pushHistory(); snapped = true; }
      // timeline px → SOURCE seconds (a sped-up clip consumes source faster)
      let d = ((ev.clientX - startX) / pxPerSec) * orig.speed;
      // clamp so we never invert the clip or exceed the source
      if (mode === 'left') d = Math.max(-orig.inSec, Math.min(d, orig.outSec - 0.2 - orig.inSec));
      else d = Math.max(orig.inSec + 0.2 - orig.outSec, Math.min(d, orig.sourceDurationSec - orig.outSec));
      dSec = d;
      setTrimP({id, side: mode, dSec: d});
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (snapped) {
        if (mode === 'left') trimClip(id, orig.inSec + dSec, orig.outSec);
        else trimClip(id, orig.inSec, orig.outSec + dSec);
      }
      setTrimP(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // drag a clip block horizontally to reorder it (CapCut-style). Plain click
  // (no movement) keeps the old behavior: select + seek to the clip start.
  const startClipDrag = (e: React.PointerEvent, clipId: string, startMs: number) => {
    e.stopPropagation();
    selectClip(clipId);
    const startX = e.clientX;
    let cur: {id: string; dx: number; targetIdx: number} | null = null;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!cur && Math.abs(dx) < 6) return; // dead zone → click, not drag
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      // insertion index from the cursor position over the OTHER clips
      const xMs = Math.max(0, (ev.clientX - rect.left + (canvasRef.current?.scrollLeft ?? 0)) / pxPerMs);
      const others = clips.filter((c) => c.id !== clipId);
      let acc = 0;
      let idx = others.length;
      for (let i = 0; i < others.length; i++) {
        const durMs = clipDurationSec(others[i]) * 1000;
        if (xMs < acc + durMs / 2) { idx = i; break; }
        acc += durMs;
      }
      cur = {id: clipId, dx, targetIdx: idx};
      setDrag(cur);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (cur) moveClipTo(clipId, cur.targetIdx); // pushes its own history
      else seekFrame((startMs / 1000) * fps + 1); // plain click = seek
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const deleteSelected = () => {
    if (selectedClipId) deleteClip(selectedClipId);
  };

  const ruler = Array.from({length: Math.ceil(totalSec) + 1});
  const tickStep = pxPerSec < 45 ? 5 : pxPerSec < 90 ? 2 : 1; // sparser labels when zoomed out

  return (
    <div className="h-full flex flex-col select-none">
      {/* toolbar */}
      <div className="h-10 border-b border-outline-variant flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-3 text-on-surface-variant">
          <IconButton icon="content_cut" label="Split clip at playhead (S)" onClick={() => splitClipAtFrame(currentFrame)} className="hover:text-on-surface transition-colors" />
          <IconButton icon="delete" label="Delete selected clip (Delete)" onClick={deleteSelected} disabled={!selectedClipId} className="hover:text-on-surface transition-colors disabled:opacity-40" />
          <div aria-hidden="true" className="h-4 w-px bg-outline-variant mx-1" />
          <IconButton icon="zoom_out" label="Zoom out" onClick={() => setPxPerSec((p) => Math.max(20, p - 20))} disabled={pxPerSec <= 20} className="hover:text-on-surface transition-colors disabled:opacity-40" />
          <IconButton icon="zoom_in" label="Zoom in" onClick={() => setPxPerSec((p) => Math.min(220, p + 20))} disabled={pxPerSec >= 220} className="hover:text-on-surface transition-colors disabled:opacity-40" />
        </div>
        <div className="flex gap-4 text-mono-label font-mono text-on-surface-variant">
          <span aria-label={`Playhead at ${fmt(currentFrame / fps)} of ${fmt(totalSec)}`}>Timeline: {fmt(currentFrame / fps)} / {fmt(totalSec)}</span>
          <span>{meta.width}×{meta.height}</span>
          <span aria-live="polite">Zoom: {Math.round((pxPerSec / 70) * 100)}%</span>
        </div>
      </div>

      {/* tracks */}
      <div className="flex-1 flex overflow-hidden">
        {/* label column (visual only — each track is a named group below) */}
        <div aria-hidden="true" className="flex flex-col border-r border-outline-variant bg-surface-container-lowest z-10 shrink-0" style={{width: LABELS_W}}>
          <div className="h-6 border-b border-outline-variant/30" />
          {['Captions', 'Video', 'B-roll', 'Audio'].map((l) => (
            <div key={l} className="flex items-center px-4 border-b border-outline-variant/30" style={{height: TRACK_H}}>
              <span className="text-[10px] font-label-bold uppercase tracking-wider text-on-surface-variant">{l}</span>
            </div>
          ))}
        </div>

        {/* scrolling canvas */}
        <div
          ref={canvasRef}
          role="region"
          aria-label="Timeline. Arrow keys move the playhead, Tab reaches the blocks, S splits, Delete removes the selected clip"
          tabIndex={0}
          className="flex-1 overflow-x-auto relative timeline-grid focus-visible:outline-offset-[-2px]"
        >
          <div className="relative" onPointerDown={scrubStart} style={{width: trackWidth, minWidth: '100%'}}>
            {/* ruler */}
            <div aria-hidden="true" className="h-6 border-b border-outline-variant bg-surface-container/50 sticky top-0 z-10 pointer-events-none">
              {ruler.map((_, s) =>
                s % tickStep === 0 ? (
                  <span key={s} className="absolute text-[9px] font-mono text-on-surface-variant/75 border-l border-outline-variant/30 pl-1" style={{left: s * pxPerSec, top: 6}}>
                    {s}s
                  </span>
                ) : null,
              )}
            </div>

            {/* playhead */}
            <div aria-hidden="true" className="absolute w-[2px] bg-primary z-20 pointer-events-none" style={{left: playheadX, top: 0, bottom: 0}}>
              <div className="w-3 h-3 bg-primary rounded-full absolute top-0 -left-[5px] shadow-[0_0_8px_rgba(194,193,255,0.8)]" />
            </div>

            {/* Captions track (anchored to clips — follow trims/reorders) */}
            <Track label="Captions track">
              {projCaps.map((c) => {
                const sel = c.id === selectedId;
                const text = c.words.map((w) => w.text).join(' ');
                const pick = () => { select(c.id); seekMs(c.startMs + 20); };
                return (
                  <div
                    key={c.id}
                    role="button"
                    tabIndex={0}
                    aria-pressed={sel}
                    aria-label={`Caption at ${secs(c.startMs)}: ${text}`}
                    data-timeline-block
                    onPointerDown={(e) => { e.stopPropagation(); pick(); }}
                    onKeyDown={keyActivate(pick)}
                    title={text}
                    className={`absolute top-2 h-8 rounded px-2 flex items-center clip-gradient overflow-hidden cursor-pointer ${
                      sel ? 'bg-tertiary-container border-2 border-primary shadow-[inset_0_0_10px_rgba(194,193,255,0.2)]' : 'bg-tertiary-container/30 border border-tertiary/40'
                    }`}
                    style={{left: c.startMs * pxPerMs, width: Math.max(14, (c.endMs - c.startMs) * pxPerMs)}}
                  >
                    <span className="text-[10px] truncate text-on-tertiary-container pointer-events-none">{text}</span>
                  </div>
                );
              })}
            </Track>

            {/* Video track (clips) */}
            <Track label="Video track">
              {placed.map(({clip, startMs}) => {
                const sel = clip.id === selectedClipId;
                const dup = dupSuggestion.includes(clip.id);
                const speed = clip.speed ?? 1;
                const name = clip.label ?? clip.id;
                const pick = () => { selectClip(clip.id); seekFrame((startMs / 1000) * fps + 1); };
                const description = [
                  `Clip ${name}, ${clipDurationSec(clip).toFixed(1)}s at ${secs(startMs)}`,
                  clip.muted ? 'muted' : '',
                  speed !== 1 ? `${speed}× speed` : '',
                  dup ? 'duplicate take, will be removed' : '',
                ].filter(Boolean).join(', ');
                const orig = {inSec: clip.inSec, outSec: clip.outSec, sourceDurationSec: clip.sourceDurationSec, speed};
                let left = startMs * pxPerMs;
                let w = Math.max(28, clipDurationSec(clip) * pxPerSec);
                // live preview: left handle moves the left edge, right handle the right edge
                if (trimP && trimP.id === clip.id) {
                  const dPx = (trimP.dSec / speed) * pxPerSec; // source-sec → timeline px
                  if (trimP.side === 'left') { left += dPx; w -= dPx; }
                  else w += dPx;
                }
                const dragged = drag?.id === clip.id;
                if (dragged) left += drag!.dx; // block follows the cursor while reordering
                return (
                  <div
                    key={clip.id}
                    role="button"
                    tabIndex={0}
                    aria-pressed={sel}
                    aria-label={description}
                    data-timeline-block
                    onPointerDown={(e) => startClipDrag(e, clip.id, startMs)}
                    onKeyDown={keyActivate(pick)}
                    title={name}
                    className={`absolute top-1 h-10 rounded flex items-center clip-gradient overflow-hidden ${
                      dragged ? 'cursor-grabbing z-30 shadow-xl opacity-90' : 'cursor-grab'
                    } ${
                      sel
                        ? 'bg-primary-container border-2 border-primary shadow-[inset_0_0_10px_rgba(194,193,255,0.25)]'
                        : dup
                          ? 'bg-error-container/30 border border-error/60 opacity-60'
                          : 'bg-primary-container/70 border border-primary/40'
                    }`}
                    style={{left, width: Math.max(16, w)}}
                  >
                    {/* voice waveform (from the source audio, sliced to the trim window) */}
                    <Wave peaks={slicePeaks(waves[clip.src], clip.inSec, clip.outSec)} color={clip.muted ? 'rgba(255,255,255,0.18)' : 'rgba(231,228,255,0.5)'} />
                    {clip.muted && <span aria-hidden="true" className="material-symbols-outlined text-[12px] text-error absolute top-0.5 left-3 z-10">volume_off</span>}
                    {dup && <span aria-hidden="true" className="material-symbols-outlined text-[12px] text-error absolute top-0.5 right-1 z-10">content_copy</span>}
                    {/* keyframe (flag) markers — only those inside the trimmed range */}
                    {(clip.transform ?? []).filter((k) => k.t >= clip.inSec - 0.001 && k.t <= clip.outSec + 0.001).map((k, ki) => {
                      const jump = () => { selectClip(clip.id); seekFrame(((startMs / 1000) + (k.t - clip.inSec) / speed) * fps); };
                      return (
                        <span
                          key={ki}
                          role="button"
                          tabIndex={0}
                          aria-label={`Keyframe at ${(k.t - clip.inSec).toFixed(1)}s into ${name} — jump`}
                          onPointerDown={(e) => { e.stopPropagation(); jump(); }}
                          onKeyDown={keyActivate(jump)}
                          title="Keyframe — click to jump"
                          className="absolute bottom-0.5 w-1.5 h-1.5 bg-white rotate-45 -ml-[3px] z-20 cursor-pointer"
                          style={{left: ((k.t - clip.inSec) / speed) * pxPerSec}}
                        />
                      );
                    })}
                    {/* trim handles are pointer-only (drag); the Inspector shows in/out for everyone */}
                    <div aria-hidden="true" onPointerDown={(e) => trimDrag(e, clip.id, 'left', orig)} className="absolute left-0 top-0 w-2 h-full cursor-ew-resize bg-primary/30 hover:bg-primary/60 z-10" />
                    <span className="px-2 text-[10px] text-on-primary-container font-bold truncate pointer-events-none">{name}</span>
                    <div aria-hidden="true" onPointerDown={(e) => trimDrag(e, clip.id, 'right', orig)} className="absolute right-0 top-0 w-2 h-full cursor-ew-resize bg-primary/30 hover:bg-primary/60 z-10" />
                  </div>
                );
              })}

              {/* insertion indicator while drag-reordering */}
              {drag && (() => {
                const others = clips.filter((c) => c.id !== drag.id);
                const x = others.slice(0, drag.targetIdx).reduce((acc, c) => acc + clipDurationSec(c), 0) * pxPerSec;
                return <div aria-hidden="true" className="absolute top-0 h-full w-[3px] bg-primary rounded z-40 pointer-events-none shadow-[0_0_8px_rgba(194,193,255,0.9)]" style={{left: x - 1}} />;
              })()}
            </Track>

            {/* B-roll track (clip-anchored — follow trims/reorders) */}
            <Track label="B-roll track">
              {projBrolls.map((b) => {
                const sel = b.id === selectedId;
                const left = b.startMs * pxPerMs;
                const w = Math.max(20, (b.endMs - b.startMs) * pxPerMs);
                const pick = () => { select(b.id); seekMs(b.startMs + 20); };
                return (
                  <div
                    key={b.id}
                    role="button"
                    tabIndex={0}
                    aria-pressed={sel}
                    aria-label={`B-roll ${b.kind} at ${secs(b.startMs)}: ${b.query ?? b.id}`}
                    data-timeline-block
                    onPointerDown={(e) => { e.stopPropagation(); pick(); }}
                    onKeyDown={keyActivate(pick)}
                    title={b.query ?? b.id}
                    className={`absolute top-2 h-8 rounded px-2 flex items-center clip-gradient overflow-hidden cursor-pointer ${
                      sel ? 'bg-tertiary-container border-2 border-primary' : 'bg-tertiary-container/40 border border-tertiary/40'
                    }`}
                    style={{left, width: w}}
                  >
                    <span aria-hidden="true" className="material-symbols-outlined text-[12px] text-on-tertiary-container mr-1 pointer-events-none">
                      {b.kind === 'video' ? 'movie' : 'image'}
                    </span>
                    <span className="text-[10px] truncate text-on-tertiary-container pointer-events-none">{b.query ?? b.id}</span>
                  </div>
                );
              })}
            </Track>

            {/* Audio track (music, with waveform) */}
            <Track label="Audio track">
              {music ? (
                <div aria-label={`Music: ${music.src.split('/').pop()}${music.duck ? ', ducking under voice' : ''}`} className="absolute top-2 h-8 rounded flex items-center clip-gradient overflow-hidden bg-on-secondary-fixed-variant/40 border border-secondary/30" style={{left: 0, width: trackWidth}}>
                  <Wave
                    peaks={slicePeaks(waves[music.src], music.startSec ?? 0, (music.startSec ?? 0) + totalSec)}
                    color="rgba(173,198,255,0.6)"
                  />
                  <span className="px-2 text-[10px] text-secondary-fixed font-bold relative z-10 truncate">
                    {music.src.split('/').pop()}{music.duck ? ' · ducking' : ''}
                  </span>
                </div>
              ) : (
                <span className="absolute top-3 left-2 text-[10px] text-on-surface-variant/75">No music — add from the Assets panel</span>
              )}
            </Track>
          </div>
        </div>
      </div>
    </div>
  );
};

const Track: React.FC<{label: string; children: React.ReactNode}> = ({label, children}) => (
  <div role="group" aria-label={label} className="relative border-b border-outline-variant/20" style={{height: TRACK_H}}>{children}</div>
);
