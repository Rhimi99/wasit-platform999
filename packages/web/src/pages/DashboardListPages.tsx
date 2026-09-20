import { AppLayout } from '@/components/layouts/AppLayout';
import { useI18n } from '@/lib/i18n-context';
import { Card, EmptyState, SectionHeader } from '@/components/ui';

// شاشات القوائم داخل لوحات التجار/الموردين/الشركات.
// تُربط بواجهات الـ Backend للكيانات (suppliers/merchants/companies) عند توفرها.
export function DashboardListPage({ kind }: { kind: 'suppliers' | 'customers' | 'buyers' | 'branches' | 'employees' | 'merchants' }) {
  const { t } = useI18n();
  const titles: Record<string, string> = {
    suppliers: t('dashboard.suppliers'),
    customers: t('dashboard.customers'),
    buyers: t('dashboard.buyers'),
    branches: t('dashboard.branches'),
    employees: t('dashboard.employees'),
    merchants: t('dashboard.merchants'),
  };
  return (
    <AppLayout>
      <SectionHeader title={titles[kind]} />
      <Card>
        <EmptyState title={t('common.noData')} hint={titles[kind]} />
      </Card>
    </AppLayout>
  );
}

export function DashboardFinancePage() {
  const { t } = useI18n();
  return (
    <AppLayout>
      <SectionHeader title={t('dashboard.finance')} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Card><p className="text-xs text-slate-500">{t('order.items')}</p><p className="text-2xl font-bold text-slate-800">—</p></Card>
        <Card><p className="text-xs text-slate-500">{t('order.commission')}</p><p className="text-2xl font-bold text-slate-800">—</p></Card>
        <Card><p className="text-xs text-slate-500">{t('order.settlement')}</p><p className="text-2xl font-bold text-wasit-700">—</p></Card>
      </div>
    </AppLayout>
  );
}

export function DashboardReportsPage() {
  const { t } = useI18n();
  return (
    <AppLayout>
      <SectionHeader title={t('dashboard.reports')} />
      <Card>
        <p className="text-sm text-slate-600">{t('reports.roadmap')}</p>
      </Card>
    </AppLayout>
  );
}