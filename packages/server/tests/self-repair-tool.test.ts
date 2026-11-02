import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, lstat, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_REPAIR_ATTEMPTS,
  MAX_REPAIR_DISPLAY_BYTES,
  MAX_REPAIR_FILE_BYTES,
  MAX_REPAIR_LINE_DELTA,
  MAX_REPAIR_REPLACE_BYTES,
  REPAIR_ALLOWED_EXTENSIONS,
  REPAIR_ALLOWED_ROOTS,
  REPAIR_ALLOWED_TEST_ROOTS,
  REPAIR_CONTAINER_FLAGS,
  REPAIR_CONTAINER_TEST_COMMAND,
  REPAIR_IMAGE,
  REPAIR_IMAGE_APP_DIR,
  REPAIR_RUNTIME_ENV_KEY,
  REPAIR_SANDBOX_UNAVAILABLE_EXIT,
  REPAIR_TEST_TIMEOUT_MS,
  REPAIR_WORKSPACE_MOUNT,
  buildRepairContainerArgv,
  prepareRepairWorkspace,
  proposeRepairPatch,
  readRepairFile,
  reviewableRepairProposal,
  runRepairTests,
  sha256Hex,
  disposeRepairWorkspace,
  repairTestEnv,
} from '../src/lib/ai/self-repair-tool.js';
import type { RepairResult } from '../src/lib/ai/self-repair-tool.js';
import {
  withAgentRunContext,
  ActionNotAuthorizedError,
} from '../src/lib/ai/agent-run-context.js';

/**
 * Isolated (DB-free) checks for the Development Agent self-repair tool's guard
 * rails. They prove the deny-by-default gate, the path allow-lists and the hard
 * attempt ceiling. They do NOT run a test or spawn a process.
 *
 * Every rejection asserted here happens *before* the workspace is created, so no
 * temp directory is left behind.
 */

const GRANTED = ['development.propose_patch'];

/** Runs `fn` under a run context that grants the repair action. */
function granted<T>(fn: () => Promise<T>): Promise<T> {
  return withAgentRunContext(
    { taskId: 't', agentKey: 'development-agent', taskType: 'dev.repair', authorizedActions: GRANTED },
    fn,
  );
}

const validTarget = 'packages/server/src/lib/ai/types.ts';
const validTest = 'packages/server/tests/development-read-model.test.ts';

describe('self-repair tool — deny-by-default action gate', () => {
  it('refuses to prepare a workspace with no run context', async () => {
    await expect(
      prepareRepairWorkspace('/repo', { targetPath: validTarget, testFile: validTest }),
    ).rejects.toBeInstanceOf(ActionNotAuthorizedError);
  });

  it('refuses when the run does not grant development.propose_patch', async () => {
    await expect(
      withAgentRunContext(
        { taskId: 't', agentKey: 'development-agent', taskType: 'dev.repair', authorizedActions: ['development.read_platform_snapshot'] },
        () => prepareRepairWorkspace('/repo', { targetPath: validTarget, testFile: validTest }),
      ),
    ).rejects.toBeInstanceOf(ActionNotAuthorizedError);
  });

  it('gates readRepairFile and proposeRepairPatch too', async () => {
    const ws = { workspaceDir: '/tmp/none', targetPath: validTarget, testFile: validTest };
    await expect(readRepairFile(ws, validTarget)).rejects.toBeInstanceOf(ActionNotAuthorizedError);
    await expect(proposeRepairPatch(ws, { find: 'a', replace: 'b' })).rejects.toBeInstanceOf(ActionNotAuthorizedError);
  });
});

describe('self-repair tool — path allow-lists', () => {
  const rejectTarget = (targetPath: string) =>
    granted(() => prepareRepairWorkspace('/repo', { targetPath, testFile: validTest }));

  it('rejects traversal and absolute target paths', async () => {
    await expect(rejectTarget('../etc/passwd')).rejects.toThrow(/repo-relative/);
    await expect(rejectTarget('packages/server/src/../../secret.ts')).rejects.toThrow(/repo-relative/);
    await expect(rejectTarget('/etc/passwd.ts')).rejects.toThrow(/repo-relative/);
  });

  it('rejects targets outside the allow-listed source root', async () => {
    await expect(rejectTarget('packages/server/tests/x.ts')).rejects.toThrow(/outside the patchable source roots/);
    await expect(rejectTarget('packages/shared/src/x.ts')).rejects.toThrow(/outside the patchable source roots/);
    await expect(rejectTarget('package.json')).rejects.toThrow(/outside the patchable source roots/);
  });

  it('rejects non-source extensions and secret-ish names under an allowed root', async () => {
    await expect(rejectTarget('packages/server/src/logo.png')).rejects.toThrow(/extension/);
    await expect(rejectTarget('packages/server/src/.env.ts')).rejects.toThrow(/not a patchable file/);
  });

  it('rejects test paths outside the allow-listed test root or not a *.test.ts', async () => {
    await expect(
      granted(() => prepareRepairWorkspace('/repo', { targetPath: validTarget, testFile: 'packages/server/tests/helper.ts' })),
    ).rejects.toThrow(/\*\.test\.ts/);
  });
});

