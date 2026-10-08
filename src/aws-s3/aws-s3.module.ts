import { Module } from '@nestjs/common';
import { AwsS3Service } from './aws-s3.service';
import { ObjectStorage } from './object-storage';

@Module({
  providers: [
    AwsS3Service,
    { provide: ObjectStorage, useExisting: AwsS3Service },
  ],
  exports: [ObjectStorage, AwsS3Service],
})
export class AwsS3Module {}
