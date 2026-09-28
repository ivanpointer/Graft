/**
 * Exact per-file source snapshots for evaluating changed symbol meanings.
 *
 * `wiring.json` intentionally excludes source bodies. This regenerable,
 * gitignored sidecar keeps one prior copy per file instead, so a router can see
 * bounded old/new evidence without bloating the public graph artifact.
 */
import { join } from "node:path";
import { CACHE_DIR } from "../context/node-file.js";
import { readJson, writeJsonAtomic } from "../util/state.js";

const CACHE_VERSION = 1;
export const MEANING_SOURCE_CACHE_FILE = "meaning-sources.json";

export interface MeaningSourceEntry {
  /** Hash of the complete file source, matching the file node's body_hash. */
  hash: string;
  source: string;
}

export interface MeaningSourceCache {
  version: number;
  files: Record<string, MeaningSourceEntry>;
}

export function emptyMeaningSourceCache(): MeaningSourceCache {
  return { version: CACHE_VERSION, files: {} };
}

export function meaningSourceCachePath(outDir: string): string {
  return join(outDir, CACHE_DIR, MEANING_SOURCE_CACHE_FILE);
}

export function readMeaningSourceCache(outDir: string): MeaningSourceCache {
  const cache = readJson<MeaningSourceCache>(meaningSourceCachePath(outDir));
  if (!cache || cache.version !== CACHE_VERSION || !cache.files || typeof cache.files !== "object") {
    return emptyMeaningSourceCache();
  }
  const files: Record<string, MeaningSourceEntry> = {};
  for (const [path, entry] of Object.entries(cache.files)) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.hash !== "string" || typeof entry.source !== "string") continue;
    files[path] = { hash: entry.hash, source: entry.source };
  }
  return { version: CACHE_VERSION, files };
}

/** Best-effort: losing this cache costs reuse, never correctness. */
export function writeMeaningSourceCache(outDir: string, files: Record<string, MeaningSourceEntry>): boolean {
  try {
    writeJsonAtomic(meaningSourceCachePath(outDir), { version: CACHE_VERSION, files }, true);
    return true;
  } catch {
    return false;
  }
}
