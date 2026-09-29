/** Exact, result-bound observations from native host tool hooks. */
import { recordHarnessConfiguration } from '../stats/config.js';
import { recordToolObservation } from '../stats/store.js';

const MARKER = /^\[graft\] invocation_id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\r?$/gim;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function textParts(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((part) => {
    if (typeof part === 'string') return [part];
    const item = object(part);
    return item && (item.type === undefined || item.type === 'text') && typeof item.text === 'string' ? [item.text] : [];
  });
  const item = object(value);
  return item && typeof item.text === 'string' ? [item.text] : [];
}

/** A marker must occupy a whole line. Ambiguous results cannot identify one call. */
export function invocationIdFromTexts(texts: string[]): string | null {
  const ids = new Set<string>();
  for (const text of texts) {
    if (text.length > 2_000_000) return null;
    for (const match of text.matchAll(MARKER)) ids.add(match[1].toLowerCase());
  }
  return ids.size === 1 ? [...ids][0] : null;
}

function graftCall(tool: unknown, command: unknown, host: 'gemini-cli' | 'opencode'): boolean {
  if (typeof tool !== 'string') return false;
  if (host === 'gemini-cli' && /^mcp_graft_[a-z0-9_]+$/i.test(tool)) return true;
  if (host === 'opencode' && /^graft_[a-z0-9_]+$/i.test(tool)) return true;
  const shell = host === 'gemini-cli' ? 'run_shell_command' : 'bash';
  return tool === shell && typeof command === 'string'
    && /^\s*(?:[^\s/]+\/)*graft(?:\s|$)/.test(command);
}

interface NativeToolResult {
  host: 'gemini-cli' | 'opencode';
  tool: unknown;
  command?: unknown;
  texts: string[];
  repo?: unknown;
  sessionId?: unknown;
  toolUseId?: unknown;
  home?: string;
}

async function observe(result: NativeToolResult): Promise<string | null> {
  if (!graftCall(result.tool, result.command, result.host)) return null;
  const invocationId = invocationIdFromTexts(result.texts);
  if (!invocationId) return null;
  // Neither host's documented tool-result event includes the active model or
  // effort. A session-level model event cannot safely identify this tool call.
  const configSnapshotId = await recordHarnessConfiguration(result.host, {}, result.home, {});
  await recordToolObservation({
    host: result.host, kind: 'graft', invocationId,
    repo: typeof result.repo === 'string' ? result.repo : undefined,
    sessionId: typeof result.sessionId === 'string' ? result.sessionId : undefined,
    toolUseId: typeof result.toolUseId === 'string' ? result.toolUseId : undefined,
    metadataSource: 'host-payload', configSnapshotId: configSnapshotId ?? undefined,
    // Savings live only on the authoritative invocation fact.
  }, result.home);
  return invocationId;
}

/** Gemini CLI AfterTool: tool_response.llmContent / returnDisplay. */
export async function observeGeminiAfterTool(input: unknown, home?: string): Promise<string | null> {
  const event = object(input);
  if (!event || event.hook_event_name !== 'AfterTool') return null;
  const response = object(event.tool_response);
  if (!response) return null;
  const toolInput = object(event.tool_input);
  return observe({ host: 'gemini-cli', tool: event.tool_name, command: toolInput?.command,
    texts: [...textParts(response.llmContent), ...textParts(response.returnDisplay)],
    repo: event.cwd, sessionId: event.session_id, home });
}

/** OpenCode V1 tool.execute.after: output.output or raw MCP content[]. */
export async function observeOpenCodeAfterTool(input: unknown, output: unknown, repo?: string, home?: string): Promise<string | null> {
  const event = object(input);
  const response = object(output);
  if (!event || !response) return null;
  const args = object(event.args);
  return observe({ host: 'opencode', tool: event.tool, command: args?.command,
    texts: [...textParts(response.output), ...textParts(response.content)],
    repo, sessionId: event.sessionID, toolUseId: event.callID, home });
}

async function readHookPayload(): Promise<unknown> {
  try {
    let raw = '';
    for await (const chunk of process.stdin) {
      raw += chunk.toString();
      if (raw.length > 2_000_000) break;
    }
    return raw.length <= 2_000_000 ? JSON.parse(raw) : null;
  } catch { return null; }
}

/** Gemini's command hook protocol requires JSON-only stdout and exit 0. */
export async function mainGeminiHook(): Promise<void> {
  try { await observeGeminiAfterTool(await readHookPayload()); }
  catch { /* Statistics must not interrupt the host. */ }
  process.stdout.write('{}\n');
}

/** Stable subprocess entry for a machine-wide OpenCode V1 plugin. */
export async function mainOpenCodeHook(): Promise<void> {
  try {
    const payload = object(await readHookPayload());
    if (payload) await observeOpenCodeAfterTool(payload.input, payload.output,
      typeof payload.repo === 'string' ? payload.repo : undefined);
  } catch { /* Statistics must not interrupt the host. */ }
  process.stdout.write('{}\n');
}
