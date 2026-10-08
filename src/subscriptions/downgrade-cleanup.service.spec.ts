import {
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { PLAN_CATALOG, PlanCode } from '../plans/plan.constants';
import { Role } from '../enums/roles.enum';
import { InvitationStatus } from '../invitations/entities/employee-invitation.entity';
import { DowngradeCleanupService } from './downgrade-cleanup.service';

type Row = {
  _id: Types.ObjectId;
  companyId: string;
  createdAt: Date;
  role?: Role;
  status?: InvitationStatus;
  expiresAt?: Date;
  storageKey?: string;
};
const companyId = new Types.ObjectId().toString();
const otherCompanyId = new Types.ObjectId().toString();
const owner = {
  id: new Types.ObjectId().toString(),
  companyId,
  role: Role.COMPANY_OWNER,
};
const row = (index: number, extra = {}): Row => ({
  _id: new Types.ObjectId(),
  companyId,
  createdAt: new Date(1700000000000 + index),
  ...extra,
});
function model(rows: Row[]) {
  const matches = (item: Row, filter: Record<string, unknown>) =>
    Object.entries(filter).every(([key, value]) => {
      if (key === '_id' && value && typeof value === 'object' && '$in' in value)
        return (value.$in as Types.ObjectId[]).some(
          (id) => id.toString() === item._id.toString(),
        );
      if (key === 'expiresAt') return item.expiresAt! > new Date();
      return String(item[key as keyof Row]) === String(value);
    });
  return {
    find: jest.fn((filter: Record<string, unknown>) => {
      const values = rows.filter((item) => matches(item, filter));
      const query = {
        session: () => query,
        select: () => query,
        sort: (order: Record<string, number>) => {
          values.sort(
            (a, b) =>
              (a.createdAt.getTime() - b.createdAt.getTime()) *
                order.createdAt ||
              a._id.toString().localeCompare(b._id.toString()) * order._id,
          );
          return query;
        },
        lean: () => Promise.resolve(values),
      };
      return query;
    }),
    findOne: jest.fn((filter: Record<string, unknown>) => ({
      select: () => Promise.resolve(rows.find((item) => matches(item, filter))),
    })),
    findOneAndDelete: jest.fn((filter: Record<string, unknown>) => {
      const index = rows.findIndex((item) => matches(item, filter));
      return Promise.resolve(index < 0 ? null : rows.splice(index, 1)[0]);
    }),
    deleteMany: jest.fn((filter: Record<string, unknown>) => {
      for (let i = rows.length - 1; i >= 0; i--)
        if (matches(rows[i], filter)) rows.splice(i, 1);
      return Promise.resolve({});
    }),
    updateMany: jest.fn((filter: Record<string, unknown>) => {
      for (const item of rows)
        if (matches(item, filter)) item.status = InvitationStatus.REVOKED;
      return Promise.resolve({});
    }),
  };
}
function fixture() {
  const files = Array.from({ length: 15 }, (_, i) =>
    row(i, { storageKey: `synthetic-${i}` }),
  );
  const employees = Array.from({ length: 15 }, (_, i) =>
    row(i, { role: Role.COMPANY_MEMBER }),
  );
  const invitations = Array.from({ length: 2 }, (_, i) =>
    row(i, {
      status: InvitationStatus.PENDING,
      expiresAt: new Date(Date.now() + 86400000),
    }),
  );
  employees.push(row(0, { role: Role.COMPANY_OWNER }));
  files.push(row(0, { companyId: otherCompanyId, storageKey: 'other-tenant' }));
  employees.push(
    row(0, { companyId: otherCompanyId, role: Role.COMPANY_MEMBER }),
  );
  const fileModel = model(files),
    userModel = model(employees),
    invitationModel = model(invitations);
  const subscriptions = {
    paymentsEnabled: false,
    getSubscription: jest.fn(() =>
      Promise.resolve({ planCode: PlanCode.PREMIUM }),
    ),
    acquireLock: jest.fn(() => Promise.resolve({})),
    changePlan: jest.fn((_actor: unknown, code: PlanCode) =>
      Promise.resolve({ planCode: code }),
    ),
  };
  const storage = {
    deleteObject: jest.fn((key: string) => {
      void key;
      return Promise.resolve();
    }),
  };
  const service = new DowngradeCleanupService(
    subscriptions as never,
    { findOne: (code: PlanCode) => PLAN_CATALOG[code] } as never,
    storage as never,
    fileModel as never,
    userModel as never,
    invitationModel as never,
    {
      transaction: (work: (session: object) => unknown) =>
        Promise.resolve(work({})),
    } as never,
  );
  return {
    service,
    files,
    employees,
    invitations,
    fileModel,
    userModel,
    invitationModel,
    subscriptions,
    storage,
  };
}

describe('Explicit downgrade cleanup', () => {
  it('previews counts without deleting anything, then keeps newest Free files and the owner only', async () => {
    const f = fixture();
    const retained = f.files
      .filter((file) => file.companyId === companyId)
      .slice(5)
      .map((file) => file._id);
    const preview = await f.service.preview(owner, PlanCode.FREE);
    expect(preview).toMatchObject({
      storedFiles: 15,
      fileLimit: 10,
      filesToRemove: 5,
      employeesToRemove: 15,
      invitationsToRevoke: 2,
    });
    expect(f.storage.deleteObject).not.toHaveBeenCalled();
    await f.service.cleanup(owner, PlanCode.FREE, preview.previewToken);
    expect(
      f.files
        .filter((file) => file.companyId === companyId)
        .map((file) => file._id),
    ).toEqual(retained);
    expect(f.files.some((file) => file.companyId === otherCompanyId)).toBe(
      true,
    );
    expect(
      f.employees
        .filter((user) => user.companyId === companyId)
        .map((user) => user.role),
    ).toEqual([Role.COMPANY_OWNER]);
    expect(f.employees.some((user) => user.companyId === otherCompanyId)).toBe(
      true,
    );
    expect(
      f.invitations.every(
        (invitation) => invitation.status === InvitationStatus.REVOKED,
      ),
    ).toBe(true);
    expect(f.subscriptions.changePlan).toHaveBeenCalledWith(
      owner,
      PlanCode.FREE,
    );
  });

  it('keeps the oldest Basic employees, removes newest extras, and revokes excess invitations', async () => {
    const f = fixture();
    const retained = f.employees.slice(0, 10).map((user) => user._id);
    const preview = await f.service.preview(owner, PlanCode.BASIC);
    expect(preview).toMatchObject({
      filesToRemove: 0,
      employeesToRemove: 5,
      invitationsToRevoke: 2,
    });
    await f.service.cleanup(owner, PlanCode.BASIC, preview.previewToken);
    expect(
      f.employees
        .filter(
          (user) =>
            user.companyId === companyId && user.role === Role.COMPANY_MEMBER,
        )
        .map((user) => user._id),
    ).toEqual(retained);
    expect(f.storage.deleteObject).not.toHaveBeenCalled();
  });

  it('keeps the newest 100 files when cleaning up for Basic', async () => {
    const f = fixture();
    for (let index = 15; index < 105; index++)
      f.files.push(row(index, { storageKey: `synthetic-${index}` }));
    const retained = f.files
      .filter((file) => file.companyId === companyId)
      .slice(5)
      .map((file) => file._id);
    const preview = await f.service.preview(owner, PlanCode.BASIC);
    expect(preview).toMatchObject({
      storedFiles: 105,
      fileLimit: 100,
      filesToRemove: 5,
    });
    expect(f.storage.deleteObject).not.toHaveBeenCalled();
    await f.service.cleanup(owner, PlanCode.BASIC, preview.previewToken);
    expect(
      f.files
        .filter((file) => file.companyId === companyId)
        .map((file) => file._id),
    ).toEqual(retained);
  });

  it('keeps the oldest pending invitations within the seats left after accepted employees', async () => {
    const f = fixture();
    f.employees.splice(8, 7);
    f.invitations.push(
      row(2, {
        status: InvitationStatus.PENDING,
        expiresAt: new Date(Date.now() + 86400000),
      }),
    );
    const preview = await f.service.preview(owner, PlanCode.BASIC);
    expect(preview).toMatchObject({
      employeesToRemove: 0,
      invitationsToRevoke: 1,
    });
    await f.service.cleanup(owner, PlanCode.BASIC, preview.previewToken);
    expect(f.invitations.map((invitation) => invitation.status)).toEqual([
      InvitationStatus.PENDING,
      InvitationStatus.PENDING,
      InvitationStatus.REVOKED,
    ]);
  });

  it('does not delete data when automatic paid cleanup requires Checkout first', async () => {
    const f = fixture();
    const preview = await f.service.preview(owner, PlanCode.BASIC);
    f.subscriptions.paymentsEnabled = true;
    await expect(
      f.service.cleanup(owner, PlanCode.BASIC, preview.previewToken),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.storage.deleteObject).not.toHaveBeenCalled();
    expect(f.userModel.deleteMany).not.toHaveBeenCalled();
  });

  it('rejects changed or incorrect previews before deleting anything', async () => {
    const f = fixture();
    const preview = await f.service.preview(owner, PlanCode.FREE);
    f.files.push(row(20));
    await expect(
      f.service.cleanup(owner, PlanCode.FREE, preview.previewToken),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.storage.deleteObject).not.toHaveBeenCalled();
    expect(f.userModel.deleteMany).not.toHaveBeenCalled();
  });

  it('preserves metadata on a storage failure and requires a fresh preview after partial cleanup', async () => {
    const f = fixture();
    const preview = await f.service.preview(owner, PlanCode.FREE);
    f.storage.deleteObject
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(
      f.service.cleanup(owner, PlanCode.FREE, preview.previewToken),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(f.files.filter((file) => file.companyId === companyId)).toHaveLength(
      14,
    );
    expect(f.subscriptions.changePlan).not.toHaveBeenCalled();
    await expect(
      f.service.cleanup(owner, PlanCode.FREE, preview.previewToken),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects member access and cleanup for a plan that is not lower', async () => {
    const f = fixture();
    await expect(
      f.service.preview({ ...owner, role: Role.COMPANY_MEMBER }, PlanCode.FREE),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      f.service.preview(owner, PlanCode.PREMIUM),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('does not remove unconfirmed new employee accounts after membership changes during file cleanup', async () => {
    const f = fixture();
    const preview = await f.service.preview(owner, PlanCode.FREE);
    f.storage.deleteObject.mockImplementationOnce(() => {
      f.employees.push(row(25, { role: Role.COMPANY_MEMBER }));
      return Promise.resolve();
    });
    await expect(
      f.service.cleanup(owner, PlanCode.FREE, preview.previewToken),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.userModel.deleteMany).not.toHaveBeenCalled();
    expect(f.subscriptions.changePlan).not.toHaveBeenCalled();
  });
});
