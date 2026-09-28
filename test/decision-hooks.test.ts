import { test } from "node:test";
import assert from "node:assert/strict";
import { Graft } from "../src/engine.js";
import {
  rerankAskResult,
  SelectingCruxSummarizer,
  ValidatingSynthesizer,
} from "../src/ai/decisions.js";
import { disambiguateEdges } from "../src/graph/disambiguate.js";
import { enrichGraph } from "../src/graph/enrich.js";
import { readMeaningSourceCache } from "../src/graph/meaning-source-cache.js";
import type { AskResult } from "../src/ask/ask.js";
import type { NodeV1 } from "../src/graph/types.js";
import { tmpRepo } from "./helpers.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

test("ask reranking accepts only opaque keys and retains omitted baseline hits", async () => {
  const result: AskResult = {
    query: "cache",
    mode: "lexical",
    hits: [
      { kind: "symbol", title: "A", pointer: "a.ts:L1-L2", snippet: "a", score: 2 },
      { kind: "symbol", title: "B", pointer: "b.ts:L1-L2", snippet: "b", score: 1 },
    ],
  };
  const reranked = await rerankAskResult(
    result.query,
    result,
    { async rerank() { return { order: ["unknown", "c1", "c1"] }; } },
    2,
  );
  assert.deepEqual(reranked.hits.map((hit) => hit.title), ["B", "A"]);
});

test("ask reranker can abstain without inventing an empty candidate key", async () => {
  const result: AskResult = {
    query: "missing",
    mode: "lexical",
    hits: [{ kind: "symbol", title: "A", pointer: "a.ts:L1-L2", snippet: "a", score: 1 }],
  };
  const reranked = await rerankAskResult(
    result.query,
    result,
    { async rerank() { return { order: [], abstain: true, reason: "none apply" }; } },
    1,
  );
  assert.equal(reranked.mode, "empty");
  assert.deepEqual(reranked.hits, []);
  assert.equal(reranked.note, "none apply");
});

test("crux selector can replace generated coordinates only with a supplied span", async () => {
  const source = Array.from({ length: 12 }, (_value, index) => `line ${index + 1}`).join("\n");
  const wrapped = new SelectingCruxSummarizer(
    { async describeFile() { return [{ id: "a.ts#run", summary: "runs", crux_start: 2, crux_end: 2 }]; } },
    {
      async select(input) {
        const alternative = input.symbols[0].candidates.find((candidate) => !candidate.proposed)!;
        return [{ symbolKey: input.symbols[0].key, candidateKey: alternative.key }];
      },
    },
  );
  const result = await wrapped.describeFile({
    path: "a.ts",
    source,
    nodes: [{ id: "a.ts#run", kind: "function", signature: "run()", startLine: 1, endLine: 12 }],
  });
  assert.deepEqual([result[0].crux_start, result[0].crux_end], [1, 8]);
});

test("meaning validator filters only explicitly rejected opaque candidates", async () => {
  const wrapped = new ValidatingSynthesizer(
    {
      async synthesize() {
        return [
          { name: "keep", type: "concept", summary: "good", sources: [], links: [] },
          { name: "drop", type: "concept", summary: "bad", sources: [], links: [] },
        ];
      },
    },
    { async validate() { return [{ key: "m1", accept: false }, { key: "invented", accept: false }]; } },
  );
  const result = await wrapped.synthesize([]);
  assert.deepEqual(result.map((node) => node.name), ["keep"]);
});

test("file-summary rejections are quality misses and do not trip the provider failure gate", async () => {
  const repo = tmpRepo("decision-validator");
  for (let index = 0; index < 4; index++) {
    writeFileSync(join(repo, `file-${index}.ts`), `export const value${index} = ${index};\n`);
  }
  const engine = new Graft({
    summarizer: { async summarize() { return "generated summary"; } },
    synthesizer: { async synthesize() { return []; } },
    meaningValidator: {
      async validate(input) {
        return input.candidates.map((candidate) => ({ key: candidate.key, accept: false }));
      },
    },
  });
  const result = await engine.init(repo);
  assert.equal(result.failedFiles, 4);
  assert.equal(result.fatal, undefined);
});

