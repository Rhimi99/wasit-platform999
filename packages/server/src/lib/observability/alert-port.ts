export type AlertSeverity = 'WARNING' | 'CRITICAL';
export type AlertStatus = 'FIRING' | 'RESOLVED';

export interface AlertNotification {
  rule: string;
  severity: AlertSeverity;
  status: AlertStatus;
  summary: string;
  details: Record<string, unknown>;
  occurredAt: string;
}

/**
 * Where an alert goes when it fires. Kept behind a port (like mail/SMS) so the
 * delivery channel is deployment-specific and swappable: an operator can log,
 * POST to a webhook (Slack/Mattermost/PagerDuty bridge), or add a new adapter
 * without touching the rule engine.
 */
export interface AlertNotifier {
  readonly id: string;
  /** Whether the notifier is configured well enough to deliver. */
  isAvailable(): boolean;
  send(notification: AlertNotification): Promise<void>;
}