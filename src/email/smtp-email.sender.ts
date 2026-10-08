import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import net from 'node:net';
import nodemailer, { Transporter } from 'nodemailer';
import type { SMTPTransportGetSocket } from 'nodemailer/lib/smtp-transport';
import { EmailMessage, EmailSender } from './email-sender';

const SMTP_CONNECTION_TIMEOUT_MS = 10_000;

const createIpv4Socket: SMTPTransportGetSocket = (options, callback) => {
  const socket = net.createConnection({
    host: options.host ?? 'localhost',
    port: Number(options.port) || (options.secure ? 465 : 587),
    family: 4,
  });
  let settled = false;
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    socket.removeListener('connect', onConnect);
    socket.removeListener('error', onError);
    if (error) {
      socket.destroy();
      callback(error);
      return;
    }
    callback(null, { connection: socket });
  };
  const onConnect = () => finish();
  const onError = (error: Error) => finish(error);
  const timeout = setTimeout(() => {
    const error = new Error('SMTP IPv4 connection timed out');
    Object.assign(error, { code: 'ETIMEDOUT', command: 'CONN' });
    finish(error);
  }, options.connectionTimeout ?? SMTP_CONNECTION_TIMEOUT_MS);
  socket.once('connect', onConnect);
  socket.once('error', onError);
};

@Injectable()
export class SmtpEmailSender implements EmailSender {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(config: ConfigService) {
    this.from = config.getOrThrow<string>('SMTP_FROM');
    const user = config.get<string>('SMTP_USER');
    const password = config.get<string>('SMTP_PASSWORD');
    this.transporter = nodemailer.createTransport({
      host: config.getOrThrow<string>('SMTP_HOST'),
      port: config.getOrThrow<number>('SMTP_PORT'),
      secure: config.getOrThrow<boolean>('SMTP_SECURE'),
      requireTLS: config.getOrThrow<boolean>('SMTP_REQUIRE_TLS'),
      auth: user && password ? { user, pass: password } : undefined,
      connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      disableFileAccess: true,
      disableUrlAccess: true,
      getSocket: createIpv4Socket,
    });
  }

  async send(message: EmailMessage) {
    try {
      await this.transporter.sendMail({ from: this.from, ...message });
    } catch {
      // SMTP errors can include recipient addresses and transport details.
      throw new Error('Email delivery failed');
    }
  }
}
