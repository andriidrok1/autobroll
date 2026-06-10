import React from 'react';
import {useCurrentFrame, useVideoConfig, interpolate, spring} from 'remotion';

export type CalloutVariant = 'minimal' | 'bar' | 'circle';

const FONT = 'Inter, -apple-system, system-ui, sans-serif';

export const NumberCallout: React.FC<{
  value: number;
  label: string;
  variant?: CalloutVariant;
  accent?: string;
  suffix?: string;
}> = ({value, label, variant = 'minimal', accent = '#5b8cff', suffix = '%'}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  // вход — pop-in (overshoot = bounce масштаба)
  const enter = spring({frame, fps, config: {damping: 14}});
  const scale = interpolate(enter, [0, 1], [0.7, 1]);
  const opacity = interpolate(enter, [0, 1], [0, 1], {extrapolateRight: 'clamp'});

  // прогресс счёта/заливки (плавный, без overshoot)
  const prog = spring({frame, fps, config: {damping: 200}});
  const counted = Math.round(interpolate(prog, [0, 1], [0, value], {extrapolateRight: 'clamp'}));
  const fraction = Math.min(value, 100) / 100; // для bar/circle (проценты)

  const card: React.CSSProperties = {
    transform: `scale(${scale})`,
    opacity,
    background: 'rgba(12,12,16,0.82)',
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
    borderRadius: 28,
    border: '1px solid rgba(255,255,255,0.08)',
    padding: '32px 40px',
    fontFamily: FONT,
    boxShadow: '0 24px 70px rgba(0,0,0,0.45)',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 22,
    color: '#9a9aa6',
    fontWeight: 600,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  };

  if (variant === 'minimal') {
    return (
      <div style={{...card, textAlign: 'center'}}>
        <div style={{fontSize: 104, fontWeight: 800, color: '#fff', lineHeight: 1, letterSpacing: -2}}>
          {counted}
          <span style={{color: accent}}>{suffix}</span>
        </div>
        <div style={{...labelStyle, marginTop: 10}}>{label}</div>
      </div>
    );
  }

  if (variant === 'bar') {
    return (
      <div style={{...card, width: 460}}>
        <div style={labelStyle}>{label}</div>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 6,
            margin: '8px 0 20px',
            fontWeight: 800,
            color: '#fff',
          }}
        >
          <span style={{fontSize: 84, lineHeight: 1, letterSpacing: -2}}>{counted}</span>
          <span style={{fontSize: 48, color: accent}}>{suffix}</span>
        </div>
        <div style={{height: 16, borderRadius: 999, background: 'rgba(255,255,255,0.10)', overflow: 'hidden'}}>
          <div
            style={{
              height: '100%',
              width: `${fraction * 100 * prog}%`,
              borderRadius: 999,
              background: `linear-gradient(90deg, ${accent}, ${accent}cc)`,
            }}
          />
        </div>
      </div>
    );
  }

  // circle
  const r = 110;
  const stroke = 18;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - fraction * prog);
  const box = (r + stroke) * 2;

  return (
    <div style={{...card, display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
      <svg width={box} height={box} style={{transform: 'rotate(-90deg)'}}>
        <circle cx={box / 2} cy={box / 2} r={r} fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth={stroke} />
        <circle
          cx={box / 2}
          cy={box / 2}
          r={r}
          fill="none"
          stroke={accent}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
        />
      </svg>
      <div style={{position: 'absolute', top: '50%', transform: 'translateY(-60%)', textAlign: 'center'}}>
        <div style={{fontSize: 76, fontWeight: 800, color: '#fff', lineHeight: 1, letterSpacing: -2}}>
          {counted}
          <span style={{color: accent}}>{suffix}</span>
        </div>
      </div>
      <div style={{...labelStyle, marginTop: 18}}>{label}</div>
    </div>
  );
};
