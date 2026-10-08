import { ConfigService } from '@nestjs/config';
import { createEmailSender } from './email-sender.provider';
import { ResendEmailSender } from './resend-email.sender';
import { SmtpEmailSender } from './smtp-email.sender';

describe('createEmailSender', () => {
  afterEach(() => jest.restoreAllMocks());

  it('invokes only SMTP when SMTP is selected', async () => {
    const smtpSend = jest
      .spyOn(SmtpEmailSender.prototype, 'send')
      .mockResolvedValue(undefined);
    const resendSend = jest.spyOn(ResendEmailSender.prototype, 'send');
    const sender = createEmailSender(
      new ConfigService({
        EMAIL_PROVIDER: 'smtp',
        SMTP_HOST: 'smtp.example.test',
        SMTP_FROM: 'no-reply@example.test',
        SMTP_PORT: 587,
        SMTP_SECURE: false,
        SMTP_REQUIRE_TLS: true,
      }),
    );
    await sender.send({
      to: 'owner@example.test',
      subject: 'Test',
      text: 'Link',
    });
    expect(sender).toBeInstanceOf(SmtpEmailSender);
    expect(smtpSend).toHaveBeenCalledTimes(1);
    expect(resendSend).not.toHaveBeenCalled();
  });

  it('invokes only Resend when Resend is selected', async () => {
    const smtpSend = jest.spyOn(SmtpEmailSender.prototype, 'send');
    const resendSend = jest
      .spyOn(ResendEmailSender.prototype, 'send')
      .mockResolvedValue(undefined);
    const sender = createEmailSender(
      new ConfigService({
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_example_test_key_12345',
        RESEND_FROM: 'no-reply@example.test',
      }),
    );
    await sender.send({
      to: 'owner@example.test',
      subject: 'Test',
      text: 'Link',
    });
    expect(sender).toBeInstanceOf(ResendEmailSender);
    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(smtpSend).not.toHaveBeenCalled();
  });
});
