import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useI18n } from '@/lib/i18n-context';

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center justify-center p-8 ${className}`} role="status" aria-label="loading">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-wasit-600 border-t-transparent" />
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center rounded-lg border border-red-200 bg-red-50 p-6 text-center" role="alert">
      <p className="text-sm font-medium text-red-700">{message}</p>
      {onRetry && (
        <button className="mt-3 text-sm font-medium text-red-600 underline" onClick={onRetry}>
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-slate-200 bg-slate-50 p-8 text-center">
      <div className="text-3xl opacity-30">🗂️</div>
      <p className="mt-2 text-sm font-medium text-slate-600">{title}</p>
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

export function Badge({ children, color = 'slate', className = '', testId }: { children: ReactNode; color?: 'slate' | 'green' | 'red' | 'amber' | 'teal' | 'indigo'; className?: string; testId?: string }) {
  const palette: Record<string, string> = {
    slate: 'bg-slate-100 text-slate-700 border-slate-200',
    green: 'bg-green-50 text-green-700 border-green-200',
    red: 'bg-red-50 text-red-700 border-red-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    teal: 'bg-wasit-50 text-wasit-700 border-wasit-200',
    indigo: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  };
  return (
    <span data-testid={testId} className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${palette[color]} ${className}`}>
      {children}
    </span>
  );
}

export function Card({ children, className = '', testId }: { children: ReactNode; className?: string; testId?: string }) {
  return <div data-testid={testId} className={`card p-4 ${className}`}>{children}</div>;
}

export function SectionHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        <h2 className="text-lg font-bold text-slate-900">{title}</h2>
        {subtitle && <p className="text-sm text-slate-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
/**
 * In-app replacement for `window.prompt` when a decision needs a written reason.
 *
 * The reason is mandatory: the submit button stays disabled until it reaches
 * `minLength`, so an incident can never be closed with an empty justification.
 * Escape and the backdrop cancel (no action), which is the honest way out — the
 * dialog refuses to submit, it does not pretend the decision was made.
 */
export function ReasonDialog({
  title,
  description,
  label,
  confirmLabel,
  cancelLabel,
  minLength = 3,
  busy = false,
  error,
  onSubmit,
  onCancel,
  testId = 'reason-dialog',
}: {
  title: string;
  description?: string;
  label: string;
  confirmLabel: string;
  cancelLabel: string;
  minLength?: number;
  busy?: boolean;
  error?: string | null;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
  testId?: string;
}) {
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const valid = trimmed.length >= minLength;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid={testId}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}
    >
      <form
        className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !busy) onSubmit(trimmed);
        }}
      >
        <h3 className="text-base font-bold text-slate-900">{title}</h3>
        {description && <p className="mt-1 text-xs text-slate-500">{description}</p>}

        <label className="label mt-4 block" htmlFor={`${testId}-input`}>{label}</label>
        <textarea
          id={`${testId}-input`}
          data-testid={`${testId}-input`}
          className="input min-h-[80px]"
          value={reason}
          autoFocus
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
        />
        {!valid && (
          <p className="mt-1 text-[11px] text-slate-400" data-testid={`${testId}-hint`}>
            {`≥ ${minLength}`}
          </p>
        )}
        {error && (
          <p role="alert" data-testid={`${testId}-error`} className="mt-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
            {error}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            data-testid={`${testId}-cancel`}
            onClick={onCancel}
            disabled={busy}
            className="btn-secondary px-3 py-1.5 text-xs"
          >
            {cancelLabel}
          </button>
          <button
            type="submit"
            data-testid={`${testId}-confirm`}
            disabled={!valid || busy}
            aria-busy={busy}
            className="btn-primary px-3 py-1.5 text-xs"
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
