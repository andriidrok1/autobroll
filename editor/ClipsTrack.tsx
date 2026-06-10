import React, {useRef} from 'react';
import type {PlayerRef} from '@remotion/player';
import {useEditor} from './store';
import {placeClips, clipDurationSec} from '../src/timeline';

const PX_PER_SEC = 70; // matches the captions Timeline

// Clips track: the assembled multi-clip timeline. Each block is a trimmed take.
// Drag edges = trim in/out · ◀ ▶ = reorder · ✕ = delete · click = select + seek.
export const ClipsTrack: React.FC<{playerRef: React.RefObject<PlayerRef>}> = ({playerRef}) => {
  const {meta, clips, selectedClipId, currentFrame, selectClip, deleteClip, moveClip, trimClip} = useEditor();
  const trackRef = useRef<HTMLDivElement>(null);
  if (!meta || !clips.length) return null;

  const fps = meta.fps;
  const placed = placeClips(clips, fps);
  const totalSec = placed.length ? placed[placed.length - 1].endMs / 1000 : 0;
  const playheadX = (currentFrame / fps) * PX_PER_SEC;
  const seekToFrame = (f: number) => playerRef.current?.seekTo(Math.max(0, Math.round(f)));

  // drag a clip edge to trim. mode = 'left' (move inSec) | 'right' (move outSec)
  const startTrim = (e: React.PointerEvent, id: string, mode: 'left' | 'right', orig: {inSec: number; outSec: number}) => {
    e.stopPropagation();
    e.preventDefault();
    selectClip(id);
    const startX = e.clientX;
    const move = (ev: PointerEvent) => {
      const dSec = (ev.clientX - startX) / PX_PER_SEC;
      if (mode === 'left') trimClip(id, orig.inSec + dSec, orig.outSec);
      else trimClip(id, orig.inSec, orig.outSec + dSec);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div style={{padding: '4px 0 10px', userSelect: 'none'}}>
      <div style={{display: 'flex', alignItems: 'center'}}>
        <div style={{width: 90, fontSize: 12, color: '#9a9aa6', flexShrink: 0}}>Clips</div>

        <div
          ref={trackRef}
          style={{position: 'relative', height: 56, width: Math.max(1, totalSec * PX_PER_SEC), background: '#141418', borderRadius: 6}}
        >
          {placed.map(({clip, startMs}) => {
            const left = (startMs / 1000) * PX_PER_SEC;
            const width = Math.max(16, clipDurationSec(clip) * PX_PER_SEC);
            const sel = clip.id === selectedClipId;
            const orig = {inSec: clip.inSec, outSec: clip.outSec};
            return (
              <div
                key={clip.id}
                onPointerDown={() => {
                  selectClip(clip.id);
                  seekToFrame((startMs / 1000) * fps + 1);
                }}
                title={clip.label ?? clip.id}
                style={{
                  position: 'absolute',
                  left,
                  top: 4,
                  width: width - 2,
                  height: 48,
                  background: sel ? '#1f4d3a' : '#23232c',
                  border: sel ? '1px solid #39d98a' : '1px solid #34343f',
                  borderRadius: 5,
                  overflow: 'hidden',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  padding: '4px 8px',
                }}
              >
                {/* left trim handle */}
                <div
                  onPointerDown={(e) => startTrim(e, clip.id, 'left', orig)}
                  style={{position: 'absolute', left: 0, top: 0, width: 8, height: '100%', cursor: 'ew-resize', background: sel ? 'rgba(57,217,138,0.35)' : 'rgba(255,255,255,0.08)'}}
                />
                <div style={{fontSize: 10, color: sel ? '#bff5da' : '#c8c8d2', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', pointerEvents: 'none'}}>
                  {clip.label ?? clip.id}
                </div>

                {sel && (
                  <div style={{display: 'flex', gap: 4, alignSelf: 'flex-start'}}>
                    <Mini label="◀" onClick={() => moveClip(clip.id, -1)} title="Move left" />
                    <Mini label="▶" onClick={() => moveClip(clip.id, 1)} title="Move right" />
                    <Mini label="✕" onClick={() => deleteClip(clip.id)} title="Delete take" danger />
                  </div>
                )}

                <div style={{fontSize: 9, color: '#777', pointerEvents: 'none'}}>{clipDurationSec(clip).toFixed(1)}s</div>

                {/* right trim handle */}
                <div
                  onPointerDown={(e) => startTrim(e, clip.id, 'right', orig)}
                  style={{position: 'absolute', right: 0, top: 0, width: 8, height: '100%', cursor: 'ew-resize', background: sel ? 'rgba(57,217,138,0.35)' : 'rgba(255,255,255,0.08)'}}
                />
              </div>
            );
          })}

          <div style={{position: 'absolute', left: playheadX, top: -2, width: 2, height: 60, background: '#ff3b3b', pointerEvents: 'none'}} />
        </div>
      </div>
      <div style={{marginLeft: 90, marginTop: 6, fontSize: 11, color: '#555'}}>
        Drag edges = trim · ◀ ▶ = reorder · ✕ = delete take · click = select &amp; seek
      </div>
    </div>
  );
};

const Mini: React.FC<{label: string; onClick: () => void; title: string; danger?: boolean}> = ({label, onClick, title, danger}) => (
  <button
    title={title}
    onPointerDown={(e) => e.stopPropagation()}
    onClick={(e) => {
      e.stopPropagation();
      onClick();
    }}
    style={{
      width: 20,
      height: 18,
      lineHeight: '16px',
      padding: 0,
      fontSize: 11,
      borderRadius: 4,
      border: '1px solid #34343f',
      background: danger ? '#3a1f24' : '#16161c',
      color: danger ? '#ff8a8a' : '#c8c8d2',
      cursor: 'pointer',
    }}
  >
    {label}
  </button>
);
