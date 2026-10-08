process.env.MONGO_URI = 'mongodb://localhost:27017/datavault-test';
process.env.NODE_ENV = 'test';
process.env.STRIPE_ENABLED = 'false';
process.env.OPENROUTER_ENABLED = 'false';
process.env.GEMINI_ENABLED = 'false';
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_MODEL;
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_MODEL;
delete process.env.OPENROUTER_FALLBACK_MODELS;
process.env.JWT_SECRET = 'a-secure-test-secret-with-32-characters';
process.env.ACCOUNT_ACTIVATION_URL =
  'https://client.example.test/auth/activate';
process.env.EMPLOYEE_INVITATION_URL =
  'https://client.example.test/invitations/accept';
process.env.EMAIL_PROVIDER = 'smtp';
process.env.SMTP_HOST = 'smtp.example.test';
process.env.SMTP_PORT = '587';
process.env.SMTP_SECURE = 'false';
process.env.SMTP_REQUIRE_TLS = 'true';
process.env.SMTP_FROM = 'no-reply@example.test';
delete process.env.SMTP_USER;
delete process.env.SMTP_PASSWORD;
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.GOOGLE_CALLBACK_URL;
delete process.env.FRONT_URI;
process.env.CORS_ORIGIN =
  'https://client.example.test,https://second.example.test';
