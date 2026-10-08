import { ConfigService } from '@nestjs/config';
import { EmailService } from './email.service';

describe('EmailService', () => {
  it('sends a clear plaintext activation email through the provider-neutral contract', async () => {
    const sender = { send: jest.fn().mockResolvedValue(undefined) };
    const service = new EmailService(
      sender,
      new ConfigService({
        ACCOUNT_ACTIVATION_URL: 'https://app.example.test/auth/activate',
        EMPLOYEE_INVITATION_URL: 'https://app.example.test/invitations/accept',
      }),
    );
    await service.sendCompanyActivation(
      'owner@example.com',
      '<Acme>',
      'a'.repeat(43),
    );
    expect(sender.send).toHaveBeenCalledWith({
      to: 'owner@example.com',
      subject: 'Activate your DataVault account',
      text: [
        'Your DataVault company account for <Acme> is ready.',
        '',
        'Activate it within 24 hours:',
        'https://app.example.test/auth/activate?token=' + 'a'.repeat(43),
        '',
        'If you did not register this account, you can ignore this email.',
      ].join('\n'),
    });
  });

  it('sends an employee invitation without exposing internal token state', async () => {
    const sender = { send: jest.fn().mockResolvedValue(undefined) };
    const service = new EmailService(
      sender,
      new ConfigService({
        EMPLOYEE_INVITATION_URL: 'https://app.example.test/invitations/accept',
      }),
    );
    await service.sendEmployeeInvitation(
      'employee@example.com',
      'Acme',
      'b'.repeat(43),
    );
    expect(sender.send).toHaveBeenCalledWith({
      to: 'employee@example.com',
      subject: 'Join Acme on DataVault',
      text: [
        'Acme invited you to join its DataVault account.',
        '',
        'Accept the invitation within 72 hours:',
        'https://app.example.test/invitations/accept?token=' + 'b'.repeat(43),
        '',
        'If you were not expecting this invitation, you can ignore this email.',
      ].join('\n'),
    });
  });
});
