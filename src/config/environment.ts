import { isEmail } from 'class-validator';

export function validateEnvironment(config: Record<string, unknown>) {
  const result = { ...config };
  const text = (key: string) =>
    typeof config[key] === 'string' ? config[key] : '';
  const required = (key: string) => {
    if (!text(key).trim()) throw new Error(`${key} is required`);
  };
  const httpUrl = (key: string, originOnly = false) => {
    try {
      const url = new URL(text(key));
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        (originOnly && url.origin !== text(key))
      )
        throw new Error();
    } catch {
      throw new Error(
        `${key} must be a valid HTTP(S) ${originOnly ? 'origin' : 'URL'}`,
      );
    }
  };
  required('MONGO_URI');
  if (!/^mongodb(?:\+srv)?:\/\//.test(text('MONGO_URI')))
    throw new Error('MONGO_URI must be a MongoDB connection URI');
  const nodeEnv = text('NODE_ENV') || 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv))
    throw new Error('NODE_ENV must be development, test, or production');
  result.NODE_ENV = nodeEnv;
  result.MONGO_SERVER_SELECTION_TIMEOUT_MS = integer(
    'MONGO_SERVER_SELECTION_TIMEOUT_MS',
    10_000,
    1_000,
    120_000,
  );
  result.MONGO_MAX_POOL_SIZE = integer('MONGO_MAX_POOL_SIZE', 20, 1, 200);
  result.MONGO_RETRY_ATTEMPTS = integer('MONGO_RETRY_ATTEMPTS', 5, 1, 20);
  result.MONGO_RETRY_DELAY_MS = integer(
    'MONGO_RETRY_DELAY_MS',
    3_000,
    100,
    30_000,
  );
  required('JWT_SECRET');
  if (text('JWT_SECRET').length < 32)
    throw new Error('JWT_SECRET must contain at least 32 characters');
  const port = text('PORT') || '3000';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error('PORT must be an integer between 1 and 65535');
  result.PORT = Number(port);
  result.TRUST_PROXY_HOPS = integer('TRUST_PROXY_HOPS', 0, 0, 10);
  const fileMaxSizeBytes = text('FILE_MAX_SIZE_BYTES') || '10485760';
  if (
    !/^\d+$/.test(fileMaxSizeBytes) ||
    Number(fileMaxSizeBytes) < 1 ||
    Number(fileMaxSizeBytes) > 104857600
  )
    throw new Error(
      'FILE_MAX_SIZE_BYTES must be an integer between 1 and 104857600',
    );
  result.FILE_MAX_SIZE_BYTES = Number(fileMaxSizeBytes);
  required('ACCOUNT_ACTIVATION_URL');
  httpUrl('ACCOUNT_ACTIVATION_URL');
  requireHttpsOutsideLocalhost('ACCOUNT_ACTIVATION_URL');
  required('EMPLOYEE_INVITATION_URL');
  httpUrl('EMPLOYEE_INVITATION_URL');
  requireHttpsOutsideLocalhost('EMPLOYEE_INVITATION_URL');
  required('EMAIL_PROVIDER');
  const emailProvider = text('EMAIL_PROVIDER');
  if (emailProvider !== 'smtp' && emailProvider !== 'resend')
    throw new Error('EMAIL_PROVIDER must be smtp or resend');
  if (emailProvider === 'smtp') {
    required('SMTP_HOST');
    if (!/^[A-Za-z0-9.:[\]_-]+$/.test(text('SMTP_HOST')))
      throw new Error('SMTP_HOST must be a valid hostname or IP address');
    required('SMTP_FROM');
    if (!isEmail(text('SMTP_FROM')))
      throw new Error('SMTP_FROM must be a valid email address');
    const smtpSecure = boolean('SMTP_SECURE', false);
    const smtpRequireTls = boolean('SMTP_REQUIRE_TLS', true);
    const smtpPort = text('SMTP_PORT') || (smtpSecure ? '465' : '587');
    if (
      !/^\d+$/.test(smtpPort) ||
      Number(smtpPort) < 1 ||
      Number(smtpPort) > 65535
    )
      throw new Error('SMTP_PORT must be an integer between 1 and 65535');
    result.SMTP_PORT = Number(smtpPort);
    result.SMTP_SECURE = smtpSecure;
    result.SMTP_REQUIRE_TLS = smtpRequireTls;
    if (text('SMTP_USER') || text('SMTP_PASSWORD')) {
      required('SMTP_USER');
      required('SMTP_PASSWORD');
    }
  } else {
    required('RESEND_API_KEY');
    if (!/^re_[A-Za-z0-9_-]{8,}$/.test(text('RESEND_API_KEY')))
      throw new Error('RESEND_API_KEY must be a Resend API key');
    required('RESEND_FROM');
    if (!isEmail(text('RESEND_FROM')))
      throw new Error('RESEND_FROM must be a valid email address');
  }
  if (text('CORS_ORIGIN')) {
    for (const origin of text('CORS_ORIGIN')
      .split(',')
      .map((value) => value.trim())) {
      // Validate each origin without exposing environment values in errors.
      const url = validateOrigin(origin);
      if (url.protocol !== 'https:' && !isLocalhost(url.hostname))
        throw new Error('CORS_ORIGIN must use HTTPS outside localhost');
    }
  }
  const googleKeys = [
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_CALLBACK_URL',
    'FRONT_URI',
  ];
  if (googleKeys.some((key) => text(key))) {
    googleKeys.forEach(required);
    httpUrl('GOOGLE_CALLBACK_URL');
    httpUrl('FRONT_URI', true);
    requireHttpsOutsideLocalhost('GOOGLE_CALLBACK_URL');
    requireHttpsOutsideLocalhost('FRONT_URI');
    const callback = new URL(text('GOOGLE_CALLBACK_URL'));
    if (
      callback.pathname !== '/auth/google/callback' ||
      callback.search ||
      callback.hash
    )
      throw new Error(
        'GOOGLE_CALLBACK_URL must point to /auth/google/callback without query or fragment',
      );
  }
  const awsKeys = [
    'AWS_BUCKET_NAME',
    'AWS_REGION',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
  ];
  const stripeEnabled = boolean('STRIPE_ENABLED', false);
  result.STRIPE_ENABLED = stripeEnabled;
  result.STRIPE_SYNC_INTERVAL_MS = integer(
    'STRIPE_SYNC_INTERVAL_MS',
    30000,
    10000,
    300000,
  );
  if (stripeEnabled) {
    const stripeKeys = [
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'STRIPE_BASIC_PRICE_ID',
      'STRIPE_PREMIUM_PRICE_ID',
      'STRIPE_OVERAGE_PRICE_ID',
      'STRIPE_OVERAGE_METER_ID',
      'STRIPE_OVERAGE_EVENT_NAME',
      'STRIPE_PORTAL_CONFIGURATION_ID',
      'STRIPE_CHECKOUT_SUCCESS_URL',
      'STRIPE_CHECKOUT_CANCEL_URL',
      'STRIPE_PORTAL_RETURN_URL',
    ];
    stripeKeys.forEach(required);
    if (!/^sk_test_[A-Za-z0-9]+$/.test(text('STRIPE_SECRET_KEY')))
      throw new Error('STRIPE_SECRET_KEY must be a Test Mode secret key');
    if (!/^whsec_[A-Za-z0-9]+$/.test(text('STRIPE_WEBHOOK_SECRET')))
      throw new Error('STRIPE_WEBHOOK_SECRET must be a webhook signing secret');
    for (const key of [
      'STRIPE_BASIC_PRICE_ID',
      'STRIPE_PREMIUM_PRICE_ID',
      'STRIPE_OVERAGE_PRICE_ID',
    ])
      if (!/^price_[A-Za-z0-9]+$/.test(text(key)))
        throw new Error(`${key} must be a Stripe Price ID`);
    if (
      new Set(
        [
          'STRIPE_BASIC_PRICE_ID',
          'STRIPE_PREMIUM_PRICE_ID',
          'STRIPE_OVERAGE_PRICE_ID',
        ].map(text),
      ).size !== 3
    )
      throw new Error('Stripe plan Price IDs must be distinct');
    if (!/^mtr_(?:test_)?[A-Za-z0-9]+$/.test(text('STRIPE_OVERAGE_METER_ID')))
      throw new Error('STRIPE_OVERAGE_METER_ID must be a Stripe meter ID');
    if (!/^[A-Za-z0-9_]+$/.test(text('STRIPE_OVERAGE_EVENT_NAME')))
      throw new Error(
        'STRIPE_OVERAGE_EVENT_NAME must contain only letters, digits and underscores',
      );
    if (!/^bpc_[A-Za-z0-9]+$/.test(text('STRIPE_PORTAL_CONFIGURATION_ID')))
      throw new Error(
        'STRIPE_PORTAL_CONFIGURATION_ID must be a Stripe Portal configuration ID',
      );
    for (const key of [
      'STRIPE_CHECKOUT_SUCCESS_URL',
      'STRIPE_CHECKOUT_CANCEL_URL',
      'STRIPE_PORTAL_RETURN_URL',
    ]) {
      httpUrl(key);
      requireHttpsOutsideLocalhost(key);
      const url = new URL(text(key));
      if (nodeEnv === 'production' && url.protocol !== 'https:')
        throw new Error(`${key} must use HTTPS in production`);
    }
  }
  const openRouterEnabled = boolean('OPENROUTER_ENABLED', false);
  result.OPENROUTER_ENABLED = openRouterEnabled;
  result.OPENROUTER_TIMEOUT_MS = integer(
    'OPENROUTER_TIMEOUT_MS',
    30_000,
    5_000,
    120_000,
  );
  result.OPENROUTER_MAX_OUTPUT_TOKENS = integer(
    'OPENROUTER_MAX_OUTPUT_TOKENS',
    1_000,
    64,
    8_192,
  );
  result.OPENROUTER_MAX_TOOL_ITERATIONS = integer(
    'OPENROUTER_MAX_TOOL_ITERATIONS',
    3,
    1,
    5,
  );
  result.OPENROUTER_REQUIRE_ZDR = boolean('OPENROUTER_REQUIRE_ZDR', false);
  result.AI_MAX_MESSAGE_CHARS = integer(
    'AI_MAX_MESSAGE_CHARS',
    8_000,
    100,
    50_000,
  );
  result.AI_MAX_HISTORY_MESSAGES = integer(
    'AI_MAX_HISTORY_MESSAGES',
    20,
    2,
    50,
  );
  result.AI_MAX_CONTEXT_CHARS = integer(
    'AI_MAX_CONTEXT_CHARS',
    40_000,
    1_000,
    200_000,
  );
  result.AI_MAX_CONVERSATION_MESSAGES = integer(
    'AI_MAX_CONVERSATION_MESSAGES',
    100,
    2,
    200,
  );
  result.AI_MAX_CONVERSATIONS_PER_USER = integer(
    'AI_MAX_CONVERSATIONS_PER_USER',
    100,
    1,
    1_000,
  );
  result.AI_RATE_LIMIT_PER_MINUTE = integer(
    'AI_RATE_LIMIT_PER_MINUTE',
    10,
    1,
    120,
  );
  if (
    Number(result.AI_MAX_HISTORY_MESSAGES) >
    Number(result.AI_MAX_CONVERSATION_MESSAGES)
  )
    throw new Error(
      'AI_MAX_HISTORY_MESSAGES cannot exceed AI_MAX_CONVERSATION_MESSAGES',
    );
  if (Number(result.AI_MAX_CONTEXT_CHARS) < Number(result.AI_MAX_MESSAGE_CHARS))
    throw new Error(
      'AI_MAX_CONTEXT_CHARS cannot be less than AI_MAX_MESSAGE_CHARS',
    );
  if (openRouterEnabled) {
    required('OPENROUTER_API_KEY');
    required('OPENROUTER_MODEL');
    if (
      !/^sk-or-v1-[A-Za-z0-9_-]{32,}$/.test(text('OPENROUTER_API_KEY')) ||
      /REPLACE_ME/i.test(text('OPENROUTER_API_KEY'))
    )
      throw new Error('OPENROUTER_API_KEY must be an OpenRouter API key');
    const modelPattern =
      /^~?[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;
    const primary = text('OPENROUTER_MODEL').trim();
    if (!modelPattern.test(primary) || /REPLACE_ME/i.test(primary))
      throw new Error('OPENROUTER_MODEL must be a valid OpenRouter model ID');
    const fallbacks = text('OPENROUTER_FALLBACK_MODELS')
      .split(',')
      .map((model) => model.trim())
      .filter(Boolean);
    if (
      fallbacks.length > 3 ||
      fallbacks.some(
        (model) => !modelPattern.test(model) || /REPLACE_ME/i.test(model),
      ) ||
      new Set([primary, ...fallbacks]).size !== 1 + fallbacks.length
    )
      throw new Error(
        'OPENROUTER_FALLBACK_MODELS must contain up to three distinct OpenRouter model IDs',
      );
    result.OPENROUTER_MODEL = primary;
    result.OPENROUTER_FALLBACK_MODELS = fallbacks;
  } else {
    result.OPENROUTER_FALLBACK_MODELS = [];
  }
  const geminiEnabled = boolean('GEMINI_ENABLED', false);
  result.GEMINI_ENABLED = geminiEnabled;
  result.GEMINI_TIMEOUT_MS = integer(
    'GEMINI_TIMEOUT_MS',
    30_000,
    5_000,
    120_000,
  );
  result.GEMINI_MAX_OUTPUT_TOKENS = integer(
    'GEMINI_MAX_OUTPUT_TOKENS',
    2_048,
    64,
    8_192,
  );
  if (geminiEnabled) {
    required('GEMINI_API_KEY');
    required('GEMINI_MODEL');
    const key = text('GEMINI_API_KEY');
    if (
      key.length < 20 ||
      key.length > 256 ||
      /\s/.test(key) ||
      /REPLACE_ME|PLACEHOLDER/i.test(key)
    )
      throw new Error('GEMINI_API_KEY must be a valid backend API key');
    const model = text('GEMINI_MODEL').trim();
    if (
      !/^gemini-[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/.test(model) ||
      /REPLACE_ME|PLACEHOLDER/i.test(model)
    )
      throw new Error('GEMINI_MODEL must be a valid Gemini model ID');
    result.GEMINI_MODEL = model;
  }
  if (awsKeys.some((key) => text(key))) {
    required('AWS_BUCKET_NAME');
    required('AWS_REGION');
    if (text('AWS_ACCESS_KEY_ID') || text('AWS_SECRET_ACCESS_KEY')) {
      required('AWS_ACCESS_KEY_ID');
      required('AWS_SECRET_ACCESS_KEY');
    }
    if (text('AWS_SESSION_TOKEN')) {
      required('AWS_ACCESS_KEY_ID');
      required('AWS_SECRET_ACCESS_KEY');
    }
  }
  return result;

  function boolean(key: string, defaultValue: boolean) {
    const value = text(key).trim().toLowerCase();
    if (!value) return defaultValue;
    if (!['true', 'false'].includes(value))
      throw new Error(`${key} must be true or false`);
    return value === 'true';
  }

  function integer(
    key: string,
    defaultValue: number,
    minimum: number,
    maximum: number,
  ) {
    const value = text(key) || String(defaultValue);
    if (
      !/^\d+$/.test(value) ||
      Number(value) < minimum ||
      Number(value) > maximum
    )
      throw new Error(
        `${key} must be an integer between ${minimum} and ${maximum}`,
      );
    return Number(value);
  }

  function requireHttpsOutsideLocalhost(key: string) {
    const url = new URL(text(key));
    if (url.protocol !== 'https:' && !isLocalhost(url.hostname))
      throw new Error(`${key} must use HTTPS outside localhost`);
  }
}

function validateOrigin(origin: string) {
  try {
    const url = new URL(origin);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.origin !== origin ||
      url.username ||
      url.password
    )
      throw new Error();
    return url;
  } catch {
    throw new Error('CORS_ORIGIN must contain comma-separated HTTP(S) origins');
  }
}

function isLocalhost(hostname: string) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
}
