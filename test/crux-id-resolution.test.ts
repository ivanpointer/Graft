/**
 * A model can read "use the id verbatim" as "echo the full TARGET line".
 * The parser must bind that response only to ids from the request, so the
 * enrichment pass marks every returned symbol ready instead of paying to retry
 * the file and then reporting an empty response.
 */
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
    const ids = [...user.matchAll(/^- id=(.*?) \| .*? \| lines L\d+-L\d+/gm)].map((match) => match[1]);
    return {
      text: "",
      toolCalls: [
        {
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
        },
      ],
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

test("echoed target lines resolve to requested ids and make every node ready", async () => {
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

test("an unrequested returned id is diagnosed and ignored", async () => {
  const model: ChatModel = {
    label: "fake:unknown-id",
    async create(): Promise<ChatResponse> {
      return {
        text: "",
        toolCalls: [{
          id: "unknown",
          name: "record_symbols",
          args: { symbols: [{ id: "src/other.ts#run", summary: "wrong file", crux_start: 0, crux_end: 0 }] },
        }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
        stopReason: "tool_calls",
        assistant: { role: "assistant", content: "" },
      };
    },
  };
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    const out = await new ChatCruxSummarizer(model).describeFile({
      path: "src/calc.ts",
      source: "export function sum() {}\n",
      nodes: [{
        id: "src/calc.ts#sum",
        kind: "function",
        signature: "sum()",
        startLine: 1,
        endLine: 1,
      }],
    });
    assert.deepEqual(out, []);
  } finally {
    console.error = original;
  }
  assert.ok(lines.some((line) => /src\/other\.ts#run/.test(line) && /does not match any requested target/.test(line)));
});

test("a different id that merely starts with a requested id is not mis-bound", async () => {
  const model: ChatModel = {
    label: "fake:prefix-collision",
    async create(): Promise<ChatResponse> {
      return {
        text: "",
        toolCalls: [{
          id: "collision",
          name: "record_symbols",
          args: { symbols: [{ id: "src/calc.ts#summary", summary: "wrong symbol", crux_start: 0, crux_end: 0 }] },
        }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
        stopReason: "tool_calls",
        assistant: { role: "assistant", content: "" },
      };
    },
  };
  const original = console.error;
  console.error = () => {};
  try {
    const out = await new ChatCruxSummarizer(model).describeFile({
      path: "src/calc.ts",
      source: "export function sum() {}\n",
      nodes: [{ id: "src/calc.ts#sum", kind: "function", signature: "sum()", startLine: 1, endLine: 1 }],
    });
    assert.deepEqual(out, []);
  } finally {
    console.error = original;
  }
});
