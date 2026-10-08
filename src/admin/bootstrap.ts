import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import {
  AdminBootstrapService,
  bootstrapCredentials,
} from './admin-bootstrap.service';
import {
  CliFailure,
  CliFailureCategory,
  safeCliCategory,
} from '../maintenance/cli-errors';
import { adminAuditSchema } from './entities/admin-audit.entity';
import { platformAdminSchema } from './entities/platform-admin.entity';

// Intentionally excludes AppModule: never starts HTTP, payment workers, SMTP,
// S3, or any tenant feature while bootstrapping an administrator.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        bootstrapCredentials(config);
        const uri = config.get<string>('MONGO_URI');
        if (!uri || !/^mongodb(?:\+srv)?:\/\//.test(uri))
          throw new CliFailure(
            CliFailureCategory.INVALID_BOOTSTRAP_CONFIGURATION,
          );
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
  providers: [AdminBootstrapService],
})
class AdminBootstrapModule {}

async function bootstrap() {
  let app:
    | Awaited<ReturnType<typeof NestFactory.createApplicationContext>>
    | undefined;
  try {
    app = await NestFactory.createApplicationContext(AdminBootstrapModule, {
      logger: false,
      abortOnError: false,
    });
    const result = await app.get(AdminBootstrapService).run();
    process.stdout.write(
      result.created
        ? 'Platform administrator created.\n'
        : 'Platform administrator already exists; credentials unchanged.\n',
    );
  } catch (error) {
    process.stderr.write(
      `Platform bootstrap failed: ${safeCliCategory(error, CliFailureCategory.MONGO_CONNECTION)}.\n`,
    );
    process.exitCode = 1;
  } finally {
    try {
      await app?.close();
    } catch {
      process.stderr.write(
        `Platform bootstrap failed: ${CliFailureCategory.CLOSE}.\n`,
      );
      process.exitCode = 1;
    }
  }
}

void bootstrap();
