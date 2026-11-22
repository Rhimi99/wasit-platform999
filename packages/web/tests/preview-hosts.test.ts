import { describe, it, expect } from 'vitest';
import { allowedHosts } from '../vite.config';

/**
 * The demo is served through `vite preview`, whose `allowedHosts` gate rejects
 * any Host header it does not know. The runtime hostname changes whenever the
 * container is recreated, so the demo's own origin has to be read from the
 * environment instead of being hard-coded — while unknown hosts stay refused.
 */
describe('preview allowed hosts', () => {
  it('admits the demo origin declared in APP_URL and CORS_ORIGIN', () => {
    const hosts = allowedHosts({
      APP_URL: 'https://work-9-example.prod-runtime.all-hands.dev',
      CORS_ORIGIN: 'https://shop.example.com, https://alt.example.com',
    });
    expect(hosts).toContain('work-9-example.prod-runtime.all-hands.dev');
    expect(hosts).toContain('shop.example.com');
    expect(hosts).toContain('alt.example.com');
  });

  it('admits explicit WEB_ALLOWED_HOSTS entries with or without a scheme', () => {
    const hosts = allowedHosts({ WEB_ALLOWED_HOSTS: 'a.example.com,https://b.example.com:8443' });
    expect(hosts).toContain('a.example.com');
    expect(hosts).toContain('b.example.com');
  });

  it('never admits a host that was not declared', () => {
    const hosts = allowedHosts({ APP_URL: 'https://demo.example.com' });
    expect(hosts).not.toContain('evil.example.com');
    expect(hosts).not.toContain('*');
  });

  it('ignores malformed entries instead of widening the list', () => {
    const hosts = allowedHosts({ WEB_ALLOWED_HOSTS: '::not a host::', APP_URL: 'not a url' });
    expect(hosts).not.toContain('::not a host::');
    expect(hosts.every((h) => typeof h === 'string' && h.length > 0)).toBe(true);
  });
});
