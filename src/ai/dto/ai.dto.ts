import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateBy,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AiChatDto {
  @ApiPropertyOptional({
    pattern: '^[a-fA-F0-9]{24}$',
    description:
      'Owned conversation to continue. Omit to create a conversation.',
  })
  @IsOptional()
  @IsMongoId()
  conversationId?: string;

  @ApiProperty({
    minLength: 1,
    maxLength: 50_000,
    description: 'User-visible message. Model selection is server-controlled.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(50_000)
  @ValidateBy({
    name: 'nonWhitespaceMessage',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && value.trim().length > 0,
    },
  })
  message: string;
}

export class AiConversationQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 1000, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000)
  page = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 20;
}

export class AiConversationIdDto {
  @ApiProperty({ pattern: '^[a-fA-F0-9]{24}$' })
  @IsMongoId()
  id: string;
}

export class AiEmptyDto {}
