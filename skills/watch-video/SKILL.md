---
name: watch-video
description: Use when the user wants Claude to watch, analyze, review, take notes on, answer questions about, or compare a video — a YouTube URL, a Loom URL, or a local file (e.g. an mp4 downloaded from Slack). Extracts a time-synced transcript plus still frames at a configurable interval, producing a queryable manifest so Claude can answer follow-up questions, summarize, compare against other material, or take focused notes — whichever the user actually asked for.
---

# Watch Video

Claude can't stream video. This skill fakes it: pull a transcript (auto-captions first, Whisper fallback), extract still frames every N seconds, align each frame with the line spoken at that timestamp, then make that data **queryable for the rest of the conversation** so Claude can answer whatever the user is actually asking.

The runtime is **Bun** (TypeScript). Heavy lifting is delegated to local binaries: `ffmpeg`, `yt-dlp`, and `whisper-cli` (from `whisper-cpp`).

## When to invoke

Any time the user wants Claude to engage with a video. The ask shapes the output, not the extraction. Examples:

- "Summarize this video" / "take notes on this Loom" → produce a markdown notes file.
- "Watch this walkthrough — does it match what we've built in `apps/app/...`?" → extract, sample frames, then compare against the named project area.
- "What did the speaker say about X?" / "where in the video do they show Y?" → search transcript, quote with timestamps, pull the relevant frame.
- "Is the bug visible in this screen recording?" → look at frames near the moment described, report what you see.
- "What UI patterns / concepts should we adopt from this?" → frame-by-frame review for visual concepts.

Inputs:
- a YouTube URL
- a Loom URL (e.g. `https://www.loom.com/share/...`)
- a local video file path (e.g. an mp4 downloaded from Slack)

