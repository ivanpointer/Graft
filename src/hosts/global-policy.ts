/**
 * Whether Graft should manage user-level agent configuration.
 *
 * Declarative configuration managers can own those files instead by exporting
 * `GRAFT_NO_GLOBAL_WIRING=1`. Repo-local instructions, hooks, and MCP entries
 * are still installed; this only applies the same boundary as `init --no-global`.
 */
export function globalWiringAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.GRAFT_NO_GLOBAL_WIRING;
  return value === undefined || value === "" || value === "0" || value === "false";
}
