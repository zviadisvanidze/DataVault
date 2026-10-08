import { Mongoose, Schema, Types } from 'mongoose';
import { companyVerificationSchema } from '../auth/entities/company-verification.entity';
import { companyFileSchema } from '../files/entities/company-file.entity';
import { employeeInvitationSchema } from '../invitations/entities/employee-invitation.entity';
import { subscriptionPeriodSchema } from '../subscriptions/entities/subscription-period.entity';
import { subscriptionSchema } from '../subscriptions/entities/subscription.entity';
import { userSchema } from '../users/entities/user.entity';

const scalarReferences: [string, Schema, string][] = [
  ['User.companyId', userSchema, 'companyId'],
  ['Subscription.companyId', subscriptionSchema, 'companyId'],
  ['SubscriptionPeriod.companyId', subscriptionPeriodSchema, 'companyId'],
  ['CompanyVerification.companyId', companyVerificationSchema, 'companyId'],
  ['CompanyVerification.ownerId', companyVerificationSchema, 'ownerId'],
  ['EmployeeInvitation.companyId', employeeInvitationSchema, 'companyId'],
  ['EmployeeInvitation.invitedBy', employeeInvitationSchema, 'invitedBy'],
  ['CompanyFile.companyId', companyFileSchema, 'companyId'],
  ['CompanyFile.uploaderId', companyFileSchema, 'uploaderId'],
];

describe('ObjectId reference schemas', () => {
  it.each(scalarReferences)(
    '%s is an ObjectId path and casts string query IDs',
    (_name, schema, path) => {
      expect(schema.path(path).instance).toBe('ObjectId');
      expect(schema.path(path)).toBeInstanceOf(Schema.Types.ObjectId);

      // Isolated, disconnected models: query casting executes no database IO.
      const mongoose = new Mongoose();
      const Model = mongoose.model('ObjectIdRegression', schema);
      const id = new Types.ObjectId();
      const query = Model.findOne({ [path]: id.toHexString() });
      query.cast(Model);
      expect(query.getFilter()).toEqual({ [path]: id });

      const invalidQuery = Model.findOne({ [path]: 'invalid-id' });
      expect(() => {
        invalidQuery.cast(Model);
      }).toThrow(mongoose.Error.CastError);
    },
  );

  it('uses ObjectId array elements and casts restricted-user query IDs', () => {
    expect(companyFileSchema.path('restrictedUserIds').instance).toBe('Array');
    expect(companyFileSchema.path('restrictedUserIds.0').instance).toBe(
      'ObjectId',
    );
    const mongoose = new Mongoose();
    const Model = mongoose.model(
      'RestrictedUsersRegression',
      companyFileSchema,
    );
    const ids = [new Types.ObjectId(), new Types.ObjectId()];
    const query = Model.find({
      restrictedUserIds: { $in: ids.map((id) => id.toHexString()) },
    });
    query.cast(Model);
    expect(query.getFilter()).toEqual({ restrictedUserIds: { $in: ids } });
  });
});
