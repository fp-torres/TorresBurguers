import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Not, Repository, type FindOptionsWhere } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { isUniqueViolation } from '../common/database-errors';
import { likeContains, pageRequest } from '../store/dto/store-list-query.dto';
import type { Paginated } from '../store/store-presenter';
import { auditScopeOf, type BillingActor } from './billing-actor';
import {
  presentPlan,
  presentPublicPlan,
  type PlanView,
  type PublicPlanView,
} from './billing-presenter';
import { CreatePlanDto, PlanListQueryDto, UpdatePlanDto } from './dto/plan.dto';
import {
  BillingInterval,
  Plan,
  PlanStatus,
  type PlanFeatures,
} from './entities/plan.entity';
import {
  Subscription,
  SubscriptionStatus,
} from './entities/subscription.entity';
import { normalizeFeatures } from './plan-rules';

export const PLAN_NOT_FOUND_MESSAGE = 'Plano não encontrado.';
export const PLAN_CODE_TAKEN_MESSAGE =
  'Já existe um plano com este código. Escolha outro.';

/** Campos editáveis do plano (lista de permitidos do PATCH). */
const PLAN_FIELDS = [
  'code',
  'name',
  'description',
  'price',
  'billing_interval',
  'trial_days',
  'max_staff_users',
  'max_products',
  'max_monthly_orders',
  'max_storage_mb',
  'features',
  'status',
  'is_public',
  'sort_order',
] as const;

type PlanField = (typeof PLAN_FIELDS)[number];

/** Comparação de valores do plano (recursos comparados já normalizados). */
function sameValue(field: PlanField, current: unknown, next: unknown): boolean {
  if (field === 'features') {
    return (
      JSON.stringify(normalizeFeatures(current as PlanFeatures)) ===
      JSON.stringify(normalizeFeatures(next as PlanFeatures))
    );
  }
  if (field === 'price') return Number(current) === Number(next);
  return (current ?? null) === (next ?? null);
}

/**
 * Planos comerciais da plataforma (superpainel). Nenhum preço é fixo no código; planos nunca são
 * apagados (assinaturas e faturas apontam para eles): para tirar de venda, desative (INACTIVE).
 */
@Injectable()
export class PlansService {
  constructor(
    @InjectRepository(Plan)
    private readonly plans: Repository<Plan>,
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
    private readonly audit: AuditService,
  ) {}

  /** GET /plans: planos à venda (ACTIVE e públicos), só com os campos comerciais. */
  async listPublic(): Promise<PublicPlanView[]> {
    const plans = await this.plans.find({
      where: { status: PlanStatus.ACTIVE, is_public: true },
      order: { sort_order: 'ASC', price: 'ASC', id: 'ASC' },
    });
    return plans.map(presentPublicPlan);
  }

  /** GET /platform/plans: ?status=&is_public=&search= (nome ou código) &page=&pageSize= */
  async list(query: PlanListQueryDto = {}): Promise<Paginated<PlanView>> {
    const { search, page, pageSize, offset } = pageRequest(query);
    const base: FindOptionsWhere<Plan> = {};
    if (query.status) base.status = query.status;
    if (query.is_public !== undefined) base.is_public = query.is_public;
    const where = search
      ? [
          { ...base, name: ILike(likeContains(search)) },
          { ...base, code: ILike(likeContains(search)) },
        ]
      : base;

    const [plans, total] = await this.plans.findAndCount({
      where,
      order: { sort_order: 'ASC', id: 'ASC' },
      skip: offset,
      take: pageSize,
    });
    const counts = await Promise.all(
      plans.map((plan) => this.activeSubscriptions(plan.id)),
    );
    return {
      items: plans.map((plan, index) =>
        presentPlan(plan, { active_subscriptions: counts[index] }),
      ),
      total,
      page,
      pageSize,
    };
  }

  async detail(id: number): Promise<PlanView> {
    const plan = await this.findOrFail(id);
    return presentPlan(plan, {
      active_subscriptions: await this.activeSubscriptions(plan.id),
    });
  }

  async findOrFail(id: number): Promise<Plan> {
    const plan = await this.plans.findOne({ where: { id } });
    if (!plan) throw new NotFoundException(PLAN_NOT_FOUND_MESSAGE);
    return plan;
  }

