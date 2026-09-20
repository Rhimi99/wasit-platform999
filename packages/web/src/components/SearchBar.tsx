import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '@/lib/i18n-context';

const TYPE_OPTIONS = [
  { value: 'all', key: 'search.all' },
  { value: 'products', key: 'search.products' },
  { value: 'suppliers', key: 'search.suppliers' },
  { value: 'merchants', key: 'search.merchants' },
  { value: 'companies', key: 'search.companies' },
  { value: 'categories', key: 'search.categories' },
];

export function SearchBar({ initial = '', autoFocus = false }: { initial?: string; autoFocus?: boolean }) {
  const { t } = useI18n();
  const [q, setQ] = useState(initial);
  const [type, setType] = useState('all');
  const navigate = useNavigate();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = q.trim();
    if (!trimmed) return;
    navigate(`/search?q=${encodeURIComponent(trimmed)}&type=${type}`);
  };

  return (
    <form onSubmit={submit} className="flex w-full max-w-2xl items-center gap-2">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('nav.search')}
        className="input"
        autoFocus={autoFocus}
        aria-label="Search"
      />
      <select value={type} onChange={(e) => setType(e.target.value)} className="input w-auto" aria-label="Search type">
        {TYPE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{t(o.key)}</option>
        ))}
      </select>
      <button type="submit" className="btn-primary shrink-0">🔍 {t('common.search')}</button>
    </form>
  );
}