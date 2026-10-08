import { ClientSession, Connection, mongo, Types } from 'mongoose';
import { CompanyPlatformStatus } from '../companies/platform-status';
import { Role } from '../enums/roles.enum';
import { PaymentAccess, PaymentSyncIssue } from '../payments/payment.constants';
import { PlanCode } from '../plans/plan.constants';
import { CliFailure, CliFailureCategory } from './cli-errors';

export enum CleanupRefusalReason {
  PRODUCTION_ENVIRONMENT = 'development_or_test_required',
  MAINTENANCE_NOT_CONFIRMED = 'all_application_processes_must_be_stopped',
  COMPANY_NOT_FOUND = 'company_not_found',
  ACTIVATED = 'company_is_not_explicitly_unactivated',
  HISTORY = 'signup_records_have_changed_or_unknown_fields',
  PLATFORM_HISTORY = 'platform_status_or_audit_history',
  USERS = 'exactly_one_pristine_owner_required',
  SUBSCRIPTION = 'exactly_one_pristine_free_subscription_required',
  FILES = 'stored_file_or_uploader_references_exist',
  INVITATIONS = 'invitation_or_inviter_references_exist',
  PERIODS = 'billing_period_records_exist',
  STRIPE = 'stripe_history_or_usage_exists',
  AI_HISTORY = 'ai_conversation_or_usage_history_exists',
  VERIFICATION = 'verification_relationship_is_inconsistent',
}

export class CleanupRefusal extends CliFailure {
  constructor(public readonly reason: CleanupRefusalReason) {
    super(CliFailureCategory.CLEANUP_REFUSED);
  }
}

export interface CleanupOptions {
  companyId: string;
  environment: string | undefined;
  confirmDisposable: boolean;
  confirmApplicationStopped: boolean;
}
export function validateCleanupOptions(options: CleanupOptions) {
  if (!['development', 'test'].includes(options.environment ?? ''))
    refuse(CleanupRefusalReason.PRODUCTION_ENVIRONMENT);
  if (!/^[a-fA-F0-9]{24}$/.test(options.companyId))
    throw new CliFailure(CliFailureCategory.INVALID_CLEANUP_ARGUMENTS);
  if (options.confirmDisposable && !options.confirmApplicationStopped)
    refuse(CleanupRefusalReason.MAINTENANCE_NOT_CONFIRMED);
}
export type CleanupCollections = Record<
  | 'companies'
  | 'users'
  | 'subscriptions'
  | 'verifications'
  | 'files'
  | 'invitations'
  | 'periods'
  | 'stripeEvents'
  | 'stripeUsage'
  | 'aiConversations'
  | 'aiMessages'
  | 'aiUsage'
  | 'audits',
  mongo.Collection<StoredRecord>
>;
export type StoredRecord = Record<string, unknown> & { _id: Types.ObjectId };

const metadata = ['_id', '__v', 'createdAt', 'updatedAt'];
function knownFields(record: StoredRecord, fields: string[]) {
  return (
    Object.keys(record).every((key) =>
      [...metadata, ...fields].includes(key),
    ) &&
    (record.__v === undefined || record.__v === 0)
  );
}
function pristineTimestamps(record: StoredRecord) {
  return (
    record.createdAt instanceof Date &&
    record.updatedAt instanceof Date &&
    Number.isFinite(record.createdAt.getTime()) &&
    record.createdAt.getTime() === record.updatedAt.getTime()
  );
}
function sameId(value: unknown, expected: Types.ObjectId) {
  return value instanceof Types.ObjectId && value.equals(expected);
}
function refuse(reason: CleanupRefusalReason): never {
  throw new CleanupRefusal(reason);
}

/** CLI-only, fail-closed cleanup for the exact untouched signup shape. */
export class DisposableCompanyCleanup {
  constructor(
    private readonly connection: Connection,
    private readonly collections: CleanupCollections,
  ) {}

