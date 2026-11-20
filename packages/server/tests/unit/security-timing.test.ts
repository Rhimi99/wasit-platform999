import { describe, it, expect } from 'vitest';
import { DUMMY_ARGON2_HASH, hashPassword, verifyPassword } from '../../src/lib/security.js';

/**
 * Login timing equalisation (LC-07 review) — database-free.
 *
 * The login flow answers an unknown account, a locked account, and a wrong
 * password with the same 401 body; those paths must also cost the same *time*, or
 * the response latency becomes an oracle for whether an address exists / is
 * locked. The fix is to run one argon2 verification against
 * `DUMMY_ARGON2_HASH` on the no-session paths, with parameters identical to a
 * real stored hash.
 *
 * This file pins (1) the parameters match `hashPassword` exactly, and (2) the
 * measured verification cost is comparable. The measurement is a smoke test, not
 * a proof of constant time — argon2 verification is inherently variable — so it
 * uses a generous ratio bound and reports the numbers.
 */

/** Parse the argon2id cost parameters out of a PHC-format hash. */
function params(hash: string): Record<string, string> {
  // $argon2id$v=19$m=19456,t=2,p=1$<salt>$<digest>
  const m = /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(hash);
  if (!m) throw new Error(`not an argon2id PHC hash: ${hash.slice(0, 24)}`);
  return { v: m[1], m: m[2], t: m[3], p: m[4] };
}

async function medianVerifyMs(hash: string, iterations = 5): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    await verifyPassword('a-wrong-password-for-timing', hash);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

describe('login timing — dummy hash matches the real cost', () => {
  it('uses the same argon2id parameters as hashPassword', async () => {
    const real = await hashPassword('a-password-to-hash');
    expect(params(DUMMY_ARGON2_HASH)).toEqual(params(real));
  });

  it('costs a comparable time to a real hash verification', async () => {
    const real = await hashPassword('a-password-to-hash');
    // Warm up so the first-call cost does not skew the medians.
    await verifyPassword('warmup', DUMMY_ARGON2_HASH);
    await verifyPassword('warmup', real);

    const dummyMs = await medianVerifyMs(DUMMY_ARGON2_HASH);
    const realMs = await medianVerifyMs(real);
    const ratio = dummyMs / realMs;
    // Identical parameters → the two should be close; 2.5 is a loose ceiling that
    // still fails loudly if the dummy hash is left at a different cost (the bug
    // this guards against measured ~4-5x before the fix).
    expect(ratio, `dummy=${dummyMs.toFixed(1)}ms real=${realMs.toFixed(1)}ms ratio=${ratio.toFixed(2)}`).toBeLessThan(2.5);
    expect(ratio).toBeGreaterThan(0.4);
  });

  it('never verifies true for an arbitrary password (it is not a usable credential)', async () => {
    expect(await verifyPassword('', DUMMY_ARGON2_HASH)).toBe(false);
    expect(await verifyPassword('password', DUMMY_ARGON2_HASH)).toBe(false);
    expect(await verifyPassword('CorrectHorse123!', DUMMY_ARGON2_HASH)).toBe(false);
  });
});
