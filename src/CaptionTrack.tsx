import React from 'react';
import {useCurrentFrame, useVideoConfig, interpolate, Sequence} from 'remotion';
import type {Caption} from './captions';

export type {Caption} from './captions';

const FONT = 'Inter, -apple-system, system-ui, sans-serif';
const ACCENT = '#FFB020';

// один блок субтитров (внутри своего Sequence)
const CaptionPage: React.FC<{caption: Caption; accentColor: string; durationInFrames: number}> = ({caption, accentColor, durationInFrames}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const absMs = caption.startMs + (frame / fps) * 1000;
  const fontSize = Math.round(62 * (caption.scale ?? 1));

  // soft cross-dissolve: fade in at the start, fade out near the end so a page
  // doesn't snap away the instant the last word is spoken
  const inF = Math.round(fps * 0.14);
  const outF = Math.round(fps * 0.18);
  const appear = interpolate(frame, [0, inF], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const disappear = interpolate(frame, [Math.max(inF, durationInFrames - outF), durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const opacity = appear * disappear;

  return (
    <div
      style={{
        position: 'absolute',
        top: `${caption.topPct}%`,
        left: 0,
        right: 0,
        display: 'flex',
        justifyContent: 'center',
        padding: '0 70px',
        opacity,
        transform: `translateY(${interpolate(appear, [0, 1], [10, 0])}px)`,
      }}
    >
     <div
       data-ab={`cap:${caption.id}`}
       style={{
         display: 'flex',
         justifyContent: 'center',
         flexWrap: 'wrap',
         gap: '0 16px',
         fontFamily: FONT,
       }}
     >
      {caption.words.map((w, i) => {
        const active = absMs >= w.startMs && absMs <= w.endMs;
        const color = w.accent ? accentColor : active ? '#ffffff' : 'rgba(255,255,255,0.78)';
        return (
          <span
            key={i}
            style={{
              fontSize,
              fontWeight: w.accent ? 800 : 600,
              lineHeight: 1.25,
              letterSpacing: -0.5,
              color,
              transform: active || w.accent ? 'scale(1.05)' : 'scale(1)',
              display: 'inline-block',
              textShadow: '0 2px 12px rgba(0,0,0,0.55), 0 0 26px rgba(0,0,0,0.35)',
            }}
          >
            {w.text}
          </span>
        );
      })}
     </div>
    </div>
  );
};

// каждая фраза = свой Sequence
export const CaptionTrack: React.FC<{
  captions: Caption[];
  accentColor?: string;
}> = ({captions, accentColor = ACCENT}) => {
  const {fps} = useVideoConfig();
  if (!captions?.length) return null;

  return (
    <>
      {captions.map((c, i) => {
        const nextStart = captions[i + 1]?.startMs ?? Infinity;
        const visEnd = Math.min(nextStart, c.endMs + 700, c.holdMaxMs ?? Infinity);
        const from = Math.round((c.startMs / 1000) * fps);
        const dur = Math.max(1, Math.round(((visEnd - c.startMs) / 1000) * fps));
        return (
          <Sequence key={c.id} from={from} durationInFrames={dur} layout="none" name={c.words.map((w) => w.text).join(' ')}>
            <CaptionPage caption={c} accentColor={accentColor} durationInFrames={dur} />
          </Sequence>
        );
      })}
    </>
  );
};
