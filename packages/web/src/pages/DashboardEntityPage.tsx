import { useEffect, useState } from 'react';
import { api, apiCall } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type { CompanyProfile, EntityProfileType, MerchantProfile, MyEntities, SupplierProfile } from '@/lib/types';

type Profile = MerchantProfile | SupplierProfile | CompanyProfile;

const NAME_FIELD: Record<EntityProfileType, 'storeName' | 'companyName' | 'legalName'> = {
  merchant: 'storeName',
  supplier: 'companyName',
  company: 'legalName',
};

const NAME_LABEL_KEY: Record<EntityProfileType, string> = {
  merchant: 'entity.storeName',
  supplier: 'entity.companyName',
  company: 'entity.legalName',
};

const TYPE_LABEL_KEY: Record<EntityProfileType, string> = {
  merchant: 'entity.typeMerchant',
  supplier: 'entity.typeSupplier',
  company: 'entity.typeCompany',
};

function profileName(profile: Profile): string {
  if (profile.type === 'merchant') return profile.storeName;
  if (profile.type === 'supplier') return profile.companyName;
  return profile.legalName;
}

/**
 * ENTITY-01 — self-service editor for the caller's own merchant/supplier/company
 * profile. The three tables do not share column names, so the form is built from
 * the profile `type` rather than from a shared field list.
 */
export function DashboardEntityPage() {
  const { t } = useI18n();
  const [entities, setEntities] = useState<MyEntities | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const [name, setName] = useState('');
  const [countryId, setCountryId] = useState('');
  const [cityId, setCityId] = useState('');
  const [industry, setIndustry] = useState('');
  const [description, setDescription] = useState('');
  const [logoUrl, setLogoUrl] = useState('');

  const profile: Profile | null = entities?.merchant ?? entities?.supplier ?? entities?.company ?? null;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    apiCall(() => api.myEntityProfiles()).then((res) => {
      if (!active) return;
      setLoading(false);
      if (res.error) {
        setError(res.error);
        return;
      }
      const next = res.data ?? { merchant: null, supplier: null, company: null };
      setEntities(next);
      const first = next.merchant ?? next.supplier ?? next.company;
      if (first) {
        setName(profileName(first));
        setCountryId(first.countryId ?? '');
        setCityId(first.cityId ?? '');
        setIndustry(first.type === 'company' ? first.industry ?? '' : '');
        setDescription(first.description ?? '');
        setLogoUrl(first.logoUrl ?? '');
      }
    });
    return () => { active = false; };
  }, [reloadKey]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!profile) return;
    setSaving(true);
    setError(null);
    setNotice(null);

    const payload: Record<string, unknown> = {
      [NAME_FIELD[profile.type]]: name.trim(),
      countryId: countryId.trim() || null,
      cityId: cityId.trim() || null,
      description: description.trim() || null,
      logoUrl: logoUrl.trim() || null,
    };
    if (profile.type === 'company') payload.industry = industry.trim() || null;

    const res = await apiCall(() => api.updateMyEntity(profile.type, payload));
    setSaving(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setNotice(res.data?.changed ? t('entity.saved') : t('entity.noChanges'));
    setReloadKey((k) => k + 1);
  }

  return (
    <AppLayout>
      <SectionHeader title={t('entity.title')} subtitle={t('entity.subtitle')} />

      {loading && <Spinner />}
      {!loading && error && !entities && <ErrorState message={error} onRetry={() => setReloadKey((k) => k + 1)} />}

      {!loading && entities && !profile && (
        <EmptyState title={t('entity.none')} hint={t('entity.noneHint')} />
      )}

      {profile && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" data-testid="entity-profile-form">
              <div className="sm:col-span-2">
                <label className="label" htmlFor="entity-name">{t(NAME_LABEL_KEY[profile.type])} *</label>
                <input
                  id="entity-name"
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  minLength={2}
                  maxLength={250}
                />
              </div>
              <div>
                <label className="label" htmlFor="entity-country">{t('field.country')}</label>
                <input id="entity-country" className="input" value={countryId} onChange={(e) => setCountryId(e.target.value)} maxLength={36} />
              </div>
              <div>
                <label className="label" htmlFor="entity-city">{t('field.city')}</label>
                <input id="entity-city" className="input" value={cityId} onChange={(e) => setCityId(e.target.value)} maxLength={36} />
              </div>
              {profile.type === 'company' && (
                <div className="sm:col-span-2">
                  <label className="label" htmlFor="entity-industry">{t('entity.industry')}</label>
                  <input id="entity-industry" className="input" value={industry} onChange={(e) => setIndustry(e.target.value)} maxLength={150} />
                </div>
              )}
              <div className="sm:col-span-2">
                <label className="label" htmlFor="entity-logo">{t('entity.logoUrl')}</label>
                <input id="entity-logo" className="input" dir="ltr" value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} maxLength={2000} />
              </div>
              <div className="sm:col-span-2">
                <label className="label" htmlFor="entity-description">{t('form.description')}</label>
                <textarea
                  id="entity-description"
                  className="input min-h-24"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={5000}
                />
              </div>
              <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
                <button type="submit" className="btn btn-primary" disabled={saving} data-testid="entity-save">
                  {saving ? t('entity.saving') : t('common.save')}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={saving}
                  onClick={() => {
                    setName(profileName(profile));
                    setCountryId(profile.countryId ?? '');
                    setCityId(profile.cityId ?? '');
                    setIndustry(profile.type === 'company' ? profile.industry ?? '' : '');
                    setDescription(profile.description ?? '');
                    setLogoUrl(profile.logoUrl ?? '');
                    setNotice(null);
                    setError(null);
                  }}
                >
                  {t('entity.reset')}
                </button>
                {notice && <span className="text-sm text-emerald-700" role="status">{notice}</span>}
              </div>
              {error && <p className="sm:col-span-2 text-sm text-red-600" role="alert">{error}</p>}
            </form>
          </Card>

          <Card>
            <h3 className="mb-3 text-sm font-semibold text-slate-700">{t('entity.statusTitle')}</h3>
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-2">
                <span className="text-slate-500">{t('entity.type')}</span>
                <Badge color="teal">{t(TYPE_LABEL_KEY[profile.type])}</Badge>
              </div>
              <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-2">
                <span className="text-slate-500">{t('entity.verification')}</span>
                <Badge color={profile.verified ? 'green' : 'amber'}>
                  {profile.verified ? t('entity.verified') : t('entity.unverified')}
                </Badge>
              </div>
              <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-2">
                <span className="text-slate-500">{t('entity.accountState')}</span>
                <Badge color={profile.isActive ? 'green' : 'red'}>
                  {profile.isActive ? t('entity.active') : t('entity.inactive')}
                </Badge>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500">{t('entity.slug')}</span>
                <span className="text-xs text-slate-600" dir="ltr">{profile.slug}</span>
              </div>
            </div>
            <p className="mt-3 rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-500">
              {t('entity.protectedNote')}
            </p>
          </Card>
        </div>
      )}
    </AppLayout>
  );
}
