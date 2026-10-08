import { INestApplication, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { Readable } from 'stream';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { ObjectStorage } from '../src/aws-s3/object-storage';
import { configureApp } from '../src/config/configure-app';
import { EmailSender } from '../src/email/email-sender';
import { Role } from '../src/enums/roles.enum';
import {
  CompanyFileType,
  CompanyFileVisibility,
} from '../src/files/entities/company-file.entity';
import { PlanCode } from '../src/plans/plan.constants';
import { billingPeriod } from '../src/subscriptions/billing-period';

interface UserState {
  _id: Types.ObjectId;
  companyId: Types.ObjectId;
  role: Role;
  email?: string;
}

interface CompanyState {
  _id: Types.ObjectId;
  activatedAt: Date;
}

interface SubscriptionState {
  _id: Types.ObjectId;
  companyId: Types.ObjectId;
  planCode: PlanCode;
  activatedAt: Date;
  planChangedAt: Date;
  revision: number;
}

interface PeriodState {
  companyId: string;
  startsAt: Date;
  endsAt: Date;
  uploadedFiles: number;
  fileOverageCents: number;
}

interface FileState {
  _id: Types.ObjectId;
  companyId: string;
  uploaderId: string;
  originalFilename: string;
  storageKey: string;
  fileType: CompanyFileType;
  mimeType: string;
  size: number;
  visibility: CompanyFileVisibility;
  restrictedUserIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

function selectable<T>(value: T) {
  const promise = Promise.resolve(value);
  return Object.assign(promise, { select: () => promise });
}

function validXls() {
  const buffer = Buffer.alloc(512);
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(buffer);
  buffer.writeUInt16LE(0xfffe, 28);
  buffer.writeUInt16LE(9, 30);
  Buffer.from('Workbook\0', 'utf16le').copy(buffer, 128);
  return buffer;
}

function validXlsx() {
  const names = ['[Content_Types].xml', 'xl/workbook.xml'];
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const value of names) {
    const name = Buffer.from(value);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length;
  }
  const localData = Buffer.concat(localParts);
  const centralData = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(centralData.length, 12);
  eocd.writeUInt32LE(localData.length, 16);
  return Buffer.concat([localData, centralData, eocd]);
}

describe('company files (e2e)', () => {
  let app: INestApplication<App>;
  const companyId = new Types.ObjectId();
  const otherCompanyId = new Types.ObjectId();
  const ownerId = new Types.ObjectId();
  const memberId = new Types.ObjectId();
  const otherMemberId = new Types.ObjectId();
  const unauthorizedMemberId = new Types.ObjectId();
  const otherOwnerId = new Types.ObjectId();
  const otherCompanyMemberId = new Types.ObjectId();
  const users = new Map<string, UserState>();
  const companies = new Map<string, CompanyState>();
  const subscriptions = new Map<string, SubscriptionState>();
  const periods = new Map<string, PeriodState>();
  const files = new Map<string, FileState>();
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  let ownerToken: string;
  let memberToken: string;
  let otherMemberToken: string;
  let unauthorizedMemberToken: string;
  let otherOwnerToken: string;
  let transactionTail = Promise.resolve();
  let failNextMetadataCreate = false;
  let failNextPut = false;
  let failNextDelete = false;

  beforeAll(async () => {
    const userModel = {
      findById: jest.fn((id: string) => Promise.resolve(users.get(id) ?? null)),
      countDocuments: jest.fn(
        (filter: { _id?: { $in: string[] }; companyId: string; role?: Role }) =>
          Promise.resolve(
            [...users.values()].filter(
              (user) =>
                user.companyId.toString() === String(filter.companyId) &&
                (filter.role === undefined || user.role === filter.role) &&
                (filter._id === undefined ||
                  filter._id.$in.includes(user._id.toString())),
            ).length,
          ),
      ),
      findOne: jest.fn(
        (filter: { _id?: string; companyId?: string; email?: string }) =>
          Promise.resolve(
            [...users.values()].find(
              (user) =>
                (filter._id === undefined ||
                  user._id.toString() === String(filter._id)) &&
                (filter.companyId === undefined ||
                  user.companyId.toString() === String(filter.companyId)) &&
                (filter.email === undefined || user.email === filter.email),
            ) ?? null,
          ),
      ),
      find: jest.fn((filter: { companyId: string }) => {
        let result = [...users.values()].filter(
          (user) => user.companyId.toString() === String(filter.companyId),
        );
        const query = {
          sort: () => query,
          skip: (count: number) => {
            result = result.slice(count);
            return query;
          },
          limit: (count: number) => Promise.resolve(result.slice(0, count)),
        };
        return query;
      }),
      findOneAndDelete: jest.fn(
        (filter: { _id: string; companyId: string }) => {
          const user = users.get(String(filter._id));
          if (!user || user.companyId.toString() !== String(filter.companyId))
            return Promise.resolve(null);
          users.delete(user._id.toString());
          return Promise.resolve(user);
        },
      ),
    };
    const companyModel = {
      findOne: jest.fn((filter: { _id: Types.ObjectId }) =>
        Promise.resolve(companies.get(filter._id.toString()) ?? null),
      ),
    };
    const subscriptionModel = {
      findOne: jest.fn((filter: { companyId: string }) =>
        Promise.resolve(subscriptions.get(String(filter.companyId)) ?? null),
      ),
      findOneAndUpdate: jest.fn(
        (
          filter: { companyId?: string; _id?: Types.ObjectId },
          update: {
            $inc?: object;
            $set?: { planCode: PlanCode; planChangedAt: Date };
          },
        ) => {
          const subscription = filter.companyId
            ? subscriptions.get(String(filter.companyId))
            : [...subscriptions.values()].find((value) =>
                value._id.equals(filter._id),
              );
          if (!subscription) return Promise.resolve(null);
          if (update.$inc) subscription.revision++;
          if (update.$set) Object.assign(subscription, update.$set);
          return Promise.resolve(subscription);
        },
      ),
      create: jest.fn(),
    };
    const periodModel = {
      findOne: jest.fn((filter: { companyId: string; startsAt: Date }) => {
        const period = periods.get(String(filter.companyId));
        return Promise.resolve(
          period && period.startsAt.getTime() === filter.startsAt.getTime()
            ? period
            : null,
        );
      }),
      findOneAndUpdate: jest.fn(
        (
          filter: { companyId: string; startsAt: Date },
          update: {
            $setOnInsert: Omit<
              PeriodState,
              'uploadedFiles' | 'fileOverageCents'
            >;
            $inc: { uploadedFiles: number; fileOverageCents: number };
          },
        ) => {
          const key = String(filter.companyId);
          const period = periods.get(key) ?? {
            ...update.$setOnInsert,
            companyId: key,
            uploadedFiles: 0,
            fileOverageCents: 0,
          };
          period.uploadedFiles += update.$inc.uploadedFiles;
          period.fileOverageCents += update.$inc.fileOverageCents;
          periods.set(key, period);
          return Promise.resolve(period);
        },
      ),
    };
    const matchesFile = (
      file: FileState,
      filter: {
        _id?: string;
        companyId?: string;
        storageKey?: string;
        $or?: Array<Record<string, unknown>>;
      },
    ) => {
      if (
        filter._id !== undefined &&
        file._id.toString() !== String(filter._id)
      )
        return false;
      if (
        filter.companyId !== undefined &&
        file.companyId !== String(filter.companyId)
      )
        return false;
      if (
        filter.storageKey !== undefined &&
        file.storageKey !== filter.storageKey
      )
        return false;
      if (!filter.$or) return true;
      return filter.$or.some((condition) => {
        if ('visibility' in condition) {
          const expected = condition.visibility;
          if (typeof expected === 'object')
            return file.visibility === undefined;
          return file.visibility === expected;
        }
        if ('uploaderId' in condition)
          return file.uploaderId === String(condition.uploaderId);
        if ('restrictedUserIds' in condition)
          return file.restrictedUserIds.includes(
            String(condition.restrictedUserIds),
          );
        return false;
      });
    };
    const fileModel = {
      create: jest.fn(
        (inputs: Omit<FileState, '_id' | 'createdAt' | 'updatedAt'>[]) => {
          if (failNextMetadataCreate) {
            failNextMetadataCreate = false;
            throw new Error('metadata failure');
          }
          const now = new Date();
          const file = {
            ...inputs[0],
            _id: new Types.ObjectId(),
            createdAt: now,
            updatedAt: now,
          };
          files.set(file._id.toString(), file);
          return Promise.resolve([file]);
        },
      ),
      find: jest.fn((filter: Parameters<typeof matchesFile>[1]) => {
        let result = [...files.values()].filter((file) =>
          matchesFile(file, filter),
        );
        result.sort(
          (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
        );
        const query = {
          sort: () => query,
          skip: (count: number) => {
            result = result.slice(count);
            return query;
          },
          limit: (count: number) => Promise.resolve(result.slice(0, count)),
        };
        return query;
      }),
      countDocuments: jest.fn((filter: Parameters<typeof matchesFile>[1]) =>
        Promise.resolve(
          [...files.values()].filter((file) => matchesFile(file, filter))
            .length,
        ),
      ),
      findOne: jest.fn((filter: Parameters<typeof matchesFile>[1]) =>
        selectable(
          [...files.values()].find((file) => matchesFile(file, filter)) ?? null,
        ),
      ),
      findOneAndUpdate: jest.fn(
        (
          filter: Parameters<typeof matchesFile>[1],
          update: {
            $set: Pick<FileState, 'visibility' | 'restrictedUserIds'>;
          },
        ) => {
          const file = [...files.values()].find((value) =>
            matchesFile(value, filter),
          );
          if (!file) return Promise.resolve(null);
          Object.assign(file, update.$set, { updatedAt: new Date() });
          return Promise.resolve(file);
        },
      ),
      findOneAndDelete: jest.fn(
        (filter: { _id: string; companyId: string; storageKey: string }) => {
          const file = files.get(String(filter._id));
          if (
            !file ||
            file.companyId !== String(filter.companyId) ||
            file.storageKey !== filter.storageKey
          )
            return Promise.resolve(null);
          files.delete(file._id.toString());
          return Promise.resolve(file);
        },
      ),
    };
    const storage = {
      putObject: jest.fn(
        (input: { key: string; body: Buffer; contentType: string }) => {
          if (failNextPut) {
            failNextPut = false;
            throw new ServiceUnavailableException('S3 put failure');
          }
          objects.set(input.key, {
            body: Buffer.from(input.body),
            contentType: input.contentType,
          });
          return Promise.resolve();
        },
      ),
      getObject: jest.fn((key: string) => {
        const object = objects.get(key);
        if (!object) throw new Error('S3 object missing');
        return Promise.resolve({
          stream: Readable.from(object.body),
          contentLength: object.body.length,
        });
      }),
      deleteObject: jest.fn((key: string) => {
        if (failNextDelete) {
          failNextDelete = false;
          throw new ServiceUnavailableException('S3 delete failure');
        }
        objects.delete(key);
        return Promise.resolve();
      }),
    };
    const connection = {
      close: jest.fn(),
      transaction: jest.fn((work: (session: object) => Promise<unknown>) => {
        const run = transactionTail.then(async () => {
          const periodSnapshot = new Map(
            [...periods].map(([key, value]) => [key, { ...value }]),
          );
          const fileSnapshot = new Map(
            [...files].map(([key, value]) => [
              key,
              { ...value, restrictedUserIds: [...value.restrictedUserIds] },
            ]),
          );
          const subscriptionSnapshot = new Map(
            [...subscriptions].map(([key, value]) => [key, { ...value }]),
          );
          try {
            return await work({});
          } catch (error) {
            periods.clear();
            periodSnapshot.forEach((value, key) => periods.set(key, value));
            files.clear();
            fileSnapshot.forEach((value, key) => files.set(key, value));
            subscriptions.clear();
            subscriptionSnapshot.forEach((value, key) =>
              subscriptions.set(key, value),
            );
            throw error;
          }
        });
        transactionTail = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      }),
    };

    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(getConnectionToken())
      .useValue(connection)
      .overrideProvider(getModelToken('user'))
      .useValue(userModel)
      .overrideProvider(getModelToken('company'))
      .useValue(companyModel)
      .overrideProvider(getModelToken('subscription'))
      .useValue(subscriptionModel)
      .overrideProvider(getModelToken('subscriptionPeriod'))
      .useValue(periodModel)
      .overrideProvider(getModelToken('companyFile'))
      .useValue(fileModel)
      .overrideProvider(getModelToken('employeeInvitation'))
      .useValue({ countDocuments: jest.fn().mockResolvedValue(0) })
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
      .useValue({ bulkWrite: jest.fn() })
      .overrideProvider(ObjectStorage)
      .useValue(storage)
      .overrideProvider(EmailSender)
      .useValue({ send: jest.fn() })
      .overrideProvider(ConfigService)
      .useValue(
        new ConfigService({
          JWT_SECRET: 'a-secure-test-secret-with-32-characters',
          OPENROUTER_ENABLED: false,
          OPENROUTER_FALLBACK_MODELS: [],
          OPENROUTER_MAX_OUTPUT_TOKENS: 1000,
          OPENROUTER_MAX_TOOL_ITERATIONS: 3,
          OPENROUTER_TIMEOUT_MS: 30000,
          OPENROUTER_REQUIRE_ZDR: false,
          AI_MAX_MESSAGE_CHARS: 8000,
          AI_MAX_HISTORY_MESSAGES: 20,
          AI_MAX_CONTEXT_CHARS: 40000,
          AI_MAX_CONVERSATION_MESSAGES: 100,
          AI_MAX_CONVERSATIONS_PER_USER: 100,
          AI_RATE_LIMIT_PER_MINUTE: 10,
          FILE_MAX_SIZE_BYTES: 1024,
        }),
      )
      .overrideProvider(getModelToken('aiConversation'))
      .useValue({})
      .overrideProvider(getModelToken('aiMessage'))
      .useValue({})
      .overrideProvider(getModelToken('aiUsage'))
      .useValue({})
      .compile();
    app = fixture.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
    const jwt = app.get(JwtService);
    ownerToken = jwt.sign({ id: ownerId.toString() });
    memberToken = jwt.sign({ id: memberId.toString() });
    otherMemberToken = jwt.sign({ id: otherMemberId.toString() });
    unauthorizedMemberToken = jwt.sign({
      id: unauthorizedMemberId.toString(),
    });
    otherOwnerToken = jwt.sign({ id: otherOwnerId.toString() });
  });

  beforeEach(() => {
    users.clear();
    companies.clear();
    subscriptions.clear();
    periods.clear();
    files.clear();
    objects.clear();
    failNextMetadataCreate = false;
    failNextPut = false;
    failNextDelete = false;
    transactionTail = Promise.resolve();
    const activatedAt = new Date('2026-01-15T12:00:00.000Z');
    for (const [id, tenantId, role] of [
      [ownerId, companyId, Role.COMPANY_OWNER],
      [memberId, companyId, Role.COMPANY_MEMBER],
      [otherMemberId, companyId, Role.COMPANY_MEMBER],
      [unauthorizedMemberId, companyId, Role.COMPANY_MEMBER],
      [otherOwnerId, otherCompanyId, Role.COMPANY_OWNER],
      [otherCompanyMemberId, otherCompanyId, Role.COMPANY_MEMBER],
    ] as const)
      users.set(id.toString(), {
        _id: id,
        companyId: tenantId,
        role,
        email: `${id.toString()}@example.test`,
      });
    companies.set(companyId.toString(), { _id: companyId, activatedAt });
    companies.set(otherCompanyId.toString(), {
      _id: otherCompanyId,
      activatedAt,
    });
    for (const id of [companyId, otherCompanyId])
      subscriptions.set(id.toString(), {
        _id: new Types.ObjectId(),
        companyId: id,
        planCode: PlanCode.FREE,
        activatedAt,
        planChangedAt: activatedAt,
        revision: 0,
      });
  });

  afterAll(() => app?.close());

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const upload = (
    name: string,
    mime: string,
    body: Buffer,
    token = memberToken,
    permissions?: {
      visibility: CompanyFileVisibility;
      restrictedUserIds?: string[];
    },
  ) => {
    const pending = request(app.getHttpServer())
      .post('/files')
      .set(auth(token));
    if (permissions) {
      pending.field('visibility', permissions.visibility);
      if (permissions.restrictedUserIds)
        pending.field(
          'restrictedUserIds',
          JSON.stringify(permissions.restrictedUserIds),
        );
    }
    return pending.attach('file', body, {
      filename: name,
      contentType: mime,
    });
  };

  const seedStoredFiles = (count: number) => {
    while (files.size < count) {
      const id = new Types.ObjectId();
      const storageKey = `companies/${companyId.toString()}/files/${id.toString()}.csv`;
      files.set(id.toString(), {
        _id: id,
        companyId: companyId.toString(),
        uploaderId: memberId.toString(),
        originalFilename: `${id.toString()}.csv`,
        storageKey,
        fileType: CompanyFileType.CSV,
        mimeType: 'text/csv',
        size: 3,
        visibility: CompanyFileVisibility.COMPANY_WIDE,
        restrictedUserIds: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      objects.set(storageKey, {
        body: Buffer.from('a,b'),
        contentType: 'text/csv',
      });
    }
  };

  const seedPeriod = (uploadedFiles: number) => {
    const subscription = subscriptions.get(companyId.toString())!;
    const period = billingPeriod(subscription.activatedAt, new Date());
    periods.set(companyId.toString(), {
      companyId: companyId.toString(),
      ...period,
      uploadedFiles,
      fileOverageCents: 0,
    });
  };

  it('accepts CSV, XLS, and XLSX for owners and members with private tenant keys', async () => {
    const cases: Array<[string, string, Buffer, string]> = [
      ['data.csv', 'text/csv', Buffer.from('a,b\n1,2'), memberToken],
      ['legacy.xls', 'application/vnd.ms-excel', validXls(), ownerToken],
      [
        'book.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        validXlsx(),
        memberToken,
      ],
    ];
    for (const [name, mime, body, token] of cases)
      await upload(name, mime, body, token)
        .expect(201)
        .expect(({ body: response }: { body: Record<string, unknown> }) => {
          expect(response).not.toHaveProperty('storageKey');
          expect(response).not.toHaveProperty('buffer');
        });
    expect(files.size).toBe(3);
    expect(
      [...objects.keys()].every((key) =>
        key.startsWith(`companies/${companyId.toString()}/files/`),
      ),
    ).toBe(true);
  });

  it('enforces company-wide and restricted visibility for lists, metadata, and downloads', async () => {
    const companyWide = await upload(
      'company.csv',
      'text/csv',
      Buffer.from('a,b'),
      ownerToken,
    ).expect(201);
    const restricted = await upload(
      'restricted.csv',
      'text/csv',
      Buffer.from('a,b'),
      memberToken,
      {
        visibility: CompanyFileVisibility.RESTRICTED,
        restrictedUserIds: [otherMemberId.toString()],
      },
    ).expect(201);
    const multiRestricted = await upload(
      'multi.csv',
      'text/csv',
      Buffer.from('a,b'),
      ownerToken,
      {
        visibility: CompanyFileVisibility.RESTRICTED,
        restrictedUserIds: [
          otherMemberId.toString(),
          unauthorizedMemberId.toString(),
        ],
      },
    ).expect(201);
    expect(companyWide.body).toMatchObject({
      visibility: CompanyFileVisibility.COMPANY_WIDE,
      restrictedUserIds: [],
    });
    expect(restricted.body).toMatchObject({
      visibility: CompanyFileVisibility.RESTRICTED,
      restrictedUserIds: [otherMemberId.toString()],
    });

    const expectedListTotals = [
      [ownerToken, 3],
      [memberToken, 2],
      [otherMemberToken, 3],
      [unauthorizedMemberToken, 2],
    ] as const;
    for (const [token, total] of expectedListTotals)
      await request(app.getHttpServer())
        .get('/files')
        .set(auth(token))
        .expect(200)
        .expect(({ body }: { body: { total: number } }) =>
          expect(body.total).toBe(total),
        );

    const restrictedId = (restricted.body as { id: string }).id;
    await request(app.getHttpServer())
      .get(`/files/${restrictedId}`)
      .set(auth(memberToken))
      .expect(200);
    await request(app.getHttpServer())
      .get(`/files/${restrictedId}`)
      .set(auth(otherMemberToken))
      .expect(200);
    await request(app.getHttpServer())
      .get(`/files/${restrictedId}`)
      .set(auth(ownerToken))
      .expect(200);
    await request(app.getHttpServer())
      .get(`/files/${restrictedId}`)
      .set(auth(unauthorizedMemberToken))
      .expect(404);
    await request(app.getHttpServer())
      .get(`/files/${restrictedId}/download`)
      .set(auth(unauthorizedMemberToken))
      .expect(404);
    await request(app.getHttpServer())
      .get(`/files/${restrictedId}/download`)
      .set(auth(otherMemberToken))
      .expect(200);
    expect(
      (multiRestricted.body as { restrictedUserIds: string[] })
        .restrictedUserIds,
    ).toEqual([otherMemberId.toString(), unauthorizedMemberId.toString()]);
  });

  it('applies uploader/owner permission changes immediately without touching S3', async () => {
    const uploaded = await upload(
      'permissions.csv',
      'text/csv',
      Buffer.from('a,b'),
      memberToken,
      {
        visibility: CompanyFileVisibility.RESTRICTED,
        restrictedUserIds: [otherMemberId.toString()],
      },
    ).expect(201);
    const fileId = (uploaded.body as { id: string }).id;
    const storageKeys = [...objects.keys()];

    await request(app.getHttpServer())
      .patch(`/files/${fileId}/permissions`)
      .send({ visibility: CompanyFileVisibility.COMPANY_WIDE })
      .expect(401);
    await request(app.getHttpServer())
      .patch(`/files/${fileId}/permissions`)
      .set(auth(otherOwnerToken))
      .send({ visibility: CompanyFileVisibility.COMPANY_WIDE })
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/files/${fileId}/permissions`)
      .set(auth(memberToken))
      .send({
        visibility: CompanyFileVisibility.RESTRICTED,
        restrictedUserIds: [otherCompanyMemberId.toString()],
      })
      .expect(400);
    await request(app.getHttpServer())
      .patch(`/files/${fileId}/permissions`)
      .set(auth(memberToken))
      .send({
        visibility: CompanyFileVisibility.COMPANY_WIDE,
        companyId: otherCompanyId.toString(),
      })
      .expect(400);

    await request(app.getHttpServer())
      .patch(`/files/${fileId}/permissions`)
      .set(auth(otherMemberToken))
      .send({ visibility: CompanyFileVisibility.COMPANY_WIDE })
      .expect(403);
    await request(app.getHttpServer())
      .patch(`/files/${fileId}/permissions`)
      .set(auth(memberToken))
      .send({ visibility: CompanyFileVisibility.COMPANY_WIDE })
      .expect(200)
      .expect(({ body }: { body: Record<string, unknown> }) =>
        expect(body).toMatchObject({
          visibility: CompanyFileVisibility.COMPANY_WIDE,
          restrictedUserIds: [],
        }),
      );
    await request(app.getHttpServer())
      .get(`/files/${fileId}`)
      .set(auth(unauthorizedMemberToken))
      .expect(200);
    await request(app.getHttpServer())
      .get('/files')
      .set(auth(unauthorizedMemberToken))
      .expect(200)
      .expect(({ body }: { body: { total: number } }) =>
        expect(body.total).toBe(1),
      );
    await request(app.getHttpServer())
      .get(`/files/${fileId}/download`)
      .set(auth(unauthorizedMemberToken))
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/files/${fileId}/permissions`)
      .set(auth(memberToken))
      .send({
        visibility: CompanyFileVisibility.RESTRICTED,
        restrictedUserIds: [unauthorizedMemberId.toString()],
      })
      .expect(200);
    await request(app.getHttpServer())
      .get(`/files/${fileId}`)
      .set(auth(otherMemberToken))
      .expect(404);
    await request(app.getHttpServer())
      .get('/files')
      .set(auth(otherMemberToken))
      .expect(200)
      .expect(({ body }: { body: { total: number } }) =>
        expect(body.total).toBe(0),
      );
    await request(app.getHttpServer())
      .get(`/files/${fileId}/download`)
      .set(auth(otherMemberToken))
      .expect(404);
    await request(app.getHttpServer())
      .get(`/files/${fileId}`)
      .set(auth(unauthorizedMemberToken))
      .expect(200);
    await request(app.getHttpServer())
      .get(`/files/${fileId}/download`)
      .set(auth(unauthorizedMemberToken))
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/files/${fileId}/permissions`)
      .set(auth(ownerToken))
      .send({
        visibility: CompanyFileVisibility.RESTRICTED,
        restrictedUserIds: [otherMemberId.toString()],
      })
      .expect(200);
    expect([...objects.keys()]).toEqual(storageKeys);
    expect(objects.size).toBe(1);
  });

  it('rejects invalid visibility metadata and cross-company employee injection before storage', async () => {
    const deletedEmployeeId = new Types.ObjectId().toString();
    const invalidCases: Array<{
      visibility: CompanyFileVisibility;
      restrictedUserIds?: string[];
    }> = [
      { visibility: CompanyFileVisibility.RESTRICTED },
      {
        visibility: CompanyFileVisibility.COMPANY_WIDE,
        restrictedUserIds: [memberId.toString()],
      },
      {
        visibility: CompanyFileVisibility.RESTRICTED,
        restrictedUserIds: [otherCompanyMemberId.toString()],
      },
      {
        visibility: CompanyFileVisibility.RESTRICTED,
        restrictedUserIds: [ownerId.toString()],
      },
      {
        visibility: CompanyFileVisibility.RESTRICTED,
        restrictedUserIds: [deletedEmployeeId],
      },
      {
        visibility: CompanyFileVisibility.RESTRICTED,
        restrictedUserIds: [memberId.toString(), memberId.toString()],
      },
    ];
    for (const permissions of invalidCases)
      await upload(
        'invalid-permissions.csv',
        'text/csv',
        Buffer.from('a,b'),
        memberToken,
        permissions,
      ).expect(400);
    await request(app.getHttpServer())
      .post('/files')
      .set(auth(memberToken))
      .field('visibility', CompanyFileVisibility.COMPANY_WIDE)
      .field('companyId', otherCompanyId.toString())
      .attach('file', Buffer.from('a,b'), {
        filename: 'injected.csv',
        contentType: 'text/csv',
      })
      .expect(400);
    expect(objects.size).toBe(0);
    expect(files.size).toBe(0);
    expect(periods.size).toBe(0);
  });

  it('allows only the owner to delete employees and makes stale file grants ineffective', async () => {
    const uploaded = await upload(
      'employee-access.csv',
      'text/csv',
      Buffer.from('a,b'),
      memberToken,
      {
        visibility: CompanyFileVisibility.RESTRICTED,
        restrictedUserIds: [otherMemberId.toString()],
      },
    ).expect(201);
    const fileId = (uploaded.body as { id: string }).id;
    await request(app.getHttpServer())
      .delete(`/users/${otherMemberId.toString()}`)
      .set(auth(otherMemberToken))
      .expect(403);
    await request(app.getHttpServer())
      .get('/users')
      .set(auth(memberToken))
      .expect(403);
    await request(app.getHttpServer())
      .patch(`/users/${otherMemberId.toString()}`)
      .set(auth(unauthorizedMemberToken))
      .send({ fullName: 'Unauthorized change' })
      .expect(403);
    await request(app.getHttpServer())
      .delete(`/users/${otherMemberId.toString()}`)
      .set(auth(otherOwnerToken))
      .expect(404);
    await request(app.getHttpServer())
      .delete(`/users/${otherMemberId.toString()}`)
      .set(auth(ownerToken))
      .expect(200);
    await request(app.getHttpServer())
      .get(`/files/${fileId}`)
      .set(auth(otherMemberToken))
      .expect(401);
    await request(app.getHttpServer())
      .get(`/files/${fileId}`)
      .set(auth(unauthorizedMemberToken))
      .expect(404);
    await request(app.getHttpServer())
      .get(`/files/${fileId}`)
      .set(auth(ownerToken))
      .expect(200)
      .expect(({ body }: { body: { restrictedUserIds: string[] } }) =>
        expect(body.restrictedUserIds).toEqual([otherMemberId.toString()]),
      );
    await request(app.getHttpServer())
      .get('/users')
      .set(auth(ownerToken))
      .expect(200)
      .expect(({ body }: { body: { users: Array<{ _id: string }> } }) =>
        expect(body.users.map((user) => user._id)).not.toContain(
          otherMemberId.toString(),
        ),
      );
    await request(app.getHttpServer())
      .delete(`/users/${ownerId.toString()}`)
      .set(auth(ownerToken))
      .expect(400);
    await request(app.getHttpServer())
      .patch(`/files/${fileId}/permissions`)
      .set(auth(ownerToken))
      .send({
        visibility: CompanyFileVisibility.RESTRICTED,
        restrictedUserIds: [otherMemberId.toString()],
      })
      .expect(400);
    await request(app.getHttpServer())
      .patch(`/files/${fileId}/permissions`)
      .set(auth(ownerToken))
      .send({ visibility: CompanyFileVisibility.COMPANY_WIDE })
      .expect(200);
    await request(app.getHttpServer())
      .get(`/files/${fileId}`)
      .set(auth(unauthorizedMemberToken))
      .expect(200);
  });

  it('rejects missing, empty, oversized, unsupported, mismatched, malformed, and injected uploads', async () => {
    await request(app.getHttpServer())
      .post('/files')
      .attach('file', Buffer.from('a,b'), {
        filename: 'data.csv',
        contentType: 'text/csv',
      })
      .expect(401);
    await request(app.getHttpServer())
      .post('/files')
      .set(auth(memberToken))
      .expect(400);
    await upload('empty.csv', 'text/csv', Buffer.alloc(0)).expect(400);
    await upload('large.csv', 'text/csv', Buffer.alloc(1025, 65)).expect(413);
    await upload('data.pdf', 'application/pdf', Buffer.from('x')).expect(400);
    await upload('data.xlsx', 'text/csv', validXlsx()).expect(400);
    await upload(
      'data.csv',
      'application/octet-stream',
      Buffer.from('a,b'),
    ).expect(400);
    await upload(
      'spoofed.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),
        Buffer.from('[Content_Types].xml xl/workbook.xml'),
      ]),
    ).expect(400);
    await upload('data.csv', 'text/csv', Buffer.from([0, 1, 2])).expect(400);
    await upload(
      'data.xls',
      'application/vnd.ms-excel',
      Buffer.alloc(512),
    ).expect(400);
    await request(app.getHttpServer())
      .post('/files')
      .set(auth(memberToken))
      .field('companyId', otherCompanyId.toString())
      .field('uploaderId', otherOwnerId.toString())
      .field('storageKey', 'arbitrary')
      .attach('file', Buffer.from('a,b\n1,2'), {
        filename: 'data.csv',
        contentType: 'text/csv',
      })
      .expect(400);
    expect(files.size).toBe(0);
    expect(objects.size).toBe(0);
  });

  it('protects cleanup previews and confirmation with owner authorization and strict input validation', async () => {
    await request(app.getHttpServer())
      .post('/subscriptions/downgrade-preview')
      .set(auth(memberToken))
      .send({ planCode: 'free' })
      .expect(403);
    await request(app.getHttpServer())
      .post('/subscriptions/downgrade-cleanup')
      .set(auth(memberToken))
      .send({ planCode: 'free', previewToken: 'a'.repeat(64) })
      .expect(403);
    await request(app.getHttpServer())
      .post('/subscriptions/downgrade-preview')
      .set(auth(ownerToken))
      .send({ planCode: 'free', companyId: otherCompanyId.toString() })
      .expect(400);
    await request(app.getHttpServer())
      .post('/subscriptions/downgrade-cleanup')
      .set(auth(ownerToken))
      .send({ planCode: 'free' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/subscriptions/downgrade-cleanup')
      .set(auth(ownerToken))
      .send({ planCode: 'free', previewToken: 'invalid' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/subscriptions/downgrade-preview')
      .set(auth(ownerToken))
      .send({ planCode: 'premium' })
      .expect(409);
    expect(files.size).toBe(0);
  });

  it('enforces Free and Basic hard limits and Premium overage', async () => {
    for (let i = 0; i < 9; i++)
      await upload(`existing-${i}.csv`, 'text/csv', Buffer.from('a,b')).expect(
        201,
      );
    await upload('free-last.csv', 'text/csv', Buffer.from('a,b')).expect(201);
    await upload('free-over.csv', 'text/csv', Buffer.from('a,b')).expect(403);

    subscriptions.get(companyId.toString())!.planCode = PlanCode.BASIC;
    periods.get(companyId.toString())!.uploadedFiles = 99;
    seedStoredFiles(99);
    await upload('basic-last.csv', 'text/csv', Buffer.from('a,b')).expect(201);
    await upload('basic-over.csv', 'text/csv', Buffer.from('a,b')).expect(403);

    subscriptions.get(companyId.toString())!.planCode = PlanCode.PREMIUM;
    periods.get(companyId.toString())!.uploadedFiles = 999;
    seedStoredFiles(999);
    await upload('premium-1000.csv', 'text/csv', Buffer.from('a,b')).expect(
      201,
    );
    await upload('premium-1001.csv', 'text/csv', Buffer.from('a,b')).expect(
      201,
    );
    expect(periods.get(companyId.toString())).toMatchObject({
      uploadedFiles: 1001,
      fileOverageCents: 50,
    });
    await request(app.getHttpServer())
      .get('/subscriptions/current/billing')
      .set(auth(memberToken))
      .expect(200)
      .expect(
        ({
          body,
        }: {
          body: {
            successfulUploads: number;
            billableOverageUploads: number;
            overageChargeCents: number;
            totalAmountCents: number;
          };
        }) =>
          expect(body).toMatchObject({
            successfulUploads: 1001,
            billableOverageUploads: 1,
            overageChargeCents: 50,
            totalAmountCents: 30050,
          }),
      );

    await request(app.getHttpServer())
      .patch('/subscriptions/current')
      .set(auth(ownerToken))
      .send({ planCode: PlanCode.BASIC })
      .expect(409);
    // The owner chooses which 100 files to retain; historical usage is unchanged.
    const extraIds = [...files.keys()].slice(100);
    for (const id of extraIds) {
      const file = files.get(id)!;
      objects.delete(file.storageKey);
      files.delete(id);
    }
    await request(app.getHttpServer())
      .patch('/subscriptions/current')
      .set(auth(ownerToken))
      .send({ planCode: PlanCode.BASIC })
      .expect(200);
    await upload(
      'blocked-after-downgrade.csv',
      'text/csv',
      Buffer.from('a,b'),
    ).expect(403);
    expect(periods.get(companyId.toString())).toMatchObject({
      uploadedFiles: 1001,
      fileOverageCents: 50,
    });
  });

  it.each([PlanCode.FREE, PlanCode.BASIC, PlanCode.PREMIUM])(
    'deleting a %s file frees capacity for a replacement',
    async (code) => {
      subscriptions.get(companyId.toString())!.planCode = code;
      const limit =
        code === PlanCode.FREE ? 10 : code === PlanCode.BASIC ? 100 : 1000;
      seedStoredFiles(limit - 1);
      seedPeriod(limit - 1);
      let lastFileId = '';
      for (let i = 0; i < 1; i++) {
        const uploaded = await upload(
          `file-${i}.csv`,
          'text/csv',
          Buffer.from('a,b'),
        ).expect(201);
        lastFileId = (uploaded.body as { id: string }).id;
      }
      if (code !== PlanCode.PREMIUM)
        await upload('blocked.csv', 'text/csv', Buffer.from('a,b')).expect(403);
      await request(app.getHttpServer())
        .delete(`/files/${lastFileId}`)
        .set(auth(ownerToken))
        .expect(200);
      await request(app.getHttpServer())
        .get('/subscriptions/current')
        .set(auth(ownerToken))
        .expect(200)
        .expect(
          ({
            body,
          }: {
            body: {
              storedFiles: number;
              billingPeriod: { uploadedFiles: number };
            };
          }) =>
            expect(body).toMatchObject({
              storedFiles: limit - 1,
              billingPeriod: { uploadedFiles: limit },
            }),
        );
      await upload('replacement.csv', 'text/csv', Buffer.from('a,b')).expect(
        201,
      );
      expect(files.size).toBe(limit);
      expect(periods.get(companyId.toString())?.uploadedFiles).toBe(limit + 1);
      expect(periods.get(companyId.toString())?.fileOverageCents).toBe(0);
      if (code !== PlanCode.PREMIUM)
        await upload(
          'still-blocked.csv',
          'text/csv',
          Buffer.from('a,b'),
        ).expect(403);
    },
  );

  it('serializes a final Premium upload against an immediate downgrade', async () => {
    subscriptions.get(companyId.toString())!.planCode = PlanCode.PREMIUM;
    seedPeriod(1000);
    seedStoredFiles(99);

    const [uploadResponse, downgradeResponse] = await Promise.all([
      upload('plan-race.csv', 'text/csv', Buffer.from('a,b')),
      request(app.getHttpServer())
        .patch('/subscriptions/current')
        .set(auth(ownerToken))
        .send({ planCode: PlanCode.BASIC }),
    ]);

    expect(downgradeResponse.status).toBe(200);
    expect([201, 403]).toContain(uploadResponse.status);
    const period = periods.get(companyId.toString())!;
    expect(subscriptions.get(companyId.toString())!.planCode).toBe(
      PlanCode.BASIC,
    );
    expect(period.uploadedFiles).toBe(
      uploadResponse.status === 201 ? 1001 : 1000,
    );
    expect(period.fileOverageCents).toBe(0);
  });

  it('serializes concurrent final-slot uploads and cleans up the rejected object', async () => {
    for (let i = 0; i < 9; i++)
      await upload(`existing-${i}.csv`, 'text/csv', Buffer.from('a,b')).expect(
        201,
      );
    const responses = await Promise.all([
      upload('first.csv', 'text/csv', Buffer.from('a,b')),
      upload('second.csv', 'text/csv', Buffer.from('a,b')),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 403,
    ]);
    expect(files.size).toBe(10);
    expect(objects.size).toBe(10);
    expect(periods.get(companyId.toString())?.uploadedFiles).toBe(10);
  });

  it('does not consume quota on S3 failure and compensates metadata failure', async () => {
    failNextPut = true;
    await upload('storage.csv', 'text/csv', Buffer.from('a,b')).expect(503);
    expect(periods.size).toBe(0);
    expect(objects.size).toBe(0);

    failNextMetadataCreate = true;
    await upload('metadata.csv', 'text/csv', Buffer.from('a,b')).expect(500);
    expect(periods.size).toBe(0);
    expect(files.size).toBe(0);
    expect(objects.size).toBe(0);
  });

  it('paginates metadata and hides cross-tenant identifiers', async () => {
    const createdAt = new Date();
    for (let index = 0; index < 31; index++) {
      const id = new Types.ObjectId();
      files.set(id.toString(), {
        _id: id,
        companyId: companyId.toString(),
        uploaderId: memberId.toString(),
        originalFilename: `${index}.csv`,
        storageKey: `companies/${companyId.toString()}/files/${index}.csv`,
        fileType: CompanyFileType.CSV,
        mimeType: 'text/csv',
        size: 3,
        visibility: CompanyFileVisibility.COMPANY_WIDE,
        restrictedUserIds: [],
        createdAt,
        updatedAt: createdAt,
      });
    }
    const targetId = [...files.keys()][0];
    await request(app.getHttpServer())
      .get('/files?page=2&take=30')
      .set(auth(memberToken))
      .expect(200)
      .expect(({ body }: { body: { total: number; files: object[] } }) => {
        expect(body.total).toBe(31);
        expect(body.files).toHaveLength(1);
        expect(JSON.stringify(body)).not.toContain('storageKey');
      });
    await request(app.getHttpServer())
      .get(`/files/${targetId}`)
      .set(auth(otherOwnerToken))
      .expect(404);
    await request(app.getHttpServer())
      .get('/files/not-an-id')
      .set(auth(memberToken))
      .expect(400);
  });

  it('streams downloads privately and applies uploader/owner deletion rules while preserving upload history', async () => {
    const uploaded = await upload(
      '../safe.csv',
      'text/csv',
      Buffer.from('a,b\n1,2'),
    ).expect(201);
    const body = uploaded.body as unknown as { id: string };
    const periodBeforeDelete = periods.get(companyId.toString())!.uploadedFiles;
    await request(app.getHttpServer())
      .get(`/files/${body.id}/download`)
      .set(auth(memberToken))
      .expect('Content-Type', /text\/csv/)
      .expect('Content-Disposition', /attachment/)
      .expect('Cache-Control', 'private, no-store')
      .expect('X-Content-Type-Options', 'nosniff')
      .expect(200);
    await request(app.getHttpServer())
      .get(`/files/${body.id}/download`)
      .set(auth(otherOwnerToken))
      .expect(404);
    await request(app.getHttpServer())
      .delete(`/files/${body.id}`)
      .set(auth(otherMemberToken))
      .expect(403);
    await request(app.getHttpServer())
      .delete(`/files/${body.id}`)
      .set(auth(ownerToken))
      .expect(200);
    expect(files.size).toBe(0);
    expect(objects.size).toBe(0);
    expect(periods.get(companyId.toString())!.uploadedFiles).toBe(
      periodBeforeDelete,
    );
  });

  it('keeps metadata retryable when S3 deletion fails', async () => {
    const uploaded = await upload(
      'safe.csv',
      'text/csv',
      Buffer.from('a,b'),
    ).expect(201);
    const body = uploaded.body as unknown as { id: string };
    failNextDelete = true;
    await request(app.getHttpServer())
      .delete(`/files/${body.id}`)
      .set(auth(memberToken))
      .expect(503);
    expect(files.has(body.id)).toBe(true);
    expect(objects.size).toBe(1);
  });
});
