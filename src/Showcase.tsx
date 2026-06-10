import React from 'react';
import {AbsoluteFill} from 'remotion';
import {NumberCallout} from './NumberCallout';

// Сравнение трёх вариантов рядом на чистом фоне (для оценки эстетики в studio)
export const Showcase: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        background: 'radial-gradient(circle at 50% 30%, #1a1a22, #0a0a0d)',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 60,
      }}
    >
      <NumberCallout variant="minimal" value={40} label="engagement growth" accent="#5b8cff" />
      <NumberCallout variant="bar" value={72} label="conversion" accent="#39d98a" />
      <NumberCallout variant="circle" value={88} label="model accuracy" accent="#ff8a5b" />
    </AbsoluteFill>
  );
};
