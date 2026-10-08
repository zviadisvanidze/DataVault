import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Connection, createConnection, Schema } from 'mongoose';
import { companySchema } from '../companies/entities/company.entity';
import { userSchema } from '../users/entities/user.entity';
import { subscriptionSchema } from '../subscriptions/entities/subscription.entity';
import { companyVerificationSchema } from '../auth/entities/company-verification.entity';
import { companyFileSchema } from '../files/entities/company-file.entity';
import { employeeInvitationSchema } from '../invitations/entities/employee-invitation.entity';
import { subscriptionPeriodSchema } from '../subscriptions/entities/subscription-period.entity';
import { stripeEventSchema } from '../payments/entities/stripe-event.entity';
import { stripeUsageSchema } from '../payments/entities/stripe-usage.entity';
import { adminAuditSchema } from '../admin/entities/admin-audit.entity';
import { aiConversationSchema } from '../ai/entities/ai-conversation.entity';
import { aiMessageSchema } from '../ai/entities/ai-message.entity';
import { aiUsageSchema } from '../ai/entities/ai-usage.entity';
import { CliFailure, CliFailureCategory, safeCliCategory } from './cli-errors';
import {
  CleanupCollections,
  CleanupRefusal,
  cleanupArguments,
  DisposableCompanyCleanup,
  validateCleanupOptions,
  StoredRecord,
} from './cleanup-disposable-company.service';

@Module({ imports: [ConfigModule.forRoot({ isGlobal: true })] })
class CleanupConfigurationModule {}

function collections(connection: Connection): CleanupCollections {
  const definitions: [keyof CleanupCollections, string, Schema][] = [
    ['companies', 'company', companySchema],
    ['users', 'user', userSchema],
    ['subscriptions', 'subscription', subscriptionSchema],
    ['verifications', 'companyVerification', companyVerificationSchema],
    ['files', 'companyFile', companyFileSchema],
    ['invitations', 'employeeInvitation', employeeInvitationSchema],
    ['periods', 'subscriptionPeriod', subscriptionPeriodSchema],
    ['stripeEvents', 'stripeEvent', stripeEventSchema],
    ['stripeUsage', 'stripeUsage', stripeUsageSchema],
    ['aiConversations', 'aiConversation', aiConversationSchema],
    ['aiMessages', 'aiMessage', aiMessageSchema],
    ['aiUsage', 'aiUsage', aiUsageSchema],
    ['audits', 'adminAudit', adminAuditSchema],
  ];
  if (!connection.db) throw new CliFailure(CliFailureCategory.MONGO_CONNECTION);
  const result = {} as CleanupCollections;
  for (const [key, name, original] of definitions) {
    // Reuse authoritative collection names, without creating collections/indexes.
    const schema = original.clone();
    schema.set('autoCreate', false);
    schema.set('autoIndex', false);
    result[key] = connection.db.collection<StoredRecord>(
      connection.model(name, schema).collection.name,
    );
  }
  return result;
}

async function main() {
  let connection: Connection | undefined;
  let app:
    | Awaited<ReturnType<typeof NestFactory.createApplicationContext>>
    | undefined;
  let phase = CliFailureCategory.INVALID_CLEANUP_ARGUMENTS;
  try {
    app = await NestFactory.createApplicationContext(
      CleanupConfigurationModule,
      { logger: false, abortOnError: false },
    );
    const config = app.get(ConfigService);
    const options = cleanupArguments(
      process.argv.slice(2),
      config.get<string>('NODE_ENV'),
    );
    // Fail before connecting when a mutation is not explicitly authorized.
    validateCleanupOptions(options);
    const uri = config.get<string>('MONGO_URI');
    if (!uri || !/^mongodb(?:\+srv)?:\/\//.test(uri))
      throw new CliFailure(CliFailureCategory.INVALID_CLEANUP_ARGUMENTS);
    phase = CliFailureCategory.MONGO_CONNECTION;
    connection = createConnection(uri, {
      serverSelectionTimeoutMS: 10000,
      maxPoolSize: 2,
      autoIndex: false,
      autoCreate: false,
    });
    await connection.asPromise();
    phase = CliFailureCategory.MONGO_TRANSACTION;
    const hello = await connection.db!.admin().command({ hello: 1 });
    if (
      !hello.logicalSessionTimeoutMinutes ||
      (!hello.setName && hello.msg !== 'isdbgrid')
    )
      throw new CliFailure(CliFailureCategory.MONGO_TRANSACTION);
    const report = await new DisposableCompanyCleanup(
      connection,
      collections(connection),
    ).run(options);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    const reason = error instanceof CleanupRefusal ? ` (${error.reason})` : '';
    process.stderr.write(
      `Disposable company cleanup failed: ${safeCliCategory(error, phase)}${reason}.\n`,
    );
    process.exitCode = 1;
  } finally {
    try {
      await connection?.close();
      await app?.close();
    } catch {
      process.stderr.write(
        `Disposable company cleanup failed: ${CliFailureCategory.CLOSE}.\n`,
      );
      process.exitCode = 1;
    }
  }
}

void main();
