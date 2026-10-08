import { validateEnvironment } from './environment';

const valid = {
  MONGO_URI: 'mongodb://localhost:27017/datavault',
  JWT_SECRET: 'a-secure-test-secret-with-32-characters',
  ACCOUNT_ACTIVATION_URL: 'https://client.test/auth/activate',
  EMPLOYEE_INVITATION_URL: 'https://client.test/invitations/accept',
  EMAIL_PROVIDER: 'smtp',
  SMTP_HOST: 'smtp.example.test',
  SMTP_FROM: 'no-reply@example.test',
};

describe('validateEnvironment', () => {
  it('applies defaults and accepts disabled optional integrations', () => {
    expect(validateEnvironment(valid)).toMatchObject({
      ...valid,
      NODE_ENV: 'development',
      PORT: 3000,
      FILE_MAX_SIZE_BYTES: 10485760,
      TRUST_PROXY_HOPS: 0,
      MONGO_SERVER_SELECTION_TIMEOUT_MS: 10000,
      MONGO_MAX_POOL_SIZE: 20,
      MONGO_RETRY_ATTEMPTS: 5,
      MONGO_RETRY_DELAY_MS: 3000,
      OPENROUTER_ENABLED: false,
      OPENROUTER_TIMEOUT_MS: 30000,
      OPENROUTER_MAX_OUTPUT_TOKENS: 1000,
      OPENROUTER_MAX_TOOL_ITERATIONS: 3,
      OPENROUTER_REQUIRE_ZDR: false,
      OPENROUTER_FALLBACK_MODELS: [],
      GEMINI_ENABLED: false,
      GEMINI_TIMEOUT_MS: 30000,
      GEMINI_MAX_OUTPUT_TOKENS: 2048,
      AI_MAX_MESSAGE_CHARS: 8000,
      AI_MAX_HISTORY_MESSAGES: 20,
      AI_MAX_CONTEXT_CHARS: 40000,
      AI_MAX_CONVERSATION_MESSAGES: 100,
      AI_MAX_CONVERSATIONS_PER_USER: 100,
      AI_RATE_LIMIT_PER_MINUTE: 10,
    });
  });

  it.each([
    [{ ...valid, JWT_SECRET: 'short' }, 'JWT_SECRET'],
    [{ ...valid, CORS_ORIGIN: 'https://valid.test/path' }, 'CORS_ORIGIN'],
    [{ ...valid, GOOGLE_CLIENT_ID: 'id' }, 'GOOGLE_CLIENT_SECRET'],
    [{ ...valid, AWS_ACCESS_KEY_ID: 'id' }, 'AWS_BUCKET_NAME'],
    [{ ...valid, SMTP_HOST: '' }, 'SMTP_HOST'],
    [{ ...valid, SMTP_FROM: 'invalid' }, 'SMTP_FROM'],
    [{ ...valid, SMTP_PORT: '0' }, 'SMTP_PORT'],
    [{ ...valid, SMTP_SECURE: 'yes' }, 'SMTP_SECURE'],
    [{ ...valid, SMTP_USER: 'user' }, 'SMTP_PASSWORD'],
    [{ ...valid, EMAIL_PROVIDER: '' }, 'EMAIL_PROVIDER'],
    [{ ...valid, EMAIL_PROVIDER: 'auto' }, 'EMAIL_PROVIDER'],
    [{ ...valid, FILE_MAX_SIZE_BYTES: '0' }, 'FILE_MAX_SIZE_BYTES'],
    [{ ...valid, FILE_MAX_SIZE_BYTES: '104857601' }, 'FILE_MAX_SIZE_BYTES'],
    [{ ...valid, NODE_ENV: 'staging' }, 'NODE_ENV'],
    [{ ...valid, TRUST_PROXY_HOPS: '11' }, 'TRUST_PROXY_HOPS'],
    [
      { ...valid, MONGO_SERVER_SELECTION_TIMEOUT_MS: '999' },
      'MONGO_SERVER_SELECTION_TIMEOUT_MS',
    ],
    [{ ...valid, MONGO_MAX_POOL_SIZE: '0' }, 'MONGO_MAX_POOL_SIZE'],
    [{ ...valid, MONGO_RETRY_ATTEMPTS: '0' }, 'MONGO_RETRY_ATTEMPTS'],
    [{ ...valid, MONGO_RETRY_DELAY_MS: '99' }, 'MONGO_RETRY_DELAY_MS'],
    [{ ...valid, CORS_ORIGIN: 'http://remote.test' }, 'CORS_ORIGIN'],
    [
      { ...valid, ACCOUNT_ACTIVATION_URL: 'http://client.test' },
      'ACCOUNT_ACTIVATION_URL',
    ],
    [
      { ...valid, EMPLOYEE_INVITATION_URL: 'http://client.test' },
      'EMPLOYEE_INVITATION_URL',
    ],
  ])('rejects an invalid configuration', (config, key) => {
    expect(() => validateEnvironment(config)).toThrow(key);
  });

  it('defaults to required STARTTLS and permits authenticated implicit TLS', () => {
    expect(validateEnvironment(valid)).toMatchObject({
      SMTP_PORT: 587,
      SMTP_SECURE: false,
      SMTP_REQUIRE_TLS: true,
    });
    expect(
      validateEnvironment({
        ...valid,
        SMTP_SECURE: 'true',
        SMTP_USER: 'user',
        SMTP_PASSWORD: 'password',
      }),
    ).toMatchObject({ SMTP_PORT: 465, SMTP_SECURE: true });
  });

  it('requires only Resend credentials in resend mode', () => {
    const resend = {
      ...valid,
      EMAIL_PROVIDER: 'resend',
      SMTP_HOST: undefined,
      SMTP_FROM: undefined,
      RESEND_API_KEY: 're_example_test_key_12345',
      RESEND_FROM: 'no-reply@example.test',
    };
    expect(validateEnvironment(resend)).toMatchObject(resend);
    expect(() =>
      validateEnvironment({ ...resend, RESEND_API_KEY: '' }),
    ).toThrow('RESEND_API_KEY');
    expect(() =>
      validateEnvironment({ ...resend, RESEND_API_KEY: 'REPLACE_ME' }),
    ).toThrow('RESEND_API_KEY');
    expect(() => validateEnvironment({ ...resend, RESEND_FROM: '' })).toThrow(
      'RESEND_FROM',
    );
    expect(() =>
      validateEnvironment({ ...resend, RESEND_FROM: 'invalid' }),
    ).toThrow('RESEND_FROM');
    expect(() =>
      validateEnvironment({ ...resend, SMTP_PORT: 'invalid' }),
    ).not.toThrow();
  });

  it('does not require Resend credentials in smtp mode', () => {
    expect(() =>
      validateEnvironment({ ...valid, RESEND_API_KEY: '', RESEND_FROM: '' }),
    ).not.toThrow();
  });

  it('requires HTTPS for configured OAuth URLs outside localhost', () => {
    expect(() =>
      validateEnvironment({
        ...valid,
        GOOGLE_CLIENT_ID: 'client',
        GOOGLE_CLIENT_SECRET: 'secret',
        GOOGLE_CALLBACK_URL: 'http://api.example.test/auth/google/callback',
        FRONT_URI: 'https://client.example.test',
      }),
    ).toThrow('GOOGLE_CALLBACK_URL');
  });

  it('requires the exact trusted Google callback route without query or fragment', () => {
    const google = {
      ...valid,
      GOOGLE_CLIENT_ID: 'client',
      GOOGLE_CLIENT_SECRET: 'secret',
      FRONT_URI: 'https://client.example.test',
    };
    expect(() =>
      validateEnvironment({
        ...google,
        GOOGLE_CALLBACK_URL: 'https://api.example.test/auth/google/callback',
      }),
    ).not.toThrow();
    for (const callback of [
      'https://api.example.test/other',
      'https://api.example.test/auth/google/callback?next=https://evil.test',
      'https://api.example.test/auth/google/callback#fragment',
    ])
      expect(() =>
        validateEnvironment({ ...google, GOOGLE_CALLBACK_URL: callback }),
      ).toThrow('GOOGLE_CALLBACK_URL');
  });
});

