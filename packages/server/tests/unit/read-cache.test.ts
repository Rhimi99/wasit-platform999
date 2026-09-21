import { describe, it, expect } from 'vitest';
import { MemoryReadCache, NoopReadCache } from '../../src/lib/cache/memory.js';

/** A clock the test advances by hand, so TTL behaviour is not wall-clock bound. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('MemoryReadCache', () => {
  it('stores and returns a value until its TTL lapses', async () => {
    const clock = fakeClock();
    const cache = new MemoryReadCache(10, clock.now);

    await cache.set('geo:countries', '{"a":1}', 60);
    expect(await cache.get('geo:countries')).toBe('{"a":1}');

    clock.advance(59_000);
    expect(await cache.get('geo:countries')).toBe('{"a":1}');

    clock.advance(2_000);
    expect(await cache.get('geo:countries')).toBeNull();
  });

  it('ignores a zero or negative TTL instead of storing a dead entry', async () => {
    const cache = new MemoryReadCache(10);
    await cache.set('k', 'v', 0);
    await cache.set('k2', 'v', -5);
    expect(await cache.get('k')).toBeNull();
    expect((await cache.stats()).entries).toBe(0);
  });

  it('evicts the least-recently-used entry past the bound', async () => {
    const cache = new MemoryReadCache(2);
    await cache.set('a', '1', 60);
    await cache.set('b', '2', 60);
    // Touch `a` so `b` becomes the least recently used.
    expect(await cache.get('a')).toBe('1');
    await cache.set('c', '3', 60);

    expect(await cache.get('b')).toBeNull();
    expect(await cache.get('a')).toBe('1');
    expect(await cache.get('c')).toBe('3');
    expect((await cache.stats()).entries).toBe(2);
  });

  it('invalidates every key under a prefix and leaves the rest', async () => {
    const cache = new MemoryReadCache(10);
    await cache.set('geo:countries', '1', 60);
    await cache.set('geo:regions:tn', '2', 60);
    await cache.set('categories:active', '3', 60);

    expect(await cache.invalidatePrefix('geo:')).toBe(2);
    expect(await cache.get('geo:countries')).toBeNull();
    expect(await cache.get('geo:regions:tn')).toBeNull();
    expect(await cache.get('categories:active')).toBe('3');
  });

  it('tracks hits, misses and hit rate', async () => {
    const cache = new MemoryReadCache(10);
    expect((await cache.stats()).hitRate).toBeNull();

    await cache.set('k', 'v', 60);
    await cache.get('k');
    await cache.get('k');
    await cache.get('missing');

    const stats = await cache.stats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBeCloseTo(2 / 3, 5);
  });

  it('clear removes entries and resets counters', async () => {
    const cache = new MemoryReadCache(10);
    await cache.set('k', 'v', 60);
    await cache.get('k');
    await cache.clear();
    const stats = await cache.stats();
    expect(stats.entries).toBe(0);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
  });
});

describe('NoopReadCache', () => {
  it('never returns a value and reports an empty state', async () => {
    const cache = new NoopReadCache();
    await cache.set('k', 'v', 60);
    expect(await cache.get('k')).toBeNull();
    expect(await cache.invalidatePrefix('geo:')).toBe(0);
    expect(await cache.stats()).toEqual({ entries: 0, hits: 0, misses: 0, hitRate: null });
  });
});