  async run(options: CleanupOptions) {
    validateCleanupOptions(options);
    const companyId = new Types.ObjectId(options.companyId);
    try {
      return await this.connection.transaction(
        async (session) => {
          const checked = await this.inspect(companyId, session);
          const counts = {
            companies: 1,
            ownerUsers: 1,
            freeSubscriptions: 1,
            verificationRecords: checked.verifications.length,
          };
          if (!options.confirmDisposable)
            return {
              companyId: companyId.toHexString(),
              mode: 'dry_run' as const,
              eligible: true,
              matched: counts,
              deleted: null,
            };

          // Exact IDs + relationship predicates; transaction write conflicts protect
          // activation/profile/subscription races. Offline maintenance additionally
          // prevents phantom dependent inserts by application workers or operators.
          const removedVerifications = checked.verifications.length
            ? await this.collections.verifications.deleteMany(
                {
                  _id: { $in: checked.verifications.map((v) => v._id) },
                  companyId,
                  ownerId: checked.owner._id,
                },
                { session },
              )
            : { deletedCount: 0 };
          const removedOwner = await this.collections.users.deleteOne(
            { _id: checked.owner._id, companyId, role: Role.COMPANY_OWNER },
            { session },
          );
          const removedSubscription =
            await this.collections.subscriptions.deleteOne(
              {
                _id: checked.subscription._id,
                companyId,
                planCode: PlanCode.FREE,
                revision: 0,
              },
              { session },
            );
          const removedCompany = await this.collections.companies.deleteOne(
            { _id: companyId, activatedAt: { $type: 'null' } },
            { session },
          );
          if (
            removedVerifications.deletedCount !== counts.verificationRecords ||
            removedOwner.deletedCount !== 1 ||
            removedSubscription.deletedCount !== 1 ||
            removedCompany.deletedCount !== 1
          )
            throw new CliFailure(CliFailureCategory.CLEANUP_COUNTS);
          return {
            companyId: companyId.toHexString(),
            mode: 'deleted' as const,
            eligible: true,
            matched: counts,
            deleted: counts,
          };
        },
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
          maxCommitTimeMS: 10000,
        },
      );
    } catch (error) {
      if (error instanceof CliFailure) throw error;
      throw new CliFailure(CliFailureCategory.MONGO_TRANSACTION);
    }
  }

  private async inspect(companyId: Types.ObjectId, session: ClientSession) {
    const c = this.collections;
    const company = await c.companies.findOne(
      { _id: companyId },
      { session, maxTimeMS: 5000 },
    );
    if (!company) refuse(CleanupRefusalReason.COMPANY_NOT_FOUND);
    if (company.activatedAt !== null) refuse(CleanupRefusalReason.ACTIVATED);
    if (
      (company.platformStatus !== undefined &&
        company.platformStatus !== CompanyPlatformStatus.ACTIVE) ||
      company.platformStatusReason !== undefined ||
      company.platformStatusChangedAt !== undefined ||
      company.platformStatusChangedBy !== undefined
    )
      refuse(CleanupRefusalReason.PLATFORM_HISTORY);
    if (
      !pristineTimestamps(company) ||
      !knownFields(company, [
        'name',
        'country',
        'industry',
        'activatedAt',
        'platformStatus',
      ])
    )
      refuse(CleanupRefusalReason.HISTORY);

    // Native queries deliberately also detect malformed historical string refs.
    // Such records are never silently omitted by Mongoose ObjectId casting.
    const companyStringRef = new RegExp(`^${companyId.toHexString()}$`, 'i');
    const tenant = { companyId: { $in: [companyId, companyStringRef] } };
    const users = await c.users
      .find(tenant, { session, maxTimeMS: 5000, projection: { password: 0 } })
      .toArray();
    if (
      users.length !== 1 ||
      users[0].role !== Role.COMPANY_OWNER ||
      !sameId(users[0].companyId, companyId) ||
      !pristineTimestamps(users[0]) ||
      !knownFields(users[0], ['companyId', 'role', 'fullName', 'email'])
    )
      refuse(CleanupRefusalReason.USERS);
    const owner = users[0];
    if (!(owner._id instanceof Types.ObjectId))
      refuse(CleanupRefusalReason.USERS);
    const ownerStringRef = new RegExp(`^${owner._id.toHexString()}$`, 'i');
    const ownerRefs = { $in: [owner._id, ownerStringRef] };
    const subscriptions = await c.subscriptions
      .find(tenant, { session, maxTimeMS: 5000 })
      .toArray();
    if (subscriptions.length !== 1) refuse(CleanupRefusalReason.SUBSCRIPTION);
    const subscription = subscriptions[0];
    if (
      !(subscription._id instanceof Types.ObjectId) ||
      !sameId(subscription.companyId, companyId) ||
      subscription.planCode !== PlanCode.FREE ||
      subscription.revision !== 0 ||
      (subscription.stripeManaged !== undefined &&
        subscription.stripeManaged !== false) ||
      (subscription.paymentAccess !== undefined &&
        subscription.paymentAccess !== PaymentAccess.UNMANAGED) ||
      (subscription.paymentSyncIssue !== undefined &&
        subscription.paymentSyncIssue !== PaymentSyncIssue.NONE) ||
      (subscription.stripeCancelAtPeriodEnd !== undefined &&
        subscription.stripeCancelAtPeriodEnd !== false) ||
      (subscription.stripePlanConfirmed !== undefined &&
        subscription.stripePlanConfirmed !== false) ||
      !(subscription.activatedAt instanceof Date) ||
      !(subscription.planChangedAt instanceof Date) ||
      subscription.activatedAt.getTime() !==
        subscription.planChangedAt.getTime() ||
      !pristineTimestamps(subscription) ||
      !knownFields(subscription, [
        'companyId',
        'planCode',
        'activatedAt',
        'planChangedAt',
        'revision',
        'stripeManaged',
        'paymentAccess',
        'paymentSyncIssue',
        'stripeCancelAtPeriodEnd',
        'stripePlanConfirmed',
      ])
    )
      refuse(CleanupRefusalReason.SUBSCRIPTION);

    if (
      await c.files.countDocuments(
        { $or: [tenant, { uploaderId: ownerRefs }] },
        { session, maxTimeMS: 5000 },
      )
    )
      refuse(CleanupRefusalReason.FILES);
    if (
      await c.invitations.countDocuments(
        { $or: [tenant, { invitedBy: ownerRefs }] },
        { session, maxTimeMS: 5000 },
      )
    )
      refuse(CleanupRefusalReason.INVITATIONS);
    if (await c.periods.countDocuments(tenant, { session, maxTimeMS: 5000 }))
      refuse(CleanupRefusalReason.PERIODS);
    if (
      (await c.stripeEvents.countDocuments(tenant, {
        session,
        maxTimeMS: 5000,
      })) ||
      (await c.stripeUsage.countDocuments(tenant, { session, maxTimeMS: 5000 }))
    )
      refuse(CleanupRefusalReason.STRIPE);
    const aiReferences = {
      $or: [tenant, { userId: ownerRefs }],
    };
    if (
      (await c.aiConversations.countDocuments(aiReferences, {
        session,
        maxTimeMS: 5000,
      })) ||
      (await c.aiMessages.countDocuments(aiReferences, {
        session,
        maxTimeMS: 5000,
      })) ||
      (await c.aiUsage.countDocuments(aiReferences, {
        session,
        maxTimeMS: 5000,
      }))
    )
      refuse(CleanupRefusalReason.AI_HISTORY);
    if (
      await c.audits.countDocuments(
        {
          $or: [
            {
              targetId: {
                $in: [companyId, companyStringRef, owner._id, ownerStringRef],
              },
            },
            { actorId: ownerRefs },
          ],
        },
        { session, maxTimeMS: 5000 },
      )
    )
      refuse(CleanupRefusalReason.PLATFORM_HISTORY);
    const verifications = await c.verifications
      .find(
        { $or: [tenant, { ownerId: ownerRefs }] },
        { session, maxTimeMS: 5000, projection: { tokenHash: 0 } },
      )
      .toArray();
    if (
      verifications.length > 1 ||
      verifications.some(
        (v) =>
          !(v._id instanceof Types.ObjectId) ||
          !sameId(v.companyId, companyId) ||
          !sameId(v.ownerId, owner._id) ||
          !knownFields(v, ['companyId', 'ownerId', 'expiresAt', 'lastSentAt']),
      )
    )
      refuse(CleanupRefusalReason.VERIFICATION);
    return { owner, subscription, verifications };
  }
}

export function cleanupArguments(
  args: string[],
  environment: string | undefined,
): CleanupOptions {
  let companyId: string | undefined;
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (flags.has(arg))
      throw new CliFailure(CliFailureCategory.INVALID_CLEANUP_ARGUMENTS);
    flags.add(arg);
    if (arg === '--company-id') companyId = args[++i];
    else if (!['--confirm-disposable', '--confirm-app-stopped'].includes(arg))
      throw new CliFailure(CliFailureCategory.INVALID_CLEANUP_ARGUMENTS);
  }
  if (
    !companyId ||
    !/^[a-fA-F0-9]{24}$/.test(companyId) ||
    (flags.has('--confirm-app-stopped') && !flags.has('--confirm-disposable'))
  )
    throw new CliFailure(CliFailureCategory.INVALID_CLEANUP_ARGUMENTS);
  return {
    companyId,
    environment,
    confirmDisposable: flags.has('--confirm-disposable'),
    confirmApplicationStopped: flags.has('--confirm-app-stopped'),
  };
}