describe('self-repair tool — the verification test must be independent', () => {
  const rejectTarget = (targetPath: string, testFile: string) =>
    granted(() => prepareRepairWorkspace('/repo', { targetPath, testFile }));

  it('rejects a test that lives inside the patchable source roots', async () => {
    await expect(
      rejectTarget(validTarget, 'packages/server/src/evil.test.ts'),
    ).rejects.toThrow(/must not live under the patchable source roots/);
  });

  it('rejects a test that is the very file under repair', async () => {
    // A `.test.ts` under `src` is a valid patch target, so the same-file case is
    // reachable and must be refused as non-independent verification.
    const sameFile = 'packages/server/src/modules/ai/thing.test.ts';
    await expect(rejectTarget(sameFile, sameFile)).rejects.toThrow(/independent of the file under repair/);
  });

  it('rejects a same-file repair spelled differently (normalisation, not text compare)', async () => {
    const sameFile = 'packages/server/src/modules/ai/thing.test.ts';
    for (const alias of [
      './packages/server/src/modules/ai/thing.test.ts',
      'packages/server/src/modules//ai/thing.test.ts',
      'packages/server/src/modules/ai/thing.test.ts/',
    ]) {
      await expect(rejectTarget(sameFile, alias)).rejects.toThrow(/independent of the file under repair/);
      await expect(rejectTarget(alias, sameFile)).rejects.toThrow(/independent of the file under repair/);
    }
  });

  it('accepts a well-formed repair that uses an independent, allow-listed test', async () => {
    // The guards run before the workspace is created, so a valid pair proceeds to
    // `cp` and then fails on the missing source tree — proving the pair passed
    // every path/independence gate (it is NOT an ActionNotAuthorizedError, and NOT
    // any of the path rejections).
    await expect(
      rejectTarget('packages/server/src/lib/ai/types.ts', 'packages/server/tests/development-read-model.test.ts'),
    ).rejects.not.toThrow(/independent of the file under repair|patchable source roots|outside the allow-listed test root|\*\.test\.ts|repo-relative/);
  });
});

