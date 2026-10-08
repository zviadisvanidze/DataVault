import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, PipelineStage, Types } from 'mongoose';
import { Company } from '../companies/entities/company.entity';
import {
  CompanyPlatformReason,
  CompanyPlatformStatus,
} from '../companies/platform-status';
import { Role } from '../enums/roles.enum';
import {
  CompanyFile,
  CompanyFileVisibility,
} from '../files/entities/company-file.entity';
import {
  EmployeeInvitation,
  InvitationStatus,
} from '../invitations/entities/employee-invitation.entity';
import { PaymentAccess, PaymentSyncIssue } from '../payments/payment.constants';
import { PlanCode } from '../plans/plan.constants';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { SubscriptionPeriod } from '../subscriptions/entities/subscription-period.entity';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { User } from '../users/entities/user.entity';
import { AdminAudit, AdminAuditAction } from './entities/admin-audit.entity';
import {
  AdminAuditQueryDto,
  AdminCompanyQueryDto,
  AdminFileQueryDto,
  AdminPaginationDto,
  AdminUserQueryDto,
} from './dto/admin.dto';
import { PlatformAdminActor } from './platform-admin.guard';

const companyProjection = {
  _id: 0,
  id: '$_id',
  name: 1,
  country: 1,
  industry: 1,
  activatedAt: 1,
  createdAt: 1,
  updatedAt: 1,
  platformStatus: {
    $ifNull: ['$platformStatus', CompanyPlatformStatus.ACTIVE],
  },
  platformStatusReason: 1,
  platformStatusChangedAt: 1,
  platformStatusChangedBy: 1,
};
const userProjection = {
  _id: 0,
  id: '$_id',
  companyId: 1,
  fullName: 1,
  email: 1,
  role: 1,
  createdAt: 1,
};
const fileProjection = {
  _id: 0,
  id: '$_id',
  companyId: 1,
  uploaderId: 1,
  originalFilename: 1,
  fileType: 1,
  mimeType: 1,
  size: 1,
  createdAt: 1,
  updatedAt: 1,
  visibility: { $ifNull: ['$visibility', CompanyFileVisibility.COMPANY_WIDE] },
  restrictedUserIds: 1,
};
const auditProjection = {
  _id: 0,
  id: '$_id',
  action: 1,
  actorId: 1,
  targetId: 1,
  targetType: 1,
  reason: 1,
  previousStatus: 1,
  nextStatus: 1,
  createdAt: 1,
};

