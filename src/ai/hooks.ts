import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ChatCruxSummarizer, type CruxSummarizer } from "./crux.js";
import { createChatModel } from "./llm/factory.js";
import type { ChatModel } from "./llm/types.js";
import { resolveConfig, type EngineConfig, type ResolvedConfig } from "./providers.js";
import { ChatSummarizer, type Summarizer } from "./summarize.js";
import { ChatSynthesizer, type Synthesizer } from "./synthesize.js";

export interface HookDefaults {
  chatModel(): ChatModel;
  summarizer(): Summarizer;
  cruxSummarizer(): CruxSummarizer;
  synthesizer(): Synthesizer;
}

/** Context passed to every factory exported by a `--hook` module. */
export interface HookContext {
  /** Provider/env/default resolution before hook overrides are applied. */
  config: Readonly<ResolvedConfig>;
  /** Lazy built-ins, so a hook can wrap one without constructing unused transports. */
  defaults: HookDefaults;
}

export interface GraftHookModule {
  chatModel?(context: HookContext): ChatModel | Promise<ChatModel>;
  summarizer?(context: HookContext): Summarizer | Promise<Summarizer>;
  cruxSummarizer?(context: HookContext): CruxSummarizer | Promise<CruxSummarizer>;
  synthesizer?(context: HookContext): Synthesizer | Promise<Synthesizer>;
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
    },
  };

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
