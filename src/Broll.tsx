import React from 'react';
import {Sequence, OffthreadVideo, Video, Img, staticFile, useVideoConfig, interpolate, useCurrentFrame, getRemotionEnvironment} from 'remotion';
import {placeClips, type Clip} from './timeline';

export type BrollItem = {
  id: string;
  clipId?: string; // anchor; startMs/endMs are source-relative when set
  startMs: number;
  endMs: number;
  kind: 'video' | 'image';
  mode: 'fullscreen' | 'inset' | 'top';
  src: string;
  source?: 'own' | 'pexels';
  query?: string;
  alternatives?: string[];
  scale?: number; // size multiplier (1 = default), set via the on-preview slider
};

// the creator's own B-roll source (pool the generator can pick from)
export type BrollAsset = {id: string; src: string; kind: 'video' | 'image'; label: string; thumb?: string};

// remote (Pexels) URLs load directly; local paths go through staticFile
const resolveSrc = (s: string) => (/^https?:\/\//.test(s) ? s : staticFile(s));

// Source-relative B-roll → absolute timeline, honoring clip order + trim
// (mirrors projectCaptions). Drops cues whose clip was removed or trimmed away.
export function projectBrolls(items: BrollItem[], clips: Clip[], fps: number): BrollItem[] {
  if (!clips.length) return items;
  const placed = placeClips(clips, fps);
  const byId = new Map(placed.map((p) => [p.clip.id, p]));
  const out: BrollItem[] = [];
  for (const b of items) {
    if (!b.clipId) {
      out.push(b);
      continue;
    }
    const pc = byId.get(b.clipId);
    if (!pc) continue;
    const inMs = pc.clip.inSec * 1000;
    const outMs = pc.clip.outSec * 1000;
    if (b.startMs >= outMs || b.endMs <= inMs) continue;
    const speed = pc.clip.speed ?? 1;
    const toAbs = (srcMs: number) => pc.startMs + (srcMs - inMs) / speed;
    out.push({...b, startMs: toAbs(b.startMs), endMs: toAbs(b.endMs)});
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

const boxByMode: Record<BrollItem['mode'], React.CSSProperties> = {
  fullscreen: {top: 0, left: 0, width: '100%', height: '100%'},
  top: {top: 0, left: 0, width: '100%', height: '45%'},
  inset: {top: '6%', right: '5%', width: '34%', height: '22%', borderRadius: 18, overflow: 'hidden', border: '3px solid rgba(255,255,255,0.9)', boxShadow: '0 20px 50px rgba(0,0,0,0.5)'},
};

const One: React.FC<{item: BrollItem}> = ({item}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const fade = interpolate(frame, [0, Math.round(fps * 0.18)], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const box = item.mode === 'inset' ? boxByMode.inset : item.mode === 'top' ? boxByMode.top : boxByMode.fullscreen;
  const VideoComp = getRemotionEnvironment().isRendering ? OffthreadVideo : Video;
  const src = resolveSrc(item.src);
  const scale = item.scale ?? 1;
  // scale around a sensible origin per mode (inset hugs its corner, others center)
  const origin = item.mode === 'inset' ? 'top right' : 'center';

  return (
    <div data-ab={`broll:${item.id}`} style={{position: 'absolute', ...box, opacity: fade, transform: scale === 1 ? undefined : `scale(${scale})`, transformOrigin: origin}}>
      {item.kind === 'video' ? (
        <VideoComp src={src} muted style={{width: '100%', height: '100%', objectFit: 'cover'}} />
      ) : (
        <Img src={src} style={{width: '100%', height: '100%', objectFit: 'cover'}} />
      )}
    </div>
  );
};

export const BrollLayer: React.FC<{items: BrollItem[]}> = ({items}) => {
  const {fps} = useVideoConfig();
  if (!items?.length) return null;
  return (
    <>
      {items.map((b) => {
        const from = Math.round((b.startMs / 1000) * fps);
        const dur = Math.max(1, Math.round(((b.endMs - b.startMs) / 1000) * fps));
        return (
          <Sequence key={b.id} from={from} durationInFrames={dur} layout="none" name={`broll: ${b.query ?? b.id}`}>
            <One item={b} />
          </Sequence>
        );
      })}
    </>
  );
};
