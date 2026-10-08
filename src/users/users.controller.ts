import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { QueryParams } from './dto/query-params.dto';
import { IsValidMongoDBId } from './dto/is-valid-objectID.dto';
import { IsAuthGuard } from '../guards/is-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../enums/roles.enum';
import { ChangePasswordDto } from './dto/change-password.dto';

@UseGuards(IsAuthGuard, RolesGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @Roles(Role.COMPANY_OWNER)
  findAll(@CurrentUser() user: AuthenticatedUser, @Query() query: QueryParams) {
    return this.usersService.findAll(user, query);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param() { id }: IsValidMongoDBId,
  ) {
    return this.usersService.findOne(user, id);
  }

  @Patch('me/password')
  changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.usersService.changePassword(user, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param() { id }: IsValidMongoDBId,
    @Body() dto: UpdateUserDto,
  ) {
    return this.usersService.updateUser(user, id, dto);
  }

  @Delete(':id')
  @Roles(Role.COMPANY_OWNER)
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param() { id }: IsValidMongoDBId,
  ) {
    return this.usersService.deleteUser(user, id);
  }
}
