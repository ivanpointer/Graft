import type { AskHit, AskResult } from "../ask/ask.js";
import type { FileCruxInput, NodeCrux, NodeRef, CruxSummarizer } from "./crux.js";
import type { FileSummary, SynthNode, Synthesizer } from "./synthesize.js";
import type { Summarizer } from "./summarize.js";
import type { Crux, Kind, Relation } from "../graph/types.js";

export interface DecisionMetadata {
  confidence?: number;
  provider?: string;
  model?: string;
  usage?: Record<string, number>;
}

export interface AskCandidate {
  key: string;
  kind: AskHit["kind"];
  title: string;
  pointer: string;
  snippet: string;
  baselineScore: number;
}

export interface AskRerankInput {
  query: string;
  candidates: readonly AskCandidate[];
  limit: number;
}

export interface AskRerankDecision extends DecisionMetadata {
  /** Opaque candidate keys in preferred order. Unknown and duplicate keys are ignored. */
  order: readonly string[];
  /** Return no hits when the shortlist does not answer the query. */
  abstain?: boolean;
  reason?: string;
}

export interface AskReranker {
  rerank(input: AskRerankInput): Promise<AskRerankDecision>;
}

export interface CruxCandidate {
  key: string;
  startLine: number;
  endLine: number;
  code: string;
  proposed: boolean;
}

export interface SymbolCruxCandidates {
  key: string;
  node: NodeRef;
  summary: string;
  candidates: readonly CruxCandidate[];
}

export interface CruxSelectionInput {
  path: string;
  source: string;
  symbols: readonly SymbolCruxCandidates[];
}

export interface CruxSelection extends DecisionMetadata {
  symbolKey: string;
  /** An opaque candidate key, or null to record that the symbol has no distinct crux. */
  candidateKey: string | null;
}

export interface CruxSelector {
  select(input: CruxSelectionInput): Promise<readonly CruxSelection[]>;
}

export interface EdgeCandidate {
  key: string;
  id: string;
  path: string;
  kind: Kind;
  signature: string | null;
  body?: string;
}

export interface AmbiguousEdge {
  key: string;
  source: { id: string; path: string; signature: string | null; body?: string };
  relation: Relation;
  name: string;
  candidates: readonly EdgeCandidate[];
}

export interface EdgeDisambiguationInput {
  ambiguities: readonly AmbiguousEdge[];
}

export interface EdgeDecision extends DecisionMetadata {
  ambiguityKey: string;
  /** An opaque candidate key, or null to leave the edge unresolved. */
  candidateKey: string | null;
}

export interface EdgeDisambiguator {
  choose(input: EdgeDisambiguationInput): Promise<readonly EdgeDecision[]>;
}

export type MeaningKind = "file-summary" | "symbol-summary" | "concept-node";

export interface MeaningCandidate {
  key: string;
  kind: MeaningKind;
  path?: string;
  source: string;
  value: string;
}

export interface MeaningValidationInput {
  candidates: readonly MeaningCandidate[];
}

export interface MeaningDecision extends DecisionMetadata {
  key: string;
  accept: boolean;
  reason?: string;
}

export interface MeaningValidator {
  validate(input: MeaningValidationInput): Promise<readonly MeaningDecision[]>;
}

export type DeepBuildPhase = "file-summary" | "symbol-meaning";

export interface PriorMeaning {
  contentHash: string;
  value: string;
  /**
   * For a symbol, the excerpt is either absent (`null`) or remapped to the
   * current source before it is exposed to a router. See
   * {@link DeepBuildRouteCapabilities.symbolMeaningReuse}.
   */
  crux?: Crux | null;
}

export interface DeepBuildRouteItem {
  /** Opaque key that identifies the item within this request. */
  key: string;
  source: string;
  contentHash: string;
  /** The last ready meaning, when the source changed since it was produced. */
  prior?: PriorMeaning;
}

