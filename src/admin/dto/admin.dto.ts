import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateBy,
} from 'class-validator';
import {
  CompanyPlatformReason,
  CompanyPlatformStatus,
} from '../../companies/platform-status';
import { Role } from '../../enums/roles.enum';
import {
  CompanyFileType,
  CompanyFileVisibility,
} from '../../files/entities/company-file.entity';
import { PaymentAccess } from '../../payments/payment.constants';
import { PlanCode } from '../../plans/plan.constants';
import { AdminAuditAction } from '../entities/admin-audit.entity';
import { NewPassword } from '../../common/password-policy';

export class AdminLoginDto {
  @ApiProperty({ format: 'email', minLength: 3, maxLength: 254 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @Length(3, 254)
  email: string;

  @ApiProperty({ minLength: 1, maxLength: 72, writeOnly: true })
  @IsString()
  @Length(1, 72)
  @ValidateBy({
    name: 'bcryptByteLimit',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 72,
    },
  })
  password: string;
}

export class AdminForgotPasswordDto {
  @ApiProperty({ format: 'email', minLength: 3, maxLength: 254 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @Length(3, 254)
  email: string;
}

export class AdminResetPasswordDto {
  @ApiProperty({ minLength: 43, maxLength: 43, writeOnly: true })
  @IsString()
  @ValidateBy({
    name: 'adminResetToken',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value),
    },
  })
  token: string;

  @ApiProperty({ minLength: 12, maxLength: 72, writeOnly: true })
  @IsString()
  @NewPassword()
  newPassword: string;
}

export class AdminEmptyDto {}

export class AdminPaginationDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 1000, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  page = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 25;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order: 'asc' | 'desc' = 'desc';
}

export class AdminCompanyQueryDto extends AdminPaginationDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 80 })
  @IsOptional()
  @IsString()
  @Length(1, 80)
  search?: string;
  @ApiPropertyOptional({
    enum: ['createdAt', 'name', 'updatedAt'],
    default: 'createdAt',
  })
  @IsOptional()
  @IsIn(['createdAt', 'name', 'updatedAt'])
  sortBy: 'createdAt' | 'name' | 'updatedAt' = 'createdAt';
  @ApiPropertyOptional({ enum: ['activated', 'pending'] })
  @IsOptional()
  @IsIn(['activated', 'pending'])
  activation?: 'activated' | 'pending';
  @ApiPropertyOptional({ enum: CompanyPlatformStatus })
  @IsOptional()
  @IsEnum(CompanyPlatformStatus)
  status?: CompanyPlatformStatus;
  @ApiPropertyOptional({ enum: PlanCode })
  @IsOptional()
  @IsEnum(PlanCode)
  plan?: PlanCode;
  @ApiPropertyOptional({ enum: PaymentAccess })
  @IsOptional()
  @IsEnum(PaymentAccess)
  paymentAccess?: PaymentAccess;
  @ApiPropertyOptional({ enum: ['true', 'false'] })
  @IsOptional()
  @IsIn(['true', 'false'])
  stripeManaged?: 'true' | 'false';
}

export class AdminUserQueryDto extends AdminPaginationDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 80 })
  @IsOptional()
  @IsString()
  @Length(1, 80)
  search?: string;
  @ApiPropertyOptional({ pattern: '^[a-fA-F0-9]{24}$' })
  @IsOptional()
  @IsMongoId()
  companyId?: string;
  @ApiPropertyOptional({ enum: Role })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;
  @ApiPropertyOptional({
    enum: ['createdAt', 'email', 'fullName'],
    default: 'createdAt',
  })
  @IsOptional()
  @IsIn(['createdAt', 'email', 'fullName'])
  sortBy: 'createdAt' | 'email' | 'fullName' = 'createdAt';
}

export class AdminFileQueryDto extends AdminPaginationDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 80 })
  @IsOptional()
  @IsString()
  @Length(1, 80)
  search?: string;
  @ApiPropertyOptional({ pattern: '^[a-fA-F0-9]{24}$' })
  @IsOptional()
  @IsMongoId()
  companyId?: string;
  @ApiPropertyOptional({ enum: CompanyFileVisibility })
  @IsOptional()
  @IsEnum(CompanyFileVisibility)
  visibility?: CompanyFileVisibility;
  @ApiPropertyOptional({ enum: CompanyFileType })
  @IsOptional()
  @IsEnum(CompanyFileType)
  fileType?: CompanyFileType;
  @ApiPropertyOptional({
    enum: ['createdAt', 'originalFilename', 'size'],
    default: 'createdAt',
  })
  @IsOptional()
  @IsIn(['createdAt', 'originalFilename', 'size'])
  sortBy: 'createdAt' | 'originalFilename' | 'size' = 'createdAt';
}

export class AdminAuditQueryDto extends AdminPaginationDto {
  @ApiPropertyOptional({ enum: AdminAuditAction })
  @IsOptional()
  @IsEnum(AdminAuditAction)
  action?: AdminAuditAction;
  @ApiPropertyOptional({ pattern: '^[a-fA-F0-9]{24}$' })
  @IsOptional()
  @IsMongoId()
  actorId?: string;
  @ApiPropertyOptional({ pattern: '^[a-fA-F0-9]{24}$' })
  @IsOptional()
  @IsMongoId()
  targetId?: string;
}

export class AdminCompanyIdDto {
  @ApiProperty({ pattern: '^[a-fA-F0-9]{24}$' })
  @IsMongoId()
  id: string;
}

export class SuspendCompanyDto {
  @ApiProperty({
    enum: [
      CompanyPlatformReason.SECURITY_REVIEW,
      CompanyPlatformReason.POLICY_REVIEW,
      CompanyPlatformReason.OPERATIONAL_HOLD,
    ],
  })
  @IsIn([
    CompanyPlatformReason.SECURITY_REVIEW,
    CompanyPlatformReason.POLICY_REVIEW,
    CompanyPlatformReason.OPERATIONAL_HOLD,
  ])
  reason: CompanyPlatformReason;
}
