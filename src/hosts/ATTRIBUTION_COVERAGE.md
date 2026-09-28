# Native attribution coverage

Graft records saved tokens once, on the CLI or MCP invocation. A host adapter
adds a tool observation only when the actual tool result contains one standalone
`[graft] invocation_id=<uuid>` line. Observations carry no additional savings.

| Host | Native result used | Confirmed join fields | Model / effort in confirmed report |
| --- | --- | --- | --- |
| Gemini CLI | `AfterTool.tool_response.llmContent` or `returnDisplay` from a Graft MCP or CLI tool call | Graft invocation ID; `session_id`; `cwd` | `unknown` / `unknown` |
| OpenCode 1.18.x (V1 plugin) | `tool.execute.after` output string or raw MCP text content | Graft invocation ID; `sessionID`; `callID`; project directory | `unknown` / `unknown` |
| Instruction-only hosts | Graft's own invocation fact | Graft invocation ID only | `unknown` / `unknown` |

Gemini's documented `BeforeModel.llm_request.model` is a separate model event.
`AfterTool` does not document a request ID, turn ID, or tool-use ID that joins it
to that event. Session identity and event timing are insufficient if calls run
concurrently or a model falls back. The adapter therefore does not read
`BeforeModel` or assign its model to a tool observation. No Gemini effort field
is established for the observed tool call.

OpenCode V1's `tool.execute.after` provides `sessionID` and `callID`, but no
active model or effort. Model-related hooks do not share `callID` with that
tool event. The adapter records the exact invocation and call ID while keeping
model and effort unknown. OpenCode V2 has a different plugin API and is not
wired by this V1 adapter.

The adapters do not read transcripts, global model settings, or host names as
proxies for active model or effort. They write `domain='harness'` snapshots with
unknown dimensions, so the confirmed model/effort report cannot suggest a
model that was not established for that invocation. A future adapter can fill
those dimensions only after a native per-tool field or a stable request/tool ID
proves the join.

Contracts checked on 2026-09-28:

- Gemini CLI [hooks reference](https://geminicli.com/docs/hooks/reference/) and [configuration](https://geminicli.com/docs/reference/configuration/).
- OpenCode [V1 plugin documentation](https://opencode.ai/docs/plugins/) and [typed V1 hook API](https://github.com/anomalyco/opencode/blob/dev/packages/plugin/src/index.ts).
- OpenCode [V2 plugin documentation](https://opencode.ai/v2/docs/build/plugins) for the separate V2 contract.
