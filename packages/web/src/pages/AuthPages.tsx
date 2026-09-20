import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiClientError } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { Card } from '@/components/ui';
import { PublicLayout } from '@/components/layouts/PublicLayout';

export function ForgotPasswordPage() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [devToken, setDevToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await api.forgotPassword(email);
      setSent(true);
      if (res?.devResetToken) setDevToken(res.devResetToken);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : String(err));
    }
  };

  return (
    <PublicLayout>
      <div className="mx-auto flex max-w-md flex-col justify-center px-4 py-12">
        <Card className="p-6">
          <h1 className="text-xl font-bold text-slate-900">{t('auth.forgot')}</h1>
          {sent ? (
            <p className="mt-4 text-sm text-slate-600">
              {t('auth.registerSuccess')}
              {devToken && <code className="mt-2 block rounded bg-slate-100 p-2 text-xs" dir="ltr">{devToken}</code>}
            </p>
          ) : (
            <form onSubmit={submit} className="mt-4 space-y-3">
              <div>
                <label className="label">{t('auth.email')}</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="input" required />
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <button className="btn-primary w-full" type="submit">Send</button>
            </form>
          )}
        </Card>
      </div>
    </PublicLayout>
  );
}

export function ResetPasswordPage() {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.resetPassword(token, newPassword);
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : String(err));
    }
  };

  return (
    <PublicLayout>
      <div className="mx-auto flex max-w-md flex-col justify-center px-4 py-12">
        <Card className="p-6">
          <h1 className="text-xl font-bold text-slate-900">{t('security.changePassword')}</h1>
          {done ? (
            <p className="mt-4 text-sm text-green-700">{t('auth.loginSuccess')}</p>
          ) : (
            <form onSubmit={submit} className="mt-4 space-y-3">
              <div>
                <label className="label">{t('auth.password')}</label>
                <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="input" minLength={8} required />
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <button className="btn-primary w-full" type="submit">{t('common.save')}</button>
            </form>
          )}
        </Card>
      </div>
    </PublicLayout>
  );
}