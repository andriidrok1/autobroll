// Caption-сущности: редактируемая модель субтитров.
// Строятся один раз из words+accents+placements, дальше редактируются в сторе.

export type Word = {word: string; startMs: number; endMs: number};
export type Placement = {fromMs: number; toMs: number; topPct: number};

export type CaptionWord = {text: string; startMs: number; endMs: number; accent: boolean};
export type Caption = {
  id: string;
  words: CaptionWord[];
  startMs: number;
  endMs: number;
  topPct: number;
};

const MAX_WORDS = 4;
const GAP_MS = 700;
export const DEFAULT_TOP = 58;

const PUNCT_ONLY = /^[.,!?;:()\-—]+$/;
const SENT_END = /[.!?]$/;
const toDisplay = (w: string) => w.replace(/[.,;:]+$/g, '').replace(/^[.,;:]+/g, '');

type Page = {words: CaptionWord[]; start: number; end: number};

function buildPages(raw: Word[], accentIdx: number[]): Page[] {
  const acc = new Set(accentIdx);
  const pages: Page[] = [];
  let cur: CaptionWord[] = [];
  let skipParen = false;
  const flush = () => {
    if (cur.length) {
      pages.push({words: cur, start: cur[0].startMs, end: cur[cur.length - 1].endMs});
      cur = [];
    }
  };
  raw.forEach((w, i) => {
    if (w.word === '(') { skipParen = true; flush(); return; }
    if (w.word === ')') { skipParen = false; return; }
    if (skipParen || PUNCT_ONLY.test(w.word)) return;
    const prev = cur[cur.length - 1];
    const bigGap = prev && w.startMs - prev.endMs > GAP_MS;
    if (cur.length >= MAX_WORDS || bigGap) flush();
    const display = toDisplay(w.word);
    if (!display) return;
    cur.push({text: display, startMs: w.startMs, endMs: w.endMs, accent: acc.has(i)});
    if (SENT_END.test(w.word)) flush();
  });
  flush();
  return pages;
}

export function buildCaptions(
  words: Word[],
  accents: number[],
  placements: Placement[],
  defaultTop = DEFAULT_TOP,
): Caption[] {
  return buildPages(words, accents).map((p, i) => {
    const scene = placements.find((pl) => p.start >= pl.fromMs && p.start < pl.toMs);
    return {
      id: `c${i}`,
      words: p.words,
      startMs: p.start,
      endMs: p.end,
      topPct: scene ? scene.topPct : defaultTop,
    };
  });
}
