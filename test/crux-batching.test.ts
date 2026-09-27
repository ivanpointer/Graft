/** Regression coverage for symbol-dense files exceeding one model response. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatCruxSummarizer, type NodeRef } from "../src/ai/crux.js";
import type { ChatModel, ChatRequest, ChatResponse } from "../src/ai/llm/types.js";

class BoundedModel implements ChatModel {
  readonly label = "fake:bounded-output";
  requests: ChatRequest[] = [];

  async create(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(req);
    const prompt = req.messages.find((message) => message.role === "user")?.content ?? "";
    const targets = [...prompt.matchAll(/^- id=(.*?) \| .*? \| lines L(\d+)-L(\d+)/gm)];
    assert.ok(targets.length <= 64, `one response was asked for ${targets.length} symbols`);
    const code = prompt.split("\n\nTARGETS", 1)[0] ?? "";
    for (const target of targets) {
      assert.match(code, new RegExp(`(?:^|\\n)${target[2]}\\t`), `source omitted target ${target[1]}`);
    }
    return {
      text: "",
      toolCalls: [{
        id: `call-${this.requests.length}`,
        name: "record_symbols",
        args: {
          symbols: targets.map((target) => ({
            id: target[1],
            summary: `purpose of ${target[1]}`,
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

test("dense files are described across bounded calls with source-local windows", async () => {
  const source = Array.from(
    { length: 450 },
    (_, i) => `export const value${i + 1} = ${i + 1}; ${"x".repeat(180)}`,
  ).join("\n");
  const nodes: NodeRef[] = Array.from({ length: 150 }, (_, i) => {
    const line = i * 3 + 1;
    return {
      id: `src/generated.ts#value${line}`,
      kind: "constant",
      signature: `value${line}`,
      startLine: line,
      endLine: line,
    };
  });
  const model = new BoundedModel();
  const out = await new ChatCruxSummarizer(model).describeFile({
    path: "src/generated.ts",
    source,
    nodes,
  });

  assert.ok(model.requests.length > 3, "source-window pressure should split before the symbol cap alone");
  assert.equal(out.length, nodes.length);
  assert.deepEqual(out.map((result) => result.id), nodes.map((node) => node.id));
  for (const request of model.requests) assert.equal(request.maxTokens, 8192);
});

test("small files still use one model call", async () => {
  const model = new BoundedModel();
  const nodes: NodeRef[] = Array.from({ length: 5 }, (_, i) => ({
    id: `src/small.ts#value${i + 1}`,
    kind: "constant",
    signature: null,
    startLine: i + 1,
    endLine: i + 1,
  }));
  const out = await new ChatCruxSummarizer(model).describeFile({
    path: "src/small.ts",
    source: nodes.map((_, i) => `export const value${i + 1} = ${i + 1};`).join("\n"),
    nodes,
  });

  assert.equal(model.requests.length, 1);
  assert.equal(out.length, nodes.length);
});
