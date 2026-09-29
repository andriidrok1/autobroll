// node --test (Node ≥ 22.6 strips the types from ./keys.ts natively)
import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveKey, isTypingTarget} from './keys.ts';

const ctx = {frame: 50, totalFrames: 300};

test('arrows nudge the playhead by one frame, Shift by ten', () => {
  assert.deepEqual(resolveKey({key: 'ArrowLeft'}, ctx), {type: 'seek', frame: 49});
  assert.deepEqual(resolveKey({key: 'ArrowRight'}, ctx), {type: 'seek', frame: 51});
  assert.deepEqual(resolveKey({key: 'ArrowLeft', shiftKey: true}, ctx), {type: 'seek', frame: 40});
  assert.deepEqual(resolveKey({key: 'ArrowRight', shiftKey: true}, ctx), {type: 'seek', frame: 60});
});

test('seeking is clamped to the timeline', () => {
  assert.deepEqual(resolveKey({key: 'ArrowLeft', shiftKey: true}, {frame: 3, totalFrames: 300}), {type: 'seek', frame: 0});
  assert.deepEqual(resolveKey({key: 'ArrowRight', shiftKey: true}, {frame: 295, totalFrames: 300}), {type: 'seek', frame: 299});
  assert.deepEqual(resolveKey({key: 'Home'}, ctx), {type: 'seek', frame: 0});
  assert.deepEqual(resolveKey({key: 'End'}, ctx), {type: 'seek', frame: 299});
});

test('Delete/Backspace remove the selection, S splits, Esc escapes', () => {
  assert.deepEqual(resolveKey({key: 'Delete'}, ctx), {type: 'delete-selection'});
  assert.deepEqual(resolveKey({key: 'Backspace'}, ctx), {type: 'delete-selection'});
  assert.deepEqual(resolveKey({key: 's'}, ctx), {type: 'split'});
  assert.deepEqual(resolveKey({key: 'S', shiftKey: true}, ctx), {type: 'split'});
  assert.deepEqual(resolveKey({key: 'Escape'}, ctx), {type: 'escape'});
});

test('Space toggles playback unless a keyboard-focused button owns it', () => {
  assert.deepEqual(resolveKey({key: ' ', code: 'Space'}, ctx), {type: 'toggle-play'});
  assert.equal(resolveKey({key: ' ', code: 'Space'}, {...ctx, targetIsFocusedButton: true}), null);
});

test('undo/redo chords; other modifier chords are left to the browser', () => {
  assert.deepEqual(resolveKey({key: 'z', metaKey: true}, ctx), {type: 'undo'});
  assert.deepEqual(resolveKey({key: 'z', ctrlKey: true, shiftKey: true}, ctx), {type: 'redo'});
  assert.deepEqual(resolveKey({key: 'y', ctrlKey: true}, ctx), {type: 'redo'});
  assert.equal(resolveKey({key: 's', ctrlKey: true}, ctx), null);
  assert.equal(resolveKey({key: 'ArrowLeft', metaKey: true}, ctx), null);
});

test('typing targets are recognised', () => {
  assert.equal(isTypingTarget({tagName: 'INPUT'}), true);
  assert.equal(isTypingTarget({tagName: 'textarea'}), true);
  assert.equal(isTypingTarget({tagName: 'DIV', isContentEditable: true}), true);
  assert.equal(isTypingTarget({tagName: 'BUTTON'}), false);
  assert.equal(isTypingTarget(null), false);
});
