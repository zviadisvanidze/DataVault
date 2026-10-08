import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { Connection, Model, Types } from 'mongoose';
import { ObjectStorage } from '../aws-s3/object-storage';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { Role } from '../enums/roles.enum';
import { EntitlementsService } from '../subscriptions/entitlements.service';
import { EntitlementDenialReason } from '../subscriptions/subscription.constants';
import { IsValidMongoDBId } from '../users/dto/is-valid-objectID.dto';
import { QueryParams } from '../users/dto/query-params.dto';
import { User } from '../users/entities/user.entity';
import {
  CompanyFile,
  CompanyFileVisibility,
} from './entities/company-file.entity';
import { UploadedCompanyFile, validateCompanyFile } from './file-validation';
import {
  UpdateFilePermissionsDto,
  UploadFilePermissionsDto,
} from './dto/file-permissions.dto';

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    @InjectModel('companyFile')
    private readonly fileModel: Model<CompanyFile>,
    @InjectModel('user') private readonly userModel: Model<User>,
    private readonly storage: ObjectStorage,
    private readonly entitlements: EntitlementsService,
    private readonly config: ConfigService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  async upload(
    actor: AuthenticatedUser,
    upload: UploadedCompanyFile | undefined,
    permissions: UploadFilePermissionsDto = new UploadFilePermissionsDto(),
    now?: Date,
  ) {
    const file = validateCompanyFile(
      upload,
      this.config.getOrThrow<number>('FILE_MAX_SIZE_BYTES'),
    );
    const normalizedPermissions = await this.validatePermissions(
      actor,
      permissions.visibility,
      permissions.restrictedUserIds,
    );
    const availability = await this.entitlements.checkFileUpload(
      actor.companyId,
      1,
      now ?? new Date(),
    );
    if (!availability.allowed)
      throw new ForbiddenException({
        message:
          'The stored file limit has been reached. Delete a file to upload another.',
        reason: EntitlementDenialReason.FILE_LIMIT_REACHED,
        limit: availability.includedFilesPerMonth,
      });

    const storageKey = `companies/${actor.companyId}/files/${randomUUID()}.${file.fileType}`;
    await this.storage.putObject({
      key: storageKey,
      body: file.buffer,
      contentType: file.mimeType,
    });

    try {
      const metadata = await this.connection.transaction(
        async (session) => {
          await this.entitlements.recordFileUploads(
            actor.companyId,
            1,
            now ?? new Date(),
            session,
          );
          const [created] = await this.fileModel.create(
            [
              {
                companyId: actor.companyId,
                uploaderId: actor.id,
                originalFilename: file.originalFilename,
                storageKey,
                fileType: file.fileType,
                mimeType: file.mimeType,
                size: file.size,
                ...normalizedPermissions,
              },
            ],
            { session },
          );
          return created;
        },
        { writeConcern: { w: 'majority' } },
      );
      return this.publicMetadata(metadata);
    } catch (error) {
      if (this.hasUnknownCommitResult(error)) {
        try {
          const committed = await this.fileModel.findOne(
            { companyId: actor.companyId, storageKey },
            null,
            {
              readPreference: 'primary',
              readConcern: { level: 'majority' },
            },
          );
          if (committed) return this.publicMetadata(committed);
        } catch {
          this.logger.error(
            'Could not confirm an uncertain upload transaction',
          );
        }
        // A missing majority read is not proof that an uncertain commit
        // aborted. Retain the private object rather than leave committed
        // metadata pointing at an object that compensation deleted.
        this.logger.error(
          'Upload transaction outcome is uncertain; storage object retained for reconciliation',
        );
        throw error;
      }
      try {
        await this.storage.deleteObject(storageKey);
      } catch {
        this.logger.error('Could not clean up an uncommitted storage object');
      }
      throw error;
    }
  }

  async findAll(actor: AuthenticatedUser, { page, take }: QueryParams) {
    take = Math.min(take, 30);
    const filter = this.accessFilter(actor);
    const [files, total] = await Promise.all([
      this.fileModel
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * take)
        .limit(take),
      this.fileModel.countDocuments(filter),
    ]);
    return {
      files: files.map((file) => this.publicMetadata(file)),
      total,
      page,
      take,
    };
  }

  async findOne(actor: AuthenticatedUser, fileId: string) {
    const file = await this.fileModel.findOne({
      _id: fileId,
      ...this.accessFilter(actor),
    });
    if (!file) throw new NotFoundException('File not found');
    return this.publicMetadata(file);
  }

  async download(actor: AuthenticatedUser, fileId: string) {
    const file = await this.findStoredFile(actor, fileId);
    const stored = await this.storage.getObject(file.storageKey);
    return { file, ...stored };
  }

  async delete(actor: AuthenticatedUser, fileId: string) {
    const file = await this.findStoredFile(actor, fileId);
    if (
      actor.role !== Role.COMPANY_OWNER &&
      file.uploaderId.toString() !== actor.id
    )
      throw new ForbiddenException(
        'Only the uploader or company owner can delete this file',
      );

    await this.storage.deleteObject(file.storageKey);
    const deleted = await this.fileModel.findOneAndDelete({
      _id: fileId,
      companyId: actor.companyId,
      storageKey: file.storageKey,
    });
    if (!deleted) throw new NotFoundException('File not found');
    return { message: 'File deleted.' };
  }

  async updatePermissions(
    actor: AuthenticatedUser,
    fileId: string,
    dto: UpdateFilePermissionsDto,
  ) {
    const file = await this.fileModel.findOne({
      _id: fileId,
      companyId: actor.companyId,
    });
    if (!file) throw new NotFoundException('File not found');
    if (
      actor.role !== Role.COMPANY_OWNER &&
      file.uploaderId.toString() !== actor.id
    )
      throw new ForbiddenException(
        'Only the uploader or company owner can change file permissions',
      );
    const permissions = await this.validatePermissions(
      actor,
      dto.visibility,
      dto.restrictedUserIds,
    );
    const updated = await this.fileModel.findOneAndUpdate(
      { _id: fileId, companyId: actor.companyId },
      { $set: permissions },
      { new: true, runValidators: true },
    );
    if (!updated) throw new NotFoundException('File not found');
    return this.publicMetadata(updated);
  }

  private async findStoredFile(
    actor: AuthenticatedUser,
    fileId: IsValidMongoDBId['id'],
  ) {
    const file = await this.fileModel
      .findOne({ _id: fileId, ...this.accessFilter(actor) })
      .select('+storageKey');
    if (!file) throw new NotFoundException('File not found');
    return file;
  }

  private publicMetadata(file: CompanyFile & { _id?: unknown }) {
    return {
      id: file._id,
      uploaderId: file.uploaderId,
      originalFilename: file.originalFilename,
      fileType: file.fileType,
      mimeType: file.mimeType,
      size: file.size,
      visibility: file.visibility ?? CompanyFileVisibility.COMPANY_WIDE,
      restrictedUserIds: file.restrictedUserIds ?? [],
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
    };
  }

  private accessFilter(actor: AuthenticatedUser) {
    if (actor.role === Role.COMPANY_OWNER)
      return { companyId: actor.companyId };
    return {
      companyId: actor.companyId,
      $or: [
        { visibility: CompanyFileVisibility.COMPANY_WIDE },
        { visibility: { $exists: false } },
        { uploaderId: actor.id },
        { restrictedUserIds: actor.id },
      ],
    };
  }

  private async validatePermissions(
    actor: AuthenticatedUser,
    visibility: CompanyFileVisibility,
    suppliedUserIds: string[] | undefined,
  ) {
    if (!Object.values(CompanyFileVisibility).includes(visibility))
      throw new BadRequestException('File visibility is invalid');
    const restrictedUserIds = [...new Set(suppliedUserIds ?? [])];
    if (restrictedUserIds.length !== (suppliedUserIds ?? []).length)
      throw new BadRequestException('Restricted employees must be unique');
    if (
      visibility === CompanyFileVisibility.COMPANY_WIDE &&
      restrictedUserIds.length > 0
    )
      throw new BadRequestException(
        'Company-wide files cannot have restricted employees',
      );
    if (
      visibility === CompanyFileVisibility.RESTRICTED &&
      restrictedUserIds.length === 0
    )
      throw new BadRequestException(
        'Restricted files require at least one employee',
      );
    if (restrictedUserIds.some((userId) => !Types.ObjectId.isValid(userId)))
      throw new BadRequestException('Restricted employees are invalid');
    if (restrictedUserIds.length > 0) {
      const matchingEmployees = await this.userModel.countDocuments({
        _id: { $in: restrictedUserIds },
        companyId: actor.companyId,
        role: Role.COMPANY_MEMBER,
      });
      if (matchingEmployees !== restrictedUserIds.length)
        throw new BadRequestException(
          'Restricted employees must be active members of the company',
        );
    }
    return { visibility, restrictedUserIds };
  }

  private hasUnknownCommitResult(error: unknown) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('errorLabels' in error)
    )
      return false;
    return (
      Array.isArray(error.errorLabels) &&
      error.errorLabels.includes('UnknownTransactionCommitResult')
    );
  }
}
