import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';
import { AwsS3Service } from './aws-s3.service';

describe('AwsS3Service', () => {
  const send = jest.spyOn(S3Client.prototype, 'send');
  const logError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  const service = new AwsS3Service(
    new ConfigService({
      AWS_BUCKET_NAME: 'private-bucket',
      AWS_REGION: 'us-east-1',
    }),
  );

  beforeEach(() => send.mockReset());

  afterAll(() => {
    send.mockRestore();
    logError.mockRestore();
  });

  it('stores private objects using the supplied server-side key', async () => {
    send.mockResolvedValueOnce({} as never);
    await service.putObject({
      key: 'companies/company/files/id.csv',
      body: Buffer.from('a,b'),
      contentType: 'text/csv',
    });
    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect((command as PutObjectCommand).input).toMatchObject({
      Bucket: 'private-bucket',
      Key: 'companies/company/files/id.csv',
      ContentType: 'text/csv',
    });
    expect((command as PutObjectCommand).input).not.toHaveProperty('ACL');
  });

  it('returns an S3 stream and deletes through private object commands', async () => {
    const stream = Readable.from('a,b');
    send
      .mockResolvedValueOnce({ Body: stream, ContentLength: 3 } as never)
      .mockResolvedValueOnce({} as never);
    await expect(service.getObject('private-key')).resolves.toEqual({
      stream,
      contentLength: 3,
    });
    await service.deleteObject('private-key');
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetObjectCommand);
    expect(send.mock.calls[1][0]).toBeInstanceOf(DeleteObjectCommand);
  });

  it('fails closed when storage is unavailable or unconfigured', async () => {
    send.mockRejectedValueOnce(new Error('AWS failure') as never);
    await expect(
      service.putObject({
        key: 'key',
        body: Buffer.from('x'),
        contentType: 'text/csv',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    const unconfigured = new AwsS3Service(new ConfigService({}));
    await expect(unconfigured.getObject('key')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
