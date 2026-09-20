import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiCall, formatDate } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import { useAuth } from '@/lib/auth-context';
import { AppLayout } from '@/components/layouts/AppLayout';
import { Card, EmptyState, ErrorState, SectionHeader, Spinner } from '@/components/ui';
import type { ThreadDetail, ThreadMessage, ThreadSummary } from '@/lib/types';

interface NewThreadModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (threadId: string) => void;
}

function NewThreadModal({ open, onClose, onCreated }: NewThreadModalProps) {
  const { t } = useI18n();
  const [userId, setUserId] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  if (!open) return null;

  async function submit() {
    if (!userId.trim() || !body.trim()) return;
    setSending(true);
    setError(null);
    const res = await apiCall(() =>
      api.openThread({ participantUserId: userId.trim(), subject: subject.trim() || undefined, body: body.trim() }));
    setSending(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    onCreated(res.data!.threadId);
    onClose();
    setUserId('');
    setSubject('');
    setBody('');
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-3 text-base font-semibold text-slate-800">{t('messages.newTitle')}</h3>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">{t('messages.withUser')} (User ID)</label>
            <input
              dir="ltr"
              className="input"
              placeholder="00000000-0000-0000-0000-000000000000"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">{t('common.info')}</label>
            <input
              className="input"
              placeholder="Subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">{t('messages.compose')}</label>
            <textarea
              className="input min-h-24"
              placeholder={t('messages.newPlaceholder')}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex items-center justify-end gap-2">
            <button className="btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
            <button className="btn-primary disabled:opacity-50" disabled={sending || (!userId.trim() || !body.trim())} onClick={submit}>
              {sending ? t('common.loading') : t('messages.start')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function threadDisplayName(thread: ThreadSummary, currentUserId: string): string {
  const other = thread.participants.find((p) => p.userId !== currentUserId);
  return other?.displayName ?? other?.email ?? thread.subject ?? thread.id.slice(0, 8);
}

export function DashboardMessagesPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ThreadSummary | null>(null);
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [compose, setCompose] = useState('');
  const [sending, setSending] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadThreads = useCallback(async (q = '') => {
    setLoading(true);
    setError(null);
    const res = await apiCall(() => api.listThreads({ q: q || undefined }));
    if (res.data) setThreads(res.data.items);
    setError(res.error);
    setLoading(false);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => loadThreads(search), 300);
    return () => clearTimeout(timer);
  }, [search, loadThreads]);

  useEffect(() => {
    loadThreads();
  }, [loadThreads]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [detail?.messages.length, selected?.id]);

  async function openThread(thread: ThreadSummary) {
    setSelected(thread);
    setDetailLoading(true);
    setDetail(null);
    const res = await apiCall(() => api.getThread(thread.id));
    if (res.data) {
      setDetail(res.data);
      // Update unread badge to 0 for the opened thread.
      setThreads((prev) => prev.map((th) => (th.id === thread.id ? { ...th, unreadCount: 0 } : th)));
    } else {
      setDetail(null);
    }
    setDetailLoading(false);
  }

  async function handleSend() {
    if (!selected || !compose.trim() || sending) return;
    setSending(true);
    const res = await apiCall(() => api.sendMessage(selected.id, compose.trim()));
    if (res.data) {
      setCompose('');
      const refreshed = await apiCall(() => api.getThread(selected.id));
      if (refreshed.data) setDetail(refreshed.data);
    }
    setSending(false);
  }

  const otherParticipants = detail?.participants.filter((p) => p.userId !== user?.id) ?? [];
  const otherName = otherParticipants[0]?.displayName ?? otherParticipants[0]?.email ?? selected?.subject ?? '';

  return (
    <AppLayout>
      <SectionHeader title={t('messages.myMessages')} />
      <div className="mx-auto max-w-5xl">
        <div className="grid h-[calc(100vh-220px)] grid-cols-1 gap-4 md:grid-cols-[300px_1fr]">
          {/* Thread list pane */}
          <Card className="min-h-0 overflow-hidden p-0">
            <div className="border-b border-slate-100 p-3">
              <div className="flex items-center gap-2">
                <input
                  className="input h-9 flex-1 text-sm"
                  placeholder={t('messages.search')}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <button className="btn-primary h-9 whitespace-nowrap px-3 text-xs" onClick={() => setModalOpen(true)}>{t('messages.new')}</button>
              </div>
            </div>
            <div className="max-h-[calc(100vh-320px)] min-h-0 overflow-y-auto">
              {loading && <div className="p-6"><Spinner /></div>}
              {!loading && error && <div className="p-3"><ErrorState message={error} /></div>}
              {!loading && !error && threads.length === 0 && (
                <div className="p-4"><EmptyState title={search ? t('messages.searchEmpty') : t('messages.empty')} /></div>
              )}
              {!loading && threads.map((th) => {
                const unread = th.unreadCount;
                const other = threadDisplayName(th, user?.id ?? '') || th.subject || th.id.slice(0, 8);
                return (
                  <button
                    key={th.id}
                    onClick={() => openThread(th)}
                    className={`flex w-full items-start gap-2 border-b border-slate-50 px-3 py-3 text-start transition ${selected?.id === th.id ? 'bg-wasit-50' : 'hover:bg-slate-50'}`}
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-wasit-100 text-sm font-semibold text-wasit-700">
                      {other.slice(0, 1).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between">
                        <span className="truncate text-sm font-medium text-slate-700">{other}</span>
                        {th.lastMessage && (
                          <span className="ms-2 shrink-0 text-[10px] text-slate-400">
                            {formatTime(th.lastMessage.createdAt)}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs text-slate-500">{th.lastMessage?.body ?? ''}</span>
                        {unread > 0 && (
                          <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-wasit-600 px-1.5 text-[10px] font-bold text-white">
                            {unread}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </Card>

          {/* Conversation pane */}
          <Card className="flex min-h-0 flex-col p-0">
            {!selected ? (
              <div className="flex flex-1 items-center justify-center">
                <EmptyState title={t('messages.selectThread')} />
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-800">{otherName || selected.subject || t('messages.title')}</div>
                    <div className="text-xs text-slate-400">
                      {t('messages.participants')}: {otherParticipants.map((p) => p.displayName ?? p.email).join('، ') || t('messages.you')}
                    </div>
                  </div>
                  {detail?.isBlocked && <span className="text-xs font-medium text-red-500">{t('messages.blocked')}</span>}
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50/50 px-4 py-4">
                  {detailLoading && <div className="p-6"><Spinner /></div>}
                  {!detailLoading && detail && detail.messages.length === 0 && (
                    <EmptyState title={t('messages.noMessages')} />
                  )}
                  {!detailLoading && detail?.messages.map((m) => {
                  const sender = detail.participants.find((p) => p.userId === m.senderId);
                  const senderName = sender?.displayName ?? sender?.email ?? m.senderId.slice(0, 8);
                  return <MessageBubble key={m.id} m={m} isMine={m.senderId === user?.id} myName={t('messages.you')} otherName={senderName} />;
                })}
                  <div ref={bottomRef} />
                </div>

                <div className="border-t border-slate-100 p-3">
                  {detail?.isBlocked ? (
                    <p className="p-2 text-center text-xs text-red-500">{t('messages.blocked')}</p>
                  ) : (
                    <div className="flex items-end gap-2">
                      <textarea
                        className="input min-h-12 flex-1 resize-none text-sm"
                        placeholder={t('messages.compose')}
                        value={compose}
                        onChange={(e) => setCompose(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            handleSend();
                          }
                        }}
                      />
                      <button className="btn-primary h-12 whitespace-nowrap px-4" onClick={handleSend} disabled={sending || !compose.trim()}>
                        {sending ? t('common.loading') : t('messages.send')}
                      </button>
                    </div>
                  )}
                  <p className="mt-1 text-center text-[10px] text-slate-400">{t('messages.sendHint')}</p>
                </div>
              </>
            )}
          </Card>
        </div>
      </div>
      <NewThreadModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={async (threadId) => {
          const loaded = await apiCall(() => api.listThreads());
          if (loaded.data) setThreads(loaded.data.items);
          const found = threads.find((th) => th.id === threadId) ?? loaded.data?.items.find((th) => th.id === threadId);
          if (found) {
            await openThread(found);
          } else {
            setDetailLoading(true);
            const d = await apiCall(() => api.getThread(threadId));
            if (d.data) {
              setDetail(d.data);
              setSelected({ id: threadId, subject: d.data.subject, unreadCount: 0, participantCount: d.data.participants.length, participants: d.data.participants.map((p) => ({ userId: p.userId, displayName: p.displayName, email: p.email })), createdAt: d.data.createdAt, updatedAt: d.data.updatedAt, relatedEntityId: null, relatedEntityType: null, isBlocked: false, lastMessage: null } as ThreadSummary);
            }
            setDetailLoading(false);
          }
        }}
      />
    </AppLayout>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameDay = new Date().toDateString() === d.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return formatDate(d);
}

function MessageBubble({ m, isMine, myName, otherName }: { m: ThreadMessage; isMine: boolean; myName: string; otherName: string }) {
  return (
    <div className={`mb-2 flex ${isMine ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm shadow-sm ${isMine ? 'rounded-br-sm bg-wasit-600 text-white' : 'rounded-bl-sm bg-white text-slate-700'}`}>
        <div className="mb-0.5 text-[10px] font-semibold opacity-80">{isMine ? myName : otherName}</div>
        <p className="whitespace-pre-wrap break-words">{m.body}</p>
        <div className={`mt-1 flex items-center justify-end gap-1 text-[10px] ${isMine ? 'opacity-80' : 'text-slate-400'}`}>
          <span>{formatTime(m.createdAt)}</span>
          {isMine && (
            m.status === 'READ'
              ? <span>✓✓</span>
              : m.status === 'DELIVERED'
                ? <span>✓✓</span>
                : <span>✓</span>
          )}
        </div>
      </div>
    </div>
  );
}