/** Optional guarantees made by the caller for a deep-build routing request. */
export interface DeepBuildRouteCapabilities {
  /**
   * A `reuse` decision for a symbol is safe only when its supplied prior has
   * either no crux or a crux whose exact code was found uniquely in the current
   * node span. Its coordinates therefore point into the current file.
   */
  symbolMeaningReuse?: "exact-crux-remap";
}

export interface DeepBuildRouteInput {
  phase: DeepBuildPhase;
  path: string;
  items: readonly DeepBuildRouteItem[];
  /** Capabilities vary by phase; hooks must tolerate their absence. */
  capabilities?: DeepBuildRouteCapabilities;
}

export interface DeepBuildItemDecision extends DecisionMetadata {
  key: string;
  action: "process" | "skip" | "reuse";
  reason?: string;
}

export interface DeepBuildRouter {
  route(input: DeepBuildRouteInput): Promise<readonly DeepBuildItemDecision[]>;
}

export const defaultDecisionHooks = {
  askReranker: (): AskReranker => ({
    async rerank(input) { return { order: input.candidates.map((candidate) => candidate.key) }; },
  }),
  cruxSelector: (): CruxSelector => ({
    async select(input) {
      return input.symbols.map((symbol) => ({
        symbolKey: symbol.key,
        candidateKey: symbol.candidates.find((candidate) => candidate.proposed)?.key ?? null,
      }));
    },
  }),
  edgeDisambiguator: (): EdgeDisambiguator => ({ async choose() { return []; } }),
  meaningValidator: (): MeaningValidator => ({
    async validate(input) { return input.candidates.map((candidate) => ({ key: candidate.key, accept: true })); },
  }),
  deepBuildRouter: (): DeepBuildRouter => ({
    async route(input) { return input.items.map((item) => ({ key: item.key, action: "process" })); },
  }),
};

/** Re-rank a larger deterministic shortlist while retaining every unmentioned hit. */
export async function rerankAskResult(
  query: string,
  result: AskResult,
  reranker: AskReranker,
  limit: number,
): Promise<AskResult> {
  const byKey = new Map<string, AskHit>();
  const candidates = result.hits.map((hit, index): AskCandidate => {
    const key = `c${index}`;
    byKey.set(key, hit);
    return { key, kind: hit.kind, title: hit.title, pointer: hit.pointer, snippet: hit.snippet, baselineScore: hit.score };
  });
  const decision = await reranker.rerank({ query, candidates, limit });
  if (decision.abstain) {
    return {
      ...result,
      mode: "empty",
      hits: [],
      note: decision.reason?.trim() || "semantic reranker found no answer in the candidate shortlist",
    };
  }
  const seen = new Set<string>();
  const hits: AskHit[] = [];
  for (const key of decision.order) {
    const hit = byKey.get(key);
    if (hit && !seen.has(key)) { seen.add(key); hits.push(hit); }
  }
  for (const candidate of candidates) {
    if (seen.has(candidate.key)) continue;
    hits.push(byKey.get(candidate.key)!);
  }
  return { ...result, hits: hits.slice(0, limit) };
}

function cruxCandidates(source: string, node: NodeRef, proposed?: NodeCrux): CruxCandidate[] {
  const lines = source.split("\n");
  const out: CruxCandidate[] = [];
  const seen = new Set<string>();
  const add = (startLine: number, endLine: number, isProposed: boolean): void => {
    const start = Math.max(node.startLine, Math.min(startLine, node.endLine));
    const end = Math.max(start, Math.min(endLine, node.endLine));
    const span = `${start}:${end}`;
    if (seen.has(span)) {
      if (isProposed) {
        const existing = out.find((candidate) => `${candidate.startLine}:${candidate.endLine}` === span);
        if (existing) existing.proposed = true;
      }
      return;
    }
    seen.add(span);
    out.push({ key: `s${out.length}`, startLine: start, endLine: end, code: lines.slice(start - 1, end).join("\n"), proposed: isProposed });
  };
  if (proposed && proposed.crux_start > 0 && proposed.crux_end >= proposed.crux_start) {
    add(proposed.crux_start, proposed.crux_end, true);
  }
  for (let start = node.startLine; start <= node.endLine && out.length < 254; start += 4) {
    add(start, Math.min(start + 7, node.endLine), false);
  }
  return out;
}

