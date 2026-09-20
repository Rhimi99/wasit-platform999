/**
 * Anti-fee-evasion signal detection.
 *
 * The purpose is to notice attempts to move a WASIT transaction off-platform
 * (which would bypass the seller commission) without turning the messenger into
 * a surveillance tool. Two deliberate privacy rules:
 *
 *  1. Detection runs on the message text in memory. Only signal *codes* and
 *     counts reach the database — never the matched text, phone number or link,
 *     and never the full message body.
 *  2. A signal is a hint for the risk team, not a verdict. Nothing is blocked or
 *     auto-penalised here; it feeds the separate Risk Engine.
 */

export type FeeEvasionSignalCode =
  | 'OFF_PLATFORM_PHONE'
  | 'OFF_PLATFORM_EMAIL'
  | 'OFF_PLATFORM_SOCIAL'
  | 'DIRECT_PAYMENT_REQUEST'
  | 'OFF_PLATFORM_DEAL_PHRASE';

export interface FeeEvasionSignal {
  code: FeeEvasionSignalCode;
  weight: number;
  /** Human-readable, contains no captured value. */
  message: string;
}

interface Rule {
  code: FeeEvasionSignalCode;
  weight: number;
  message: string;
  pattern: RegExp;
}

// Tunisian/international phone numbers, with or without separators.
const PHONE = /(?:\+?\d[\s.-]?){7,15}\d/;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
// WhatsApp/Telegram handles and common off-platform domains.
const SOCIAL =
  /(?:wa\.me|whatsapp|telegram|t\.me|instagram|facebook|messenger|viber|signal\.me|snapchat)/i;
const DIRECT_PAYMENT =
  /(?:western\s*union|moneygram|d17\s*transfer|p2p\s*transfer|حوالة|تحويل\s*مباشر|دفع\s*مباشر\s*لي|نقدا|كاش)/i;
const DEAL_PHRASE =
  /(?:outside\s+wasit|off\s*platform|avoid\s+(?:the\s+)?(?:commission|fee)|بدون\s*عمولة|خارج\s*(?:الوسيط|المنصة)|تجاوز\s*العمولة)/i;

const RULES: Rule[] = [
  { code: 'OFF_PLATFORM_PHONE', weight: 15, message: 'Message contains a phone number', pattern: PHONE },
  { code: 'OFF_PLATFORM_EMAIL', weight: 15, message: 'Message contains an email address', pattern: EMAIL },
  { code: 'OFF_PLATFORM_SOCIAL', weight: 20, message: 'Message references an off-platform channel', pattern: SOCIAL },
  { code: 'DIRECT_PAYMENT_REQUEST', weight: 25, message: 'Message suggests a direct payment method', pattern: DIRECT_PAYMENT },
  { code: 'OFF_PLATFORM_DEAL_PHRASE', weight: 30, message: 'Message mentions dealing outside the platform', pattern: DEAL_PHRASE },
];

/**
 * Scans a single message. Returns one signal per matched rule at most, so a long
 * message cannot inflate the score by repeating the same hint.
 */
export function detectOffPlatformSignals(text: string): FeeEvasionSignal[] {
  if (!text) return [];
  const signals: FeeEvasionSignal[] = [];
  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      signals.push({ code: rule.code, weight: rule.weight, message: rule.message });
    }
  }
  return signals;
}

/** True when a message carried at least one evasion hint worth recording. */
export function hasFeeEvasionSignal(text: string): boolean {
  return detectOffPlatformSignals(text).length > 0;
}
