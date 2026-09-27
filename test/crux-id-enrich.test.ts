/** End-to-end regression for binding row-echoed model ids during enrichment. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatCruxSummarizer } from "../src/ai/crux.js";
import { enrichGraph } from "../src/graph/enrich.js";
import type { ChatModel, ChatRequest, ChatResponse } from "../src/ai/llm/types.js";
import type { NodeV1 } from "../src/graph/types.js";

class EchoedTargetModel implements ChatModel {
  readonly label = "fake:echoed-target";

  async create(req: ChatRequest): Promise<ChatResponse> {
    const user = req.messages.find((message) => message.role === "user")?.content ?? "";
    const ids = [...user.matchAll(/^- id=(.*?) \| .*? \| lines L\d+-L\d+/gm)].map(
      (match) => match[1],
    );
    return {
      text: "",
      toolCalls: [{
        id: "echo",
        name: "record_symbols",
        args: {
          symbols: ids.map((id) => ({
            id: `${id} | function | lines L1-L9`,
            summary: `purpose of ${id}`,
            crux_start: 0,
            crux_end: 0,
          })),
        },
      }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
      stopReason: "tool_calls",
      assistant: { role: "assistant", content: "" },
    };
  }
}

function node(id: string, name: string, kind: NodeV1["kind"]): NodeV1 {
  return {
    id,
    name,
    kind,
    path: "src/calc.ts",
    span: "L1-L9",
    signature: kind === "file" ? null : `${name}()`,
    exported: true,
    origin: "ast",
    body_hash: `hash-${name}`,
    summary_state: "pending",
    summary: null,
    crux: null,
  };
}

test("row-echoed ids make every requested node ready", async () => {
  const nodes = [
    node("src/calc.ts", "calc.ts", "file"),
    node("src/calc.ts#sum", "sum", "function"),
    node("src/calc.ts#sum.inner", "inner", "function"),
  ];
  const stats = await enrichGraph(
    nodes,
    new Map(),
    new Map([["src/calc.ts", "export function sum() {\n  return 1;\n}\n"]]),
    { summarizer: new ChatCruxSummarizer(new EchoedTargetModel()), concurrency: 1 },
  );

  assert.equal(stats.computed, nodes.length);
  assert.equal(stats.failedFiles, 0);
  assert.equal(stats.pending, 0);
  for (const n of nodes) {
    assert.equal(n.summary_state, "ready", n.id);
    assert.equal(n.summary, `purpose of ${n.id}`);
  }
});
