import { useCallback, useEffect, useMemo, useState } from 'react';
import { SECURITY_READ_SCOPES, api, apiCall } from '@/lib/api';
import type {
  SecurityActionRow,
  SecurityDelegationRow,
  SecurityMyDelegation,
  SecurityActionSpec,
  SecurityAtRiskSession,
  SecurityBlockRow,
  SecurityEventRow,
  SecurityIncidentRow,
  SecurityIncidentStatus,
  SecurityOverview,
  SecurityRuleRow,
  SecuritySeverity,
} from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { useAuth } from '@/lib/auth-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';

/**
 * WCDC-01 — the GM Security Center.
 *
 * Reads what the API actually stored. Every number is a count from the database;
 * a value that could not be read renders as "—", never as zero. Response buttons
 * are shown only to the GM, and even then the server re-checks the permission and
 * the four-eyes rule — the UI is a convenience, not the control.
 */

type Tab = 'overview' | 'incidents' | 'events' | 'actions';

type Color = 'slate' | 'green' | 'red' | 'amber' | 'teal' | 'indigo';

const SEVERITY_COLOR: Record<SecuritySeverity, Color> = {
  LOW: 'slate',
  MEDIUM: 'amber',
  HIGH: 'red',
  CRITICAL: 'red',
};

const STATUS_COLOR: Record<SecurityIncidentStatus, Color> = {
  OPEN: 'red',
  ACKNOWLEDGED: 'amber',
  CONTAINED: 'teal',
  RESOLVED: 'green',
  CLOSED: 'slate',
};

const POSTURE_COLOR: Record<SecurityOverview['posture']['level'], Color> = {
  CALM: 'green',
  ELEVATED: 'amber',
  HIGH: 'red',
  CRITICAL: 'red',
};

