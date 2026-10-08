import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  OpenAPIObject,
  OperationObject,
  PathItemObject,
} from '@nestjs/swagger';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  AdminAuthController,
  AdminController,
} from '../admin/admin.controller';
import { AiController } from '../ai/ai.controller';
import { AuthController } from '../auth/auth.controller';
import { CompaniesController } from '../companies/companies.controller';
import { configureApp } from '../config/configure-app';
import { FilesController } from '../files/files.controller';
import { HealthController } from '../health/health.controller';
import { InvitationsController } from '../invitations/invitations.controller';
import {
  PaymentsController,
  StripeWebhookController,
} from '../payments/payments.controller';
import { PlansController } from '../plans/plans.controller';
import { StatisticsController } from '../statistics/statistics.controller';
import { SubscriptionsController } from '../subscriptions/subscriptions.controller';
import { UsersController } from '../users/users.controller';
import { configureSwagger, createOpenApiDocument } from '.';
import { PLATFORM_ADMIN_JWT, TENANT_JWT } from './swagger';

const controllers = [
  AuthController,
  UsersController,
  CompaniesController,
  PlansController,
  SubscriptionsController,
  InvitationsController,
  FilesController,
  StatisticsController,
  PaymentsController,
  StripeWebhookController,
  AdminAuthController,
  AdminController,
  HealthController,
  AiController,
];

const httpMethods = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'options',
  'head',
]);

function requirePath(document: OpenAPIObject, path: string): PathItemObject {
  const item = document.paths[path];
  expect(item).toBeDefined();
  if (!item) throw new Error(`Expected OpenAPI path ${path}`);
  return item;
}

function requireOperation(
  item: PathItemObject,
  method: keyof PathItemObject,
): OperationObject {
  const operation = item[method];
  expect(operation).toBeDefined();
  if (
    !operation ||
    typeof operation !== 'object' ||
    !('responses' in operation)
  )
    throw new Error(`Expected OpenAPI operation ${String(method)}`);
  return operation;
}

