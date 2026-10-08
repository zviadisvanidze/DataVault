import { ConfigService } from '@nestjs/config';
import { EmailService } from './email.service';
import { ResendEmailSender } from './resend-email.sender';

describe('ResendEmailSender', () => {
  const apiKey = 're_example_test_key_12345';
  const config = new ConfigService({
    RESEND_API_KEY: apiKey,
    RESEND_FROM: 'no-reply@example.test',
    ACCOUNT_ACTIVATION_URL: 'https://app.example.test/auth/activate',
    EMPLOYEE_INVITATION_URL: 'https://app.example.test/invitations/accept',
  });

  afterEach(() => jest.restoreAllMocks());

  it('sends both existing plaintext link templates over HTTPS', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    const service = new EmailService(new ResendEmailSender(config), config);

    await service.sendCompanyActivation(
      'owner@example.test',
      'Acme',
      'activation-token',
    );
    await service.sendEmployeeInvitation(
      'employee@example.test',
      'Acme',
      'invitation-token',
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const messages = fetchMock.mock.calls.map(([url, options]) => {
      expect(url).toBe('https://api.resend.com/emails');
      expect(options).toMatchObject({ method: 'POST', redirect: 'error' });
      expect(options?.headers).toMatchObject({
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      });
      expect(options?.signal).toBeDefined();
      const body = options?.body;
      expect(typeof body).toBe('string');
      return JSON.parse(typeof body === 'string' ? body : '') as Record<
        string,
        unknown
      >;
    });
    expect(messages[0]).toMatchObject({
      from: 'no-reply@example.test',
      to: ['owner@example.test'],
      subject: 'Activate your DataVault account',
    });
    expect(messages[0].text).toContain(
      'https://app.example.test/auth/activate?token=activation-token',
    );
    expect(messages[1]).toMatchObject({
      from: 'no-reply@example.test',
      to: ['employee@example.test'],
      subject: 'Join Acme on DataVault',
    });
    expect(messages[1].text).toContain(
      'https://app.example.test/invitations/accept?token=invitation-token',
    );
  });

  it('sanitizes provider rejections without retrying', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'private provider details' }), {
        status: 401,
      }),
    );
    const sender = new ResendEmailSender(config);
    await expect(
      sender.send({
        to: 'owner@example.test',
        subject: 'Activation',
        text: 'private token',
      }),
    ).rejects.toThrow('Email delivery failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sanitizes network failures without retrying', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('credential or recipient in raw error'));
    const sender = new ResendEmailSender(config);
    await expect(
      sender.send({ to: 'owner@example.test', subject: 'Test', text: 'Link' }),
    ).rejects.toThrow('Email delivery failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
