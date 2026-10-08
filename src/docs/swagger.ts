import { INestApplication } from '@nestjs/common';
import {
  OpenAPIObject,
  SchemaObject,
  SwaggerModule,
  DocumentBuilder,
} from '@nestjs/swagger';
import helmet from 'helmet';
import { Role } from '../enums/roles.enum';
import {
  CompanyPlatformReason,
  CompanyPlatformStatus,
} from '../companies/platform-status';
import {
  AdminAuditAction,
  AdminAuditReason,
} from '../admin/entities/admin-audit.entity';
import {
  CompanyFileType,
  CompanyFileVisibility,
} from '../files/entities/company-file.entity';
import { InvitationStatus } from '../invitations/entities/employee-invitation.entity';
import { PaymentAccess, PaymentSyncIssue } from '../payments/payment.constants';
import { PlanCode } from '../plans/plan.constants';

export const TENANT_JWT = 'tenant-jwt';
export const PLATFORM_ADMIN_JWT = 'platform-admin-jwt';
export const SWAGGER_PATH = 'docs';

type Schema = SchemaObject;

const id: Schema = { type: 'string', pattern: '^[a-fA-F0-9]{24}$' };
const date: Schema = { type: 'string', format: 'date-time' };
const nullableDate: Schema = { ...date, nullable: true };
const nullableString: Schema = { type: 'string', nullable: true };
const cents: Schema = { type: 'integer', minimum: 0, description: 'USD cents' };

