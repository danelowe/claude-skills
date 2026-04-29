#!/usr/bin/env bun
import { $ } from "bun";
import { mkdir, readFile, writeFile, readdir, rm, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  type TranscriptSegment,
  type TranscriptSource,
  type Frame,
  type Manifest,
  type MaskRegion,
  computeFrameHashesSequential,
  dedupeByHash,
  ffprobeDimensions,
  padRegion,
  parseMaskRegionArg,
} from "./lib";

const WHISPER_MODELS_DIR = join(homedir(), ".cache", "whisper-models");
const WHISPER_MODEL_BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const FRAME_PATTERN = "frame_%05d.jpg";

const isUrl = (s: string): boolean => /^https?:\/\//i.test(s);

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\.[^/.]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "video";

const which = (cmd: string): boolean => Bun.which(cmd) !== null;

const die = (msg: string, code = 1): never => {
  console.error(msg);
  process.exit(code);
};

type Args = {
  input: string;
  outputDir: string;
  interval: number;
  whisperModel: string;
  useWhisper: boolean;
  dedupe: boolean;
  autoMask: boolean;
  hashThreshold: number;
  manualMask: MaskRegion[];
};

const parseArgs = (): Args => {
  const argv = process.argv.slice(2);
  let input = "";
  let outputDir = "";
  let interval = 1.0;
  let whisperModel = "base.en";
  let useWhisper = true;
  let dedupe = false;
  let autoMask = true;
  let hashThreshold = 5;
  const manualMask: MaskRegion[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--output-dir") outputDir = argv[++i]!;
    else if (a === "--interval") interval = parseFloat(argv[++i]!);
    else if (a === "--whisper-model") whisperModel = argv[++i]!;
    else if (a === "--no-whisper") useWhisper = false;
    else if (a === "--dedupe") dedupe = true;
    else if (a === "--no-auto-mask") autoMask = false;
    else if (a === "--hash-threshold") hashThreshold = parseInt(argv[++i]!, 10);
    else if (a === "--mask-region") {
      try {
        manualMask.push(parseMaskRegionArg(argv[++i]!));
      } catch (e) {
        die((e as Error).message, 2);
      }
    } else if (a === "-h" || a === "--help") {
      console.log(
        "Usage: extract-video.ts <url-or-path>\n" +
          "  [--output-dir DIR] [--interval N] [--whisper-model M] [--no-whisper]\n" +
          "  [--dedupe] [--no-auto-mask] [--hash-threshold N]\n" +
          "  [--mask-region \"x,y,w,h[,label]\"]   (fractions 0-1, repeatable)\n\n" +
          "Default: extract frames + transcript only. Pass --dedupe to also run\n" +
          "the perceptual-hash dedupe pass (uses ANTHROPIC_API_KEY for auto-mask\n" +
          "via Haiku unless --no-auto-mask). For agent-driven mask detection,\n" +
          "leave --dedupe off here and run dedupe-frames.ts separately.",
      );
      process.exit(0);
    } else if (!a.startsWith("--") && !input) input = a;
    else die(`Unknown arg: ${a}`, 2);
  }
  if (!input) die("Usage: extract-video.ts <url-or-path> [flags]; see --help", 2);
  return { input, outputDir, interval, whisperModel, useWhisper, dedupe, autoMask, hashThreshold, manualMask };
};

const ffprobeDuration = async (file: string): Promise<number> => {
  const out = await $`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${file}`.text();
  return parseFloat(out.trim()) || 0;
};

const ytDlpInfo = async (url: string): Promise<{ title: string }> => {
  const out = await $`yt-dlp -j --no-warnings ${url}`.text();
  const j = JSON.parse(out);
  return { title: j.title || "video" };
};

const downloadVideo = async (
  url: string,
  dir: string,
): Promise<{ video: string; vtt: string | null; title: string }> => {
  const info = await ytDlpInfo(url);
  const outTemplate = join(dir, "source.%(ext)s");
  await $`yt-dlp --no-warnings --write-auto-subs --sub-langs "en.*,en" --sub-format vtt --convert-subs vtt -o ${outTemplate} ${url}`;
  const files = await readdir(dir);
  const video = files.find(
    (f) => f.startsWith("source.") && !f.endsWith(".vtt") && !f.endsWith(".part") && !f.endsWith(".json"),
  );
  if (!video) die("yt-dlp did not produce a video file");
  const vttFile = files.find((f) => f.endsWith(".vtt"));
  return { video: join(dir, video!), vtt: vttFile ? join(dir, vttFile) : null, title: info.title };
};

const vttToSec = (ts: string): number => {
  const [h = "0", m = "0", s = "0"] = ts.split(":");
  return parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s.replace(",", "."));
};