For Slack videos: the user must download the file first (Slack URLs carry expiring auth tokens; yt-dlp can't fetch them). Tell them to download then re-share the path.

## Dependencies (verify before first run)

All available in nixpkgs.

- `bun` — runtime
- `ffmpeg` (and `ffprobe`) — frame + audio extraction
- `yt-dlp` — only needed for URLs (YouTube, Loom, etc.)
- `whisper-cpp` — provides `whisper-cli`; needed when no captions are available

If anything is missing, surface the script's error verbatim and stop. Don't guess around a broken environment.

The Whisper model file auto-downloads on first use to `~/.cache/whisper-models/ggml-<model>.bin` (~150MB for `base.en`).

## Pipeline

Two cooperating scripts. Both are data-only tools — Claude does the understanding.

- `scripts/extract-video.ts` — downloads (if URL), extracts frames at a fixed interval, transcribes audio, writes `manifest.json`. **No dedupe by default.**
- `scripts/dedupe-frames.ts` — operates on an existing `manifest.json` + a list of mask regions; computes perceptual hashes, drops near-duplicate frames from disk, and updates the manifest in place.

```
# Step 1: extract
bun ~/.claude/skills/watch-video/scripts/extract-video.ts \
  "<url-or-local-path>" \
  --output-dir "<working-dir>" \
  --interval 1.0

# Step 2 (after agent identifies mask regions — see workflow below): dedupe
bun ~/.claude/skills/watch-video/scripts/dedupe-frames.ts \
  "<working-dir>/manifest.json" \
  --mask-region "0.85,0.85,0.13,0.13,webcam"
```

`extract-video.ts` flags:
- `--output-dir DIR` — defaults to `$TMPDIR/watch-video/<slug>/`.
- `--interval N` — seconds between frames. Default 1.0. For long videos (>10 min), bump to 2 or 3. The dedupe pass will drop redundant frames later, so erring toward denser sampling is fine.
- `--whisper-model M` — `tiny.en` / `base.en` / `small.en` / `medium.en` / `large-v3` and non-`.en` multilingual variants. Default `base.en`.
- `--no-whisper` — skip transcription if captions are missing. Frames-only output.
- `--dedupe` — opt in to the all-in-one path: extract + auto-detect mask via Haiku API + dedupe in one command. Requires `ANTHROPIC_API_KEY` for auto-mask. Useful for cron / scripted invocation; **the agent should generally not use this** — see workflow below.
- `--no-auto-mask` — only meaningful with `--dedupe`. Skip the Haiku API call; dedupe with manual masks (or none).
- `--hash-threshold N` — only meaningful with `--dedupe`. Default 5.
- `--mask-region "x,y,w,h[,label]"` — only meaningful with `--dedupe`. Fractions of frame size, top-left origin. Repeatable.

`dedupe-frames.ts` flags:
- `--mask-region "x,y,w,h[,label]"` — fractions, repeatable. Merged with any `mask_regions` already in the manifest.
- `--hash-threshold N` — Hamming distance above which two frames are considered different. Default 5.

`extract-video.ts` prints a one-line JSON to stdout:
```json
{"manifest": "...", "frames_dir": "...", "frame_count": N, "dropped_frame_count": M, "transcript_source": "captions|whisper|none", "duration_sec": ..., "title": "...", "slug": "...", "output_dir": "...", "mask_regions": [...]}
```

`dedupe-frames.ts` prints:
```json
{"manifest": "...", "kept": N, "dropped": M, "mask_regions": [...]}
```

### Why two steps

Auto-detecting mask regions needs a vision-model call on a sample frame. Two ways to make that call:

1. **Agent-driven (default for this skill).** The agent reads a sample frame and identifies mask regions itself, using the user's Claude subscription. Recommended in Claude Code by spawning a Haiku subagent for the mask step (cheap, isolated). In Claude Desktop or other clients, the agent does it inline.
2. **Direct API (cron fallback).** `extract-video.ts --dedupe` posts to `api.anthropic.com` using `ANTHROPIC_API_KEY`. This billing is **separate** from the Claude subscription. Useful when there's no agent in the loop (cron, CI), but pays an API key cost.

The agent should default to (1). (2) is for non-interactive callers.

## Workflow

### 1. Extract

Pick a working dir (default temp, or a permanent path if the user wants notes saved there).

Choose interval by length:
- ≤ 5 min: `--interval 1`
- 5–15 min: `--interval 2`
- \> 15 min: `--interval 3` or ask the user

Run extract — **do not pass `--dedupe`**:
```
bun ~/.claude/skills/watch-video/scripts/extract-video.ts "<input>" --output-dir "<dir>" --interval 1
```

Parse stdout JSON for paths. The manifest at this point has all sampled frames and a `mask_regions: []`.

### 2. Detect mask regions (cheap, with Haiku)

Pick a representative frame from the manifest's `frames` array — index `Math.floor(frames.length / 2)` (mid-video) is usually fine; avoid index 0 if it might be a title card.

**In Claude Code**, spawn a Haiku subagent so this call is cheap and stays out of the main context. Use the `Agent` tool with `model: "haiku"`. Prompt:

> Read the image at `<absolute-path-to-frame>`. This is a still frame from a screen recording. Identify regions that should be masked when comparing UI changes between frames: speaker webcams (Loom circular overlay, Zoom corner box), persistent OS chrome (menubar, dock, taskbar), watermarks, or persistent overlays. Do NOT include the cursor.
>
> Return ONLY a JSON object, no prose, no markdown fences:
> `{"mask": [{"label": "<short>", "x": <0-1>, "y": <0-1>, "w": <0-1>, "h": <0-1>}]}`
>
> Coordinates are fractions of frame width/height. (0,0) is top-left. Return `{"mask": []}` if there's nothing to mask.

Parse the JSON from the subagent's response. (If the subagent wraps it in fences or prose, extract with a regex like `/\{[\s\S]*\}/`.)

**In Claude Desktop or other clients without subagents**: do the same thing inline — Read the frame yourself and produce the same JSON in your own reasoning. The output of this step is just the list of mask regions; how you arrive at it doesn't matter.

**Pad each region by ~15%** before passing to dedupe, since vision models are imprecise on bbox edges. For a region `{x, y, w, h}`, pad to `{x: max(0, x - 0.15*w), y: max(0, y - 0.15*h), w: min(1-x', w * 1.3), h: min(1-y', h * 1.3)}`.

If the user has explicitly asked you to skip masking (or for very simple full-screen recordings), you can skip this step and run dedupe with no `--mask-region` flags.

### 3. Dedupe

Run with one `--mask-region` flag per region:
```
bun ~/.claude/skills/watch-video/scripts/dedupe-frames.ts "<dir>/manifest.json" \
  --mask-region "0.85,0.85,0.13,0.13,webcam" \
  --mask-region "0.0,0.0,1.0,0.04,menubar"
```

Default `--hash-threshold 5` is a good starting point. If the user reports the dedupe was too aggressive (lost important frames), re-run with `--hash-threshold 3`. The script merges new mask regions with any already in the manifest, so it's safe to re-run with additional regions.

The manifest now reflects the deduped state. `frames` will have fewer entries with gaps in `timestamp`; `dropped_frame_count` reflects how many were removed.

### 4. Read the manifest

Use the `Read` tool on `<output-dir>/manifest.json` directly — the file is JSON and is meant to be read as-is. Don't shell out to `jq`, `cat`, or anything else; that just adds permission prompts.

The manifest has:
- `transcript_segments` — array of `{ start, end, text }`. Searchable by keyword.
- `frames` — array of `{ path, timestamp, spoken_text }`. After dedupe these are the frames where the UI meaningfully changed. `timestamp` is the original sample time (so you can correlate with the transcript) and may have gaps where redundant frames were dropped.
- `mask_regions` — fractional bboxes that were masked when computing perceptual hashes (typically the speaker webcam). Useful context if you're sampling frames for visual analysis: those regions may contain irrelevant content (e.g. a face) that shouldn't be described as part of the demo.
- `dropped_frame_count` — how many redundant frames were removed.

This manifest is the **durable record for the rest of the conversation**. Don't delete it. If the user asks a follow-up question 10 messages later, re-read the manifest and pull the frames you need.

### 5. Initial pass over the content

**Sample, don't brute-force.** Reading every frame is wasteful for anything over a minute.

- ≤ 30s video: read every frame.
- 30s–3min: read frames every ~5s plus any frame where `spoken_text` suggests a topic shift.
- \> 3min: read frames every ~10s plus boundary frames at transcript topic shifts.

Use the `Read` tool on frame paths — they're JPEGs and Claude sees them visually. Always pair each frame with its `spoken_text`.

The goal of this pass is to know enough about the video to respond to the user's actual request. Don't over-invest if the user only asked a narrow question — sample broadly enough to confirm what the video is, then go deeper where their question points.

### 6. Respond to what the user actually asked

The output shape comes from the user's request. Common branches:

#### A. Q&A or "where in the video does X happen?"
- Search `transcript_segments` for the keyword(s).
- Pull the matching frame(s) by timestamp from the `frames` array.
- Quote the line with `[mm:ss]` and describe what's on screen.
- Keep the response tight — don't write a full summary unless asked.

#### B. Comparison ("does this match our current X?", "how does this differ from what we built?")
- Identify the parts of the video that map to the comparison target. The user usually points at a path or component; if not, ask.
- Read the relevant project files **and** the corresponding frames.
- Report differences concretely, side by side. Cite both sides:
  - Video: `[mm:ss]` + what's visible / said.
  - Project: file path + line number + what's there.
- Note divergences in behavior, layout, copy, flow, naming. Flag anything that looks like a deliberate design improvement worth pulling in.

#### C. Summary / notes (the "give me notes on this video" ask)
Write to `<output-dir>/<slug>-notes.md` (or a user-specified path):

```markdown
# <Title>

**Source:** <URL or local path>
**Duration:** <mm:ss>
**Transcript source:** <captions / whisper-base.en / none>

## One-line summary
<≤20 words — the core hook>

## TL;DR
<3–5 bullets capturing the main beats>

## Timeline
- **[00:00]** <what's on screen + the key line>
- **[00:15]** ...

## Key quotes
> "<verbatim>" — [mm:ss]

## Visual notes
<What the video shows that the transcript misses — layout, on-screen text, transitions, micro-interactions, B-roll, emotion.>
```

#### D. UI walkthrough / product demo / design review
This is a flavor of (C) or (B) — the user wants the visual patterns extracted. Add these sections (or fold into the comparison output):

```markdown
## Concepts to adopt
- **[01:23] <pattern name>** — <what it does, why it works, what to take away>

## Wins
- **[02:14] <thing>** — <why it's a win>

## Watchouts
<things that didn't land — only if you genuinely noticed something>
```

Be specific and timestamp-anchored. "Good copy" is useless; "the empty state uses the verb the user just tried (`Connect Stripe → Stripe not connected yet`) instead of generic 'No data'" is useful.

#### E. Anything else
If the ask doesn't fit the above (e.g. "transcribe this", "extract just the slides", "is the audio quality OK"), use the manifest data to answer directly. The manifest is the source of truth — drive your response from it.

### 7. Stay queryable for follow-ups

After the initial response, **keep the manifest and frames around** for the rest of the conversation. If the user comes back with "wait, what did they say at minute 4?" or "show me that screen with the sidebar again," you re-read the manifest and pull the relevant frame — no re-extraction needed.

Only clean up when:
- the user explicitly says they're done with this video, OR
- you're starting a different video and the temp dir would otherwise pile up.

When cleaning up, delete `<output-dir>/frames/` (the only remaining intermediate — `_audio.wav` and `_whisper.json` are removed by `extract-video.ts` itself on success). Keep the `.md` (if any) and `manifest.json`.

## Common gotchas

- **Slack videos** — Slack share URLs have expiring auth tokens; yt-dlp can't fetch them. Ask the user to download the mp4 first, then pass the local path.
- **Private Loom videos** — public/shared Loom URLs work. Private/team-locked ones need browser cookies; surface yt-dlp's error verbatim and suggest `--cookies-from-browser` if relevant.
- **YouTube Shorts / age-gated / members-only** — yt-dlp may fail. Surface the error verbatim; don't retry silently.
- **No captions + no whisper-cli installed** — script notes it and continues frames-only. For audio-heavy videos that's a poor result; tell the user to install whisper-cpp.
- **Local file with no audio track** — pass `--no-whisper` to get frames-only output.
- **Very long videos (>30 min)** — confirm before running. 60 min @ 1s = 3600 frames. Use `--interval 5` or higher.
- **YouTube auto-caption duplication** — auto-captions emit rolling/repeated text. The parser dedupes, but if a transcript looks weirdly repetitive, that's the source.
- **Mask wrong / over-aggressive** — Haiku occasionally mis-identifies a region (e.g. masks a real UI panel). Once dedupe-frames.ts has run, dropped frames are gone from disk; to recover, re-run extract-video.ts and skip step 2 (or pass corrected `--mask-region` flags). Subsequent dedupe-frames.ts calls *merge* masks with existing ones — to replace, edit `manifest.json` first.
- **Dedupe ate useful frames** — happens with subtle UI animations (tooltips, focus rings) that fall below the hash threshold. To recover: re-extract with a finer `--interval` and either skip dedupe or run dedupe-frames.ts with `--hash-threshold 3` for a more permissive cut.

## What NOT to do

- Don't pretend to "watch" a video by inventing content from the title or thumbnail. If the pipeline fails, say so.
- Don't read every frame for videos over a minute — sample.
- Don't write a summary or "concepts to adopt" section if the user only asked a narrow question. Match the response to the ask.
- Don't delete the manifest or frames after the first response — the user will likely have follow-ups.
- Don't run extraction twice on the same video. If a working dir already has a `manifest.json`, reuse it.
- Don't pass `--dedupe` to `extract-video.ts` from the agent path — that triggers the direct API call. Use the two-step flow (extract → mask detection → dedupe-frames.ts) so the mask call uses the user's subscription via the Haiku subagent.
- Don't reach for the most powerful model for the mask-detection subagent. Pin it to Haiku — the task is "look at one frame, return JSON bboxes." Anything bigger is wasted budget.
- Don't shell out via Bash for things that have a dedicated tool. Read the manifest with `Read`, sample frames with `Read`, spawn the mask subagent with `Agent`. The only Bash calls the workflow needs are the two `bun` script invocations (extract + dedupe).

## Minimising permission prompts

This skill's full happy path uses exactly two distinct Bash commands:

- `bun ~/.claude/skills/watch-video/scripts/extract-video.ts ...`
- `bun ~/.claude/skills/watch-video/scripts/dedupe-frames.ts ...`

Allowlist both at the user level by adding the following to your Claude Code settings (managed via nix in this setup — see `/Users/Shared/Code/nix/hosts/macbook/concord.nix`):

```json
{
  "permissions": {
    "allow": [
      "Bash(bun ~/.claude/skills/watch-video/scripts/extract-video.ts:*)",
      "Bash(bun ~/.claude/skills/watch-video/scripts/dedupe-frames.ts:*)"
    ]
  }
}
```

After that, no permission prompts during a normal run. Read / Agent calls don't prompt by default.