describe('Gemini environment validation', () => {
  const gemini = {
    ...valid,
    GEMINI_ENABLED: 'true',
    GEMINI_API_KEY: `AIza${'a'.repeat(36)}`,
    GEMINI_MODEL: 'gemini-3.5-flash-lite',
  };

  it('accepts direct Gemini alone or alongside OpenRouter', () => {
    expect(validateEnvironment(gemini)).toMatchObject({
      OPENROUTER_ENABLED: false,
      GEMINI_ENABLED: true,
      GEMINI_MODEL: 'gemini-3.5-flash-lite',
    });
    expect(
      validateEnvironment({
        ...gemini,
        OPENROUTER_ENABLED: 'true',
        OPENROUTER_API_KEY: `sk-or-v1-${'a'.repeat(48)}`,
        OPENROUTER_MODEL: 'provider/model',
      }),
    ).toMatchObject({ OPENROUTER_ENABLED: true, GEMINI_ENABLED: true });
  });

  it.each([
    ['GEMINI_API_KEY', ''],
    ['GEMINI_API_KEY', 'REPLACE_ME'],
    ['GEMINI_API_KEY', 'contains whitespace inside'],
    ['GEMINI_MODEL', ''],
    ['GEMINI_MODEL', 'REPLACE_ME'],
    ['GEMINI_MODEL', 'provider/gemini-3.5-flash-lite'],
    ['GEMINI_TIMEOUT_MS', '4999'],
    ['GEMINI_MAX_OUTPUT_TOKENS', '9000'],
  ])('rejects invalid %s without echoing the value', (key, value) => {
    expect(() => validateEnvironment({ ...gemini, [key]: value })).toThrow(key);
  });
});