const parseVtt = (content: string): TranscriptSegment[] => {
  const segments: TranscriptSegment[] = [];
  const lines = content.split(/\r?\n/);
  const tsRe = /^(\d{2}:\d{2}:\d{2}[\.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[\.,]\d{3})/;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const m = line.match(tsRe);
    if (!m) {
      i++;
      continue;
    }
    const start = vttToSec(m[1]!);
    const end = vttToSec(m[2]!);
    i++;
    const textLines: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() !== "") {
      const cleaned = (lines[i] ?? "").replace(/<[^>]+>/g, "").trim();
      if (cleaned) textLines.push(cleaned);
      i++;
    }
    const text = textLines.join(" ").trim();
    if (text) segments.push({ start, end, text });
  }
  const deduped: TranscriptSegment[] = [];
  for (let j = 0; j < segments.length; j++) {
    const cur = segments[j]!;
    const next = segments[j + 1];
    if (next && next.text.startsWith(cur.text) && next.text !== cur.text) continue;
    deduped.push(cur);
  }
  return deduped;
};

const ensureWhisperModel = async (model: string): Promise<string> => {
  const path = join(WHISPER_MODELS_DIR, `ggml-${model}.bin`);
  if (existsSync(path)) return path;
  await mkdir(WHISPER_MODELS_DIR, { recursive: true });
  const url = `${WHISPER_MODEL_BASE_URL}/ggml-${model}.bin`;
  console.error(`Downloading whisper model ${model} from ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) die(`Failed to download whisper model ${model}: HTTP ${res.status}`);
  // Bun.write(path, response) hangs silently on HF's chunked S3 redirect, so
  // buffer the response fully before writing. ~150MB in memory is fine for a
  // one-time download.
  const tmpPath = `${path}.part`;
  await Bun.write(tmpPath, await res.bytes());
  await rename(tmpPath, path);
  return path;
};

const whisperBin = (): string | null => {
  if (which("whisper-cli")) return "whisper-cli";
  if (which("whisper-cpp")) return "whisper-cpp";
  return null;
};

const transcribeWithWhisper = async (
  videoFile: string,
  dir: string,
  model: string,
  bin: string,
): Promise<TranscriptSegment[]> => {
  const wav = join(dir, "_audio.wav");
  await $`ffmpeg -y -loglevel error -i ${videoFile} -ar 16000 -ac 1 -c:a pcm_s16le ${wav}`.quiet();
  const modelPath = await ensureWhisperModel(model);
  const outBase = join(dir, "_whisper");
  // -np suppresses progress prints; .quiet() suppresses the result-stream
  // whisper-cli emits to stdout (we read the JSON from disk anyway).
  await $`${bin} -m ${modelPath} -f ${wav} -oj -of ${outBase} -np`.quiet();
  const json = JSON.parse(await readFile(`${outBase}.json`, "utf8"));
  const segs: TranscriptSegment[] = (json.transcription || [])
    .map((s: { offsets?: { from: number; to: number }; text?: string }) => ({
      start: (s.offsets?.from ?? 0) / 1000,
      end: (s.offsets?.to ?? 0) / 1000,
      text: (s.text ?? "").trim(),
    }))
    .filter((s: TranscriptSegment) => s.text);
  return segs;
};

const extractFrames = async (videoFile: string, dir: string, interval: number): Promise<string[]> => {
  const framesDir = join(dir, "frames");
  await mkdir(framesDir, { recursive: true });
  const fps = 1 / interval;
  await $`ffmpeg -y -loglevel error -i ${videoFile} -vf fps=${fps} -q:v 4 ${framesDir}/${FRAME_PATTERN}`;
  const files = (await readdir(framesDir)).filter((f) => f.endsWith(".jpg")).sort();
  return files.map((f) => join(framesDir, f));
};

const findSpoken = (segments: TranscriptSegment[], t: number): string => {
  for (const s of segments) if (t >= s.start && t < s.end) return s.text;
  let best = "";
  for (const s of segments) {
    if (s.start <= t) best = s.text;
    else break;
  }
  return best;
};

const identifyMaskRegions = async (imagePath: string): Promise<MaskRegion[]> => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const imageData = await readFile(imagePath);
  const base64 = imageData.toString("base64");
  const prompt = `This is a still frame from a screen recording or screencast.
Identify regions that should be masked when comparing UI changes between frames — specifically:
- Speaker webcams (e.g. Loom circular overlay, Zoom corner box)
- Persistent OS chrome that's not part of the demo (menu bar, dock, taskbar)
- Branded watermarks or persistent overlays
Do NOT include the cursor.

Return ONLY a JSON object, no prose, of the form:
{"mask": [{"label": "<short>", "x": <0-1>, "y": <0-1>, "w": <0-1>, "h": <0-1>}]}
Coordinates are fractions of frame width/height. (0,0) is top-left.
Return {"mask": []} if there's nothing to mask.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Haiku API error ${res.status}: ${errText}`);
  }
  const j = (await res.json()) as { content: { type: string; text?: string }[] };
  const text = j.content.find((c) => c.type === "text")?.text ?? "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`no JSON in Haiku response: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(jsonMatch[0]) as { mask?: MaskRegion[] };
  return (parsed.mask ?? []).map((m) => padRegion(m, 0.15));
};

