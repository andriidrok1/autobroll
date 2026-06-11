// Caption-сущности: редактируемая модель субтитров.
// Анкорятся к клипу: clipId + времена ОТНОСИТЕЛЬНО исходного клипа (0 = начало
// несрезанного клипа). Абсолютная позиция на таймлайне вычисляется projectCaptions
// из текущих clips — поэтому при перестановке/обрезке клипа субтитры едут с ним.

import {placeClips, type Clip} from './timeline';

export type CaptionWord = {text: string; startMs: number; endMs: number; accent: boolean};
export type Caption = {
  id: string;
  clipId?: string; // к какому клипу привязан (source-relative времена ниже)
  words: CaptionWord[];
  startMs: number;
  endMs: number;
  topPct: number;
  scale?: number; // size multiplier (1 = default), set via the on-preview slider
  holdMaxMs?: number; // projected only: clip's end — the visual hold must not bleed into the next clip
};

// Source-relative captions → absolute timeline captions, honoring current clip
// order + trim. Drops captions whose clip was removed or trimmed away.
export function projectCaptions(captions: Caption[], clips: Clip[], fps: number): Caption[] {
  if (!clips.length) return captions; // no clip context → assume already absolute
  const placed = placeClips(clips, fps);
  const byId = new Map(placed.map((p) => [p.clip.id, p]));
  const out: Caption[] = [];
  for (const cap of captions) {
    if (!cap.clipId) {
      out.push(cap); // legacy/absolute caption — pass through
      continue;
    }
    const pc = byId.get(cap.clipId);
    if (!pc) continue; // clip deleted
    const inMs = pc.clip.inSec * 1000;
    const outMs = pc.clip.outSec * 1000;
    if (cap.startMs >= outMs || cap.endMs <= inMs) continue; // trimmed away
    // source-relative → absolute timeline, honoring playback speed (slow-mo
    // stretches the words with the speech, speed-up compresses them)
    const speed = pc.clip.speed ?? 1;
    const toAbs = (srcMs: number) => pc.startMs + (srcMs - inMs) / speed;
    out.push({
      ...cap,
      startMs: toAbs(cap.startMs),
      endMs: Math.min(toAbs(cap.endMs), pc.endMs),
      holdMaxMs: pc.endMs, // don't let the visual hold bleed into the next clip
      words: cap.words.map((w) => ({...w, startMs: toAbs(w.startMs), endMs: toAbs(w.endMs)})),
    });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}
