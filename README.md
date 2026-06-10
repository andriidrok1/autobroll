# AutoBroll

Auto-generate clean, **human-looking captions** for talking-head video — then tweak them in a browser editor.

Most AI caption tools lock subtitles to the bottom, highlight every other word, and slap a box behind them. The result reads like a machine made it. AutoBroll does the opposite: it's sparing with accents, places captions where they don't cover faces or on-screen text, and renders everything as React/Remotion graphics so the output looks like a human editor cut it by hand.

> Status: working end-to-end. CLI + browser editor both run. Single-clip caption flow is solid; a multi-clip timeline and code-graphic B-roll layer are in progress.

---

## How it works

```
video.mp4
  │
  1. transcript + word timecodes      WhisperX (or whisper.cpp fallback, no Python)
  │
  2. accent detection                 Gemini → which words deserve a highlight (sparingly)
  │
  3. caption placement                Gemini vision → per-scene zone (never over a face/UI)
  │
  4. compose + render                 Remotion: OffthreadVideo + caption track → mp4
out.mp4
```

A single orchestrator (`scripts/pipeline.mjs`) runs steps 1–3 and writes `public/{meta,transcript,accents,placement}.json`. The Remotion composition (`src/CaptionedVideo.tsx`) reads those and burns captions over the clip.

## Quick start

```bash
git clone <repo> && cd autobroll
npm install
echo "GEMINI_API_KEY=..." > .env
```

**Requirements:** `ffmpeg` on your PATH, a `GEMINI_API_KEY`. WhisperX (Python, in `.venv/`) is used if present for the most accurate word timing; otherwise it falls back to `whisper.cpp` (pure Node, no Python).

### One-shot CLI

```bash
npx autobroll my-video.mp4 out.mp4
```

Transcribes → detects accents + placement → renders a captioned mp4.

### Browser editor (recommended)

```bash
npm run editor:server   # backend: import, render, project save  (:3333)
npm run editor          # editor UI  (:5173)
```

In the editor you can:

- **Import a video** — drops it through the whole pipeline, no terminal
- **Drag captions** vertically on the video to reposition
- **Edit text** to fix transcription mistakes
- **Retime** by dragging caption blocks / edges on the timeline
- **Toggle accents** per word
- **Undo / redo** (⌘Z / ⇧⌘Z) and **export** to mp4

Edits autosave to `public/project.json`, so your work survives a reload.

## Project layout

| Path | What |
|------|------|
| `scripts/pipeline.mjs` | orchestrator: meta → transcribe → accents → placement |
| `scripts/extract-meta.mjs` | ffprobe → `meta.json` (fps/size/duration) |
| `scripts/transcribe-whisperx.sh`, `transcribe.mjs` | transcription (WhisperX / whisper.cpp) |
| `scripts/detect-accents.mjs`, `detect-placement.mjs` | Gemini accent + placement passes |
| `scripts/detect-broll.mjs`, `fetch-broll.mjs` | experimental B-roll planning/fetch |
| `src/CaptionedVideo.tsx`, `CaptionTrack.tsx`, `captions.ts` | Remotion caption rendering |
| `src/NumberCallout.tsx`, `Showcase.tsx` | animated stat callouts (graphic layer) |
| `src/timeline.ts`, `MultiClipVideo.tsx` | multi-clip timeline model (in progress) |
| `editor/` | Vite + React editor on top of `@remotion/player` |
| `server/index.mjs` | import / render / project-save backend |

## License

MIT
