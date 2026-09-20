/**
 * SMS port — the only surface the rest of the server depends on for outgoing
 * text messages. Concrete transports implement this interface and are resolved
 * by `resolveSmsTransport()`; nothing transport-specific may leak beyond this
 * directory.
 *
 * Unlike email there is no universal wire protocol for SMS, so this port — not
 * a shared standard — is what keeps WASIT vendor-neutral: swapping providers
 * means adding one `SmsTransport` implementation here, with no changes to the
 * verification flow, routes or audit trail.
 */
export interface SmsMessage {
  /** E.164 or provider-accepted destination number. */
  to: string;
  /** Message body. Kept short on purpose: SMS is billed per segment. */
  text: string;
}

export interface SmsTransport {
  /** Stable id used in logs/status (e.g. `log`, `http`). */
  readonly id: string;
  /**
   * True when this transport can actually deliver a message right now
   * (credentials present). Non-functional transports must not throw on send;
   * they record/degrade instead so authentication flows never crash.
   */
  isAvailable(): boolean;
  send(message: SmsMessage): Promise<void>;
}