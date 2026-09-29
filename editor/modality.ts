// Did the focused element get there via the keyboard (Tab) or a pointer?
// Chrome flips :focus-visible on during the keydown itself, so it can't tell us
// whether Space on a focused control should activate the control (keyboard
// user) or play/pause the preview (mouse user who just clicked a clip).
let keyboard = false;
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => { if (e.key === 'Tab') keyboard = true; }, true);
  window.addEventListener('pointerdown', () => { keyboard = false; }, true);
}
export const focusIsFromKeyboard = () => keyboard;
