/** Host shims resolve the current installed Graft runtime and fail open. */
import { fileURLToPath } from 'node:url';

const baked = fileURLToPath(new URL('../../dist/hosts/native-attribution.js', import.meta.url));

export interface AttributionLoaderOptions {
  /** Test seam; production embeds the package that ran init. */
  bakedPath?: string;
  /** Test seam; production uses Nix's stable system-profile locator. */
  nixLocator?: { command: string; args?: string[] };
}

function loader(options: AttributionLoaderOptions = {}): string {
  const bakedPath = options.bakedPath ?? baked;
  const nixLocator = options.nixLocator ?? { command: '/run/current-system/sw/bin/graft-claude-dir', args: [] };
  return `
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const BAKED = ${JSON.stringify(bakedPath)};
const NIX_LOCATOR = ${JSON.stringify(nixLocator)};
const loaded = new Map();

function fromPkg(base) {
  try {
    const pkg = require.resolve('@nanonets/graft/package.json', { paths: [base] });
    return join(dirname(pkg), 'dist', 'hosts', 'native-attribution.js');
  } catch { return null; }
}

function nixSystem() {
  try {
    // The stable profile command returns dist/claude; hosts is its sibling.
    const dir = execFileSync(NIX_LOCATOR.command, NIX_LOCATOR.args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    }).trim();
    return dir ? join(dir, '..', 'hosts', 'native-attribution.js') : null;
  } catch { return null; }
}

function globalInstall() {
  try {
    const root = execFileSync('npm', ['root', '-g'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32', timeout: 2000,
    }).trim();
    return root ? join(root, '@nanonets', 'graft', 'dist', 'hosts', 'native-attribution.js') : null;
  } catch { return null; }
}

function versionOf(file) {
  try {
    return JSON.parse(readFileSync(join(dirname(file), '..', '..', 'package.json'), 'utf8')).version || null;
  } catch { return null; }
}

function compareVersions(a, b) {
  if (!a) return b ? -1 : 0;
  if (!b) return 1;
  const parts = (v) => String(v).split('-')[0].split('.').map((n) => Number(n) || 0);
  const left = parts(a), right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] || 0) - (right[i] || 0);
    if (difference) return difference;
  }
  return 0;
}

async function loadGraftAttribution(projectDir) {
  // Nix store paths rotate across rebuilds. The current system profile wins
  // even if an older baked store path still exists or has the same version.
  const system = nixSystem();
  if (system && existsSync(system)) {
    try { return await import(pathToFileURL(system).href); } catch { /* fallback */ }
  }

  // Compare every available install, including npm global. A stale baked path
  // must never prevent a newer global package from being considered. At equal
  // versions prefer project/global installs over the baked fallback.
  const candidates = [
    { file: fromPkg(projectDir), rank: 0 },
    { file: globalInstall(), rank: 1 },
    { file: fromPkg(join(dirname(process.execPath), '..', 'lib')), rank: 2 },
    { file: BAKED, rank: 3 },
  ].filter((candidate) => candidate.file && existsSync(candidate.file));
  candidates.sort((a, b) => compareVersions(versionOf(b.file), versionOf(a.file)) || a.rank - b.rank);
  for (const candidate of candidates) {
    try { return await import(pathToFileURL(candidate.file).href); } catch { /* fallback */ }
  }
  return null;
}

function graftAttribution(projectDir = process.cwd()) {
  const key = projectDir || process.cwd();
  if (!loaded.has(key)) loaded.set(key, loadGraftAttribution(key));
  return loaded.get(key);
}
`;
}

/** Native Gemini command hook; stdout is always a valid, neutral JSON object. */
export function geminiAttributionShim(options: AttributionLoaderOptions = {}): string {
  return `#!/usr/bin/env node\n${loader(options)}\ntry {
  const module = await graftAttribution();
  if (module) await module.mainGeminiHook();
  else process.stdout.write('{}\\n');
} catch { process.stdout.write('{}\\n'); }
`;
}

/** OpenCode 1.18.x V1 plugin. No transcript, args, or result is persisted. */
export function openCodeAttributionPlugin(options: AttributionLoaderOptions = {}): string {
  return `${loader(options)}
export const GraftAttribution = async ({ directory }) => ({
  'tool.execute.after': async (input, output) => {
    try {
      const module = await graftAttribution(directory);
      if (module) await module.observeOpenCodeAfterTool(input, output, directory);
    } catch { /* fail open */ }
  },
});
`;
}
