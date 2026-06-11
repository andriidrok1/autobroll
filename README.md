# AutoBroll

An AI short-form video editor that runs in your browser. Drop in your raw takes — it listens to them, puts them in narrative order, cuts the silence, writes human-looking captions, finds B-roll, and lets you polish everything on a CapCut-style timeline. Export to mp4. Built on [Remotion](https://remotion.dev).

![AutoBroll editor](docs/screenshot.png)

Most AI caption tools lock subtitles to the bottom, highlight every other word, and slap a box behind them. AutoBroll is the opposite: sparing gold accents on the words that matter, captions placed where they don't cover your face, soft cross-dissolves — output that reads like a human editor cut it by hand.

> Personal tool, shared as-is. Everything runs locally; the only network calls are Gemini (text analysis) and Pexels (stock B-roll search).

## What it does

**AI, one click each:**
- **Auto-arrange** — transcribes every take, orders them into a coherent story, groups retakes of the same line, suggests which duplicates to drop (you confirm)
- **Autocut** — removes silence at the ends *and* long pauses inside every clip (jump-cuts)
- **Generate Captions** — WhisperX word-level transcription → phrase-aware caption pages → Gemini picks the few words worth accenting. Re-running never overwrites your manual edits
- **Auto B-roll** — Gemini finds the moments where a visual helps, prefers *your* uploaded footage, falls back to Pexels (with swappable alternatives)

**Editor:**
- Multi-clip timeline: drag to reorder, drag edges to trim, `S` to split at the playhead, waveforms on every clip
- Click anything on the preview to select it; drag corner to resize, drag captions to reposition
- **Keyframes** (CapCut-style flags) for smooth zoom/pan animation per clip
- Per-clip speed (0.25–4×), volume, mute; music with volume/fade and **auto-ducking under voice**
- Caption editing: text, accent words, position, size
- Full undo/redo (⌘Z), autosave, multi-project library
- Export mp4 (frame-accurate Remotion render)

Captions, B-roll and keyframes are **anchored to clips** — reorder, trim, split or speed up a clip and everything moves with it.

## Setup

Requirements: **Node 20+**, **ffmpeg** on PATH, **Python 3.10+** (for WhisperX).

```bash
git clone <repo> && cd autobroll
npm install

# transcription (WhisperX — word-level timestamps)
python3 -m venv .venv
.venv/bin/pip install whisperx

# API keys
cp .env.example .env   # then paste your keys (both have free tiers)
```

## Run

```bash
npm start
```

Open **http://localhost:5173** → drop your clips → Open editor.

A sensible flow: **Auto-arrange** → remove duplicate takes (banner) → **Autocut** → **Generate Captions** → **Auto B-roll** → polish → **Export mp4**.

### Shortcuts

| Key | Action |
|---|---|
| `Space` | play / pause |
| `S` | split clip at playhead |
| `⌘Z` / `⇧⌘Z` | undo / redo |

## How it works

```
clips (mp4/mov…) ──► /api/add-clip      ffmpeg remux/encode + thumbnail
                          │
                 WhisperX per clip      word timestamps, cached per clip —
                          │             arrange/captions/autocut share one transcription
              Gemini (structured JSON)  order takes · pick accent words · plan B-roll
                          │
              Remotion composition      clips back-to-back + captions + B-roll +
                          │             music (ducked) + keyframed transforms
                  @remotion/player      live preview in the editor (same component)
                  remotion render       frame-accurate mp4 export
```

- `editor/` — React app (Vite + Tailwind + zustand + @remotion/player)
- `src/` — the Remotion composition (what the player previews *and* the renderer exports)
- `server/` — small Node backend: projects, uploads, waveforms, AI jobs, render
- `scripts/` — AI pipelines (transcribe/arrange/captions/B-roll/autocut) + `gemini.mjs` client

Tip: set `AUTOBROLL_PROMPT` in `.env` with your topics/brand names — it biases transcription accuracy for your vocabulary.

## License

MIT
