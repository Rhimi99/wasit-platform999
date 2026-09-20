import type { SmsMessage, SmsTransport } from './port';

export interface HttpSmsAuth {
  scheme: 'bearer' | 'basic' | 'none';
  token?: string;
  username?: string;
  password?: string;
}

export interface HttpSmsConfig {
  url: string;
  auth: HttpSmsAuth;
  /** Sender id / origination number the gateway expects. */
  sender: string;
  /** JSON field names for the destination, body and sender. */
  toField: string;
  textField: string;
  senderField: string;
  /** Optional extra headers (e.g. provider-specific API version). */
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Generic HTTP SMS transport. It POSTs a JSON body to a provider endpoint and
 * treats any non-2xx response as a delivery failure (thrown so `sendSms` can
 * audit it). The request shape is configurable through field names so the same
 * class fits the common `{ to, text }` gateways without a code change; providers
 * whose API differs structurally get their own `SmsTransport` in this folder.
 *
 * Credentials come only from the environment, never the repository.
 */
export class HttpSmsTransport implements SmsTransport {
  readonly id = 'http';

  constructor(private readonly config: HttpSmsConfig) {}

  isAvailable(): boolean {
    if (!this.config.url) return false;
    if (this.config.auth.scheme === 'bearer') return Boolean(this.config.auth.token);
    if (this.config.auth.scheme === 'basic') {
      return Boolean(this.config.auth.username && this.config.auth.password);
    }
    return true;
  }

  async send(message: SmsMessage): Promise<void> {
    if (!this.isAvailable()) {
      throw new Error('SMS_HTTP_URL is not configured');
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(this.config.headers ?? {}),
    };
    if (this.config.auth.scheme === 'bearer') {
      headers.Authorization = `Bearer ${this.config.auth.token}`;
    } else if (this.config.auth.scheme === 'basic') {
      const raw = `${this.config.auth.username}:${this.config.auth.password}`;
      headers.Authorization = `Basic ${Buffer.from(raw).toString('base64')}`;
    }

    const body: Record<string, string> = {
      [this.config.toField]: message.to,
      [this.config.textField]: message.text,
    };
    if (this.config.sender) body[this.config.senderField] = this.config.sender;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 10_000);
    try {
      const res = await fetch(this.config.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`SMS gateway responded ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}