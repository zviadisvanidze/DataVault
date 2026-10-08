import {
  ApiAcceptedResponse,
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiFoundResponse,
  ApiGatewayTimeoutResponse,
  ApiHeader,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  AdminController,
  AdminAuthController,
} from '../admin/admin.controller';
import { AiController } from '../ai/ai.controller';
import { AiChatDto } from '../ai/dto/ai.dto';
import { AuthController } from '../auth/auth.controller';
import { ResendVerificationDto } from '../auth/dto/resend-verification.dto';
import { SignInDto } from '../auth/dto/sign-in.dto';
import { SignUpDto } from '../auth/dto/sign-up.dto';
import { VerifyAccountDto } from '../auth/dto/verify-account.dto';
import { GoogleExchangeDto } from '../auth/dto/google-exchange.dto';
import { GoogleRegistrationDto } from '../auth/dto/google-registration.dto';
import { ForgotPasswordDto } from '../auth/dto/forgot-password.dto';
import { ResetPasswordDto } from '../auth/dto/reset-password.dto';
import { CompaniesController } from '../companies/companies.controller';
import { CompanyFileVisibility } from '../files/entities/company-file.entity';
import { FilesController } from '../files/files.controller';
import { HealthController } from '../health/health.controller';
import { AcceptInvitationDto } from '../invitations/dto/accept-invitation.dto';
import { InviteEmployeeDto } from '../invitations/dto/invite-employee.dto';
import { InvitationsController } from '../invitations/invitations.controller';
import {
  PaymentsController,
  StripeWebhookController,
} from '../payments/payments.controller';
import { PlansController } from '../plans/plans.controller';
import { StatisticsController } from '../statistics/statistics.controller';
import { SubscriptionsController } from '../subscriptions/subscriptions.controller';
import { UsersController } from '../users/users.controller';
import {
  PLATFORM_ADMIN_JWT,
  TENANT_JWT,
  apiResponses,
  apiSchemas,
} from './swagger';

type Controller = {
  readonly name: string;
  readonly prototype: object;
};
type Decorator = ClassDecorator | MethodDecorator;

let applied = false;

function decorateClass(target: Controller, ...decorators: Decorator[]) {
  for (const decorator of decorators) {
    const applyDecorator = decorator as unknown as (value: Controller) => void;
    applyDecorator(target);
  }
}

function decorateMethod(
  target: Controller,
  name: string,
  ...decorators: Decorator[]
) {
  const descriptor = Object.getOwnPropertyDescriptor(target.prototype, name);
  if (!descriptor)
    throw new Error(`OpenAPI target ${target.name}.${name} is missing`);
  for (const decorator of decorators)
    (decorator as MethodDecorator)(target.prototype, name, descriptor);
}

const error = (description: string) => ({
  description,
  schema: apiSchemas.error,
});

function tenantController(target: Controller, tag: string) {
  decorateClass(
    target,
    ApiTags(tag),
    ApiBearerAuth(TENANT_JWT),
    ApiUnauthorizedResponse(
      error(
        'Missing, invalid, expired, inactive, or suspended tenant authentication.',
      ),
    ),
  );
}

function adminController(target: Controller) {
  decorateClass(
    target,
    ApiTags('Platform Administration'),
    ApiBearerAuth(PLATFORM_ADMIN_JWT),
    ApiUnauthorizedResponse(
      error(
        'A valid active Platform Admin JWT is required. Tenant JWTs are rejected.',
      ),
    ),
  );
}

const objectIdParam = () =>
  ApiParam({
    name: 'id',
    schema: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' },
  });

