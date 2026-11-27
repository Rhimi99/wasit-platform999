#!/usr/bin/env node
/**
 * Ensures the bundled ffmpeg (the `ffmpeg-static` package) is present and runs.
 *
 * Why this exists: `npm ci --ignore-scripts` skips the package's postinstall,
 * and npm 12+ blocks dependency install scripts unless each one is approved, so
 * `npm rebuild ffmpeg-static` reports success while leaving the binary missing.
 * Running the package's own installer is deterministic on every npm version and
 * keeps the repository's `--ignore-scripts` supply-chain stance intact.
 *
 * Usage: node scripts/setup-ffmpeg-static.mjs [--force] [--quiet]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const force = process.argv.includes('--force');
const quiet = process.argv.includes('--quiet');
const log = (message) => {
  if (!quiet) console.log(message);
};

function packageDir() {
  const require = createRequire(path.join(repoRoot, 'package.json'));
  try {
    return path.dirname(require.resolve('ffmpeg-static/package.json'));
  } catch {
    // Workspaces hoist to the root; fall back to the local layout.
    const local = path.join(repoRoot, 'node_modules/ffmpeg-static');
    if (existsSync(local)) return local;
    console.error('ffmpeg-static is not installed. Run `npm ci --ignore-scripts` first.');
    process.exit(2);
  }
}

function binaryRuns(binary) {
  if (!existsSync(binary) || !statSync(binary).isFile()) return null;
  try {
    const out = execFileSync(binary, ['-version'], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n')[0].trim();
  } catch {
    return null;
  }
}

const dir = packageDir();
const binary = path.join(dir, 'ffmpeg');

if (!force) {
  const version = binaryRuns(binary);
  if (version) {
    log(`ffmpeg-static ready: ${version}`);
    process.exit(0);
  }
}

log(`ffmpeg-static binary missing at ${binary} — running the package installer`);
try {
  execFileSync(process.execPath, [path.join(dir, 'install.js')], { cwd: dir, stdio: quiet ? 'ignore' : 'inherit', timeout: 900_000 });
} catch (error) {
  console.error(`ffmpeg-static installer failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const version = binaryRuns(binary);
if (!version) {
  console.error(`ffmpeg-static installer finished but ${binary} is missing or not executable.`);
  process.exit(1);
}
log(`ffmpeg-static ready: ${version}`);
