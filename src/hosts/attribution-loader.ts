/** Small host shims load Graft's installed runtime and fail open when absent. */
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const baked = fileURLToPath(new URL('../../dist/hosts/native-attribution.js', import.meta.url));

// Keep a direct path for the installed package that ran init, but also resolve
// upgrades from the consuming project's node_modules or the global npm root.
const loader = `
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
let loaded;
async function loadGraftAttribution() {
  const candidates = [];
  try {
    const pkg = require.resolve('@nanonets/graft/package.json');
    candidates.push(join(dirname(pkg), 'dist', 'hosts', 'native-attribution.js'));
  } catch {}
  candidates.push(${JSON.stringify(baked)});
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try { return await import(pathToFileURL(candidate).href); } catch {}
  }
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim();
    const candidate = join(root, '@nanonets', 'graft', 'dist', 'hosts', 'native-attribution.js');
    if (existsSync(candidate)) return await import(pathToFileURL(candidate).href);
  } catch {}
  return null;
}
function graftAttribution() { return loaded ??= loadGraftAttribution(); }
`;

/** Native Gemini command hook; stdout is always a valid, neutral JSON object. */
export function geminiAttributionShim(): string {
  return `#!/usr/bin/env node\n${loader}\ntry {
  const module = await graftAttribution();
  if (module) await module.mainGeminiHook();
  else process.stdout.write('{}\\n');
} catch { process.stdout.write('{}\\n'); }
`;
}

/** OpenCode 1.18.x V1 plugin. No transcript, args, or result is persisted. */
export function openCodeAttributionPlugin(): string {
  return `${loader}
export const GraftAttribution = async ({ directory }) => ({
  'tool.execute.after': async (input, output) => {
    try {
      const module = await graftAttribution();
      if (module) await module.observeOpenCodeAfterTool(input, output, directory);
    } catch { /* fail open */ }
  },
});
`;
}
