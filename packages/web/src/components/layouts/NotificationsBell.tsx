import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, apiCall, formatDate } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import type { NotificationItem } from '@/lib/types';

export function NotificationsBell() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  const loadUnread = useCallback(async () => {
    const res = await apiCall(() => api.unreadNotificationCount());
    if (res.data) setUnread(res.data.count);
  }, []);

  const loadList = useCallback(async () => {
    const res = await apiCall(() => api.listNotifications({ pageSize: 20 }));
    if (res.data) {
      setItems(res.data.items);
      setUnread(res.data.unreadCount);
    }
  }, []);

  useEffect(() => {
    loadUnread();
    const id = setInterval(loadUnread, 20000);
    return () => clearInterval(id);
  }, [loadUnread]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  async function toggle() {
    if (!open) await loadList();
    setOpen((o) => !o);
  }

  async function clickNotification(n: NotificationItem) {
    if (!n.readAt) {
      await apiCall(() => api.markNotificationRead(n.id));
      setUnread((u) => Math.max(0, u - 1));
      setItems((prev) => prev.map((i) => (i.id === n.id ? { ...i, readAt: new Date().toISOString() } : i)));
    }
    setOpen(false);
  }

  async function markAll() {
    await apiCall(() => api.markAllNotificationsRead());
    setUnread(0);
    setItems((prev) => prev.map((i) => (i.readAt ? i : { ...i, readAt: new Date().toISOString() })));
  }

  return (
    <div className="relative" ref={ref}>
      <button className="relative rounded-md p-2 text-slate-500 hover:bg-slate-100" aria-label={t('notifications.title')} onClick={toggle}>
        🔔
        {unread > 0 && (
          <span className="absolute -end-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute end-0 top-12 z-50 w-80 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
            <span className="text-sm font-semibold text-slate-700">{t('notifications.title')}</span>
            <button className="text-xs text-wasit-600 hover:underline" onClick={markAll}>
              {t('notifications.markAll')}
            </button>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <p className="p-6 text-center text-sm text-slate-400">{t('notifications.empty')}</p>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  onClick={() => clickNotification(n)}
                  className={`flex w-full flex-col items-start gap-0.5 border-b border-slate-50 px-3 py-2.5 text-start transition ${n.readAt ? 'bg-white' : 'bg-wasit-50/50'}`}
                >
                  <div className="flex w-full items-center justify-between">
                    <span className={`text-sm ${n.readAt ? 'font-medium text-slate-600' : 'font-semibold text-slate-800'}`}>
                      {notifTitle(n, t('notifications.type.MESSAGE.NEW'))}
                    </span>
                    {!n.readAt && <span className="h-2 w-2 shrink-0 rounded-full bg-wasit-500" />}
                  </div>
                  {n.body && <span className="line-clamp-2 w-full text-xs text-slate-500">{n.body}</span>}
                  <span className="mt-0.5 text-[10px] text-slate-400">{formatDate(n.createdAt)}</span>
                </button>
              ))
            )}
          </div>
          {items.some((n) => n.data?.threadId) && (
            <div className="border-t border-slate-100 p-2">
              <Link to="/dashboard/messages" onClick={() => setOpen(false)} className="block rounded-md bg-wasit-50 px-3 py-1.5 text-center text-xs font-medium text-wasit-700 hover:bg-wasit-100">
                {t('messages.myMessages')}
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function notifTitle(n: NotificationItem, fallback: string): string {
  if (n.data?.title && typeof n.data.title === 'string') return n.data.title;
  return fallback;
}