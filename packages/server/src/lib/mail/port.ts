/**
 * Mail port — the only surface the rest of the server depends on for outgoing
 * email. Concrete transports (SMTP, a provider API, a test capture) implement
 * this interface and are resolved by `resolveMailTransport()`; nothing
 * transport-specific may leak beyond this directory.
 */
export interface MailMessage {
  to: string;
  subject: string;
  /** Plain-text body. Always provided so every transport can deliver something. */
  text: string;
  /** Optional HTML body. */
  html?: string;
}

export interface MailTransport {
  /** Stable id used in logs/status (e.g. `smtp`, `log`, `capture`). */
  readonly id: string;
  /**
   * True when this transport can actually deliver mail right now (credentials
   * present, provider reachable). Non-functional transports must not throw on
   * send; they record/degrade instead so authentication flows never crash.
   */
  isAvailable(): boolean;
  send(message: MailMessage): Promise<void>;
}