import { ConfigService } from '@nestjs/config';
import { EmailSender } from './email-sender';
import { ResendEmailSender } from './resend-email.sender';
import { SmtpEmailSender } from './smtp-email.sender';

export function createEmailSender(config: ConfigService): EmailSender {
  switch (config.getOrThrow<string>('EMAIL_PROVIDER')) {
    case 'smtp':
      return new SmtpEmailSender(config);
    case 'resend':
      return new ResendEmailSender(config);
    default:
      throw new Error('EMAIL_PROVIDER must be smtp or resend');
  }
}
