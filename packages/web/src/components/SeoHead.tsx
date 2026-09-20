import { useEffect } from 'react';
import type { JsonLd } from '@/lib/types';

interface SeoHeadProps {
  title: string;
  description?: string;
  /** Path relative to the site origin, e.g. `/products/123`. Defaults to the current location. */
  canonicalPath?: string;
  /** schema.org object fetched from `/structured-data/...`. */
  jsonLd?: JsonLd | null;
  noindex?: boolean;
}

function upsertMeta(selector: string, attr: 'name' | 'property', key: string, content: string): void {
  let el = document.head.querySelector<HTMLMetaElement>(selector);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

/**
 * Minimal document-head manager for the SPA. Keeps SEO metadata in sync without
 * pulling in a head library: title, description, Open Graph, canonical and JSON-LD.
 */
export function SeoHead({ title, description, canonicalPath, jsonLd, noindex }: SeoHeadProps) {
  useEffect(() => {
    document.title = title;
    if (description) {
      upsertMeta('meta[name="description"]', 'name', 'description', description);
      upsertMeta('meta[property="og:description"]', 'property', 'og:description', description);
    }
    upsertMeta('meta[property="og:title"]', 'property', 'og:title', title);
    upsertMeta('meta[property="og:type"]', 'property', 'og:type', 'website');

    const origin = window.location.origin;
    const path = canonicalPath ?? window.location.pathname;
    const href = `${origin}${path}`;
    upsertMeta('meta[property="og:url"]', 'property', 'og:url', href);

    let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement('link');
      canonical.rel = 'canonical';
      document.head.appendChild(canonical);
    }
    canonical.href = href;

    let robots = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
    if (noindex) {
      if (!robots) {
        robots = document.createElement('meta');
        robots.name = 'robots';
        document.head.appendChild(robots);
      }
      robots.content = 'noindex,nofollow';
    } else if (robots) {
      robots.content = 'index,follow';
    }

    const scriptId = 'wasit-jsonld';
    document.getElementById(scriptId)?.remove();
    if (jsonLd) {
      const script = document.createElement('script');
      script.type = 'application/ld+json';
      script.id = scriptId;
      script.textContent = JSON.stringify(jsonLd);
      document.head.appendChild(script);
    }
  }, [title, description, canonicalPath, jsonLd, noindex]);

  return null;
}