const main = async () => {
  const args = parseArgs();
  const sourceIsUrl = isUrl(args.input);

  const need = ["ffmpeg", "ffprobe"];
  if (sourceIsUrl) need.push("yt-dlp");
  const missing = need.filter((c) => !which(c));
  if (missing.length) {
    die(
      `Missing on PATH: ${missing.join(", ")}\n` +
        `Add to your nix config (home.packages): ffmpeg yt-dlp whisper-cpp`,
      3,
    );
  }

  let whisper: string | null = null;
  if (args.useWhisper) {
    whisper = whisperBin();
    if (!whisper) {
      console.error("Note: whisper-cli/whisper-cpp not on PATH; will skip transcription if no captions.");
    }
  }

  let title = basename(args.input);
  let slug = slugify(title);
  if (sourceIsUrl) {
    try {
      const info = await ytDlpInfo(args.input);
      title = info.title;
      slug = slugify(info.title);
    } catch {
      // proceed with basename-derived slug
    }
  }
  const dir = args.outputDir || join(tmpdir(), "watch-video", slug);
  await mkdir(dir, { recursive: true });

  let video: string;
  let vttPath: string | null = null;
  if (sourceIsUrl) {
    const dl = await downloadVideo(args.input, dir);
    video = dl.video;
    vttPath = dl.vtt;
    title = dl.title;
    slug = slugify(title);
  } else {
    video = resolve(args.input);
    if (!existsSync(video)) die(`File not found: ${video}`);
  }

  const duration = await ffprobeDuration(video);

  let segments: TranscriptSegment[] = [];
  let transcriptSource: TranscriptSource = "none";
  if (vttPath) {
    segments = parseVtt(await readFile(vttPath, "utf8"));
    if (segments.length) transcriptSource = "captions";
  }
  if (segments.length === 0 && args.useWhisper && whisper) {
    segments = await transcribeWithWhisper(video, dir, args.whisperModel, whisper);
    if (segments.length) transcriptSource = "whisper";
  }

  const framePaths = await extractFrames(video, dir, args.interval);
  const framesDir = join(dir, "frames");

  const allFrames = framePaths.map((p, i) => ({ path: p, timestamp: i * args.interval }));

  let mask: MaskRegion[] = [...args.manualMask];
  let keptFrames = allFrames;
  let droppedCount = 0;

  if (args.dedupe && allFrames.length > 1) {
    const dims = await ffprobeDimensions(allFrames[0]!.path);

    if (args.autoMask) {
      if (!process.env.ANTHROPIC_API_KEY) {
        console.error("Note: --dedupe with auto-mask, but ANTHROPIC_API_KEY not set; proceeding with manual masks only.");
      } else {
        try {
          const sampleIdx = Math.floor(allFrames.length / 2);
          const auto = await identifyMaskRegions(allFrames[sampleIdx]!.path);
          mask.push(...auto);
        } catch (e) {
          console.error(`auto-mask failed (continuing without): ${e instanceof Error ? e.message : e}`);
        }
      }
    }

    try {
      const hashes = await computeFrameHashesSequential(framesDir, FRAME_PATTERN, allFrames.length, mask, dims);
      const keepIndices = dedupeByHash(hashes, args.hashThreshold);
      const dropped = allFrames.filter((_, i) => !keepIndices.has(i));
      droppedCount = dropped.length;
      await Promise.all(dropped.map((f) => rm(f.path).catch(() => {})));
      keptFrames = allFrames.filter((_, i) => keepIndices.has(i));
    } catch (e) {
      console.error(`dedupe failed (keeping all frames): ${e instanceof Error ? e.message : e}`);
    }
  }

  const frames: Frame[] = keptFrames.map((f) => ({
    path: f.path,
    timestamp: f.timestamp,
    spoken_text: findSpoken(segments, f.timestamp),
  }));

  const manifest: Manifest = {
    source: args.input,
    title,
    slug,
    duration_sec: duration,
    transcript_source: transcriptSource,
    whisper_model: transcriptSource === "whisper" ? args.whisperModel : undefined,
    transcript_segments: segments,
    frames,
    mask_regions: mask,
    dropped_frame_count: droppedCount,
  };
  const manifestPath = join(dir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  // Clean up intermediate artifacts; transcript is in the manifest.
  await Promise.all([
    rm(join(dir, "_audio.wav"), { force: true }),
    rm(join(dir, "_whisper.json"), { force: true }),
  ]);

  console.log(
    JSON.stringify({
      manifest: manifestPath,
      frames_dir: framesDir,
      frame_count: frames.length,
      dropped_frame_count: droppedCount,
      transcript_source: transcriptSource,
      duration_sec: duration,
      title,
      slug,
      output_dir: dir,
      mask_regions: mask,
    }),
  );
};

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
