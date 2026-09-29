/**
 * The Context Graph Engine.
 *
 * Two operations, no database:
 *   - {@link Graft.init}  build `.context/` from a code repo.
 *   - {@link Graft.check} report whether `.context/` is still in
 *     sync with the code (for CI).
 *
 * The graph is a folder of linked markdown files committed to the repo; git is
 * the sync. This class wires the configured LLM provider into the build/check
 * pipelines; an API key is required for any LLM-backed operation.
 */
import { resolveConfig, type EngineConfig, type ResolvedConfig } from "./ai/providers.js";
import { ChatSynthesizer, type Synthesizer } from "./ai/synthesize.js";
import { ChatSummarizer, type Summarizer } from "./ai/summarize.js";
import { ChatCruxSummarizer, type CruxSummarizer } from "./ai/crux.js";
import { createChatModel } from "./ai/llm/factory.js";
import type { ChatModel } from "./ai/llm/types.js";
import { buildContext, CODE_EXTENSIONS, type BuildProgress, type BuildResult } from "./context/build.js";
import { checkContext, type CheckResult } from "./context/check.js";
import { buildGraph, type GraphBuildOptions, type GraphBuildResult } from "./graph/build.js";
import { checkGraph, type GraphCheckResult } from "./graph/check.js";
import { ask, askWithReranker, type AskResult } from "./ask/ask.js";
import {
  SelectingCruxSummarizer,
  ValidatingCruxSummarizer,
  ValidatingSummarizer,
  ValidatingSynthesizer,
} from "./ai/decisions.js";

export { CODE_EXTENSIONS };
export type { BuildResult, BuildProgress, CheckResult, GraphBuildResult, GraphCheckResult, AskResult };

export interface InitOptions {
  /** Code extensions to include. Default: {@link CODE_EXTENSIONS}. */
  extensions?: string[];
  /** Repo-relative directory prefixes to limit the concept pass (`--only-dir`). */
  onlyDirs?: string[];
  /** Progress callback for long builds. */
  onProgress?: (info: BuildProgress) => void;
}

export interface CheckRunOptions {
  extensions?: string[];
}

export interface GraphRunOptions {
  /** Run the Tier-2 LLM meaning pass (summary + crux). Absent → Tier-1 only. */
  llm?: boolean;
  /** Max files summarized in parallel during the LLM pass. */
  concurrency?: number;
  /** Replay unchanged files from the extraction cache (default true). */
  reuse?: boolean;
  /** Opt-in compiler-grade LSP edge enrichment (`graft build --lsp`). */
  lsp?: boolean;
  /** Repo-relative directory prefixes to limit the build to (`--only-dir`). */
  onlyDirs?: string[];
  onProgress?: GraphBuildOptions["onProgress"];
}

export class Graft {
  private cfg: ResolvedConfig;

  constructor(config: EngineConfig = {}) {
    this.cfg = resolveConfig(config);
  }

  /** Build the `.context/` graph from the repo at `dir`. */
  async init(dir: string, opts: InitOptions = {}): Promise<BuildResult> {
    return buildContext(dir, {
      contextDir: this.cfg.contextDir,
      extensions: opts.extensions,
      onlyDirs: opts.onlyDirs,
      model: this.modelLabel(),
      summarizer: this.summarizer(),
      synthesizer: this.synthesizer(),
      router: this.cfg.deepBuildRouter,
      onProgress: opts.onProgress,
    });
  }

  /** Report whether the committed `.context/` markdown graph is in sync with the code. */
  check(dir: string, opts: CheckRunOptions = {}): CheckResult {
    return checkContext(dir, { contextDir: this.cfg.contextDir, extensions: opts.extensions });
  }

  /** Report whether the committed `graph.json` is in sync with the code (Tier-1 diff).
   * Async because the breadth tier warms WASM grammars before re-extraction. */
  checkGraph(dir: string): Promise<GraphCheckResult> {
    return checkGraph(dir, { contextDir: this.cfg.contextDir });
  }

