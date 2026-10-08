import { Types } from 'mongoose';
import { Role } from '../enums/roles.enum';
import { AiToolFailure, AiToolName, AiToolsService } from './ai-tools.service';

describe('AiToolsService', () => {
  const actor = {
    id: new Types.ObjectId().toHexString(),
    companyId: new Types.ObjectId().toHexString(),
    role: Role.COMPANY_MEMBER,
  };
  const companies = {
    findCurrent: jest.fn().mockResolvedValue({
      name: 'Data Company',
      country: 'GE',
      industry: 'Technology',
      activatedAt: new Date('2026-01-01T00:00:00.000Z'),
      privateInternal: 'hidden',
    }),
  };
  const subscriptions = {
    getCurrent: jest.fn().mockResolvedValue({
      plan: { code: 'basic', monthlyFileLimit: 100 },
      activatedAt: new Date('2026-01-01T00:00:00.000Z'),
      planChangedAt: new Date('2026-01-01T00:00:00.000Z'),
      billingPeriod: { start: new Date(), end: new Date() },
      employeeCount: 2,
      billingSummary: { totalAmountCents: 1000 },
      stripeCustomerId: 'must-not-leak',
    }),
  };
  const statistics = {
    getCurrent: jest.fn().mockResolvedValue({
      companyId: actor.companyId,
      acceptedEmployeeCount: 2,
      currentPlan: 'basic',
    }),
  };
  const files = {
    findAll: jest.fn().mockResolvedValue({
      files: [
        {
          _id: new Types.ObjectId(),
          companyId: actor.companyId,
          uploaderId: actor.id,
          originalFilename: 'visible.csv',
          mimeType: 'text/csv',
          fileType: 'csv',
          size: 42,
          visibility: 'restricted',
          restrictedUserIds: [actor.id],
          storageKey: 'private/object/key',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      total: 1,
    }),
  };
  const service = new AiToolsService(
    companies as never,
    subscriptions as never,
    statistics as never,
    files as never,
  );

  beforeEach(() => jest.clearAllMocks());

  it('returns only safe company and subscription data for the actor tenant', async () => {
    const company = await service.execute(
      actor,
      AiToolName.COMPANY_PROFILE,
      '{}',
    );
    const subscription = await service.execute(
      actor,
      AiToolName.SUBSCRIPTION_BILLING,
      '{}',
    );
    expect(companies.findCurrent).toHaveBeenCalledWith(actor.companyId);
    expect(subscriptions.getCurrent).toHaveBeenCalledWith(actor.companyId);
    expect(JSON.stringify({ company, subscription })).not.toMatch(
      /privateInternal|stripeCustomerId|must-not-leak/,
    );
  });

  it('removes tenant identifiers from statistics', async () => {
    const result = await service.execute(
      actor,
      AiToolName.COMPANY_STATISTICS,
      '{}',
    );
    expect(statistics.getCurrent).toHaveBeenCalledWith(actor.companyId);
    expect(result).toEqual({ acceptedEmployeeCount: 2, currentPlan: 'basic' });
  });

  it('delegates file visibility to FilesService and strips internal identifiers', async () => {
    const result = await service.execute(
      actor,
      AiToolName.VISIBLE_FILES,
      '{"limit":1}',
    );
    expect(files.findAll).toHaveBeenCalledWith(actor, { page: 1, take: 1 });
    expect(result).toMatchObject({
      files: [{ originalFilename: 'visible.csv', visibility: 'restricted' }],
      returned: 1,
      totalVisibleFiles: 1,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /companyId|uploaderId|restrictedUserIds|storageKey|private\/object/,
    );
  });

  it.each([
    [AiToolName.COMPANY_PROFILE, '{"companyId":"attacker"}'],
    [AiToolName.VISIBLE_FILES, '{"userId":"attacker"}'],
    [AiToolName.VISIBLE_FILES, '{"limit":11}'],
    [AiToolName.VISIBLE_FILES, '{"limit":"5"}'],
    ['unknown_tool', '{}'],
    [AiToolName.VISIBLE_FILES, 'not-json'],
  ])('rejects untrusted or unknown tool input', async (name, args) => {
    await expect(service.execute(actor, name, args)).rejects.toBeInstanceOf(
      AiToolFailure,
    );
  });

  it('canonicalizes argument order for repeated-call protection', () => {
    expect(service.fingerprint('tool', '{"b":2,"a":1}')).toBe(
      service.fingerprint('tool', '{"a":1,"b":2}'),
    );
  });
});
