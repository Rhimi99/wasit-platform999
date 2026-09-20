import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { Card } from '@/components/ui';
import { PublicLayout } from '@/components/layouts/PublicLayout';

const ROLES = [
  { value: 'CUSTOMER', key: 'auth.role.CUSTOMER' },
  { value: 'MERCHANT', key: 'auth.role.MERCHANT' },
  { value: 'SUPPLIER', key: 'auth.role.SUPPLIER' },
  { value: 'COMPANY', key: 'auth.role.COMPANY' },
];

export function RegisterPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [role, setRole] = useState('CUSTOMER');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.register({ email, password, firstName: firstName || undefined, lastName: lastName || undefined, role, locale: undefined });
      setSuccess(true);
      // بعد التسجيل، اقترح الدخول
      setTimeout(() => navigate('/login'), 1800);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <PublicLayout>
      <div className="mx-auto flex max-w-md flex-col justify-center px-4 py-12">
        <Card className="p-6">
          <h1 className="text-2xl font-bold text-slate-900">{t('auth.register')}</h1>
          {success ? (
            <div className="mt-6 rounded-md bg-green-50 p-4 text-sm text-green-800" role="status">
              {t('auth.registerSuccess')}
            </div>
          ) : (
            <form onSubmit={submit} className="mt-6 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">{t('auth.firstName')}</label>
                  <input value={firstName} onChange={(e) => setFirstName(e.target.value)} className="input" />
                </div>
                <div>
                  <label className="label">{t('auth.lastName')}</label>
                  <input value={lastName} onChange={(e) => setLastName(e.target.value)} className="input" />
                </div>
              </div>
              <div>
                <label className="label">{t('auth.email')}</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="input" required />
              </div>
              <div>
                <label className="label">{t('auth.password')}</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="input" minLength={8} required />
              </div>
              <div>
                <label className="label">{t('auth.role')}</label>
                <select value={role} onChange={(e) => setRole(e.target.value)} className="input">
                  {ROLES.map((r) => <option key={r.value} value={r.value}>{t(r.key)}</option>)}
                </select>
              </div>
              {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
              <button type="submit" disabled={loading} className="btn-primary w-full">{loading ? t('common.loading') : t('auth.register')}</button>
            </form>
          )}
          <div className="mt-4 text-center text-sm">
            <Link to="/login" className="text-wasit-700 hover:underline">{t('auth.haveAccount')}</Link>
          </div>
        </Card>
      </div>
    </PublicLayout>
  );
}