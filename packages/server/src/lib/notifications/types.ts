/**
 * Notification engine vocabulary — channels, categories and the event registry.
 *
 * A notification event is described once here so the engine, the delivery
 * ledger, the preference lookup and the tests all agree on the same names. The
 * registry also decides which channels an event may use by default and which
 * preference category it belongs to, so a new lifecycle event is added in one
 * place rather than wired at each call site.
 */

export type NotificationChannel = 'IN_APP' | 'EMAIL' | 'SMS' | 'PUSH' | 'WEBHOOK';

export const NOTIFICATION_CHANNELS: readonly NotificationChannel[] = [
  'IN_APP',
  'EMAIL',
  'SMS',
  'PUSH',
  'WEBHOOK',
];

/**
 * Preference category. A user opts a whole category in or out per channel via
 * `notification_preferences`; the engine never reads a preference for a channel
 * the event does not use.
 */
export type NotificationCategory =
  | 'ORDER'
  | 'PAYMENT'
  | 'REFUND'
  | 'INVENTORY'
  | 'DISPUTE'
  | 'VERIFICATION'
  | 'SECURITY'
  | 'SYSTEM';

export const NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [
  'ORDER',
  'PAYMENT',
  'REFUND',
  'INVENTORY',
  'DISPUTE',
  'VERIFICATION',
  'SECURITY',
  'SYSTEM',
];

/** Outcome recorded in the delivery ledger for a single channel send. */
export type DeliveryStatus = 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED';

export interface NotificationEventDefinition {
  category: NotificationCategory;
  /** Channels this event may use. `IN_APP` is always offered; others are opt-in per event. */
  channels: readonly NotificationChannel[];
}

/**
 * Lifecycle events wired to the engine. Order and money events carry the full
 * channel set; they are the ones a buyer or seller must not miss. The registry
 * is the single source of truth for a category/channel decision.
 */
export const NOTIFICATION_EVENTS: Record<string, NotificationEventDefinition> = {
  ORDER_CREATED: { category: 'ORDER', channels: ['IN_APP', 'EMAIL', 'SMS', 'PUSH', 'WEBHOOK'] },
  ORDER_STATUS_CHANGED: { category: 'ORDER', channels: ['IN_APP', 'EMAIL', 'SMS', 'PUSH', 'WEBHOOK'] },
  PAYMENT_SUCCEEDED: { category: 'PAYMENT', channels: ['IN_APP', 'EMAIL', 'SMS', 'PUSH', 'WEBHOOK'] },
  PAYMENT_FAILED: { category: 'PAYMENT', channels: ['IN_APP', 'EMAIL', 'SMS', 'PUSH', 'WEBHOOK'] },
  REFUND_COMPLETED: { category: 'REFUND', channels: ['IN_APP', 'EMAIL', 'SMS', 'PUSH', 'WEBHOOK'] },
  INVENTORY_LOW_STOCK: { category: 'INVENTORY', channels: ['IN_APP'] },
  INVENTORY_OUT_OF_STOCK: { category: 'INVENTORY', channels: ['IN_APP'] },
};

export function eventDefinition(type: string): NotificationEventDefinition {
  return NOTIFICATION_EVENTS[type] ?? { category: 'SYSTEM', channels: ['IN_APP'] };
}
