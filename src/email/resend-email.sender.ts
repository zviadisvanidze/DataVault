import { ConfigService } from '@nestjs/config';
import { EmailMessage, EmailSender } from './email-sender';

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
const RESEND_TIMEOUT_MS = 10_000;

export class ResendEmailSender implements EmailSender {
  private readonly apiKey: string;
  private readonly from: string;

  constructor(config: ConfigService) {
    this.apiKey = config.getOrThrow<string>('RESEND_API_KEY');
    this.from = config.getOrThrow<string>('RESEND_FROM');
  }

  async send(message: EmailMessage): Promise<void> {
    try {
      const response = await fetch(RESEND_EMAILS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
        }),
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
        redirect: 'error',
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error('Email delivery failed');
    } catch {
      // Provider responses can contain addresses, message bodies, or credentials.
      throw new Error('Email delivery failed');
    }
  }
}
