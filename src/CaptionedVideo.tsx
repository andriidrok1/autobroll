import React from 'react';
import {AbsoluteFill, OffthreadVideo, Sequence, staticFile, useVideoConfig} from 'remotion';
import {CaptionTrack} from './CaptionTrack';
import {BrollLayer, type BrollItem} from './Broll';
import {buildCaptions, type Caption, type Word, type Placement} from './captions';

export const CaptionedVideo: React.FC<{
  captions?: Caption[];
  brolls?: BrollItem[];
  words?: Word[];
  accents?: number[];
  placements?: Placement[];
  accentColor?: string;
}> = ({captions, brolls = [], words = [], accents = [], placements = [], accentColor}) => {
  const {durationInFrames} = useVideoConfig();
  const caps = captions ?? buildCaptions(words, accents, placements);

  return (
    <AbsoluteFill style={{backgroundColor: 'black'}}>
      {/* слой видео */}
      <Sequence name="clip.mp4" durationInFrames={durationInFrames}>
        <OffthreadVideo src={staticFile('clip.mp4')} />
      </Sequence>
      {/* слой B-roll (поверх видео, под субтитрами) */}
      <BrollLayer items={brolls} />
      {/* слой субтитров (всегда сверху) */}
      <CaptionTrack captions={caps} accentColor={accentColor} />
    </AbsoluteFill>
  );
};
