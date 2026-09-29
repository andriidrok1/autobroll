// Keyboard model for the editor (pure, so it can be unit-tested without a DOM).
//
//   Space            play / pause
//   ← / →            move the playhead 1 frame (Shift = 10 frames)
//   Home / End       jump to the start / end
//   S                split the clip under the playhead
//   Delete / ⌫       delete the selected clip (or B-roll cue)
//   Esc              dismiss the duplicate-takes banner, else clear the selection
//   ⌘Z / ⌘⇧Z / ⌘Y    undo / redo
//
// Keys are ignored while typing (input/textarea/contenteditable), and Space is
// left to a keyboard-focused button so Tab + Space activates it instead of
// toggling playback.

export type KeyLike = {key: string; code?: string; shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean};

export type KeyAction =
  | {type: 'toggle-play'}
  | {type: 'seek'; frame: number}
  | {type: 'split'}
  | {type: 'delete-selection'}
  | {type: 'escape'}
  | {type: 'undo'}
  | {type: 'redo'}
  | null;

export const FRAME_STEP = 1;
export const FRAME_STEP_FAST = 10;

/** true when the key event originates in a text field — the editor must not steal it */
export const isTypingTarget = (el: {tagName?: string; isContentEditable?: boolean} | null | undefined): boolean => {
  if (!el) return false;
  const tag = (el.tagName ?? '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!el.isContentEditable;
};

export const resolveKey = (
  e: KeyLike,
  ctx: {frame: number; totalFrames: number; targetIsFocusedButton?: boolean},
): KeyAction => {
  const mod = !!(e.metaKey || e.ctrlKey);
  const k = e.key;
  if (e.code === 'Space' || k === ' ') return ctx.targetIsFocusedButton ? null : {type: 'toggle-play'};
  if (mod && k.toLowerCase() === 'z') return e.shiftKey ? {type: 'redo'} : {type: 'undo'};
  if (mod && k.toLowerCase() === 'y') return {type: 'redo'};
  if (mod) return null; // leave other browser shortcuts alone (⌘R, ⌘L …)
  const last = Math.max(0, ctx.totalFrames - 1);
  const step = e.shiftKey ? FRAME_STEP_FAST : FRAME_STEP;
  switch (k) {
    case 'ArrowLeft': return {type: 'seek', frame: Math.max(0, ctx.frame - step)};
    case 'ArrowRight': return {type: 'seek', frame: Math.min(last, ctx.frame + step)};
    case 'Home': return {type: 'seek', frame: 0};
    case 'End': return {type: 'seek', frame: last};
    case 'Delete':
    case 'Backspace': return {type: 'delete-selection'};
    case 'Escape': return {type: 'escape'};
    case 's':
    case 'S': return {type: 'split'};
    default: return null;
  }
};
