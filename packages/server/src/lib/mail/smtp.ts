import nodemailer, { type Transporter } from 'nodemailer';
import type { MailMessage, MailTransport } from './port';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
}

/**
 * SMTP transport (vendor-neutral: works with any provider that speaks SMTP).
 *
 * Credentials come only from the environment. When SMTP is not configured the
 * transport reports `isAvailable() === false` and `send()` throws a tagged
 * error, so the caller decides how to degrade rather than silently dropping
 * authentication email.
 */
export class SmtpMailTransport implements MailTransport {
  readonly id = 'smtp';
  private readonly transporter: Transporter;

  constructor(private readonly config: SmtpConfig) {
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.user ? { user: config.user, pass: config.password } : undefined,
    });
  }

  isAvailable(): boolean {
    return Boolean(this.config.host);
  }

  async send(message: MailMessage): Promise<void> {
    if (!this.isAvailable()) {
      throw new Error('SMTP_HOST is not configured');
    }
    await this.transporter.sendMail({
      from: this.config.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}