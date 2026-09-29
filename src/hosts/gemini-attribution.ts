/** Gemini CLI native AfterTool attribution.
 * Contract: https://geminicli.com/docs/hooks/reference/
 * Project hooks live in .gemini/settings.json. The event supplies the actual
 * tool_response but no documented model, effort, turn, or tool-use ID.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { geminiAttributionShim } from './attribution-loader.js';
import { readJsonObject, writeOwned, type ConfigWrite } from './config-write.js';
import type { PlannedWrite } from './plan.js';

const shimPath = (repo: string) => join(repo, '.gemini', 'hooks', 'graft-attribution.mjs');
const settingsPath = (repo: string) => join(repo, '.gemini', 'settings.json');

export function geminiAttributionTargets(repo: string): PlannedWrite[] {
  return [
    { hostId: 'gemini', id: 'gemini-attribution-shim', path: shimPath(repo), scope: 'repo', kind: 'hook', what: 'AfterTool attribution adapter' },
    { hostId: 'gemini', id: 'gemini-attribution-settings', path: settingsPath(repo), scope: 'repo', kind: 'hook', what: 'AfterTool hook registration' },
  ];
}

/** Keep foreign commands even if a user placed them in Graft's hook group. */
export function withoutGeminiAttributionHooks(entries: unknown[]): unknown[] {
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [entry];
    const group = entry as Record<string, unknown>;
    if (!Array.isArray(group.hooks)) return [entry];
    const kept = group.hooks.filter((hook: unknown) => {
      if (!hook || typeof hook !== 'object' || Array.isArray(hook)) return true;
      const candidate = hook as Record<string, unknown>;
      return candidate.type !== 'command' || typeof candidate.command !== 'string'
        || !candidate.command.includes('graft-attribution.mjs');
    });
    if (kept.length === group.hooks.length) return [entry];
    return kept.length > 0 ? [{ ...group, hooks: kept }] : [];
  });
}

export function installGeminiAttribution(repo: string): ConfigWrite[] {
  const shim = writeOwned('gemini-attribution-shim', shimPath(repo), geminiAttributionShim());
  const path = settingsPath(repo);
  const skipped: ConfigWrite = { id: 'gemini-attribution-settings', path, action: 'skipped-unparseable' };
  const loaded = readJsonObject(path);
  if (loaded === 'unparseable') return [shim, skipped];
  const { root, existed } = loaded;
  const before = JSON.stringify(root);
  const hooks = (root.hooks ??= {});
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return [shim, skipped];
  if (hooks.AfterTool !== undefined && !Array.isArray(hooks.AfterTool)) return [shim, skipped];
  const prior: unknown[] = hooks.AfterTool ?? [];
  hooks.AfterTool = [
    ...withoutGeminiAttributionHooks(prior),
    {
      matcher: 'mcp_graft_.*|run_shell_command',
      hooks: [{ name: 'graft-attribution', type: 'command', command: `node "${shimPath(repo)}"`, timeout: 8000 }],
    },
  ];
  if (JSON.stringify(root) === before) return [shim, { id: 'gemini-attribution-settings', path, action: 'unchanged' }];
  writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`);
  return [shim, { id: 'gemini-attribution-settings', path, action: existed ? 'updated' : 'created' }];
}
