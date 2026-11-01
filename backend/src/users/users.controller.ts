import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type {
  AuthenticatedRequest,
  OptionalAuthRequest,
} from '../auth/auth-user';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
import { SessionTokenService } from '../auth/session-token.service';
import { withOptimizedImage } from '../common/pipes/optimize-image.pipe';
import { ParseIdPipe } from '../common/pipes/parse-id.pipe';
import { ImageFileInterceptor } from '../common/uploads/image-upload';
import { userFilePrefix } from '../common/uploads/owned-files';
import { CurrentTenant, StaffRoute } from '../tenancy/decorators';
import type { TenantContext } from '../tenancy/tenant-context';
import { TenantService } from '../tenancy/tenant.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { AccountCreationLimitGuard } from './account-creation-limit.guard';
import { UserRole } from './entities/user.entity';
import {
  ADMIN_SELF_DELETE_MESSAGE,
  assertCanDeleteUser,
  assertWritable,
  resolveRoleChange,
  resolveSignup,
  resolveUserAccess,
} from './users.policy';
import { UsersService } from './users.service';

/** Caminho público da foto recém-gravada por este upload (undefined sem arquivo). */
function uploadedAvatar(filename?: string): string | undefined {
  return filename ? `/uploads/${filename}` : undefined;
}

/**
 * Contas e equipe da loja. A loja da equipe vem SEMPRE do usuário autenticado (users.store_id,
 * recarregado do banco pela JwtStrategy) — nunca do corpo, da query ou de cabeçalhos.
 * Respostas montadas por lista de campos permitidos (SessionUser).
 */