function node(id: string, path: string): NodeV1 {
  const name = id.slice(id.lastIndexOf("#") + 1);
  return {
    id, name, kind: "function", path, span: "L1-L2", signature: `${name}()`,
    exported: true, origin: "ast", body_hash: id, body_text: `function ${name}() {}`,
    summary_state: "pending", summary: null, crux: null,
  };
}

test("edge disambiguator can choose only from deterministic same-name candidates", async () => {
  const nodes = [node("src/caller.ts#run", "src/caller.ts"), node("src/a.ts#save", "src/a.ts"), node("src/b.ts#save", "src/b.ts")];
  const added = await disambiguateEdges(
    nodes,
    [{ source: nodes[0].id, relation: "calls", file: nodes[0].path, name: "save" }],
    [],
    { async choose(input) {
      assert.deepEqual(input.ambiguities[0].candidates.map((candidate) => candidate.key), ["c0", "c1"]);
      return [{ ambiguityKey: input.ambiguities[0].key, candidateKey: "c1" }];
    } },
  );
  assert.deepEqual(added, [{ source: nodes[0].id, target: "src/b.ts#save", relation: "calls", confidence: "semantic" }]);
});

test("deep-build router skips the symbol meaning call without making the build fail", async () => {
  const repo = tmpRepo("decision-route");
  writeFileSync(join(repo, "main.ts"), "export function run() { return 1; }\n");
  let calls = 0;
  const engine = new Graft({
    cruxSummarizer: { async describeFile() { calls++; return []; } },
    deepBuildRouter: { async route(input) {
      assert.equal(input.phase, "symbol-meaning");
      return input.items.map((item) => ({ key: item.key, action: "skip", reason: "fixture" }));
    } },
  });
  const result = await engine.graph(repo, { llm: true, concurrency: 1 });
  assert.equal(calls, 0);
  assert.equal(result.meaning.routedFiles, 1);
  assert.equal(result.meaning.failedFiles, 0);
});

test("deep-build router can reuse one prior symbol while recomputing another", async () => {
  const path = "main.ts";
  const source = "export function keep() { return 1; }\nexport function refresh() { return 2; }\n";
  const current = [node(`${path}#keep`, path), node(`${path}#refresh`, path)];
  current[0].span = "L1-L1";
  current[0].body_hash = "keep-new";
  current[1].span = "L2-L2";
  current[1].body_hash = "refresh-new";
  const previous = current.map((value, index): NodeV1 => ({
    ...value,
    body_hash: index === 0 ? "keep-old" : "refresh-old",
    summary_state: "ready",
    summary: index === 0 ? "old keep meaning" : "old refresh meaning",
  }));
  let calls = 0;
  const stats = await enrichGraph(
    current,
    new Map(previous.map((value) => [value.id, value])),
    new Map([[path, source]]),
    {
      concurrency: 1,
      router: { async route(input) {
        assert.equal(input.items.length, 2);
        assert.equal(input.capabilities?.symbolMeaningReuse, "exact-crux-remap");
        assert.equal(input.items[0].prior?.value, "old keep meaning");
        assert.equal(input.items[0].prior?.crux, null);
        return input.items.map((item) => ({ key: item.key, action: item.key === "s0" ? "reuse" : "process" }));
      } },
      summarizer: { async describeFile(input) {
        calls++;
        assert.deepEqual(input.nodes.map((value) => value.id), [`${path}#refresh`]);
        return [{ id: `${path}#refresh`, summary: "new refresh meaning", crux_start: 2, crux_end: 2 }];
      } },
    },
  );
  assert.equal(calls, 1);
  assert.equal(stats.reused, 1);
  assert.equal(stats.computed, 1);
  assert.equal(current[0].summary, "old keep meaning");
  assert.equal(current[1].summary, "new refresh meaning");
});

