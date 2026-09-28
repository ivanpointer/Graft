/**
 * Secret-free, effective configuration dimensions for machine stats.
 *
 * Facts retain only this content-addressed reference: settings belong in one
 * immutable dimension row, not duplicated across every tool call.
 */
import { resolveConfig, type EngineConfig } from '../ai/providers.js';
import { recordConfigurationSnapshot } from './store.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_SCHEMA_VERSION = 1;

type HarnessDimensions = { provider: string; model: string; reasoningEffort: string };

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256 ? value.trim() : undefined;
}

function payloadDimensions(input: unknown): Partial<HarnessDimensions> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const agent = value.agent && typeof value.agent === 'object' ? value.agent as Record<string, unknown> : {};
  const thinking = value.thinking && typeof value.thinking === 'object' ? value.thinking as Record<string, unknown> : {};
  return {
    provider: text(value.provider) ?? text(agent.provider),
    model: text(value.model) ?? text(value.model_id) ?? text(agent.model),
    reasoningEffort: text(value.reasoning_effort) ?? text(value.model_reasoning_effort)
      ?? text(value.effort) ?? text(agent.reasoning_effort) ?? text(thinking.effort),
  };
}

function codexDimensions(env: NodeJS.ProcessEnv): Partial<HarnessDimensions> {
  try {
    const config = readFileSync(
      env.CODEX_HOME ? join(env.CODEX_HOME, 'config.toml') : join(homedir(), '.codex', 'config.toml'),
      'utf8',
    );
    return {
      provider: 'openai',
      model: text(/^model\s*=\s*"([^"]+)"/m.exec(config)?.[1]),
      reasoningEffort: text(/^model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(config)?.[1]),
    };
  } catch { return {}; }
}

/** Host-scoped metadata only: no shared machine default is ever consulted. */
function harnessDimensions(host: string | undefined, input: unknown, env: NodeJS.ProcessEnv): HarnessDimensions {
  const native = host === 'codex' ? codexDimensions(env) : {};
  const observed = payloadDimensions(input);
  return {
    provider: observed.provider ?? native.provider ?? 'unknown',
    model: observed.model ?? native.model ?? 'unknown',
    reasoningEffort: observed.reasoningEffort ?? native.reasoningEffort ?? 'unknown',
  };
}

/** Record the effective Graft LLM settings used by a CLI or MCP operation. */
export async function recordGraftConfiguration(
  config: EngineConfig = {}, home?: string, env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const resolved = resolveConfig(config);
  const host = env.CODEX_SESSION_ID ? 'codex' : env.CLAUDE_SESSION_ID ? 'claude-code' : env.CURSOR_SESSION_ID ? 'cursor' : undefined;
  const harness = harnessDimensions(host, undefined, env);
  return recordConfigurationSnapshot({
    domain: 'graft',
    schemaVersion: CONFIG_SCHEMA_VERSION,
    settings: {
      provider: resolved.provider,
      model: resolved.model,
      // Absence is a meaningful, stable cohort: the endpoint chose its default.
      reasoningEffort: resolved.reasoningEffort ?? 'provider-default',
      harness,
    },
    dimensions: {
      provider: resolved.provider,
      model: resolved.model,
      reasoningEffort: resolved.reasoningEffort ?? 'provider-default',
      harness,
    },
  }, home);
}

/**
 * Record host identity without guessing its active model or effort. Native
 * adapters will supply those settings when their runtime metadata is available.
 */
export async function recordHarnessConfiguration(
  host: string,
  input?: unknown,
  home?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const harness = harnessDimensions(host, input, env);
  return recordConfigurationSnapshot({
    domain: 'harness',
    schemaVersion: CONFIG_SCHEMA_VERSION,
    settings: { host, ...harness },
    dimensions: { harness: { host, ...harness } },
  }, home);
}
