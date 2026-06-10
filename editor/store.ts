import {create} from 'zustand';
import type {Caption} from '../src/captions';
import {totalDurationFrames, type Clip, type Music} from '../src/timeline';

export type Meta = {durationInFrames: number; fps: number; width: number; height: number};

const HISTORY_LIMIT = 100;

type EditorState = {
  meta: Meta | null;
  captions: Caption[];
  clips: Clip[];
  music: Music;
  accentColor: string;
  selectedId: string | null;
  selectedClipId: string | null;
  currentFrame: number;

  // undo/redo: снапшоты captions. Толкаем ОДИН раз в начале логической правки
  // (pushHistory вызывает UI на pointerdown/focus) — драг не флудит историю.
  past: Caption[][];
  future: Caption[][];

  init: (meta: Meta, captions: Caption[], accentColor?: string, clips?: Clip[], music?: Music) => void;
  select: (id: string | null) => void;
  setCurrentFrame: (f: number) => void;
  setTopPct: (id: string, topPct: number) => void;
  setText: (id: string, text: string) => void;
  toggleAccent: (id: string, wordIndex: number) => void;
  setTiming: (id: string, startMs: number, endMs: number) => void;

  // clips track (multi-clip timeline)
  selectClip: (id: string | null) => void;
  deleteClip: (id: string) => void;
  moveClip: (id: string, dir: -1 | 1) => void;
  trimClip: (id: string, inSec: number, outSec: number) => void;
  setMusic: (music: Music) => void;

  pushHistory: () => void;
  undo: () => void;
  redo: () => void;
};

// recompute timeline length in frames from the current clips
const withMeta = (meta: Meta | null, clips: Clip[]): Meta | null =>
  meta ? {...meta, durationInFrames: totalDurationFrames(clips, meta.fps)} : meta;

const mapCap = (caps: Caption[], id: string, fn: (c: Caption) => Caption) =>
  caps.map((c) => (c.id === id ? fn(c) : c));

export const useEditor = create<EditorState>((set) => ({
  meta: null,
  captions: [],
  clips: [],
  music: null,
  accentColor: '#FFB020',
  selectedId: null,
  selectedClipId: null,
  currentFrame: 0,
  past: [],
  future: [],

  init: (meta, captions, accentColor, clips = [], music = null) =>
    set((s) => ({
      meta: withMeta(meta, clips),
      captions,
      clips,
      music,
      accentColor: accentColor ?? s.accentColor,
      past: [],
      future: [],
    })),
  select: (id) => set({selectedId: id}),
  setCurrentFrame: (f) => set({currentFrame: f}),

  setTopPct: (id, topPct) => set((s) => ({captions: mapCap(s.captions, id, (c) => ({...c, topPct}))})),

  // правка текста: ре-токенизация, равномерное распределение тайминга,
  // сохранение акцентов по совпадению слова
  setText: (id, text) =>
    set((s) => ({
      captions: mapCap(s.captions, id, (c) => {
        const tokens = text.trim().split(/\s+/).filter(Boolean);
        if (!tokens.length) return c;
        const accented = new Set(c.words.filter((w) => w.accent).map((w) => w.text.toLowerCase()));
        const per = (c.endMs - c.startMs) / tokens.length;
        const words = tokens.map((t, i) => ({
          text: t,
          startMs: Math.round(c.startMs + i * per),
          endMs: Math.round(c.startMs + (i + 1) * per),
          accent: accented.has(t.toLowerCase()),
        }));
        return {...c, words};
      }),
    })),

  toggleAccent: (id, wi) =>
    set((s) => ({
      captions: mapCap(s.captions, id, (c) => ({
        ...c,
        words: c.words.map((w, i) => (i === wi ? {...w, accent: !w.accent} : w)),
      })),
    })),

  // правка тайминга — слова репроецируются пропорционально в новый интервал
  setTiming: (id, startMs, endMs) =>
    set((s) => ({
      captions: mapCap(s.captions, id, (c) => {
        const oldSpan = Math.max(1, c.endMs - c.startMs);
        const newSpan = Math.max(1, endMs - startMs);
        const words = c.words.map((w) => ({
          ...w,
          startMs: Math.round(startMs + ((w.startMs - c.startMs) / oldSpan) * newSpan),
          endMs: Math.round(startMs + ((w.endMs - c.startMs) / oldSpan) * newSpan),
        }));
        return {...c, startMs, endMs, words};
      }),
    })),

  // ---- clips track ----
  selectClip: (id) => set({selectedClipId: id}),

  deleteClip: (id) =>
    set((s) => {
      const clips = s.clips.filter((c) => c.id !== id);
      return {clips, meta: withMeta(s.meta, clips), selectedClipId: s.selectedClipId === id ? null : s.selectedClipId};
    }),

  // reorder by swapping with the neighbour in `dir` (-1 left, +1 right)
  moveClip: (id, dir) =>
    set((s) => {
      const i = s.clips.findIndex((c) => c.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= s.clips.length) return s;
      const clips = s.clips.slice();
      [clips[i], clips[j]] = [clips[j], clips[i]];
      return {clips};
    }),

  // trim in/out (sec), clamped to [0, sourceDuration] with a 0.2s min length
  trimClip: (id, inSec, outSec) =>
    set((s) => {
      const clips = s.clips.map((c) => {
        if (c.id !== id) return c;
        const lo = Math.max(0, Math.min(inSec, c.sourceDurationSec - 0.2));
        const hi = Math.min(c.sourceDurationSec, Math.max(outSec, lo + 0.2));
        return {...c, inSec: lo, outSec: hi};
      });
      return {clips, meta: withMeta(s.meta, clips)};
    }),

  setMusic: (music) => set({music}),

  // снапшот текущего состояния перед логической правкой
  pushHistory: () =>
    set((s) => ({past: [...s.past, s.captions].slice(-HISTORY_LIMIT), future: []})),

  undo: () =>
    set((s) => {
      if (!s.past.length) return s;
      const prev = s.past[s.past.length - 1];
      return {captions: prev, past: s.past.slice(0, -1), future: [s.captions, ...s.future]};
    }),

  redo: () =>
    set((s) => {
      if (!s.future.length) return s;
      const next = s.future[0];
      return {captions: next, past: [...s.past, s.captions], future: s.future.slice(1)};
    }),
}));