export const apiSchemas = {
  error: {
    type: 'object',
    properties: {
      statusCode: { type: 'integer' },
      message: {
        oneOf: [
          { type: 'string' },
          { type: 'array', items: { type: 'string' } },
        ],
      },
      error: { type: 'string' },
      code: { type: 'string' },
      requestId: { type: 'string', format: 'uuid' },
    },
  } satisfies Schema,
  message: {
    type: 'object',
    required: ['message'],
    properties: { message: { type: 'string' } },
  } satisfies Schema,
  accessToken: {
    type: 'object',
    required: ['accessToken'],
    properties: {
      accessToken: {
        type: 'string',
        writeOnly: true,
        description: 'Bearer JWT returned only by the authentication response.',
      },
    },
  } satisfies Schema,
  user: {
    type: 'object',
    required: ['_id', 'email', 'companyId', 'role', 'createdAt', 'updatedAt'],
    properties: {
      _id: id,
      fullName: { type: 'string' },
      email: { type: 'string', format: 'email' },
      companyId: id,
      role: { type: 'string', enum: Object.values(Role) },
      avatar: { type: 'string' },
      createdAt: date,
      updatedAt: date,
    },
  } satisfies Schema,
  company: {
    type: 'object',
    required: [
      '_id',
      'name',
      'country',
      'industry',
      'platformStatus',
      'createdAt',
      'updatedAt',
    ],
    properties: {
      _id: id,
      name: { type: 'string' },
      country: { type: 'string', minLength: 2, maxLength: 2 },
      industry: { type: 'string' },
      activatedAt: nullableDate,
      platformStatus: {
        type: 'string',
        enum: Object.values(CompanyPlatformStatus),
      },
      createdAt: date,
      updatedAt: date,
    },
  } satisfies Schema,
  plan: {
    type: 'object',
    required: [
      'code',
      'name',
      'currency',
      'basePriceCents',
      'employeePriceCents',
      'includedFilesPerMonth',
      'maxEmployees',
      'extraFilePriceCents',
      'interval',
    ],
    properties: {
      code: { type: 'string', enum: Object.values(PlanCode) },
      name: { type: 'string' },
      currency: { type: 'string', enum: ['USD'] },
      basePriceCents: cents,
      employeePriceCents: cents,
      includedFilesPerMonth: { type: 'integer', minimum: 0 },
      maxEmployees: { type: 'integer', minimum: 0, nullable: true },
      extraFilePriceCents: { ...cents, nullable: true },
      interval: { type: 'string', enum: ['month'] },
    },
  } satisfies Schema,
  billingPeriod: {
    type: 'object',
    required: ['startsAt', 'endsAt'],
    properties: { startsAt: date, endsAt: date },
  } satisfies Schema,
  billingSummary: {
    type: 'object',
    required: [
      'companyId',
      'calculationBasis',
      'currency',
      'plan',
      'activatedAt',
      'planChangedAt',
      'planChangedInCurrentPeriod',
      'billingPeriod',
      'baseAmountCents',
      'employeeCount',
      'billableEmployeeCount',
      'employeeUnitPriceCents',
      'employeeChargeCents',
      'includedUploadAllowance',
      'successfulUploads',
      'billableOverageUploads',
      'overageUnitPriceCents',
      'overageChargeCents',
      'totalAmountCents',
    ],
    properties: {
      companyId: id,
      calculationBasis: {
        type: 'string',
        enum: ['current_plan_estimate_with_recorded_overage'],
      },
      currency: { type: 'string', enum: ['USD'] },
      plan: {} as Schema,
      activatedAt: date,
      planChangedAt: date,
      planChangedInCurrentPeriod: { type: 'boolean' },
      billingPeriod: {} as Schema,
      baseAmountCents: cents,
      employeeCount: { type: 'integer', minimum: 0 },
      billableEmployeeCount: { type: 'integer', minimum: 0 },
      employeeUnitPriceCents: cents,
      employeeChargeCents: cents,
      includedUploadAllowance: { type: 'integer', minimum: 0 },
      successfulUploads: { type: 'integer', minimum: 0 },
      billableOverageUploads: { type: 'integer', minimum: 0 },
      overageUnitPriceCents: cents,
      overageChargeCents: cents,
      totalAmountCents: cents,
    },
  } satisfies Schema,
  invitation: {
    type: 'object',
    required: ['id', 'email', 'status', 'expiresAt', 'lastSentAt'],
    properties: {
      id,
      email: { type: 'string', format: 'email' },
      status: { type: 'string', enum: Object.values(InvitationStatus) },
      expiresAt: date,
      lastSentAt: date,
    },
  } satisfies Schema,
  file: {
    type: 'object',
    required: [
      'id',
      'uploaderId',
      'originalFilename',
      'fileType',
      'mimeType',
      'size',
      'visibility',
      'restrictedUserIds',
      'createdAt',
      'updatedAt',
    ],
    properties: {
      id,
      uploaderId: id,
      originalFilename: { type: 'string' },
      fileType: { type: 'string', enum: Object.values(CompanyFileType) },
      mimeType: { type: 'string' },
      size: { type: 'integer', minimum: 1 },
      visibility: {
        type: 'string',
        enum: Object.values(CompanyFileVisibility),
      },
      restrictedUserIds: { type: 'array', items: id },
      createdAt: date,
      updatedAt: date,
    },
  } satisfies Schema,
  aiConversation: {
    type: 'object',
    required: ['id', 'title', 'messageCount', 'createdAt', 'updatedAt'],
    properties: {
      id,
      title: { type: 'string', maxLength: 80 },
      messageCount: { type: 'integer', minimum: 0 },
      createdAt: date,
      updatedAt: date,
    },
  } satisfies Schema,
  aiMessage: {
    type: 'object',
    required: ['id', 'role', 'content'],
    properties: {
      id,
      role: { type: 'string', enum: ['user', 'assistant'] },
      content: { type: 'string' },
      createdAt: date,
    },
  } satisfies Schema,
  aiUsage: {
    type: 'object',
    required: [
      'model',
      'promptTokens',
      'completionTokens',
      'totalTokens',
      'durationMs',
      'toolCallCount',
    ],
    properties: {
      model: { type: 'string' },
      promptTokens: { type: 'integer', minimum: 0 },
      completionTokens: { type: 'integer', minimum: 0 },
      totalTokens: { type: 'integer', minimum: 0 },
      providerCostUsdMicros: {
        type: 'integer',
        minimum: 0,
        nullable: true,
        description:
          'Provider-reported cost in millionths of one USD, when supplied.',
      },
      durationMs: { type: 'integer', minimum: 0 },
      toolCallCount: { type: 'integer', minimum: 0 },
    },
  } satisfies Schema,
  paymentCurrent: {
    type: 'object',
    required: [
      'mode',
      'planCode',
      'paymentAccess',
      'stripeStatus',
      'cancelAtPeriodEnd',
      'pendingPlanCode',
      'pendingPlanAt',
      'billingPeriod',
      'synchronization',
      'invoices',
    ],
    properties: {
      mode: { type: 'string', enum: ['test'] },
      planCode: { type: 'string', enum: Object.values(PlanCode) },
      paymentAccess: { type: 'string', enum: Object.values(PaymentAccess) },
      stripeStatus: nullableString,
      cancelAtPeriodEnd: { type: 'boolean' },
      pendingPlanCode: {
        type: 'string',
        enum: Object.values(PlanCode),
        nullable: true,
      },
      pendingPlanAt: nullableDate,
      billingPeriod: {} as Schema,
      synchronization: {
        type: 'object',
        required: ['issue', 'lastSyncedAt', 'pendingUsage'],
        properties: {
          issue: { type: 'string', enum: Object.values(PaymentSyncIssue) },
          lastSyncedAt: nullableDate,
          pendingUsage: { type: 'integer', minimum: 0 },
        },
      },
      invoices: {
        type: 'array',
        items: {
          type: 'object',
          required: [
            'id',
            'status',
            'currency',
            'amountDueCents',
            'amountPaidCents',
            'totalCents',
            'hostedInvoiceUrl',
            'createdAt',
          ],
          properties: {
            id: { type: 'string' },
            status: nullableString,
            currency: { type: 'string' },
            amountDueCents: cents,
            amountPaidCents: cents,
            totalCents: cents,
            hostedInvoiceUrl: { type: 'string', format: 'uri', nullable: true },
            createdAt: date,
          },
        },
      },
    },
  } satisfies Schema,
};

