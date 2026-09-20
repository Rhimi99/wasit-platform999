import type { MailMessage } from './port';

export type MailLocale = 'ar' | 'fr' | 'en';

interface TemplateStrings {
  subject: string;
  greeting: string;
  body: string;
  cta: string;
  ignore: string;
  expiry: string;
}

/**
 * User-facing transactional copy. Kept out of the service layer so the wording
 * can change (or gain locales) without touching token/audit logic. Locale
 * falls back to `ar` — the platform's primary market.
 */
const VERIFY_EMAIL: Record<MailLocale, TemplateStrings> = {
  ar: {
    subject: 'أكد بريدك الإلكتروني — WASIT BUSINESS GLOBAL',
    greeting: 'مرحبًا،',
    body: 'شكرًا لتسجيلك في WASIT. لتأكيد بريدك الإلكتروني وتفعيل حسابك، اضغط على الرابط التالي:',
    cta: 'تأكيد البريد الإلكتروني',
    ignore: 'إذا لم تنشئ هذا الحساب، يمكنك تجاهل هذه الرسالة.',
    expiry: 'تنتهي صلاحية هذا الرابط خلال {hours} ساعة.',
  },
  fr: {
    subject: 'Confirmez votre e-mail — WASIT BUSINESS GLOBAL',
    greeting: 'Bonjour,',
    body: 'Merci de votre inscription sur WASIT. Pour confirmer votre adresse e-mail et activer votre compte, cliquez sur le lien ci-dessous :',
    cta: 'Confirmer l’e-mail',
    ignore: 'Si vous n’êtes pas à l’origine de cette inscription, ignorez ce message.',
    expiry: 'Ce lien expire dans {hours} heure(s).',
  },
  en: {
    subject: 'Confirm your email — WASIT BUSINESS GLOBAL',
    greeting: 'Hello,',
    body: 'Thanks for signing up for WASIT. To confirm your email address and activate your account, click the link below:',
    cta: 'Confirm email',
    ignore: 'If you did not create this account, you can safely ignore this message.',
    expiry: 'This link expires in {hours} hour(s).',
  },
};

const RESET_PASSWORD: Record<MailLocale, TemplateStrings> = {
  ar: {
    subject: 'إعادة تعيين كلمة المرور — WASIT BUSINESS GLOBAL',
    greeting: 'مرحبًا،',
    body: 'وصلنا طلب لإعادة تعيين كلمة المرور. لإكمال العملية، اضغط على الرابط التالي:',
    cta: 'إعادة تعيين كلمة المرور',
    ignore: 'إذا لم تطلب ذلك، تجاهل هذه الرسالة — ستبقى كلمة مرورك دون تغيير.',
    expiry: 'تنتهي صلاحية هذا الرابط خلال {hours} ساعة.',
  },
  fr: {
    subject: 'Réinitialisation du mot de passe — WASIT BUSINESS GLOBAL',
    greeting: 'Bonjour,',
    body: 'Nous avons reçu une demande de réinitialisation de votre mot de passe. Pour continuer, cliquez sur le lien ci-dessous :',
    cta: 'Réinitialiser le mot de passe',
    ignore: 'Si vous n’êtes pas à l’origine de cette demande, ignorez ce message — votre mot de passe reste inchangé.',
    expiry: 'Ce lien expire dans {hours} heure(s).',
  },
  en: {
    subject: 'Reset your password — WASIT BUSINESS GLOBAL',
    greeting: 'Hello,',
    body: 'We received a request to reset your password. To continue, click the link below:',
    cta: 'Reset password',
    ignore: 'If you did not request this, ignore this message — your password will not change.',
    expiry: 'This link expires in {hours} hour(s).',
  },
};

function normalizeLocale(locale?: string | null): MailLocale {
  return locale === 'fr' || locale === 'en' || locale === 'ar' ? locale : 'ar';
}

function render(link: string, t: TemplateStrings, hours: number): { subject: string; text: string; html: string } {
  const expiry = t.expiry.replace('{hours}', String(hours));
  const text = [t.greeting, '', t.body, '', link, '', expiry, t.ignore].join('\n');
  const html = [
    `<p>${t.greeting}</p>`,
    `<p>${t.body}</p>`,
    `<p><a href="${link}">${t.cta}</a></p>`,
    `<p>${expiry}</p>`,
    `<p style="color:#666">${t.ignore}</p>`,
  ].join('\n');
  return { subject: t.subject, text, html };
}

export function buildVerificationEmail(input: {
  to: string;
  link: string;
  locale?: string | null;
  ttlHours: number;
}): MailMessage {
  const t = VERIFY_EMAIL[normalizeLocale(input.locale)];
  return { to: input.to, ...render(input.link, t, input.ttlHours) };
}

export function buildPasswordResetEmail(input: {
  to: string;
  link: string;
  locale?: string | null;
  ttlHours: number;
}): MailMessage {
  const t = RESET_PASSWORD[normalizeLocale(input.locale)];
  return { to: input.to, ...render(input.link, t, input.ttlHours) };
}