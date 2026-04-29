import { $ } from "bun";

export type TranscriptSegment = { start: number; end: number; text: string };
export type Frame = { path: string; timestamp: number; spoken_text: string };
export type TranscriptSource = "captions" | "whisper" | "none";
export type MaskRegion = { label: string; x: number; y: number; w: number; h: number };
export type Manifest = {
  source: string;
  title: string;
  slug: string;
  duration_sec: number;
  transcript_source: TranscriptSource;
  whisper_model?: string;
  transcript_segments: TranscriptSegment[];
  frames: Frame[];
  mask_regions: MaskRegion[];
  dropped_frame_count: number;
};

export type Dimensions = { width: number; height: number };

export const ffprobeDimensions = async (file: string): Promise<Dimensions> => {
  const out = await $`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 ${file}`.text();
  const [w = "0", h = "0"] = out.trim().split(",");
  return { width: parseInt(w, 10), height: parseInt(h, 10) };
};

export const padRegion = (m: MaskRegion, pad: number): MaskRegion => {
  const x = Math.max(0, m.x - m.w * pad);
  const y = Math.max(0, m.y - m.h * pad);
  const w = Math.min(1 - x, m.w * (1 + 2 * pad));
  const h = Math.min(1 - y, m.h * (1 + 2 * pad));
  return { label: m.label, x, y, w, h };
};

export const hammingDistance = (a: bigint, b: bigint): number => {
  let x = a ^ b;
  let count = 0;
  while (x !== 0n) {
    if (x & 1n) count++;
    x >>= 1n;
  }
  return count;
};

export const dedupeByHash = (hashes: bigint[], threshold: number): Set<number> => {
  const keep = new Set<number>();
  if (hashes.length === 0) return keep;
  keep.add(0);
  let lastKept = hashes[0]!;
  for (let i = 1; i < hashes.length; i++) {
    if (hammingDistance(hashes[i]!, lastKept) > threshold) {
      keep.add(i);
      lastKept = hashes[i]!;
    }
  }
  return keep;
};

const drawboxesFor = (mask: MaskRegion[], dims: Dimensions): string =>
  mask
    .map((m) => {
      const x = Math.max(0, Math.floor(m.x * dims.width));
      const y = Math.max(0, Math.floor(m.y * dims.height));
      const w = Math.max(1, Math.floor(m.w * dims.width));
      const h = Math.max(1, Math.floor(m.h * dims.height));
      return `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=black:t=fill`;
    })
    .join(",");

const dHashFilter = (mask: MaskRegion[], dims: Dimensions): string => {
  const parts = [drawboxesFor(mask, dims), "scale=9:8", "format=gray"].filter(Boolean);
  return parts.join(",");
};

const dHashFromBytes = (buf: Uint8Array, offset: number): bigint => {
  let hash = 0n;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const left = buf[offset + row * 9 + col]!;
      const right = buf[offset + row * 9 + col + 1]!;
      if (left > right) hash |= 1n << BigInt(row * 8 + col);
    }
  }
  return hash;
};

const FRAME_SIZE = 9 * 8;

export const computeFrameHashesSequential = async (
  framesDir: string,
  pattern: string,
  count: number,
  mask: MaskRegion[],
  dims: Dimensions,
): Promise<bigint[]> => {
  if (count === 0) return [];
  const filter = dHashFilter(mask, dims);
  const inputPath = `${framesDir}/${pattern}`;
  const buf = await $`ffmpeg -loglevel error -start_number 1 -i ${inputPath} -vf ${filter} -f rawvideo -`.bytes();
  if (buf.length < FRAME_SIZE * count) {
    throw new Error(`hash output truncated: got ${buf.length} bytes, expected ${FRAME_SIZE * count}`);
  }
  const hashes: bigint[] = [];
  for (let i = 0; i < count; i++) hashes.push(dHashFromBytes(buf, i * FRAME_SIZE));
  return hashes;
};

const computeFrameHash = async (
  path: string,
  mask: MaskRegion[],
  dims: Dimensions,
): Promise<bigint> => {
  const filter = dHashFilter(mask, dims);
  const buf = await $`ffmpeg -loglevel error -i ${path} -vf ${filter} -f rawvideo -`.bytes();
  return dHashFromBytes(buf, 0);
};

export const computeFrameHashes = async (
  paths: string[],
  mask: MaskRegion[],
  dims: Dimensions,
): Promise<bigint[]> => {
  const BATCH = 8;
  const out: bigint[] = new Array(paths.length);
  for (let i = 0; i < paths.length; i += BATCH) {
    const slice = paths.slice(i, i + BATCH);
    const hashes = await Promise.all(slice.map((p) => computeFrameHash(p, mask, dims)));
    for (let j = 0; j < hashes.length; j++) out[i + j] = hashes[j]!;
  }
  return out;
};

export const parseMaskRegionArg = (raw: string): MaskRegion => {
  const parts = raw.split(",").map((s) => s.trim());
  if (parts.length < 4) throw new Error(`--mask-region expects "x,y,w,h[,label]", got: ${raw}`);
  return {
    x: parseFloat(parts[0]!),
    y: parseFloat(parts[1]!),
    w: parseFloat(parts[2]!),
    h: parseFloat(parts[3]!),
    label: parts[4] || "manual",
  };
};
