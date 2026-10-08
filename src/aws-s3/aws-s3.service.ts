import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';
import { ObjectStorage, PutObjectInput, StoredObject } from './object-storage';

@Injectable()
export class AwsS3Service implements ObjectStorage {
  private readonly storageService: S3Client;
  private readonly bucketName?: string;
  private readonly logger = new Logger(AwsS3Service.name);

  constructor(private readonly config: ConfigService) {
    this.bucketName = config.get<string>('AWS_BUCKET_NAME');
    const accessKeyId = config.get<string>('AWS_ACCESS_KEY_ID');
    this.storageService = new S3Client({
      region: config.get<string>('AWS_REGION'),
      // Use IAM roles/default credential chain when no explicit credentials are supplied.
      ...(accessKeyId
        ? {
            credentials: {
              accessKeyId,
              secretAccessKey: config.getOrThrow<string>(
                'AWS_SECRET_ACCESS_KEY',
              ),
              sessionToken:
                config.get<string>('AWS_SESSION_TOKEN') || undefined,
            },
          }
        : {}),
    });
  }

  async putObject(input: PutObjectInput): Promise<void> {
    this.requireStorage();
    try {
      await this.storageService.send(
        new PutObjectCommand({
          Key: input.key,
          Bucket: this.bucketName,
          Body: input.body,
          ContentType: input.contentType,
        }),
      );
    } catch {
      this.logger.error('S3 upload failed');
      throw new ServiceUnavailableException('Could not upload file');
    }
  }

  async getObject(key: string): Promise<StoredObject> {
    this.requireStorage();
    try {
      const result = await this.storageService.send(
        new GetObjectCommand({ Bucket: this.bucketName, Key: key }),
      );
      if (!(result.Body instanceof Readable)) throw new Error('Missing body');
      return {
        stream: result.Body,
        contentLength: result.ContentLength,
      };
    } catch {
      this.logger.error('S3 download failed');
      throw new ServiceUnavailableException('Could not download file');
    }
  }

  async deleteObject(key: string): Promise<void> {
    this.requireStorage();
    try {
      await this.storageService.send(
        new DeleteObjectCommand({ Bucket: this.bucketName, Key: key }),
      );
    } catch {
      this.logger.error('S3 deletion failed');
      throw new ServiceUnavailableException('Could not delete file');
    }
  }

  private requireStorage() {
    if (!this.bucketName)
      throw new ServiceUnavailableException('S3 storage is not configured');
  }
}
