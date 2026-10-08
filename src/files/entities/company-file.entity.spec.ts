import { model, Types } from 'mongoose';
import {
  companyFileSchema,
  CompanyFileVisibility,
} from './company-file.entity';

describe('CompanyFile schema', () => {
  it('keeps ownership and storage identity immutable and private', () => {
    expect(companyFileSchema.path('companyId').options.immutable).toBe(true);
    expect(companyFileSchema.path('uploaderId').options.immutable).toBe(true);
    expect(companyFileSchema.path('storageKey').options).toMatchObject({
      immutable: true,
      unique: true,
      select: false,
    });
    const FileModel = model('CompanyFileSchemaTest', companyFileSchema);
    const document = new FileModel({
      companyId: new Types.ObjectId(),
      uploaderId: new Types.ObjectId(),
      originalFilename: 'data.csv',
      storageKey: 'private-key',
      fileType: 'csv',
      mimeType: 'text/csv',
      size: 10,
    });
    expect(document.toJSON()).not.toHaveProperty('storageKey');
    expect(document.visibility).toBe(CompanyFileVisibility.COMPANY_WIDE);
    expect(document.restrictedUserIds).toEqual([]);
  });

  it('indexes tenant pagination without exposing raw contents', () => {
    expect(companyFileSchema.indexes()).toEqual(
      expect.arrayContaining([
        [{ companyId: 1, createdAt: -1, _id: -1 }, expect.any(Object)],
        [
          {
            companyId: 1,
            restrictedUserIds: 1,
            createdAt: -1,
            _id: -1,
          },
          expect.any(Object),
        ],
      ]),
    );
    expect(companyFileSchema.path('buffer')).toBeUndefined();
  });

  it('enforces visibility and restricted-user invariants', async () => {
    const FileModel = model(
      'CompanyFileVisibilitySchemaTest',
      companyFileSchema,
    );
    const base = {
      companyId: new Types.ObjectId(),
      uploaderId: new Types.ObjectId(),
      originalFilename: 'data.csv',
      storageKey: 'private-key-visibility',
      fileType: 'csv',
      mimeType: 'text/csv',
      size: 10,
    };
    await expect(
      new FileModel({
        ...base,
        visibility: CompanyFileVisibility.RESTRICTED,
        restrictedUserIds: [],
      }).validate(),
    ).rejects.toThrow('Restricted files require at least one employee');
    await expect(
      new FileModel({
        ...base,
        visibility: CompanyFileVisibility.COMPANY_WIDE,
        restrictedUserIds: [new Types.ObjectId()],
      }).validate(),
    ).rejects.toThrow('Company-wide files cannot have restricted employees');
    const duplicateEmployeeId = new Types.ObjectId();
    await expect(
      new FileModel({
        ...base,
        visibility: CompanyFileVisibility.RESTRICTED,
        restrictedUserIds: [duplicateEmployeeId, duplicateEmployeeId],
      }).validate(),
    ).rejects.toThrow('Restricted employees must be unique');
  });
});