describe('OpenRouter environment validation', () => {
  const enabled = {
    ...valid,
    OPENROUTER_ENABLED: 'true',
    OPENROUTER_API_KEY: `sk-or-v1-${'a'.repeat(48)}`,
    OPENROUTER_MODEL: 'openai/gpt-4.1-mini',
    OPENROUTER_FALLBACK_MODELS:
      'anthropic/claude-sonnet-4, google/gemini-2.5-flash',
    OPENROUTER_REQUIRE_ZDR: 'true',
  };

  it('parses enabled provider, privacy, fallback, and abuse controls', () => {
    expect(validateEnvironment(enabled)).toMatchObject({
      OPENROUTER_ENABLED: true,
      OPENROUTER_MODEL: 'openai/gpt-4.1-mini',
      OPENROUTER_FALLBACK_MODELS: [
        'anthropic/claude-sonnet-4',
        'google/gemini-2.5-flash',
      ],
      OPENROUTER_REQUIRE_ZDR: true,
    });
  });

  it.each([
    ['OPENROUTER_API_KEY', ''],
    ['OPENROUTER_API_KEY', 'sk-or-v1-REPLACE_ME'],
    ['OPENROUTER_API_KEY', 'sk-not-openrouter'],
    ['OPENROUTER_MODEL', ''],
    ['OPENROUTER_MODEL', 'REPLACE_ME/model'],
    ['OPENROUTER_MODEL', 'no-provider-prefix'],
    ['OPENROUTER_FALLBACK_MODELS', 'openai/gpt-4.1-mini'],
    ['OPENROUTER_FALLBACK_MODELS', 'a/model,b/model,c/model,d/model'],
    ['OPENROUTER_FALLBACK_MODELS', 'invalid'],
    ['OPENROUTER_TIMEOUT_MS', '4999'],
    ['OPENROUTER_MAX_OUTPUT_TOKENS', '63'],
    ['OPENROUTER_MAX_TOOL_ITERATIONS', '6'],
    ['OPENROUTER_REQUIRE_ZDR', 'yes'],
    ['AI_MAX_MESSAGE_CHARS', '99'],
    ['AI_MAX_HISTORY_MESSAGES', '51'],
    ['AI_MAX_CONTEXT_CHARS', '999'],
    ['AI_MAX_CONVERSATION_MESSAGES', '201'],
    ['AI_MAX_CONVERSATIONS_PER_USER', '0'],
    ['AI_RATE_LIMIT_PER_MINUTE', '121'],
  ])('rejects invalid %s without including its value', (key, value) => {
    expect(() => validateEnvironment({ ...enabled, [key]: value })).toThrow(
      key,
    );
  });

  it('requires internally consistent history and context bounds', () => {
    expect(() =>
      validateEnvironment({
        ...enabled,
        AI_MAX_HISTORY_MESSAGES: '20',
        AI_MAX_CONVERSATION_MESSAGES: '10',
      }),
    ).toThrow('AI_MAX_HISTORY_MESSAGES');
    expect(() =>
      validateEnvironment({
        ...enabled,
        AI_MAX_MESSAGE_CHARS: '8000',
        AI_MAX_CONTEXT_CHARS: '7000',
      }),
    ).toThrow('AI_MAX_CONTEXT_CHARS');
  });
});

