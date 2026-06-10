import React, {useRef} from 'react';
import type {PlayerRef} from '@remotion/player';
import {useEditor} from './store';

const PX_PER_SEC = 70;

export const Timeline: React.FC<{playerRef: React.RefObject<PlayerRef | null>}> = ({playerRef}) => {
  const {meta, captions, selectedId, select, currentFrame, setTiming, pushHistory} = useEditor();
  const trackRef = useRef<HTMLDivElement>(null);
  if (!meta) return null;

  const pxPerMs = PX_PER_SEC / 1000;
  const totalMs = (meta.durationInFrames / meta.fps) * 1000;
  const playheadX = (currentFrame / meta.fps) * 1000 * pxPerMs;

  const seekTo = (ms: number) => playerRef.current?.seekTo(Math.round((ms / 1000) * meta.fps));

  const onTrackClick = (e: React.MouseEvent) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    seekTo((e.clientX - rect.left) / pxPerMs);
  };

  // drag: mode = move | left | right
  const startDrag = (
    e: React.PointerEvent,
    id: string,
    mode: 'move' | 'left' | 'right',
    orig: {startMs: number; endMs: number},
  ) => {
    e.stopPropagation();
    e.preventDefault();
    select(id);
    const startX = e.clientX;
    let moved = false;
    let snapped = false; // снапшот истории — один раз, как только реально потянули
    const span = orig.endMs - orig.startMs;

    const move = (ev: PointerEvent) => {
      const dMs = (ev.clientX - startX) / pxPerMs;
      if (Math.abs(ev.clientX - startX) > 3) {
        if (!snapped) { pushHistory(); snapped = true; }
        moved = true;
      }
      if (mode === 'move') {
        const ns = Math.min(Math.max(0, orig.startMs + dMs), totalMs - span);
        setTiming(id, Math.round(ns), Math.round(ns + span));
      } else if (mode === 'left') {
        const ns = Math.min(Math.max(0, orig.startMs + dMs), orig.endMs - 150);
        setTiming(id, Math.round(ns), orig.endMs);
      } else {
        const ne = Math.max(Math.min(totalMs, orig.endMs + dMs), orig.startMs + 150);
        setTiming(id, orig.startMs, Math.round(ne));
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) seekTo(orig.startMs + 30); // клик без драга = перемотка
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div style={{padding: '10px 0', userSelect: 'none'}}>
      <div style={{position: 'relative', height: 18, marginLeft: 90, overflow: 'hidden'}}>
        {Array.from({length: Math.ceil(totalMs / 1000) + 1}).map((_, s) => (
          <div key={s} style={{position: 'absolute', left: s * PX_PER_SEC, fontSize: 10, color: '#555'}}>
            {s}s
          </div>
        ))}
      </div>

      <div style={{display: 'flex', alignItems: 'center'}}>
        <div style={{width: 90, fontSize: 12, color: '#9a9aa6', flexShrink: 0}}>Captions</div>

        <div
          ref={trackRef}
          onClick={onTrackClick}
          style={{position: 'relative', height: 48, width: totalMs * pxPerMs, background: '#141418', borderRadius: 6}}
        >
          {captions.map((c) => {
            const left = c.startMs * pxPerMs;
            const width = Math.max(10, (c.endMs - c.startMs) * pxPerMs);
            const sel = c.id === selectedId;
            const orig = {startMs: c.startMs, endMs: c.endMs};
            return (
              <div
                key={c.id}
                onPointerDown={(e) => startDrag(e, c.id, 'move', orig)}
                title={c.words.map((w) => w.text).join(' ')}
                style={{
                  position: 'absolute',
                  left,
                  top: 4,
                  width: width - 2,
                  height: 40,
                  background: sel ? '#2b6cff' : '#2a2a33',
                  border: sel ? '1px solid #5b8cff' : '1px solid #34343f',
                  borderRadius: 5,
                  overflow: 'hidden',
                  fontSize: 11,
                  color: sel ? '#fff' : '#c8c8d2',
                  whiteSpace: 'nowrap',
                  textOverflow: 'ellipsis',
                  display: 'flex',
                  alignItems: 'center',
                  padding: '0 10px',
                  cursor: 'grab',
                }}
              >
                {/* левый край */}
                <div
                  onPointerDown={(e) => startDrag(e, c.id, 'left', orig)}
                  style={{position: 'absolute', left: 0, top: 0, width: 7, height: '100%', cursor: 'ew-resize', background: sel ? 'rgba(255,255,255,0.25)' : 'transparent'}}
                />
                <span style={{pointerEvents: 'none', overflow: 'hidden', textOverflow: 'ellipsis'}}>
                  {c.words.map((w) => w.text).join(' ')}
                </span>
                {/* правый край */}
                <div
                  onPointerDown={(e) => startDrag(e, c.id, 'right', orig)}
                  style={{position: 'absolute', right: 0, top: 0, width: 7, height: '100%', cursor: 'ew-resize', background: sel ? 'rgba(255,255,255,0.25)' : 'transparent'}}
                />
              </div>
            );
          })}

          <div style={{position: 'absolute', left: playheadX, top: -2, width: 2, height: 52, background: '#ff3b3b', pointerEvents: 'none'}} />
        </div>
      </div>
      <div style={{marginLeft: 90, marginTop: 6, fontSize: 11, color: '#555'}}>
        Drag block = move in time · drag edges = start/end · click = seek
      </div>
    </div>
  );
};
