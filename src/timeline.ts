// Multi-clip timeline model. A project is an ordered list of clips, each with
// in/out trim points, assembled back-to-back. Optional music track on top.
// This is the spine of the editor: trim = change in/out, reorder = change order,
// delete = drop a clip. Captions are mapped onto the assembled timeline (see remapCaptions).

// a keyframe ("flag") pins a transform at a source-relative time inside the clip
export type Keyframe = {t: number; scale: number; x: number; y: number};

export type Clip = {
  id: string; // unique, stable per take (e.g. "IMG_0227")
  src: string; // staticFile-relative path, e.g. "clips/IMG_0227.mp4"
  label?: string; // human label shown on the track
  inSec: number; // trim: start offset inside the source
  outSec: number; // trim: end offset inside the source
  sourceDurationSec: number; // full length of the source (trim bounds)
  transform?: Keyframe[]; // keyframes (by source-time) for zoom/pan animation
  volume?: number; // clip audio gain, 1 = original
  muted?: boolean; // hard-mute the clip's own audio
  speed?: number; // playback rate (0.25..4), 1 = normal; timeline duration = source/speed
};

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
const smooth = (f: number) => f * f * (3 - 2 * f); // smoothstep ease-in-out

// transform at a given source-time, interpolating between keyframes.
// 0 kf → identity · 1 kf → static · 2+ → eased interpolation, held past the ends.
export function sampleTransform(kfs: Keyframe[] | undefined, sourceSec: number): {scale: number; x: number; y: number} {
  if (!kfs || kfs.length === 0) return {scale: 1, x: 0, y: 0};
  const pick = (k: Keyframe) => ({scale: k.scale, x: k.x, y: k.y});
  if (kfs.length === 1 || sourceSec <= kfs[0].t) return pick(kfs[0]);
  const last = kfs[kfs.length - 1];
  if (sourceSec >= last.t) return pick(last);
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (sourceSec >= a.t && sourceSec <= b.t) {
      const f = b.t === a.t ? 0 : smooth((sourceSec - a.t) / (b.t - a.t));
      return {scale: lerp(a.scale, b.scale, f), x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f)};
    }
  }
  return pick(last);
}

export type Music = {
  src: string; // staticFile-relative, e.g. "music/track.mp3"
  volume: number; // 0..1
  startSec: number; // offset into the music file to begin from
  fadeOutSec: number; // fade at the end of the video (0 = none)
  duck?: boolean; // auto-lower the music while someone is speaking
  duckLevel?: number; // ducked gain as a fraction of volume (default 0.25)
} | null;

export type Project = {
  clips: Clip[];
  music: Music;
};

// TIMELINE duration (what the viewer experiences) — source span divided by speed
export const clipDurationSec = (c: Clip) => Math.max(0, (c.outSec - c.inSec) / (c.speed ?? 1));

// Where each clip lands on the assembled timeline (in frames + ms), in order.
export type PlacedClip = {clip: Clip; fromFrame: number; durFrames: number; startMs: number; endMs: number};

export const placeClips = (clips: Clip[], fps: number): PlacedClip[] => {
  let acc = 0;
  return clips.map((clip) => {
    const durFrames = Math.max(1, Math.round(clipDurationSec(clip) * fps));
    const fromFrame = acc;
    acc += durFrames;
    return {
      clip,
      fromFrame,
      durFrames,
      startMs: (fromFrame / fps) * 1000,
      endMs: ((fromFrame + durFrames) / fps) * 1000,
    };
  });
};

export const totalDurationFrames = (clips: Clip[], fps: number): number =>
  Math.max(1, clips.reduce((sum, c) => sum + Math.max(1, Math.round(clipDurationSec(c) * fps)), 0));
