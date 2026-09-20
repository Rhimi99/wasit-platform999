import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { useAuth } from '@/lib/auth-context';
import { Card } from '@/components/ui';
import { PublicLayout } from '@/components/layouts/PublicLayout';

export function LoginPage() {
  const { t } = useI18n();
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const afterLogin = (user: { roles: string[] }) => {
    setUser(user as never);
    navigate(user.roles.some((r) => ['ADMIN', 'SUPER_ADMIN'].includes(r)) ? '/admin' : '/dashboard');
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api.login(email, password);
      if (res.mfaRequired) {
        setChallengeToken(res.challengeToken);
      } else {
        afterLogin(res);
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const submitChallenge = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!challengeToken) return;
    setError(null);
    setLoading(true);
    try {
      const user = await api.mfaChallenge(challengeToken, code);
      afterLogin(user);
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
          <h1 className="text-2xl font-bold text-slate-900">{t('auth.login')}</h1>
          {challengeToken ? (
            <form onSubmit={submitChallenge} className="mt-6 space-y-4">
              <p className="text-sm text-slate-600">{t('mfa.challengePrompt')}</p>
              <div>
                <label className="label">{t('mfa.code')}</label>
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="input"
                  dir="ltr"
                  required
                  autoFocus
                />
              </div>
              {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
              <button type="submit" disabled={loading} className="btn-primary w-full">{loading ? t('common.loading') : t('mfa.verify')}</button>
              <button
                type="button"
                className="w-full text-sm text-slate-500 hover:underline"
                onClick={() => { setChallengeToken(null); setCode(''); setError(null); }}
              >
                {t('common.back')}
              </button>
            </form>
          ) : (
            <form onSubmit={submit} className="mt-6 space-y-4">
              <div>
                <label className="label">{t('auth.email')}</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="input" required />
              </div>
              <div>
                <label className="label">{t('auth.password')}</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="input" required />
              </div>
              {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
              <button type="submit" disabled={loading} className="btn-primary w-full">{loading ? t('common.loading') : t('auth.login')}</button>
            </form>
          )}
          <div className="mt-4 flex items-center justify-between text-sm">
            <Link to="/forgot-password" className="text-wasit-700 hover:underline">{t('auth.forgot')}</Link>
            <Link to="/register" className="text-wasit-700 hover:underline">{t('auth.newHere')}</Link>
          </div>
        </Card>
      </div>
    </PublicLayout>
  );
}