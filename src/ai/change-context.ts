import type { DeepBuildChangeContext, DeepBuildSourceWindow } from "./decisions.js";

/** Keep router evidence bounded even when the cached source is large. */
const CHANGE_CONTEXT_LINES = 3;
const CHANGE_CONTEXT_CHAR_BUDGET = 12_000;

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

/**
 * Build one window containing every changed line. Widely separated changes
 * intentionally include the intervening lines; if that is too large, omit the
 * context instead of presenting a misleading partial diff.
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

  const previousEnd = previousLines.length - suffix;
  const currentEnd = currentLines.length - suffix;
  const previousStart = Math.max(0, prefix - CHANGE_CONTEXT_LINES);
  const currentStart = Math.max(0, prefix - CHANGE_CONTEXT_LINES);
  const context: DeepBuildChangeContext = {
    kind: "complete-line-window-v1",
    previous: sourceWindow(
      previousLines,
      previousStart,
      Math.min(previousLines.length, previousEnd + CHANGE_CONTEXT_LINES),
    ),
    current: sourceWindow(
      currentLines,
      currentStart,
      Math.min(currentLines.length, currentEnd + CHANGE_CONTEXT_LINES),
    ),
  };
  return JSON.stringify(context).length <= CHANGE_CONTEXT_CHAR_BUDGET ? context : undefined;
}