describe('Stripe Test Mode environment validation', () => {
  const stripe = {
    ...valid,
    STRIPE_ENABLED: 'true',
    STRIPE_SECRET_KEY: 'sk_test_fixture',
    STRIPE_WEBHOOK_SECRET: 'whsec_fixture',
    STRIPE_BASIC_PRICE_ID: 'price_basic',
    STRIPE_PREMIUM_PRICE_ID: 'price_premium',
    STRIPE_OVERAGE_PRICE_ID: 'price_overage',
    STRIPE_OVERAGE_METER_ID: 'mtr_fixture',
    STRIPE_OVERAGE_EVENT_NAME: 'upload_overage',
    STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_fixture',
    STRIPE_CHECKOUT_SUCCESS_URL: 'https://client.test/success',
    STRIPE_CHECKOUT_CANCEL_URL: 'https://client.test/cancel',
    STRIPE_PORTAL_RETURN_URL: 'https://client.test/billing',
  };
  it('defaults off and validates all enabled mapping/settings', () => {
    expect(validateEnvironment(valid).STRIPE_ENABLED).toBe(false);
    expect(validateEnvironment(stripe)).toMatchObject({
      STRIPE_ENABLED: true,
      STRIPE_SYNC_INTERVAL_MS: 30000,
    });
  });
  it.each([
    'mtr_123',
    'mtr_fixture',
    'mtr_test_61Q8nQMqIFK9fRQmr41CMAXJrFdZ5MnA',
    'mtr_test_A1b2C3',
  ])('accepts a supported meter ID format: %s', (meterId) => {
    expect(
      validateEnvironment({ ...stripe, STRIPE_OVERAGE_METER_ID: meterId }),
    ).toMatchObject({ STRIPE_OVERAGE_METER_ID: meterId });
  });
  it.each([
    '',
    'mtr_',
    'mtr_test_',
    'mtr_test_...',
    'mtr_test_test_A1b2C3',
    'mtr_live_A1b2C3',
    'mtr_sandbox_A1b2C3',
    'mtr_test_A1_b2',
    'mtr_test_A1-b2',
    'mtr_test_A1 b2',
    ' mtr_test_A1b2C3',
    'mtr_test_A1b2C3 ',
    'MTR_test_A1b2C3',
    'price_A1b2C3',
    'mtr_REPLACE_ME',
    'mtr_test_REPLACE_ME',
  ])('rejects malformed or example placeholder meter IDs: %s', (meterId) => {
    expect(() =>
      validateEnvironment({ ...stripe, STRIPE_OVERAGE_METER_ID: meterId }),
    ).toThrow('STRIPE_OVERAGE_METER_ID');
  });
  it.each([
    ['STRIPE_SECRET_KEY', 'sk_live_fixture'],
    ['STRIPE_WEBHOOK_SECRET', ''],
    ['STRIPE_BASIC_PRICE_ID', 'invalid'],
    ['STRIPE_OVERAGE_METER_ID', 'invalid'],
    ['STRIPE_OVERAGE_EVENT_NAME', 'bad-event'],
    ['STRIPE_PORTAL_CONFIGURATION_ID', 'invalid'],
    ['STRIPE_CHECKOUT_SUCCESS_URL', 'http://remote.test/success'],
    ['STRIPE_CHECKOUT_CANCEL_URL', 'https://user:password@client.test/cancel'],
    ['STRIPE_PORTAL_RETURN_URL', 'ftp://client.test/billing'],
    ['STRIPE_SYNC_INTERVAL_MS', '9999'],
  ])('rejects unsafe/missing %s without exposing its value', (key, value) => {
    expect(() => validateEnvironment({ ...stripe, [key]: value })).toThrow(key);
  });
  it('rejects duplicate catalog mappings and production HTTP even on localhost', () => {
    expect(() =>
      validateEnvironment({
        ...stripe,
        STRIPE_PREMIUM_PRICE_ID: 'price_basic',
      }),
    ).toThrow('distinct');
    expect(() =>
      validateEnvironment({
        ...stripe,
        NODE_ENV: 'production',
        STRIPE_CHECKOUT_SUCCESS_URL: 'http://localhost:3000/success',
      }),
    ).toThrow('HTTPS');
  });
});