  /** POST /platform/plans */
  async create(dto: CreatePlanDto, actor: BillingActor): Promise<PlanView> {
    await this.assertCodeAvailable(dto.code);
    let plan: Plan;
    try {
      plan = await this.plans.save(
        this.plans.create({
          code: dto.code,
          name: dto.name,
          description: dto.description ?? null,
          price: dto.price,
          currency: 'BRL',
          billing_interval: dto.billing_interval ?? BillingInterval.MONTHLY,
          trial_days: dto.trial_days ?? 0,
          max_staff_users: dto.max_staff_users ?? null,
          max_products: dto.max_products ?? null,
          max_monthly_orders: dto.max_monthly_orders ?? null,
          max_storage_mb: dto.max_storage_mb ?? null,
          features: normalizeFeatures(dto.features),
          status: dto.status ?? PlanStatus.ACTIVE,
          is_public: dto.is_public ?? true,
          sort_order: dto.sort_order ?? 0,
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(PLAN_CODE_TAKEN_MESSAGE);
      }
      throw error;
    }

    await this.audit.record({
      actor: actor.user,
      scope: auditScopeOf(actor),
      action: 'plan.create',
      targetType: 'plan',
      targetId: plan.id,
      metadata: {
        code: plan.code,
        name: plan.name,
        price: plan.price,
        billing_interval: plan.billing_interval,
        trial_days: plan.trial_days,
        status: plan.status,
        is_public: plan.is_public,
      },
      request: actor.request,
    });
    return presentPlan(plan, { active_subscriptions: 0 });
  }

  /**
   * PATCH /platform/plans/:id: aplica só o que foi enviado e mudou. Recursos são mesclados (só as
   * chaves enviadas mudam). Assinaturas existentes continuam no plano; o preço novo vale a partir da
   * próxima fatura.
   */
  async update(
    id: number,
    dto: UpdatePlanDto,
    actor: BillingActor,
  ): Promise<PlanView> {
    const current = await this.findOrFail(id);

    const changes: Partial<Plan> = {};
    for (const field of PLAN_FIELDS) {
      let value: unknown = dto[field];
      if (value === undefined) continue;
      if (field === 'features') {
        value = normalizeFeatures({
          ...normalizeFeatures(current.features),
          ...(value as PlanFeatures),
        });
      }
      if (!sameValue(field, current[field], value)) {
        Object.assign(changes, { [field]: value });
      }
    }
    const fields = Object.keys(changes) as PlanField[];
    if (!fields.length) return this.detail(id);

    if (changes.code !== undefined) {
      await this.assertCodeAvailable(changes.code, id);
    }
    try {
      const result = await this.plans.update({ id }, changes);
      if (!result.affected) throw new NotFoundException(PLAN_NOT_FOUND_MESSAGE);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(PLAN_CODE_TAKEN_MESSAGE);
      }
      throw error;
    }

    await this.audit.record({
      actor: actor.user,
      scope: auditScopeOf(actor),
      action: 'plan.update',
      targetType: 'plan',
      targetId: id,
      metadata: {
        fields,
        // Mudanças comerciais relevantes com antes/depois (o resto, só o nome do campo)
        ...(changes.price !== undefined
          ? { price: { from: current.price, to: changes.price } }
          : {}),
        ...(changes.status !== undefined
          ? { status: { from: current.status, to: changes.status } }
          : {}),
      },
      request: actor.request,
    });
    return this.detail(id);
  }

  /** Assinaturas não canceladas do plano (indicador do superpainel). */
  private activeSubscriptions(planId: number): Promise<number> {
    return this.subscriptions.count({
      where: { plan_id: planId, status: Not(SubscriptionStatus.CANCELED) },
    });
  }

  private async assertCodeAvailable(
    code: string,
    exceptId?: number,
  ): Promise<void> {
    const taken = await this.plans.exists({
      where: exceptId === undefined ? { code } : { code, id: Not(exceptId) },
    });
    if (taken) throw new ConflictException(PLAN_CODE_TAKEN_MESSAGE);
  }
}
