import { useEffect, useState } from 'react';
import { api, apiCall } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import { SeoHead } from '@/components/SeoHead';
import type { PublicLegalDocument } from '@/lib/types';
import { PublicLayout } from '@/components/layouts/PublicLayout';

/**
 * Public legal-document index. The API only ever discloses documents that are
 * published and in force; while nothing is approved the list is empty and the
 * page states that plainly rather than showing placeholder legal text.
 */
export function LegalPage() {
  const { t, locale } = useI18n();
  const [documents, setDocuments] = useState<PublicLegalDocument[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiCall(() => api.publicLegalDocuments()).then((res) => {
      setDocuments(res.data?.items ?? []);
      setError(res.error);
      setLoading(false);
    });
  }, []);

  const lang: 'ar' | 'en' = locale === 'en' ? 'en' : 'ar';

  return (
    <PublicLayout>
      <SeoHead title={`${t('legal.title')} — LE WASSIT`} canonicalPath="/legal" />
      <div className="mx-auto max-w-4xl px-4 py-8">
        <SectionHeader title={t('legal.title')} />
        {loading ? (
          <Spinner />
        ) : error ? (
          <ErrorState message={error} />
        ) : documents.length === 0 ? (
          <EmptyState title={t('legal.empty')} />
        ) : (
          <div className="space-y-4">
            {documents.map((d) => (
              <Card key={d.code} className="p-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-lg font-semibold text-slate-800">{d.title[lang] || d.title.en}</h3>
                  <span className="text-xs text-slate-400">
                    {t('legal.version')} {d.version}
                  </span>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{d.summary[lang] || d.summary.en}</p>
                <p className="mt-3 text-xs text-slate-400">
                  {t('legal.effectiveDate')}: {d.effectiveDate ?? t('legal.notInForce')}
                </p>
              </Card>
            ))}
          </div>
        )}
      </div>
    </PublicLayout>
  );
}
