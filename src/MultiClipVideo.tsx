import React from 'react';
import {AbsoluteFill, Audio, OffthreadVideo, Sequence, staticFile, useVideoConfig, interpolate, useCurrentFrame} from 'remotion';
import {CaptionTrack} from './CaptionTrack';
import {BrollLayer, type BrollItem} from './Broll';
import {type Caption} from './captions';
import {placeClips, totalDurationFrames, type Clip, type Music} from './timeline';

// Music layer: plays the track over the whole timeline, with start offset,
// volume, and an optional fade-out at the end.
const MusicTrack: React.FC<{music: NonNullable<Music>; totalFrames: number}> = ({music, totalFrames}) => {
  const {fps} = useVideoConfig();
  const fadeFrames = Math.round((music.fadeOutSec ?? 0) * fps);
  return (
    <Audio
      src={staticFile(music.src)}
      trimBefore={Math.round((music.startSec ?? 0) * fps)}
      volume={(f) =>
        fadeFrames > 0
          ? interpolate(f, [totalFrames - fadeFrames, totalFrames], [music.volume, 0], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            })
          : music.volume
      }
    />
  );
};

export const MultiClipVideo: React.FC<{
  clips?: Clip[];
  music?: Music;
  captions?: Caption[];
  brolls?: BrollItem[];
  accentColor?: string;
}> = ({clips = [], music = null, captions = [], brolls = [], accentColor}) => {
  const {fps} = useVideoConfig();
  const placed = placeClips(clips, fps);
  const totalFrames = totalDurationFrames(clips, fps);

  return (
    <AbsoluteFill style={{backgroundColor: 'black'}}>
      {/* clip layer — trimmed takes back-to-back */}
      {placed.map(({clip, fromFrame, durFrames}) => (
        <Sequence key={clip.id} from={fromFrame} durationInFrames={durFrames} name={clip.label ?? clip.id}>
          <OffthreadVideo
            src={staticFile(clip.src)}
            trimBefore={Math.round(clip.inSec * fps)}
            trimAfter={Math.round(clip.outSec * fps)}
            style={{width: '100%', height: '100%', objectFit: 'cover'}}
          />
        </Sequence>
      ))}

      {/* B-roll overlay (above clips, below captions) */}
      <BrollLayer items={brolls} />

      {/* music */}
      {music && <MusicTrack music={music} totalFrames={totalFrames} />}

      {/* captions, always on top */}
      <CaptionTrack captions={captions} accentColor={accentColor} />
    </AbsoluteFill>
  );
};
