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

function owned(entry: unknown): boolean {
  return JSON.stringify(entry ?? '').includes('graft-attribution.mjs');
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
    ...prior.filter((entry) => !owned(entry)),
    {
      matcher: 'mcp_graft_.*|run_shell_command',
      hooks: [{ name: 'graft-attribution', type: 'command', command: `node "${shimPath(repo)}"`, timeout: 8000 }],
    },
  ];
  if (JSON.stringify(root) === before) return [shim, { id: 'gemini-attribution-settings', path, action: 'unchanged' }];
  writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`);
  return [shim, { id: 'gemini-attribution-settings', path, action: existed ? 'updated' : 'created' }];
}
