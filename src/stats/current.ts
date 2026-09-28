/** Per-process observation shared by CLI renderers and the post-action hook. */
export interface CurrentInvocation {
  repo?: string;
  startedAt: number;
  savedTokens: number;
  baselineTokens?: number;
  outputTokens?: number;
  sourceFiles?: number;
}

let current: CurrentInvocation | null = null;

export function beginInvocation(repo?: string): void {
  current = { repo, startedAt: Date.now(), savedTokens: 0 };
}

export function setInvocationRepo(repo: string): void {
  if (current) current.repo = repo;
  else beginInvocation(repo);
}

/** A command can render only one savings headline; keep the largest exact one. */
export function noteSavings(observation: {
  savedTokens: number; baselineTokens: number; outputTokens: number; sourceFiles: number;
}): void {
  if (!current || observation.savedTokens < current.savedTokens) return;
  current.savedTokens = observation.savedTokens;
  current.baselineTokens = observation.baselineTokens;
  current.outputTokens = observation.outputTokens;
  current.sourceFiles = observation.sourceFiles;
}

export function takeInvocation(): CurrentInvocation | null {
  const taken = current;
  current = null;
  return taken;
}