test("deep-build router remaps an unchanged crux after lines shift", async () => {
  const path = "main.ts";
  const source = "// inserted comment\r\nexport function keep() {\r\n  return stable();\r\n}\r\n";
  const current = [node(`${path}#keep`, path)];
  current[0].span = "L2-L4";
  current[0].body_hash = "keep-new";
  const previous: NodeV1 = {
    ...current[0], body_hash: "keep-old", summary_state: "ready", summary: "old meaning",
    crux: { code: "  return stable();", span: "L2-L2" },
  };
  let calls = 0;
  const stats = await enrichGraph(current, new Map([[previous.id, previous]]), new Map([[path, source]]), {
    concurrency: 1,
    router: { async route(input) {
      assert.deepEqual(input.items[0].prior?.crux, { code: "  return stable();\r", span: "L3-L3" });
      return [{ key: "s0", action: "reuse" }];
    } },
    summarizer: { async describeFile() { calls++; return []; } },
  });
  assert.equal(calls, 0);
  assert.equal(stats.reused, 1);
  assert.deepEqual(current[0].crux, { code: "  return stable();\r", span: "L3-L3" });
});

test("deep-build router receives complete bounded symbol changes from a hash-matched source snapshot", async () => {
  const path = "main.ts";
  const previousSource = "export function keep() {\n  // old explanation\n  return stable();\n}\n";
  const source = "export function keep() {\n  // clearer explanation\n  return stable();\n}\n";
  const current = [node(`${path}#keep`, path)];
  current[0].span = "L1-L4";
  current[0].body_hash = "symbol-new";
  const previous: NodeV1 = {
    ...current[0], body_hash: "symbol-old", summary_state: "ready", summary: "Returns the stable result.",
    crux: { code: "  return stable();", span: "L3-L3" },
  };
  const priorFile: NodeV1 = {
    ...node(path, path), id: path, name: path, kind: "file", span: "L1-L4", signature: null,
    body_hash: "file-old", summary_state: "ready", summary: "Contains keep.",
  };
  let calls = 0;
  const stats = await enrichGraph(
    current,
    new Map([[previous.id, previous], [priorFile.id, priorFile]]),
    new Map([[path, source]]),
    {
      concurrency: 1,
      priorSources: new Map([[path, { hash: "file-old", source: previousSource }]]),
      router: { async route(input) {
        assert.deepEqual(input.capabilities, {
          symbolMeaningReuse: "exact-crux-remap",
          symbolMeaningChangeContext: "complete-line-hunks-v1",
        });
        assert.deepEqual(input.items[0].change, {
          kind: "complete-line-hunks-v1",
          hunks: [{
            previous: { startLine: 1, lineCount: 4, code: previousSource.trimEnd() },
            current: { startLine: 1, lineCount: 4, code: source.trimEnd() },
          }],
        });
        assert.deepEqual(input.items[0].prior?.crux, { code: "  return stable();", span: "L3-L3" });
        return [{ key: "s0", action: "reuse" }];
      } },
      summarizer: { async describeFile() { calls++; return []; } },
    },
  );

  assert.equal(calls, 0);
  assert.equal(stats.reused, 1);
  assert.equal(current[0].summary, "Returns the stable result.");
});

test("deep-build router ignores a symbol source snapshot that does not match the prior file hash", async () => {
  const path = "main.ts";
  const source = "export function keep() { return stable(); }\n";
  const current = [node(`${path}#keep`, path)];
  current[0].span = "L1-L1";
  current[0].body_hash = "symbol-new";
  const previous: NodeV1 = {
    ...current[0], body_hash: "symbol-old", summary_state: "ready", summary: "Returns the stable result.", crux: null,
  };
  const priorFile: NodeV1 = {
    ...node(path, path), id: path, name: path, kind: "file", span: "L1-L1", signature: null,
    body_hash: "trusted-file-hash", summary_state: "ready", summary: "Contains keep.",
  };
  await enrichGraph(
    current,
    new Map([[previous.id, previous], [priorFile.id, priorFile]]),
    new Map([[path, source]]),
    {
      concurrency: 1,
      priorSources: new Map([[path, { hash: "stale-sidecar-hash", source: "untrusted old source" }]]),
      router: { async route(input) {
        assert.deepEqual(input.capabilities, { symbolMeaningReuse: "exact-crux-remap" });
        assert.equal(input.items[0].change, undefined);
        return [{ key: "s0", action: "reuse" }];
      } },
      summarizer: { async describeFile() { throw new Error("should reuse through the legacy path"); } },
    },
  );
  assert.equal(current[0].summary_state, "ready");
});

