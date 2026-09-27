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
        assert.equal(input.items[0].prior?.value, "old keep meaning");
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
      return [{ key: input.items[0].key, action: "reuse" }];
    } },
  });
  const result = await second.init(repo);
  assert.equal(calls, 0);
  assert.equal(result.reused, 1);
});
