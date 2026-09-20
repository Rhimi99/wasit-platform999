import { useEffect, useState } from 'react';
import { AppLayout } from '@/components/layouts/AppLayout';
import { useI18n } from '@/lib/i18n-context';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import { api, apiCall, formatMoney } from '@/lib/api';
import type { CampaignStats, CampaignSummary, MyAnalyticsOverview } from '@/lib/types';

export function DashboardAdsPage() {
  const { t } = useI18n();
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [advertisers, setAdvertisers] = useState<Array<{ id: string; type: 'MERCHANT' | 'SUPPLIER' | 'COMPANY'; name: string }>>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stats, setStats] = useState<CampaignStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ title: '', objective: 'PRODUCT_ADS', budget: '100', advertiserId: '', advertiserType: 'SUPPLIER', endsAt: '' });
  const [notice, setNotice] = useState<string | null>(null);
  const [recs, setRecs] = useState<{
    totalCampaigns: number;
    activeCampaigns: number;
    totalSpent: string;
    totalBudget: string;
    averageCtr: number;
    averageConversionRate: number;
    bestObjective: string;
    note: string;
  } | null>(null);
  const [recsLoading, setRecsLoading] = useState(false);

  const loadCampaigns = async () => {
    const res = await apiCall(() => api.listCampaigns({ pageSize: 100 }));
    if (res.error) { setError(res.error); return; }
    setCampaigns(res.data?.items ?? []);
    setError(null);
  };

  const loadAdvertisers = async () => {
    const res = await apiCall(() => api.myAdvertisers());
    if (!res.error && res.data) setAdvertisers(res.data.items);
  };

  const loadStats = async (id: string) => {
    const res = await apiCall(() => api.campaignStats(id));
    if (!res.error && res.data) setStats(res.data);
    else setStats(null);
  };

  useEffect(() => {
    (async () => {
      await Promise.all([loadCampaigns(), loadAdvertisers()]);
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (selectedId) void loadStats(selectedId);
    else setStats(null);
  }, [selectedId]);

  const loadRecs = async () => {
    setRecsLoading(true);
    const res = await apiCall(() => api.adsRecommendations());
    setRecsLoading(false);
    if (!res.error && res.data) setRecs(res.data.data);
  };

  useEffect(() => {
    void loadRecs();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setNotice(null);
    const res = await apiCall(() =>
      api.createCampaign({
        advertiserId: form.advertiserId,
        advertiserType: form.advertiserType,
        title: form.title,
        objective: form.objective,
        budget: form.budget,
        currencyCode: 'TND',
        startsAt: new Date().toISOString(),
        endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null,
      }),
    );
    setCreating(false);
    if (res.error) { setError(res.error); return; }
    setNotice(t('ads.createdNotice'));
    await loadCampaigns();
    if (res.data) setSelectedId(res.data.id);
    setForm((f) => ({ ...f, title: '', budget: '100' }));
  };

  const updateStatus = async (id: string, status: string) => {
    setNotice(null);
    const res = await apiCall(() => api.updateCampaign(id, { status }));
    if (res.error) { setError(res.error); return; }
    setNotice(t('ads.updatedNotice'));
    await loadCampaigns();
  };

  const objectiveLabel = (o: string) => {
    const labels: Record<string, string> = {
      PRODUCT_ADS: t('ads.objective.product'),
      STORE_ADS: t('ads.objective.store'),
      SUPPLIER_ADS: t('ads.objective.supplier'),
      COMPANY_ADS: t('ads.objective.company'),
      B2B_ADS: t('ads.objective.b2b'),
      B2C_ADS: t('ads.objective.b2c'),
    };
    return labels[o] ?? o;
  };

  const statusColor = (s: string) =>
    s === 'ACTIVE' ? 'green' : s === 'PAUSED' ? 'amber' : s === 'COMPLETED' ? 'indigo' : s === 'CANCELLED' ? 'red' : 'slate';

  const inputCls = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-wasit-500 focus:outline-none';
  const btn = (extra: string) => `rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${extra}`;

  return (
    <AppLayout>
      <SectionHeader title={t('ads.title')} subtitle={t('ads.subtitle')} />
      {error && <ErrorState message={error} onRetry={() => { setError(null); void loadCampaigns(); }} />}
      {notice && <div className="mb-3 rounded-md border border-wasit-200 bg-wasit-50 px-4 py-2 text-sm text-wasit-800">{notice}</div>}

      {loading ? (
        <Spinner />
      ) : (
        <div className="space-y-6">
          {/* AI Ads Recommendations */}
          <Card>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-700">{t('ads.aiRecommendations.title')}</h3>
              <button type="button" disabled={recsLoading} onClick={() => void loadRecs()} className={btn('bg-wasit-600 text-white hover:bg-wasit-700 disabled:opacity-50')}>
                {recsLoading ? t('ads.aiRecommendations.loading') : t('ads.aiRecommendations.refresh')}
              </button>
            </div>
            {recs ? (
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs text-slate-500">{t('ads.aiRecommendations.campaigns')}</p>
                  <p className="mt-1 text-lg font-semibold text-slate-800">{recs.totalCampaigns}</p>
                </div>
                <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs text-slate-500">{t('ads.aiRecommendations.ctr')}</p>
                  <p className="mt-1 text-lg font-semibold text-slate-800">{(recs.averageCtr * 100).toFixed(2)}%</p>
                </div>
                <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs text-slate-500">{t('ads.aiRecommendations.bestObjective')}</p>
                  <p className="mt-1 text-lg font-semibold text-wasit-700">{recs.bestObjective}</p>
                </div>
                <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs text-slate-500">{t('ads.aiRecommendations.spentVsBudget')}</p>
                  <p className="mt-1 text-lg font-semibold text-slate-800">{recs.totalSpent} / {recs.totalBudget} TND</p>
                </div>
                <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs text-slate-500">{t('ads.aiRecommendations.conversionRate')}</p>
                  <p className="mt-1 text-lg font-semibold text-slate-800">{(recs.averageConversionRate * 100).toFixed(2)}%</p>
                </div>
                <div className="rounded-md border border-slate-200 bg-slate-50 p-3 sm:col-span-3">
                  <p className="text-xs text-slate-500">{t('ads.aiRecommendations.insight')}</p>
                  <p className="mt-1 text-sm text-slate-700">{recs.note}</p>
                </div>
              </div>
            ) : (
              <div className="mt-3 text-sm text-slate-500">{t('ads.aiRecommendations.empty')}</div>
            )}
          </Card>

          {/* Create campaign */}
          <Card>
            <h3 className="text-sm font-semibold text-slate-700">{t('ads.createCampaign')}</h3>
            <form onSubmit={handleCreate} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <input className={`${inputCls} sm:col-span-2`} placeholder={t('ads.form.title')} value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} required />
              <select className={inputCls} value={form.objective} onChange={(e) => setForm((f) => ({ ...f, objective: e.target.value }))}>
                {['PRODUCT_ADS', 'STORE_ADS', 'SUPPLIER_ADS', 'COMPANY_ADS', 'B2B_ADS', 'B2C_ADS'].map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
              <input className={inputCls} type="number" min="1" step="0.001" placeholder={t('ads.form.budget')} value={form.budget} onChange={(e) => setForm((f) => ({ ...f, budget: e.target.value }))} />
              {advertisers.length > 0 ? (
                <select className={inputCls} value={form.advertiserId} onChange={(e) => {
                  const adv = advertisers.find((a) => a.id === e.target.value);
                  setForm((f) => ({ ...f, advertiserId: e.target.value, advertiserType: adv?.type ?? f.advertiserType }));
                }}>
                  <option value="">{t('ads.form.entity')}</option>
                  {advertisers.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.type})</option>)}
                </select>
              ) : (
                <input className={inputCls} placeholder={t('ads.form.entityId')} value={form.advertiserId} onChange={(e) => setForm((f) => ({ ...f, advertiserId: e.target.value }))} />
              )}
              <button type="submit" disabled={creating || !form.advertiserId} className={`${btn('bg-wasit-600 text-white hover:bg-wasit-700 disabled:opacity-50')} sm:col-span-2 lg:col-span-1`}>
                {creating ? t('common.processing') : t('ads.create')}
              </button>
            </form>
          </Card>

          {/* Campaigns list */}
          <div>
            <h3 className="mb-2 text-sm font-semibold text-slate-700">{t('ads.myCampaigns')}</h3>
            {campaigns.length === 0 ? (
              <EmptyState title={t('ads.noCampaigns')} hint={t('ads.noCampaignsHint')} />
            ) : (
              <div className="grid gap-3">
                {campaigns.map((cp) => (
                  <Card key={cp.id} className={`cursor-pointer hover:border-wasit-300 ${selectedId === cp.id ? 'border-wasit-400 ring-1 ring-wasit-200' : ''}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2" onClick={() => setSelectedId(selectedId === cp.id ? null : cp.id)}>
                      <div>
                        <p className="text-sm font-semibold text-slate-800">{cp.title}</p>
                        <p className="text-xs text-slate-400">{objectiveLabel(cp.objective)} · {cp.currencyCode}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge color={statusColor(cp.status) as 'green'}>{cp.status}</Badge>
                        <span className="text-xs text-slate-500">{t('ads.spentOf')} {Number(cp.spent)} / {Number(cp.budget)}</span>
                      </div>
                    </div>
                    {selectedId === cp.id && (
                      <div className="mt-3 space-y-3 border-t border-slate-100 pt-3">
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                          {[['impressions', stats?.impressions], ['clicks', stats?.clicks], ['conversions', stats?.conversions], ['ctr', stats ? `${(stats.ctr * 100).toFixed(2)}%` : '—']].map(([k, v]) => (
                            <div key={k as string} className="rounded-md bg-slate-50 p-2 text-center">
                              <p className="text-lg font-bold text-slate-800">{v ?? '—'}</p>
                              <p className="text-[10px] text-slate-400">{t(`ads.${k}` as never)}</p>
                            </div>
                          ))}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button className={btn('bg-wasit-600 text-white hover:bg-wasit-700')} disabled={cp.status === 'ACTIVE'} onClick={() => void updateStatus(cp.id, 'ACTIVE')}>{t('ads.activate')}</button>
                          {cp.status === 'ACTIVE' && <button className={btn('bg-amber-500 text-white hover:bg-amber-600')} onClick={() => void updateStatus(cp.id, 'PAUSED')}>{t('ads.pause')}</button>}
                          {cp.status !== 'DRAFT' && <button className={btn('bg-amber-500 text-white hover:bg-amber-600')} onClick={() => void updateStatus(cp.id, 'ACTIVE')}>{t('ads.resume')}</button>}
                          {cp.status === 'DRAFT' && <button className={btn('bg-red-600 text-white hover:bg-red-700')} onClick={() => void updateStatus(cp.id, 'CANCELLED')}>{t('ads.cancel')}</button>}
                          {cp.status === 'ACTIVE' && <button className={btn('bg-red-600 text-white hover:bg-red-700')} onClick={() => void updateStatus(cp.id, 'COMPLETED')}>{t('ads.end')}</button>}
                        </div>
                        <AddCreativeCampaign campaignId={cp.id} advertiser={advertisers.find((a) => a.id === cp.advertiserId)} onAdded={() => void loadStats(cp.id)} t={t} />
                      </div>
                    )}
                  </Card>
                ))}
              </div>
            )}
          </div>

          {/* My advertisers */}
          <div>
            <h3 className="mb-2 text-sm font-semibold text-slate-700">{t('ads.myEntities')}</h3>
            <div className="flex flex-wrap gap-2">
              {advertisers.length === 0 ? (
                <p className="text-xs text-slate-400">{t('ads.noEntities')}</p>
              ) : (
                advertisers.map((a) => (
                  <span key={a.id} className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600">
                    <Badge color={a.type === 'SUPPLIER' ? 'teal' : a.type === 'MERCHANT' ? 'indigo' : 'amber'}>{a.type}</Badge> {a.name}
                  </span>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </AppLayout>
  );
}

function AddCreativeCampaign({ campaignId, advertiser, onAdded, t }: {
  campaignId: string;
  advertiser: { id: string; type: string; name: string } | undefined;
  onAdded: () => void;
  t: (k: string) => string;
}) {
  const [type, setType] = useState('BANNER');
  const [title, setTitle] = useState('');
  const [targetUrl, setTargetUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    const res = await apiCall(() => api.addCreative(campaignId, { type, title, targetUrl: targetUrl || null }));
    setBusy(false);
    if (!res.error) {
      setTitle('');
      setTargetUrl('');
      onAdded();
    }
  };

  void advertiser;
  const inputCls = 'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-wasit-500 focus:outline-none';
  return (
    <form onSubmit={handleAdd} className="grid gap-2 sm:grid-cols-4">
      <select className={inputCls} value={type} onChange={(e) => setType(e.target.value)}>
        <option value="BANNER">BANNER</option>
        <option value="TEXT">TEXT</option>
        <option value="VIDEO">VIDEO</option>
      </select>
      <input className={inputCls} placeholder={t('ads.form.creativeTitle')} value={title} onChange={(e) => setTitle(e.target.value)} />
      <input className={inputCls} placeholder={t('ads.form.targetUrl')} value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} />
      <button type="submit" disabled={busy || !title.trim()} className="rounded-md bg-slate-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50">
        {busy ? t('common.processing') : t('ads.addCreative')}
      </button>
    </form>
  );
}

export function DashboardAnalyticsPage() {
  const { t } = useI18n();
  const [data, setData] = useState<MyAnalyticsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    setLoading(true);
    apiCall(() => api.myAnalyticsOverview()).then((res) => {
      setData(res.data);
      setError(res.error);
      setLoading(false);
    });
  }, [reloadKey]);

  return (
    <AppLayout>
      <SectionHeader title={t('analytics.title')} subtitle={t('analytics.ownSubtitle')} />
      {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={() => setReloadKey((k) => k + 1)} /> : !data?.hasBusinessEntity ? (
        <EmptyState title={t('analytics.noBusiness')} hint={t('analytics.noBusinessHint')} />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <p className="text-xs text-slate-500">{t('analytics.store')}</p>
              <p className="mt-1 truncate text-lg font-semibold text-slate-900">{data.sellerName ?? t('analytics.store')}</p>
            </Card>
            <Card>
              <p className="text-xs text-slate-500">{t('analytics.gmv')}</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">{formatMoney(data.gmvAsSeller)}</p>
            </Card>
            <Card>
              <p className="text-xs text-slate-500">{t('analytics.orders')}</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">{data.ordersAsSeller}</p>
            </Card>
            <Card>
              <p className="text-xs text-slate-500">{t('order.sellerCommission')}</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">{formatMoney(data.commissionAsSeller)}</p>
            </Card>
            <Card>
              <p className="text-xs text-slate-500">{t('analytics.products')}</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">{data.products}</p>
            </Card>
            <Card>
              <p className="text-xs text-slate-500">{t('analytics.publishedProducts')}</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">{data.publishedProducts}</p>
            </Card>
            <Card>
              <p className="text-xs text-slate-500">{t('analytics.customers')}</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">{data.customers}</p>
            </Card>
            <Card>
              <p className="text-xs text-slate-500">{t('analytics.avgOrderValue')}</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">{formatMoney(data.avgOrderValue)}</p>
            </Card>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="border-amber-200 bg-amber-50">
              <p className="text-xs text-slate-500">{t('analytics.inventoryItems')}</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">{data.inventoryItems}</p>
            </Card>
            <Card className="border-amber-200 bg-amber-50">
              <p className="text-xs text-slate-500">{t('analytics.lowStock')}</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">{data.lowStock}</p>
            </Card>
            <Card className="border-red-200 bg-red-50">
              <p className="text-xs text-slate-500">{t('analytics.outOfStock')}</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">{data.outOfStock}</p>
            </Card>
            <Card>
              <p className="text-xs text-slate-500">{t('analytics.activeCampaigns')}</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">{data.activeCampaigns} <span className="text-sm text-slate-400">/ {data.campaigns}</span></p>
            </Card>
          </div>
        </>
      )}
    </AppLayout>
  );
}

export function DashboardAIPage() {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.aiStatus>> | null>(null);
  const [budget, setBudget] = useState<Awaited<ReturnType<typeof api.aiMyBudget>> | null>(null);
  const [models, setModels] = useState<Array<{ key: string; displayName: string; provider: string; isActive: boolean }>>([]);
  const [agents, setAgents] = useState<Array<{ key: string; name: string; description: string; requiresHumanApproval: boolean }>>([]);
  const [activity, setActivity] = useState<Array<{ id: string; requestType: string; model: string; tokensInput: number; tokensOutput: number; cost: string; createdAt: string }>>([]);
  const [agentStatus, setAgentStatus] = useState<Record<string, string>>({});
  const [runTool, setRunTool] = useState<string | null>(null);
  const [runInput, setRunInput] = useState('');
  const [runResult, setRunResult] = useState<{ content?: string; data?: Record<string, unknown>; model?: string; cost?: string } | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const tools = [
    { name: t('ai.tool.recommendations'), key: 'recommendations' },
    { name: t('ai.tool.smartSearch'), key: 'smartSearch' },
    { name: t('ai.tool.marketAnalysis'), key: 'marketAnalysis' },
    { name: t('ai.tool.priceIntelligence'), key: 'priceIntelligence' },
    { name: t('ai.tool.supplierRecommendations'), key: 'supplierRecommendations' },
    { name: t('ai.tool.salesIntelligence'), key: 'salesIntelligence' },
  ];

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    const [st, bd, md, ag, ac] = await Promise.all([
      apiCall(() => api.aiStatus()),
      apiCall(() => api.aiMyBudget()),
      apiCall(() => api.aiModels()),
      apiCall(() => api.aiAgents()),
      apiCall(() => api.aiActivity()),
    ]);
    if (st.error && bd.error && md.error && ag.error && ac.error) {
      setError(st.error);
    }
    if (st.data) setStatus(st.data);
    if (bd.data) setBudget(bd.data);
    if (md.data) setModels(md.data.items);
    if (ag.data) setAgents(ag.data.agents);
    if (ac.data) setActivity(ac.data.items);
    setLoading(false);
  };

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const agentInputFor = (agentKey: string): Record<string, unknown> => {
    switch (agentKey) {
      case 'product-agent':
        return { action: 'analyze_product', productId: runInput || undefined };
      case 'risk-agent':
        return { action: 'assess_risk', userId: runInput || undefined };
      case 'sales-agent':
        return { action: 'identify_leads', periodDays: 30, limit: 5 };
      case 'marketing-agent':
        return { action: 'recommend_campaign', limit: 5 };
      case 'ads-agent':
        return { action: 'recommend_ads' };
      case 'support-agent':
        return { action: 'draft_reply', limit: 5 };
      case 'analytics-agent':
        return { action: 'generate_report', periodDays: 30, limit: 5 };
      case 'market-research-agent':
        return { action: 'market_overview', limit: 5 };
      case 'b2b-agent':
        return { action: 'match_b2b' };
      case 'dispute-assistant':
        return { action: 'summarize_dispute', limit: 5 };
      case 'development-agent':
        return { action: 'dev_plan' };
      default:
        return { action: 'analyze' };
    }
  };

  /** Renders a structured agent result as pretty JSON (agent tasks store JSON). */
  const parseResultData = (result: unknown): Record<string, unknown> | null => {
    if (result && typeof result === 'object' && 'advice' in (result as Record<string, unknown>)) {
      const advice = (result as { advice?: unknown }).advice;
      if (typeof advice === 'string') {
        try {
          const parsed = JSON.parse(advice);
          if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
        } catch {
          return { advice };
        }
      }
      if (advice && typeof advice === 'object') return advice as Record<string, unknown>;
    }
    return null;
  };

  const runAgent = async (agentKey: string, _name: string) => {
    setRunError(null);
    setAgentStatus((prev) => ({ ...prev, [agentKey]: t('ai.agent.pending') }));
    const res = await apiCall(() => api.aiCreateAgentTask(agentKey, agentInputFor(agentKey)));
    if (res.error) {
      setAgentStatus((prev) => ({ ...prev, [agentKey]: t('ai.agent.failed') }));
      setRunError(res.error);
      void loadAll();
      return;
    }
    const task = res.data;
    if (!task) {
      setAgentStatus((prev) => ({ ...prev, [agentKey]: t('ai.agent.failed') }));
      setRunError(t('ai.run.emptyAgents'));
      void loadAll();
      return;
    }
    if (task.status === 'awaiting_approval') {
      setAgentStatus((prev) => ({ ...prev, [agentKey]: t('ai.agent.pending') }));
      setRunResult({ content: `${t('ai.agents.approval')} — ${task.agentKey}.` });
    } else if (task.status === 'succeeded' || task.status === 'approved') {
      setAgentStatus((prev) => ({ ...prev, [agentKey]: t('ai.agent.succeeded') }));
      const parsed = parseResultData(task.result);
      if (parsed) {
        setRunResult({ data: parsed, model: 'local-heuristic' });
      }
    } else if (task.status === 'failed') {
      setAgentStatus((prev) => ({ ...prev, [agentKey]: t('ai.agent.failed') }));
      setRunError(task.error?.message ?? 'agent failed');
    }
    void loadAll();
  };

  const runFeature = async (toolKey: string) => {
    setRunError(null);
    setRunTool(toolKey);
    try {
      let result: { content?: string; data?: Record<string, unknown>; model?: string; cost?: string };
      let res;
      switch (toolKey) {
        case 'recommendations':
          res = await apiCall(() => api.aiSmartFeatures('recommendations', { limit: 8 }));
          break;
        case 'smartSearch':
          res = await apiCall(() => api.aiSmartFeatures('smart-search', { q: runInput || 'oil' }));
          break;
        case 'marketAnalysis':
          res = await apiCall(() => api.aiMarketAnalysis());
          break;
        case 'priceIntelligence':
          res = await apiCall(() => api.aiPriceIntelligence());
          break;
        case 'supplierRecommendations':
          res = await apiCall(() => api.aiSmartFeatures('supplier-recommendations', { limit: 5 }));
          break;
        case 'salesIntelligence':
          res = await apiCall(() => api.aiSalesIntelligence());
          break;
        default:
          setRunError('unknown tool');
          setRunTool(null);
          return;
      }
      if (res.error) {
        setRunError(res.error);
      } else if (res.data) {
        result = { data: res.data.data, model: res.data.model, cost: res.data.estimate };
        setRunResult(result);
      }
    } finally {
      setRunTool(null);
    }
    void loadAll();
  };

  const executeNow = async (toolKey: string) => {
    await runFeature(toolKey);
  };

  if (loading) return <AppLayout><SectionHeader title={t('dashboard.ai')} /><Spinner /></AppLayout>;

  if (error) {
    return (
      <AppLayout>
        <SectionHeader title={t('dashboard.ai')} />
        <ErrorState message={error} onRetry={() => void loadAll()} />
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <SectionHeader title={t('dashboard.ai')} />

      {/* Status + budget */}
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <p className="text-xs text-slate-500">{t('ai.status.provider')}</p>
          <p className="mt-1 text-lg font-semibold text-slate-800">{status?.provider ?? '—'}</p>
          <Badge color={status?.providerAvailable ? 'green' : 'amber'}>
            {status?.providerAvailable ? t('ai.status.providerAvailable') : t('ai.status.providerUnavailable')}
          </Badge>
        </Card>
        <Card>
          <p className="text-xs text-slate-500">{t('ai.status.model')}</p>
          <p className="mt-1 text-lg font-semibold text-slate-800">{status?.defaultModel ?? '—'}</p>
        </Card>
        <Card>
          <p className="text-xs text-slate-500">{t('ai.status.stats')}</p>
          <p className="mt-1 text-lg font-semibold text-slate-800">
            {t('ai.status.requests')}: {budget?.usage.requests ?? 0}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {t('ai.status.cost')}: {budget?.usage.cost ?? '0'} {budget?.usage.cost ? '' : ''}
          </p>
        </Card>
        <Card>
          <p className="text-xs text-slate-500">{t('ai.status.budget')}</p>
          <p className="mt-1 text-lg font-semibold text-slate-800">${status?.monthlyBudgetUsd ?? '0'}</p>
        </Card>
      </div>

      {/* Models */}
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {models.length === 0 && <EmptyState title={t('ai.empty')} hint={t('ai.models.hint')} />}
        {models.map((m) => (
          <Card key={m.key}>
            <p className="text-sm font-semibold text-slate-800">{m.displayName}</p>
            <p className="mt-1 text-xs text-slate-500">{m.key}</p>
            <p className="mt-1 text-xs text-slate-500">{t('ai.model.provider')}: {m.provider}</p>
            <div className="mt-2">
              <Badge color={m.isActive ? 'green' : 'slate'}>
                {m.isActive ? t('ai.model.active') : t('ai.model.deactive')}
              </Badge>
            </div>
          </Card>
        ))}
      </div>

      {/* Agents */}
      <div className="mb-4">
        <h3 className="mb-2 text-sm font-semibold text-slate-700">{t('ai.agents.title')}</h3>
        <p className="mb-2 text-xs text-slate-400">{t('ai.agents.hint')}</p>
        {agents.length === 0 && <EmptyState title={t('ai.run.emptyAgents')} />}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((a) => (
            <Card key={a.key} className="flex flex-col">
              <p className="text-sm font-semibold text-slate-800">{a.name}</p>
              <p className="mt-1 flex-1 text-xs text-slate-500">{a.description}</p>
              <div className="mt-2 flex items-center justify-between">
                <Badge color={a.requiresHumanApproval ? 'amber' : 'green'}>
                  {a.requiresHumanApproval ? t('ai.agents.approval') : t('ai.agent.succeeded')}
                </Badge>
                <button
                  onClick={() => void runAgent(a.key, a.name)}
                  disabled={agentStatus[a.key] === t('ai.agent.pending')}
                  className="rounded-md border border-wasit-600 px-3 py-1 text-xs font-medium text-wasit-700 hover:bg-wasit-50 disabled:opacity-50"
                >
                  {agentStatus[a.key] === t('ai.agent.pending') ? t('ai.loading') : t('ai.agent.action')}
                </button>
              </div>
            </Card>
          ))}
        </div>
        {Object.entries(agentStatus).filter(([_, v]) => v === t('ai.agent.succeeded')).length > 0 && (
          <p className="mt-2 text-xs text-slate-400">{t('ai.agents.completed')}</p>
        )}
      </div>

      {/* Run a tool */}
      <div className="mb-4 grid gap-3 lg:grid-cols-2">
        <Card>
          <h3 className="mb-2 text-sm font-semibold text-slate-700">{t('ai.run.title')}</h3>
          <input
            value={runInput}
            onChange={(e) => setRunInput(e.target.value)}
            placeholder={t('ai.run.placeholder')}
            className="mb-2 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <div className="flex flex-wrap gap-2">
            {tools.map((tool) => (
              <button
                key={tool.key}
                onClick={() => void executeNow(tool.key)}
                disabled={runTool === tool.key}
                className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:border-wasit-500 hover:text-wasit-700 disabled:opacity-50"
              >
                {runTool === tool.key ? `${tool.name}…` : tool.name}
              </button>
            ))}
          </div>
          {runError && <p className="mt-2 text-xs text-red-600">{runError}</p>}
          {runResult && (
            <div className="mt-3 rounded-md bg-slate-50 p-3 text-xs text-slate-700">
              {runResult.content && <p className="mb-1">{runResult.content}</p>}
              {runResult.data && (
                <>
                  {(runResult.data.recommendation as string | undefined) && (
                    <p className="mb-2 font-medium text-wasit-700">{String(runResult.data.recommendation)}</p>
                  )}
                  {/* Marketing videos are previewable and downloadable in-app */}
                  {Array.isArray(runResult.data.marketingVideos) &&
                    (runResult.data.marketingVideos as Array<Record<string, unknown>>).length > 0 && (
                      <div className="mb-2">
                        <p className="mb-1 font-medium text-slate-700">{t('ai.videos.title')}</p>
                        {(runResult.data.marketingVideos as Array<Record<string, unknown>>).map((v) => (
                          <div key={String(v.id)} className="mb-2 rounded-md border border-slate-200 p-2">
                            <p className="font-medium text-slate-700">{String(v.title)}</p>
                            {v.mediaUrl ? (
                              <div className="mt-1 flex flex-wrap gap-2">
                                <video src={String(v.mediaUrl)} controls className="h-28 rounded-md" />
                                <a
                                  href={String(v.mediaUrl)}
                                  download
                                  className="rounded bg-wasit-600 px-2 py-1 text-white hover:bg-wasit-700"
                                >
                                  {t('ai.videos.download')}
                                </a>
                              </div>
                            ) : (
                              <p className="mt-1 text-amber-600">{t('ai.videos.generating')}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  <pre className="whitespace-pre-wrap break-words">{JSON.stringify(runResult.data, null, 2)}</pre>
                </>
              )}
              <p className="mt-1 text-slate-400">model: {runResult.model ?? '—'}</p>
              {runResult.cost !== undefined && <p className="text-slate-400">cost: {runResult.cost}</p>}
            </div>
          )}
        </Card>

        {/* Recent activity */}
        <Card>
          <h3 className="mb-2 text-sm font-semibold text-slate-700">{t('ai.activity.title')}</h3>
          {activity.length === 0 && <EmptyState title={t('ai.activity.empty')} />}
          <ul className="space-y-2">
            {activity.slice(0, 10).map((a) => (
              <li key={a.id} className="rounded-md border border-slate-100 p-2">
                <p className="text-xs font-medium text-slate-700">{a.requestType}</p>
                <p className="text-xs text-slate-400">model: {a.model} · tokens: {a.tokensInput}+{a.tokensOutput} · cost: {a.cost}</p>
                <p className="text-xs text-slate-400">{new Date(a.createdAt).toLocaleString()}</p>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </AppLayout>
  );
}

export function DashboardSubscriptionsPage() {
  const { t } = useI18n();
  const plans = [
    { name: 'CUSTOMER', price: t('sub.free'), features: [t('sub.feature.browse'), t('sub.feature.ordersB2C'), t('sub.feature.basicVerification')] },
    { name: 'SMALL MERCHANT', price: `19 ${t('sub.monthly')}`, features: [t('sub.feature.productListing'), t('sub.feature.inventory'), t('sub.feature.ownAnalytics')] },
    { name: 'COMPANY', price: `99 ${t('sub.monthly')}`, features: [t('sub.feature.multiUser'), t('sub.feature.ads'), t('sub.feature.aiTools')] },
    { name: 'PRO MAX', price: `299 ${t('sub.monthly')}`, features: [t('sub.feature.allEngines'), t('sub.feature.prioritySupport'), t('sub.feature.apiAccess')] },
  ];
  return (
    <AppLayout>
      <SectionHeader title={t('sub.title')} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {plans.map((p) => (
          <Card key={p.name} className="flex flex-col">
            <h3 className="font-bold text-slate-800">{p.name}</h3>
            <p className="mt-1 text-2xl font-bold text-wasit-700">{p.price}</p>
            <ul className="mt-3 flex-1 space-y-1 text-xs text-slate-500">
              {p.features.map((f) => <li key={f}>• {f}</li>)}
            </ul>
          </Card>
        ))}
      </div>
      <p className="mt-4 text-xs text-slate-400">{t('sub.priceHint')}</p>
    </AppLayout>
  );
}