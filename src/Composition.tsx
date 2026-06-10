import React from 'react';
import {AbsoluteFill, OffthreadVideo, Sequence, staticFile} from 'remotion';
import {NumberCallout} from './NumberCallout';

export const MyVideo: React.FC = () => {
  return (
    <AbsoluteFill style={{backgroundColor: 'black'}}>
      {/* фон — твоё видео */}
      <OffthreadVideo src={staticFile('clip.mp4')} />

      {/* графика поверх, кадры 30-90 */}
      <Sequence from={30} durationInFrames={60}>
        <div style={{position: 'absolute', top: 80, right: 80}}>
          <NumberCallout variant="bar" value={40} label="engagement growth" accent="#39d98a" />
        </div>
      </Sequence>
    </AbsoluteFill>
  );
};
