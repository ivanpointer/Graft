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
| `contrib/nix-claude-shim-resolution` | Resolve the current Nix Graft package and its assets through the system profile. | Claude shim-template tests. |

## Stacked deep-hook work

1. The preserved fork branch from closed upstream PR #489
   (`feat/cli-deep-hooks`) is the parent and remains unchanged.
2. `contrib/deep-hooks-followup` adds per-item routing, safe semantic reuse,
   bounded symbol change context, and the related tests.
3. `contrib/deep-routing-cache-followup` depends on the preceding branch and
   adds worktree cache reuse plus routing from preserved source snapshots.

This is a dependency chain only, not a submission recommendation: the parent
must land before its two follow-ups can be made independent of it.

## Node-22 stats work in progress

`wip/node22-stats-store-core` is a fork-only, explicitly Node-22-dependent
forward port of the reviewable storage core from closed PR #501. It contains
machine-local invocation recording, optional history backup, local-only storage,
and the session-column migration. Its manifest retains `node >=22.5.0` because
it uses `node:sqlite`; it is not submission-ready for upstream's Node 20 floor.

The remaining original stats commits are preserved on `stats-machine-store` and
`dogfood/all-in-flight`, with these real boundaries:

| Area | Original commits | Depends on |
| --- | --- | --- |
| Unified fact schema and session instrumentation | `dad0ec2`, `39a4f58` | Node-22 store core; it touches the current Claude hook lifecycle, MCP tools, and telemetry sessions. |
| Configuration and invocation attribution | `410dc44` through `61aa123` | Unified fact schema and session instrumentation. |
| Graph-build performance facts and CLI report | `ef8a773`, `aaa5da5` | Unified fact schema (schema migration 8), then the stats CLI wiring. |
| Gemini/OpenCode and native host adapters | `f83714f` through `f9a0d76` | Invocation attribution, exact invocation IDs, and host lifecycle wiring. |

The exact design decision needed before these can become upstream-ready is the
maintainer-requested Node-20-compatible local-storage strategy: either select a
Node-20-compatible store or explicitly adopt a higher supported Node floor and
align CI. Forward-porting the later fact-schema commits before that decision
would also overwrite later Trail-hook lifecycle changes, so they remain
preserved rather than force-merged.

## Local-only and already-submitted work

* `.claude/helpers`, `.claude/skills`, and the repository-root `.mcp.json` from
  dogfood are local/dogfooding configuration and are not included in any branch
  above.
* The generated Nix-aware helper refreshes are local-only; the underlying
  portable shim fixes live in `contrib/nix-claude-shim-resolution`.
* PRs #489, #504, and #505 were closed during cleanup after no human maintainer
  activity; their fork branches, including the stacked deep-hook follow-ups,
  remain intact. No replacement PRs were opened.
* The source-window work is already incorporated in PR #274, and repository
  metadata PR #488 is already merged upstream.
* Repository metadata PR #488 is already merged upstream and is excluded.

## Protected refs

`dogfood/all-in-flight` is a protected cumulative runtime branch. This work
only reads it; it must not be rebased, reset, renamed, deleted, or pushed.