@Injectable()
export class AdminService {
  constructor(
    @InjectModel('company') private readonly companies: Model<Company>,
    @InjectModel('user') private readonly users: Model<User>,
    @InjectModel('subscription')
    private readonly subscriptions: Model<Subscription>,
    @InjectModel('subscriptionPeriod')
    private readonly periods: Model<SubscriptionPeriod>,
    @InjectModel('employeeInvitation')
    private readonly invitations: Model<EmployeeInvitation>,
    @InjectModel('companyFile') private readonly files: Model<CompanyFile>,
    @InjectModel('adminAudit') private readonly audits: Model<AdminAudit>,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly config: ConfigService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  private subscriptionLookup(): PipelineStage[] {
    return [
      {
        $lookup: {
          from: this.subscriptions.collection.name,
          localField: '_id',
          foreignField: 'companyId',
          pipeline: [
            {
              $project: {
                _id: 0,
                planCode: 1,
                stripeManaged: 1,
                paymentAccess: 1,
                stripeStatus: 1,
                paymentSyncIssue: 1,
                stripeSyncedAt: 1,
                pendingPlanCode: 1,
                pendingPlanAt: 1,
              },
            },
          ],
          as: 'subscription',
        },
      },
      { $unwind: { path: '$subscription', preserveNullAndEmptyArrays: true } },
    ];
  }

  private async page<T>(
    model: Model<T>,
    query: AdminPaginationDto,
    pipeline: PipelineStage[],
    projection: Record<string, unknown>,
    sortBy: string,
    allowedSorts: readonly string[],
  ) {
    if (
      !Number.isInteger(query.page) ||
      query.page < 1 ||
      query.page > 1000 ||
      !Number.isInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 100 ||
      !allowedSorts.includes(sortBy) ||
      !['asc', 'desc'].includes(query.order)
    )
      throw new BadRequestException('Invalid admin pagination or sorting');
    const direction = query.order === 'asc' ? 1 : -1;
    const [result] = await model
      .aggregate<{ items: unknown[]; total: { count: number }[] }>([
        ...pipeline,
        { $sort: { [sortBy]: direction, _id: direction } },
        {
          $facet: {
            items: [
              { $skip: (query.page - 1) * query.limit },
              { $limit: query.limit },
              { $project: projection },
            ],
            total: [{ $count: 'count' }],
          },
        },
      ])
      .option({ maxTimeMS: 5000 });
    return {
      items: result?.items ?? [],
      pagination: {
        page: query.page,
        limit: query.limit,
        total: result?.total[0]?.count ?? 0,
      },
    };
  }

  private search(value: string) {
    if (!value.length || value.length > 80)
      throw new BadRequestException('Invalid search');
    return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }

  async dashboard(now = new Date()) {
    const [companyRows, userRows, fileRows, usageRows, pendingInvitations] =
      await Promise.all([
        this.companies
          .aggregate<{
            counts: {
              total: number;
              activated: number;
              suspended: number;
              missingSubscriptions: number;
              stripeManaged: number;
              paymentAttention: number;
            }[];
            plans: { _id: PlanCode | null; count: number }[];
          }>([
            ...this.subscriptionLookup(),
            {
              $facet: {
                counts: [
                  {
                    $group: {
                      _id: null,
                      total: { $sum: 1 },
                      activated: {
                        $sum: {
                          $cond: [
                            {
                              $ne: [{ $ifNull: ['$activatedAt', null] }, null],
                            },
                            1,
                            0,
                          ],
                        },
                      },
                      suspended: {
                        $sum: {
                          $cond: [
                            {
                              $eq: [
                                '$platformStatus',
                                CompanyPlatformStatus.SUSPENDED,
                              ],
                            },
                            1,
                            0,
                          ],
                        },
                      },
                      missingSubscriptions: {
                        $sum: {
                          $cond: [
                            {
                              $eq: [
                                { $ifNull: ['$subscription.planCode', null] },
                                null,
                              ],
                            },
                            1,
                            0,
                          ],
                        },
                      },
                      stripeManaged: {
                        $sum: { $cond: ['$subscription.stripeManaged', 1, 0] },
                      },
                      paymentAttention: {
                        $sum: {
                          $cond: [
                            {
                              $and: [
                                '$subscription.stripeManaged',
                                {
                                  $or: [
                                    {
                                      $eq: [
                                        '$subscription.paymentAccess',
                                        PaymentAccess.SUSPENDED,
                                      ],
                                    },
                                    {
                                      $ne: [
                                        {
                                          $ifNull: [
                                            '$subscription.paymentSyncIssue',
                                            PaymentSyncIssue.NONE,
                                          ],
                                        },
                                        PaymentSyncIssue.NONE,
                                      ],
                                    },
                                    {
                                      $lt: [
                                        {
                                          $ifNull: [
                                            '$subscription.stripeSyncedAt',
                                            new Date(0),
                                          ],
                                        },
                                        new Date(now.getTime() - 86400000),
                                      ],
                                    },
                                  ],
                                },
                              ],
                            },
                            1,
                            0,
                          ],
                        },
                      },
                    },
                  },
                ],
                plans: [
                  {
                    $group: {
                      _id: { $ifNull: ['$subscription.planCode', null] },
                      count: { $sum: 1 },
                    },
                  },
                ],
              },
            },
          ])
          .option({ maxTimeMS: 10000 }),
        this.users
          .aggregate<{ _id: Role; count: number }>([
            { $group: { _id: '$role', count: { $sum: 1 } } },
          ])
          .option({ maxTimeMS: 10000 }),
        this.files
          .aggregate<{ _id: CompanyFileVisibility; count: number }>([
            {
              $group: {
                _id: {
                  $ifNull: ['$visibility', CompanyFileVisibility.COMPANY_WIDE],
                },
                count: { $sum: 1 },
              },
            },
          ])
          .option({ maxTimeMS: 10000 }),
        this.periods
          .aggregate<{
            successfulUploads: number;
            recordedOverageCents: number;
            trackedCompanyPeriods: number;
          }>([
            { $match: { startsAt: { $lte: now }, endsAt: { $gt: now } } },
            {
              $group: {
                _id: null,
                successfulUploads: { $sum: '$uploadedFiles' },
                recordedOverageCents: { $sum: '$fileOverageCents' },
                trackedCompanyPeriods: { $sum: 1 },
              },
            },
          ])
          .option({ maxTimeMS: 10000 }),
        this.invitations.countDocuments({
          status: InvitationStatus.PENDING,
          expiresAt: { $gt: now },
        }),
      ]);
    const counts = companyRows[0]?.counts[0];
    const byPlan = Object.fromEntries(
      Object.values(PlanCode).map((code) => [
        code,
        companyRows[0]?.plans.find((row) => row._id === code)?.count ?? 0,
      ]),
    );
    return {
      generatedAt: now,
      companies: {
        total: counts?.total ?? 0,
        activated: counts?.activated ?? 0,
        pendingActivation: (counts?.total ?? 0) - (counts?.activated ?? 0),
        suspended: counts?.suspended ?? 0,
        byPlan,
        missingSubscriptions: counts?.missingSubscriptions ?? 0,
      },
      tenantUsers: {
        total: userRows.reduce((sum, row) => sum + row.count, 0),
        owners:
          userRows.find((row) => row._id === Role.COMPANY_OWNER)?.count ?? 0,
        members:
          userRows.find((row) => row._id === Role.COMPANY_MEMBER)?.count ?? 0,
      },
      pendingInvitations,
      currentlyStoredFiles: {
        total: fileRows.reduce((sum, row) => sum + row.count, 0),
        companyWide:
          fileRows.find((row) => row._id === CompanyFileVisibility.COMPANY_WIDE)
            ?.count ?? 0,
        restricted:
          fileRows.find((row) => row._id === CompanyFileVisibility.RESTRICTED)
            ?.count ?? 0,
      },
      currentCompanyBillingPeriods: {
        successfulUploads: usageRows[0]?.successfulUploads ?? 0,
        recordedOverageCents: usageRows[0]?.recordedOverageCents ?? 0,
        trackedCompanyPeriods: usageRows[0]?.trackedCompanyPeriods ?? 0,
        calculationBasis: 'sum_of_current_activation_anchored_period_rows',
        isCollectedRevenue: false,
      },
      stripe:
        this.config.get<boolean>('STRIPE_ENABLED') === true
          ? {
              managedCompanies: counts?.stripeManaged ?? 0,
              paymentAttentionCompanies: counts?.paymentAttention ?? 0,
            }
          : null,
    };
  }

  listCompanies(query: AdminCompanyQueryDto) {
    const match: Record<string, unknown> = {};
    if (query.search) match.name = this.search(query.search);
    if (query.activation)
      match.activatedAt =
        query.activation === 'activated' ? { $ne: null } : null;
    if (query.status === CompanyPlatformStatus.SUSPENDED)
      match.platformStatus = query.status;
    if (query.status === CompanyPlatformStatus.ACTIVE)
      match.$or = [
        { platformStatus: query.status },
        { platformStatus: { $exists: false } },
      ];
    const subscriptionMatch: Record<string, unknown> = {};
    if (query.plan) subscriptionMatch['subscription.planCode'] = query.plan;
    if (query.paymentAccess)
      subscriptionMatch.$expr = {
        $eq: [
          { $ifNull: ['$subscription.paymentAccess', PaymentAccess.UNMANAGED] },
          query.paymentAccess,
        ],
      };
    if (query.stripeManaged)
      subscriptionMatch['subscription.stripeManaged'] =
        query.stripeManaged === 'true' ? true : { $ne: true };
    return this.page(
      this.companies,
      query,
      [
        { $match: match },
        ...this.subscriptionLookup(),
        { $match: subscriptionMatch },
      ],
      { ...companyProjection, subscription: 1 },
      query.sortBy,
      ['createdAt', 'name', 'updatedAt'],
    );
  }

  async companyDetail(id: string, now = new Date()) {
    const companyId = new Types.ObjectId(id);
    const company = await this.companies
      .findById(companyId)
      .select(
        'name country industry activatedAt platformStatus createdAt updatedAt +platformStatusReason +platformStatusChangedAt +platformStatusChangedBy',
      )
      .lean();
    if (!company) throw new NotFoundException('Company not found');
    const [
      owner,
      employees,
      pendingInvitations,
      files,
      companyWide,
      restricted,
      subscription,
    ] = await Promise.all([
      this.users
        .findOne({ companyId, role: Role.COMPANY_OWNER })
        .select('email fullName createdAt')
        .lean(),
      this.users.countDocuments({ companyId, role: Role.COMPANY_MEMBER }),
      this.invitations.countDocuments({
        companyId,
        status: InvitationStatus.PENDING,
        expiresAt: { $gt: now },
      }),
      this.files.countDocuments({ companyId }),
      this.files.countDocuments({
        companyId,
        $or: [
          { visibility: CompanyFileVisibility.COMPANY_WIDE },
          { visibility: { $exists: false } },
        ],
      }),
      this.files.countDocuments({
        companyId,
        visibility: CompanyFileVisibility.RESTRICTED,
      }),
      this.subscriptions
        .findOne({ companyId })
        .select(
          'planCode activatedAt planChangedAt stripeManaged stripeCustomerId stripeSubscriptionId stripeStatus paymentAccess paymentSyncIssue stripeSyncedAt stripeCancelAtPeriodEnd pendingPlanCode pendingPlanAt',
        )
        .lean(),
    ]);
    const current = subscription
      ? await this.subscriptionsService.getCurrent(id, now)
      : null;
    return {
      company: {
        id: company._id,
        name: company.name,
        country: company.country,
        industry: company.industry,
        activatedAt: company.activatedAt,
        createdAt: company.createdAt,
        updatedAt: company.updatedAt,
        platformStatus: company.platformStatus ?? CompanyPlatformStatus.ACTIVE,
        platformStatusReason: company.platformStatusReason ?? null,
        platformStatusChangedAt: company.platformStatusChangedAt ?? null,
        platformStatusChangedBy: company.platformStatusChangedBy ?? null,
      },
      owner: owner
        ? {
            id: owner._id,
            email: owner.email,
            fullName: owner.fullName,
            createdAt: owner.createdAt,
          }
        : null,
      employees: { accepted: employees, pendingInvitations },
      currentlyStoredFiles: { total: files, companyWide, restricted },
      subscription: subscription
        ? {
            planCode: subscription.planCode,
            activatedAt: subscription.activatedAt,
            planChangedAt: subscription.planChangedAt,
            pendingPlanCode: subscription.pendingPlanCode ?? null,
            pendingPlanAt: subscription.pendingPlanAt ?? null,
          }
        : null,
      billingEstimate: current?.billingSummary ?? null,
      stripe: subscription?.stripeManaged
        ? {
            managed: true,
            customerId: subscription.stripeCustomerId,
            subscriptionId: subscription.stripeSubscriptionId,
            status: subscription.stripeStatus,
            paymentAccess: subscription.paymentAccess,
            synchronizationIssue: subscription.paymentSyncIssue,
            lastSyncedAt: subscription.stripeSyncedAt,
            cancelAtPeriodEnd: subscription.stripeCancelAtPeriodEnd,
          }
        : null,
      integrityWarnings: [
        ...(!owner ? ['missing_owner'] : []),
        ...(!subscription ? ['missing_subscription'] : []),
      ],
    };
  }

  listUsers(query: AdminUserQueryDto) {
    const match: Record<string, unknown> = {};
    if (query.companyId) match.companyId = new Types.ObjectId(query.companyId);
    if (query.role) match.role = query.role;
    if (query.search)
      match.$or = [
        { email: this.search(query.search) },
        { fullName: this.search(query.search) },
      ];
    return this.page(
      this.users,
      query,
      [{ $match: match }],
      userProjection,
      query.sortBy,
      ['createdAt', 'email', 'fullName'],
    );
  }

  listFiles(query: AdminFileQueryDto) {
    const match: Record<string, unknown> = {};
    if (query.companyId) match.companyId = new Types.ObjectId(query.companyId);
    if (query.search) match.originalFilename = this.search(query.search);
    if (query.fileType) match.fileType = query.fileType;
    if (query.visibility === CompanyFileVisibility.RESTRICTED)
      match.visibility = query.visibility;
    if (query.visibility === CompanyFileVisibility.COMPANY_WIDE)
      match.$or = [
        { visibility: query.visibility },
        { visibility: { $exists: false } },
      ];
    return this.page(
      this.files,
      query,
      [{ $match: match }],
      fileProjection,
      query.sortBy,
      ['createdAt', 'originalFilename', 'size'],
    );
  }

  listAudit(query: AdminAuditQueryDto) {
    const match: Record<string, unknown> = {};
    if (query.action) match.action = query.action;
    if (query.actorId) match.actorId = new Types.ObjectId(query.actorId);
    if (query.targetId) match.targetId = new Types.ObjectId(query.targetId);
    return this.page(
      this.audits,
      query,
      [{ $match: match }],
      auditProjection,
      'createdAt',
      ['createdAt'],
    );
  }

  async changeCompanyStatus(
    actor: PlatformAdminActor,
    id: string,
    nextStatus: CompanyPlatformStatus,
    reason: CompanyPlatformReason,
  ) {
    const companyId = new Types.ObjectId(id);
    await this.connection.transaction(
      async (session) => {
        const company = await this.companies
          .findById(companyId)
          .session(session);
        if (!company) throw new NotFoundException('Company not found');
        const previousStatus =
          company.platformStatus ?? CompanyPlatformStatus.ACTIVE;
        if (previousStatus === nextStatus)
          throw new ConflictException(
            'Company already has the requested platform status',
          );
        const changed = await this.companies.findOneAndUpdate(
          {
            _id: companyId,
            platformStatus:
              nextStatus === CompanyPlatformStatus.SUSPENDED
                ? { $ne: nextStatus }
                : CompanyPlatformStatus.SUSPENDED,
          },
          {
            $set: {
              platformStatus: nextStatus,
              platformStatusReason: reason,
              platformStatusChangedAt: new Date(),
              platformStatusChangedBy: new Types.ObjectId(actor.id),
            },
          },
          { new: true, runValidators: true, session },
        );
        if (!changed)
          throw new ConflictException(
            'Company platform status changed concurrently',
          );
        await this.audits.create(
          [
            {
              action:
                nextStatus === CompanyPlatformStatus.SUSPENDED
                  ? AdminAuditAction.COMPANY_SUSPENDED
                  : AdminAuditAction.COMPANY_REACTIVATED,
              actorId: actor.id,
              targetId: companyId,
              targetType: 'company',
              reason,
              previousStatus,
              nextStatus,
            },
          ],
          { session },
        );
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
    );
    return { companyId: id, platformStatus: nextStatus };
  }
}