  /**
   * Build `.context/graph.json` — a per-symbol code graph from tree-sitter.
   * Tier-1 (structure) always runs; the Tier-2 meaning layer runs only when
   * `opts.llm` is set. Either way the prior meaning layer is preserved.
   */
  graph(dir: string, opts: GraphRunOptions = {}): Promise<GraphBuildResult> {
    return buildGraph(dir, {
      contextDir: this.cfg.contextDir,
      summarizer: opts.llm ? this.cruxSummarizer() : undefined,
      edgeDisambiguator: opts.llm ? this.cfg.edgeDisambiguator : undefined,
      router: opts.llm ? this.cfg.deepBuildRouter : undefined,
      concurrency: opts.concurrency,
      reuse: opts.reuse,
      lsp: opts.lsp,
      onlyDirs: opts.onlyDirs,
      onProgress: opts.onProgress,
    });
  }

  /**
   * Answer a plain-words query from the committed `graft/` graph — the active
   * channel. Deterministic and $0: routes structural queries to the wiring
   * edges and everything else to a lexical rank over concepts + symbols.
   */
  ask(dir: string, query: string, opts: { limit?: number; source?: boolean; full?: boolean; in?: string; graphRank?: boolean } = {}): AskResult {
    return ask(dir, query, {
      contextDir: this.cfg.contextDir,
      limit: opts.limit,
      source: opts.source,
      full: opts.full,
      in: opts.in,
      graphRank: opts.graphRank,
    });
  }

  /**
   * Async query path used when a hook supplies semantic re-ranking. The normal
   * synchronous {@link ask} API remains source-compatible for deterministic use.
   */
  async askWithHooks(
    dir: string,
    query: string,
    opts: { limit?: number; source?: boolean; full?: boolean; in?: string; graphRank?: boolean } = {},
  ): Promise<AskResult> {
    if (!this.cfg.askReranker) return this.ask(dir, query, opts);
    return askWithReranker(dir, query, opts, this.cfg.askReranker);
  }

  private _chatModel?: ChatModel;

  /** The configured transport, or a clear error telling the user how to set a key. */
  private chatModel(): ChatModel {
    if (this.cfg.chatModel) return this.cfg.chatModel;
    if (this._chatModel) return this._chatModel;
    if (!this.cfg.apiKey) {
      throw new Error(
        "No API key. Set GRAFT_API_KEY (and GRAFT_PROVIDER / GRAFT_BASE_URL / GRAFT_MODEL " +
          "for your provider) to build or summarize the graph.",
      );
    }
    this._chatModel = createChatModel({
      provider: this.cfg.provider,
      apiKey: this.cfg.apiKey,
      model: this.cfg.model,
      reasoningEffort: this.cfg.reasoningEffort,
      baseUrl: this.cfg.baseUrl,
      headers: this.cfg.headers,
    });
    return this._chatModel;
  }

  private synthesizer(): Synthesizer {
    const base = this.cfg.synthesizer ?? new ChatSynthesizer(this.chatModel());
    return this.cfg.meaningValidator ? new ValidatingSynthesizer(base, this.cfg.meaningValidator) : base;
  }

  /** Per-node crux summarizer for the code graph's Tier-2 pass. */
  private cruxSummarizer(): CruxSummarizer {
    let summarizer = this.cfg.cruxSummarizer ?? new ChatCruxSummarizer(this.chatModel());
    if (this.cfg.cruxSelector) summarizer = new SelectingCruxSummarizer(summarizer, this.cfg.cruxSelector);
    if (this.cfg.meaningValidator) summarizer = new ValidatingCruxSummarizer(summarizer, this.cfg.meaningValidator);
    return summarizer;
  }

  private summarizer(): Summarizer {
    const base = this.cfg.summarizer ?? new ChatSummarizer(this.chatModel());
    return this.cfg.meaningValidator ? new ValidatingSummarizer(base, this.cfg.meaningValidator) : base;
  }

  /** Human label for the active model, recorded in the manifest. */
  private modelLabel(): string {
    if (this.cfg.chatModel) return this.cfg.chatModel.label;
    if (
      this.cfg.synthesizer || this.cfg.summarizer || this.cfg.cruxSummarizer ||
      this.cfg.cruxSelector || this.cfg.edgeDisambiguator ||
      this.cfg.meaningValidator || this.cfg.deepBuildRouter
    ) return "custom";
    return `${this.cfg.provider}:${this.cfg.model}`;
  }
}
