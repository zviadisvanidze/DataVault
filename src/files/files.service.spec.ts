import {
  BadRequestException,
  ForbiddenException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';
import { Types } from 'mongoose';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { Role } from '../enums/roles.enum';
import {
  CompanyFileType,
  CompanyFileVisibility,
} from './entities/company-file.entity';
import { FilesService } from './files.service';

function selectable<T>(value: T) {
  const promise = Promise.resolve(value);
  return Object.assign(promise, { select: jest.fn(() => promise) });
}

function paginated<T>(value: T) {
  return {
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(value),
  };
}

describe('FilesService', () => {
  const logError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  const companyId = new Types.ObjectId();
  const ownerId = new Types.ObjectId();
  const memberId = new Types.ObjectId();
  const fileId = new Types.ObjectId();
  const owner: AuthenticatedUser = {
    id: ownerId.toString(),
    companyId: companyId.toString(),
    role: Role.COMPANY_OWNER,
  };
  const member: AuthenticatedUser = {
    id: memberId.toString(),
    companyId: companyId.toString(),
    role: Role.COMPANY_MEMBER,
  };
  const metadata = {
    _id: fileId,
    companyId,
    uploaderId: memberId,
    originalFilename: 'data.csv',
    storageKey: `companies/${companyId.toString()}/files/test.csv`,
    fileType: CompanyFileType.CSV,
    mimeType: 'text/csv',
    size: 7,
    visibility: CompanyFileVisibility.COMPANY_WIDE,
    restrictedUserIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const model = {
    create: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    findOneAndDelete: jest.fn(),
    countDocuments: jest.fn(),
  };
  const userModel = { countDocuments: jest.fn() };
  const storage = {
    putObject: jest.fn(),
    getObject: jest.fn(),
    deleteObject: jest.fn(),
  };
  const entitlements = {
    checkFileUpload: jest.fn(),
    recordFileUploads: jest.fn(),
  };
  const config = new ConfigService({ FILE_MAX_SIZE_BYTES: 1024 });
  const session = {};
  const connection = {
    transaction: jest.fn((work: (session: object) => unknown) => work(session)),
  };
  const service = new FilesService(
    model as never,
    userModel as never,
    storage,
    entitlements as never,
    config,
    connection as never,
  );
  const csv = {
    originalname: '../data.csv',
    mimetype: 'text/csv',
    buffer: Buffer.from('a,b\n1,2'),
    size: 7,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    entitlements.checkFileUpload.mockResolvedValue({
      allowed: true,
      includedFilesPerMonth: 10,
    });
    entitlements.recordFileUploads.mockResolvedValue({});
    model.create.mockResolvedValue([metadata]);
    model.findOneAndDelete.mockResolvedValue(metadata);
    model.findOneAndUpdate.mockResolvedValue(metadata);
    userModel.countDocuments.mockResolvedValue(1);
    storage.putObject.mockResolvedValue(undefined);
    storage.getObject.mockResolvedValue({
      stream: Readable.from('a,b\n1,2'),
      contentLength: 7,
    });
    storage.deleteObject.mockResolvedValue(undefined);
  });

  afterAll(() => logError.mockRestore());

  it('uses a server-generated tenant key and atomically records metadata and usage', async () => {
    const result = await service.upload(member, csv);
    const putCalls = storage.putObject.mock.calls as unknown as [
      [
        {
          key: string;
          contentType: string;
        },
      ],
    ];
    const putCall = putCalls[0][0];
    expect(putCall.key).toMatch(
      new RegExp(`^companies/${companyId.toString()}/files/[0-9a-f-]+\\.csv$`),
    );
    expect(putCall.key).not.toContain('data.csv');
    expect(entitlements.recordFileUploads).toHaveBeenCalledWith(
      member.companyId,
      1,
      expect.any(Date),
      session,
    );
    const createCalls = model.create.mock.calls as unknown as [
      [[Record<string, unknown>]],
    ];
    const input = createCalls[0][0][0];
    expect(input).toMatchObject({
      companyId: member.companyId,
      uploaderId: member.id,
      storageKey: putCall.key,
      originalFilename: 'data.csv',
      visibility: CompanyFileVisibility.COMPANY_WIDE,
      restrictedUserIds: [],
    });
    expect(result).not.toHaveProperty('storageKey');
  });

  it('records an upload in the period when storage succeeds across an anniversary', async () => {
    const beforeBoundary = new Date('2026-02-15T11:59:59.900Z');
    const afterBoundary = new Date('2026-02-15T12:00:00.100Z');
    jest.useFakeTimers().setSystemTime(beforeBoundary);
    storage.putObject.mockImplementationOnce(() => {
      jest.setSystemTime(afterBoundary);
      return Promise.resolve();
    });
    try {
      await service.upload(member, csv);
      expect(entitlements.checkFileUpload).toHaveBeenCalledWith(
        member.companyId,
        1,
        beforeBoundary,
      );
      expect(entitlements.recordFileUploads).toHaveBeenCalledWith(
        member.companyId,
        1,
        afterBoundary,
        session,
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not store or count a rejected quota or failed S3 upload', async () => {
    entitlements.checkFileUpload.mockResolvedValue({
      allowed: false,
      includedFilesPerMonth: 10,
    });
    await expect(service.upload(member, csv)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(storage.putObject).not.toHaveBeenCalled();
    expect(entitlements.recordFileUploads).not.toHaveBeenCalled();

    entitlements.checkFileUpload.mockResolvedValue({ allowed: true });
    storage.putObject.mockRejectedValue(
      new ServiceUnavailableException('storage failed'),
    );
    await expect(service.upload(member, csv)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(connection.transaction).not.toHaveBeenCalled();
  });

  it('cleans up the S3 object when quota recording or metadata persistence fails', async () => {
    const databaseError = new Error('database failed');
    model.create.mockRejectedValue(databaseError);
    await expect(service.upload(member, csv)).rejects.toBe(databaseError);
    const putCalls = storage.putObject.mock.calls as unknown as [
      [{ key: string }],
    ];
    const putCall = putCalls[0][0];
    expect(storage.deleteObject).toHaveBeenCalledWith(putCall.key);
  });

  it('preserves the original persistence error when compensation also fails', async () => {
    const databaseError = new Error('database failed');
    model.create.mockRejectedValue(databaseError);
    storage.deleteObject.mockRejectedValue(new Error('cleanup failed'));
    await expect(service.upload(member, csv)).rejects.toBe(databaseError);
    expect(logError).toHaveBeenCalledWith(
      'Could not clean up an uncommitted storage object',
    );
  });

  it('does not delete a committed object when the commit acknowledgement was uncertain', async () => {
    connection.transaction.mockImplementationOnce(
      async (work: (session: object) => unknown) => {
        await work(session);
        throw Object.assign(new Error('uncertain commit'), {
          errorLabels: ['UnknownTransactionCommitResult'],
        });
      },
    );
    model.findOne.mockReturnValue(selectable(metadata));
    await expect(service.upload(member, csv)).resolves.toMatchObject({
      id: fileId,
    });
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it('retains the private object when an uncertain commit is not yet visible', async () => {
    const uncertain = Object.assign(new Error('uncertain commit'), {
      errorLabels: ['UnknownTransactionCommitResult'],
    });
    connection.transaction.mockImplementationOnce(() =>
      Promise.reject(uncertain),
    );
    model.findOne.mockResolvedValue(null);

    await expect(service.upload(member, csv)).rejects.toBe(uncertain);
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(
      'Upload transaction outcome is uncertain; storage object retained for reconciliation',
    );
  });

  it('scopes metadata listing and lookup to the actor company', async () => {
    const query = paginated([metadata]);
    model.find.mockReturnValue(query);
    model.countDocuments.mockResolvedValue(1);
    await expect(
      service.findAll(member, { page: 2, take: 100 }),
    ).resolves.toMatchObject({ total: 1, page: 2, take: 30 });
    expect(model.find).toHaveBeenCalledWith({
      companyId: member.companyId,
      $or: [
        { visibility: CompanyFileVisibility.COMPANY_WIDE },
        { visibility: { $exists: false } },
        { uploaderId: member.id },
        { restrictedUserIds: member.id },
      ],
    });
    expect(query.skip).toHaveBeenCalledWith(30);

    model.findOne.mockReturnValue(selectable(null));
    await expect(
      service.findOne(member, fileId.toString()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('streams a tenant-owned private object without exposing its key', async () => {
    model.findOne.mockReturnValue(selectable(metadata));
    const result = await service.download(member, fileId.toString());
    expect(storage.getObject).toHaveBeenCalledWith(metadata.storageKey);
    expect(result.stream).toBeInstanceOf(Readable);
  });

  it('validates restricted employees in the actor company before uploading', async () => {
    const selectedId = new Types.ObjectId().toString();
    await service.upload(member, csv, {
      visibility: CompanyFileVisibility.RESTRICTED,
      restrictedUserIds: [selectedId],
    });
    expect(userModel.countDocuments).toHaveBeenCalledWith({
      _id: { $in: [selectedId] },
      companyId: member.companyId,
      role: Role.COMPANY_MEMBER,
    });
    expect(model.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          visibility: CompanyFileVisibility.RESTRICTED,
          restrictedUserIds: [selectedId],
        }),
      ],
      { session },
    );

    userModel.countDocuments.mockResolvedValue(0);
    await expect(
      service.upload(member, csv, {
        visibility: CompanyFileVisibility.RESTRICTED,
        restrictedUserIds: [new Types.ObjectId().toString()],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.putObject).toHaveBeenCalledTimes(1);
  });

  it('enforces permission invariants and permits only uploader or owner updates', async () => {
    model.findOne.mockReturnValue(selectable(metadata));
    await expect(
      service.updatePermissions(member, fileId.toString(), {
        visibility: CompanyFileVisibility.RESTRICTED,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.updatePermissions(member, fileId.toString(), {
        visibility: CompanyFileVisibility.COMPANY_WIDE,
        restrictedUserIds: [new Types.ObjectId().toString()],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const selectedId = new Types.ObjectId().toString();
    await service.updatePermissions(owner, fileId.toString(), {
      visibility: CompanyFileVisibility.RESTRICTED,
      restrictedUserIds: [selectedId],
    });
    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: fileId.toString(), companyId: owner.companyId },
      {
        $set: {
          visibility: CompanyFileVisibility.RESTRICTED,
          restrictedUserIds: [selectedId],
        },
      },
      { new: true, runValidators: true },
    );

    const otherMember = { ...member, id: new Types.ObjectId().toString() };
    await expect(
      service.updatePermissions(otherMember, fileId.toString(), {
        visibility: CompanyFileVisibility.COMPANY_WIDE,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows the uploader or owner to delete without reducing usage', async () => {
    model.findOne.mockReturnValue(selectable(metadata));
    model.findOneAndDelete.mockResolvedValue(metadata);
    await service.delete(member, fileId.toString());
    await service.delete(owner, fileId.toString());
    expect(storage.deleteObject).toHaveBeenCalledTimes(2);
    expect(entitlements.recordFileUploads).not.toHaveBeenCalled();
  });

  it('prevents another member from deleting and keeps metadata after S3 failure', async () => {
    const otherMember = { ...member, id: new Types.ObjectId().toString() };
    model.findOne.mockReturnValue(selectable(metadata));
    await expect(
      service.delete(otherMember, fileId.toString()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    storage.deleteObject.mockRejectedValue(
      new ServiceUnavailableException('storage failed'),
    );
    await expect(
      service.delete(member, fileId.toString()),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(model.findOneAndDelete).not.toHaveBeenCalled();
  });

  it('allows retrying metadata deletion after the private object was removed', async () => {
    model.findOne.mockReturnValue(selectable(metadata));
    const databaseError = new Error('metadata deletion failed');
    model.findOneAndDelete.mockRejectedValueOnce(databaseError);
    await expect(service.delete(owner, fileId.toString())).rejects.toBe(
      databaseError,
    );
    await expect(
      service.delete(owner, fileId.toString()),
    ).resolves.toMatchObject({
      message: 'File deleted.',
    });
    expect(storage.deleteObject).toHaveBeenCalledTimes(2);
  });
});