const ACTIONS: Array<{ value: string; key: string; target: 'ip' | 'user' | 'asset' | 'none' }> = [
  { value: 'BLOCK_IP', key: 'wcdc.action.block', target: 'ip' },
  { value: 'RATE_LIMIT_TIGHTEN', key: 'wcdc.action.tighten', target: 'ip' },
  { value: 'REVOKE_SESSION', key: 'wcdc.action.revoke', target: 'user' },
  { value: 'QUARANTINE_ASSET', key: 'wcdc.action.quarantine', target: 'asset' },
  { value: 'ESCALATE', key: 'wcdc.action.escalate', target: 'none' },
  { value: 'NOTIFY_GM', key: 'wcdc.action.notify', target: 'none' },
  { value: 'AI_KILL_SWITCH', key: 'wcdc.action.killswitch', target: 'none' },
];

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: Color }) {
  const toneClass =
    tone === 'red' ? 'text-red-700' : tone === 'amber' ? 'text-amber-700' : tone === 'green' ? 'text-green-700' : 'text-slate-900';
  return (
    <Card className="p-4">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${toneClass}`}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </Card>
  );
}

function shortDate(value: string | null, locale: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locale === 'ar' ? 'ar-TN' : 'fr-TN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function AdminSecurityPage() {
  const { t, locale } = useI18n();
  const { user } = useAuth();
  const isGm = (user?.roles ?? []).includes('SUPER_ADMIN');

  const [tab, setTab] = useState<Tab>('overview');
  const [overview, setOverview] = useState<SecurityOverview | null>(null);
  const [incidents, setIncidents] = useState<SecurityIncidentRow[]>([]);
  const [events, setEvents] = useState<SecurityEventRow[]>([]);
  const [actions, setActions] = useState<SecurityActionRow[]>([]);
  const [rules, setRules] = useState<SecurityRuleRow[]>([]);
  const [specs, setSpecs] = useState<SecurityActionSpec[]>([]);
  const [atRisk, setAtRisk] = useState<SecurityAtRiskSession[]>([]);
  const [blocks, setBlocks] = useState<SecurityBlockRow[]>([]);
  const [delegations, setDelegations] = useState<SecurityDelegationRow[]>([]);
  const [myDelegation, setMyDelegation] = useState<SecurityMyDelegation | null>(null);
  const [accessDenied, setAccessDenied] = useState(false);
  const [edge, setEdge] = useState<{ provider: string; coversVolumetricDdos: boolean; recommendation: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [selectedIncident, setSelectedIncident] = useState<SecurityIncidentRow | null>(null);
  const [actionType, setActionType] = useState('BLOCK_IP');
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');

  const [grantEmail, setGrantEmail] = useState('');
  const [grantScopes, setGrantScopes] = useState<string[]>(['overview']);
  const [grantDays, setGrantDays] = useState('7');
  const [grantReason, setGrantReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setAccessDenied(false);

    const meCall = await apiCall(() => api.adminSecurityMyDelegation());
    if (meCall.data) setMyDelegation(meCall.data);

    const [overviewCall, incidentsCall, eventsCall, actionsCall, rulesCall, sessionsCall, edgeCall, blocksCall] = await Promise.all([
      apiCall(() => api.adminSecurityOverview()),
      apiCall(() => api.adminSecurityIncidents({ limit: 50 })),
      apiCall(() => api.adminSecurityEvents({ limit: 50 })),
      apiCall(() => api.adminSecurityActions({ limit: 50 })),
      apiCall(() => api.adminSecurityRules()),
      apiCall(() => api.adminSecuritySessionsAtRisk()),
      apiCall(() => api.adminSecurityExternal()),
      apiCall(() => api.adminSecurityBlocks(true)),
    ]);
    if (overviewCall.data) setOverview(overviewCall.data);
    if (incidentsCall.data) setIncidents(incidentsCall.data.items);
    if (eventsCall.data) setEvents(eventsCall.data.items);
    if (actionsCall.data) setActions(actionsCall.data.items);
    if (rulesCall.data) {
      setRules(rulesCall.data.rules);
      setSpecs(rulesCall.data.actions);
    }
    if (sessionsCall.data) setAtRisk(sessionsCall.data.items);
    if (edgeCall.data) setEdge(edgeCall.data);
    if (blocksCall.data) setBlocks(blocksCall.data.items);

    // A 403 here is the policy at work, not a broken screen: the account holds
    // neither SECURITY_READ nor a live delegation. Say so plainly.
    if (overviewCall.errorObject?.statusCode === 403) {
      setAccessDenied(true);
      setError(null);
    } else {
      setError(overviewCall.error ?? incidentsCall.error ?? eventsCall.error ?? null);
    }

    if (isGm) {
      const delegationsCall = await apiCall(() => api.adminSecurityDelegations(false));
      if (delegationsCall.data) setDelegations(delegationsCall.data.items);
    }
    setLoading(false);
  }, [isGm]);

  useEffect(() => {
    void load();
  }, [load]);

  const pending = useMemo(() => actions.filter((a) => a.status === 'REQUIRES_APPROVAL'), [actions]);

  const selectedSpec = specs.find((s) => s.action === actionType);

  async function runScan() {
    setBusy(true);
    setNotice(null);
    const result = await apiCall(() => api.adminSecurityScan(60));
    setBusy(false);
    if (result.error) {
      setNotice(result.error);
      return;
    }
    setNotice(
      t('wcdc.scan.result')
        .replace('{scanned}', String(result.data?.scanned ?? 0))
        .replace('{recorded}', String(result.data?.recorded ?? 0)),
    );
    await load();
  }

  async function respond() {
    if (!selectedIncident) return;
    setBusy(true);
    setNotice(null);
    const result = await apiCall(() =>
      api.adminSecurityRespond(selectedIncident.id, {
        action: actionType,
        target:
          !selectedSpec || selectedSpec.targetKind === 'none' || selectedSpec.targetKind === 'incident'
            ? undefined
            : target,
        reason,
      }),
    );
    setBusy(false);
    if (result.error) {
      setNotice(result.error);
      return;
    }
    setNotice(result.data?.requiresApproval ? t('wcdc.respond.pending') : t('wcdc.respond.done'));
    setReason('');
    setTarget('');
    await load();
  }

  async function approve(actionId: string) {
    setBusy(true);
    setNotice(null);
    const result = await apiCall(() => api.adminSecurityApprove(actionId));
    setBusy(false);
    if (result.error) {
      setNotice(result.error);
      return;
    }
    setNotice(result.data?.detail ?? t('wcdc.respond.done'));
    await load();
  }

  async function liftBlock(blockId: string) {
    setBusy(true);
    setNotice(null);
    const result = await apiCall(() => api.adminSecurityRevokeBlock(blockId));
    setBusy(false);
    if (result.error) {
      setNotice(result.error);
      return;
    }
    setNotice(result.data?.detail ?? t('wcdc.blocks.lifted'));
    await load();
  }

  async function createDelegation() {
    setBusy(true);
    setNotice(null);
    const result = await apiCall(() =>
      api.adminSecurityCreateDelegation({
        adminEmail: grantEmail.trim(),
        scopes: grantScopes,
        expiresInDays: Number(grantDays),
        reason: grantReason,
      }),
    );
    setBusy(false);
    if (result.error) {
      setNotice(result.error);
      return;
    }
    setNotice(t('wcdc.delegation.created'));
    setGrantReason('');
    await load();
  }

  async function extendDelegation(row: SecurityDelegationRow) {
    setBusy(true);
    setNotice(null);
    const result = await apiCall(() =>
      api.adminSecurityAmendDelegation(row.id, { expiresInDays: Number(grantDays) || 7, reason: 'extended from the GM screen' }),
    );
    setBusy(false);
    if (result.error) {
      setNotice(result.error);
      return;
    }
    setNotice(t('wcdc.delegation.extended'));
    await load();
  }

  async function revokeDelegation(row: SecurityDelegationRow) {
    setBusy(true);
    setNotice(null);
    const result = await apiCall(() => api.adminSecurityRevokeDelegation(row.id, 'revoked from the GM screen'));
    setBusy(false);
    if (result.error) {
      setNotice(result.error);
      return;
    }
    setNotice(t('wcdc.delegation.revokedNotice'));
    await load();
  }

  function toggleGrantScope(scope: string) {
    setGrantScopes((current) =>
      current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope],
    );
  }

  async function setStatus(incident: SecurityIncidentRow, status: SecurityIncidentStatus) {
    setBusy(true);
    const result = await apiCall(() => api.adminSecuritySetStatus(incident.id, status));
    setBusy(false);
    if (result.error) {
      setNotice(result.error);
      return;
    }
    await load();
  }

  const postureLabel = overview
    ? t(`wcdc.posture.${overview.posture.level.toLowerCase()}`)
    : '—';

  return (
    <AppLayout>
      <div className="mx-auto w-full max-w-6xl px-3 py-4 sm:px-4 sm:py-6">
        <SectionHeader
          title={t('wcdc.title')}
          subtitle={t('wcdc.subtitle')}
          action={
            isGm ? (
              <button
                type="button"
                onClick={runScan}
                disabled={busy}
                className="min-h-11 rounded-lg bg-slate-900 px-4 text-sm font-medium text-white disabled:opacity-50"
              >
                {t('wcdc.action.scan')}
              </button>
            ) : null
          }
        />

        {!isGm ? (
          <p className="mt-3 rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-600">
            {t('wcdc.readOnly')}
            {myDelegation?.grant
              ? ` · ${t('wcdc.delegation.youHave')}: ${myDelegation.grant.scopes
                  .map((scope) => t(`wcdc.scope.${scope}`))
                  .join('، ')} · ${t('wcdc.delegation.until')} ${shortDate(myDelegation.grant.expiresAt, locale)}`
              : ''}
          </p>
        ) : null}

        {notice ? (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800" role="status">
            {notice}
          </p>
        ) : null}

        <div className="mt-4 flex gap-1 overflow-x-auto pb-1" role="tablist">
          {(['overview', 'incidents', 'events', 'actions'] as Tab[]).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={tab === item}
              onClick={() => setTab(item)}
              className={`min-h-11 shrink-0 rounded-lg px-3 text-sm font-medium ${
                tab === item ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700'
              }`}
            >
              {t(`wcdc.tab.${item}`)}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="mt-6 flex justify-center">
            <Spinner />
          </div>
        ) : accessDenied ? (
          <Card className="mt-4 p-5" testId="wcdc-no-access">
            <h3 className="text-sm font-semibold text-slate-900">{t('wcdc.delegation.noAccess')}</h3>
            <p className="mt-2 text-sm text-slate-600">{t('wcdc.delegation.noAccessHint')}</p>
          </Card>
        ) : error && !overview ? (
          <div className="mt-6">
            <ErrorState message={error} onRetry={load} />
          </div>
        ) : (
          <>
            {tab === 'overview' && overview ? (
              <div className="mt-4 space-y-4">
                <Card className="p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-medium text-slate-500">{t('wcdc.posture')}</p>
                      <div className="mt-1 flex items-center gap-2">
                        <Badge color={POSTURE_COLOR[overview.posture.level]}>{postureLabel}</Badge>
                        <span className="text-2xl font-semibold text-slate-900" dir="ltr">
                          {overview.posture.score}/100
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        {t('wcdc.posture.basis')}: {overview.posture.basis}
                        {overview.posture.worstRule ? ` · ${overview.posture.worstRule}` : ''}
                      </p>
                    </div>
                    <div className="text-xs text-slate-500">
                      {t('wcdc.generated')}: {shortDate(overview.generatedAt, locale)}
                    </div>
                  </div>
                </Card>

                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <Kpi label={t('wcdc.kpi.events')} value={String(overview.counts.events24h)} />
                  <Kpi
                    label={t('wcdc.kpi.open')}
                    value={String(overview.counts.incidentsOpen)}
                    tone={overview.counts.incidentsOpen > 0 ? 'amber' : undefined}
                  />
                  <Kpi
                    label={t('wcdc.kpi.critical')}
                    value={String(overview.counts.criticalOpen)}
                    tone={overview.counts.criticalOpen > 0 ? 'red' : undefined}
                  />
                  <Kpi label={t('wcdc.kpi.contained')} value={String(overview.counts.incidentsContained)} tone="green" />
                  <Kpi label={t('wcdc.kpi.blocked')} value={String(overview.counts.blockedAddresses)} />
                  <Kpi
                    label={t('wcdc.kpi.sessions')}
                    value={String(overview.counts.atRiskSessions)}
                    tone={overview.counts.atRiskSessions > 0 ? 'red' : undefined}
                  />
                  <Kpi
                    label={t('wcdc.kpi.approvals')}
                    value={String(overview.counts.pendingApprovals)}
                    tone={overview.counts.pendingApprovals > 0 ? 'amber' : undefined}
                  />
                  <Kpi label={t('wcdc.kpi.resolved')} value={String(overview.counts.incidentsResolved24h)} tone="green" />
                </div>

                <Card className="p-4">
                  <h3 className="text-sm font-semibold text-slate-900">{t('wcdc.protection')}</h3>
                  <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="rounded-lg bg-slate-50 p-3">
                      <dt className="text-xs text-slate-500">{t('wcdc.protection.api')}</dt>
                      <dd className="mt-1 text-sm text-slate-900">
                        {overview.protection.api.enabled ? t('wcdc.on') : t('wcdc.off')} ·{' '}
                        {overview.protection.api.blockedAddresses} {t('wcdc.kpi.blocked')}
                      </dd>
                      <p className="mt-1 text-xs text-slate-500">
                        {t('wcdc.protection.addressControls')}:{' '}
                        {t(`wcdc.addressControls.${overview.protection.api.addressControls}`)}
                      </p>
                    </div>
                    <div className="rounded-lg bg-slate-50 p-3">
                      <dt className="text-xs text-slate-500">{t('wcdc.protection.uploads')}</dt>
                      <dd className="mt-1 text-sm text-slate-900">
                        {overview.protection.uploads.rejected24h} {t('wcdc.protection.rejected')} ·{' '}
                        {overview.protection.uploads.quarantinedAssets} {t('wcdc.protection.quarantined')}
                      </dd>
                    </div>
                    <div className="rounded-lg bg-slate-50 p-3">
                      <dt className="text-xs text-slate-500">{t('wcdc.protection.agents')}</dt>
                      <dd className="mt-1 text-sm text-slate-900">
                        {overview.protection.agents.outOfScope24h} {t('wcdc.protection.outOfScope')} ·{' '}
                        {overview.protection.agents.aiExecutionStopped === null
                          ? '—'
                          : overview.protection.agents.aiExecutionStopped
                            ? t('wcdc.protection.aiStopped')
                            : t('wcdc.protection.aiRunning')}
                      </dd>
                    </div>
                    <div className="rounded-lg bg-slate-50 p-3">
                      <dt className="text-xs text-slate-500">{t('wcdc.protection.audit')}</dt>
                      <dd className="mt-1 text-sm text-slate-900">
                        {overview.protection.audit.tamperAttempts24h} {t('wcdc.protection.tamper')} ·{' '}
                        {shortDate(overview.protection.audit.lastWriteAt, locale)}
                      </dd>
                    </div>
                  </dl>
                  <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                    <p className="font-medium">{t('wcdc.protection.edge')}: {overview.protection.edge.provider}</p>
                    <p className="mt-1">{t('wcdc.edge.warning')}</p>
                    {edge ? <p className="mt-1" dir="ltr">{edge.recommendation}</p> : null}
                  </div>
                </Card>

                <Card className="p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-slate-900">{t('wcdc.blocks.title')}</h3>
                    <span className="text-xs text-slate-500">
                      {blocks.length} {t('wcdc.blocks.active')}
                    </span>
                  </div>
                  {blocks.length === 0 ? (
                    <p className="mt-2 text-sm text-slate-500">{t('wcdc.blocks.empty')}</p>
                  ) : (
                    <ul className="mt-3 divide-y divide-slate-100">
                      {blocks.map((block) => (
                        <li key={block.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-slate-900" dir="ltr">
                              {block.target}
                            </p>
                            <p className="text-xs text-slate-500">
                              {t('wcdc.blocks.until')}: {shortDate(block.expiresAt, locale)}
                              {block.reason ? ` · ${block.reason}` : ''}
                            </p>
                          </div>
                          {isGm ? (
                            <button
                              type="button"
                              onClick={() => liftBlock(block.id)}
                              disabled={busy}
                              className="min-h-11 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 disabled:opacity-50"
                            >
                              {t('wcdc.blocks.lift')}
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>

                {isGm ? (
                  <Card className="p-4" testId="wcdc-delegations">
                    <h3 className="text-sm font-semibold text-slate-900">{t('wcdc.delegation.title')}</h3>
                    <p className="mt-1 text-xs text-slate-500">{t('wcdc.delegation.subtitle')}</p>

                    <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <label className="text-xs font-medium text-slate-600">
                        {t('wcdc.delegation.email')}
                        <input
                          data-testid="wcdc-delegation-email"
                          type="email"
                          value={grantEmail}
                          onChange={(event) => setGrantEmail(event.target.value)}
                          className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 text-sm"
                          dir="ltr"
                          placeholder="admin@example.com"
                        />
                      </label>
                      <label className="text-xs font-medium text-slate-600">
                        {t('wcdc.delegation.days')}
                        <input
                          data-testid="wcdc-delegation-days"
                          type="number"
                          min={1}
                          max={365}
                          value={grantDays}
                          onChange={(event) => setGrantDays(event.target.value)}
                          className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 text-sm"
                          dir="ltr"
                        />
                      </label>
                    </div>

                    <div className="mt-3">
                      <p className="text-xs font-medium text-slate-600">{t('wcdc.delegation.scopes')}</p>
                      <div className="mt-1 flex flex-wrap gap-2">
                        {SECURITY_READ_SCOPES.map((scope) => (
                          <label
                            key={scope}
                            className={`min-h-11 cursor-pointer rounded-lg border px-3 text-xs leading-[2.75rem] ${
                              grantScopes.includes(scope)
                                ? 'border-slate-900 bg-slate-900 text-white'
                                : 'border-slate-300 text-slate-700'
                            }`}
                          >
                            <input
                              data-testid={`wcdc-delegation-scope-${scope}`}
                              type="checkbox"
                              className="sr-only"
                              checked={grantScopes.includes(scope)}
                              onChange={() => toggleGrantScope(scope)}
                            />
                            {t(`wcdc.scope.${scope}`)}
                          </label>
                        ))}
                      </div>
                    </div>

                    <label className="mt-3 block text-xs font-medium text-slate-600">
                      {t('wcdc.delegation.reason')}
                      <input
                        data-testid="wcdc-delegation-reason"
                        value={grantReason}
                        onChange={(event) => setGrantReason(event.target.value)}
                        className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 text-sm"
                      />
                    </label>

                    <button
                      type="button"
                      data-testid="wcdc-delegation-create"
                      onClick={createDelegation}
                      disabled={busy || !grantEmail.trim() || grantScopes.length === 0 || grantReason.trim().length < 8}
                      className="mt-3 min-h-11 rounded-lg bg-slate-900 px-4 text-sm font-medium text-white disabled:opacity-50"
                    >
                      {t('wcdc.delegation.create')}
                    </button>

                    <div className="mt-4">
                      {delegations.length === 0 ? (
                        <p className="text-sm text-slate-500">{t('wcdc.delegation.empty')}</p>
                      ) : (
                        <ul className="divide-y divide-slate-100">
                          {delegations.map((row) => (
                            <li
                              key={row.id}
                              data-testid="wcdc-delegation-row"
                              className="flex flex-wrap items-center justify-between gap-2 py-3"
                            >
                              <div className="min-w-0">
                                <p className="text-sm font-medium text-slate-900" dir="ltr">
                                  {row.adminEmail ?? row.adminUserId}
                                </p>
                                <p className="text-xs text-slate-500">
                                  {row.scopes.map((scope) => t(`wcdc.scope.${scope}`)).join('، ')} ·{' '}
                                  {t('wcdc.delegation.expires')}: {shortDate(row.expiresAt, locale)}
                                </p>
                                <p className="text-xs text-slate-400">
                                  {t('wcdc.delegation.issuedBy')}: <span dir="ltr">{row.grantedById}</span>
                                </p>
                              </div>
                              <div className="flex gap-2">
                                <button
                                  type="button"
                                  data-testid={`wcdc-delegation-extend-${row.id}`}
                                  onClick={() => extendDelegation(row)}
                                  disabled={busy}
                                  className="min-h-11 rounded-lg border border-slate-300 px-3 text-sm text-slate-700 disabled:opacity-50"
                                >
                                  {t('wcdc.delegation.extend')}
                                </button>
                                <button
                                  type="button"
                                  data-testid={`wcdc-delegation-revoke-${row.id}`}
                                  onClick={() => revokeDelegation(row)}
                                  disabled={busy}
                                  className="min-h-11 rounded-lg border border-red-300 px-3 text-sm text-red-700 disabled:opacity-50"
                                >
                                  {t('wcdc.delegation.revoke')}
                                </button>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </Card>
                ) : null}

                <Card className="p-4">
                  <h3 className="text-sm font-semibold text-slate-900">{t('wcdc.policy')}</h3>
                  <p className="mt-2 text-sm text-slate-700">
                    {t('wcdc.policy.auto')}:{' '}
                    <span className="font-medium">
                      {overview.policy.autoContainment === 'limited' ? t('wcdc.policy.limited') : t('wcdc.policy.off')}
                    </span>{' '}
                    · {t('wcdc.policy.source')}:{' '}
                    <span className="font-medium">
                      {overview.policy.source === 'policy' ? t('wcdc.policy.fromPolicy') : t('wcdc.policy.defaults')}
                    </span>
                  </p>
                  <p className="mt-1 text-xs text-slate-500" dir="ltr">
                    burst {overview.policy.burstMax}/{overview.policy.burstWindowSeconds}s · block TTL{' '}
                    {overview.policy.blockTtlMinutes} min
                  </p>
                </Card>

                <Card className="p-4">
                  <h3 className="text-sm font-semibold text-slate-900">{t('wcdc.rules.title')}</h3>
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full min-w-[520px] text-left text-sm">
                      <thead className="text-xs text-slate-500">
                        <tr>
                          <th className="py-2">{t('wcdc.rule.name')}</th>
                          <th className="py-2">{t('wcdc.rule.severity')}</th>
                          <th className="py-2">{t('wcdc.rule.threshold')}</th>
                          <th className="py-2">{t('wcdc.rule.auto')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rules.map((rule) => (
                          <tr key={rule.id} className="border-t border-slate-100">
                            <td className="py-2">
                              <span className="font-medium text-slate-900">{t(`wcdc.rule.${rule.id}`)}</span>
                              <span className="ms-2 text-xs text-slate-400" dir="ltr">
                                {rule.id}
                              </span>
                            </td>
                            <td className="py-2">
                              <Badge color={SEVERITY_COLOR[rule.severity]}>{t(`wcdc.severity.${rule.severity}`)}</Badge>
                            </td>
                            <td className="py-2 text-slate-700" dir="ltr">
                              {rule.effectiveThreshold}/{rule.effectiveWindowSeconds}s
                            </td>
                            <td className="py-2 text-slate-700">{rule.autoEligible ? t('wcdc.yes') : t('wcdc.no')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              </div>
            ) : null}

            {tab === 'incidents' ? (
              <div className="mt-4 space-y-3">
                {incidents.length === 0 ? (
                  <EmptyState title={t('wcdc.incidents.empty')} />
                ) : (
                  incidents.map((incident) => (
                    <Card key={incident.id} className="p-4">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge color={SEVERITY_COLOR[incident.severity]}>{t(`wcdc.severity.${incident.severity}`)}</Badge>
                            <Badge color={STATUS_COLOR[incident.status]}>{t(`wcdc.status.${incident.status}`)}</Badge>
                            <span className="text-xs text-slate-400" dir="ltr">
                              {incident.ruleId}
                            </span>
                          </div>
                          <h3 className="mt-1 text-sm font-semibold text-slate-900">{t(`wcdc.rule.${incident.ruleId}`)}</h3>
                          <p className="mt-1 text-xs text-slate-500">
                            {t('wcdc.incident.events')}: {incident.eventCount} · {t('wcdc.incident.risk')}:{' '}
                            {incident.riskScore}/100 · {shortDate(incident.lastSeenAt, locale)}
                          </p>
                          <p className="mt-1 text-xs text-slate-500" dir="ltr">
                            {incident.ipAddress ?? incident.actorId ?? '—'}
                          </p>
                        </div>
                        {isGm ? (
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedIncident(incident);
                                setActionType('BLOCK_IP');
                              }}
                              className="min-h-11 rounded-lg bg-slate-900 px-3 text-xs font-medium text-white"
                            >
                              {t('wcdc.action.respond')}
                            </button>
                            {incident.status === 'OPEN' ? (
                              <button
                                type="button"
                                onClick={() => setStatus(incident, 'ACKNOWLEDGED')}
                                disabled={busy}
                                className="min-h-11 rounded-lg bg-slate-100 px-3 text-xs font-medium text-slate-700"
                              >
                                {t('wcdc.status.ACKNOWLEDGED')}
                              </button>
                            ) : null}
                            {incident.status !== 'RESOLVED' && incident.status !== 'CLOSED' ? (
                              <button
                                type="button"
                                onClick={() => setStatus(incident, 'RESOLVED')}
                                disabled={busy}
                                className="min-h-11 rounded-lg bg-green-600 px-3 text-xs font-medium text-white"
                              >
                                {t('wcdc.status.RESOLVED')}
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                      {incident.containment ? (
                        <p className="mt-2 rounded-lg bg-teal-50 px-3 py-2 text-xs text-teal-900" dir="ltr">
                          {JSON.stringify(incident.containment).slice(0, 240)}
                        </p>
                      ) : null}
                    </Card>
                  ))
                )}
              </div>
            ) : null}

            {tab === 'events' ? (
              <div className="mt-4">
                {events.length === 0 ? (
                  <EmptyState title={t('wcdc.events.empty')} />
                ) : (
                  <Card className="p-0">
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[640px] text-left text-sm">
                        <thead className="bg-slate-50 text-xs text-slate-500">
                          <tr>
                            <th className="px-3 py-2">{t('wcdc.rule.name')}</th>
                            <th className="px-3 py-2">{t('wcdc.rule.severity')}</th>
                            <th className="px-3 py-2">{t('wcdc.event.source')}</th>
                            <th className="px-3 py-2">{t('wcdc.event.route')}</th>
                            <th className="px-3 py-2">{t('wcdc.event.when')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {events.map((event) => (
                            <tr key={event.id} className="border-t border-slate-100">
                              <td className="px-3 py-2 font-medium text-slate-900">{t(`wcdc.rule.${event.ruleId}`)}</td>
                              <td className="px-3 py-2">
                                <Badge color={SEVERITY_COLOR[event.severity]}>{t(`wcdc.severity.${event.severity}`)}</Badge>
                              </td>
                              <td className="px-3 py-2 text-slate-600" dir="ltr">
                                {event.source}
                              </td>
                              <td className="px-3 py-2 text-xs text-slate-500" dir="ltr">
                                {event.method} {event.route}
                              </td>
                              <td className="px-3 py-2 text-xs text-slate-500">{shortDate(event.occurredAt, locale)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                )}
              </div>
            ) : null}

            {tab === 'actions' ? (
              <div className="mt-4 space-y-3">
                {pending.length > 0 ? (
                  <Card className="border border-amber-200 bg-amber-50 p-4">
                    <h3 className="text-sm font-semibold text-amber-900">{t('wcdc.actions.pending')}</h3>
                    <ul className="mt-2 space-y-2">
                      {pending.map((action) => (
                        <li key={action.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                          <span className="text-amber-900">
                            {t(`wcdc.actionLabel.${action.actionType}`)} · <span dir="ltr">{action.target ?? '—'}</span>
                          </span>
                          {isGm ? (
                            <button
                              type="button"
                              onClick={() => approve(action.id)}
                              disabled={busy}
                              className="min-h-11 rounded-lg bg-amber-700 px-3 text-xs font-medium text-white disabled:opacity-50"
                            >
                              {t('wcdc.action.approve')}
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2 text-xs text-amber-800">{t('wcdc.actions.fourEyes')}</p>
                  </Card>
                ) : null}

                {actions.length === 0 ? (
                  <EmptyState title={t('wcdc.actions.empty')} />
                ) : (
                  <Card className="p-0">
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[620px] text-left text-sm">
                        <thead className="bg-slate-50 text-xs text-slate-500">
                          <tr>
                            <th className="px-3 py-2">{t('wcdc.actions.type')}</th>
                            <th className="px-3 py-2">{t('wcdc.actions.status')}</th>
                            <th className="px-3 py-2">{t('wcdc.actions.target')}</th>
                            <th className="px-3 py-2">{t('wcdc.actions.mode')}</th>
                            <th className="px-3 py-2">{t('wcdc.event.when')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {actions.map((action) => (
                            <tr key={action.id} className="border-t border-slate-100">
                              <td className="px-3 py-2 text-slate-900">{t(`wcdc.actionLabel.${action.actionType}`)}</td>
                              <td className="px-3 py-2">
                                <Badge
                                  color={
                                    action.status === 'EXECUTED'
                                      ? 'green'
                                      : action.status === 'REQUIRES_APPROVAL'
                                        ? 'amber'
                                        : 'red'
                                  }
                                >
                                  {t(`wcdc.actionStatus.${action.status}`)}
                                </Badge>
                              </td>
                              <td className="px-3 py-2 text-xs text-slate-600" dir="ltr">
                                {action.target ?? '—'}
                              </td>
                              <td className="px-3 py-2 text-xs text-slate-600" dir="ltr">
                                {action.mode}
                              </td>
                              <td className="px-3 py-2 text-xs text-slate-500">{shortDate(action.createdAt, locale)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                )}
              </div>
            ) : null}

            {tab === 'overview' && atRisk.length > 0 ? (
              <Card className="mt-4 p-4">
                <h3 className="text-sm font-semibold text-slate-900">{t('wcdc.sessions.title')}</h3>
                <ul className="mt-2 space-y-2 text-sm">
                  {atRisk.map((session) => (
                    <li key={session.sessionId} className="rounded-lg bg-red-50 px-3 py-2 text-red-900">
                      <span dir="ltr">{session.email ?? session.userId}</span> · {session.addressesSeen}{' '}
                      {t('wcdc.sessions.addresses')} · <span dir="ltr">{session.sessionIp ?? '—'}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
          </>
        )}

        {selectedIncident ? (
          <div className="fixed inset-0 z-40 flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4">
            <div className="w-full max-w-lg rounded-t-2xl bg-white p-4 sm:rounded-2xl">
              <h3 className="text-sm font-semibold text-slate-900">{t('wcdc.action.respond')}</h3>
              <p className="mt-1 text-xs text-slate-500">{selectedIncident.ruleId}</p>

              <label className="mt-3 block text-xs font-medium text-slate-600" htmlFor="wcdc-action">
                {t('wcdc.field.action')}
              </label>
              <select
                id="wcdc-action"
                value={actionType}
                onChange={(e) => setActionType(e.target.value)}
                className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 text-sm"
              >
                {ACTIONS.map((action) => (
                  <option key={action.value} value={action.value}>
                    {t(action.key)}
                  </option>
                ))}
              </select>

              {selectedSpec && selectedSpec.targetKind !== 'none' && selectedSpec.targetKind !== 'incident' ? (
                <>
                  <label className="mt-3 block text-xs font-medium text-slate-600" htmlFor="wcdc-target">
                    {t(`wcdc.field.target.${selectedSpec.targetKind}`)}
                  </label>
                  <input
                    id="wcdc-target"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    dir="ltr"
                    className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 text-sm"
                  />
                </>
              ) : null}

              <label className="mt-3 block text-xs font-medium text-slate-600" htmlFor="wcdc-reason">
                {t('wcdc.field.reason')}
              </label>
              <textarea
                id="wcdc-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />

              {selectedSpec?.requiresApproval ? (
                <p className="mt-2 text-xs text-amber-700">{t('wcdc.field.needsApproval')}</p>
              ) : null}

              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedIncident(null)}
                  className="min-h-11 rounded-lg bg-slate-100 px-4 text-sm font-medium text-slate-700"
                >
                  {t('wcdc.cancel')}
                </button>
                <button
                  type="button"
                  onClick={respond}
                  disabled={busy || reason.trim().length < 3}
                  className="min-h-11 rounded-lg bg-slate-900 px-4 text-sm font-medium text-white disabled:opacity-50"
                >
                  {t('wcdc.action.respond')}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </AppLayout>
  );
}
