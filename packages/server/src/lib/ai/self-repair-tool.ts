import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants as fsConstants } from 'node:fs';
import { cp, lstat, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { requireAction } from '../../lib/ai/agent-run-context.js';

const execFileAsync = promisify(execFile);

/**
 * Isolated self-repair tool for the Development Agent.
 *
 * This is the single, narrow surface through which the agent may touch code. It
 * NEVER writes to the real repository: every operation happens inside a private
 * copy under the OS temp dir, and the caller receives the copy's path so a human
 * can review the diff before anything is applied anywhere.
 *
 * Hard limits (enforced here, not by convention):
 *   - the workspace is a fresh `mkdtemp` directory; the source tree is copied
 *     in and never modified — no `node_modules` symlink into the real tree;
 *   - only files whose repo-relative path is under an allow-listed root AND
 *     carries an allow-listed source extension may be read or patched, so
 *     secrets (`.env`), config, migrations, schema, lockfiles and the `tests/`
 *     tree are unreachable;
 *   - a patch is a single exact, unique string replacement — no regex, no
 *     multi-file, no shell;
 *   - the test runs inside a hardened, disposable container (read-only root, no
 *     network, no capabilities, non-root, no privilege escalation) using a fixed,
 *     generated DB-free vitest config; the caller supplies only an allow-listed
 *     test path, never flags or a shell string;
 *   - the run is FAIL-CLOSED: if the container runtime or the repair image is
 *     unavailable, the test does not run and the result is a failure — `npx` and
 *     `vitest` are never executed on the host;
 *   - success requires the test to have actually run and passed; a failing or
 *     absent test is a failure, never a success.
 */

/** Repo-relative roots the agent may read and patch (source only). */
export const REPAIR_ALLOWED_ROOTS: readonly string[] = ['packages/server/src'];
/** File extensions the agent may read and patch. */
export const REPAIR_ALLOWED_EXTENSIONS: readonly string[] = ['.ts', '.tsx'];
/** Repo-relative roots an allow-listed test file may live under. */
export const REPAIR_ALLOWED_TEST_ROOTS: readonly string[] = ['packages/server/tests'];
/** Hard ceiling on the number of repair attempts for one run. */
export const MAX_REPAIR_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Containerized repair sandbox (PHASE 2U-A)
// ---------------------------------------------------------------------------
//
// The repair test MUST run inside a disposable container that has no writable
// path to the real repository. There is deliberately NO host fallback: if the
// container runtime or the repair image is unavailable, `runRepairTests` fails
// closed rather than executing `npx`/`vitest` against the developer's tree.

/**
 * The image that carries the pre-installed dependency closure (`FROM deps AS
 * repair` in the Dockerfile). It is a fixed name, never caller-supplied.
 */
export const REPAIR_IMAGE = 'wasit-repair-sandbox:local';
/** Fixed in-image root that holds the pre-installed dependency closure. */
export const REPAIR_IMAGE_APP_DIR = '/app';
/**
 * Fixed in-container mount point for the disposable workspace. It is placed
 * *under* {@link REPAIR_IMAGE_APP_DIR} on purpose: Node resolves a bare import
 * (`vitest/config`, `@wasit/shared`, …) by walking up from the importing file, so
 * the workspace's tests reach the image's read-only `/app/node_modules` without
 * any symlink into — or copy of — the host dependency tree.
 */
export const REPAIR_WORKSPACE_MOUNT = `${REPAIR_IMAGE_APP_DIR}/repair-ws`;
/**
 * The only executable the repair path spawns on the host. It is a container
 * runtime, not a test runner: the caller never supplies it, and it is used with
 * a fixed argv. `npx`/`vitest` are never spawned on the host.
 */
export const REPAIR_CONTAINER_RUNTIME = 'docker';
/**
 * Fixed test-runner argv executed *inside* the container (never on the host).
 * It invokes the image's vitest entry point directly (no `npx`, so there is no
 * network or registry resolution), with the generated DB-free config.
 */
export const REPAIR_CONTAINER_TEST_COMMAND: readonly string[] = [
  'node',
  `${REPAIR_IMAGE_APP_DIR}/node_modules/vitest/vitest.mjs`,
  'run',
  '--config',
  'vitest.repair.config.ts',
];
/**
 * The hardening flags for the repair container: root filesystem read-only, no
 * network, no added capabilities, no privilege escalation, non-root user, a
 * bounded writable tmpfs for scratch, and only the disposable workspace mounted
 * writable. Anything added to this list is an explicit reduction of isolation.
 */
export const REPAIR_CONTAINER_FLAGS: readonly string[] = [
  '--rm',
  '--read-only',
  '--network=none',
  '--cap-drop=ALL',
  '--security-opt=no-new-privileges',
  '--user',
  'node',
  '--tmpfs',
  '/tmp:rw,noexec,nosuid,nodev,size=512m',
];
/** Exit code returned when the sandbox cannot be established (fail-closed). */
export const REPAIR_SANDBOX_UNAVAILABLE_EXIT = 125;
/**
 * The environment key that names the container runtime executable. The runtime
 * is *always* invoked as `docker`; this variable only points at the executable,
 * so tests can substitute a stub. It never selects a test runner.
 */
export const REPAIR_RUNTIME_ENV_KEY = 'WASIT_REPAIR_RUNTIME';

/**
 * A fail-closed reason for a refused sandbox run. `code` is a stable, non-secret
 * token safe to surface in an audit record; `message` is a short diagnostic.
 */
export interface RepairSandboxFailure {
  readonly code:
    | 'SANDBOX_RUNTIME_UNAVAILABLE'
    | 'SANDBOX_IMAGE_UNAVAILABLE'
    | 'SANDBOX_RUN_FAILED'
    | 'SANDBOX_TIMEOUT';
  readonly message: string;
}
/** Hard wall-clock ceiling for one test invocation (ms). */
export const REPAIR_TEST_TIMEOUT_MS = 120_000;
/**
 * Hard ceiling on the size (bytes, UTF-8) of the file under repair. A repair is a
 * small, localised fix; a file larger than this is refused before any patch is
 * computed, so a runaway or generated artifact cannot be rewritten wholesale.
 */
export const MAX_REPAIR_FILE_BYTES = 256 * 1024;
/** Hard ceiling on the byte size of a single `replace` (the patch payload). */
export const MAX_REPAIR_REPLACE_BYTES = 64 * 1024;
/**
 * Hard ceiling on the size (bytes, UTF-8) of the proposed change a reviewer is
 * shown inline. A patch within this bound is rendered in full as `before`/`after`
 * plus a diff; a larger patch is not truncated into a misleading "complete"
 * proposal — it is reported as needing separate handling.
 */
export const MAX_REPAIR_DISPLAY_BYTES = 32 * 1024;
/**
 * Hard ceiling on the net line-count change a single patch may introduce
 * (`abs(afterLines - beforeLines)`). Insertions and deletions are bounded
 * together, so a patch cannot balloon the file one line at a time.
 */
export const MAX_REPAIR_LINE_DELTA = 200;

/** The action id this surface is gated by (must be in the run's grant list). */
const REPAIR_ACTION_ID = 'development.propose_patch';

export interface RepairWorkspace {
  /** Absolute path of the private copy; safe to inspect, never the real repo. */
  readonly workspaceDir: string;
  /** Repo-relative path of the file the caller wants to repair. */
  readonly targetPath: string;
  /** Repo-relative path of the allow-listed test that must pass. */
  readonly testFile: string;
}

export interface RepairProposal {
  readonly file: string;
  readonly before: string;
  readonly after: string;
  readonly diff: string;
}

export interface RepairResult {
  /** `passed` only when the test actually ran and exited 0. */
  readonly testPassed: boolean;
  readonly attempts: number;
  readonly output: string;
  readonly exitCode: number;
  /** The exact patch applied, with a unified-style diff of the change. */
  readonly proposal: RepairProposal;
  /** Repo-relative path of the changed file inside the isolated copy. */
  readonly changedFile: string;
  /**
   * sha256 of the exact bytes that were tested. For a passing result it is the
   * hash of the patched file; for a failed result (workspace reverted) it is the
   * hash of the reverted, original file. This is the auditable fingerprint of
   * what the test actually ran against — no content, just a digest.
   */
  readonly patchSha256: string;
  /** Where the reviewer can inspect the result. */
  readonly workspaceDir: string;
}

/**
 * The reviewable form of a repair outcome. It never re-reads the workspace: the
 * `before`/`after` bytes and `patchSha256` all come from the same in-memory
 * {@link RepairResult} that the test run produced, so a reviewer is shown the
 * exact content that was verified — the bytes cannot drift after verification.
 *
 * When the proposed change exceeds {@link MAX_REPAIR_DISPLAY_BYTES} the inline
 * content is withheld (`reviewable: false`, `contentTruncated: true`) rather than
 * presenting a truncated diff as if it were complete.
 */
export interface ReviewableRepairProposal {
  readonly reviewable: boolean;
  readonly reason: 'OK' | 'TOO_LARGE' | 'NOT_VERIFIED';
  readonly file: string;
  readonly testFile: string;
  readonly verified: boolean;
  readonly patchSha256: string;
  readonly diff: string | null;
  readonly before: string | null;
  readonly after: string | null;
  readonly bytes: { before: number; after: number };
  readonly contentTruncated: boolean;
}

/**
 * Derives the reviewable proposal from a completed repair result without
 * touching the workspace again. `verified` is true only when the test actually
 * passed, and `patchSha256` is the digest of the exact bytes that were verified,
 * so the displayed content is bound to the verified version.
 */
export function reviewableRepairProposal(
  result: RepairResult,
  testFile: string,
): ReviewableRepairProposal {
  const beforeBytes = Buffer.byteLength(result.proposal.before, 'utf8');
  const afterBytes = Buffer.byteLength(result.proposal.after, 'utf8');
  const tooLarge = beforeBytes > MAX_REPAIR_DISPLAY_BYTES || afterBytes > MAX_REPAIR_DISPLAY_BYTES;
  const base = {
    file: result.changedFile,
    testFile,
    verified: result.testPassed,
    patchSha256: result.patchSha256,
    bytes: { before: beforeBytes, after: afterBytes },
  };
  if (!result.testPassed) {
    return { ...base, reviewable: false, reason: 'NOT_VERIFIED', diff: null, before: null, after: null, contentTruncated: false };
  }
  if (tooLarge) {
    return { ...base, reviewable: false, reason: 'TOO_LARGE', diff: null, before: null, after: null, contentTruncated: true };
  }
  return {
    ...base,
    reviewable: true,
    reason: 'OK',
    diff: result.proposal.diff,
    before: result.proposal.before,
    after: result.proposal.after,
    contentTruncated: false,
  };
}

/** Normalises a repo-relative path and rejects traversal / absolute input. */
function safeRelPath(input: string, label: string): string {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error(`repair: ${label} is required`);
  }
  const cleaned = input.replace(/\\/g, '/').replace(/^\.\//, '');
  if (cleaned.startsWith('/') || cleaned.split('/').includes('..')) {
    throw new Error(`repair: ${label} must be a repo-relative path without ".."`);
  }
  return cleaned;
}

/**
 * Validates a repo-relative path and returns its canonical form.
 *
 * `path.posix.normalize` collapses `.` segments, doubled separators and a
 * trailing slash, so two textually different spellings of the same file compare
 * equal. Normalisation runs *after* {@link safeRelPath} has rejected traversal
 * and absolute input, so it can never reintroduce a `..` segment.
 */
function normalizedRel(input: string, label: string): string {
  return path.posix.normalize(safeRelPath(input, label)).replace(/\/+$/, '');
}

/** True when `rel` is exactly an allow-listed root or sits under one. */
function underRoot(rel: string, roots: readonly string[]): boolean {
  return roots.some((root) => rel === root || rel.startsWith(`${root}/`));
}

/** Enforces the source allow-list: allowed root AND allowed extension. */
function assertPatchablePath(rel: string): void {
  if (!underRoot(rel, REPAIR_ALLOWED_ROOTS)) {
    throw new Error(`repair: "${rel}" is outside the patchable source roots`);
  }
  if (!REPAIR_ALLOWED_EXTENSIONS.includes(path.posix.extname(rel))) {
    throw new Error(`repair: "${rel}" is not an allowed source file extension`);
  }
  // Defence in depth: even under an allowed root, never touch secret-ish names.
  const base = path.posix.basename(rel);
  if (base === '.env' || base.startsWith('.env.')) {
    throw new Error(`repair: "${rel}" is not a patchable file`);
  }
}

/**
 * Enforces the test allow-list: allowed test root AND a `.test.ts` suffix, and
 * that the test is independent of the file under repair.
 *
 * The independent-verification rule is what stops the agent from editing the
 * very test it uses as proof: a repair may not target the test file itself, and
 * the verifying test may not live under the patchable source roots. The check is
 * done on *normalised* repo-relative paths, so a `.`/`//`/trailing-slash
 * spelling of the same file cannot slip past a textual comparison.
 */
function assertTestPath(rel: string, targetPath: string): void {
  // Independent verification, checked first so it is the reason surfaced when the
  // "test" is really the file being repaired (a `.test.ts` under `src` is itself a
  // valid patch target, so this branch is reachable).
  if (rel === targetPath) {
    throw new Error('repair: the verification test must be independent of the file under repair');
  }
  if (underRoot(rel, REPAIR_ALLOWED_ROOTS)) {
    throw new Error('repair: the verification test must not live under the patchable source roots');
  }
  if (!underRoot(rel, REPAIR_ALLOWED_TEST_ROOTS)) {
    throw new Error(`repair: test "${rel}" is outside the allow-listed test root`);
  }
  if (!/\.test\.tsx?$/.test(rel)) {
    throw new Error(`repair: test "${rel}" must be a *.test.ts(x) file`);
  }
}

/**
 * True when the running platform does not provide POSIX open flags
 * (`O_NOFOLLOW`/`O_DIRECTORY`). On such a platform the fd-based
 * {@link openContainedFile} guard cannot be used and the caller falls back to
 * the `realpath`-only containment check (with the residual TOCTOU window that
 * implies). Linux/macOS expose the flags, so the stronger path is used there.
 */
function isPlatformUnsupported(): boolean {
  return (
    typeof fsConstants.O_NOFOLLOW !== 'number' || typeof fsConstants.O_DIRECTORY !== 'number'
  );
}

/**
 * Opens a file that must live inside the isolated workspace and returns its open
 * handle, so the caller reads/writes through that exact descriptor instead of
 * re-resolving the path.
 *
 * Defence in depth, in order:
 *   1. `O_NOFOLLOW` — refuses to follow a symlink at the **final** path
 *      component, so the file handle can never be a symlink redirect. It does
 *      NOT protect intermediate directories; that residual window is documented
 *      and cannot be closed without `openat`-relative traversal (unavailable in
 *      `fs/promises`).
 *   2. `fstat` on the open handle — the opened object must be a regular file, so
 *      a FIFO/device/socket (or a directory) is refused even if it passed the
 *      path checks.
 *
 * Because the operations that follow use this handle (not a re-resolved path),
 * a symlink swapped in *after* the open cannot redirect them: they already point
 * at the verified inode. The workspace *root* is deliberately not rejected for
 * being a symlink here: containment is judged after resolving the root (see
 * {@link assertRealPathInsideWorkspace}), which is the established behaviour.
 *
 * `flags` must include `O_NOFOLLOW` and `O_NONBLOCK`; the latter keeps opening a
 * FIFO/device from blocking before the fstat check can reject it.
 */
async function openContainedFile(
  workspaceDir: string,
  rel: string,
  flags: number,
): Promise<FileHandle> {
  const handle = await open(path.join(workspaceDir, rel), flags);
  try {
    const st = await handle.stat();
    if (!st.isFile()) {
      throw new Error(`repair: "${rel}" is not a regular file`);
    }
  } catch (err) {
    await handle.close();
    throw err;
  }
  return handle;
}

/**
 * Reads a workspace file through the guarded fd path (O_NOFOLLOW + fstat), or
 * through a plain `readFile` on a platform without the POSIX open flags. The
 * caller has already run the path allow-lists and the realpath containment check.
 */
async function readContained(workspaceDir: string, rel: string): Promise<string> {
  if (isPlatformUnsupported()) return readFile(path.join(workspaceDir, rel), 'utf8');
  const handle = await openContainedFile(
    workspaceDir,
    rel,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Writes a workspace file through the guarded fd path: the handle is opened with
 * O_NOFOLLOW and fstat-verified as a regular file, then truncated and written
 * from offset 0, so the bytes land on the verified inode and a symlink at the
 * final component can never redirect the write. On a platform without the open
 * flags it falls back to a plain `writeFile` (path-based, realpath-only guard).
 */
async function writeContained(workspaceDir: string, rel: string, content: string): Promise<void> {
  if (isPlatformUnsupported()) {
    await writeFile(path.join(workspaceDir, rel), content, 'utf8');
    return;
  }
  const handle = await openContainedFile(
    workspaceDir,
    rel,
    fsConstants.O_RDWR | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    await handle.truncate(0);
    await handle.write(content, 0, 'utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Confirms a repo-relative path stays inside the workspace on the *real*
 * filesystem, not just textually.
 *
 * `assertPatchablePath`/`assertTestPath` vet the textual path; this second gate
 * re-checks the resolved location so a symlink (a file symlink, or a symlinked
 * parent directory) cannot redirect a read or write outside the isolated
 * workspace. The nearest existing ancestor is resolved with `realpath` and must
 * be `workspaceDir` itself or below it — so a symlinked component anywhere along
 * the path is caught, and a path that does not exist yet is still bounded.
 *
 * This is the pre-open containment check. It is deliberately *paired* with the
 * fd-based {@link openContainedFile} guard (O_NOFOLLOW + fstat) for the actual
 * read/write, so the final component is opened without following a symlink even
 * if it is swapped after this check. A residual TOCTOU window remains for
 * *intermediate* directories: this check and the following open are separate
 * syscalls, and closing that window needs `openat`-relative traversal, which
 * `fs/promises` does not expose. That residual risk is documented, not claimed
 * as solved.
 */
async function assertRealPathInsideWorkspace(workspaceDir: string, rel: string): Promise<void> {
  const root = await realpath(workspaceDir);
  const target = path.join(workspaceDir, rel);

  let current = target;
  for (;;) {
    try {
      await lstat(current);
      break;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  const resolved = await realpath(current);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`repair: "${rel}" resolves outside the isolated workspace`);
  }
}

/** A compact unified-style diff of a single contiguous change. */
function singleChangeDiff(file: string, before: string, after: string): string {
  const out = [`--- a/${file}`, `+++ b/${file}`, '@@'];
  for (const line of before.split('\n')) out.push(`-${line}`);
  for (const line of after.split('\n')) out.push(`+${line}`);
  return out.join('\n');
}

/**
 * sha256 (hex) of the exact bytes that were tested. No content is retained.
 *
 * Exported so the audit fingerprint is verifiable without spawning a test run.
 */
export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Writes a DB-free vitest config into the workspace. It deliberately omits
 * `globalSetup`/`setupFiles`, so no database is ever dropped, created, migrated
 * or seeded — a repair test run can never destroy `wasit_test`.
 */
async function writeSandboxConfig(ws: RepairWorkspace): Promise<string> {
  const configPath = path.join(ws.workspaceDir, 'vitest.repair.config.ts');
  const body = [
    "import { defineConfig } from 'vitest/config';",
    'export default defineConfig({',
    // Keep every cache write inside the disposable workspace: the container root
    // is read-only, and only the workspace mount is writable.
    `  cacheDir: '${path.join(REPAIR_WORKSPACE_MOUNT, '.repair-vite-cache').replace(/\\/g, '/')}',`,
    '  test: {',
    "    environment: 'node',",
    `    include: ['${ws.testFile}'],`,
    '    testTimeout: 60000,',
    '    hookTimeout: 60000,',
    '  },',
    '});',
    '',
  ].join('\n');
  await writeFile(configPath, body, 'utf8');
  return configPath;
}

/**
 * Copies the repository source tree into a fresh isolated workspace.
 *
 * Only `packages/server/src` and `packages/server/tests` are copied — the
 * minimum needed to read a source file and run a scoped test. `.env` files,
 * git metadata, `node_modules` and build output are never copied, and no
 * `node_modules` symlink into the real tree is created: the container resolves
 * dependencies from its own image.
 */
export async function prepareRepairWorkspace(
  sourceRoot: string,
  target: { targetPath: string; testFile: string },
): Promise<RepairWorkspace> {
  requireAction(REPAIR_ACTION_ID);
  const targetPath = normalizedRel(target.targetPath, 'targetPath');
  const testFile = normalizedRel(target.testFile, 'testFile');
  assertPatchablePath(targetPath);
  assertTestPath(testFile, targetPath);

  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'wasit-repair-'));
  for (const rel of [...REPAIR_ALLOWED_ROOTS, ...REPAIR_ALLOWED_TEST_ROOTS]) {
    await cp(path.join(sourceRoot, rel), path.join(workspaceDir, rel), { recursive: true });
  }
  // No `node_modules` is placed here. The workspace is mounted into the repair
  // container at REPAIR_WORKSPACE_MOUNT and `node_modules` is resolved *inside*
  // the image (a read-only copy of the pre-installed dependency closure), so the
  // subprocess has no writable path to the repository's real dependency tree.
  const ws: RepairWorkspace = { workspaceDir, targetPath, testFile };
  await writeSandboxConfig(ws);
  return ws;
}

/** Reads a source file from the isolated workspace (never the real repo). */
export async function readRepairFile(ws: RepairWorkspace, relPath: string): Promise<string> {
  requireAction(REPAIR_ACTION_ID);
  const rel = normalizedRel(relPath, 'path');
  assertPatchablePath(rel);
  await assertRealPathInsideWorkspace(ws.workspaceDir, rel);
  // Read through an fd opened with O_NOFOLLOW (no symlink at the final
  // component) and fstat-verified as a regular file; the fallback keeps the
  // pre-existing realpath-only behaviour on platforms without the open flags.
  return readContained(ws.workspaceDir, rel);
}

/**
 * Applies exactly one exact, unique string replacement inside the isolated
 * workspace and returns the proposal (with a diff) without touching the repo.
 *
 * `find` must occur exactly once: a zero-match or multi-match patch is refused,
 * so the agent can never blind-apply a change in the wrong place.
 */
export async function proposeRepairPatch(
  ws: RepairWorkspace,
  edit: { find: string; replace: string },
): Promise<RepairProposal> {
  requireAction(REPAIR_ACTION_ID);
  const rel = ws.targetPath;
  assertPatchablePath(rel);
  if (typeof edit.find !== 'string' || edit.find.length === 0) {
    throw new Error('repair: patch "find" must be a non-empty string');
  }
  if (typeof edit.replace !== 'string') {
    throw new Error('repair: patch "replace" must be a string');
  }
  // Resource limits are checked *before* the file is touched, so an over-limit
  // request is refused outright and never produces a partial write.
  const replaceBytes = Buffer.byteLength(edit.replace, 'utf8');
  if (replaceBytes > MAX_REPAIR_REPLACE_BYTES) {
    throw new Error(
      `repair: replacement is ${replaceBytes} bytes, over the ${MAX_REPAIR_REPLACE_BYTES}-byte limit`,
    );
  }
  await assertRealPathInsideWorkspace(ws.workspaceDir, rel);
  // Read and write through ONE fd opened with O_NOFOLLOW and fstat-verified as a
  // regular file, so the bytes written go to the exact inode that was read and
  // the final path component can never be a symlink redirect. On a platform
  // without the open flags, the helpers fall back to the pre-existing
  // path-based flow.
  const before = await readContained(ws.workspaceDir, rel);
  const beforeBytes = Buffer.byteLength(before, 'utf8');
  if (beforeBytes > MAX_REPAIR_FILE_BYTES) {
    throw new Error(
      `repair: file is ${beforeBytes} bytes, over the ${MAX_REPAIR_FILE_BYTES}-byte limit`,
    );
  }
  const occurrences = before.split(edit.find).length - 1;
  if (occurrences === 0) throw new Error('repair: patch "find" did not match the file');
  if (occurrences > 1) throw new Error(`repair: patch "find" is ambiguous (${occurrences} matches)`);
  const after = before.replace(edit.find, edit.replace);
  const lineDelta = Math.abs(after.split('\n').length - before.split('\n').length);
  if (lineDelta > MAX_REPAIR_LINE_DELTA) {
    throw new Error(
      `repair: patch changes ${lineDelta} lines, over the ${MAX_REPAIR_LINE_DELTA}-line limit`,
    );
  }
  // The write targets the verified inode, not a re-resolved path.
  await writeContained(ws.workspaceDir, rel, after);
  return { file: rel, before, after, diff: singleChangeDiff(rel, edit.find, edit.replace) };
}

/** Reverts the isolated workspace copy to the unpatched content. */
export async function revertRepairPatch(ws: RepairWorkspace, original: string): Promise<void> {
  requireAction(REPAIR_ACTION_ID);
  assertPatchablePath(ws.targetPath);
  await assertRealPathInsideWorkspace(ws.workspaceDir, ws.targetPath);
  // Same fd-based guard as the patch path: revert targets the verified inode.
  await writeContained(ws.workspaceDir, ws.targetPath, original);
}

/**
 * The minimal, explicit environment for the repair subprocess (the container
 * runtime CLI).
 *
 * It is built from an allow-list, never from a spread of the parent
 * `process.env`: a DB URL, an API key or an auth token present in the server
 * process can therefore never leak into the (untrusted, patched) test code.
 * `HOME` is redirected into the disposable workspace and the npm cache is pinned
 * there too, so any tooling writes stay inside the workspace rather than in the
 * real home directory.
 *
 * Only what a `docker run …` invocation actually needs is passed:
 *   - `PATH`    — to locate the container runtime executable;
 *   - `TMPDIR`  — so the runtime can create short-lived files where the OS
 *                 expects them (kept as-is; it is not a secret);
 *   - `HOME`    — redirected to the workspace, so the real home is never exposed;
 *   - `NODE_ENV` — fixed to `test`;
 *   - `npm_config_*` — pin the npm cache into the workspace and silence the
 *                 update/fund/audit chatter (no network, no repo writes);
 *   - `DOCKER_HOST` / `DOCKER_CONFIG` — forwarded only when present, so a
 *                 non-default daemon endpoint keeps working. Neither is a secret,
 *                 and neither is a test runner.
 */
export function repairTestEnv(
  workspaceDir: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    HOME: workspaceDir,
    npm_config_cache: path.join(workspaceDir, '.npm-cache'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
  };
  if (typeof base.PATH === 'string' && base.PATH.length > 0) env.PATH = base.PATH;
  if (typeof base.TMPDIR === 'string' && base.TMPDIR.length > 0) env.TMPDIR = base.TMPDIR;
  if (typeof base.DOCKER_HOST === 'string' && base.DOCKER_HOST.length > 0) env.DOCKER_HOST = base.DOCKER_HOST;
  if (typeof base.DOCKER_CONFIG === 'string' && base.DOCKER_CONFIG.length > 0) env.DOCKER_CONFIG = base.DOCKER_CONFIG;
  return env;
}

/**
 * Resolves the container-runtime executable to spawn, or `null` when none is
 * usable. The runtime is *always* the container CLI (default `docker`); an
 * absolute path is checked for the execute bit, a bare name is resolved against
 * `PATH`. `WASIT_REPAIR_RUNTIME` only points at the executable — it can never
 * select a test runner, and a value that is not an executable file is refused.
 */
function resolveRuntimeExecutable(base: NodeJS.ProcessEnv = process.env): string | null {
  const configured = base[REPAIR_RUNTIME_ENV_KEY];
  const candidate =
    typeof configured === 'string' && configured.trim().length > 0 ? configured.trim() : REPAIR_CONTAINER_RUNTIME;
  if (candidate.includes(path.sep)) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      return null;
    }
  }
  for (const dir of (base.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const full = path.join(dir, candidate);
    try {
      accessSync(full, fsConstants.X_OK);
      return full;
    } catch {
      /* keep searching */
    }
  }
  return null;
}

/** The fixed `docker run …` argv for one workspace. Never caller-supplied. */
export function buildRepairContainerArgv(ws: RepairWorkspace): string[] {
  return [
    'run',
    ...REPAIR_CONTAINER_FLAGS,
    '-v',
    `${ws.workspaceDir}:${REPAIR_WORKSPACE_MOUNT}:rw`,
    '-w',
    REPAIR_WORKSPACE_MOUNT,
    REPAIR_IMAGE,
    ...REPAIR_CONTAINER_TEST_COMMAND,
  ];
}

/** The outcome of one repair test invocation (host-side, fail-closed). */
export interface RepairTestRun {
  readonly passed: boolean;
  readonly output: string;
  readonly exitCode: number;
  /** Set only when the sandbox itself refused or failed (never for a test failure). */
  readonly sandbox: RepairSandboxFailure | null;
}

/**
 * Runs the allow-listed test for the workspace inside the hardened repair
 * container and returns whether it passed.
 *
 * FAIL-CLOSED: if no container runtime is available, the test is not run and the
 * result is a failure with `SANDBOX_RUNTIME_UNAVAILABLE`. `npx`/`vitest` are
 * never executed on the host — there is no fallback. A container-runtime exit of
 * {@link REPAIR_SANDBOX_UNAVAILABLE_EXIT} (Docker's "image not found" code) is
 * reported as `SANDBOX_IMAGE_UNAVAILABLE`; a timeout as `SANDBOX_TIMEOUT`. Any
 * non-zero exit (including a genuinely failing test) is a failure.
 */
export async function runRepairTests(ws: RepairWorkspace): Promise<RepairTestRun> {
  requireAction(REPAIR_ACTION_ID);
  assertTestPath(ws.testFile, ws.targetPath);
  const runtime = resolveRuntimeExecutable();
  if (!runtime) {
    return {
      passed: false,
      output: 'repair sandbox unavailable: no container runtime found (fail-closed; the test was not run)',
      exitCode: REPAIR_SANDBOX_UNAVAILABLE_EXIT,
      sandbox: {
        code: 'SANDBOX_RUNTIME_UNAVAILABLE',
        message: `no usable container runtime (expected "${REPAIR_CONTAINER_RUNTIME}")`,
      },
    };
  }
  try {
    const { stdout, stderr } = await execFileAsync(runtime, buildRepairContainerArgv(ws), {
      cwd: ws.workspaceDir,
      timeout: REPAIR_TEST_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      // Allow-listed env only: the parent environment (and its secrets) is never
      // spread into the subprocess.
      env: repairTestEnv(ws.workspaceDir),
    });
    return { passed: true, output: `${stdout}\n${stderr}`.trim(), exitCode: 0, sandbox: null };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean; signal?: string };
    const output = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim();
    const exitCode = typeof e.code === 'number' ? e.code : 1;
    if (e.killed === true || e.signal === 'SIGTERM') {
      return {
        passed: false,
        output,
        exitCode,
        sandbox: { code: 'SANDBOX_TIMEOUT', message: `repair container exceeded ${REPAIR_TEST_TIMEOUT_MS}ms` },
      };
    }
    if (exitCode === REPAIR_SANDBOX_UNAVAILABLE_EXIT) {
      return {
        passed: false,
        output,
        exitCode,
        sandbox: { code: 'SANDBOX_IMAGE_UNAVAILABLE', message: `repair image "${REPAIR_IMAGE}" unavailable` },
      };
    }
    return { passed: false, output, exitCode, sandbox: null };
  }
}

/**
 * Runs the full bounded repair loop: patch → test, up to
 * {@link MAX_REPAIR_ATTEMPTS} attempts. The first passing attempt wins; if none
 * passes, the workspace is reverted and `testPassed` is false. There is no
 * unbounded retry: the attempt count is a hard ceiling.
 */
export async function runBoundedRepairLoop(
  ws: RepairWorkspace,
  edits: readonly { find: string; replace: string }[],
): Promise<RepairResult> {
  requireAction(REPAIR_ACTION_ID);
  const original = await readRepairFile(ws, ws.targetPath);
  const maxAttempts = Math.min(Math.max(edits.length, 1), MAX_REPAIR_ATTEMPTS);
  let lastProposal: RepairProposal | null = null;
  let last = { passed: false, output: '', exitCode: 1 };

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const edit = edits[attempt];
    if (!edit) break;
    lastProposal = await proposeRepairPatch(ws, edit);
    last = await runRepairTests(ws);
    if (last.passed) {
      return {
        testPassed: true,
        attempts: attempt + 1,
        output: last.output,
        exitCode: last.exitCode,
        proposal: lastProposal,
        changedFile: ws.targetPath,
        patchSha256: sha256Hex(lastProposal.after),
        workspaceDir: ws.workspaceDir,
      };
    }
    // Failed attempt: revert before the next one so attempts never compound.
    await revertRepairPatch(ws, original);
  }

  return {
    testPassed: false,
    attempts: maxAttempts,
    output: last.output,
    exitCode: last.exitCode,
    proposal: lastProposal ?? { file: ws.targetPath, before: original, after: original, diff: '' },
    changedFile: ws.targetPath,
    // Failed: the workspace was reverted, so the bytes "tested" are the
    // original, unpatched content.
    patchSha256: sha256Hex(original),
    workspaceDir: ws.workspaceDir,
  };
}

/**
 * Removes the isolated workspace. Safe to call at the end of any run.
 *
 * Safety before a recursive delete: the root is `lstat`-checked to be a real
 * directory and NOT a symlink, and its resolved location must sit directly under
 * the OS temp directory (the only place `prepareRepairWorkspace` creates a
 * workspace, via `mkdtemp`). If either check fails — a swapped root, a symlink,
 * or a path outside the temp dir — the delete is SKIPPED and the workspace is
 * left in place rather than risk removing an unexpected tree. A leftover temp
 * directory is the safe failure mode; deleting the wrong tree is not.
 *
 * Residual limit: the identity check and the `rm` are separate syscalls, so a
 * root swapped between them is not caught here; `rm` does not traverse a
 * symlinked root, but it cannot be proven to close that window.
 */
export async function disposeRepairWorkspace(ws: RepairWorkspace): Promise<void> {
  let rootStat;
  try {
    rootStat = await lstat(ws.workspaceDir);
  } catch {
    return; // Already gone — nothing to dispose.
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return;

  let realRoot: string;
  let realTmp: string;
  try {
    realRoot = await realpath(ws.workspaceDir);
    realTmp = await realpath(os.tmpdir());
  } catch {
    return; // Cannot confirm identity — leave it rather than guess.
  }
  if (path.dirname(realRoot) !== realTmp) return;

  await rm(realRoot, { recursive: true, force: true });
}
