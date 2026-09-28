import type { DeepBuildChangeContext, DeepBuildSourceWindow } from "./decisions.js";

/** Keep router evidence bounded even when the cached source is large. */
const CHANGE_CONTEXT_LINES = 3;
const CHANGE_CONTEXT_CHAR_BUDGET = 12_000;
/** Bound exact line-diff work; larger changed regions fall back to one hunk. */
const MAX_DIFF_CELLS = 4_000_000;

interface ChangedRange {
  previousStart: number;
  previousEnd: number;
  currentStart: number;
  currentEnd: number;
}

function sourceLines(source: string): string[] {
  if (!source) return [];
  const lines = source.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function sourceWindow(lines: readonly string[], start: number, end: number): DeepBuildSourceWindow {
  return {
    startLine: start + 1,
    lineCount: end - start,
    code: lines.slice(start, end).join("\n"),
  };
}

function oneChangedRange(
  previousLines: readonly string[],
  currentLines: readonly string[],
  prefix: number,
  suffix: number,
): ChangedRange[] {
  return [{
    previousStart: prefix,
    previousEnd: previousLines.length - suffix,
    currentStart: prefix,
    currentEnd: currentLines.length - suffix,
  }];
}

/** Exact LCS-backed changed ranges for a bounded middle region. */
function changedRanges(
  previousLines: readonly string[],
  currentLines: readonly string[],
  prefix: number,
  suffix: number,
): ChangedRange[] {
  const previousEnd = previousLines.length - suffix;
  const currentEnd = currentLines.length - suffix;
  const previous = previousLines.slice(prefix, previousEnd);
  const current = currentLines.slice(prefix, currentEnd);
  const rows = previous.length + 1;
  const columns = current.length + 1;
  if (rows * columns > MAX_DIFF_CELLS) {
    return oneChangedRange(previousLines, currentLines, prefix, suffix);
  }

  let lcs: Uint32Array;
  try {
    lcs = new Uint32Array(rows * columns);
  } catch {
    return oneChangedRange(previousLines, currentLines, prefix, suffix);
  }
  for (let previousIndex = previous.length - 1; previousIndex >= 0; previousIndex--) {
    for (let currentIndex = current.length - 1; currentIndex >= 0; currentIndex--) {
      const offset = previousIndex * columns + currentIndex;
      lcs[offset] = previous[previousIndex] === current[currentIndex]
        ? lcs[(previousIndex + 1) * columns + currentIndex + 1]! + 1
        : Math.max(
            lcs[(previousIndex + 1) * columns + currentIndex]!,
            lcs[previousIndex * columns + currentIndex + 1]!,
          );
    }
  }

  const ranges: ChangedRange[] = [];
  let previousIndex = 0;
  let currentIndex = 0;
  let active: ChangedRange | undefined;
  const begin = (): ChangedRange => active ??= {
    previousStart: prefix + previousIndex,
    previousEnd: prefix + previousIndex,
    currentStart: prefix + currentIndex,
    currentEnd: prefix + currentIndex,
  };
  const finish = (): void => {
    if (!active) return;
    ranges.push(active);
    active = undefined;
  };

  while (previousIndex < previous.length || currentIndex < current.length) {
    if (
      previousIndex < previous.length &&
      currentIndex < current.length &&
      previous[previousIndex] === current[currentIndex]
    ) {
      finish();
      previousIndex++;
      currentIndex++;
      continue;
    }
    const range = begin();
    if (
      currentIndex >= current.length ||
      (previousIndex < previous.length &&
        lcs[(previousIndex + 1) * columns + currentIndex]! >=
          lcs[previousIndex * columns + currentIndex + 1]!)
    ) {
      previousIndex++;
      range.previousEnd = prefix + previousIndex;
    } else {
      currentIndex++;
      range.currentEnd = prefix + currentIndex;
    }
  }
  finish();
  return ranges;
}

function expandAndMerge(
  ranges: readonly ChangedRange[],
  previousLineCount: number,
  currentLineCount: number,
): ChangedRange[] {
  const expanded = ranges.map((range) => ({
    previousStart: Math.max(0, range.previousStart - CHANGE_CONTEXT_LINES),
    previousEnd: Math.min(previousLineCount, range.previousEnd + CHANGE_CONTEXT_LINES),
    currentStart: Math.max(0, range.currentStart - CHANGE_CONTEXT_LINES),
    currentEnd: Math.min(currentLineCount, range.currentEnd + CHANGE_CONTEXT_LINES),
  }));
  const merged: ChangedRange[] = [];
  for (const range of expanded) {
    const prior = merged[merged.length - 1];
    if (
      prior &&
      (range.previousStart <= prior.previousEnd || range.currentStart <= prior.currentEnd)
    ) {
      prior.previousEnd = Math.max(prior.previousEnd, range.previousEnd);
      prior.currentEnd = Math.max(prior.currentEnd, range.currentEnd);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * Build bounded hunks containing every changed line. Distant unchanged regions
 * are omitted; if even the complete hunk set exceeds the disclosure budget,
 * omit it instead of presenting a misleading partial diff.
 */
export function completeLineChangeContext(
  previousSource: string,
  currentSource: string,
): DeepBuildChangeContext | undefined {
  if (previousSource === currentSource) return undefined;
  const previousLines = sourceLines(previousSource);
  const currentLines = sourceLines(currentSource);
  let prefix = 0;
  while (
    prefix < previousLines.length &&
    prefix < currentLines.length &&
    previousLines[prefix] === currentLines[prefix]
  ) prefix++;

  let suffix = 0;
  while (
    suffix < previousLines.length - prefix &&
    suffix < currentLines.length - prefix &&
    previousLines[previousLines.length - 1 - suffix] === currentLines[currentLines.length - 1 - suffix]
  ) suffix++;

  const ranges = expandAndMerge(
    changedRanges(previousLines, currentLines, prefix, suffix),
    previousLines.length,
    currentLines.length,
  );
  if (ranges.length === 0) return undefined;
  const context: DeepBuildChangeContext = {
    kind: "complete-line-hunks-v1",
    hunks: ranges.map((range) => ({
      previous: sourceWindow(previousLines, range.previousStart, range.previousEnd),
      current: sourceWindow(currentLines, range.currentStart, range.currentEnd),
    })),
  };
  return JSON.stringify(context).length <= CHANGE_CONTEXT_CHAR_BUDGET ? context : undefined;
}
