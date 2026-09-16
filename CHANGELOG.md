# Changelog

## 0.4.0 — 2026-09-16

**New: Claude can edit your video.** `mcp/server.mjs` is an MCP server with 24 tools over the project model and the AI pipelines — clips (trim, split, reorder, speed, keyframes), captions (text, accents, position, size), B-roll (Pexels search, add, move, mode), music, `run_ai_step`, `render`, and `frame_at` so Claude can look at a source or rendered frame. Register with `claude mcp add`; `.mcp.json` covers Claude Code inside the repo. The browser editor polls the project file and reloads live when Claude saves it.

## 0.3.0 — 2026-09-16

**Fixed**
- Export failed at ~47% with a misleading "disk space is low" message whenever Auto B-roll had picked a 4K Pexels clip. Remotion's compositor cannot read 2160-tall sources; the planner now takes the smallest file that is at least 1080×1920, and the server downloads every remote B-roll once into `public/broll/` and downscales anything taller before rendering. Old projects and your own 4K footage render too.
- Project cards on the Start screen were a `<button>` inside a `<button>` (React warning).

**Faster**
- WhisperX runs on the GPU when torch sees one (float16), CPU otherwise (int8). `AUTOBROLL_DEVICE=cpu|cuda` overrides; a failed CUDA run falls back to the CPU.
- One WhisperX process per batch instead of one per clip. Three takes: ~10 s instead of ~51 s.
- Transcripts are cached per source file, so Autocut segments and re-arranged copies never re-transcribe.
- Export concurrency and the OffthreadVideo cache now follow the machine (cores − 2, ¼ of RAM) instead of assuming a 16-core box.

**New**
- Face-aware captions: one frame per source clip goes to Gemini, the caption block lands just under the chin (or above the head when the face sits low). Cached per source; `AUTOBROLL_FACE_AWARE=0` disables.
- `npm run setup` — checks Node/ffmpeg/Python, creates the WhisperX venv (`--cpu` for a CPU-only torch), seeds `.env`.
- Start screen shows what is missing (ffmpeg, WhisperX, API keys) with a fix hint, via `/api/health`.
- AI job failures show the actual cause in the editor ("GEMINI_API_KEY is missing…", "WhisperX is not installed…") instead of "see server logs".

## 0.2.0 — 2026-06-11

Multi-clip editor: Auto-arrange, Autocut, captions, Auto B-roll, keyframes, speed, audio ducking, export.
