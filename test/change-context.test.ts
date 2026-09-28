import assert from "node:assert/strict";
import test from "node:test";
import { completeLineChangeContext } from "../src/ai/change-context.js";

test("complete change context omits distant unchanged source without omitting changes", () => {
  const filler = Array.from(
    { length: 300 },
    (_value, index) => `export const unchanged${index} = ${JSON.stringify(`sentinel-${index}-${"x".repeat(48)}`)};`,
  );
  const previous = ["// header", "const first = 'old';", ...filler, "const second = 'old';", "// footer"];
  const current = ["// header", "const first = 'new';", ...filler, "const second = 'new';", "// footer"];

  const context = completeLineChangeContext(previous.join("\n"), current.join("\n"));

  assert.equal(context?.kind, "complete-line-hunks-v1");
  assert.equal(context?.hunks.length, 2);
  assert.match(context?.hunks[0]?.previous.code ?? "", /first = 'old'/);
  assert.match(context?.hunks[0]?.current.code ?? "", /first = 'new'/);
  assert.match(context?.hunks[1]?.previous.code ?? "", /second = 'old'/);
  assert.match(context?.hunks[1]?.current.code ?? "", /second = 'new'/);
  assert.doesNotMatch(JSON.stringify(context), /sentinel-150-/);
  assert.ok(JSON.stringify(context).length < 12_000);
});

test("complete change context merges nearby edits whose context overlaps", () => {
  const previous = ["a", "old-one", "b", "c", "d", "e", "old-two", "f", "g"];
  const current = ["a", "new-one", "b", "c", "d", "e", "new-two", "f", "g"];

  const context = completeLineChangeContext(previous.join("\n"), current.join("\n"));

  assert.equal(context?.hunks.length, 1);
  assert.match(context?.hunks[0]?.previous.code ?? "", /old-one[\s\S]*old-two/);
  assert.match(context?.hunks[0]?.current.code ?? "", /new-one[\s\S]*new-two/);
});

test("complete change context fails closed when changed lines exceed the budget", () => {
  const previous = `export const payload = ${JSON.stringify("a".repeat(13_000))};`;
  const current = `export const payload = ${JSON.stringify("b".repeat(13_000))};`;

  assert.equal(completeLineChangeContext(previous, current), undefined);
});
