import {
  employeeInvitationSchema,
  InvitationStatus,
} from './employee-invitation.entity';

describe('EmployeeInvitation schema', () => {
  it('keeps token hashes private and defines lifecycle constraints', () => {
    expect(employeeInvitationSchema.path('tokenHash').options.select).toBe(
      false,
    );
    expect(employeeInvitationSchema.path('companyId').options.immutable).toBe(
      true,
    );
    expect(employeeInvitationSchema.path('invitedBy').options.immutable).toBe(
      true,
    );
    expect(employeeInvitationSchema.path('status').options.enum).toEqual(
      InvitationStatus,
    );
  });

  it('has unique pending-email and token indexes plus expiration cleanup', () => {
    const indexes = employeeInvitationSchema.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        [
          { email: 1 },
          expect.objectContaining({
            unique: true,
            partialFilterExpression: { status: InvitationStatus.PENDING },
          }),
        ],
        [{ tokenHash: 1 }, expect.objectContaining({ unique: true })],
        [{ expiresAt: 1 }, expect.objectContaining({ expireAfterSeconds: 0 })],
      ]),
    );
  });
});
