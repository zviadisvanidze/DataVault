import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/config/configure-app';
import { EmailSender } from '../src/email/email-sender';
import { Role } from '../src/enums/roles.enum';
import { CompanyFileVisibility } from '../src/files/entities/company-file.entity';
import { InvitationStatus } from '../src/invitations/entities/employee-invitation.entity';
import { PlanCode } from '../src/plans/plan.constants';

interface DashboardBody {
  companyId: string;
  subscription: { planCode: PlanCode };
  employees: {
    accepted: number;
    pendingInvitations: number;
    limit: number | null;
    unlimited: boolean;
    remainingSlots: number | null;
  };
  files: {
    currentlyStored: {
      total: number;
      companyWide: number;
      restricted: number;
    };
    currentBillingPeriod: {
      successfulUploads: number;
      includedAllowance: number;
      unlimited: boolean;
      remainingUploads: number | null;
      premiumOverageUploads: number;
    };
  };
  billing: {
    baseAmountCents: number;
    employeeChargeCents: number;
    overageChargeCents: number;
    totalAmountCents: number;
  };
}

describe('company statistics dashboard (e2e)', () => {
  let app: INestApplication<App>;
  const freeCompanyId = new Types.ObjectId();
  const basicCompanyId = new Types.ObjectId();
  const premiumCompanyId = new Types.ObjectId();
  const inactiveCompanyId = new Types.ObjectId();
  const freeOwnerId = new Types.ObjectId();
  const basicOwnerId = new Types.ObjectId();
  const basicMemberId = new Types.ObjectId();
  const basicMemberTwoId = new Types.ObjectId();
  const premiumOwnerId = new Types.ObjectId();
  const premiumMemberId = new Types.ObjectId();
  const inactiveOwnerId = new Types.ObjectId();
  const tokens = new Map<string, string>();
  const activatedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000);

  beforeAll(async () => {
    const users = [
      { _id: freeOwnerId, companyId: freeCompanyId, role: Role.COMPANY_OWNER },
      {
        _id: basicOwnerId,
        companyId: basicCompanyId,
        role: Role.COMPANY_OWNER,
      },
      {
        _id: basicMemberId,
        companyId: basicCompanyId,
        role: Role.COMPANY_MEMBER,
      },
      {
        _id: basicMemberTwoId,
        companyId: basicCompanyId,
        role: Role.COMPANY_MEMBER,
      },
      {
        _id: premiumOwnerId,
        companyId: premiumCompanyId,
        role: Role.COMPANY_OWNER,
      },
      {
        _id: premiumMemberId,
        companyId: premiumCompanyId,
        role: Role.COMPANY_MEMBER,
      },
      {
        _id: inactiveOwnerId,
        companyId: inactiveCompanyId,
        role: Role.COMPANY_OWNER,
      },
    ];
    const plans = new Map<string, PlanCode>([
      [freeCompanyId.toString(), PlanCode.FREE],
      [basicCompanyId.toString(), PlanCode.BASIC],
      [premiumCompanyId.toString(), PlanCode.PREMIUM],
      [inactiveCompanyId.toString(), PlanCode.FREE],
    ]);
    const usage = new Map([
      [freeCompanyId.toString(), { uploadedFiles: 0, fileOverageCents: 0 }],
      [basicCompanyId.toString(), { uploadedFiles: 7, fileOverageCents: 0 }],
      [
        premiumCompanyId.toString(),
        { uploadedFiles: 1003, fileOverageCents: 150 },
      ],
    ]);
    const invitations = [
      ...Array.from({ length: 2 }, () => ({
        companyId: basicCompanyId,
        status: InvitationStatus.PENDING,
        expiresAt: future,
      })),
      {
        companyId: basicCompanyId,
        status: InvitationStatus.PENDING,
        expiresAt: past,
      },
      {
        companyId: premiumCompanyId,
        status: InvitationStatus.PENDING,
        expiresAt: future,
      },
      {
        companyId: premiumCompanyId,
        status: InvitationStatus.REVOKED,
        expiresAt: future,
      },
    ];
    const files = [
      {
        companyId: basicCompanyId,
        visibility: CompanyFileVisibility.COMPANY_WIDE,
      },
      { companyId: basicCompanyId, visibility: undefined },
      {
        companyId: basicCompanyId,
        visibility: CompanyFileVisibility.RESTRICTED,
      },
      {
        companyId: premiumCompanyId,
        visibility: CompanyFileVisibility.COMPANY_WIDE,
      },
      {
        companyId: premiumCompanyId,
        visibility: CompanyFileVisibility.RESTRICTED,
      },
    ];
    const sameId = (left: unknown, right: unknown) =>
      left?.toString() === right?.toString();

    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(getConnectionToken())
      .useValue({
        close: jest.fn(),
        transaction: jest.fn((work: (session: object) => unknown) => work({})),
      })
      .overrideProvider(getModelToken('user'))
      .useValue({
        findById: jest.fn((id: string) =>
          Promise.resolve(users.find((user) => sameId(user._id, id)) ?? null),
        ),
        countDocuments: jest.fn((filter: { companyId: unknown; role?: Role }) =>
          Promise.resolve(
            users.filter(
              (user) =>
                sameId(user.companyId, filter.companyId) &&
                (filter.role === undefined || user.role === filter.role),
            ).length,
          ),
        ),
      })
      .overrideProvider(getModelToken('company'))
      .useValue({
        findOne: jest.fn((filter: { _id: unknown }) =>
          Promise.resolve(
            sameId(filter._id, inactiveCompanyId)
              ? null
              : { _id: filter._id, activatedAt },
          ),
        ),
      })
      .overrideProvider(getModelToken('subscription'))
      .useValue({
        findOne: jest.fn((filter: { companyId: unknown }) => {
          const companyId = String(filter.companyId);
          const planCode = plans.get(companyId);
          return Promise.resolve(
            planCode
              ? {
                  _id: new Types.ObjectId(),
                  companyId: new Types.ObjectId(companyId),
                  planCode,
                  activatedAt,
                  planChangedAt: activatedAt,
                }
              : null,
          );
        }),
      })
      .overrideProvider(getModelToken('subscriptionPeriod'))
      .useValue({
        findOne: jest.fn((filter: { companyId: unknown; startsAt: Date }) => {
          const periodUsage = usage.get(String(filter.companyId));
          return Promise.resolve(
            periodUsage ? { ...periodUsage, startsAt: filter.startsAt } : null,
          );
        }),
      })
      .overrideProvider(getModelToken('employeeInvitation'))
      .useValue({
        countDocuments: jest.fn(
          (filter: {
            companyId: unknown;
            status: InvitationStatus;
            expiresAt: { $gt: Date };
          }) =>
            Promise.resolve(
              invitations.filter(
                (invitation) =>
                  sameId(invitation.companyId, filter.companyId) &&
                  invitation.status === filter.status &&
                  invitation.expiresAt > filter.expiresAt.$gt,
              ).length,
            ),
        ),
      })
      .overrideProvider(getModelToken('companyFile'))
      .useValue({
        countDocuments: jest.fn(
          (filter: {
            companyId: unknown;
            visibility?: CompanyFileVisibility;
            $or?: unknown[];
          }) =>
            Promise.resolve(
              files.filter((file) => {
                if (!sameId(file.companyId, filter.companyId)) return false;
                if (filter.visibility !== undefined)
                  return file.visibility === filter.visibility;
                if (filter.$or)
                  return (
                    file.visibility === CompanyFileVisibility.COMPANY_WIDE ||
                    file.visibility === undefined
                  );
                return true;
              }).length,
            ),
        ),
      })
      .overrideProvider(getModelToken('platformAdmin'))
      .useValue({})
      .overrideProvider(getModelToken('adminAudit'))
      .useValue({})
      .overrideProvider(getModelToken('adminAccessRequest'))
      .useValue({})
      .overrideProvider(getModelToken('companyVerification'))
      .useValue({})
      .overrideProvider(getModelToken('googleOAuthState'))
      .useValue({})
      .overrideProvider(getModelToken('googleOAuthExchange'))
      .useValue({})
      .overrideProvider(getModelToken('plan'))
      .useValue({ bulkWrite: jest.fn().mockResolvedValue(undefined) })
      .overrideProvider(EmailSender)
      .useValue({ send: jest.fn() })
      .overrideProvider(getModelToken('aiConversation'))
      .useValue({})
      .overrideProvider(getModelToken('aiMessage'))
      .useValue({})
      .overrideProvider(getModelToken('aiUsage'))
      .useValue({})
      .compile();

    app = fixture.createNestApplication();
    configureApp(app);
    const jwt = app.get(JwtService);
    for (const user of users)
      tokens.set(user._id.toString(), jwt.sign({ id: user._id.toString() }));
    await app.init();
  });

  afterAll(() => app?.close());

  const auth = (userId: Types.ObjectId) => ({
    Authorization: `Bearer ${tokens.get(userId.toString())!}`,
  });

  it('returns an empty Free dashboard only to an activated authenticated company', async () => {
    await request(app.getHttpServer()).get('/statistics/current').expect(401);
    await request(app.getHttpServer())
      .get('/statistics/current')
      .set(auth(inactiveOwnerId))
      .expect(401);
    await request(app.getHttpServer())
      .get('/statistics/current')
      .set(auth(freeOwnerId))
      .expect('Cache-Control', 'private, no-store')
      .expect(200)
      .expect(({ body }: { body: DashboardBody }) => {
        expect(body.companyId).toBe(freeCompanyId.toString());
        expect(body.subscription.planCode).toBe(PlanCode.FREE);
        expect(body.employees).toMatchObject({
          accepted: 0,
          pendingInvitations: 0,
          limit: 0,
          unlimited: false,
        });
        expect(body.files.currentlyStored).toEqual({
          total: 0,
          companyWide: 0,
          restricted: 0,
        });
        expect(body.files.currentBillingPeriod).toMatchObject({
          successfulUploads: 0,
          includedAllowance: 10,
          remainingUploads: 10,
        });
        expect(body.billing.totalAmountCents).toBe(0);
      });
  });

  it('allows a Basic owner and member to read the same tenant-derived dashboard', async () => {
    for (const userId of [basicOwnerId, basicMemberId]) {
      await request(app.getHttpServer())
        .get('/statistics/current')
        .set(auth(userId))
        .expect(200)
        .expect(({ body }: { body: DashboardBody }) => {
          expect(body.companyId).toBe(basicCompanyId.toString());
          expect(body.subscription.planCode).toBe(PlanCode.BASIC);
          expect(body.employees).toMatchObject({
            accepted: 2,
            pendingInvitations: 2,
            limit: 10,
            remainingSlots: 6,
          });
          expect(body.files.currentlyStored).toEqual({
            total: 3,
            companyWide: 2,
            restricted: 1,
          });
          expect(body.files.currentBillingPeriod).toMatchObject({
            successfulUploads: 7,
            includedAllowance: 100,
            remainingUploads: 97,
          });
          expect(body.billing).toMatchObject({
            employeeChargeCents: 1000,
            totalAmountCents: 1000,
          });
        });
    }
  });

  it('keeps tenant statistics isolated and rejects client-supplied values', async () => {
    await request(app.getHttpServer())
      .get(
        `/statistics/current?companyId=${premiumCompanyId.toString()}&totalAmountCents=0`,
      )
      .set(auth(basicOwnerId))
      .expect(400);
    await request(app.getHttpServer())
      .get('/statistics/current')
      .set(auth(basicOwnerId))
      .send({ acceptedEmployees: 0, storedFiles: 0 })
      .expect(400);
    await request(app.getHttpServer())
      .get('/statistics/current')
      .set(auth(basicOwnerId))
      .expect(200)
      .expect(({ body }: { body: { companyId: string } }) =>
        expect(body.companyId).toBe(basicCompanyId.toString()),
      );
  });

  it('reports Premium unlimited capacity and overage while separating stored files from upload usage', () =>
    request(app.getHttpServer())
      .get('/statistics/current')
      .set(auth(premiumOwnerId))
      .expect(200)
      .expect(({ body }: { body: DashboardBody }) => {
        expect(body.companyId).toBe(premiumCompanyId.toString());
        expect(body.subscription.planCode).toBe(PlanCode.PREMIUM);
        expect(body.employees).toMatchObject({
          accepted: 1,
          pendingInvitations: 1,
          limit: null,
          unlimited: true,
          remainingSlots: null,
        });
        expect(body.files.currentlyStored.total).toBe(2);
        expect(body.files.currentBillingPeriod).toMatchObject({
          successfulUploads: 1003,
          includedAllowance: 1000,
          unlimited: true,
          remainingUploads: null,
          premiumOverageUploads: 3,
        });
        expect(body.billing).toMatchObject({
          baseAmountCents: 30000,
          overageChargeCents: 150,
          totalAmountCents: 30150,
        });
      }));
});
