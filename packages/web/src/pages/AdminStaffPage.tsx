import { useCallback, useEffect, useState } from 'react';
import { api, apiCall, formatDate } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { useAuth } from '@/lib/auth-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Badge, Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type { AssignableStaffRole, StaffActivityRow, StaffMember, StaffRoleCatalog } from '@/lib/types';

/**
 * RBAC-02 — staff desk.
 *
 * The page is a mirror of `/api/admin/staff`, which is SUPER_ADMIN-only. Every
 * action is re-checked on the server; hiding a button here is presentation, not
 * security. Nothing secret is displayed: MFA is a boolean, and the invite is
 * sent by email (the token is never rendered).
 */
export function AdminStaffPage() {
  const { t } = useI18n();
  const { user } = useAuth();

  const [catalog, setCatalog] = useState<StaffRoleCatalog | null>(null);
  const [members, setMembers] = useState<StaffMember[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [reloadKey, setReloadKey] = useState(0);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<StaffMember | null>(null);
  const [activity, setActivity] = useState<StaffActivityRow[]>([]);
  const [pendingRole, setPendingRole] = useState<AssignableStaffRole | ''>('');
  const [busy, setBusy] = useState(false);

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    email: '',
    firstName: '',
    lastName: '',
    role: 'SUPPORT' as AssignableStaffRole,
    sendInvite: true,
  });

  useEffect(() => {
    apiCall(() => api.adminStaffRoles()).then((res) => {
      if (!res.error) setCatalog(res.data);
    });
  }, []);

  useEffect(() => {
    setLoading(true);
    apiCall(() =>
      api.adminStaffList({ q: search.trim() || undefined, role: roleFilter || undefined, status: statusFilter, pageSize: 100 }),
    ).then((res) => {
      setLoading(false);
      if (res.error) {
        setError(res.error);
        return;
      }
      setError(null);
      setMembers(res.data?.items ?? []);
      setTotal(res.data?.total ?? 0);
    });
  }, [search, roleFilter, statusFilter, reloadKey]);

  const loadDetail = useCallback(async (id: string) => {
    const [member, log] = await Promise.all([
      apiCall(() => api.adminStaffMember(id)),
      apiCall(() => api.adminStaffActivity(id)),
    ]);
    if (member.error) {
      setError(member.error);
      return;
    }
    setSelected(member.data?.member ?? null);
    setActivity(log.data?.items ?? []);
    setPendingRole('');
  }, []);

  const select = async (id: string) => {
    setSelectedId(id);
    await loadDetail(id);
  };

  async function createStaff(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await apiCall(() =>
      api.adminStaffCreate({
        email: form.email.trim(),
        firstName: form.firstName.trim() || undefined,
        lastName: form.lastName.trim() || undefined,
        role: form.role,
        sendInvite: form.sendInvite,
      }),
    );
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setNotice(res.data?.inviteSent ? t('staff.inviteSent') : t('staff.created'));
    setForm({ email: '', firstName: '', lastName: '', role: 'SUPPORT', sendInvite: true });
    setShowCreate(false);
    setReloadKey((k) => k + 1);
    if (res.data?.member) await select(res.data.member.id);
  }

  async function applyRole() {
    if (!selected || !pendingRole) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await apiCall(() => api.adminStaffSetRole(selected.id, pendingRole));
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setNotice(t('staff.roleChanged'));
    await loadDetail(selected.id);
    setReloadKey((k) => k + 1);
  }

  async function toggleStatus() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await apiCall(() => api.adminStaffSetStatus(selected.id, !selected.isActive));
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setNotice(t('staff.statusChanged'));
    await loadDetail(selected.id);
    setReloadKey((k) => k + 1);
  }

  const permissionsFor = (role: string): string[] =>
    catalog?.assignable.find((entry) => entry.role === role)?.permissions ?? [];
  const currentRole = selected?.roles[0] ?? '';
  const currentPermissions = permissionsFor(currentRole);
  const pendingPermissions = pendingRole ? permissionsFor(pendingRole) : [];
  const isSelf = selected?.id === user?.id;
  const targetIsSuperAdmin = selected?.roles.includes('SUPER_ADMIN') ?? false;

  return (
    <AppLayout>
      <SectionHeader
        title={t('admin.staff')}
        subtitle={t('admin.staffSubtitle')}
        action={
          <button type="button" className="btn btn-primary" data-testid="staff-new" onClick={() => setShowCreate((v) => !v)}>
            {t('staff.new')}
          </button>
        }
      />

      {notice && <p className="mb-2 text-sm text-green-700" role="status" data-testid="staff-notice">{notice}</p>}
      {error && <p className="mb-2 text-sm text-red-600" role="alert" data-testid="staff-error">{error}</p>}
      <p className="mb-3 rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-500">{t('staff.protectedNote')}</p>

      {showCreate && (
        <Card className="mb-4">
          <h3 className="mb-1 text-sm font-semibold text-slate-800">{t('staff.createTitle')}</h3>
          <p className="mb-3 text-xs text-slate-500">{t('staff.createHint')}</p>
          <form onSubmit={createStaff} className="grid gap-3 sm:grid-cols-2" data-testid="staff-create-form">
            <div className="sm:col-span-2">
              <label className="label" htmlFor="staff-email">{t('field.email')} *</label>
              <input
                id="staff-email"
                type="email"
                className="input"
                dir="ltr"
                required
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </div>
            <div>
              <label className="label" htmlFor="staff-first">{t('staff.firstName')}</label>
              <input id="staff-first" className="input" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="staff-last">{t('staff.lastName')}</label>
              <input id="staff-last" className="input" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="staff-role">{t('staff.role')} *</label>
              <select
                id="staff-role"
                className="input"
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value as AssignableStaffRole })}
              >
                {catalog?.assignable.map((entry) => (
                  <option key={entry.role} value={entry.role}>{entry.role}</option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2 self-end text-sm text-slate-600">
              <input
                type="checkbox"
                checked={form.sendInvite}
                onChange={(e) => setForm({ ...form, sendInvite: e.target.checked })}
              />
              {t('staff.sendInvite')}
            </label>
            <div className="sm:col-span-2 rounded-lg bg-slate-50 p-3 text-xs text-slate-600" data-testid="staff-create-permissions">
              <span className="font-medium">{t('staff.permissions')}: {permissionsFor(form.role).length}</span>
              <div className="mt-1 flex flex-wrap gap-1" dir="ltr">
                {permissionsFor(form.role).map((p) => (
                  <span key={p} className="rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-600">{p}</span>
                ))}
              </div>
            </div>
            <div className="sm:col-span-2 flex gap-2">
              <button type="submit" className="btn btn-primary" disabled={busy} data-testid="staff-create-submit">
                {busy ? '…' : t('staff.create')}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setShowCreate(false)}>
                {t('common.cancel')}
              </button>
            </div>
          </form>
        </Card>
      )}

      <Card className="mb-4">
        <div className="grid gap-2 sm:grid-cols-4">
          <input
            className="input sm:col-span-2"
            placeholder={t('staff.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="staff-search"
          />
          <select className="input" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} data-testid="staff-role-filter">
            <option value="">{t('staff.allRoles')}</option>
            {catalog?.assignable.map((entry) => (
              <option key={entry.role} value={entry.role}>{entry.role}</option>
            ))}
            <option value="SUPER_ADMIN">SUPER_ADMIN</option>
          </select>
          <select
            className="input"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'all' | 'active' | 'inactive')}
            data-testid="staff-status-filter"
          >
            <option value="all">{t('staff.allStatuses')}</option>
            <option value="active">{t('staff.statusActive')}</option>
            <option value="inactive">{t('staff.statusInactive')}</option>
          </select>
        </div>
        <p className="mt-2 text-xs text-slate-500">{t('staff.total')}: {total}</p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {loading ? <Spinner /> : members.length === 0 ? <EmptyState title={t('staff.empty')} hint={t('staff.emptyHint')} /> : (
            <>
              {/* Desktop table */}
              <Card className="hidden overflow-x-auto sm:block">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>{t('field.email')}</th>
                      <th>{t('staff.role')}</th>
                      <th>{t('staff.status')}</th>
                      <th>{t('staff.mfa')}</th>
                      <th>{t('staff.lastLogin')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((m) => (
                      <tr
                        key={m.id}
                        data-testid={`staff-row-${m.id}`}
                        onClick={() => select(m.id)}
                        className={`cursor-pointer ${selectedId === m.id ? 'bg-slate-50' : ''}`}
                      >
                        <td dir="ltr">
                          <div className="font-medium">{m.email}</div>
                          <div className="text-xs text-slate-500">{[m.firstName, m.lastName].filter(Boolean).join(' ') || '—'}</div>
                        </td>
                        <td>{m.roles.map((r) => <Badge key={r} color={r === 'SUPER_ADMIN' ? 'indigo' : 'teal'}>{r}</Badge>)}</td>
                        <td>
                          <Badge color={m.isActive ? 'green' : 'red'}>{m.isActive ? t('staff.statusActive') : t('staff.statusInactive')}</Badge>
                        </td>
                        <td>
                          <Badge color={m.mfaEnabled ? 'green' : 'amber'}>{m.mfaEnabled ? t('staff.mfaOn') : t('staff.mfaOff')}</Badge>
                        </td>
                        <td className="text-xs text-slate-600">{m.lastLoginAt ? formatDate(m.lastLoginAt) : t('staff.never')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>

              {/* Phone cards */}
              <div className="space-y-2 sm:hidden">
                {members.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    data-testid={`staff-card-${m.id}`}
                    onClick={() => select(m.id)}
                    className={`w-full rounded-xl border p-3 text-start ${selectedId === m.id ? 'border-brand-500 bg-slate-50' : 'border-slate-200 bg-white'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium" dir="ltr">{m.email}</span>
                      <Badge color={m.isActive ? 'green' : 'red'}>{m.isActive ? t('staff.statusActive') : t('staff.statusInactive')}</Badge>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-slate-500">
                      {m.roles.map((r) => <Badge key={r} color={r === 'SUPER_ADMIN' ? 'indigo' : 'teal'}>{r}</Badge>)}
                      <span>· {m.mfaEnabled ? t('staff.mfaOn') : t('staff.mfaOff')}</span>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div>
          {!selected ? (
            <Card>
              <p className="text-sm text-slate-500">{t('staff.selectHint')}</p>
            </Card>
          ) : (
            <Card testId="staff-detail">
              <h3 className="text-sm font-semibold text-slate-800" dir="ltr">{selected.email}</h3>
              <p className="mb-3 text-xs text-slate-500">
                {[selected.firstName, selected.lastName].filter(Boolean).join(' ') || '—'}
              </p>

              <div className="space-y-1 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-500">{t('staff.role')}</span>
                  <span>{selected.roles.map((r) => <Badge key={r} color={r === 'SUPER_ADMIN' ? 'indigo' : 'teal'}>{r}</Badge>)}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-500">{t('staff.status')}</span>
                  <Badge color={selected.isActive ? 'green' : 'red'}>
                    {selected.isActive ? t('staff.statusActive') : t('staff.statusInactive')}
                  </Badge>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-500">{t('staff.mfa')}</span>
                  <Badge color={selected.mfaEnabled ? 'green' : 'amber'}>{selected.mfaEnabled ? t('staff.mfaOn') : t('staff.mfaOff')}</Badge>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-500">{t('staff.createdAt')}</span>
                  <span className="text-xs">{formatDate(selected.createdAt)}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-500">{t('staff.lastLogin')}</span>
                  <span className="text-xs">{selected.lastLoginAt ? formatDate(selected.lastLoginAt) : t('staff.never')}</span>
                </div>
              </div>

              <div className="mt-3 rounded-lg bg-slate-50 p-3" data-testid="staff-permissions">
                <p className="text-xs font-medium text-slate-600">
                  {t('staff.permissions')}: {currentPermissions.length}
                </p>
                <div className="mt-1 flex max-h-28 flex-wrap gap-1 overflow-y-auto" dir="ltr">
                  {currentPermissions.map((p) => (
                    <span key={p} className="rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-600">{p}</span>
                  ))}
                </div>
              </div>

              {targetIsSuperAdmin || isSelf ? (
                <p className="mt-3 rounded-lg bg-amber-50 p-2 text-xs text-amber-800">
                  {targetIsSuperAdmin ? t('staff.superAdminProtected') : t('staff.selfProtected')}
                </p>
              ) : (
                <>
                  <div className="mt-3">
                    <label className="label" htmlFor="staff-role-select">{t('staff.changeRole')}</label>
                    <select
                      id="staff-role-select"
                      className="input"
                      value={pendingRole}
                      data-testid="staff-role-select"
                      onChange={(e) => setPendingRole(e.target.value as AssignableStaffRole | '')}
                    >
                      <option value="">—</option>
                      {catalog?.assignable.map((entry) => (
                        <option key={entry.role} value={entry.role}>{entry.role}</option>
                      ))}
                    </select>
                    {pendingRole && (
                      <div className="mt-2 rounded-lg border border-slate-200 p-2" data-testid="staff-role-preview">
                        <p className="text-xs font-medium text-slate-700">
                          {t('staff.rolePreviewTitle')}: <span dir="ltr" className="font-mono">{pendingRole}</span>
                        </p>
                        <div className="mt-1 flex max-h-24 flex-wrap gap-1 overflow-y-auto" dir="ltr">
                          {pendingPermissions.map((p) => (
                            <span key={p} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-700">{p}</span>
                          ))}
                        </div>
                        <button
                          type="button"
                          className="btn btn-primary mt-2 w-full"
                          disabled={busy || pendingRole === currentRole}
                          onClick={applyRole}
                          data-testid="staff-role-apply"
                        >
                          {t('staff.confirmRole')}
                        </button>
                      </div>
                    )}
                  </div>

                  <button
                    type="button"
                    className={selected.isActive ? 'btn btn-danger mt-3 w-full' : 'btn btn-secondary mt-3 w-full'}
                    disabled={busy}
                    onClick={toggleStatus}
                    data-testid="staff-toggle-status"
                  >
                    {selected.isActive ? t('staff.deactivate') : t('staff.activate')}
                  </button>
                </>
              )}

              <div className="mt-4" data-testid="staff-activity">
                <p className="mb-1 text-xs font-semibold text-slate-700">{t('staff.activity')}</p>
                {activity.length === 0 ? (
                  <p className="text-xs text-slate-500">{t('staff.activityEmpty')}</p>
                ) : (
                  <ul className="space-y-1">
                    {activity.map((row) => (
                      <li key={row.id} className="rounded bg-slate-50 px-2 py-1 text-[11px] text-slate-600">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono">{row.action}</span>
                          <span>{formatDate(row.createdAt)}</span>
                        </div>
                        <div className="truncate" dir="ltr">{row.actorEmail ?? '—'}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Card>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
