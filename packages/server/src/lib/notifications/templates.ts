import type { NotificationChannel } from './types';

export type NotifLocale = 'ar' | 'fr' | 'en';

/**
 * User-facing copy for lifecycle notifications, kept out of the engine so the
 * wording (or a new locale) never touches delivery logic — the same split the
 * auth mail/SMS templates use. Locale falls back to `ar`, the platform's
 * primary market.
 *
 * Copy is deliberately free of sensitive data: it names the order by its public
 * number and the amount, never a payment instrument, address or code.
 */
interface Copy {
  title: string;
  body: string;
}

type CopyTable = Record<NotifLocale, (vars: Record<string, string>) => Copy>;

function locale(l: string | null | undefined): NotifLocale {
  const key = (l ?? 'ar').slice(0, 2).toLowerCase();
  return key === 'fr' || key === 'en' || key === 'ar' ? key : 'ar';
}

function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
}

const ORDER_CREATED: CopyTable = {
  ar: (v) => ({ title: 'طلب جديد', body: fill('تم استلام الطلب {orderNumber}.', v) }),
  fr: (v) => ({ title: 'Nouvelle commande', body: fill('La commande {orderNumber} a été reçue.', v) }),
  en: (v) => ({ title: 'New order', body: fill('Order {orderNumber} was received.', v) }),
};

const ORDER_STATUS_CHANGED: CopyTable = {
  ar: (v) => ({ title: 'تحديث حالة الطلب', body: fill('أصبحت حالة الطلب {orderNumber}: {status}.', v) }),
  fr: (v) => ({ title: 'Statut de la commande mis à jour', body: fill('La commande {orderNumber} est désormais : {status}.', v) }),
  en: (v) => ({ title: 'Order status updated', body: fill('Order {orderNumber} is now {status}.', v) }),
};

const PAYMENT_SUCCEEDED: CopyTable = {
  ar: (v) => ({ title: 'تم تأكيد الدفع', body: fill('تم تأكيد الدفع للطلب {orderNumber} بمبلغ {amount} {currency}.', v) }),
  fr: (v) => ({ title: 'Paiement confirmé', body: fill('Le paiement de la commande {orderNumber} ({amount} {currency}) est confirmé.', v) }),
  en: (v) => ({ title: 'Payment confirmed', body: fill('Payment for order {orderNumber} ({amount} {currency}) is confirmed.', v) }),
};

const PAYMENT_FAILED: CopyTable = {
  ar: (v) => ({ title: 'فشل الدفع', body: fill('تعذّر إتمام الدفع للطلب {orderNumber}.', v) }),
  fr: (v) => ({ title: 'Paiement échoué', body: fill('Le paiement de la commande {orderNumber} a échoué.', v) }),
  en: (v) => ({ title: 'Payment failed', body: fill('Payment for order {orderNumber} failed.', v) }),
};

const REFUND_COMPLETED: CopyTable = {
  ar: (v) => ({ title: 'تم الاسترداد', body: fill('تم استرداد {amount} {currency} للطلب {orderNumber}.', v) }),
  fr: (v) => ({ title: 'Remboursement effectué', body: fill('Un remboursement de {amount} {currency} a été effectué pour la commande {orderNumber}.', v) }),
  en: (v) => ({ title: 'Refund processed', body: fill('A refund of {amount} {currency} was processed for order {orderNumber}.', v) }),
};

const TABLES: Record<string, CopyTable> = {
  ORDER_CREATED,
  ORDER_STATUS_CHANGED,
  PAYMENT_SUCCEEDED,
  PAYMENT_FAILED,
  REFUND_COMPLETED,
};

/**
 * Renders the title/body for an event in the recipient's locale. An unknown
 * event falls back to a neutral, non-sensitive line rather than throwing, so a
 * new call site can never crash a completed business transaction.
 */
export function renderNotification(
  type: string,
  vars: Record<string, string>,
  l: string | null | undefined,
): Copy {
  const table = TABLES[type];
  if (!table) return { title: type, body: type };
  return table[locale(l)](vars);
}

/**
 * The placeholder names a template needs, in declaration order and deduplicated.
 * Derived from the copy itself so it can never drift from the wording: the
 * template is rendered against a proxy that echoes each placeholder, and the
 * survivors are the required keys. All locales share one placeholder set, so the
 * Arabic table is representative. Returns `[]` for an unknown event (no template
 * — the caller supplies its own copy).
 */
export function templatePlaceholders(type: string): string[] {
  const table = TABLES[type];
  if (!table) return [];
  const echo = new Proxy(
    {},
    {
      get: (_t, key) => (typeof key === 'string' ? `{${key}}` : undefined),
      has: () => true,
    },
  ) as Record<string, string>;
  const copy = table.ar(echo);
  const found = `${copy.title} ${copy.body}`.match(/\{(\w+)\}/g) ?? [];
  return [...new Set(found.map((p) => p.slice(1, -1)))];
}

/** Plain-text/HTML bodies for the email channel, from the same copy. */
export function emailParts(copy: Copy): { subject: string; text: string; html: string } {
  return {
    subject: copy.title,
    text: copy.body,
    html: `<p>${copy.body}</p>`,
  };
}

/** Short single-segment body for the SMS channel. */
export function smsBody(copy: Copy): string {
  return `WASIT — ${copy.body}`;
}

export type { NotificationChannel };
