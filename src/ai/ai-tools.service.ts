import { Injectable } from '@nestjs/common';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { CompaniesService } from '../companies/companies.service';
import { FilesService } from '../files/files.service';
import { StatisticsService } from '../statistics/statistics.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';

export enum AiToolName {
  COMPANY_PROFILE = 'get_company_profile',
  SUBSCRIPTION_BILLING = 'get_subscription_and_billing',
  COMPANY_STATISTICS = 'get_company_statistics',
  VISIBLE_FILES = 'list_visible_files',
}

export class AiToolFailure extends Error {}

const noArguments = {
  type: 'object',
  properties: {},
  additionalProperties: false,
  required: [],
} as const;

@Injectable()
export class AiToolsService {
  readonly definitions: ChatCompletionTool[] = [
    {
      type: 'function',
      function: {
        name: AiToolName.COMPANY_PROFILE,
        description:
          'Read the authenticated user company profile. Use for authoritative questions about the current DataVault company.',
        strict: true,
        parameters: noArguments,
      },
    },
    {
      type: 'function',
      function: {
        name: AiToolName.SUBSCRIPTION_BILLING,
        description:
          'Read the authenticated company current plan, entitlements, billing period, employee count, upload usage, overage, and internal billing estimate.',
        strict: true,
        parameters: noArguments,
      },
    },
    {
      type: 'function',
      function: {
        name: AiToolName.COMPANY_STATISTICS,
        description:
          'Read the authenticated company dashboard statistics, including employees, pending invitations, stored files, current-period uploads, and billing estimate.',
        strict: true,
        parameters: noArguments,
      },
    },
    {
      type: 'function',
      function: {
        name: AiToolName.VISIBLE_FILES,
        description:
          'List recent file metadata that the authenticated user is currently authorized to see. File contents and storage details are never available.',
        strict: true,
        parameters: {
          type: 'object',
          properties: {
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 10,
              description: 'Number of recent visible files to return.',
            },
          },
          additionalProperties: false,
          required: [],
        },
      },
    },
  ];

  constructor(
    private readonly companies: CompaniesService,
    private readonly subscriptions: SubscriptionsService,
    private readonly statistics: StatisticsService,
    private readonly files: FilesService,
  ) {}

  async execute(actor: AuthenticatedUser, name: string, rawArguments: string) {
    const args = this.arguments(rawArguments);
    if (!Object.values(AiToolName).includes(name as AiToolName))
      throw new AiToolFailure();
    const toolName = name as AiToolName;
    switch (toolName) {
      case AiToolName.COMPANY_PROFILE: {
        this.noArguments(args);
        const company = await this.companies.findCurrent(actor.companyId);
        return {
          name: company.name,
          country: company.country,
          industry: company.industry,
          activatedAt: company.activatedAt,
          requestingUserRole: actor.role,
        };
      }
      case AiToolName.SUBSCRIPTION_BILLING: {
        this.noArguments(args);
        const current = await this.subscriptions.getCurrent(actor.companyId);
        return {
          plan: current.plan,
          activatedAt: current.activatedAt,
          planChangedAt: current.planChangedAt,
          billingPeriod: current.billingPeriod,
          acceptedEmployeeCount: current.employeeCount,
          billingEstimate: current.billingSummary,
        };
      }
      case AiToolName.COMPANY_STATISTICS: {
        this.noArguments(args);
        const value = await this.statistics.getCurrent(actor.companyId);
        const safe = { ...value } as Record<string, unknown>;
        delete safe.companyId;
        return safe;
      }
      case AiToolName.VISIBLE_FILES: {
        if (
          Object.keys(args).some((key) => key !== 'limit') ||
          (args.limit !== undefined &&
            (!Number.isInteger(args.limit) ||
              Number(args.limit) < 1 ||
              Number(args.limit) > 10))
        )
          throw new AiToolFailure();
        const result = await this.files.findAll(actor, {
          page: 1,
          take: args.limit === undefined ? 5 : Number(args.limit),
        });
        return {
          files: result.files.map((file) => ({
            originalFilename: file.originalFilename,
            fileType: file.fileType,
            mimeType: file.mimeType,
            size: file.size,
            visibility: file.visibility,
            createdAt: file.createdAt,
            updatedAt: file.updatedAt,
          })),
          returned: result.files.length,
          totalVisibleFiles: result.total,
        };
      }
    }
  }

  fingerprint(name: string, rawArguments: string) {
    const args = this.arguments(rawArguments);
    return `${name}:${JSON.stringify(
      Object.fromEntries(
        Object.entries(args).sort(([a], [b]) => a.localeCompare(b)),
      ),
    )}`;
  }

  private arguments(raw: string): Record<string, unknown> {
    if (typeof raw !== 'string' || raw.length > 1_024)
      throw new AiToolFailure();
    try {
      const value = JSON.parse(raw || '{}') as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error();
      return value as Record<string, unknown>;
    } catch {
      throw new AiToolFailure();
    }
  }

  private noArguments(args: Record<string, unknown>) {
    if (Object.keys(args).length) throw new AiToolFailure();
  }
}