apiSchemas.billingSummary.properties.plan = apiSchemas.plan;
apiSchemas.billingSummary.properties.billingPeriod = apiSchemas.billingPeriod;
apiSchemas.paymentCurrent.properties.billingPeriod = apiSchemas.billingPeriod;

export const arrayOf = (items: Schema): Schema => ({ type: 'array', items });
export const paged = (
  property: string,
  items: Schema,
  takeProperty = 'take',
): Schema => ({
  type: 'object',
  required: [property, 'total', 'page', takeProperty],
  properties: {
    [property]: arrayOf(items),
    total: { type: 'integer', minimum: 0 },
    page: { type: 'integer', minimum: 1 },
    [takeProperty]: { type: 'integer', minimum: 1 },
  },
});

export const adminPaged = (items: Schema): Schema => ({
  type: 'object',
  required: ['items', 'pagination'],
  properties: {
    items: arrayOf(items),
    pagination: {
      type: 'object',
      required: ['page', 'limit', 'total'],
      properties: {
        page: { type: 'integer', minimum: 1, maximum: 1000 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        total: { type: 'integer', minimum: 0 },
      },
    },
  },
});

const adminCompany: Schema = {
  type: 'object',
  required: [
    'id',
    'name',
    'country',
    'industry',
    'activatedAt',
    'platformStatus',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id,
    name: { type: 'string' },
    country: { type: 'string' },
    industry: { type: 'string' },
    activatedAt: nullableDate,
    platformStatus: {
      type: 'string',
      enum: Object.values(CompanyPlatformStatus),
    },
    platformStatusReason: {
      type: 'string',
      enum: Object.values(CompanyPlatformReason),
      nullable: true,
    },
    platformStatusChangedAt: nullableDate,
    platformStatusChangedBy: { ...id, nullable: true },
    createdAt: date,
    updatedAt: date,
    subscription: {
      type: 'object',
      nullable: true,
      required: ['planCode'],
      properties: {
        planCode: { type: 'string', enum: Object.values(PlanCode) },
        stripeManaged: { type: 'boolean' },
        paymentAccess: { type: 'string', enum: Object.values(PaymentAccess) },
        stripeStatus: nullableString,
        paymentSyncIssue: {
          type: 'string',
          enum: Object.values(PaymentSyncIssue),
        },
        stripeSyncedAt: nullableDate,
        pendingPlanCode: {
          type: 'string',
          enum: Object.values(PlanCode),
          nullable: true,
        },
        pendingPlanAt: nullableDate,
      },
    },
  },
};

const adminUser: Schema = {
  type: 'object',
  required: ['id', 'companyId', 'email', 'role', 'createdAt'],
  properties: {
    id,
    companyId: id,
    fullName: { type: 'string' },
    email: { type: 'string', format: 'email' },
    role: { type: 'string', enum: Object.values(Role) },
    createdAt: date,
  },
};

const adminOwner: Schema = {
  type: 'object',
  nullable: true,
  required: ['id', 'email', 'createdAt'],
  properties: {
    id,
    email: { type: 'string', format: 'email' },
    fullName: { type: 'string' },
    createdAt: date,
  },
};

const adminFile: Schema = {
  type: 'object',
  required: [
    'id',
    'companyId',
    'uploaderId',
    'originalFilename',
    'fileType',
    'mimeType',
    'size',
    'visibility',
    'restrictedUserIds',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id,
    companyId: id,
    uploaderId: id,
    originalFilename: { type: 'string' },
    fileType: { type: 'string', enum: Object.values(CompanyFileType) },
    mimeType: { type: 'string' },
    size: { type: 'integer', minimum: 1 },
    visibility: {
      type: 'string',
      enum: Object.values(CompanyFileVisibility),
    },
    restrictedUserIds: { type: 'array', items: id },
    createdAt: date,
    updatedAt: date,
  },
};

const adminAudit: Schema = {
  type: 'object',
  required: ['id', 'action', 'createdAt'],
  properties: {
    id,
    action: { type: 'string', enum: Object.values(AdminAuditAction) },
    actorId: { ...id, nullable: true },
    targetId: { ...id, nullable: true },
    targetType: {
      type: 'string',
      enum: ['platform_admin', 'company'],
      nullable: true,
    },
    reason: {
      type: 'string',
      enum: [
        ...Object.values(CompanyPlatformReason),
        ...Object.values(AdminAuditReason),
      ],
      nullable: true,
    },
    previousStatus: {
      type: 'string',
      enum: Object.values(CompanyPlatformStatus),
      nullable: true,
    },
    nextStatus: {
      type: 'string',
      enum: Object.values(CompanyPlatformStatus),
      nullable: true,
    },
    createdAt: date,
  },
};

export const apiResponses = {
  users: paged('users', apiSchemas.user),
  plans: arrayOf(apiSchemas.plan),
  currentSubscription: {
    type: 'object',
    required: [
      'companyId',
      'plan',
      'activatedAt',
      'planChangedAt',
      'billingPeriod',
      'employeeCount',
      'monthlyPriceEstimateCents',
      'billingSummary',
    ],
    properties: {
      companyId: id,
      plan: apiSchemas.plan,
      activatedAt: date,
      planChangedAt: date,
      billingPeriod: {
        type: 'object',
        required: ['startsAt', 'endsAt', 'uploadedFiles', 'fileOverageCents'],
        properties: {
          startsAt: date,
          endsAt: date,
          uploadedFiles: { type: 'integer', minimum: 0 },
          fileOverageCents: cents,
        },
      },
      employeeCount: { type: 'integer', minimum: 0 },
      monthlyPriceEstimateCents: cents,
      billingSummary: apiSchemas.billingSummary,
    },
  } satisfies Schema,
  invitationCreated: {
    type: 'object',
    required: ['message', 'invitation'],
    properties: {
      message: { type: 'string' },
      invitation: apiSchemas.invitation,
    },
  } satisfies Schema,
  invitations: paged('invitations', apiSchemas.invitation),
  files: paged('files', apiSchemas.file),
  statistics: {
    type: 'object',
    required: ['companyId', 'subscription', 'employees', 'files', 'billing'],
    properties: {
      companyId: id,
      subscription: {
        type: 'object',
        properties: {
          planCode: { type: 'string', enum: Object.values(PlanCode) },
          planName: { type: 'string' },
          activatedAt: date,
          planChangedAt: date,
        },
      },
      employees: {
        type: 'object',
        properties: {
          accepted: { type: 'integer', minimum: 0 },
          pendingInvitations: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 0, nullable: true },
          unlimited: { type: 'boolean' },
          remainingSlots: { type: 'integer', minimum: 0, nullable: true },
        },
      },
      files: {
        type: 'object',
        properties: {
          currentlyStored: {
            type: 'object',
            properties: {
              total: { type: 'integer', minimum: 0 },
              companyWide: { type: 'integer', minimum: 0 },
              restricted: { type: 'integer', minimum: 0 },
            },
          },
          currentBillingPeriod: {
            type: 'object',
            properties: {
              startsAt: date,
              endsAt: date,
              successfulUploads: { type: 'integer', minimum: 0 },
              includedAllowance: { type: 'integer', minimum: 0 },
              unlimited: { type: 'boolean' },
              remainingIncludedUploads: { type: 'integer', minimum: 0 },
              remainingUploads: {
                type: 'integer',
                minimum: 0,
                nullable: true,
              },
              premiumOverageUploads: { type: 'integer', minimum: 0 },
            },
          },
        },
      },
      billing: {
        type: 'object',
        properties: {
          calculationBasis: { type: 'string' },
          currency: { type: 'string' },
          baseAmountCents: cents,
          employeeChargeCents: cents,
          overageChargeCents: cents,
          totalAmountCents: cents,
        },
      },
    },
  } satisfies Schema,
  aiChat: {
    type: 'object',
    required: ['requestId', 'conversation', 'messages', 'usage'],
    properties: {
      requestId: { type: 'string', format: 'uuid' },
      conversation: apiSchemas.aiConversation,
      messages: arrayOf(apiSchemas.aiMessage),
      usage: apiSchemas.aiUsage,
    },
  } satisfies Schema,
  aiConversations: {
    type: 'object',
    required: ['conversations', 'total', 'page', 'limit'],
    properties: {
      conversations: arrayOf(apiSchemas.aiConversation),
      total: { type: 'integer', minimum: 0 },
      page: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
  } satisfies Schema,
  aiConversationDetail: {
    type: 'object',
    required: ['conversation', 'messages'],
    properties: {
      conversation: apiSchemas.aiConversation,
      messages: arrayOf(apiSchemas.aiMessage),
    },
  } satisfies Schema,
  checkout: {
    type: 'object',
    required: ['url', 'mode', 'paymentCollected'],
    properties: {
      url: { type: 'string', format: 'uri', nullable: true },
      mode: { type: 'string', enum: ['setup'] },
      paymentCollected: { type: 'boolean', enum: [false] },
    },
  } satisfies Schema,
  portal: {
    type: 'object',
    required: ['url'],
    properties: { url: { type: 'string', format: 'uri' } },
  } satisfies Schema,
  planChange: {
    type: 'object',
    required: ['planCode', 'pendingPlanCode'],
    properties: {
      planCode: { type: 'string', enum: Object.values(PlanCode) },
      pendingPlanCode: {
        type: 'string',
        enum: Object.values(PlanCode),
        nullable: true,
      },
      effectiveAt: nullableDate,
      prorationBehavior: { type: 'string', enum: ['none'] },
    },
  } satisfies Schema,
  webhook: {
    type: 'object',
    required: ['received'],
    properties: {
      received: { type: 'boolean' },
      ignored: { type: 'boolean' },
      duplicate: { type: 'boolean' },
    },
  } satisfies Schema,
  healthLive: {
    type: 'object',
    required: ['status'],
    properties: { status: { type: 'string', enum: ['ok'] } },
  } satisfies Schema,
  healthReady: {
    type: 'object',
    required: ['status', 'dependencies'],
    properties: {
      status: { type: 'string', enum: ['ok'] },
      dependencies: {
        type: 'object',
        required: ['mongodb'],
        properties: { mongodb: { type: 'string', enum: ['up'] } },
      },
    },
  } satisfies Schema,
  adminDashboard: {
    type: 'object',
    required: [
      'generatedAt',
      'companies',
      'tenantUsers',
      'pendingInvitations',
      'currentlyStoredFiles',
      'currentCompanyBillingPeriods',
      'stripe',
    ],
    properties: {
      generatedAt: date,
      companies: {
        type: 'object',
        required: [
          'total',
          'activated',
          'pendingActivation',
          'suspended',
          'byPlan',
          'missingSubscriptions',
        ],
        properties: {
          total: { type: 'integer', minimum: 0 },
          activated: { type: 'integer', minimum: 0 },
          pendingActivation: { type: 'integer', minimum: 0 },
          suspended: { type: 'integer', minimum: 0 },
          byPlan: {
            type: 'object',
            required: Object.values(PlanCode),
            properties: Object.fromEntries(
              Object.values(PlanCode).map((code) => [
                code,
                { type: 'integer', minimum: 0 },
              ]),
            ),
          },
          missingSubscriptions: { type: 'integer', minimum: 0 },
        },
      },
      tenantUsers: {
        type: 'object',
        required: ['total', 'owners', 'members'],
        properties: {
          total: { type: 'integer', minimum: 0 },
          owners: { type: 'integer', minimum: 0 },
          members: { type: 'integer', minimum: 0 },
        },
      },
      pendingInvitations: { type: 'integer', minimum: 0 },
      currentlyStoredFiles: {
        type: 'object',
        required: ['total', 'companyWide', 'restricted'],
        properties: {
          total: { type: 'integer', minimum: 0 },
          companyWide: { type: 'integer', minimum: 0 },
          restricted: { type: 'integer', minimum: 0 },
        },
      },
      currentCompanyBillingPeriods: {
        type: 'object',
        required: [
          'successfulUploads',
          'recordedOverageCents',
          'trackedCompanyPeriods',
          'calculationBasis',
          'isCollectedRevenue',
        ],
        properties: {
          successfulUploads: { type: 'integer', minimum: 0 },
          recordedOverageCents: cents,
          trackedCompanyPeriods: { type: 'integer', minimum: 0 },
          calculationBasis: {
            type: 'string',
            enum: ['sum_of_current_activation_anchored_period_rows'],
          },
          isCollectedRevenue: { type: 'boolean', enum: [false] },
        },
      },
      stripe: {
        type: 'object',
        nullable: true,
        required: ['managedCompanies', 'paymentAttentionCompanies'],
        properties: {
          managedCompanies: { type: 'integer', minimum: 0 },
          paymentAttentionCompanies: { type: 'integer', minimum: 0 },
        },
      },
    },
  } satisfies Schema,
  adminCompanies: adminPaged(adminCompany),
  adminUsers: adminPaged(adminUser),
  adminFiles: adminPaged(adminFile),
  adminAudits: adminPaged(adminAudit),
  adminStatus: {
    type: 'object',
    required: ['companyId', 'platformStatus'],
    properties: {
      companyId: id,
      platformStatus: { type: 'string', enum: ['active', 'suspended'] },
    },
  } satisfies Schema,
  adminCompanyDetail: {
    type: 'object',
    required: [
      'company',
      'owner',
      'employees',
      'currentlyStoredFiles',
      'subscription',
      'billingEstimate',
      'stripe',
      'integrityWarnings',
    ],
    properties: {
      company: adminCompany,
      owner: adminOwner,
      employees: {
        type: 'object',
        required: ['accepted', 'pendingInvitations'],
        properties: {
          accepted: { type: 'integer', minimum: 0 },
          pendingInvitations: { type: 'integer', minimum: 0 },
        },
      },
      currentlyStoredFiles: {
        type: 'object',
        required: ['total', 'companyWide', 'restricted'],
        properties: {
          total: { type: 'integer', minimum: 0 },
          companyWide: { type: 'integer', minimum: 0 },
          restricted: { type: 'integer', minimum: 0 },
        },
      },
      subscription: {
        type: 'object',
        nullable: true,
        required: [
          'planCode',
          'activatedAt',
          'planChangedAt',
          'pendingPlanCode',
          'pendingPlanAt',
        ],
        properties: {
          planCode: { type: 'string', enum: Object.values(PlanCode) },
          activatedAt: date,
          planChangedAt: date,
          pendingPlanCode: {
            type: 'string',
            enum: Object.values(PlanCode),
            nullable: true,
          },
          pendingPlanAt: nullableDate,
        },
      },
      billingEstimate: { ...apiSchemas.billingSummary, nullable: true },
      stripe: {
        type: 'object',
        nullable: true,
        required: [
          'managed',
          'customerId',
          'subscriptionId',
          'status',
          'paymentAccess',
          'synchronizationIssue',
          'lastSyncedAt',
          'cancelAtPeriodEnd',
        ],
        properties: {
          managed: { type: 'boolean', enum: [true] },
          customerId: nullableString,
          subscriptionId: nullableString,
          status: nullableString,
          paymentAccess: {
            type: 'string',
            enum: Object.values(PaymentAccess),
          },
          synchronizationIssue: {
            type: 'string',
            enum: Object.values(PaymentSyncIssue),
          },
          lastSyncedAt: nullableDate,
          cancelAtPeriodEnd: { type: 'boolean' },
        },
      },
      integrityWarnings: { type: 'array', items: { type: 'string' } },
    },
  } satisfies Schema,
};

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('DataVault SaaS API')
    .setDescription(
      'DataVault multi-tenant backend API. Tenant JWTs authorize company users only; Platform Admin JWTs authorize the isolated /admin surface only. Stripe endpoints operate in Test Mode when configured. AI tools are read-only and are always authorized server-side for the authenticated tenant user.',
    )
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'JWT returned by POST /auth/sign-in for an activated tenant user.',
      },
      TENANT_JWT,
    )
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'JWT returned by POST /admin/auth/login. It cannot authorize tenant endpoints.',
      },
      PLATFORM_ADMIN_JWT,
    )
    .build();
  const document = SwaggerModule.createDocument(app, config);
  // These controllers bind empty DTOs to reject injected body/query fields.
  // Nest's scanner otherwise advertises a required JSON body for them.
  const emptyBodyDtos = new Set([
    'AdminEmptyDto',
    'BillingQueryDto',
    'EmptyPaymentDto',
    'StatisticsQueryDto',
  ]);
  for (const path of Object.values(document.paths)) {
    if (!path) continue;
    for (const operation of [
      path.get,
      path.post,
      path.put,
      path.patch,
      path.delete,
      path.options,
      path.head,
    ]) {
      if (!operation) continue;
      const body = operation.requestBody;
      if (!body || '$ref' in body) continue;
      const schema = body.content['application/json']?.schema;
      if (!schema || !('$ref' in schema)) continue;
      if (emptyBodyDtos.has(schema.$ref.split('/').at(-1) ?? ''))
        delete operation.requestBody;
    }
  }
  return document;
}

export function setupSwagger(app: INestApplication) {
  const adapter = app.getHttpAdapter().getInstance() as {
    use(path: string, middleware: ReturnType<typeof helmet>): void;
  };
  adapter.use(
    `/${SWAGGER_PATH}`,
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
        },
      },
    }),
  );
  const document = buildOpenApiDocument(app);
  SwaggerModule.setup(SWAGGER_PATH, app, document, {
    customSiteTitle: 'DataVault SaaS API',
    jsonDocumentUrl: `/${SWAGGER_PATH}/openapi.json`,
    swaggerOptions: {
      displayRequestDuration: true,
      persistAuthorization: false,
    },
  });
  return document;
}