test("graph builds persist exact meaning sources for the next bounded symbol route", async () => {
  const repo = tmpRepo("decision-route-symbol-source-cache");
  const file = join(repo, "main.ts");
  writeFileSync(file, "export const label = 'stable';\nexport function keep() {\n  // old explanation\n  return stable();\n}\n");
  await new Graft({
    cruxSummarizer: { async describeFile(input) {
      return input.nodes.map((ref) => ({
        id: ref.id,
        summary: `Meaning for ${ref.id}`,
        crux_start: Math.min(ref.endLine, 4),
        crux_end: Math.min(ref.endLine, 4),
      }));
    } },
  }).graph(repo, { llm: true, concurrency: 1 });

  const cached = readMeaningSourceCache(join(repo, "graft"));
  assert.match(cached.files["main.ts"]?.source ?? "", /old explanation/);
  writeFileSync(file, "export const label = 'stable';\nexport function keep() {\n  // clearer explanation\n  return stable();\n}\n");

  let summarizeCalls = 0;
  let sawFunctionDelta = false;
  const result = await new Graft({
    deepBuildRouter: { async route(input) {
      assert.equal(input.capabilities?.symbolMeaningChangeContext, "complete-line-hunks-v1");
      for (const item of input.items) {
        if (!item.source.startsWith("export function keep")) continue;
        sawFunctionDelta = true;
        assert.match(item.change?.hunks[0]?.previous.code ?? "", /old explanation/);
        assert.match(item.change?.hunks[0]?.current.code ?? "", /clearer explanation/);
      }
      return input.items.map((item) => ({ key: item.key, action: "reuse" }));
    } },
    cruxSummarizer: { async describeFile() { summarizeCalls++; return []; } },
  }).graph(repo, { llm: true, concurrency: 1 });

  assert.equal(sawFunctionDelta, true);
  assert.equal(summarizeCalls, 0);
  assert.ok(result.meaning.reused >= 1);
  assert.match(readMeaningSourceCache(join(repo, "graft")).files["main.ts"]?.source ?? "", /clearer explanation/);
});

test("deep-build router cannot reuse a prior meaning when its crux changed", async () => {
  const path = "main.ts";
  const source = "export function keep() {\n  return fresh();\n}\n";
  const current = [node(`${path}#keep`, path)];
  current[0].span = "L1-L3";
  current[0].body_hash = "keep-new";
  const previous: NodeV1 = {
    ...current[0], body_hash: "keep-old", summary_state: "ready", summary: "old meaning",
    crux: { code: "  return stale();", span: "L2-L2" },
  };
  let calls = 0;
  const stats = await enrichGraph(current, new Map([[previous.id, previous]]), new Map([[path, source]]), {
    concurrency: 1,
    router: { async route(input) {
      assert.equal(input.items[0].prior, undefined);
      return [{ key: "s0", action: "reuse" }];
    } },
    summarizer: { async describeFile() {
      calls++;
      return [{ id: `${path}#keep`, summary: "fresh meaning", crux_start: 2, crux_end: 2 }];
    } },
  });
  assert.equal(calls, 1);
  assert.equal(stats.reused, 0);
  assert.equal(stats.reuseDeclined, 1);
  assert.equal(stats.computed, 1);
  assert.equal(current[0].summary, "fresh meaning");
});