describe('self-repair tool — real-path containment (symlinks)', () => {
  const temps: string[] = [];
  const relTarget = 'packages/server/src/lib/ai/target.ts';

  afterEach(async () => {
    await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function makeTemp(prefix: string): Promise<string> {
    const d = await mkdtemp(path.join(os.tmpdir(), prefix));
    temps.push(d);
    return d;
  }

  /** Builds an isolated workspace dir with the parent dirs of `relTarget`. */
  async function makeWorkspace(): Promise<string> {
    const ws = await makeTemp('wasit-ws-');
    await mkdir(path.join(ws, 'packages/server/src/lib/ai'), { recursive: true });
    return ws;
  }

  it('rejects a target file symlink pointing outside the workspace (no write)', async () => {
    const ws = await makeWorkspace();
    const outside = await makeTemp('wasit-outside-');
    await writeFile(path.join(outside, 'secret.ts'), 'SECRET_ORIGINAL\n', 'utf8');
    await symlink(path.join(outside, 'secret.ts'), path.join(ws, relTarget));

    await expect(
      granted(() => readRepairFile({ workspaceDir: ws, targetPath: relTarget, testFile: validTest }, relTarget)),
    ).rejects.toThrow(/resolves outside the isolated workspace/);

    // The write path must refuse too, and the outside file must be untouched.
    await expect(
      granted(() => proposeRepairPatch({ workspaceDir: ws, targetPath: relTarget, testFile: validTest }, { find: 'SECRET_ORIGINAL', replace: 'PWNED' })),
    ).rejects.toThrow(/resolves outside the isolated workspace/);
    expect(await readFile(path.join(outside, 'secret.ts'), 'utf8')).toBe('SECRET_ORIGINAL\n');
  });

  it('rejects a symlinked parent directory that escapes the workspace', async () => {
    const ws = await makeTemp('wasit-ws-');
    const outside = await makeTemp('wasit-outside-');
    await mkdir(path.join(outside, 'ai'), { recursive: true });
    await writeFile(path.join(outside, 'ai', 'target.ts'), 'ORIGINAL\n', 'utf8');
    // packages/server/src/lib -> symlink to the existing outside directory, so the
    // resolved target (outside/ai/target.ts) leaves the workspace.
    await mkdir(path.join(ws, 'packages/server/src'), { recursive: true });
    await symlink(outside, path.join(ws, 'packages/server/src/lib'));

    await expect(
      granted(() => readRepairFile({ workspaceDir: ws, targetPath: relTarget, testFile: validTest }, relTarget)),
    ).rejects.toThrow(/resolves outside the isolated workspace/);
  });

  it('accepts a real file inside the workspace and leaves it writable', async () => {
    const ws = await makeWorkspace();
    await writeFile(path.join(ws, relTarget), 'const a = 1;\n', 'utf8');
    const content = await granted(() =>
      readRepairFile({ workspaceDir: ws, targetPath: relTarget, testFile: validTest }, relTarget),
    );
    expect(content).toBe('const a = 1;\n');
  });

  it('accepts a valid target whose parent directory does not exist yet', async () => {
    const ws = await makeTemp('wasit-ws-');
    // `packages/...` does not exist; the guard must still bound it (no throw).
    const content = await granted(() =>
      readRepairFile({ workspaceDir: ws, targetPath: relTarget, testFile: validTest }, relTarget).catch((e) => e),
    );
    // The read itself fails (ENOENT) — proving the guard let it through.
    expect(content).toBeInstanceOf(Error);
    expect((content as Error).message).not.toMatch(/resolves outside the isolated workspace/);
  });

  it('rejects a workspace that is itself a symlink to outside', async () => {
    const realOutside = await makeTemp('wasit-outside-');
    await mkdir(path.join(realOutside, 'packages/server/src/lib/ai'), { recursive: true });
    await writeFile(path.join(realOutside, relTarget), 'OUTSIDE\n', 'utf8');
    const link = path.join(os.tmpdir(), `wasit-ws-link-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await symlink(realOutside, link);
    temps.push(link);

    // `workspaceDir` resolves to `realOutside`, and so does the target — both
    // inside the *resolved* root, so this must be ACCEPTED (containment is judged
    // after resolving the root, not by rejecting symlinked roots outright).
    const content = await granted(() =>
      readRepairFile({ workspaceDir: link, targetPath: relTarget, testFile: validTest }, relTarget),
    );
    expect(content).toBe('OUTSIDE\n');
  });
});

describe('self-repair tool — resource limits', () => {
  const temps: string[] = [];
  const relTarget = 'packages/server/src/lib/ai/target.ts';

  afterEach(async () => {
    await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  /** A workspace with a real `target.ts` pre-filled with `content`. */
  async function wsWith(content: string): Promise<string> {
    const ws = await mkdtemp(path.join(os.tmpdir(), 'wasit-limits-'));
    temps.push(ws);
    await mkdir(path.join(ws, 'packages/server/src/lib/ai'), { recursive: true });
    await writeFile(path.join(ws, relTarget), content, 'utf8');
    return ws;
  }

  const wsObj = (ws: string) => ({ workspaceDir: ws, targetPath: relTarget, testFile: validTest });

  it('accepts a small change within every limit and writes it', async () => {
    const ws = await wsWith('const answer = 1;\n');
    const proposal = await granted(() =>
      proposeRepairPatch(wsObj(ws), { find: 'const answer = 1;', replace: 'const answer = 42;' }),
    );
    expect(proposal.after).toContain('const answer = 42;');
    expect(await readFile(path.join(ws, relTarget), 'utf8')).toContain('const answer = 42;');
  });

  it('rejects an oversized replacement before reading the file (no write)', async () => {
    const ws = await wsWith('const answer = 1;\n');
    const huge = 'x'.repeat(MAX_REPAIR_REPLACE_BYTES + 1);
    await expect(
      granted(() => proposeRepairPatch(wsObj(ws), { find: 'const answer = 1;', replace: huge })),
    ).rejects.toThrow(/replacement is .* over the .*-byte limit/);
    // No write happened: the file still holds the original bytes.
    expect(await readFile(path.join(ws, relTarget), 'utf8')).toBe('const answer = 1;\n');
  });

  it('rejects a file that exceeds the file-size limit (no write)', async () => {
    const big = `// ${'y'.repeat(MAX_REPAIR_FILE_BYTES)}\nconst marker = 1;\n`;
    const ws = await wsWith(big);
    await expect(
      granted(() => proposeRepairPatch(wsObj(ws), { find: 'const marker = 1;', replace: 'const marker = 2;' })),
    ).rejects.toThrow(/file is .* over the .*-byte limit/);
    // The oversized file is left byte-for-byte unchanged (no partial write).
    expect(await readFile(path.join(ws, relTarget), 'utf8')).toBe(big);
  });

  it('rejects a patch whose net line delta exceeds the limit (no write)', async () => {
    const ws = await wsWith('const marker = 1;\n');
    const replace = `const marker = 2;\n${'\n'.repeat(MAX_REPAIR_LINE_DELTA + 5)}`;
    await expect(
      granted(() => proposeRepairPatch(wsObj(ws), { find: 'const marker = 1;', replace })),
    ).rejects.toThrow(/changes .* lines, over the .*-line limit/);
    expect(await readFile(path.join(ws, relTarget), 'utf8')).toBe('const marker = 1;\n');
  });

  it('keeps the attempt ceiling and the test timeout as hard limits', () => {
    expect(MAX_REPAIR_ATTEMPTS).toBe(3);
    expect(REPAIR_TEST_TIMEOUT_MS).toBe(120_000);
  });

  it('pins the conservative resource-limit constants', () => {
    expect(MAX_REPAIR_FILE_BYTES).toBe(256 * 1024);
    expect(MAX_REPAIR_REPLACE_BYTES).toBe(64 * 1024);
    expect(MAX_REPAIR_LINE_DELTA).toBe(200);
  });
});

describe('self-repair tool — audit fingerprint', () => {
  it('is the deterministic sha256 of the exact content (not content itself)', () => {
    const content = 'export const x = 1;\n';
    const expected = createHash('sha256').update(content, 'utf8').digest('hex');
    expect(sha256Hex(content)).toBe(expected);
    expect(sha256Hex(content)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs when the content differs and is stable for identical content', () => {
    const before = 'const a = 1;\n';
    const after = 'const a = 2;\n';
    expect(sha256Hex(before)).not.toBe(sha256Hex(after));
    expect(sha256Hex(after)).toBe(sha256Hex(after));
  });
});

describe('self-repair tool — fixed policy', () => {
  it('pins the hard attempt ceiling and the source allow-lists', () => {
    expect(MAX_REPAIR_ATTEMPTS).toBe(3);
    expect(REPAIR_ALLOWED_ROOTS).toEqual(['packages/server/src']);
    expect(REPAIR_ALLOWED_EXTENSIONS).toEqual(['.ts', '.tsx']);
    expect(REPAIR_ALLOWED_TEST_ROOTS).toEqual(['packages/server/tests']);
  });
});

describe('self-repair tool — reviewable proposal (PHASE 2E-A)', () => {
  const TEST_FILE = 'packages/server/tests/development-read-model.test.ts';
  const TARGET = 'packages/server/src/lib/ai/target.ts';

  /** A completed repair result; only the fields the reviewer reads matter. */
  function repairResult(over: Partial<RepairResult> = {}): RepairResult {
    const before = 'const answer = 1;\n';
    const after = 'const answer = 42;\n';
    return {
      testPassed: true,
      attempts: 1,
      output: 'ok',
      exitCode: 0,
      proposal: { file: TARGET, before, after, diff: `-${before}+${after}` },
      changedFile: TARGET,
      patchSha256: sha256Hex(after),
      workspaceDir: '/tmp/ws',
      ...over,
    };
  }

  it('exposes the verified change (before/after + diff) after a green test', () => {
    const p = reviewableRepairProposal(repairResult(), TEST_FILE);
    expect(p.reviewable).toBe(true);
    expect(p.reason).toBe('OK');
    expect(p.verified).toBe(true);
    expect(p.file).toBe(TARGET);
    expect(p.testFile).toBe(TEST_FILE);
    expect(p.before).toContain('const answer = 1;');
    expect(p.after).toContain('const answer = 42;');
    expect(p.diff).toContain('const answer = 42;');
    expect(p.contentTruncated).toBe(false);
  });

  it('binds the displayed content to the verified bytes via patchSha256', () => {
    const p = reviewableRepairProposal(repairResult(), TEST_FILE);
    // The digest is over the exact `after` bytes that were verified.
    expect(p.patchSha256).toBe(sha256Hex(p.after!));
    // A different content hashes differently: the reviewer can detect drift.
    expect(p.patchSha256).not.toBe(sha256Hex('const answer = 2;\n'));
  });

  it('never presents an unverified change as verified', () => {
    const failed = repairResult({ testPassed: false, exitCode: 1, patchSha256: sha256Hex('const answer = 1;\n') });
    const p = reviewableRepairProposal(failed, TEST_FILE);
    expect(p.verified).toBe(false);
    expect(p.reviewable).toBe(false);
    expect(p.reason).toBe('NOT_VERIFIED');
    // No content is offered for a failed (reverted) result.
    expect(p.before).toBeNull();
    expect(p.after).toBeNull();
    expect(p.diff).toBeNull();
  });

  it('withholds an oversized change instead of showing a truncated diff', () => {
    const huge = `const answer = 42;\n${'// padding\n'.repeat(MAX_REPAIR_DISPLAY_BYTES)}`;
    const p = reviewableRepairProposal(
      repairResult({
        proposal: { file: TARGET, before: 'const answer = 1;\n', after: huge, diff: 'huge' },
        patchSha256: sha256Hex(huge),
      }),
      TEST_FILE,
    );
    expect(p.reviewable).toBe(false);
    expect(p.reason).toBe('TOO_LARGE');
    expect(p.contentTruncated).toBe(true);
    expect(p.diff).toBeNull();
    expect(p.after).toBeNull();
    // The fingerprint and sizes are still reported so the reviewer can act.
    expect(p.patchSha256).toBe(sha256Hex(huge));
    expect(p.bytes.after).toBe(Buffer.byteLength(huge, 'utf8'));
  });

  it('is a pure derivation: identical results give identical proposals', () => {
    expect(reviewableRepairProposal(repairResult(), TEST_FILE)).toEqual(
      reviewableRepairProposal(repairResult(), TEST_FILE),
    );
  });

  it('still never claims an application or a merge', () => {
    const p = reviewableRepairProposal(repairResult(), TEST_FILE);
    expect('applied' in p).toBe(false);
    expect('merged' in p).toBe(false);
  });
});

/**
 * PHASE 2M — fd-based path safety.
 *
 * These tests exercise the strengthened guard: the final path component is
 * opened with O_NOFOLLOW and the opened object is fstat-verified as a regular
 * file, so a symlink at the final component can never redirect a read or a
 * write — even one that stays inside the workspace and therefore passes the
 * realpath containment check. The destructive cleanup is verified to refuse a
 * symlinked or non-temp root.
 *
 * They are deterministic: no sleeps, no timing races. Cases that require a
 * race to be *exploited* (a component swapped between the check and the open)
 * are asserted only for the deterministic guard outcome, and the residual
 * intermediate-directory window is documented, not claimed as closed.
 */
describe('self-repair tool — fd-based path safety (PHASE 2M)', () => {
  const temps: string[] = [];
  const relTarget = 'packages/server/src/lib/ai/target.ts';

  afterEach(async () => {
    await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function makeTemp(prefix: string): Promise<string> {
    const d = await mkdtemp(path.join(os.tmpdir(), prefix));
    temps.push(d);
    return d;
  }

  /** An isolated workspace with the parent dirs of `relTarget` created. */
  async function makeWorkspace(): Promise<string> {
    const ws = await makeTemp('wasit-2m-ws-');
    await mkdir(path.join(ws, 'packages/server/src/lib/ai'), { recursive: true });
    return ws;
  }

  const wsObj = (ws: string) => ({ workspaceDir: ws, targetPath: relTarget, testFile: validTest });

  it('reads and writes a real file inside the workspace (happy path)', async () => {
    const ws = await makeWorkspace();
    await writeFile(path.join(ws, relTarget), 'const answer = 1;\n', 'utf8');

    expect(await granted(() => readRepairFile(wsObj(ws), relTarget))).toBe('const answer = 1;\n');

    const proposal = await granted(() =>
      proposeRepairPatch(wsObj(ws), { find: 'const answer = 1;', replace: 'const answer = 42;' }),
    );
    expect(proposal.after).toBe('const answer = 42;\n');
    expect(await readFile(path.join(ws, relTarget), 'utf8')).toBe('const answer = 42;\n');
  });

  it('rejects a final-component symlink that stays INSIDE the workspace (O_NOFOLLOW beats realpath)', async () => {
    const ws = await makeWorkspace();
    const other = 'packages/server/src/lib/ai/other.ts';
    await writeFile(path.join(ws, other), 'OTHER\n', 'utf8');
    // A relative symlink to a file that lives inside the workspace: the realpath
    // containment gate ACCEPTS it, so only the O_NOFOLLOW fd guard can refuse it.
    await symlink('other.ts', path.join(ws, relTarget));

    await expect(granted(() => readRepairFile(wsObj(ws), relTarget))).rejects.toThrow(/ELOOP/);
    await expect(
      granted(() => proposeRepairPatch(wsObj(ws), { find: 'OTHER', replace: 'PWNED' })),
    ).rejects.toThrow(/ELOOP/);
    // The link target is untouched (the write never followed the link).
    expect(await readFile(path.join(ws, other), 'utf8')).toBe('OTHER\n');
  });

  it('rejects a final-component symlink to a decoy outside the workspace, leaving the decoy intact', async () => {
    const ws = await makeWorkspace();
    const outside = await makeTemp('wasit-2m-out-');
    const decoy = path.join(outside, 'secret.ts');
    await writeFile(decoy, 'SECRET_ORIGINAL\n', 'utf8');
    await symlink(decoy, path.join(ws, relTarget));

    await expect(
      granted(() => proposeRepairPatch(wsObj(ws), { find: 'SECRET_ORIGINAL', replace: 'PWNED' })),
    ).rejects.toThrow(/resolves outside the isolated workspace/);
    expect(await readFile(decoy, 'utf8')).toBe('SECRET_ORIGINAL\n');
  });

  it('rejects a symlinked intermediate directory (pre-open realpath gate), leaving the outside file intact', async () => {
    const ws = await makeTemp('wasit-2m-ws-');
    const outside = await makeTemp('wasit-2m-out-');
    await mkdir(path.join(outside, 'ai'), { recursive: true });
    const decoy = path.join(outside, 'ai', 'target.ts');
    await writeFile(decoy, 'ORIGINAL\n', 'utf8');
    await mkdir(path.join(ws, 'packages/server/src'), { recursive: true });
    await symlink(outside, path.join(ws, 'packages/server/src/lib'));

    await expect(
      granted(() => proposeRepairPatch(wsObj(ws), { find: 'ORIGINAL', replace: 'PWNED' })),
    ).rejects.toThrow(/resolves outside the isolated workspace/);
    expect(await readFile(decoy, 'utf8')).toBe('ORIGINAL\n');
  });

  it('refuses to patch through a FIFO (fstat must see a regular file)', async () => {
    const ws = await makeWorkspace();
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('mkfifo', [path.join(ws, relTarget)]);

    await expect(
      granted(() => proposeRepairPatch(wsObj(ws), { find: 'a', replace: 'b' })),
    ).rejects.toThrow(/not a regular file/);
  });

  it('skips cleanup when the workspace root is a symlink (never follows it) and leaves the target intact', async () => {
    const realWs = await makeWorkspace();
    const keep = path.join(realWs, 'keep.txt');
    await writeFile(keep, 'KEEP\n', 'utf8');
    const link = path.join(await makeTemp('wasit-2m-link-'), 'ws-link');
    await symlink(realWs, link);

    await disposeRepairWorkspace({ workspaceDir: link, targetPath: relTarget, testFile: validTest });

    // The delete was skipped: both the link and the real tree are untouched.
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(keep, 'utf8')).toBe('KEEP\n');
  });

  it('skips cleanup when the root is outside the temp dir and leaves it intact', async () => {
    // A real directory that is NOT directly under os.tmpdir(): cleanup must
    // refuse to delete it, because a workspace is only ever created under tmp.
    const notTmp = path.join('/var/tmp', `wasit-2m-notmp-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(notTmp, { recursive: true });
    temps.push(notTmp);
    const keep = path.join(notTmp, 'keep.txt');
    await writeFile(keep, 'KEEP\n', 'utf8');

    await disposeRepairWorkspace({ workspaceDir: notTmp, targetPath: relTarget, testFile: validTest });

    expect(await readFile(keep, 'utf8')).toBe('KEEP\n');
    expect((await lstat(notTmp)).isDirectory()).toBe(true);
  });

  it('removes a real workspace that sits under the temp dir (happy-path cleanup)', async () => {
    const ws = await makeWorkspace();
    await disposeRepairWorkspace({ workspaceDir: ws, targetPath: relTarget, testFile: validTest });
    await expect(lstat(ws)).rejects.toThrow();
  });

  it('treats an already-removed workspace as a no-op', async () => {
    const ws = await makeWorkspace();
    await rm(ws, { recursive: true, force: true });
    await expect(
      disposeRepairWorkspace({ workspaceDir: ws, targetPath: relTarget, testFile: validTest }),
    ).resolves.toBeUndefined();
  });
});

/**
 * PHASE 2O — the repair test subprocess environment is an allow-list.
 *
 * The parent environment is never spread into the subprocess, so a secret that
 * exists only in the server process (a DB URL, an API key, a session token)
 * cannot reach the untrusted, patched test code. A synthetic secret is used
 * here; no real environment value is read or printed.
 */
describe('self-repair tool — repair test environment is allow-listed (PHASE 2O)', () => {
  it('drops a secret present in the base environment', () => {
    const env = repairTestEnv('/tmp/ws', { PATH: '/usr/bin', DATABASE_URL: 'postgres://secret' });
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it('never forwards an arbitrary secret key', () => {
    const env = repairTestEnv('/tmp/ws', {
      PATH: '/usr/bin',
      API_KEY: 'top-secret',
      AUTH_TOKEN: 'tok',
      OH_SECRET_KEY: 'sk',
      LMNR_PROJECT_API_KEY: 'lk',
    });
    expect(env.API_KEY).toBeUndefined();
    expect(env.AUTH_TOKEN).toBeUndefined();
    expect(env.OH_SECRET_KEY).toBeUndefined();
    expect(env.LMNR_PROJECT_API_KEY).toBeUndefined();
  });

  it('keeps only the allow-listed variables and fixes the tooling ones', () => {
    const env = repairTestEnv('/tmp/ws', { PATH: '/usr/bin:/bin', TMPDIR: '/tmp', SECRET: 'x' });
    expect(Object.keys(env).sort()).toEqual(
      [
        'HOME',
        'NODE_ENV',
        'PATH',
        'TMPDIR',
        'npm_config_audit',
        'npm_config_cache',
        'npm_config_fund',
        'npm_config_update_notifier',
      ].sort(),
    );
    expect(env.NODE_ENV).toBe('test');
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.TMPDIR).toBe('/tmp');
    expect(env.HOME).toBe('/tmp/ws');
    expect(env.npm_config_cache).toBe('/tmp/ws/.npm-cache');
    expect(env.SECRET).toBeUndefined();
  });

  it('tolerates a base environment without PATH or TMPDIR', () => {
    const env = repairTestEnv('/tmp/ws', {});
    expect(env.PATH).toBeUndefined();
    expect(env.TMPDIR).toBeUndefined();
    expect(env.NODE_ENV).toBe('test');
  });
});

/**
 * PHASE 2O — the repair workspace root.
 *
 * `prepareRepairWorkspace` seeds a fresh `mkdtemp` copy; that directory is
 * created 0700, so a *different* OS user cannot reach into it. This is verified
 * against a synthetic source root, never the real repository.
 */
describe('self-repair tool — workspace root is private (PHASE 2O)', () => {
  const temps: string[] = [];

  afterEach(async () => {
    await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function makeTemp(prefix: string): Promise<string> {
    const d = await mkdtemp(path.join(os.tmpdir(), prefix));
    temps.push(d);
    return d;
  }

  it('creates the workspace copy with 0700 permissions', async () => {
    const sourceRoot = await makeTemp('wasit-2o-src-');
    await mkdir(path.join(sourceRoot, 'packages/server/src/lib/ai'), { recursive: true });
    await mkdir(path.join(sourceRoot, 'packages/server/tests'), { recursive: true });
    await mkdir(path.join(sourceRoot, 'node_modules'), { recursive: true });

    const ws = await granted(() =>
      prepareRepairWorkspace(sourceRoot, {
        targetPath: 'packages/server/src/lib/ai/x.ts',
        testFile: 'packages/server/tests/y.test.ts',
      }),
    );
    temps.push(ws.workspaceDir);

    expect((await lstat(ws.workspaceDir)).mode & 0o777).toBe(0o700);
  });
});

/**
 * PHASE 2U-A — the repair test runs only inside the hardened container, and the
 * `node_modules` bridge is gone.
 *
 * The former "residual writable bridge" test is replaced here: `prepareRepairWorkspace`
 * no longer creates a `node_modules` symlink, and `runRepairTests` refuses to run
 * unless a container runtime is available (fail-closed, never a host fallback).
 * The runtime is substituted with a small executable *stub* — never `npx`/`vitest`
 * — so the spawn path is exercised without a real Docker daemon. Every stub writes
 * a marker file recording its argv, which lets us prove the host never invokes a
 * test runner and never falls back when the sandbox is unavailable.
 */
describe('self-repair tool — repair sandbox is mandatory and fail-closed (PHASE 2U-A)', () => {
  const temps: string[] = [];
  const relTarget = 'packages/server/src/lib/ai/target.ts';

  beforeEach(() => {
    // Guarantee the real environment cannot accidentally supply a runtime.
    delete process.env[REPAIR_RUNTIME_ENV_KEY];
  });

  afterEach(async () => {
    delete process.env[REPAIR_RUNTIME_ENV_KEY];
    await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function makeTemp(prefix: string): Promise<string> {
    const d = await mkdtemp(path.join(os.tmpdir(), prefix));
    temps.push(d);
    return d;
  }

  const wsObj = (ws: string) => ({ workspaceDir: ws, targetPath: relTarget, testFile: validTest });

  /**
   * Writes an executable stub that records its argv to `marker` and exits with
   * `exitCode`. It stands in for the container runtime only; it is never a test
   * runner. `sideEffect`, when given, is written before exiting.
   */
  async function makeRuntimeStub(
    opts: { marker: string; exitCode?: number; sideEffect?: { file: string; content: string } } ,
  ): Promise<string> {
    const dir = await makeTemp('wasit-2u-stub-');
    const stub = path.join(dir, 'runtime-stub.sh');
    const lines = ['#!/bin/sh', `printf '%s\\n' "$@" > ${JSON.stringify(opts.marker)}`];
    if (opts.sideEffect) {
      lines.push(`printf '%s' ${JSON.stringify(opts.sideEffect.content)} > ${JSON.stringify(opts.sideEffect.file)}`);
    }
    lines.push(`exit ${opts.exitCode ?? 0}`);
    await writeFile(stub, `${lines.join('\n')}\n`, 'utf8');
    await chmod(stub, 0o755);
    return stub;
  }

  it('A. prepareRepairWorkspace no longer creates a node_modules symlink', async () => {
    const sourceRoot = await makeTemp('wasit-2u-src-');
    await mkdir(path.join(sourceRoot, 'packages/server/src/lib/ai'), { recursive: true });
    await mkdir(path.join(sourceRoot, 'packages/server/tests'), { recursive: true });
    // A real (writable) node_modules in the source root: if a bridge were created
    // it would be a symlink pointing here, so its absence is the proof.
    await mkdir(path.join(sourceRoot, 'node_modules'), { recursive: true });

    const ws = await granted(() =>
      prepareRepairWorkspace(sourceRoot, {
        targetPath: 'packages/server/src/lib/ai/x.ts',
        testFile: 'packages/server/tests/y.test.ts',
      }),
    );
    temps.push(ws.workspaceDir);

    // No node_modules entry at all — not a symlink, not a directory.
    await expect(lstat(path.join(ws.workspaceDir, 'node_modules'))).rejects.toThrow();
  });

  it('B. fails closed with no runtime: no spawn, no host fallback', async () => {
    const ws = await makeTemp('wasit-2u-ws-');
    // An empty PATH guarantees `docker` cannot be resolved.
    const realPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const run = await granted(() => runRepairTests(wsObj(ws)));
      expect(run.passed).toBe(false);
      expect(run.exitCode).toBe(REPAIR_SANDBOX_UNAVAILABLE_EXIT);
      expect(run.sandbox?.code).toBe('SANDBOX_RUNTIME_UNAVAILABLE');
      // Nothing was executed: the workspace is untouched.
      expect(await lstat(ws).then((s) => s.isDirectory())).toBe(true);
    } finally {
      process.env.PATH = realPath;
    }
  });

  it('B2. never falls back to npx/vitest on the host when the runtime is missing', async () => {
    const ws = await makeTemp('wasit-2u-ws-');
    const realPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const run = await granted(() => runRepairTests(wsObj(ws)));
      expect(run.passed).toBe(false);
      // The only executable the tool ever spawns is the container runtime; the
      // failure path performs no spawn at all.
      expect(run.output).toMatch(/fail-closed/);
    } finally {
      process.env.PATH = realPath;
    }
  });

  it('C. missing image (runtime exit 125) is reported and never falls back', async () => {
    const ws = await makeTemp('wasit-2u-ws-');
    const marker = path.join(await makeTemp('wasit-2u-mark-'), 'argv.txt');
    process.env[REPAIR_RUNTIME_ENV_KEY] = await makeRuntimeStub({ marker, exitCode: REPAIR_SANDBOX_UNAVAILABLE_EXIT });

    const run = await granted(() => runRepairTests(wsObj(ws)));
    expect(run.passed).toBe(false);
    expect(run.sandbox?.code).toBe('SANDBOX_IMAGE_UNAVAILABLE');
    // The runtime WAS invoked (with the fixed argv) — the failure is the image,
    // not a silent local run. The recorded argv names the container runtime only.
    const argv = await readFile(marker, 'utf8');
    expect(argv).toContain('run');
    expect(argv).not.toContain('npx');
  });

  it('D. container-run failure is a failure with no host fallback', async () => {
    const ws = await makeTemp('wasit-2u-ws-');
    const marker = path.join(await makeTemp('wasit-2u-mark-'), 'argv.txt');
    process.env[REPAIR_RUNTIME_ENV_KEY] = await makeRuntimeStub({ marker, exitCode: 1 });

    const run = await granted(() => runRepairTests(wsObj(ws)));
    expect(run.passed).toBe(false);
    expect(run.exitCode).toBe(1);
    expect(run.sandbox).toBeNull();
  });

  it('E. a non-zero test exit inside the container is never reported as success', async () => {
    const ws = await makeTemp('wasit-2u-ws-');
    const marker = path.join(await makeTemp('wasit-2u-mark-'), 'argv.txt');
    // Exit 1 mirrors vitest failing: the run must not be "passed".
    process.env[REPAIR_RUNTIME_ENV_KEY] = await makeRuntimeStub({ marker, exitCode: 1 });
    const run = await granted(() => runRepairTests(wsObj(ws)));
    expect(run.passed).toBe(false);
  });

  it('F. the subprocess environment carries no host secrets (docker CLI allow-list)', () => {
    const env = repairTestEnv('/tmp/ws', {
      PATH: '/usr/bin',
      DATABASE_URL: 'postgres://secret',
      API_KEY: 'top-secret',
      JWT_SECRET: 'x',
      DOCKER_HOST: 'unix:///var/run/docker.sock',
    });
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.API_KEY).toBeUndefined();
    expect(env.JWT_SECRET).toBeUndefined();
    // Only the non-secret daemon endpoint is forwarded.
    expect(env.DOCKER_HOST).toBe('unix:///var/run/docker.sock');
  });

  it('pins the hardening flags and the fixed container argv (no shell, no test runner on host)', () => {
    expect(REPAIR_CONTAINER_FLAGS).toContain('--read-only');
    expect(REPAIR_CONTAINER_FLAGS).toContain('--network=none');
    expect(REPAIR_CONTAINER_FLAGS).toContain('--cap-drop=ALL');
    expect(REPAIR_CONTAINER_FLAGS).toContain('--security-opt=no-new-privileges');
    expect(REPAIR_CONTAINER_FLAGS).toContain('node'); // the non-root user

    const argv = buildRepairContainerArgv({
      workspaceDir: '/tmp/ws',
      targetPath: relTarget,
      testFile: validTest,
    });
    // The workspace is the ONLY writable mount, and it is mounted under /app so
    // the tests resolve the image's node_modules by walking up.
    expect(argv).toContain(`/tmp/ws:${REPAIR_WORKSPACE_MOUNT}:rw`);
    expect(REPAIR_WORKSPACE_MOUNT.startsWith(`${REPAIR_IMAGE_APP_DIR}/`)).toBe(true);
    expect(argv).toContain(REPAIR_IMAGE);
    // The in-container runner is the image's vitest entry point, not a host npx.
    expect(REPAIR_CONTAINER_TEST_COMMAND[0]).toBe('node');
    expect(REPAIR_CONTAINER_TEST_COMMAND.join(' ')).not.toContain('npx');
    // Exactly one writable bind mount (`:rw`), and no extra `-v` mounts.
    expect(argv.filter((a) => a.endsWith(':rw'))).toHaveLength(1);
    expect(argv.filter((a) => a === '-v')).toHaveLength(1);
  });

  it('rejects a configured runtime that is not an executable (no bypass to a test runner)', async () => {
    const ws = await makeTemp('wasit-2u-ws-');
    const notExec = path.join(await makeTemp('wasit-2u-bad-'), 'not-exec');
    await writeFile(notExec, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(notExec, 0o644); // not executable
    process.env[REPAIR_RUNTIME_ENV_KEY] = notExec;

    const run = await granted(() => runRepairTests(wsObj(ws)));
    expect(run.passed).toBe(false);
    expect(run.sandbox?.code).toBe('SANDBOX_RUNTIME_UNAVAILABLE');
  });

  it('G. the runtime stub cannot write through the workspace to a decoy (no bridge)', async () => {
    // This documents the *host-side* guarantee: there is no node_modules bridge,
    // so a workspace path cannot reach an outside decoy. The container's own
    // read-only enforcement is asserted in the runtime-gated describe below.
    const ws = await makeTemp('wasit-2u-ws-');
    const decoyDir = await makeTemp('wasit-2u-decoy-');
    const decoy = path.join(decoyDir, 'secret.ts');
    await writeFile(decoy, 'SECRET_ORIGINAL\n', 'utf8');

    // The workspace has no node_modules at all; a symlink placed by hand is still
    // refused by the realpath containment gate (defence in depth).
    await mkdir(path.join(ws, 'packages/server/src/lib/ai'), { recursive: true });
    await symlink(decoy, path.join(ws, relTarget));
    await expect(
      granted(() => proposeRepairPatch(wsObj(ws), { find: 'SECRET_ORIGINAL', replace: 'PWNED' })),
    ).rejects.toThrow(/resolves outside the isolated workspace/);
    expect(await readFile(decoy, 'utf8')).toBe('SECRET_ORIGINAL\n');
  });
});

/**
 * PHASE 2U-A — container-isolation proofs that REQUIRE a real container runtime.
 *
 * These are skipped unless a Docker daemon is actually reachable; they are the
 * acceptance tests for "the container cannot write to the repository" and "a real
 * test runs inside the container". They never run on the host: without a runtime
 * they are `skip`ped, not silently passed.
 */
const RUNTIME_AVAILABLE = (() => {
  try {
    return spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
})();

describe.skipIf(!RUNTIME_AVAILABLE)('self-repair tool — real container isolation (requires docker)', () => {
  const temps: string[] = [];
  const relTarget = 'packages/server/src/lib/ai/target.ts';

  afterEach(async () => {
    await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function makeTemp(prefix: string): Promise<string> {
    const d = await mkdtemp(path.join(os.tmpdir(), prefix));
    temps.push(d);
    return d;
  }

  /**
   * Removes artifacts the repair container wrote into the mounted workspace.
   * The container runs as the image's `node` user (uid 1000) while the vitest
   * process runs as the CI user (a different uid), so those files are not
   * removable by this process (`rm` fails with EACCES). They are deleted by a
   * short-lived container running as the SAME user that created them (the image
   * default) — no extra privileges, no chmod, and the production container flags
   * are unchanged. The cleanup container is additionally hardened (no network,
   * all capabilities dropped, no privilege escalation) and bounded by a timeout,
   * so a hung or failing cleanup fails H instead of passing silently. A no-op
   * when the container wrote nothing (e.g. the image was unavailable, so nothing
   * was mounted).
   */
  async function removeContainerArtifacts(workspaceDir: string): Promise<void> {
    const cacheDir = path.join(workspaceDir, '.repair-vite-cache');
    try {
      await lstat(cacheDir);
    } catch {
      return; // Nothing the container wrote — nothing to clean.
    }
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)(
      'docker',
      [
        'run', '--rm',
        '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges',
        '-v', `${workspaceDir}:${REPAIR_WORKSPACE_MOUNT}`,
        REPAIR_IMAGE,
        'sh', '-c', `rm -rf ${REPAIR_WORKSPACE_MOUNT}/.repair-vite-cache`,
      ],
      // Bounded like the other docker probe in this file; a hung cleanup fails H
      // (execFile rejects on timeout) rather than silently passing.
      { timeout: 10_000 },
    );
  }

  it('G1. a write attempt to a decoy outside the workspace fails (read-only root, only ws is rw)', async () => {
    const ws = await makeTemp('wasit-2u-ws-');
    const decoyDir = await makeTemp('wasit-2u-decoy-');
    const decoy = path.join(decoyDir, 'secret.ts');
    await writeFile(decoy, 'SECRET_ORIGINAL\n', 'utf8');
    const before = sha256Hex(await readFile(decoy, 'utf8'));

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await expect(
      promisify(execFile)('docker', [
        'run', '--rm', '--read-only', '--network=none', '--cap-drop=ALL',
        '--security-opt=no-new-privileges', '--user', 'node',
        '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m',
        '-v', `${ws}:${REPAIR_WORKSPACE_MOUNT}:rw`, '-w', REPAIR_WORKSPACE_MOUNT,
        REPAIR_IMAGE,
        'node', '-e', `require('fs').writeFileSync(${JSON.stringify(decoy)}, 'PWNED')`,
      ]),
    ).rejects.toThrow();
    expect(sha256Hex(await readFile(decoy, 'utf8'))).toBe(before);
  });

  it('G2. the image node_modules is read-only inside the container', async () => {
    const ws = await makeTemp('wasit-2u-ws-');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await expect(
      promisify(execFile)('docker', [
        'run', '--rm', '--read-only', '--network=none', '--cap-drop=ALL',
        '--security-opt=no-new-privileges', '--user', 'node',
        '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m',
        '-v', `${ws}:${REPAIR_WORKSPACE_MOUNT}:rw`, '-w', REPAIR_WORKSPACE_MOUNT,
        REPAIR_IMAGE,
        'node', '-e', `require('fs').writeFileSync('/app/node_modules/evil.ts', 'x')`,
      ]),
    ).rejects.toThrow();
  });

  it('H. a real repair test runs inside the container and reports its true exit code', async () => {
    const sourceRoot = await makeTemp('wasit-2u-src-');
    await mkdir(path.join(sourceRoot, 'packages/server/src/lib/ai'), { recursive: true });
    await mkdir(path.join(sourceRoot, 'packages/server/tests'), { recursive: true });
    await writeFile(path.join(sourceRoot, 'packages/server/src/lib/ai/x.ts'), 'export const x = 1;\n', 'utf8');
    await writeFile(
      path.join(sourceRoot, 'packages/server/tests/x.test.ts'),
      "import { describe, it, expect } from 'vitest';\nimport { x } from '../src/lib/ai/x.js';\ndescribe('x', () => { it('is 1', () => expect(x).toBe(1)); });\n",
      'utf8',
    );
    const ws = await granted(() =>
      prepareRepairWorkspace(sourceRoot, {
        targetPath: 'packages/server/src/lib/ai/x.ts',
        testFile: 'packages/server/tests/x.test.ts',
      }),
    );
    temps.push(ws.workspaceDir);

    // The workspace is created 0700 by the *test* user; the container runs as
    // the image's `node` user (uid 1000). In production the API creates the
    // workspace as `node` so the uids already match; here we widen the mode so
    // the container can create its cache dir inside the writable mount.
    await chmod(ws.workspaceDir, 0o777);

    const run = await granted(() => runRepairTests(ws));
    // DIAGNOSTIC (temporary): surface the container's output/exit code/sandbox
    // reason so a failure inside CI is visible. `output` is the container's
    // stdout+stderr (no host secrets are added by this test). Remove after H's
    // root cause is identified.
    if (!run.passed) {
      console.error(`[H diagnostic] exitCode=${run.exitCode} sandbox=${JSON.stringify(run.sandbox)}\n${run.output}`);
    }
    expect(run.passed, run.output).toBe(true);
    expect(run.exitCode, run.output).toBe(0);

    // The run wrote its vitest cache inside the workspace as the image's `node`
    // user. Remove those files as the same user, then prove the workspace is
    // fully disposable by this (different-uid) process — the exact cleanup that
    // used to fail with EACCES in afterEach.
    await removeContainerArtifacts(ws.workspaceDir);
    await expect(rm(ws.workspaceDir, { recursive: true, force: true })).resolves.toBeUndefined();
    expect(await lstat(ws.workspaceDir).then(() => true, () => false)).toBe(false);
  });
});