export function applyOpenApiMetadata() {
  if (applied) return;
  applied = true;

  decorateClass(AuthController, ApiTags('Authentication'));
  decorateMethod(
    AuthController,
    'googleAuth',
    ApiOperation({
      summary: 'Start browser-bound Google OAuth sign-in or signup',
    }),
    ApiFoundResponse({
      description:
        'Sets a short-lived HttpOnly state cookie and redirects to Google. The frontend should navigate the browser to this endpoint.',
    }),
    ApiServiceUnavailableResponse(error('Google OAuth is not configured.')),
  );
  decorateMethod(
    AuthController,
    'googleRedirect',
    ApiOperation({
      summary: 'Validate Google OAuth callback and issue an exchange code',
    }),
    ApiFoundResponse({
      description:
        'After single-use state validation, redirects existing users to sign-in or new users to registration with a short-lived opaque code in the URL fragment, never a JWT.',
    }),
    ApiServiceUnavailableResponse(error('Google OAuth is not configured.')),
    ApiUnauthorizedResponse(
      error(
        'The Google identity is not registered or its company is unavailable.',
      ),
    ),
  );
  decorateMethod(
    AuthController,
    'googleExchange',
    ApiOperation({
      summary: 'Exchange a single-use Google sign-in code for a tenant JWT',
    }),
    ApiBody({ type: GoogleExchangeDto }),
    ApiBadRequestResponse(error('The exchange code has an invalid format.')),
    ApiOkResponse({
      description:
        'Tenant JWT issued after current account and company checks.',
      schema: apiSchemas.accessToken,
    }),
    ApiUnauthorizedResponse(
      error('Invalid, expired, consumed, or unavailable Google sign-in.'),
    ),
    ApiForbiddenResponse(error('HTTPS is required in production.')),
    ApiServiceUnavailableResponse(error('Google OAuth is not configured.')),
    ApiTooManyRequestsResponse(error('Too many Google sign-in exchanges.')),
  );
  decorateMethod(
    AuthController,
    'googleRegister',
    ApiOperation({ summary: 'Finish Google signup with company details' }),
    ApiBody({ type: GoogleRegistrationDto }),
    ApiOkResponse({ schema: apiSchemas.accessToken }),
    ApiBadRequestResponse(error('Company details or code failed validation.')),
    ApiUnauthorizedResponse(
      error('Google registration code expired or was used.'),
    ),
    ApiConflictResponse(error('The email or company name is unavailable.')),
    ApiForbiddenResponse(error('HTTPS is required in production.')),
    ApiTooManyRequestsResponse(error('Too many registration attempts.')),
  );
  decorateMethod(
    AuthController,
    'signIn',
    ApiOperation({ summary: 'Sign in an activated tenant user' }),
    ApiBody({ type: SignInDto }),
    ApiCreatedResponse({
      description: 'Tenant JWT issued.',
      schema: apiSchemas.accessToken,
    }),
    ApiUnauthorizedResponse(
      error('Invalid credentials, unactivated company, or suspended company.'),
    ),
    ApiTooManyRequestsResponse(
      error('Public authentication rate limit exceeded.'),
    ),
  );
  decorateMethod(
    AuthController,
    'forgotPassword',
    ApiOperation({ summary: 'Email a one-time workspace password reset link' }),
    ApiBody({ type: ForgotPasswordDto }),
    ApiAcceptedResponse({
      description:
        'Generic response regardless of account eligibility or email delivery.',
      schema: apiSchemas.message,
    }),
    ApiBadRequestResponse(error('Email address failed validation.')),
    ApiTooManyRequestsResponse(error('Recovery request rate limit exceeded.')),
  );
  decorateMethod(
    AuthController,
    'resetPassword',
    ApiOperation({
      summary: 'Reset a workspace password with a one-time link',
    }),
    ApiBody({ type: ResetPasswordDto }),
    ApiOkResponse({
      description: 'Password updated and earlier tenant sessions invalidated.',
      schema: {
        type: 'object',
        required: ['reset'],
        properties: { reset: { type: 'boolean', enum: [true] } },
      },
    }),
    ApiBadRequestResponse(error('Reset token or password failed validation.')),
    ApiUnauthorizedResponse(
      error('Reset link is invalid, expired, or already used.'),
    ),
    ApiTooManyRequestsResponse(error('Reset rate limit exceeded.')),
  );
  decorateMethod(
    AuthController,
    'signUp',
    ApiOperation({ summary: 'Register a company and its owner' }),
    ApiBody({ type: SignUpDto }),
    ApiAcceptedResponse({
      description: 'Registration saved and activation email requested.',
      schema: apiSchemas.message,
    }),
    ApiBadRequestResponse(error('Registration data failed validation.')),
    ApiConflictResponse(error('The email or company name is unavailable.')),
    ApiServiceUnavailableResponse(
      error(
        'Registration was saved but the activation email could not be delivered.',
      ),
    ),
    ApiTooManyRequestsResponse(
      error('Public authentication rate limit exceeded.'),
    ),
  );
  decorateMethod(
    AuthController,
    'verifyAccount',
    ApiOperation({ summary: 'Activate a registered company account' }),
    ApiBody({ type: VerifyAccountDto }),
    ApiOkResponse({ schema: apiSchemas.message }),
    ApiBadRequestResponse(
      error('Activation token is invalid, expired, or unusable.'),
    ),
    ApiTooManyRequestsResponse(
      error('Public authentication rate limit exceeded.'),
    ),
  );
  decorateMethod(
    AuthController,
    'resendVerification',
    ApiOperation({ summary: 'Request another account activation email' }),
    ApiBody({ type: ResendVerificationDto }),
    ApiAcceptedResponse({
      description: 'Generic anti-enumeration response.',
      schema: apiSchemas.message,
    }),
    ApiTooManyRequestsResponse(error('Resend rate limit exceeded.')),
  );
  decorateMethod(
    AuthController,
    'currentUser',
    ApiOperation({ summary: 'Read the authenticated tenant user' }),
    ApiBearerAuth(TENANT_JWT),
    ApiOkResponse({ schema: apiSchemas.user }),
    ApiUnauthorizedResponse(error('Tenant authentication is required.')),
  );

  tenantController(UsersController, 'Tenant Users');
  decorateMethod(
    UsersController,
    'findAll',
    ApiOperation({ summary: 'List company users (company owner only)' }),
    ApiOkResponse({ schema: apiResponses.users }),
    ApiForbiddenResponse(error('Company owner access is required.')),
  );
  decorateMethod(
    UsersController,
    'findOne',
    ApiOperation({ summary: 'Read an authorized company user profile' }),
    objectIdParam(),
    ApiOkResponse({ schema: apiSchemas.user }),
    ApiForbiddenResponse(
      error('Members may read only their own user profile.'),
    ),
    ApiNotFoundResponse(error('User not found in the authenticated tenant.')),
  );
  decorateMethod(
    UsersController,
    'changePassword',
    ApiOperation({ summary: 'Change the authenticated user password' }),
    ApiOkResponse({ schema: apiSchemas.message }),
    ApiBadRequestResponse(
      error('The replacement password is invalid or unchanged.'),
    ),
    ApiUnauthorizedResponse(
      error(
        'Current password is incorrect or tenant authentication is unavailable.',
      ),
    ),
  );
  decorateMethod(
    UsersController,
    'update',
    ApiOperation({ summary: 'Update an authorized user profile' }),
    objectIdParam(),
    ApiOkResponse({ schema: apiSchemas.user }),
    ApiForbiddenResponse(error('Members may update only their own profile.')),
    ApiNotFoundResponse(error('User not found in the authenticated tenant.')),
  );
  decorateMethod(
    UsersController,
    'remove',
    ApiOperation({ summary: 'Delete a company employee (company owner only)' }),
    objectIdParam(),
    ApiOkResponse({ schema: apiSchemas.user }),
    ApiBadRequestResponse(error('The company owner cannot be deleted.')),
    ApiForbiddenResponse(error('Company owner access is required.')),
    ApiNotFoundResponse(
      error('Employee not found in the authenticated tenant.'),
    ),
  );

  tenantController(CompaniesController, 'Companies');
  decorateMethod(
    CompaniesController,
    'findCurrent',
    ApiOperation({ summary: 'Read the authenticated company profile' }),
    ApiOkResponse({ schema: apiSchemas.company }),
  );
  decorateMethod(
    CompaniesController,
    'updateCurrent',
    ApiOperation({
      summary: 'Update the company profile (company owner only)',
    }),
    ApiOkResponse({ schema: apiSchemas.company }),
    ApiForbiddenResponse(error('Company owner access is required.')),
    ApiConflictResponse(error('Company name is unavailable.')),
  );

  decorateClass(PlansController, ApiTags('Plans'));
  decorateMethod(
    PlansController,
    'findAll',
    ApiOperation({ summary: 'List the public DataVault plan catalog' }),
    ApiOkResponse({ schema: apiResponses.plans }),
  );

  tenantController(SubscriptionsController, 'Subscriptions and Billing');
  decorateMethod(
    SubscriptionsController,
    'getCurrent',
    ApiOperation({
      summary: 'Read the company subscription and current usage',
    }),
    ApiOkResponse({ schema: apiResponses.currentSubscription }),
    ApiNotFoundResponse(error('Company subscription not found.')),
  );
  decorateMethod(
    SubscriptionsController,
    'changePlan',
    ApiOperation({
      summary: 'Change or request a company plan (company owner only)',
    }),
    ApiOkResponse({
      description:
        'Returns the current subscription view when payments are disabled, or the Stripe plan-change state when enabled.',
      schema: {
        oneOf: [apiResponses.currentSubscription, apiResponses.planChange],
      },
    }),
    ApiForbiddenResponse(
      error('Owner access, plan limits, or payment state prevents the change.'),
    ),
    ApiConflictResponse(
      error('A concurrent or pending plan change prevents this request.'),
    ),
  );
  decorateMethod(
    SubscriptionsController,
    'getBilling',
    ApiOperation({
      summary: 'Read the current activation-anchored billing estimate',
    }),
    ApiOkResponse({
      description:
        'Internal product billing estimate; not a payment receipt or invoice.',
      schema: apiSchemas.billingSummary,
    }),
  );

  decorateClass(InvitationsController, ApiTags('Employee Invitations'));
  decorateMethod(
    InvitationsController,
    'accept',
    ApiOperation({ summary: 'Accept an employee invitation' }),
    ApiBody({ type: AcceptInvitationDto }),
    ApiOkResponse({ schema: apiSchemas.message }),
    ApiBadRequestResponse(
      error('Invitation is invalid, expired, revoked, or unavailable.'),
    ),
    ApiConflictResponse(error('The employee account cannot be created.')),
    ApiTooManyRequestsResponse(
      error('Invitation acceptance rate limit exceeded.'),
    ),
  );
  for (const name of ['invite', 'findPending', 'resend', 'revoke'])
    decorateMethod(
      InvitationsController,
      name,
      ApiBearerAuth(TENANT_JWT),
      ApiUnauthorizedResponse(error('Tenant authentication is required.')),
      ApiForbiddenResponse(error('Company owner access is required.')),
    );
  decorateMethod(
    InvitationsController,
    'invite',
    ApiOperation({ summary: 'Invite an employee (company owner only)' }),
    ApiBody({ type: InviteEmployeeDto }),
    ApiAcceptedResponse({ schema: apiResponses.invitationCreated }),
    ApiConflictResponse(error('The email is unavailable.')),
    ApiServiceUnavailableResponse(
      error('Invitation was saved but its email could not be delivered.'),
    ),
  );
  decorateMethod(
    InvitationsController,
    'findPending',
    ApiOperation({
      summary: 'List pending company invitations (company owner only)',
    }),
    ApiOkResponse({ schema: apiResponses.invitations }),
  );
  decorateMethod(
    InvitationsController,
    'resend',
    ApiOperation({
      summary: 'Safely resend a pending invitation (company owner only)',
    }),
    objectIdParam(),
    ApiAcceptedResponse({
      description: 'Generic anti-enumeration response.',
      schema: apiSchemas.message,
    }),
  );
  decorateMethod(
    InvitationsController,
    'revoke',
    ApiOperation({
      summary: 'Revoke a pending invitation (company owner only)',
    }),
    objectIdParam(),
    ApiOkResponse({ schema: apiSchemas.message }),
    ApiNotFoundResponse(
      error('Invitation not found in the authenticated tenant.'),
    ),
  );

  tenantController(FilesController, 'Company Files');
  decorateMethod(
    FilesController,
    'upload',
    ApiOperation({
      summary: 'Upload a tenant file with visibility permissions',
    }),
    ApiConsumes('multipart/form-data'),
    ApiBody({
      schema: {
        type: 'object',
        required: ['file'],
        properties: {
          file: {
            type: 'string',
            format: 'binary',
            description:
              'Non-empty CSV, XLS, or XLSX file within FILE_MAX_SIZE_BYTES.',
          },
          visibility: {
            type: 'string',
            enum: Object.values(CompanyFileVisibility),
            default: CompanyFileVisibility.COMPANY_WIDE,
          },
          restrictedUserIds: {
            type: 'array',
            items: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' },
            description:
              'Same-company employee IDs. Required for restricted visibility and empty for company-wide visibility.',
          },
        },
      },
    }),
    ApiCreatedResponse({ schema: apiSchemas.file }),
    ApiBadRequestResponse(
      error('File, MIME/signature, filename, or permission validation failed.'),
    ),
    ApiForbiddenResponse(
      error('The upload entitlement or tenant permission check failed.'),
    ),
    ApiResponse({ status: 413, ...error('File exceeds FILE_MAX_SIZE_BYTES.') }),
  );
  decorateMethod(
    FilesController,
    'findAll',
    ApiOperation({
      summary: 'List files visible to the authenticated tenant user',
    }),
    ApiOkResponse({ schema: apiResponses.files }),
  );
  decorateMethod(
    FilesController,
    'download',
    ApiOperation({ summary: 'Download an authorized private file' }),
    objectIdParam(),
    ApiProduces(
      'text/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ),
    ApiOkResponse({
      description: 'Private file bytes with attachment Content-Disposition.',
      schema: { type: 'string', format: 'binary' },
    }),
    ApiNotFoundResponse(
      error('File is absent or not visible to this tenant user.'),
    ),
  );
  decorateMethod(
    FilesController,
    'findOne',
    ApiOperation({ summary: 'Read authorized file metadata' }),
    objectIdParam(),
    ApiOkResponse({ schema: apiSchemas.file }),
    ApiNotFoundResponse(
      error('File is absent or not visible to this tenant user.'),
    ),
  );
  decorateMethod(
    FilesController,
    'updatePermissions',
    ApiOperation({ summary: 'Change file visibility and selected employees' }),
    objectIdParam(),
    ApiOkResponse({ schema: apiSchemas.file }),
    ApiBadRequestResponse(
      error('Visibility or selected employee validation failed.'),
    ),
    ApiForbiddenResponse(
      error('Only the uploader or company owner may change permissions.'),
    ),
    ApiNotFoundResponse(error('File not found in the authenticated tenant.')),
  );
  decorateMethod(
    FilesController,
    'delete',
    ApiOperation({ summary: 'Delete a file and its private stored object' }),
    objectIdParam(),
    ApiOkResponse({ schema: apiSchemas.message }),
    ApiForbiddenResponse(
      error('Only the uploader or company owner may delete the file.'),
    ),
    ApiNotFoundResponse(error('File not found or not visible.')),
  );

  tenantController(StatisticsController, 'Statistics');
  decorateMethod(
    StatisticsController,
    'getCurrent',
    ApiOperation({
      summary: 'Read the authenticated company dashboard statistics',
    }),
    ApiOkResponse({ schema: apiResponses.statistics }),
  );

  tenantController(PaymentsController, 'Stripe Test Mode Payments');
  decorateClass(
    PaymentsController,
    ApiForbiddenResponse(error('Company owner access is required.')),
    ApiServiceUnavailableResponse(
      error('Stripe Test Mode is disabled or temporarily unavailable.'),
    ),
  );
  decorateMethod(
    PaymentsController,
    'checkout',
    ApiOperation({
      summary: 'Create or resume hosted Checkout setup for a paid plan',
    }),
    ApiCreatedResponse({ schema: apiResponses.checkout }),
    ApiBadRequestResponse(
      error('Free does not require Checkout or the plan is invalid.'),
    ),
    ApiConflictResponse(
      error('Existing Checkout or subscription state prevents creation.'),
    ),
  );
  decorateMethod(
    PaymentsController,
    'portal',
    ApiOperation({ summary: 'Open the restricted Stripe Customer Portal' }),
    ApiCreatedResponse({ schema: apiResponses.portal }),
  );
  decorateMethod(
    PaymentsController,
    'current',
    ApiOperation({
      summary: 'Read Stripe Test Mode payment and invoice state',
    }),
    ApiOkResponse({ schema: apiSchemas.paymentCurrent }),
  );
  decorateMethod(
    PaymentsController,
    'plan',
    ApiOperation({ summary: 'Request a Stripe-managed plan change' }),
    ApiCreatedResponse({ schema: apiResponses.planChange }),
    ApiConflictResponse(
      error('Pending state or target-plan constraints prevent the change.'),
    ),
  );
  decorateMethod(
    PaymentsController,
    'cancel',
    ApiOperation({
      summary: 'Request a change to Free at the billing-period boundary',
    }),
    ApiCreatedResponse({ schema: apiResponses.planChange }),
    ApiConflictResponse(
      error('Plan constraints or pending state prevent cancellation.'),
    ),
  );
  decorateMethod(
    PaymentsController,
    'reconcile',
    ApiOperation({
      summary: 'Reconcile the company payment state with Stripe Test Mode',
    }),
    ApiCreatedResponse({ schema: apiSchemas.paymentCurrent }),
    ApiTooManyRequestsResponse(
      error('Payment reconciliation rate limit exceeded.'),
    ),
  );

  decorateClass(StripeWebhookController, ApiTags('Stripe Webhooks'));
  decorateMethod(
    StripeWebhookController,
    'webhook',
    ApiOperation({ summary: 'Receive a signed Stripe Test Mode webhook' }),
    ApiHeader({
      name: 'stripe-signature',
      required: true,
      description: 'Stripe webhook signature.',
    }),
    ApiBody({
      schema: {
        type: 'string',
        format: 'binary',
        description:
          'Opaque raw Stripe event body used for signature verification.',
      },
    }),
    ApiOkResponse({ schema: apiResponses.webhook }),
    ApiBadRequestResponse(
      error('Signature or Test Mode event validation failed.'),
    ),
    ApiServiceUnavailableResponse(
      error(
        'A retryable synchronization failure requires Stripe delivery retry.',
      ),
    ),
  );

  decorateClass(AdminAuthController, ApiTags('Platform Admin Authentication'));
  decorateMethod(
    AdminAuthController,
    'login',
    ApiOperation({ summary: 'Authenticate a Platform Administrator' }),
    ApiOkResponse({
      description: 'Platform Admin JWT issued.',
      schema: apiSchemas.accessToken,
    }),
    ApiUnauthorizedResponse(
      error('Invalid or inactive Platform Admin credentials.'),
    ),
    ApiServiceUnavailableResponse(
      error('Authentication could not be safely audit-logged.'),
    ),
    ApiTooManyRequestsResponse(
      error('Platform Admin login rate limit exceeded.'),
    ),
  );
  decorateMethod(
    AdminAuthController,
    'forgotPassword',
    ApiOperation({
      summary: 'Email a one-time Platform Admin password reset link',
    }),
    ApiOkResponse({
      description: 'Generic response for all valid email addresses.',
    }),
    ApiTooManyRequestsResponse(error('Password recovery rate limit exceeded.')),
  );
  decorateMethod(
    AdminAuthController,
    'resetPassword',
    ApiOperation({
      summary: 'Reset a Platform Admin password with a one-time link',
    }),
    ApiOkResponse({
      description: 'Password changed and older sessions invalidated.',
    }),
    ApiUnauthorizedResponse(error('Reset link is invalid or expired.')),
    ApiTooManyRequestsResponse(error('Password reset rate limit exceeded.')),
  );

  adminController(AdminController);
  decorateMethod(
    AdminController,
    'dashboard',
    ApiOperation({ summary: 'Read global operational dashboard metrics' }),
    ApiOkResponse({ schema: apiResponses.adminDashboard }),
  );
  decorateMethod(
    AdminController,
    'companies',
    ApiOperation({ summary: 'Search and filter companies' }),
    ApiOkResponse({ schema: apiResponses.adminCompanies }),
  );
  decorateMethod(
    AdminController,
    'company',
    ApiOperation({ summary: 'Read a sanitized company operational detail' }),
    objectIdParam(),
    ApiOkResponse({ schema: apiResponses.adminCompanyDetail }),
    ApiNotFoundResponse(error('Company not found.')),
  );
  decorateMethod(
    AdminController,
    'suspend',
    ApiOperation({
      summary: 'Suspend a company without changing tenant data or billing',
    }),
    objectIdParam(),
    ApiOkResponse({ schema: apiResponses.adminStatus }),
    ApiConflictResponse(
      error('Company is already suspended or changed concurrently.'),
    ),
    ApiNotFoundResponse(error('Company not found.')),
  );
  decorateMethod(
    AdminController,
    'reactivate',
    ApiOperation({ summary: 'Reactivate a suspended company' }),
    objectIdParam(),
    ApiOkResponse({ schema: apiResponses.adminStatus }),
    ApiConflictResponse(
      error('Company is already active or changed concurrently.'),
    ),
    ApiNotFoundResponse(error('Company not found.')),
  );
  decorateMethod(
    AdminController,
    'users',
    ApiOperation({ summary: 'Search sanitized tenant-user metadata' }),
    ApiOkResponse({ schema: apiResponses.adminUsers }),
  );
  decorateMethod(
    AdminController,
    'files',
    ApiOperation({
      summary: 'Search tenant file metadata without file-content access',
    }),
    ApiOkResponse({ schema: apiResponses.adminFiles }),
  );
  decorateMethod(
    AdminController,
    'audit',
    ApiOperation({ summary: 'Read append-only Platform Admin audit records' }),
    ApiOkResponse({ schema: apiResponses.adminAudits }),
  );

  decorateClass(HealthController, ApiTags('Health'));
  decorateMethod(
    HealthController,
    'liveness',
    ApiOperation({ summary: 'Check process liveness' }),
    ApiOkResponse({ schema: apiResponses.healthLive }),
  );
  decorateMethod(
    HealthController,
    'readiness',
    ApiOperation({ summary: 'Check MongoDB readiness' }),
    ApiOkResponse({ schema: apiResponses.healthReady }),
    ApiServiceUnavailableResponse({
      description: 'MongoDB is unavailable.',
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['unavailable'] },
          dependencies: {
            type: 'object',
            properties: { mongodb: { type: 'string', enum: ['down'] } },
          },
        },
      },
    }),
  );

  tenantController(AiController, 'AI Assistant');
  decorateMethod(
    AiController,
    'chat',
    ApiOperation({
      summary: 'Create or continue a tenant-owned AI conversation',
      description:
        'Model selection is server-controlled. DataVault tools are read-only and authorized using the authenticated tenant user; clients cannot submit tool results, tenant scope, or model IDs.',
    }),
    ApiBody({ type: AiChatDto }),
    ApiOkResponse({ schema: apiResponses.aiChat }),
    ApiBadRequestResponse(
      error('Message or conversation input failed validation.'),
    ),
    ApiConflictResponse(
      error('Conversation is busy or has reached a configured bound.'),
    ),
    ApiTooManyRequestsResponse(
      error('Per-user or per-company AI rate limit exceeded.'),
    ),
    ApiBadGatewayResponse(
      error('Provider response or requested tool call was invalid.'),
    ),
    ApiServiceUnavailableResponse(
      error(
        'AI is disabled, unavailable, rate-limited, or lacks provider credits.',
      ),
    ),
    ApiGatewayTimeoutResponse(
      error('The configured AI request timeout elapsed.'),
    ),
    ApiInternalServerErrorResponse(
      error('A correlated internal AI failure occurred.'),
    ),
  );
  decorateMethod(
    AiController,
    'list',
    ApiOperation({ summary: 'List the authenticated user’s AI conversations' }),
    ApiOkResponse({ schema: apiResponses.aiConversations }),
  );
  decorateMethod(
    AiController,
    'get',
    ApiOperation({
      summary: 'Read one owned AI conversation and visible history',
    }),
    objectIdParam(),
    ApiOkResponse({ schema: apiResponses.aiConversationDetail }),
    ApiNotFoundResponse(error('Conversation not found for this tenant user.')),
  );
  decorateMethod(
    AiController,
    'delete',
    ApiOperation({ summary: 'Delete owned conversation content' }),
    objectIdParam(),
    ApiOkResponse({
      description:
        'Visible conversation/messages are deleted; content-free usage accounting is retained.',
      schema: apiSchemas.message,
    }),
    ApiConflictResponse(
      error('Conversation is currently processing a request.'),
    ),
    ApiNotFoundResponse(error('Conversation not found for this tenant user.')),
  );
}
