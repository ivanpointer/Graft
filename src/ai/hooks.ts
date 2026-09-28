import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ChatCruxSummarizer, type CruxSummarizer } from "./crux.js";
import { createChatModel } from "./llm/factory.js";
import type { ChatModel } from "./llm/types.js";
import { resolveConfig, type EngineConfig, type ResolvedConfig } from "./providers.js";
import { ChatSummarizer, type Summarizer } from "./summarize.js";
import { ChatSynthesizer, type Synthesizer } from "./synthesize.js";
import {
  defaultDecisionHooks,
  type AskReranker,
  type CruxSelector,
  type DeepBuildRouter,
  type EdgeDisambiguator,
  type MeaningValidator,
} from "./decisions.js";
import { recordConfigurationSnapshot, recordDecisionRun, type DecisionKind } from "../stats/store.js";

export interface HookDefaults {
  chatModel(): ChatModel;
  summarizer(): Summarizer;
  cruxSummarizer(): CruxSummarizer;
  synthesizer(): Synthesizer;
  askReranker(): AskReranker;
  cruxSelector(): CruxSelector;
  edgeDisambiguator(): EdgeDisambiguator;
  meaningValidator(): MeaningValidator;
  deepBuildRouter(): DeepBuildRouter;
}

/** Context passed to every factory exported by a `--hook` module. */
export interface HookContext {
  /** Provider/env/default resolution before hook overrides are applied. */
  config: Readonly<ResolvedConfig>;
  /** Lazy built-ins, so a hook can wrap one without constructing unused transports. */
  defaults: HookDefaults;
}

export interface GraftHookModule {
  /**
   * Safe, declared tuning settings. This is intentionally explicit: Graft
   * never serializes a hook's closure, environment, prompts, or credentials.
   */
  statsConfig?(context: HookContext): HookStatsConfig | Promise<HookStatsConfig>;
  chatModel?(context: HookContext): ChatModel | Promise<ChatModel>;
  summarizer?(context: HookContext): Summarizer | Promise<Summarizer>;
  cruxSummarizer?(context: HookContext): CruxSummarizer | Promise<CruxSummarizer>;
  synthesizer?(context: HookContext): Synthesizer | Promise<Synthesizer>;
  askReranker?(context: HookContext): AskReranker | Promise<AskReranker>;
  cruxSelector?(context: HookContext): CruxSelector | Promise<CruxSelector>;
  edgeDisambiguator?(context: HookContext): EdgeDisambiguator | Promise<EdgeDisambiguator>;
  meaningValidator?(context: HookContext): MeaningValidator | Promise<MeaningValidator>;
  deepBuildRouter?(context: HookContext): DeepBuildRouter | Promise<DeepBuildRouter>;
}

export interface HookStatsConfig {
  name: string;
  schemaVersion: number;
  settings: Record<string, unknown>;
}

interface DecisionObserver {
  repo: string;
  configSnapshotId?: string;
  provider: string;
  model: string;
}

function reportDecision(
  observer: DecisionObserver,
  kind: DecisionKind,
  candidateCount: number,
  startedAt: number,
  items: Parameters<typeof recordDecisionRun>[0]['items'],
  opts: { phase?: string; fallback?: boolean; outcome?: 'ok' | 'error' | 'fallback' } = {},
): void {
  void recordDecisionRun({
    repo: observer.repo, configSnapshotId: observer.configSnapshotId, provider: observer.provider,
    model: observer.model, kind, candidateCount, items, durationMs: Date.now() - startedAt,
    phase: opts.phase, fallback: opts.fallback, outcome: opts.outcome,
  });
}