@ApiTags('Usuários')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly tenants: TenantService,
    private readonly sessionTokens: SessionTokenService,
  ) {}

  // Lixeira da equipe da própria loja
  @Get('trash')
  @StaffRoute(UserRole.ADMIN)
  async findDeleted(@CurrentTenant() tenant: TenantContext) {
    const users = await this.usersService.findTrash(tenant.storeId);
    return this.usersService.presentTeam(users, tenant.storeId);
  }

  @Patch(':id/restore')
  @StaffRoute(UserRole.ADMIN)
  async restore(
    @Param('id', ParseIdPipe) id: number,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: AuthenticatedRequest,
  ) {
    const user = await this.usersService.restore(
      id,
      tenant.storeId,
      req.user,
      req,
    );
    return this.usersService.presentMember(user);
  }

  /**
   * Sem token (ou com token que não é de ADMIN de loja): cadastro público de cliente, limitado por IP.
   * Com token de ADMIN da loja: conta da equipe da PRÓPRIA loja (limite de equipe do plano).
   * Os limites (SIGNUP por IP, TEAM_WRITE por loja) são conferidos no guard, antes de ler o corpo.
   */
  @Post()
  @UseGuards(OptionalJwtAuthGuard, AccountCreationLimitGuard)
  @ApiConsumes('application/json', 'multipart/form-data')
  @UseInterceptors(ImageFileInterceptor('file'))
  async create(
    @Body() createUserDto: CreateUserDto,
    @Req() req: OptionalAuthRequest,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    const actor = req.user ?? null;
    const plan = resolveSignup(createUserDto.role, actor);

    if (plan.kind === 'staff' && actor) {
      // Loja do ADMIN (do banco), que precisa poder ser alterada (situação e assinatura)
      const tenant = await this.tenants.staffContext(actor, 'manage');
      const user = await withOptimizedImage(file, (filename) =>
        this.usersService.createStaff(
          createUserDto,
          plan.role,
          tenant.storeId,
          actor,
          req,
          uploadedAvatar(filename),
        ),
      );
      return this.usersService.presentSession(user);
    }

    // Foto otimizada (.webp) só depois do corpo validado e do perfil autorizado;
    // se o cadastro falhar (ex.: e-mail já usado), o arquivo recém-gravado é apagado
    const user = await withOptimizedImage(file, (filename) =>
      this.usersService.createClient(createUserDto, uploadedAvatar(filename)),
    );
    return this.usersService.presentSession(user);
  }

  // Equipe ativa da própria loja
  @Get()
  @StaffRoute(UserRole.ADMIN)
  async findAll(@CurrentTenant() tenant: TenantContext) {
    const users = await this.usersService.findTeam(tenant.storeId);
    return this.usersService.presentTeam(users, tenant.storeId);
  }

  /** A própria conta; ou ADMIN da loja para a equipe da própria loja (fora dela → 404). */
  @Get(':id')
  @UseGuards(AuthGuard('jwt'))
  async findOne(
    @Param('id', ParseIdPipe) id: number,
    @Req() req: AuthenticatedRequest,
  ) {
    if (resolveUserAccess(req.user, id) === 'self') {
      const user = await this.usersService.findAccount(req.user.id);
      return this.usersService.presentAs(user, req.user);
    }
    const tenant = await this.tenants.staffContext(req.user, 'read');
    const user = await this.usersService.findTeamMember(id, tenant.storeId);
    return this.usersService.presentSession(user);
  }

  /**
   * A própria conta (sem mudar o perfil; trocar e-mail ou senha encerra as outras sessões e a
   * resposta traz um access_token novo); ou ADMIN da loja na equipe da própria loja (perfil só entre
   * perfis da equipe, nunca o próprio).
   */
  @Patch(':id')
  @UseGuards(AuthGuard('jwt'))
  @ApiConsumes('application/json', 'multipart/form-data')
  @UseInterceptors(ImageFileInterceptor('file'))
  async update(
    @Param('id', ParseIdPipe) id: number,
    @Body() updateUserDto: UpdateUserDto,
    @Req() req: AuthenticatedRequest,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    const actor = req.user;
    assertWritable(actor);
    const access = resolveUserAccess(actor, id);
    const role = resolveRoleChange(updateUserDto.role, actor, id);

    if (access === 'self') {
      // Foto nova com o dono no nome (u<id>-): a anterior da própria conta é apagada ao trocar
      const { user, sessionsRevoked } = await withOptimizedImage(
        file,
        (filename) =>
          this.usersService.updateSelf(
            actor,
            { ...updateUserDto, role: undefined },
            req,
            uploadedAvatar(filename),
          ),
        { prefix: userFilePrefix(actor.id) },
      );
      const view = await this.usersService.presentAs(user, actor);
      return sessionsRevoked
        ? { ...view, access_token: this.sessionTokens.issue(user) }
        : view;
    }

    const tenant = await this.tenants.staffContext(actor, 'manage');
    const user = await withOptimizedImage(
      file,
      (filename) =>
        this.usersService.updateTeamMember(
          id,
          tenant.storeId,
          { ...updateUserDto, role, current_password: undefined },
          actor,
          req,
          uploadedAvatar(filename),
        ),
      { prefix: userFilePrefix(id) },
    );
    return this.usersService.presentSession(user);
  }

  /** Lixeira: a própria conta, ou ADMIN da loja na equipe da própria loja (nunca a si mesmo). */
  @Delete(':id')
  @UseGuards(AuthGuard('jwt'))
  async remove(
    @Param('id', ParseIdPipe) id: number,
    @Req() req: AuthenticatedRequest,
  ) {
    assertWritable(req.user);
    if (assertCanDeleteUser(req.user, id) === 'self') {
      return this.usersService.removeSelf(req.user, req);
    }
    const tenant = await this.tenants.staffContext(req.user, 'manage');
    return this.usersService.removeTeamMember(
      id,
      tenant.storeId,
      req.user,
      req,
    );
  }

  /** Exclusão definitiva de quem já está na lixeira da equipe da própria loja. */
  @Delete(':id/permanent')
  @StaffRoute(UserRole.ADMIN)
  removePermanent(
    @Param('id', ParseIdPipe) id: number,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: AuthenticatedRequest,
  ) {
    if (id === req.user.id) {
      throw new BadRequestException(ADMIN_SELF_DELETE_MESSAGE);
    }
    return this.usersService.purge(id, tenant.storeId, req.user, req);
  }
}
