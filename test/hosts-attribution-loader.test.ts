import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { geminiAttributionShim, openCodeAttributionPlugin, type AttributionLoaderOptions } from '../src/hosts/attribution-loader.js';

const fresh = () => mkdtempSync(join(tmpdir(), 'graft-attribution-loader-'));

function fakeInstall(pkg: string, version: string): string {
  const hosts = join(pkg, 'dist', 'hosts');
  mkdirSync(hosts, { recursive: true });
  mkdirSync(join(pkg, 'dist', 'claude'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@nanonets/graft', version, type: 'module' }));
  writeFileSync(join(hosts, 'native-attribution.js'), `
import { writeFileSync } from 'node:fs';
export async function mainGeminiHook() {
  writeFileSync(process.env.TEST_LOADED, ${JSON.stringify(version)});
  process.stdout.write('{}\\n');
}
export async function observeOpenCodeAfterTool() {
  writeFileSync(process.env.TEST_LOADED, ${JSON.stringify(version)});
}
`);
  return join(hosts, 'native-attribution.js');
}

function globalRoot(prefix: string): string {
  const result = spawnSync('npm', ['root', '-g'], {
    encoding: 'utf8', env: { ...process.env, npm_config_prefix: prefix },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function runGemini(root: string, options: AttributionLoaderOptions, prefix: string): string | null {
  const repo = join(root, 'repo');
  const shim = join(repo, '.gemini', 'hooks', 'graft-attribution.mjs');
  const marker = join(root, 'loaded.txt');
  mkdirSync(join(repo, '.gemini', 'hooks'), { recursive: true });
  writeFileSync(shim, geminiAttributionShim(options));
  const result = spawnSync(process.execPath, [shim], {
    encoding: 'utf8', cwd: repo, input: '{}',
    env: { ...process.env, npm_config_prefix: prefix, TEST_LOADED: marker },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '{}\n');
  return existsSync(marker) ? readFileSync(marker, 'utf8') : null;
}

test('Gemini shim loads upgraded npm global rather than stale baked install', () => {
  const root = fresh();
  const prefix = join(root, 'npm-prefix');
  const stale = fakeInstall(join(root, 'stale'), '1.0.0');
  fakeInstall(join(globalRoot(prefix), '@nanonets', 'graft'), '2.0.0');
  assert.equal(runGemini(root, {
    bakedPath: stale, nixLocator: { command: join(root, 'missing-nix-locator') },
  }, prefix), '2.0.0');
});

test('npm global wins a same-version tie with an old baked build', () => {
  const root = fresh();
  const prefix = join(root, 'npm-prefix');
  const baked = fakeInstall(join(root, 'stale-build'), '2.0.0');
  const current = fakeInstall(join(globalRoot(prefix), '@nanonets', 'graft'), '2.0.0');
  writeFileSync(current, readFileSync(current, 'utf8').replaceAll('2.0.0', 'current-global'));
  assert.equal(runGemini(root, {
    bakedPath: baked, nixLocator: { command: join(root, 'missing-nix-locator') },
  }, prefix), 'current-global');
});

test('current Nix system-profile install wins over still-present baked and npm paths', () => {
  const root = fresh();
  const prefix = join(root, 'npm-prefix');
  const baked = fakeInstall(join(root, 'old-nix-store'), '9.0.0');
  fakeInstall(join(globalRoot(prefix), '@nanonets', 'graft'), '10.0.0');
  const current = join(root, 'current-system');
  fakeInstall(current, '1.0.0');
  const locator = join(root, 'nix-locator.cjs');
  writeFileSync(locator, `process.stdout.write(${JSON.stringify(join(current, 'dist', 'claude'))});\n`);
  assert.equal(runGemini(root, {
    bakedPath: baked, nixLocator: { command: process.execPath, args: [locator] },
  }, prefix), '1.0.0');
});

test('generated host shim includes NixOS and nix-darwin system-profile locators', () => {
  const src = geminiAttributionShim();
  assert.match(src, /\/run\/current-system\/sw\/bin\/graft-claude-dir/);
  assert.match(src, /\/nix\/var\/nix\/profiles\/system\/sw\/bin\/graft-claude-dir/);
});

test('OpenCode plugin uses the project install when it is newer than baked/global', () => {
  const root = fresh();
  const repo = join(root, 'repo');
  const prefix = join(root, 'npm-prefix');
  const baked = fakeInstall(join(root, 'baked'), '1.0.0');
  fakeInstall(join(globalRoot(prefix), '@nanonets', 'graft'), '2.0.0');
  fakeInstall(join(repo, 'node_modules', '@nanonets', 'graft'), '3.0.0');
  mkdirSync(join(repo, '.opencode', 'plugins'), { recursive: true });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ type: 'module' }));
  const plugin = join(repo, '.opencode', 'plugins', 'graft-attribution.js');
  writeFileSync(plugin, openCodeAttributionPlugin({
    bakedPath: baked, nixLocator: { command: join(root, 'missing-nix-locator') },
  }));
  const marker = join(root, 'loaded.txt');
  const script = `import { pathToFileURL } from 'node:url';
const plugin = await import(pathToFileURL(${JSON.stringify(plugin)}).href);
const hooks = await plugin.GraftAttribution({ directory: ${JSON.stringify(repo)} });
await hooks['tool.execute.after']({}, {});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', cwd: root,
    env: { ...process.env, npm_config_prefix: prefix, TEST_LOADED: marker },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(marker, 'utf8'), '3.0.0');
});
