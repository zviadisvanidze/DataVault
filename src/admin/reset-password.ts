import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import {
  ADMIN_PASSWORD_RESET_CONFIRMATION,
  AdminPasswordResetService,
  passwordResetArguments,
  passwordResetInput,
} from './admin-password-reset.service';
import { adminAuditSchema } from './entities/admin-audit.entity';
import { platformAdminSchema } from './entities/platform-admin.entity';
import {
  CliFailure,
  CliFailureCategory,
  safeCliCategory,
} from '../maintenance/cli-errors';
import { hiddenPrompt } from '../maintenance/hidden-prompt';

const invalidReset =
  CliFailureCategory.INVALID_ADMIN_PASSWORD_RESET_CONFIGURATION;

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const uri = config.get<string>('MONGO_URI');
        if (!uri || !/^mongodb(?:\+srv)?:\/\//.test(uri))
          throw new CliFailure(invalidReset);
        return {
          uri,
          serverSelectionTimeoutMS: 10000,
          maxPoolSize: 2,
          retryAttempts: 1,
          autoIndex: true,
        };
      },
    }),
    MongooseModule.forFeature([
      { name: 'platformAdmin', schema: platformAdminSchema },
      { name: 'adminAudit', schema: adminAuditSchema },
    ]),
  ],
  providers: [AdminPasswordResetService],
})
class AdminPasswordResetModule {}

async function resetPassword() {
  let app:
    | Awaited<ReturnType<typeof NestFactory.createApplicationContext>>
    | undefined;
  try {
    passwordResetArguments(process.argv.slice(2));
    const email = await hiddenPrompt(
      'Existing platform administrator email (hidden): ',
      undefined,
      invalidReset,
    );
    const password = await hiddenPrompt(
      'New platform administrator password (hidden): ',
      undefined,
      invalidReset,
    );
    const repeatedPassword = await hiddenPrompt(
      'Repeat new platform administrator password (hidden): ',
      undefined,
      invalidReset,
    );
    const confirmationEmail = await hiddenPrompt(
      'Retype the exact platform administrator email to confirm (hidden): ',
      undefined,
      invalidReset,
    );
    const input = passwordResetInput(
      email,
      password,
      repeatedPassword,
      confirmationEmail,
    );

    app = await NestFactory.createApplicationContext(AdminPasswordResetModule, {
      logger: false,
      abortOnError: false,
    });
    await app.get(AdminPasswordResetService).run(input);
    process.stdout.write('Platform administrator password reset completed.\n');
  } catch (error) {
    process.stderr.write(
      `Platform administrator password reset failed: ${safeCliCategory(error, CliFailureCategory.MONGO_CONNECTION)}.\n`,
    );
    process.exitCode = 1;
  } finally {
    try {
      await app?.close();
    } catch {
      process.stderr.write(
        `Platform administrator password reset failed: ${CliFailureCategory.CLOSE}.\n`,
      );
      process.exitCode = 1;
    }
  }
}

void resetPassword();

export { ADMIN_PASSWORD_RESET_CONFIRMATION };
