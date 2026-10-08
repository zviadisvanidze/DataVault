import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailSender } from './email-sender';

@Injectable()
export class EmailService {
  constructor(
    private readonly sender: EmailSender,
    private readonly config: ConfigService,
  ) {}

  async sendCompanyActivation(to: string, companyName: string, token: string) {
    const activationUrl = new URL(
      this.config.getOrThrow<string>('ACCOUNT_ACTIVATION_URL'),
    );
    activationUrl.searchParams.set('token', token);
    await this.sender.send({
      to,
      subject: 'Activate your DataVault account',
      text: [
        `Your DataVault company account for ${companyName} is ready.`,
        '',
        'Activate it within 24 hours:',
        activationUrl.toString(),
        '',
        'If you did not register this account, you can ignore this email.',
      ].join('\n'),
    });
  }

  async sendEmployeeInvitation(to: string, companyName: string, token: string) {
    const invitationUrl = new URL(
      this.config.getOrThrow<string>('EMPLOYEE_INVITATION_URL'),
    );
    invitationUrl.searchParams.set('token', token);
    await this.sender.send({
      to,
      subject: `Join ${companyName} on DataVault`,
      text: [
        `${companyName} invited you to join its DataVault account.`,
        '',
        'Accept the invitation within 72 hours:',
        invitationUrl.toString(),
        '',
        'If you were not expecting this invitation, you can ignore this email.',
      ].join('\n'),
    });
  }
}
