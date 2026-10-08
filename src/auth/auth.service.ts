import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { SignInDto } from './dto/sign-in.dto';
import { SignUpDto } from './dto/sign-up.dto';
import { JwtService } from '@nestjs/jwt';
import { User } from '../users/entities/user.entity';
import { Company } from '../companies/entities/company.entity';
import { GoogleUser } from './auth.types';
import * as bcrypt from 'bcryptjs';
import {
  duplicateKeyField,
  isDuplicateKeyError,
} from '../users/database-errors';
import { Role } from '../enums/roles.enum';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { CompanyVerificationService } from './company-verification.service';
import { CompanyPlatformStatus } from '../companies/platform-status';
import { GoogleRegistrationDto } from './dto/google-registration.dto';
import { GoogleOAuthFlowService } from './google-oauth-flow.service';

@Injectable()
export class AuthService {
  constructor(
    @InjectModel('user') private readonly userModel: Model<User>,
    @InjectModel('company') private readonly companyModel: Model<Company>,
    @InjectConnection() private readonly connection: Connection,
    private readonly jwtService: JwtService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly companyVerificationService: CompanyVerificationService,
    private readonly googleOAuthFlow: GoogleOAuthFlowService,
  ) {}

  async signIn({ email, password }: SignInDto) {
    const user = await this.userModel.findOne({ email }).select('+password');
    if (!user?.password || !(await bcrypt.compare(password, user.password)))
      throw new UnauthorizedException('Invalid credentials');
    return { accessToken: await this.signToken(user) };
  }

  async signInWithGoogle(profile: GoogleUser) {
    const user = await this.resolveGoogleUser(profile);
    return this.signToken(user);
  }

  async resolveGoogleUser(profile: GoogleUser) {
    const user = await this.findGoogleUser(profile);
    if (!user)
      throw new UnauthorizedException(
        'No account is registered for this Google identity',
      );
    return user;
  }

  async findGoogleUser(profile: GoogleUser) {
    const user = await this.userModel.findOne({ email: profile.email });
    if (!user) return null;
    await this.assertTenantAccess(user);
    user.avatar = profile.avatar;
    await user.save();
    return user;
  }

  async signUpWithGoogle({
    code,
    companyName,
    country,
    industry,
  }: GoogleRegistrationDto) {
    try {
      const owner = await this.connection.transaction(async (session) => {
        const profile = await this.googleOAuthFlow.consumeRegistrationExchange(
          code,
          session,
        );
        const [company] = await this.companyModel.create(
          [{ name: companyName, country, industry, activatedAt: new Date() }],
          { session },
        );
        const [user] = await this.userModel.create(
          [
            {
              email: profile.email,
              fullName: profile.fullName,
              avatar: profile.avatar,
              companyId: company._id,
              role: Role.COMPANY_OWNER,
            },
          ],
          { session },
        );
        await this.subscriptionsService.initializeFree(company._id, session);
        return user;
      });
      return { accessToken: await this.signToken(owner) };
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        if (duplicateKeyField(error) === 'email')
          throw new ConflictException('Email is already in use');
        if (duplicateKeyField(error) === 'name')
          throw new ConflictException('Company name is already in use');
        throw new ConflictException('Company or user already exists');
      }
      throw error;
    }
  }

  async exchangeGoogleUser(userId: Types.ObjectId) {
    const user = await this.userModel.findById(userId);
    if (!user) throw new UnauthorizedException('Account is unavailable');
    return { accessToken: await this.signToken(user) };
  }

  async signUp({
    email,
    fullName,
    password,
    companyName,
    country,
    industry,
  }: SignUpDto) {
    try {
      const delivery = await this.connection.transaction(async (session) => {
        const [company] = await this.companyModel.create(
          [{ name: companyName, country, industry, activatedAt: null }],
          { session },
        );
        const [owner] = await this.userModel.create(
          [
            {
              email,
              password: await bcrypt.hash(password, 10),
              fullName,
              companyId: company._id,
              role: Role.COMPANY_OWNER,
            },
          ],
          { session },
        );
        await this.subscriptionsService.initializeFree(company._id, session);
        return this.companyVerificationService.createForRegistration(
          company._id,
          owner._id,
          owner.email,
          company.name,
          session,
        );
      });
      try {
        await this.companyVerificationService.sendActivationEmail(delivery);
      } catch {
        throw new ServiceUnavailableException(
          'Registration was saved, but the activation email could not be delivered. Please request another activation email.',
        );
      }
      return {
        message:
          'Company registered. Check your email to activate the account.',
      };
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        if (duplicateKeyField(error) === 'email')
          throw new ConflictException('Email is already in use');
        if (duplicateKeyField(error) === 'name')
          throw new ConflictException('Company name is already in use');
        throw new ConflictException('Company or user already exists');
      }
      throw error;
    }
  }

  async getCurrentUser(userId: string) {
    const user = await this.userModel.findById(userId);
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  private async signToken(user: User & { _id: Types.ObjectId }) {
    await this.assertTenantAccess(user);
    return this.jwtService.signAsync({
      id: user._id.toString(),
      version: user.authVersion ?? 0,
    });
  }

  private async assertTenantAccess(user: User & { _id: Types.ObjectId }) {
    if (
      !(user.companyId instanceof Types.ObjectId) ||
      !Object.values(Role).includes(user.role)
    )
      throw new UnauthorizedException('User is not assigned to a company');
    const company = await this.companyModel.findOne({
      _id: user.companyId,
      activatedAt: { $ne: null },
    });
    if (!company) throw new UnauthorizedException('Account is not activated');
    if (company.platformStatus === CompanyPlatformStatus.SUSPENDED)
      throw new UnauthorizedException('Account is unavailable');
  }
}
