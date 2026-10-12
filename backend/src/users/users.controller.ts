import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Req,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserRole } from './entities/user.entity';
import {
  assertCanDeleteUser,
  assertSelfOrAdmin,
  resolveRoleChange,
  resolveSignupRole,
} from './users.policy';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
import type {
  AuthenticatedRequest,
  OptionalAuthRequest,
} from '../auth/auth-user';
import { withOptimizedImage } from '../common/pipes/optimize-image.pipe';
import { ParseIdPipe } from '../common/pipes/parse-id.pipe';
import { ImageFileInterceptor } from '../common/uploads/image-upload';

@ApiTags('Usuários')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('trash')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  findDeleted() {
    return this.usersService.findDeleted();
  }

  @Patch(':id/restore')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  restore(@Param('id', ParseIdPipe) id: number) {
    return this.usersService.restore(id);
  }

  // Cadastro público de clientes. Contas da equipe só com token de ADMIN (autenticação opcional).
  @Post()
  @UseGuards(OptionalJwtAuthGuard)
  @ApiConsumes('application/json', 'multipart/form-data')
  @UseInterceptors(ImageFileInterceptor('file'))
  create(
    @Body() createUserDto: CreateUserDto,
    @Req() req: OptionalAuthRequest,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    const role = resolveSignupRole(createUserDto.role, req.user);
    // Foto otimizada (.webp) só depois do corpo validado e do perfil autorizado;
    // se o cadastro falhar (ex.: e-mail já usado), o arquivo recém-gravado é apagado
    return withOptimizedImage(file, (filename) => {
      if (filename) createUserDto.avatar = `/uploads/${filename}`;
      return this.usersService.create(createUserDto, role);
    });
  }

  @Get()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  findAll() {
    return this.usersService.findAll();
  }

  @Get(':id')
  @UseGuards(AuthGuard('jwt'))
  findOne(
    @Param('id', ParseIdPipe) id: number,
    @Req() req: AuthenticatedRequest,
  ) {
    assertSelfOrAdmin(req.user, id);
    return this.usersService.findOne(id);
  }

  // Próprio usuário ou ADMIN; só o ADMIN altera o perfil de acesso (e nunca o próprio)
  @Patch(':id')
  @UseGuards(AuthGuard('jwt'))
  @ApiConsumes('application/json', 'multipart/form-data')
  @UseInterceptors(ImageFileInterceptor('file'))
  update(
    @Param('id', ParseIdPipe) id: number,
    @Body() updateUserDto: UpdateUserDto,
    @Req() req: AuthenticatedRequest,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    assertSelfOrAdmin(req.user, id);
    const role = resolveRoleChange(updateUserDto.role, req.user, id);
    return withOptimizedImage(file, (filename) => {
      if (filename) updateUserDto.avatar = `/uploads/${filename}`;
      return this.usersService.update(id, { ...updateUserDto, role });
    });
  }

  // Exclusão lógica: a própria conta ou ADMIN (o ADMIN não exclui a si mesmo)
  @Delete(':id')
  @UseGuards(AuthGuard('jwt'))
  remove(
    @Param('id', ParseIdPipe) id: number,
    @Req() req: AuthenticatedRequest,
  ) {
    assertCanDeleteUser(req.user, id);
    return this.usersService.remove(id);
  }

  @Delete(':id/permanent')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  removePermanent(
    @Param('id', ParseIdPipe) id: number,
    @Req() req: AuthenticatedRequest,
  ) {
    assertCanDeleteUser(req.user, id);
    return this.usersService.hardDelete(id);
  }
}
