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