import { isISO31661Alpha2 } from 'class-validator';
import { randomUUID } from 'node:crypto';
import {
  activateSmokeCompany,
  authenticateSmokeAdmin,
  platformAdminSmokeTest,
  resumePlatformAdminSmokeTest,
  smokeCommand,
  SmokeFailure,
  SmokeTransport,
} from './admin-smoke-test.service';
import { hiddenPrompt } from './hidden-prompt';
import { CliFailure, CliFailureCategory, safeCliCategory } from './cli-errors';
import { validNewPassword } from '../common/password-policy';

async function main() {
  let registrationAttempted = false;
  let resumingExistingFixture = false;
  try {
    const args = process.argv.slice(2);
    const command = smokeCommand(args);
    const origin = command.origin;
    resumingExistingFixture = command.mode === 'resume';
    const api: SmokeTransport = {
      async request(method, path, token, body) {
        let response: Response;
        try {
          response = await fetch(`${origin}${path}`, {
            method,
            redirect: 'error',
            headers: {
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              ...(body === undefined
                ? {}
                : { 'Content-Type': 'application/json' }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(
              path === '/auth/sign-up' ? 90000 : 10000,
            ),
          });
        } catch {
          throw new CliFailure(CliFailureCategory.SMOKE_HTTP);
        }
        let responseBody: unknown;
        try {
          responseBody = (await response.json()) as unknown;
        } catch {
          // The authentication classifier uses the HTTP status and treats a
          // successful login without its JSON token shape as misconfiguration.
        }
        return { status: response.status, body: responseBody };
      },
    };
    const mode = await hiddenPrompt(
      'Platform authentication (enter token or login): ',
    );
    let adminToken: string;
    if (mode === 'token')
      adminToken = await authenticateSmokeAdmin(api, {
        kind: 'supplied_token',
        token: await hiddenPrompt('Platform JWT (hidden): '),
      });
    else if (mode === 'login') {
      const email = (await hiddenPrompt('Platform email (hidden): '))
        .trim()
        .toLowerCase();
      const password = await hiddenPrompt('Platform password (hidden): ');
      adminToken = await authenticateSmokeAdmin(api, {
        kind: 'credentials',
        email,
        password,
      });
    } else throw new CliFailure(CliFailureCategory.INVALID_SMOKE_CONFIGURATION);
    const email = (
      await hiddenPrompt(
        command.mode === 'register'
          ? 'NEW accessible tenant email (hidden; must not already be registered): '
          : 'Existing smoke tenant owner email (hidden): ',
      )
    )
      .trim()
      .toLowerCase();
    const password = await hiddenPrompt(
      command.mode === 'register'
        ? 'NEW tenant password (hidden; 12–72 characters, upper/lowercase, number, symbol; at most 72 UTF-8 bytes): '
        : 'Existing smoke tenant password (hidden): ',
    );
    if (
      !email ||
      (command.mode === 'register'
        ? !validNewPassword(password)
        : password.length < 1 || password.length > 72)
    )
      throw new CliFailure(CliFailureCategory.INVALID_SMOKE_CONFIGURATION);
    const activateNormally = async () => {
      const activation = await hiddenPrompt(
        'Activation URL or token from the existing email (hidden): ',
      );
      await activateSmokeCompany(api, activation);
    };
    let fixtureName: string;
    let result: Awaited<ReturnType<typeof platformAdminSmokeTest>>;
    if (command.mode === 'register') {
      const fullName = (
        await hiddenPrompt('Test owner full name (hidden): ')
      ).trim();
      const country = (
        await hiddenPrompt('Test company ISO country code (hidden): ')
      )
        .trim()
        .toUpperCase();
      const industry = (
        await hiddenPrompt('Test company industry (hidden): ')
      ).trim();
      if (
        !fullName ||
        fullName.length > 100 ||
        !isISO31661Alpha2(country) ||
        industry.length < 2 ||
        industry.length > 100
      )
        throw new CliFailure(CliFailureCategory.INVALID_SMOKE_CONFIGURATION);
      fixtureName = `DataVault admin smoke ${randomUUID()}`;
      process.stdout.write(`Temporary fixture name: ${fixtureName}.\n`);
      result = await platformAdminSmokeTest(
        api,
        { email, password, fullName, country, industry, adminToken },
        activateNormally,
        (stage) => process.stdout.write(`Smoke HTTP checkpoint: ${stage}.\n`),
        fixtureName,
        () => {
          registrationAttempted = true;
        },
      );
    } else {
      fixtureName = command.fixtureName;
      process.stdout.write(`Resuming existing smoke fixture ${fixtureName}.\n`);
      result = await resumePlatformAdminSmokeTest(
        api,
        { email, password, adminToken },
        activateNormally,
        fixtureName,
        (stage) => process.stdout.write(`Smoke HTTP checkpoint: ${stage}.\n`),
      );
    }
    process.stdout.write(
      `Smoke test passed for temporary company ${result.companyId}. The activated fixture is retained; it is ineligible for disposable-unactivated cleanup.\n`,
    );
  } catch (error) {
    const context =
      error instanceof SmokeFailure
        ? ` at ${error.stage}${Number.isInteger(error.status) ? ` (HTTP ${error.status})` : ''}`
        : '';
    process.stderr.write(
      `Admin smoke test failed: ${safeCliCategory(error)}${context}.\n`,
    );
    process.stderr.write(
      registrationAttempted
        ? 'A registration request was attempted; only the newly registered test tenant may have been created/changed. If activation or recovery failed, inspect that fixture through the admin API; do not retry using an existing account.\n'
        : resumingExistingFixture
          ? 'No registration request was sent. The named existing smoke fixture was not replaced; inspect its reported stage before retrying resume.\n'
          : 'No registration request was sent; no tenant was created by this smoke run.\n',
    );
    process.exitCode = 1;
  }
}

void main();
