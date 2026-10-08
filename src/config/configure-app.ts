import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';

interface ExpressAdapterInstance {
  set(setting: string, value: number): void;
}

export function configureApp(app: INestApplication) {
  const config = app.get(ConfigService);
  app.use(helmet());
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  const origins = config
    .get<string>('CORS_ORIGIN')
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({
    origin: origins?.length ? origins : false,
    credentials: false,
  });
  const trustedProxyHops = config.getOrThrow<number>('TRUST_PROXY_HOPS');
  if (trustedProxyHops > 0)
    (app.getHttpAdapter().getInstance() as ExpressAdapterInstance).set(
      'trust proxy',
      trustedProxyHops,
    );
}
