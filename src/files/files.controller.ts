import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { IsAuthGuard } from '../guards/is-auth.guard';
import { IsValidMongoDBId } from '../users/dto/is-valid-objectID.dto';
import { QueryParams } from '../users/dto/query-params.dto';
import { contentDisposition, UploadedCompanyFile } from './file-validation';
import { FilesService } from './files.service';
import {
  UpdateFilePermissionsDto,
  UploadFilePermissionsDto,
} from './dto/file-permissions.dto';

@Controller('files')
@UseGuards(IsAuthGuard)
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  @Post()
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @CurrentUser() actor: AuthenticatedUser,
    @UploadedFile() file?: UploadedCompanyFile,
    @Body() permissions?: UploadFilePermissionsDto,
  ) {
    return this.filesService.upload(actor, file, permissions);
  }

  @Get()
  findAll(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: QueryParams,
  ) {
    return this.filesService.findAll(actor, query);
  }

  @Get(':id/download')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async download(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IsValidMongoDBId,
  ) {
    const result = await this.filesService.download(actor, id);
    return new StreamableFile(result.stream, {
      type: result.file.mimeType,
      disposition: contentDisposition(result.file.originalFilename),
      length: result.contentLength,
    });
  }

  @Get(':id')
  findOne(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IsValidMongoDBId,
  ) {
    return this.filesService.findOne(actor, id);
  }

  @Patch(':id/permissions')
  updatePermissions(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IsValidMongoDBId,
    @Body() dto: UpdateFilePermissionsDto,
  ) {
    return this.filesService.updatePermissions(actor, id, dto);
  }

  @Delete(':id')
  delete(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() { id }: IsValidMongoDBId,
  ) {
    return this.filesService.delete(actor, id);
  }
}
