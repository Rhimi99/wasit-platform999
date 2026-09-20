import { useEffect, useState } from 'react';
import { api, apiCall, ApiClientError } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { useAuth } from '@/lib/auth-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Card, ErrorState, SectionHeader } from '@/components/ui';

export function NotFoundPage() {
  const { t } = useI18n();
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4 text-center">
      <p className="text-6xl font-bold text-wasit-700">404</p>
      <p className="mt-2 text-lg text-slate-600">{t('errors.NOT_FOUND')}</p>
      <a href="/" className="btn-primary mt-6">{t('common.backToHome')}</a>
    </div>
  );
}

// Onboarding: create your business entity (supplier/merchant/company) based on role.
export function DashboardOnboardingPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const isSupplier = user?.roles.includes('SUPPLIER');
  const isMerchant = user?.roles.includes('MERCHANT');
  const isCompany = user?.roles.includes('COMPANY');

  const [kind, setKind] = useState<'supplier' | 'merchant' | 'company'>(isSupplier ? 'supplier' : isMerchant ? 'merchant' : 'company');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (isSupplier && kind !== 'supplier') setKind('supplier');
    else if (isMerchant && kind !== 'merchant') setKind('merchant');
    else if (isCompany && kind !== 'company') setKind('company');
  }, [isSupplier, isMerchant, isCompany, kind]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      let res: { id: string };
      if (kind === 'supplier') res = await api.createSupplier({ companyName: name, description: description || undefined });
      else if (kind === 'merchant') res = await api.createMerchant({ storeName: name, description: description || undefined });
      else res = await api.createCompany({ legalName: name, description: description || undefined });
      setDone(res.id);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AppLayout>
      <SectionHeader title={t('onboarding.title')} />
      <Card className="max-w-xl p-6">
        {done ? (
          <p className="rounded bg-green-50 p-3 text-sm text-green-800" role="status">
            {t('onboarding.created')} <code dir="ltr">{done}</code>
          </p>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="label">{t('onboarding.entityType')}</label>
              <select value={kind} onChange={(e) => setKind(e.target.value as never)} className="input" disabled={!user?.roles.includes('ADMIN')}>
                <option value="supplier">{t('onboarding.supplier')}</option>
                <option value="merchant">{t('onboarding.merchant')}</option>
                <option value="company">{t('onboarding.company')}</option>
              </select>
            </div>
            <div>
              <label className="label">{kind === 'supplier' ? t('onboarding.companyName') : kind === 'merchant' ? t('onboarding.storeName') : t('onboarding.legalName')} *</label>
              <input value={name} onChange={(e) => setName(e.target.value)} className="input" required minLength={2} />
            </div>
            <div>
              <label className="label">{t('onboarding.description')}</label>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="input" />
            </div>
            {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
            <button type="submit" disabled={submitting} className="btn-primary w-full">{submitting ? t('common.loading') : t('onboarding.create')}</button>
          </form>
        )}
        <p className="mt-3 text-xs text-slate-400">{t('onboarding.roleHint')}</p>
      </Card>
    </AppLayout>
  );
}