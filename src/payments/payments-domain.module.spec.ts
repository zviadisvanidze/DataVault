import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  getConnectionToken,
  getModelToken,
  MongooseModule,
} from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { paymentConfig } from '../../test/payments.fixture';
import { PaymentsDomainModule } from './payments-domain.module';
import { PaymentsService } from './payments.service';

describe('enabled payment domain bootstrap', () => {
  it('resolves the complete domain without network calls and waits for correctness indexes', async () => {
    let release!: () => void;
    const indexBuild = new Promise<void>((resolve) => {
      release = resolve;
    });
    const models = Object.fromEntries(
      [
        'plan',
        'subscription',
        'subscriptionPeriod',
        'user',
        'employeeInvitation',
        'companyFile',
        'stripeEvent',
        'stripeUsage',
      ].map((name) => [name, { init: jest.fn(() => indexBuild) }]),
    );
    const connection = {
      models,
      close: jest.fn().mockResolvedValue(undefined),
    };
    let compiled = false;
    const builder = Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        MongooseModule.forRoot('mongodb://localhost/unused_fixture'),
        PaymentsDomainModule,
      ],
    })
      .overrideProvider(ConfigService)
      .useValue(new ConfigService(paymentConfig))
      .overrideProvider(getConnectionToken())
      .useValue(connection);
    const pending = builder.compile().then((module) => {
      compiled = true;
      return module;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(compiled).toBe(false);
    expect(models.stripeEvent.init).toHaveBeenCalled();
    expect(models.stripeUsage.init).toHaveBeenCalled();
    expect(models.subscription.init).toHaveBeenCalled();
    release();
    const module = await pending;
    expect(module.get(PaymentsService).enabled).toBe(true);
    expect(module.get<unknown>(getModelToken('stripeEvent'))).toBe(
      models.stripeEvent,
    );
    await module.close();
  });
});
