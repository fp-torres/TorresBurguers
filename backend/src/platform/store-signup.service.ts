import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth-user';
import type { LoginResult } from '../auth/auth.service';
import { clientIpKey } from '../auth/link-token';
import { SessionTokenService } from '../auth/session-token.service';
import { Plan } from '../billing/entities/plan.entity';
import { SubscriptionsService } from '../billing/subscriptions.service';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { ACCOUNT_EXISTS_MESSAGE } from '../invitations/invitations.service';
import { Store } from '../store/entities/store.entity';
import { accountActor } from '../users/account-actor';
import { normalizeEmail } from '../users/email';
import { User, UserRole } from '../users/entities/user.entity';
import { toSessionUser } from '../users/session-user';
import { UsersService } from '../users/users.service';
import type { StoreSignupDto } from './dto/store-signup.dto';
import {
  PLATFORM_SETTINGS_ID,
  PlatformSettings,
} from './entities/platform-settings.entity';
import { isSignupPlan } from './platform-settings.service';
import {
  assertSlugAvailableForSignup,
  insertNewStore,
} from './store-provisioning';

export const SIGNUP_UNAVAILABLE_MESSAGE =
  'Cadastro de estabelecimentos indisponível.';

/**
 * Autoatendimento (POST /stores/signup, público): só com platform_settings.store_self_signup_enabled
 * e um plano ACTIVE e público configurado (senão 404). Limitado por IP (STORE_SIGNUP). Numa única
 * transação cria a loja (ATIVA, fechada, entrega desligada), a conta do responsável (ADMIN da loja,
 * mesma política de senha do cadastro de clientes), o vínculo stores.owner_user_id e a assinatura do
 * plano do autoatendimento. Devolve a sessão no formato do login: { access_token, user }.
 */
@Injectable()
export class StoreSignupService {
  constructor(
    @InjectRepository(Store)
    private readonly stores: Repository<Store>,
    @InjectRepository(PlatformSettings)
    private readonly settings: Repository<PlatformSettings>,
    @InjectRepository(Plan)
    private readonly plans: Repository<Plan>,
    private readonly usersService: UsersService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly sessionTokens: SessionTokenService,
    private readonly rateLimit: RateLimitService,
    private readonly audit: AuditService,
  ) {}

  async signup(
    dto: StoreSignupDto,
    request?: Request | null,
  ): Promise<LoginResult> {
    // Toda tentativa conta (inclusive endereço ou e-mail repetidos)
    this.rateLimit.consume('STORE_SIGNUP', clientIpKey(request));

    const plan = await this.availablePlan();
    if (!plan) throw new NotFoundException(SIGNUP_UNAVAILABLE_MESSAGE);

    const email = normalizeEmail(dto.owner.email);
    // Livre, fora da loja padrão do ambiente e nunca usado por outra loja
    await assertSlugAvailableForSignup(this.stores, dto.store.slug);
    if (await this.usersService.emailInUse(email)) {
      throw new ConflictException(ACCOUNT_EXISTS_MESSAGE);
    }

    const { store, owner, subscription } =
      await this.stores.manager.transaction(async (manager) => {
        const created = await insertNewStore(manager, {
          name: dto.store.name,
          slug: dto.store.slug,
        });
        const account = await this.usersService.insertUser(
          manager.getRepository(User),
          {
            name: dto.owner.name,
            email,
            password: dto.owner.password,
            phone: dto.owner.phone ?? null,
          },
          { role: UserRole.ADMIN, storeId: created.id },
          ACCOUNT_EXISTS_MESSAGE,
        );
        await manager
          .getRepository(Store)
          .update({ id: created.id }, { owner_user_id: account.id });
        created.owner_user_id = account.id;

        // A assinatura entra na mesma transação (com o manager, a auditoria fica a cargo daqui)
        const createdSubscription =
          await this.subscriptionsService.createForStore(created.id, plan.id, {
            actor: this.ownerActor(account),
            request,
            manager,
            provider: 'MANUAL',
            reason: 'Cadastro pelo autoatendimento.',
          });
        return {
          store: created,
          owner: account,
          subscription: createdSubscription,
        };
      });

    const actor = accountActor(owner);
    await this.audit.record({
      actor,
      scope: 'STORE',
      storeId: store.id,
      action: 'platform.store.self_signup',
      targetType: 'store',
      targetId: store.id,
      metadata: {
        slug: store.slug,
        name: store.name,
        owner_user_id: owner.id,
        owner_email: owner.email,
        plan_id: plan.id,
        plan_code: plan.code,
        subscription_id: subscription.id,
        subscription_status: subscription.status,
        terms_accepted: true,
      },
      request,
    });
    await this.audit.record({
      actor,
      scope: 'STORE',
      storeId: store.id,
      action: 'subscription.create',
      targetType: 'subscription',
      targetId: subscription.id,
      metadata: {
        plan_id: plan.id,
        plan_code: plan.code,
        status: subscription.status,
        provider: subscription.billing_provider,
        via: 'platform.store.self_signup',
      },
      request,
    });
    await this.usersService.recordLogin(owner.id);
    // Link de verificação do e-mail do responsável em segundo plano (não atrasa a resposta)
    this.usersService.startVerification(owner);

    return {
      access_token: this.sessionTokens.issue(owner),
      user: toSessionUser(owner, store),
    };
  }

  /**
   * Plano do autoatendimento, conferido a cada cadastro: o autoatendimento precisa estar habilitado e
   * o plano, disponível (ACTIVE) e público — createForStore não confere a visibilidade.
   */
  private async availablePlan(): Promise<Plan | null> {
    const settings = await this.settings.findOne({
      where: { id: PLATFORM_SETTINGS_ID },
      select: {
        id: true,
        store_self_signup_enabled: true,
        self_signup_plan_id: true,
      },
    });
    if (!settings?.store_self_signup_enabled || !settings.self_signup_plan_id) {
      return null;
    }
    const plan = await this.plans.findOne({
      where: { id: settings.self_signup_plan_id },
    });
    return isSignupPlan(plan) ? plan : null;
  }

  /** A conta recém-criada como autora da contratação (histórico da assinatura). */
  private ownerActor(user: User): AuthUser {
    return {
      id: user.id,
      email: user.email,
      role: UserRole.ADMIN,
      name: user.name,
      storeId: user.store_id ?? null,
      platformRole: null,
      supportSession: null,
    };
  }
}