function observeDecisionHooks(next: EngineConfig, hooks: GraftHookModule, observer: DecisionObserver): void {
  if (hooks.askReranker && next.askReranker) {
    const base = next.askReranker;
    next.askReranker = { async rerank(input) {
      const startedAt = Date.now();
      try {
        const decision = await base.rerank(input);
        reportDecision(observer, 'ask-rerank', input.candidates.length, startedAt, input.candidates.map((candidate, index) => ({
          key: candidate.key, inputRank: index + 1,
          outputRank: decision.abstain ? undefined : (() => { const rank = decision.order.indexOf(candidate.key); return rank < 0 ? undefined : rank + 1; })(),
          action: decision.abstain ? 'abstain' : decision.order.includes(candidate.key) ? 'selected' : 'not-selected',
          confidence: decision.confidence, reasonCode: decision.abstain ? 'abstain' : undefined,
        })));
        return decision;
      } catch (error) {
        reportDecision(observer, 'ask-rerank', input.candidates.length, startedAt, [], { outcome: 'error', fallback: true });
        throw error;
      }
    } };
  }
  if (hooks.cruxSelector && next.cruxSelector) {
    const base = next.cruxSelector;
    next.cruxSelector = { async select(input) {
      const startedAt = Date.now();
      try {
        const decisions = await base.select(input);
        const bySymbol = new Map(decisions.map((decision) => [decision.symbolKey, decision]));
        reportDecision(observer, 'crux-select', input.symbols.reduce((n, symbol) => n + symbol.candidates.length, 0), startedAt,
          input.symbols.map((symbol) => ({ key: symbol.key, action: bySymbol.get(symbol.key)?.candidateKey ?? 'none', confidence: bySymbol.get(symbol.key)?.confidence })));
        return decisions;
      } catch (error) { reportDecision(observer, 'crux-select', input.symbols.length, startedAt, [], { outcome: 'error', fallback: true }); throw error; }
    } };
  }
  if (hooks.edgeDisambiguator && next.edgeDisambiguator) {
    const base = next.edgeDisambiguator;
    next.edgeDisambiguator = { async choose(input) {
      const startedAt = Date.now();
      try {
        const decisions = await base.choose(input);
        const byAmbiguity = new Map(decisions.map((decision) => [decision.ambiguityKey, decision]));
        reportDecision(observer, 'edge-disambiguate', input.ambiguities.reduce((n, ambiguity) => n + ambiguity.candidates.length, 0), startedAt,
          input.ambiguities.map((ambiguity) => ({ key: ambiguity.key, action: byAmbiguity.get(ambiguity.key)?.candidateKey ?? 'unresolved', confidence: byAmbiguity.get(ambiguity.key)?.confidence })));
        return decisions;
      } catch (error) { reportDecision(observer, 'edge-disambiguate', input.ambiguities.length, startedAt, [], { outcome: 'error', fallback: true }); throw error; }
    } };
  }
  if (hooks.meaningValidator && next.meaningValidator) {
    const base = next.meaningValidator;
    next.meaningValidator = { async validate(input) {
      const startedAt = Date.now();
      try {
        const decisions = await base.validate(input);
        const byKey = new Map(decisions.map((decision) => [decision.key, decision]));
        reportDecision(observer, 'meaning-validate', input.candidates.length, startedAt,
          input.candidates.map((candidate) => ({ key: candidate.key, action: byKey.get(candidate.key)?.accept ? 'accept' : 'reject', confidence: byKey.get(candidate.key)?.confidence })));
        return decisions;
      } catch (error) { reportDecision(observer, 'meaning-validate', input.candidates.length, startedAt, [], { outcome: 'error', fallback: true }); throw error; }
    } };
  }
  if (hooks.deepBuildRouter && next.deepBuildRouter) {
    const base = next.deepBuildRouter;
    next.deepBuildRouter = { async route(input) {
      const startedAt = Date.now();
      try {
        const decisions = await base.route(input);
        const byKey = new Map(decisions.map((decision) => [decision.key, decision]));
        reportDecision(observer, 'deep-build-route', input.items.length, startedAt,
          input.items.map((item) => {
            const action = byKey.get(item.key)?.action ?? 'process';
            return { key: item.key, action, confidence: byKey.get(item.key)?.confidence, hasPrior: !!item.prior,
              reuseEligible: !!item.prior && !!input.capabilities?.symbolMeaningReuse,
              reuseApplied: action === 'reuse' };
          }), { phase: input.phase });
        return decisions;
      } catch (error) { reportDecision(observer, 'deep-build-route', input.items.length, startedAt, [], { phase: input.phase, outcome: 'error', fallback: true }); throw error; }
    } };
  }
}

function defaultChatModel(config: ResolvedConfig): ChatModel {
  if (!config.apiKey) {
    throw new Error(
      "the hook requested graft's default model, but no API key is configured; " +
        "set GRAFT_API_KEY or export a chatModel factory",
    );
  }
  return createChatModel({
    provider: config.provider,
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    headers: config.headers,
  });
}

function requireMethod<T>(name: string, value: T, method: keyof T): T {
  if (!value || typeof value[method] !== "function") {
    throw new Error(`hook factory ${name}() did not return an object with ${String(method)}()`);
  }
  return value;
}

