import { ConfigService } from '@nestjs/config';
import { EventEmitter } from 'node:events';
import net, { Socket } from 'node:net';
import nodemailer from 'nodemailer';
import type { SMTPTransportOptions } from 'nodemailer/lib/smtp-transport';
import { SmtpEmailSender } from './smtp-email.sender';

jest.mock('node:net', () => ({
  __esModule: true,
  default: { createConnection: jest.fn() },
}));
jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: jest.fn() },
}));

describe('SmtpEmailSender', () => {
  it('configures bounded timeouts and TLS and sends without logging credentials', async () => {
    const socket = Object.assign(new EventEmitter(), {
      destroy: jest.fn(),
    }) as unknown as Socket;
    jest.mocked(net.createConnection).mockReturnValue(socket);
    const sendMail = jest.fn().mockResolvedValue(undefined);
    const createTransport = jest.mocked(nodemailer.createTransport);
    createTransport.mockReturnValue({ sendMail } as never);
    const sender = new SmtpEmailSender(
      new ConfigService({
        SMTP_HOST: 'smtp.example.test',
        SMTP_PORT: 587,
        SMTP_SECURE: false,
        SMTP_REQUIRE_TLS: true,
        SMTP_FROM: 'no-reply@example.com',
        SMTP_USER: 'user',
        SMTP_PASSWORD: 'secret',
      }),
    );
    const transportOptions = createTransport.mock
      .calls[0][0] as SMTPTransportOptions;
    const { getSocket, ...smtpOptions } = transportOptions;
    expect(smtpOptions).toEqual({
      host: 'smtp.example.test',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: 'user', pass: 'secret' },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    expect(getSocket).toBeDefined();
    const socketCallback = jest.fn();
    getSocket?.(transportOptions, socketCallback);
    expect(net.createConnection).toHaveBeenCalledWith({
      host: 'smtp.example.test',
      port: 587,
      family: 4,
    });
    socket.emit('connect');
    expect(socketCallback).toHaveBeenCalledWith(null, { connection: socket });
    await sender.send({
      to: 'owner@example.com',
      subject: 'Activation',
      text: 'Link',
    });
    expect(sendMail).toHaveBeenCalledWith({
      from: 'no-reply@example.com',
      to: 'owner@example.com',
      subject: 'Activation',
      text: 'Link',
    });
  });

  it('does not expose raw SMTP failures', async () => {
    jest.mocked(nodemailer.createTransport).mockReturnValue({
      sendMail: jest
        .fn()
        .mockRejectedValue(new Error('private SMTP transport details')),
    } as never);
    const sender = new SmtpEmailSender(
      new ConfigService({
        SMTP_HOST: 'smtp.example.test',
        SMTP_PORT: 587,
        SMTP_SECURE: false,
        SMTP_REQUIRE_TLS: true,
        SMTP_FROM: 'no-reply@example.test',
      }),
    );
    await expect(
      sender.send({ to: 'owner@example.test', subject: 'Test', text: 'Link' }),
    ).rejects.toThrow('Email delivery failed');
  });
});
