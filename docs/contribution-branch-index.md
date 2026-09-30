# Ivan's contribution branch index

This is a fork-only staging map for work preserved on `dogfood/all-in-flight`.
It intentionally does not create a pull request or change any existing pull
request head.

## Independently reviewable branches

| Branch | Scope | Verification |
| --- | --- | --- |
| `contrib/deep-reliability-core` | Crux echoed-ID handling, dense-file batching, and OpenAI compatibility fallback caching. | Targeted crux and LLM-adapter tests. |
| `contrib/agent-hook-cli` | Stable CLI command for the installed agent-hook implementation. | `agent-hook-cli` tests. |
| `contrib/pi-host` | Pi host registration and machine-global MCP planning. | Build plus Pi registry/config/plan tests; three CLI init cases are sandbox-blocked because they read the real Codex config. |
| `contrib/global-wiring-policy` | Let an external manager opt out of Graft's global wiring while retaining repo-local setup. | Global-policy, host-init, and upkeep tests. |
| `contrib/js-yaml-pin` | Pin transitive `js-yaml` to 3.15.2. | Build and lockfile dependency check. |

## Stacked deep-hook work

1. Existing upstream PR #489 (`feat/cli-deep-hooks`) is the parent and remains
   unchanged.
2. `contrib/deep-hooks-followup` adds per-item routing, safe semantic reuse,
   bounded symbol change context, and the related tests.
3. `contrib/deep-routing-cache-followup` depends on the preceding branch and
   adds worktree cache reuse plus routing from preserved source snapshots.

Submit the parent first. After it lands, rebase the follow-up on current
upstream before opening it; then submit the cache follow-up after the first
follow-up.

## Preserved but intentionally not resubmitted

* The closed stats PR #501 and its existing `stats-machine-store` branch remain
  intact. Its `node:sqlite` implementation does not run on Node 20, so a new
  contribution branch must wait for the requested design issue and a
  Node-20-compatible storage decision.
* `.claude/helpers`, `.claude/skills`, and the repository-root `.mcp.json` from
  dogfood are local/dogfooding configuration and are not included in any branch
  above.
* Existing submissions are left alone: Terraform/HCL PR #504, Codex MCP draft
  PR #505, and the incorporated source-window work from PR #274.
* Repository metadata PR #488 is already merged upstream and is excluded.

## Protected refs

`dogfood/all-in-flight` is a protected cumulative runtime branch. This work
only reads it; it must not be rebased, reset, renamed, deleted, or pushed.