/** Load one ESM hook module and layer its exported factories over `config`. */
export async function applyHookModule(
  config: EngineConfig,
  hookPath: string,
  cwd: string,
): Promise<EngineConfig> {
  const absolute = resolve(cwd, hookPath);
  const hooks = (await import(pathToFileURL(absolute).href)) as GraftHookModule;
  const resolved = resolveConfig(config);
  const moduleHash = createHash('sha256').update(readFileSync(absolute)).digest('hex');
  let builtInModel: ChatModel | undefined;
  let effectiveModel = config.chatModel;
  const model = () => {
    if (effectiveModel) return effectiveModel;
    builtInModel ??= defaultChatModel(resolved);
    return builtInModel;
  };
  const context: HookContext = {
    config: resolved,
    defaults: {
      chatModel: () => {
        builtInModel ??= defaultChatModel(resolved);
        return builtInModel;
      },
      summarizer: () => new ChatSummarizer(model()),
      cruxSummarizer: () => new ChatCruxSummarizer(model()),
      synthesizer: () => new ChatSynthesizer(model()),
      askReranker: defaultDecisionHooks.askReranker,
      cruxSelector: defaultDecisionHooks.cruxSelector,
      edgeDisambiguator: defaultDecisionHooks.edgeDisambiguator,
      meaningValidator: defaultDecisionHooks.meaningValidator,
      deepBuildRouter: defaultDecisionHooks.deepBuildRouter,
    },
  };
  const declared = hooks.statsConfig ? await hooks.statsConfig(context) : undefined;

  const next: EngineConfig = { ...config };
  if (hooks.chatModel) {
    effectiveModel = requireMethod("chatModel", await hooks.chatModel(context), "create");
    next.chatModel = effectiveModel;
  }
  if (hooks.summarizer) {
    next.summarizer = requireMethod("summarizer", await hooks.summarizer(context), "summarize");
  }
  if (hooks.cruxSummarizer) {
    next.cruxSummarizer = requireMethod(
      "cruxSummarizer",
      await hooks.cruxSummarizer(context),
      "describeFile",
    );
  }
  if (hooks.synthesizer) {
    next.synthesizer = requireMethod("synthesizer", await hooks.synthesizer(context), "synthesize");
  }
  if (hooks.askReranker) {
    next.askReranker = requireMethod("askReranker", await hooks.askReranker(context), "rerank");
  }
  if (hooks.cruxSelector) {
    next.cruxSelector = requireMethod("cruxSelector", await hooks.cruxSelector(context), "select");
  }
  if (hooks.edgeDisambiguator) {
    next.edgeDisambiguator = requireMethod(
      "edgeDisambiguator",
      await hooks.edgeDisambiguator(context),
      "choose",
    );
  }
  if (hooks.meaningValidator) {
    next.meaningValidator = requireMethod(
      "meaningValidator",
      await hooks.meaningValidator(context),
      "validate",
    );
  }
  if (hooks.deepBuildRouter) {
    next.deepBuildRouter = requireMethod(
      "deepBuildRouter",
      await hooks.deepBuildRouter(context),
      "route",
    );
  }
  const configSnapshotId = await recordConfigurationSnapshot({
    domain: 'jev', schemaVersion: 1,
    settings: {
      module: { sha256: moduleHash, name: declared?.name ?? 'undeclared', schemaVersion: declared?.schemaVersion ?? 0 },
      settingsDeclared: declared?.settings ?? {},
      enabled: ['askReranker', 'cruxSelector', 'edgeDisambiguator', 'meaningValidator', 'deepBuildRouter'].filter((name) => hooks[name as keyof GraftHookModule] !== undefined),
      provider: resolved.provider, model: resolved.model,
    },
  });
  observeDecisionHooks(next, hooks, { repo: cwd, configSnapshotId: configSnapshotId ?? undefined, provider: resolved.provider, model: resolved.model });
  return next;
}

/**
 * A persisted hook runs without a contemporaneous CLI trust decision. Only an
 * absolute module outside the indexed repository is eligible in that case.
 * An explicit `--hook` can still load a repo-local module for that one command.
 */
export function assertSafePersistedHook(repoRoot: string, hookPath: string): string {
  if (!isAbsolute(hookPath)) {
    throw new Error(
      `refusing to auto-load repo-relative hook ${JSON.stringify(hookPath)}; ` +
        "pass --hook with the path to trust it for this build",
    );
  }
  const root = realpathSync(repoRoot);
  const hook = realpathSync(hookPath);
  const fromRoot = relative(root, hook);
  if (fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))) {
    throw new Error(
      `refusing to auto-load hook inside the indexed repository: ${hook}; ` +
        "pass --hook with the path to trust it for this build",
    );
  }
  return hook;
}
