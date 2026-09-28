/** OpenCode 1.18.x V1 plugin attribution.
 * Plugin location and tool.execute.after are documented at
 * https://opencode.ai/docs/plugins/ and its typed input/output at
 * https://github.com/anomalyco/opencode/blob/dev/packages/plugin/src/index.ts .
 * The hook has sessionID and callID, but no model or effort on this event.
 */
import { join } from 'node:path';
import { openCodeAttributionPlugin } from './attribution-loader.js';
import { writeOwned, type ConfigWrite } from './config-write.js';
import type { PlannedWrite } from './plan.js';

const pluginPath = (repo: string) => join(repo, '.opencode', 'plugins', 'graft-attribution.js');

export function openCodeAttributionTargets(repo: string): PlannedWrite[] {
  return [{ hostId: 'agents', id: 'opencode-attribution-plugin', path: pluginPath(repo), scope: 'repo', kind: 'hook', what: 'tool.execute.after attribution plugin' }];
}

export function installOpenCodeAttribution(repo: string): ConfigWrite[] {
  return [writeOwned('opencode-attribution-plugin', pluginPath(repo), openCodeAttributionPlugin())];
}
