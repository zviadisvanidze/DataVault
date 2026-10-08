import { Transform } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsEnum,
  IsMongoId,
  IsOptional,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CompanyFileVisibility } from '../entities/company-file.entity';

const parseEmployeeIds = ({ value }: { value: unknown }) => {
  if (Array.isArray(value) || value === undefined) return value;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('[')) return [trimmed];
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
};

export class UploadFilePermissionsDto {
  @ApiProperty({
    enum: CompanyFileVisibility,
    default: CompanyFileVisibility.COMPANY_WIDE,
  })
  @IsEnum(CompanyFileVisibility)
  visibility: CompanyFileVisibility = CompanyFileVisibility.COMPANY_WIDE;

  @ApiProperty({
    type: [String],
    default: [],
    description:
      'MongoDB user IDs from the authenticated company. In multipart requests this may be a JSON array string or a repeated/string field.',
  })
  @Transform(parseEmployeeIds)
  @IsArray()
  @ArrayUnique()
  @IsMongoId({ each: true })
  restrictedUserIds: string[] = [];
}

export class UpdateFilePermissionsDto {
  @ApiProperty({ enum: CompanyFileVisibility })
  @IsEnum(CompanyFileVisibility)
  visibility: CompanyFileVisibility;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Required to contain at least one valid tenant employee for restricted visibility.',
  })
  @IsOptional()
  @Transform(parseEmployeeIds)
  @IsArray()
  @ArrayUnique()
  @IsMongoId({ each: true })
  restrictedUserIds?: string[];
}
