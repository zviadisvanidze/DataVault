import { BadRequestException, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { model, Types } from 'mongoose';
import {
  CompanyVerificationService,
  RESEND_VERIFICATION_RESPONSE,
  VERIFICATION_TOKEN_TTL_MS,
} from './company-verification.service';
import { companyVerificationSchema } from './entities/company-verification.entity';
import { Role } from '../enums/roles.enum';

const hash = (token: string) =>
  createHash('sha256').update(token).digest('hex');

describe('CompanyVerificationService', () => {
  const companyId = new Types.ObjectId();
  const ownerId = new Types.ObjectId();
  const session = {};
  const now = new Date('2026-09-17T00:00:00.000Z');
  const record = { companyId, ownerId };
  const verificationModel = {
    create: jest.fn(),
    findOneAndDelete: jest.fn(),
    findOneAndUpdate: jest.fn(),
  };
  const companyModel = { findOne: jest.fn(), findOneAndUpdate: jest.fn() };
  const userModel = { findOne: jest.fn() };
  const connection = {
    transaction: jest.fn((work: (value: object) => unknown) => work(session)),
  };
  const emailService = { sendCompanyActivation: jest.fn() };
  const service = new CompanyVerificationService(
    verificationModel as never,
    companyModel as never,
    userModel as never,
    connection as never,
    emailService as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    verificationModel.findOneAndDelete.mockResolvedValue(record);
    verificationModel.findOneAndUpdate.mockResolvedValue(record);
    companyModel.findOne.mockResolvedValue({ _id: companyId, name: 'Acme' });
    companyModel.findOneAndUpdate.mockResolvedValue({
      _id: companyId,
      activatedAt: now,
    });
    userModel.findOne.mockResolvedValue({
      _id: ownerId,
      companyId,
      email: 'owner@example.com',
    });
    emailService.sendCompanyActivation.mockResolvedValue(undefined);
  });

  it('generates distinct 256-bit tokens and persists only their hash with a 24-hour expiry', async () => {
    const first = await service.createForRegistration(
      companyId,
      ownerId,
      'owner@example.com',
      'Acme',
      session as never,
      now,
    );
    const second = await service.createForRegistration(
      companyId,
      ownerId,
      'owner@example.com',
      'Acme',
      session as never,
      now,
    );
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.token).not.toBe(second.token);
    expect(verificationModel.create).toHaveBeenNthCalledWith(
      1,
      [
        {
          companyId,
          ownerId,
          tokenHash: hash(first.token),
          expiresAt: new Date(now.getTime() + VERIFICATION_TOKEN_TTL_MS),
          lastSentAt: now,
        },
      ],
      { session },
    );
    expect(emailService.sendCompanyActivation).not.toHaveBeenCalled();
  });

  it('consumes a token and activates only its matching company and owner in one transaction', async () => {
    const token = 'a'.repeat(43);
    await expect(service.verify(token, now)).resolves.toEqual({
      message: 'Account activated. You can now sign in.',
    });
    expect(verificationModel.findOneAndDelete).toHaveBeenCalledWith(
      {
        tokenHash: hash(token),
        expiresAt: { $gt: now },
      },
      { session },
    );
    expect(userModel.findOne).toHaveBeenCalledWith(
      {
        _id: ownerId,
        companyId,
        role: Role.COMPANY_OWNER,
      },
      null,
      { session },
    );
    expect(companyModel.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: companyId,
        activatedAt: null,
      },
      { $set: { activatedAt: now } },
      { new: true, runValidators: true, session },
    );
  });

  it.each(['invalid', 'expired', 'reused'])(
    'rejects an %s token without activating a company',
    async () => {
      verificationModel.findOneAndDelete.mockResolvedValue(null);
      await expect(service.verify('a'.repeat(43), now)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(companyModel.findOneAndUpdate).not.toHaveBeenCalled();
    },
  );

  it('rejects activation when the owner relationship no longer exists', async () => {
    userModel.findOne.mockResolvedValue(null);
    await expect(service.verify('a'.repeat(43), now)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(companyModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('does not activate an already active or missing company', async () => {
    companyModel.findOneAndUpdate.mockResolvedValue(null);
    await expect(service.verify('a'.repeat(43), now)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('returns the same resend response for unknown and active accounts', async () => {
    userModel.findOne.mockResolvedValueOnce(null);
    await expect(service.resend('unknown@example.com', now)).resolves.toEqual(
      RESEND_VERIFICATION_RESPONSE,
    );
    companyModel.findOne.mockResolvedValueOnce(null);
    await expect(service.resend('owner@example.com', now)).resolves.toEqual(
      RESEND_VERIFICATION_RESPONSE,
    );
    expect(emailService.sendCompanyActivation).not.toHaveBeenCalled();
    expect(verificationModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('atomically replaces a pending token after the cooldown and sends the new raw token', async () => {
    await expect(service.resend('owner@example.com', now)).resolves.toEqual(
      RESEND_VERIFICATION_RESPONSE,
    );
    const emailCall = emailService.sendCompanyActivation.mock
      .calls[0] as unknown as [string, string, string];
    expect(emailCall[0]).toBe('owner@example.com');
    expect(emailCall[1]).toBe('Acme');
    expect(emailCall[2]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const updateCall = verificationModel.findOneAndUpdate.mock
      .calls[0] as unknown as [
      Record<string, unknown>,
      { $set: { tokenHash: string; expiresAt: Date } },
      Record<string, unknown>,
    ];
    expect(updateCall[0]).toMatchObject({ companyId });
    expect(updateCall[1].$set.tokenHash).toBe(hash(emailCall[2]));
    expect(updateCall[1].$set.expiresAt).toEqual(
      new Date(now.getTime() + VERIFICATION_TOKEN_TTL_MS),
    );
    expect(updateCall[2]).toMatchObject({ upsert: true, session });
  });

  it('hides cooldown/unique-index conflicts with the same response and no email', async () => {
    verificationModel.findOneAndUpdate.mockRejectedValueOnce({ code: 11000 });
    await expect(service.resend('owner@example.com', now)).resolves.toEqual(
      RESEND_VERIFICATION_RESPONSE,
    );
    expect(emailService.sendCompanyActivation).not.toHaveBeenCalled();
  });

  it('does not reveal SMTP failure through the resend response', async () => {
    const warning = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    emailService.sendCompanyActivation.mockRejectedValueOnce(
      new Error('SMTP failure'),
    );
    await expect(service.resend('owner@example.com', now)).resolves.toEqual(
      RESEND_VERIFICATION_RESPONSE,
    );
    expect(warning).toHaveBeenCalledWith('Activation email delivery failed');
    warning.mockRestore();
  });
});

describe('verification schema security', () => {
  it('hides stored hashes from queries and JSON serialization', () => {
    expect(companyVerificationSchema.path('tokenHash').options.select).toBe(
      false,
    );
    const Verification = model(
      'VerificationSchemaTest',
      companyVerificationSchema,
    );
    const document = new Verification({ tokenHash: 'secret-hash' });
    expect(document.toJSON()).not.toHaveProperty('tokenHash');
  });

  it('uniquely constrains company/token hashes and indexes expiry for cleanup', () => {
    expect(companyVerificationSchema.path('companyId').options.unique).toBe(
      true,
    );
    expect(companyVerificationSchema.path('tokenHash').options.unique).toBe(
      true,
    );
    expect(companyVerificationSchema.indexes()).toContainEqual([
      { expiresAt: 1 },
      expect.objectContaining({ expireAfterSeconds: 0 }),
    ]);
  });
});
