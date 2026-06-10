import React from 'react';
import {Sequence, OffthreadVideo, Img, useVideoConfig, interpolate, useCurrentFrame} from 'remotion';

export type BrollItem = {
  id: string;
  startMs: number;
  endMs: number;
  kind: 'video' | 'image';
  mode: 'fullscreen' | 'inset' | 'top';
  src: string;
  query?: string;
};

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

  return (
    <div style={{position: 'absolute', ...box, opacity: fade}}>
      {item.kind === 'video' ? (
        <OffthreadVideo src={item.src} muted style={{width: '100%', height: '100%', objectFit: 'cover'}} />
      ) : (
        <Img src={item.src} style={{width: '100%', height: '100%', objectFit: 'cover'}} />
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