export class SelectingCruxSummarizer implements CruxSummarizer {
  constructor(private readonly base: CruxSummarizer, private readonly selector: CruxSelector) {}
  get lastMiss() { return this.base.lastMiss; }
  async describeFile(input: FileCruxInput): Promise<NodeCrux[]> {
    const described = await this.base.describeFile(input);
    const byId = new Map(described.map((item) => [item.id, item]));
    const symbols = input.nodes.map((node, index): SymbolCruxCandidates => {
      const describedNode = byId.get(node.id);
      return {
        key: `n${index}`,
        node,
        summary: describedNode?.summary ?? "",
        candidates: cruxCandidates(input.source, node, describedNode),
      };
    });
    const decisions = await this.selector.select({ path: input.path, source: input.source, symbols });
    const decisionBySymbol = new Map(decisions.map((decision) => [decision.symbolKey, decision]));
    return described.map((item) => {
      const symbol = symbols.find((candidate) => candidate.node.id === item.id);
      if (!symbol) return item;
      const choice = decisionBySymbol.get(symbol.key)?.candidateKey;
      if (choice === undefined) return item;
      if (choice === null) return { ...item, crux_start: 0, crux_end: 0 };
      const candidate = symbol.candidates.find((option) => option.key === choice);
      return candidate ? { ...item, crux_start: candidate.startLine, crux_end: candidate.endLine } : item;
    });
  }
}

async function rejectedKeys(validator: MeaningValidator, candidates: MeaningCandidate[]): Promise<Set<string>> {
  const decisions = await validator.validate({ candidates });
  const valid = new Set(candidates.map((candidate) => candidate.key));
  return new Set(decisions.filter((decision) => valid.has(decision.key) && !decision.accept).map((decision) => decision.key));
}

/** A validator rejection is content quality, not a provider outage. */
export class MeaningRejectedError extends Error {
  constructor(kind: MeaningKind) {
    super(`meaning validator rejected ${kind}`);
    this.name = "MeaningRejectedError";
  }
}

export class ValidatingSummarizer implements Summarizer {
  constructor(private readonly base: Summarizer, private readonly validator: MeaningValidator) {}
  async summarize(code: string, meta: { path: string }): Promise<string> {
    const summary = await this.base.summarize(code, meta);
    const rejected = await rejectedKeys(this.validator, [{ key: "m0", kind: "file-summary", path: meta.path, source: code, value: summary }]);
    if (rejected.has("m0")) throw new MeaningRejectedError("file-summary");
    return summary;
  }
}

export class ValidatingSynthesizer implements Synthesizer {
  constructor(private readonly base: Synthesizer, private readonly validator: MeaningValidator) {}
  async synthesize(files: FileSummary[]): Promise<SynthNode[]> {
    const nodes = await this.base.synthesize(files);
    const source = files.map((file) => `${file.path}\n${file.summary}`).join("\n\n");
    const candidates = nodes.map((node, index): MeaningCandidate => ({ key: `m${index}`, kind: "concept-node", source, value: JSON.stringify(node) }));
    const rejected = await rejectedKeys(this.validator, candidates);
    return nodes.filter((_node, index) => !rejected.has(`m${index}`));
  }
}

export class ValidatingCruxSummarizer implements CruxSummarizer {
  constructor(private readonly base: CruxSummarizer, private readonly validator: MeaningValidator) {}
  get lastMiss() { return this.base.lastMiss; }
  async describeFile(input: FileCruxInput): Promise<NodeCrux[]> {
    const nodes = await this.base.describeFile(input);
    const candidates = nodes.map((node, index): MeaningCandidate => ({ key: `m${index}`, kind: "symbol-summary", path: input.path, source: input.source, value: node.summary }));
    const rejected = await rejectedKeys(this.validator, candidates);
    return nodes.filter((_node, index) => !rejected.has(`m${index}`));
  }
}
