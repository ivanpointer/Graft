/**
 * Secret-free, effective configuration dimensions for machine stats.
 *
 * Facts retain only this content-addressed reference: settings belong in one
 * immutable dimension row, not duplicated across every tool call.
 */
import { resolveConfig, type EngineConfig } from '../ai/providers.js';
import { recordConfigurationSnapshot } from './store.js';

const CONFIG_SCHEMA_VERSION = 1;

type HarnessDimensions = { provider: string; model: string; reasoningEffort: string };

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256 ? value.trim() : undefined;
}

function payloadDimensions(host: string | undefined, input: unknown): Partial<HarnessDimensions> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  if (host === 'codex') return { model: text(value.model) };
  if (host === 'claude-code') {
    const effort = value.effort && typeof value.effort === 'object' && !Array.isArray(value.effort)
      ? value.effort as Record<string, unknown> : {};
    return { model: text(value.model), reasoningEffort: text(effort.level) };
  }
  if (host === 'cursor') {
    const params = Array.isArray(value.model_params) ? value.model_params : [];
    const effort = params.find((item: unknown) => item && typeof item === 'object'
      && (item as Record<string, unknown>).id === 'effort') as Record<string, unknown> | undefined;
    return { model: text(value.model_id) ?? text(value.model), reasoningEffort: text(effort?.value) };
  }
  return {};
}

/** Host-scoped metadata only: no shared machine default is ever consulted. */
export function harnessDimensions(host: string | undefined, input: unknown): HarnessDimensions {
  const observed = payloadDimensions(host, input);
  return {
    provider: observed.provider ?? 'unknown',
    model: observed.model ?? 'unknown',
    reasoningEffort: observed.reasoningEffort ?? 'unknown',
  };
}

/** Record the effective Graft LLM settings used by a CLI or MCP operation. */
export async function recordGraftConfiguration(
  config: EngineConfig = {}, home?: string, env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const resolved = resolveConfig(config);
  const host = text(env.GRAFT_HARNESS_HOST)
    ?? (env.CODEX_SESSION_ID ? 'codex' : env.CLAUDE_SESSION_ID ? 'claude-code' : env.CURSOR_SESSION_ID ? 'cursor' : undefined);
  const harness = harnessDimensions(host, undefined);
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
  const harness = harnessDimensions(host, input);
  return recordConfigurationSnapshot({
    domain: 'harness',
    schemaVersion: CONFIG_SCHEMA_VERSION,
    settings: { host, ...harness },
    dimensions: { harness: { host, ...harness } },
  }, home);
}
