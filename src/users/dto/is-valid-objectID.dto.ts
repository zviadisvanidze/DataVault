import { IsMongoId } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class IsValidMongoDBId {
  @ApiProperty({ pattern: '^[a-fA-F0-9]{24}$' })
  @IsMongoId()
  id: string;
}