test("deep-build router cannot reuse an ambiguous prior crux", async () => {
  const path = "main.ts";
  const source = "export function keep() {\n  audit();\n  audit();\n}\n";
  const current = [node(`${path}#keep`, path)];
  current[0].span = "L1-L4";
  current[0].body_hash = "keep-new";
  const previous: NodeV1 = {
    ...current[0], body_hash: "keep-old", summary_state: "ready", summary: "old meaning",
    crux: { code: "  audit();", span: "L2-L2" },
  };
  let calls = 0;
  const stats = await enrichGraph(current, new Map([[previous.id, previous]]), new Map([[path, source]]), {
    concurrency: 1,
    router: { async route(input) {
      assert.equal(input.items[0].prior, undefined);
      return [{ key: "s0", action: "reuse" }];
    } },
    summarizer: { async describeFile() {
      calls++;
      return [{ id: `${path}#keep`, summary: "fresh meaning", crux_start: 2, crux_end: 2 }];
    } },
  });
  assert.equal(calls, 1);
  assert.equal(stats.reused, 0);
  assert.equal(stats.reuseDeclined, 1);
  assert.equal(stats.computed, 1);
});

test("deep-build router cannot turn a reuse decision without any eligible prior into a cache hit", async () => {
  const path = "main.ts";
  const source = "export function newMeaning() { return 1; }\n";
  const current = [node(`${path}#newMeaning`, path)];
  current[0].span = "L1-L1";
  let calls = 0;
  const stats = await enrichGraph(current, new Map(), new Map([[path, source]]), {
    concurrency: 1,
    router: { async route(input) {
      assert.equal(input.items[0].prior, undefined);
      return [{ key: "s0", action: "reuse" }];
    } },
    summarizer: { async describeFile() {
      calls++;
      return [{ id: `${path}#newMeaning`, summary: "new meaning", crux_start: 0, crux_end: 0 }];
    } },
  });
  assert.equal(calls, 1);
  assert.equal(stats.reused, 0);
  assert.equal(stats.reuseDeclined, 1);
  assert.equal(stats.computed, 1);
  assert.equal(current[0].summary, "new meaning");
});

test("deep-build router withholds malformed cruxes and blank summaries from reuse", async () => {
  const path = "main.ts";
  const source = "export function malformed() { return 1; }\nexport function blank() { return 2; }\n";
  const current = [node(`${path}#malformed`, path), node(`${path}#blank`, path)];
  current[0].span = "L1-L1";
  current[1].span = "L2-L2";
  const malformed: NodeV1 = {
    ...current[0], body_hash: "old-malformed", summary_state: "ready", summary: "old meaning",
    crux: { code: 7, span: "L1-L1" } as unknown as NodeV1["crux"],
  };
  const blank: NodeV1 = {
    ...current[1], body_hash: "old-blank", summary_state: "ready", summary: "   ", crux: null,
  };
  let calls = 0;
  const stats = await enrichGraph(current, new Map([[malformed.id, malformed], [blank.id, blank]]), new Map([[path, source]]), {
    concurrency: 1,
    router: { async route(input) {
      assert.equal(input.items[0].prior, undefined);
      assert.equal(input.items[1].prior, undefined);
      return input.items.map((item) => ({ key: item.key, action: "reuse" }));
    } },
    summarizer: { async describeFile(input) {
      calls++;
      return input.nodes.map((value, index) => ({
        id: value.id, summary: `fresh ${index}`, crux_start: 0, crux_end: 0,
      }));
    } },
  });
  assert.equal(calls, 1);
  assert.equal(stats.reused, 0);
  assert.equal(stats.reuseDeclined, 2);
  assert.equal(stats.computed, 2);
});

test("deep-build router exceptions fail open to the normal crux pass", async () => {
  const path = "main.ts";
  const source = "export function run() { return 1; }\n";
  const current = [node(`${path}#run`, path)];
  current[0].span = "L1-L1";
  let calls = 0;
  const stats = await enrichGraph(current, new Map(), new Map([[path, source]]), {
    concurrency: 1,
    router: { async route() { throw new Error("decision service unavailable"); } },
    summarizer: { async describeFile() {
      calls++;
      return [{ id: `${path}#run`, summary: "fresh", crux_start: 0, crux_end: 0 }];
    } },
  });
  assert.equal(calls, 1);
  assert.equal(stats.computed, 1);
});

