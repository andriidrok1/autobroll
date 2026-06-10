// Multi-clip timeline model. A project is an ordered list of clips, each with
// in/out trim points, assembled back-to-back. Optional music track on top.
// This is the spine of the editor: trim = change in/out, reorder = change order,
// delete = drop a clip. Captions are mapped onto the assembled timeline (see remapCaptions).

export type Clip = {
  id: string; // unique, stable per take (e.g. "IMG_0227")
  src: string; // staticFile-relative path, e.g. "clips/IMG_0227.mp4"
  label?: string; // human label shown on the track
  inSec: number; // trim: start offset inside the source
  outSec: number; // trim: end offset inside the source
  sourceDurationSec: number; // full length of the source (trim bounds)
};

export type Music = {
  src: string; // staticFile-relative, e.g. "music/track.mp3"
  volume: number; // 0..1
  startSec: number; // offset into the music file to begin from
  fadeOutSec: number; // fade at the end of the video (0 = none)
} | null;

export type Project = {
  clips: Clip[];
  music: Music;
};

export const clipDurationSec = (c: Clip) => Math.max(0, c.outSec - c.inSec);

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
