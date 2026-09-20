import type { SmsMessage } from './port';

export type SmsLocale = 'ar' | 'fr' | 'en';

interface PhoneVerifyStrings {
  body: string;
}

/**
 * User-facing transactional SMS copy. Kept out of the service layer so the
 * wording can change (or gain locales) without touching token/audit logic.
 * Locale falls back to `ar` — the platform's primary market.
 *
 * Messages are deliberately short (a single SMS segment where possible) and
 * carry only the code plus the brand, never the account's identity.
 */
const PHONE_VERIFY: Record<SmsLocale, PhoneVerifyStrings> = {
  ar: {
    body: 'رمز تأكيد WASIT: {code}. صالح لمدة {minutes} دقيقة. لا تشاركه مع أحد.',
  },
  fr: {
    body: 'Code de confirmation WASIT : {code}. Valable {minutes} min. Ne le partagez pas.',
  },
  en: {
    body: 'WASIT confirmation code: {code}. Valid for {minutes} min. Do not share it.',
  },
};

function pick(locale: string | null | undefined): PhoneVerifyStrings {
  const key = (locale ?? 'ar').slice(0, 2).toLowerCase() as SmsLocale;
  return PHONE_VERIFY[key] ?? PHONE_VERIFY.ar;
}

export function buildPhoneVerificationSms(input: {
  to: string;
  code: string;
  locale?: string | null;
  ttlMinutes: number;
}): SmsMessage {
  const tpl = pick(input.locale);
  return {
    to: input.to,
    text: tpl.body.replace('{code}', input.code).replace('{minutes}', String(input.ttlMinutes)),
  };
}