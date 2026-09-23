import { useEffect, useRef, useState } from 'react';
import { api, apiCall } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { Badge } from '@/components/ui';
import type { ServedAdRow } from '@/lib/types';

/**
 * Anonymous per-tab id so the Advertising Engine can group a visit's impressions
 * without persisting anything identifying. Kept in sessionStorage: a reload keeps
 * the same visit, closing the tab starts a new one.
 */
function visitSessionId(): string {
  const key = 'wasit.adSession';
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const id = `web_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(key, id);
    return id;
  } catch {
    return `web_${Date.now().toString(36)}`;
  }
}

/**
 * Renders the sponsored creatives the Advertising Engine serves for a placement
 * and reports the impression. A click is reported before navigation so the
 * campaign's CTR reflects real activity rather than being permanently zero.
 */
export function AdSlot({ placement, className = '' }: { placement: string; className?: string }) {
  const { t } = useI18n();
  const [ads, setAds] = useState<ServedAdRow[]>([]);
  const reported = useRef<Set<string>>(new Set());

  useEffect(() => {
    let mounted = true;
    apiCall(() => api.servedAds({ placement })).then((res) => {
      if (!mounted) return;
      setAds(res.data?.items ?? []);
    });
    return () => {
      mounted = false;
    };
  }, [placement]);

  useEffect(() => {
    const session = visitSessionId();
    for (const ad of ads) {
      if (reported.current.has(ad.creativeId)) continue;
      reported.current.add(ad.creativeId);
      void api.recordAdEvent({
        campaignId: ad.campaignId,
        creativeId: ad.creativeId,
        eventType: 'IMPRESSION',
        sessionId: session,
      });
    }
  }, [ads]);

  const onClick = (ad: ServedAdRow) => {
    const payload = JSON.stringify({
      campaignId: ad.campaignId,
      creativeId: ad.creativeId,
      eventType: 'CLICK',
      sessionId: visitSessionId(),
    });
    // A click navigates away immediately, which aborts an in-flight fetch. Beacon
    // is queued by the browser and survives the unload, so the click is not lost.
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/ads/events', new Blob([payload], { type: 'application/json' }));
      return;
    }
    void api.recordAdEvent({
      campaignId: ad.campaignId,
      creativeId: ad.creativeId,
      eventType: 'CLICK',
      sessionId: visitSessionId(),
    });
  };

  if (ads.length === 0) return null;

  return (
    <section className={className} data-testid={`ad-slot-${placement}`}>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-slate-700">{t('ads.sponsored')}</h2>
        <Badge color="amber">{t('ads.sponsoredBadge')}</Badge>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {ads.map((ad) => {
          const body = (
            <>
              {ad.mediaUrl ? (
                <img src={ad.mediaUrl} alt={ad.title} className="h-36 w-full rounded-md object-cover" />
              ) : (
                <div className="flex h-36 w-full items-center justify-center rounded-md bg-amber-50 text-2xl">📣</div>
              )}
              <p className="mt-3 text-sm font-semibold text-slate-800">{ad.title}</p>
              {ad.body && <p className="mt-1 line-clamp-2 text-xs text-slate-500">{ad.body}</p>}
              <p className="mt-2 text-[11px] text-slate-400">{ad.advertiserType} · {ad.objective}</p>
            </>
          );
          const testId = `ad-card-${ad.creativeId}`;
          return ad.targetUrl ? (
            <a
              key={ad.creativeId}
              href={ad.targetUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid={testId}
              onClick={() => onClick(ad)}
              className="card block p-4 transition-colors hover:border-wasit-300"
            >
              {body}
            </a>
          ) : (
            <div key={ad.creativeId} data-testid={testId} className="card p-4">
              {body}
            </div>
          );
        })}
      </div>
    </section>
  );
}
