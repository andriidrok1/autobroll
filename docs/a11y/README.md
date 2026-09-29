# Accessibility pass

Audit of the browser editor with [axe-core](https://github.com/dequelabs/axe-core) (WCAG 2.1 A/AA + best-practice rules) on six screens: the Start screen (project library) and the editor with a project open (default, clip selected, and the B-roll / Styles / Settings Inspector tabs). Unique violating nodes, deduplicated across screens.

| impact   | before | after |
|----------|-------:|------:|
| critical |      2 |     0 |
| serious  |      8 |     0 |
| moderate |      7 |     0 |
| minor    |      0 |     0 |

Raw reports: [`baseline.json`](baseline.json), [`after.json`](after.json).

What the baseline was failing on: range sliders without labels (`label`), project cards with a delete button nested inside a `role=button` (`nested-interactive`), a scrollable timeline nobody could reach with the keyboard (`scrollable-region-focusable`), helper text at 60 % opacity (`color-contrast`), and missing landmarks/heading structure (`region`, `landmark-one-main`, `landmark-unique`, `page-has-heading-one`).

Things axe does not flag but were fixed anyway: Material Symbols ligatures were the accessible names of icon buttons (a screen reader said "skip_previous"); timeline blocks were plain `div`s with pointer handlers, so a keyboard user could not select a clip at all; Space was intercepted globally, so Tab + Space on a button toggled playback instead of pressing the button; no live region existed for transcription / B-roll / render progress.

## Run it

```bash
npm start          # backend + editor
npm run a11y       # → docs/a11y/report.json, exits 1 on any critical/serious
npm test           # keyboard-map unit tests (node:test)
```

The audit uses `playwright-core` with the Chromium from `~/.cache/ms-playwright` (`npx playwright-core install chromium` if it is missing). `A11Y_URL`, `A11Y_SHOTS=dir` (screenshots per screen) and `CHROMIUM_PATH` are honoured. It opens the most recent project in the library, so keep at least one around for the editor screens.

## Keyboard

| key | action |
|-----|--------|
| `Tab` / `Shift+Tab` | move between controls, including every clip, caption and B-roll block on the timeline |
| `Enter` / `Space` on a block | select it and seek to its start |
| `Space` (elsewhere) | play / pause |
| `←` / `→` | move the playhead 1 frame, `Shift` = 10 frames |
| `Home` / `End` | jump to the start / end |
| `S` | split the clip under the playhead |
| `Delete` / `Backspace` | delete the selected clip (or B-roll cue) |
| `Esc` | dismiss the duplicate-takes banner, else clear the selection |
| `Ctrl/⌘+Z`, `Ctrl/⌘+Shift+Z`, `Ctrl/⌘+Y` | undo / redo |
| `←` / `→` / `Home` / `End` on the Inspector tabs | switch tab |

Keys are ignored while typing in a text field. Space goes to the focused control only when focus got there via `Tab`; after a mouse click on a clip, Space still means play/pause (see `editor/modality.ts`). The keyboard map lives in `editor/keys.ts` and is covered by `editor/keys.test.mjs`.

## What is exposed to assistive tech

- Every icon-only button has an `aria-label` and `title` (`editor/IconButton.tsx`); the icon glyph itself is `aria-hidden`.
- Landmarks: `main` on the Start screen; in the editor `header`, `aside[aria-label=Assets]`, `section[aria-label=Preview]`, `aside[aria-label=Inspector]`, `footer[aria-label=Timeline]`, plus a visually hidden `h1`.
- Timeline: the scroll canvas is a focusable `region`; each track is a `group` with a name; blocks are `role=button` with `aria-pressed` for selection and a descriptive name (clip name, duration, start, muted / speed / duplicate flags).
- Inspector: WAI-ARIA `tablist` / `tab` / `tabpanel` with roving tabindex; all sliders have `label for` + `aria-valuetext`; speed presets, accent words, swatches and B-roll placement expose `aria-pressed`; music ducking is a `switch`.
- Live regions: one polite `status` announces long jobs (Auto-arrange, Autocut, captions, B-roll, render) with progress rounded to tens; upload/import status in the Start screen and Assets panel is also `status`; the toast is `status` (or `alert` for errors).
- Focus: a single `:focus-visible` ring everywhere (white, inset, on timeline blocks); no `outline: none` left on interactive elements. Hover-only delete buttons on project cards and B-roll assets also appear on keyboard focus.

## Not covered

- Trimming a clip and resizing/panning in the preview are still pointer-only drags. The Inspector shows In/Out/Duration and speed for everyone, but there is no keyboard equivalent for trim handles or the resize corner.
- The Remotion `<Player>` internals (the `<video>` element) are not audited or changed.
- No modals exist in the app, so there is no dialog focus trap to test.
- Contrast was fixed only where axe measured it (helper text at 60 % / 50 % / 40 % opacity → 75 %); text over waveforms and thumbnails is not measured by axe.
