#!/usr/bin/env bun
import { readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  type Manifest,
  type MaskRegion,
  computeFrameHashes,
  dedupeByHash,
  ffprobeDimensions,
  parseMaskRegionArg,
  requireArgValue,
} from "./lib";

const die = (msg: string, code = 1): never => {
  console.error(msg);
  process.exit(code);
};

type Args = {
  manifestPath: string;
  masks: MaskRegion[];
  hashThreshold: number;
};

const parseArgs = (): Args => {
  const argv = process.argv.slice(2);
  let manifestPath = "";
  let hashThreshold = 5;
  const masks: MaskRegion[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--hash-threshold") hashThreshold = parseInt(requireArgValue(argv, ++i, a), 10);
    else if (a === "--mask-region") {
      try {
        masks.push(parseMaskRegionArg(requireArgValue(argv, ++i, a)));
      } catch (e) {
        die((e as Error).message, 2);
      }
    } else if (a === "-h" || a === "--help") {
      console.log(
        "Usage: dedupe-frames.ts <manifest-path>\n" +
          "  [--mask-region \"x,y,w,h[,label]\"]   (fractions 0-1, repeatable)\n" +
          "  [--hash-threshold N]   default 5\n\n" +
          "Operates in place on an existing manifest.json. Removes redundant frames\n" +
          "from disk, merges supplied mask regions with any already in the manifest,\n" +
          "and updates the frames + mask_regions + dropped_frame_count fields.",
      );
      process.exit(0);
    } else if (!a.startsWith("--") && !manifestPath) manifestPath = a;
    else die(`Unknown arg: ${a}`, 2);
  }
  if (!manifestPath) die("Usage: dedupe-frames.ts <manifest-path> [flags]; see --help", 2);
  return { manifestPath, masks, hashThreshold };
};

const main = async () => {
  const args = parseArgs();
  if (!existsSync(args.manifestPath)) die(`Manifest not found: ${args.manifestPath}`);
  const manifest: Manifest = JSON.parse(await readFile(args.manifestPath, "utf8"));

  if (manifest.frames.length === 0) {
    console.log(JSON.stringify({ kept: 0, dropped: 0, mask_regions: args.masks }));
    return;
  }

  const firstFrame = manifest.frames[0]!;
  if (!existsSync(firstFrame.path)) {
    die(`Frame path missing on disk: ${firstFrame.path}\nThe manifest may be from a different machine or already cleaned up.`);
  }

  const dims = await ffprobeDimensions(firstFrame.path);
  const allMasks = [...(manifest.mask_regions ?? []), ...args.masks];
  const paths = manifest.frames.map((f) => f.path);

  const hashes = await computeFrameHashes(paths, allMasks, dims);
  const keepIndices = dedupeByHash(hashes, args.hashThreshold);

  const dropped = manifest.frames.filter((_, i) => !keepIndices.has(i));
  await Promise.all(dropped.map((f) => rm(f.path).catch(() => {})));

  const newFrames = manifest.frames.filter((_, i) => keepIndices.has(i));
  const newManifest: Manifest = {
    ...manifest,
    frames: newFrames,
    mask_regions: allMasks,
    dropped_frame_count: (manifest.dropped_frame_count ?? 0) + dropped.length,
  };
  await writeFile(args.manifestPath, JSON.stringify(newManifest, null, 2));

  console.log(
    JSON.stringify({
      manifest: args.manifestPath,
      kept: newFrames.length,
      dropped: dropped.length,
      mask_regions: allMasks,
    }),
  );
};

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
