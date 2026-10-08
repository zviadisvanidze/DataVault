import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Connection, createConnection, Schema } from 'mongoose';
import { companySchema } from '../companies/entities/company.entity';
import { stripeEventSchema } from '../payments/entities/stripe-event.entity';
import { stripeUsageSchema } from '../payments/entities/stripe-usage.entity';
import { userSchema } from '../users/entities/user.entity';
import { employeeInvitationSchema } from '../invitations/entities/employee-invitation.entity';
import { subscriptionPeriodSchema } from '../subscriptions/entities/subscription-period.entity';
import { subscriptionSchema } from '../subscriptions/entities/subscription.entity';
import { CliFailure, CliFailureCategory, safeCliCategory } from './cli-errors';
import {
  StripeResetCollections,
  StripeResetRecord,
  StripeResetRefusal,
  StripeTestStateReset,
  assertStripeTestKeyForExecution,
  stripeResetArguments,
} from './reset-stripe-test.service';

@Module({ imports: [ConfigModule.forRoot({ isGlobal: true })] })
class StripeResetConfigurationModule {}

function collections(connection: Connection): StripeResetCollections {
  if (!connection.db) throw new CliFailure(CliFailureCategory.MONGO_CONNECTION);
  const definitions: [keyof StripeResetCollections, string, Schema][] = [
    ['companies', 'company', companySchema],
    ['subscriptions', 'subscription', subscriptionSchema],
    ['stripeEvents', 'stripeEvent', stripeEventSchema],
    ['stripeUsage', 'stripeUsage', stripeUsageSchema],
    ['users', 'user', userSchema],
    ['invitations', 'employeeInvitation', employeeInvitationSchema],
    ['periods', 'subscriptionPeriod', subscriptionPeriodSchema],
  ];
  const result = {} as StripeResetCollections;
  for (const [key, name, original] of definitions) {
    const schema = original.clone();
    schema.set('autoCreate', false);
    schema.set('autoIndex', false);
    result[key] = connection.db.collection<StripeResetRecord>(
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
  let phase = CliFailureCategory.INVALID_STRIPE_RESET_ARGUMENTS;
  try {
    app = await NestFactory.createApplicationContext(
      StripeResetConfigurationModule,
      { logger: false, abortOnError: false },
    );
    const config = app.get(ConfigService);
    const options = stripeResetArguments(
      process.argv.slice(2),
      config.get<string>('NODE_ENV'),
    );
    if (options.execute)
      assertStripeTestKeyForExecution(config.get<string>('STRIPE_SECRET_KEY'));
    const uri = config.get<string>('MONGO_URI');
    if (!uri || !/^mongodb(?:\+srv)?:\/\//.test(uri))
      throw new CliFailure(CliFailureCategory.INVALID_STRIPE_RESET_ARGUMENTS);
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
    const report = await new StripeTestStateReset(
      connection,
      collections(connection),
    ).run(options);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    const reason =
      error instanceof StripeResetRefusal ? ` (${error.reason})` : '';
    process.stderr.write(
      `Stripe Test Mode reset failed: ${safeCliCategory(error, phase)}${reason}.\n`,
    );
    process.exitCode = 1;
  } finally {
    try {
      await connection?.close();
      await app?.close();
    } catch {
      process.stderr.write(
        `Stripe Test Mode reset failed: ${CliFailureCategory.CLOSE}.\n`,
      );
      process.exitCode = 1;
    }
  }
}

void main();
