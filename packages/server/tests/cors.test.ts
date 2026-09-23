import { describe, it, expect } from 'vitest';

// Set before importing the app so the env module parses this value. Vitest
// isolates modules per test file, so this does not affect other suites.
process.env.CORS_ORIGIN = 'https://allowed.example';

const { createApp } = await import('../src/app.js');
const { env, resolveCorsOrigin } = await import('../src/lib/env.js');

describe('Credentialed CORS origin policy', () => {
  it('reflects any origin when CORS_ORIGIN is unset (dev/test default)', () => {
    const previous = env.CORS_ORIGIN;
    env.CORS_ORIGIN = '';
    expect(resolveCorsOrigin('https://evil.example')).toBe('https://evil.example');
    expect(resolveCorsOrigin(undefined)).toBe('*');
    env.CORS_ORIGIN = previous;
  });

  it('echoes only allow-listed origins when configured', () => {
    expect(resolveCorsOrigin('https://allowed.example')).toBe('https://allowed.example');
    expect(resolveCorsOrigin('https://evil.example')).toBeNull();
    expect(resolveCorsOrigin(undefined)).toBeNull();
  });

  it("always trusts the platform's own app origin", () => {
    const appOrigin = env.APP_URL.replace(/\/$/, '');
    expect(resolveCorsOrigin(appOrigin)).toBe(appOrigin);
  });

  it('omits Access-Control-Allow-Origin for a foreign origin, but keeps the session cookie usable same-origin', async () => {
    const app = createApp();
    const foreign = await app.request('/api/health/ready', {
      headers: { Origin: 'https://evil.example' },
    });
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();

    const own = await app.request('/api/health/ready', {
      headers: { Origin: 'https://allowed.example' },
    });
    expect(own.headers.get('access-control-allow-origin')).toBe('https://allowed.example');
  });
});