test("deep-build router non-array output fails open to the normal crux pass", async () => {
  const path = "main.ts";
  const source = "export function run() { return 1; }\n";
  const current = [node(`${path}#run`, path)];
  current[0].span = "L1-L1";
  let calls = 0;
  const stats = await enrichGraph(current, new Map(), new Map([[path, source]]), {
    concurrency: 1,
    router: { async route() { return { action: "reuse" } as never; } },
    summarizer: { async describeFile() {
      calls++;
      return [{ id: `${path}#run`, summary: "fresh", crux_start: 0, crux_end: 0 }];
    } },
  });
  assert.equal(calls, 1);
  assert.equal(stats.computed, 1);
});

test("file-summary router failures and malformed output fail open", async () => {
  for (const [label, router] of [
    ["throws", { async route() { throw new Error("decision service unavailable"); } }],
    ["returns non-array", { async route() { return { action: "reuse" } as never; } }],
  ] as const) {
    const repo = tmpRepo(`decision-route-file-${label}`);
    const file = join(repo, "main.ts");
    writeFileSync(file, "export const value = 1;\n");
    await new Graft({
      summarizer: { async summarize() { return "old summary"; } },
      synthesizer: { async synthesize() { return []; } },
    }).init(repo);
    writeFileSync(file, "export const value = 2;\n");
    let calls = 0;
    const result = await new Graft({
      summarizer: { async summarize() { calls++; return "fresh summary"; } },
      synthesizer: { async synthesize() { return []; } },
      deepBuildRouter: router,
    }).init(repo);
    assert.equal(calls, 1, label);
    assert.equal(result.summarized, 1, label);
    assert.equal(result.reused, 0, label);
  }
});

test("deep-build router can reuse a prior file summary after its source changes", async () => {
  const repo = tmpRepo("decision-route-summary");
  const file = join(repo, "main.ts");
  writeFileSync(file, "export const value = 1;\n");
  const first = new Graft({
    summarizer: { async summarize() { return "stable meaning"; } },
    synthesizer: { async synthesize() { return []; } },
  });
  await first.init(repo);

  writeFileSync(file, "export const value = 2;\n");
  let calls = 0;
  const second = new Graft({
    summarizer: { async summarize() { calls++; return "unexpected"; } },
    synthesizer: { async synthesize() { return []; } },
    deepBuildRouter: { async route(input) {
      assert.equal(input.phase, "file-summary");
      assert.equal(input.items[0].prior?.value, "stable meaning");
      assert.deepEqual(input.capabilities, {
        fileSummaryChangeContext: "complete-line-hunks-v1",
      });
      assert.deepEqual(input.items[0].change, {
        kind: "complete-line-hunks-v1",
        hunks: [{
          previous: { startLine: 1, lineCount: 1, code: "export const value = 1;" },
          current: { startLine: 1, lineCount: 1, code: "export const value = 2;" },
        }],
      });
      return [{ key: input.items[0].key, action: "reuse" }];
    } },
  });
  const result = await second.init(repo);
  assert.equal(calls, 0);
  assert.equal(result.reused, 1);
});

test("file-summary router withholds incomplete change hunks", async () => {
  const repo = tmpRepo("decision-route-summary-large-change");
  const file = join(repo, "main.ts");
  writeFileSync(file, `export const payload = ${JSON.stringify("a".repeat(13_000))};\n`);
  await new Graft({
    summarizer: { async summarize() { return "old payload"; } },
    synthesizer: { async synthesize() { return []; } },
  }).init(repo);

  writeFileSync(file, `export const payload = ${JSON.stringify("b".repeat(13_000))};\n`);
  let summarized = 0;
  const result = await new Graft({
    summarizer: { async summarize() { summarized++; return "new payload"; } },
    synthesizer: { async synthesize() { return []; } },
    deepBuildRouter: { async route(input) {
      assert.equal(input.items[0].change, undefined);
      assert.deepEqual(input.capabilities, {
        fileSummaryChangeContext: "complete-line-hunks-v1",
      });
      return [{ key: input.items[0].key, action: "process" }];
    } },
  }).init(repo);

  assert.equal(summarized, 1);
  assert.equal(result.reused, 0);
});
