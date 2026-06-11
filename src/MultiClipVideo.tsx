import React from 'react';
import {AbsoluteFill, Audio, OffthreadVideo, Video, Sequence, staticFile, useVideoConfig, useCurrentFrame, interpolate, getRemotionEnvironment} from 'remotion';
import {CaptionTrack} from './CaptionTrack';
import {BrollLayer, projectBrolls, type BrollItem} from './Broll';
import {projectCaptions, type Caption} from './captions';
import {placeClips, sampleTransform, totalDurationFrames, type Clip, type Music} from './timeline';

// one clip's media with its keyframed zoom/pan transform applied
const ClipMedia: React.FC<{clip: Clip; durFrames: number; Comp: React.ElementType}> = ({clip, durFrames, Comp}) => {
  const {fps} = useVideoConfig();
  const frame = useCurrentFrame(); // relative to this clip's Sequence
  const speed = clip.speed ?? 1;
  // keyframe times are source-relative → advance source-time at `speed`
  const {scale, x, y} = sampleTransform(clip.transform, clip.inSec + (frame / fps) * speed);
  const trimBefore = Math.round(clip.inSec * fps);
  return (
    <div
      data-ab={`clip:${clip.id}`}
      style={{width: '100%', height: '100%', overflow: 'hidden', transform: `translate(${x}%, ${y}%) scale(${scale})`, transformOrigin: 'center'}}
    >
      <Comp
        src={staticFile(clip.src)}
        playbackRate={speed}
        trimBefore={trimBefore}
        // source frames consumed = timeline frames × speed (keeps the trimmed
        // span exactly as long as the Sequence — no black tail frame)
        trimAfter={trimBefore + Math.round(durFrames * speed)}
        acceptableTimeShiftInSeconds={0.5}
        muted={clip.muted || (clip.volume ?? 1) === 0}
        volume={clip.muted ? 0 : clip.volume ?? 1}
        style={{width: '100%', height: '100%', objectFit: 'cover'}}
      />
    </div>
  );
};

// Music layer: start offset, volume, optional end fade-out, and optional
// auto-ducking — the music dips while someone is speaking (speech = caption spans).
const MusicTrack: React.FC<{music: NonNullable<Music>; totalFrames: number; speech: Array<[number, number]>}> = ({music, totalFrames, speech}) => {
  const {fps} = useVideoConfig();
  const fadeFrames = Math.round((music.fadeOutSec ?? 0) * fps);
  const DUCK_RAMP_MS = 250; // ease the dip in/out
  return (
    <Audio
      src={staticFile(music.src)}
      trimBefore={Math.round((music.startSec ?? 0) * fps)}
      volume={(f) => {
        let v =
          fadeFrames > 0
            ? interpolate(f, [totalFrames - fadeFrames, totalFrames], [music.volume, 0], {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
              })
            : music.volume;
        if (music.duck && speech.length) {
          const ms = (f / fps) * 1000;
          let dist = Infinity; // distance to the nearest speech span (0 = inside)
          for (const [a, b] of speech) {
            if (ms >= a && ms <= b) { dist = 0; break; }
            dist = Math.min(dist, ms < a ? a - ms : ms - b);
          }
          const k = Math.min(1, dist / DUCK_RAMP_MS); // 0 in speech → ducked, 1 far away
          const duckLevel = music.duckLevel ?? 0.25;
          v *= duckLevel + (1 - duckLevel) * k;
        }
        return v;
      }}
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
  // captions + b-roll are anchored to clips (source-relative) → project to absolute
  const projectedCaptions = projectCaptions(captions, clips, fps);
  const projectedBrolls = projectBrolls(brolls, clips, fps);

  // OffthreadVideo is built for rendering (frame-accurate, but stutters/freezes
  // in the live Player). Use native <Video> in preview for smooth playback,
  // OffthreadVideo only when actually rendering the mp4.
  const Clip = getRemotionEnvironment().isRendering ? OffthreadVideo : Video;

  return (
    <AbsoluteFill style={{backgroundColor: 'black'}}>
      {/* clip layer — trimmed takes back-to-back, with keyframed zoom/pan */}
      {placed.map(({clip, fromFrame, durFrames}) => (
        <Sequence
          key={clip.id}
          from={fromFrame}
          durationInFrames={durFrames}
          // premount upcoming clips (hidden) so the <video> is decoded before the
          // cut — kills the black flash at segment seams in the preview
          premountFor={Math.round(fps)}
          name={clip.label ?? clip.id}
        >
          <ClipMedia clip={clip} durFrames={durFrames} Comp={Clip} />
        </Sequence>
      ))}

      {/* B-roll overlay (above clips, below captions) */}
      <BrollLayer items={projectedBrolls} />

      {/* music */}
      {music && <MusicTrack music={music} totalFrames={totalFrames} speech={projectedCaptions.map((c) => [c.startMs, c.endMs])} />}

      {/* captions, always on top */}
      <CaptionTrack captions={projectedCaptions} accentColor={accentColor} />
    </AbsoluteFill>
  );
};
