#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');
const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const BAKED = "/nix/store/kkvgpgwg6nzqf9hxncb3q72pg4chf8n6-nanonets-graft-0.20.0-stats-41f8346/lib/node_modules/@nanonets/graft/dist/claude";

// The dist/claude dir of @nanonets/graft resolved from a base whose node_modules is searched.
function fromPkg(base) {
  try {
    const pkg = require.resolve('@nanonets/graft/package.json', { paths: [base] });
    return path.join(path.dirname(pkg), 'dist', 'claude');
  } catch { return null; }
}

// The global node_modules dir per npm (handles Homebrew/Windows/volta). Queried on demand.
function globalRoot() {
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' }).trim();
    return root || null;
  } catch { return null; /* npm unavailable */ }
}

// Nix's system profile exposes executables but does not merge arbitrary share/
// subdirectories. This tiny companion command prints the package-owned Claude
// asset directory through the stable /run/current-system profile.
function nixClaudeDir() {
  try {
    const dir = execFileSync('/run/current-system/sw/bin/graft-claude-dir', [], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return dir || null;
  } catch { return null; }
}

// The version of the package a dist/claude dir belongs to, or null if unreadable.
function versionOf(distClaude) {
  try {
    return JSON.parse(fs.readFileSync(path.join(distClaude, '..', '..', 'package.json'), 'utf8')).version || null;
  } catch { return null; }
}

// Numeric-dotted compare of the release part; an unreadable version loses to any known one.
function newer(a, b) {
  if (!a) return false;
  if (!b) return true;
  const p = (v) => String(v).split('-')[0].split('.').map((n) => Number(n) || 0);
  const pa = p(a), pb = p(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

// The highest-versioned dir in `dirs` that actually contains `name`, or null.
function best(dirs, name) {
  let bestDir = null, bestVer = null;
  for (const d of dirs) {
    if (!d || !fs.existsSync(path.join(d, name))) continue;
    const v = versionOf(d);
    if (bestDir === null || newer(v, bestVer)) { bestDir = d; bestVer = v; }
  }
  return bestDir;
}

function entry(name) {
  // Nix rotates store paths on every package build. Its current-system locator
  // is stable and must win over a still-present, older baked or npm-global package.
  const nixSystem = nixClaudeDir();
  if (nixSystem && fs.existsSync(path.join(nixSystem, name))) return path.join(nixSystem, name);

  // Cheap candidates first, and only shell out to npm when every one of them misses.
  const cheap = [BAKED, fromPkg(dir), fromPkg(path.join(path.dirname(process.execPath), '..', 'lib'))];
  const hit = best(cheap, name);
  if (hit) return path.join(hit, name);
  const gr = globalRoot();
  const global = gr && path.join(gr, '@nanonets', 'graft', 'dist', 'claude');
  if (global && fs.existsSync(path.join(global, name))) return path.join(global, name);
  return path.join(dir, 'dist', 'claude', name); // last-ditch; import will no-op if absent
}

import(pathToFileURL(entry("hooks.js")).href).then((m) => m.main(process.argv[2])).catch(() => { /* graft unavailable — no-op */ });
