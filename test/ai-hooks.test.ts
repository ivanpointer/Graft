import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { applyHookModule, assertSafePersistedHook } from "../src/ai/hooks.js";
import { readBuildConfig } from "../src/util/state.js";
import { tmpRepo } from "./helpers.js";

function fresh(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("a hook can override one component and leave the others built in", async () => {
  const dir = fresh("graft-hook-");
  const hook = join(dir, "hook.mjs");
  writeFileSync(
    hook,
    `export function cruxSummarizer(ctx) {
      if (ctx.config.model !== "configured-model") throw new Error("missing resolved config");
      return { async describeFile(input) {
        return input.nodes.map((node) => ({ id: node.id, summary: "hooked", crux_start: 0, crux_end: 0 }));
      } };
    }\n`,
  );

  const config = await applyHookModule({ model: "configured-model" }, hook, dir);
  assert.equal(config.chatModel, undefined);
  assert.equal(config.summarizer, undefined);
  assert.equal(config.synthesizer, undefined);
  const result = await config.cruxSummarizer?.describeFile({
    path: "a.ts",
    source: "export const a = 1;",
    nodes: [{ id: "a.ts#a", kind: "constant", signature: "a", startLine: 1, endLine: 1 }],
  });
  assert.equal(result?.[0]?.summary, "hooked");
});

test("a chatModel hook becomes the transport used by default component factories", async () => {
  const dir = fresh("graft-hook-model-");
  const hook = join(dir, "hook.mjs");
  writeFileSync(
    hook,
    `export function chatModel() {
      return { label: "hook:model", async create() {
        return { text: "from hook", toolCalls: [], usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, stopReason: "stop", assistant: { role: "assistant", content: "from hook" } };
      } };
    }
    export function summarizer(ctx) { return ctx.defaults.summarizer(); }\n`,
  );

  const config = await applyHookModule({}, hook, dir);
  assert.equal(config.chatModel?.label, "hook:model");
  assert.equal(await config.summarizer?.summarize("code", { path: "a.ts" }), "from hook");
});

test("persisted hooks must be absolute and outside the indexed repository", () => {
  const repo = fresh("graft-hook-repo-");
  const outside = fresh("graft-hook-user-");
  const externalHook = join(outside, "hook.mjs");
  writeFileSync(externalHook, "export {};\n");
  mkdirSync(join(repo, "tools"));
  const repoHook = join(repo, "tools", "hook.mjs");
  writeFileSync(repoHook, "export {};\n");

  assert.equal(assertSafePersistedHook(repo, externalHook), realpathSync(externalHook));
  assert.throws(() => assertSafePersistedHook(repo, "./tools/hook.mjs"), /repo-relative hook/);
  assert.throws(() => assertSafePersistedHook(repo, repoHook), /inside the indexed repository/);
});

test("the CLI runs a fully hooked deep build without an API key and persists the selection", () => {
  const repo = tmpRepo("hook-cli");
  writeFileSync(join(repo, "main.ts"), "export function run() { return 1; }\n");
  const hookDir = fresh("graft-hook-cli-module-");
  const hook = join(hookDir, "hook.mjs");
  writeFileSync(
    hook,
    `export function summarizer() { return { async summarize() { return "custom file summary"; } }; }
     export function synthesizer() { return { async synthesize(files) { return [{ name: "Custom", type: "system", summary: "custom concept", sources: files.map((file) => file.path), links: [] }]; } }; }
     export function cruxSummarizer() { return { async describeFile(input) { return input.nodes.map((node) => ({ id: node.id, summary: "custom symbol", crux_start: 0, crux_end: 0 })); } }; }\n`,
  );
  const env = {
    ...process.env,
    CI: "1",
    GRAFT_API_KEY: "",
    OPENROUTER_API_KEY: "",
    ORCAROUTER_API_KEY: "",
  };

  const stdout = execFileSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "--hook", hook, "build", repo, "--deep", "-j", "1"],
    { cwd: process.cwd(), env, encoding: "utf8" },
  );

  assert.match(stdout, /✓ concepts:/);
  assert.match(stdout, /meaning: \d+ computed/);
  assert.equal(readBuildConfig(repo)?.hooks, hook);
});
