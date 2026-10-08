import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { User } from './entities/user.entity';
import { QueryParams } from './dto/query-params.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { Role } from '../enums/roles.enum';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { ChangePasswordDto } from './dto/change-password.dto';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel('user') private readonly userModel: Model<User>,
    @Optional() private readonly subscriptions?: SubscriptionsService,
    @Optional() @InjectConnection() private readonly connection?: Connection,
  ) {}

  async findAll(actor: AuthenticatedUser, { page, take }: QueryParams) {
    this.requireOwner(actor);
    take = Math.min(take, 30);
    const filter = { companyId: actor.companyId };
    const users = await this.userModel
      .find(filter)
      .sort({ _id: -1 })
      .skip((page - 1) * take)
      .limit(take);
    const total = await this.userModel.countDocuments(filter);
    return { users, total, page, take };
  }

  async findOne(actor: AuthenticatedUser, targetUserId: string) {
    this.requireSelfOrOwner(actor, targetUserId);
    const user = await this.userModel.findOne({
      _id: targetUserId,
      companyId: actor.companyId,
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async updateUser(
    actor: AuthenticatedUser,
    targetUserId: string,
    dto: UpdateUserDto,
  ) {
    await this.findOne(actor, targetUserId);
    const update: UpdateUserDto = {};
    if (dto.fullName !== undefined) update.fullName = dto.fullName;
    const user = await this.userModel.findOneAndUpdate(
      { _id: targetUserId, companyId: actor.companyId },
      update,
      { new: true, runValidators: true },
    );
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async changePassword(
    actor: AuthenticatedUser,
    { currentPassword, newPassword }: ChangePasswordDto,
  ) {
    const user = await this.userModel
      .findOne({ _id: actor.id, companyId: actor.companyId })
      .select('+password');
    if (
      !user?.password ||
      !(await bcrypt.compare(currentPassword, user.password))
    )
      throw new UnauthorizedException('Current password is incorrect');
    if (await bcrypt.compare(newPassword, user.password))
      throw new BadRequestException(
        'The new password must be different from the current password',
      );

    const password = await bcrypt.hash(newPassword, 10);
    const changed = await this.userModel.findOneAndUpdate(
      {
        _id: actor.id,
        companyId: actor.companyId,
        password: user.password,
      },
      { $set: { password } },
      { new: true, runValidators: true },
    );
    if (!changed)
      throw new UnauthorizedException(
        'The password changed during this request; try again',
      );
    return { message: 'Password changed successfully' };
  }

  async deleteUser(actor: AuthenticatedUser, targetUserId: string) {
    this.requireOwner(actor);
    const target = await this.findOne(actor, targetUserId);
    if (target.role === Role.COMPANY_OWNER)
      throw new BadRequestException('The company owner cannot be deleted');
    const filter = {
      _id: targetUserId,
      companyId: actor.companyId,
      role: Role.COMPANY_MEMBER,
    };
    // Serialize employee deletions with acceptance, plan changes and invoice
    // seat snapshots. Deletion remains possible while payments are suspended.
    const user =
      this.subscriptions?.paymentsEnabled && this.connection
        ? await this.connection.transaction(async (session) => {
            await this.subscriptions!.acquireLock(actor.companyId, session);
            return this.userModel.findOneAndDelete(filter, { session });
          })
        : await this.userModel.findOneAndDelete(filter);
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  private requireSelfOrOwner(actor: AuthenticatedUser, targetUserId: string) {
    if (
      actor.role !== Role.COMPANY_OWNER &&
      actor.id !== targetUserId.toLowerCase()
    )
      throw new ForbiddenException('You do not have access to this user');
  }

  private requireOwner(actor: AuthenticatedUser) {
    if (actor.role !== Role.COMPANY_OWNER)
      throw new ForbiddenException('Company owner access is required');
  }
}