describe('OpenAPI document', () => {
  let app: INestApplication;
  let document: OpenAPIObject;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers })
      .useMocker(() => ({}))
      .compile();
    app = module.createNestApplication();
    document = createOpenApiDocument(app);
  });

  afterAll(async () => app.close());

  it('generates the complete API document without initializing dependencies', () => {
    const operationCount = Object.values(document.paths).reduce(
      (count, item) =>
        count +
        Object.keys(item ?? {}).filter((key) => httpMethods.has(key)).length,
      0,
    );

    expect(operationCount).toBe(58);
    expect(document.info).toMatchObject({
      title: 'DataVault SaaS API',
      version: '1.0',
    });

    for (const item of Object.values(document.paths)) {
      for (const [method, candidate] of Object.entries(item ?? {})) {
        if (!httpMethods.has(method)) continue;
        const operation = candidate as OperationObject;
        expect(operation.summary).toBeTruthy();
        expect(operation.tags?.length).toBeGreaterThan(0);
        expect(Object.keys(operation.responses).length).toBeGreaterThan(0);
      }
    }
  });

  it('documents workspace recovery separately from platform admin recovery', () => {
    const forgot = requireOperation(
      requirePath(document, '/auth/forgot-password'),
      'post',
    );
    const reset = requireOperation(
      requirePath(document, '/auth/reset-password'),
      'post',
    );
    expect(forgot.security).toBeUndefined();
    expect(reset.security).toBeUndefined();
    expect(forgot.responses?.['202']).toBeDefined();
    expect(reset.responses?.['200']).toBeDefined();
  });

  it('documents Google exchange as public and only returns the normal token response', () => {
    const exchange = requireOperation(
      requirePath(document, '/auth/google/exchange'),
      'post',
    );
    expect(exchange.security).toBeUndefined();
    expect(JSON.stringify(exchange)).not.toContain('clientSecret');
    expect(JSON.stringify(exchange)).not.toContain('stateHash');
    expect(JSON.stringify(exchange)).not.toContain('codeHash');
    expect(exchange.responses?.['200']).toBeDefined();
  });

  it('documents one-use Google registration separately from sign-in', () => {
    const registration = requireOperation(
      requirePath(document, '/auth/google/register'),
      'post',
    );
    expect(registration.security).toBeUndefined();
    expect(registration.responses?.['200']).toBeDefined();
  });

  it('documents actual success statuses and bounded query controls', () => {
    expect(
      requireOperation(requirePath(document, '/auth/sign-up'), 'post')
        .responses,
    ).toHaveProperty('202');
    expect(
      requireOperation(requirePath(document, '/users/me/password'), 'patch')
        .responses,
    ).toHaveProperty('200');
    expect(
      requireOperation(requirePath(document, '/files'), 'post').responses,
    ).toHaveProperty('201');
    expect(
      requireOperation(requirePath(document, '/payments/checkout'), 'post')
        .responses,
    ).toHaveProperty('201');
    expect(
      requireOperation(requirePath(document, '/payments/webhook'), 'post')
        .responses,
    ).toHaveProperty('200');

    const queryNames = (operation: OperationObject) =>
      (operation.parameters ?? [])
        .filter(
          (
            parameter,
          ): parameter is Exclude<typeof parameter, { $ref: string }> =>
            !('$ref' in parameter) && parameter.in === 'query',
        )
        .map((parameter) => parameter.name);

    expect(
      queryNames(
        requireOperation(requirePath(document, '/admin/companies'), 'get'),
      ),
    ).toEqual(
      expect.arrayContaining([
        'page',
        'limit',
        'order',
        'search',
        'sortBy',
        'activation',
        'status',
        'plan',
        'paymentAccess',
        'stripeManaged',
      ]),
    );
    expect(
      queryNames(requireOperation(requirePath(document, '/files'), 'get')),
    ).toEqual(expect.arrayContaining(['page', 'take']));
    expect(
      queryNames(
        requireOperation(requirePath(document, '/ai/conversations'), 'get'),
      ),
    ).toEqual(expect.arrayContaining(['page', 'limit']));

    for (const [path, method] of [
      ['/subscriptions/current/billing', 'get'],
      ['/statistics/current', 'get'],
      ['/payments/current', 'get'],
      ['/payments/portal', 'post'],
      ['/payments/cancel', 'post'],
      ['/payments/reconcile', 'post'],
      ['/admin/companies/{id}/reactivate', 'post'],
    ] as const)
      expect(
        requireOperation(requirePath(document, path), method).requestBody,
      ).toBeUndefined();
  });

  it('keeps tenant and platform-admin authentication visibly separate', () => {
    expect(document.components?.securitySchemes).toMatchObject({
      [TENANT_JWT]: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      [PLATFORM_ADMIN_JWT]: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    });

    const tenant = requireOperation(
      requirePath(document, '/statistics/current'),
      'get',
    );
    const admin = requireOperation(
      requirePath(document, '/admin/dashboard'),
      'get',
    );
    const publicTenantLogin = requireOperation(
      requirePath(document, '/auth/sign-in'),
      'post',
    );
    const publicAdminLogin = requireOperation(
      requirePath(document, '/admin/auth/login'),
      'post',
    );

    expect(tenant.security).toEqual([{ [TENANT_JWT]: [] }]);
    expect(tenant.security).not.toContainEqual([{ [PLATFORM_ADMIN_JWT]: [] }]);
    expect(admin.security).toEqual([{ [PLATFORM_ADMIN_JWT]: [] }]);
    expect(admin.security).not.toContainEqual([{ [TENANT_JWT]: [] }]);
    expect(publicTenantLogin.security).toBeUndefined();
    expect(publicAdminLogin.security).toBeUndefined();

    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, candidate] of Object.entries(item ?? {})) {
        if (!httpMethods.has(method)) continue;
        const operation = candidate as OperationObject;
        if (path.startsWith('/admin/') && !path.startsWith('/admin/auth/'))
          expect(operation.security).toEqual([{ [PLATFORM_ADMIN_JWT]: [] }]);
        else if (
          path.startsWith('/files') ||
          path.startsWith('/users') ||
          path.startsWith('/companies') ||
          path.startsWith('/subscriptions') ||
          path.startsWith('/statistics') ||
          path.startsWith('/ai') ||
          (path.startsWith('/payments') && path !== '/payments/webhook')
        )
          expect(operation.security).toEqual([{ [TENANT_JWT]: [] }]);
      }
    }
  });

  it('shows only validated company identity and profile inputs', () => {
    expect(document.components?.schemas?.SignUpDto).toMatchObject({
      properties: {
        email: { type: 'string' },
        password: { writeOnly: true },
        companyName: { type: 'string' },
        country: { type: 'string' },
        industry: { type: 'string' },
      },
    });
    const update = document.components?.schemas?.UpdateCompanyDto;
    expect(update).toMatchObject({
      properties: {
        name: { type: 'string' },
        country: { type: 'string' },
        industry: { type: 'string' },
      },
    });
    expect(JSON.stringify(update)).not.toContain('activatedAt');
    expect(JSON.stringify(update)).not.toContain('platformStatus');
  });

  it('documents multipart uploads and private binary downloads', () => {
    const upload = requireOperation(requirePath(document, '/files'), 'post');
    const uploadSchema = upload.requestBody;
    expect(uploadSchema).toMatchObject({
      content: {
        'multipart/form-data': {
          schema: {
            required: ['file'],
            properties: {
              file: { type: 'string', format: 'binary' },
              visibility: { type: 'string' },
              restrictedUserIds: { type: 'array' },
            },
          },
        },
      },
    });

    const download = requireOperation(
      requirePath(document, '/files/{id}/download'),
      'get',
    );
    expect(download.responses['200']).toMatchObject({
      content: {
        'text/csv': {
          schema: { type: 'string', format: 'binary' },
        },
        'application/vnd.ms-excel': {
          schema: { type: 'string', format: 'binary' },
        },
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
          schema: { type: 'string', format: 'binary' },
        },
      },
    });
  });

  it('documents AI inputs and visible operational metadata without client model selection', () => {
    const chat = requireOperation(requirePath(document, '/ai/chat'), 'post');
    expect(chat.requestBody).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/AiChatDto' },
        },
      },
    });

    const chatDto = document.components?.schemas?.AiChatDto;
    expect(chatDto).toMatchObject({
      properties: {
        message: { type: 'string' },
        conversationId: { type: 'string' },
      },
    });
    expect(JSON.stringify(chatDto)).not.toContain('model');

    expect(chat.responses['200']).toMatchObject({
      content: {
        'application/json': {
          schema: {
            properties: {
              requestId: { type: 'string', format: 'uuid' },
              usage: {
                properties: {
                  model: { type: 'string' },
                  promptTokens: { type: 'integer' },
                  completionTokens: { type: 'integer' },
                  providerCostUsdMicros: { type: 'integer' },
                  durationMs: { type: 'integer' },
                  toolCallCount: { type: 'integer' },
                },
              },
            },
          },
        },
      },
    });
  });

  it('documents the unauthenticated Stripe webhook signature boundary', () => {
    const webhook = requireOperation(
      requirePath(document, '/payments/webhook'),
      'post',
    );
    expect(webhook.security).toBeUndefined();
    expect(webhook.parameters).toContainEqual(
      expect.objectContaining({
        name: 'stripe-signature',
        in: 'header',
        required: true,
      }),
    );
  });

  it('omits sensitive and implementation-only response fields', () => {
    const serialized = JSON.stringify(document);
    for (const forbidden of [
      'passwordHash',
      'tokenHash',
      'storageKey',
      'activeRequestId',
      'activeRequestExpiresAt',
      'stripeSecret',
      'webhookSecret',
      'systemPrompt',
      'toolPayload',
      'toolResult',
    ]) {
      expect(serialized).not.toContain(`"${forbidden}"`);
    }

    expect(document.components?.schemas?.SignInDto).toMatchObject({
      properties: { password: { writeOnly: true } },
    });
    expect(document.components?.schemas?.VerifyAccountDto).toMatchObject({
      properties: { token: { writeOnly: true } },
    });
  });
});

describe('Swagger HTTP route', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: ConfigService,
          useValue: {
            get: () => undefined,
            getOrThrow: () => 0,
          },
        },
      ],
    })
      .useMocker(() => ({}))
      .compile();
    app = module.createNestApplication();
    configureApp(app);
    configureSwagger(app);
    await app.init();
  });

  afterAll(async () => app.close());

  it('serves the UI and JSON with a docs-specific CSP', async () => {
    const ui = await request(app.getHttpServer()).get('/docs').expect(200);
    expect(ui.headers['content-security-policy']).toContain("'unsafe-inline'");
    const json = await request(app.getHttpServer())
      .get('/docs/openapi.json')
      .expect(200);
    const body: unknown = json.body;
    expect(body).toMatchObject({
      info: { title: 'DataVault SaaS API', version: '1.0' },
      paths: { '/health/live': {} },
    });
    expect(body).toHaveProperty('openapi');
  });
});
