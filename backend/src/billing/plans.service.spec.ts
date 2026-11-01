import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { CreatePlanDto, PlanListQueryDto, UpdatePlanDto } from './dto/plan.dto';
import { BillingInterval, Plan, PlanStatus } from './entities/plan.entity';
import {
  Subscription,
  SubscriptionStatus,
} from './entities/subscription.entity';
import {
  PLAN_CODE_TAKEN_MESSAGE,
  PLAN_NOT_FOUND_MESSAGE,
  PlansService,
} from './plans.service';
import {
  createBillingDb,
  rowsWhere,
  seedPlan,
  seedStore,
  seedSubscription,
  SUPER_ADMIN,
} from './testing/billing-fixtures.helper-spec';

/** Mesma configuração do ValidationPipe global (config/app-setup.ts). */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

async function validate<T>(
  metatype: new () => T,
  value: unknown,
  type: 'body' | 'query' = 'body',
): Promise<T> {
  return (await pipe.transform(value, { type, metatype })) as T;
}

async function messages(
  metatype: new () => unknown,
  value: unknown,
): Promise<string[]> {
  try {
    await validate(metatype, value);
  } catch (error) {
    if (error instanceof BadRequestException) {
      const response = error.getResponse() as { message: string[] };
      return response.message;
    }
    throw error;
  }
  return [];
}

const VALID = {
  code: ' Essencial ',
  name: 'Essencial',
  price: '99,90',
  billing_interval: 'monthly',
  trial_days: 14,
  max_staff_users: 3,
  max_products: null,
  features: { online_payments: true },
};

function setup() {
  const db = createBillingDb();
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new PlansService(
    db.repository(Plan) as never,
    db.repository(Subscription) as never,
    audit as never,
  );
  return { db, service, audit };
}

const actor = { user: SUPER_ADMIN };

describe('Planos', () => {
  describe('validação (DTOs)', () => {
    it('normaliza e aceita um plano válido', async () => {
      const dto = await validate(CreatePlanDto, VALID);
      expect(dto).toMatchObject({
        code: 'essencial',
        price: 99.9,
        billing_interval: BillingInterval.MONTHLY,
        trial_days: 14,
        max_staff_users: 3,
        max_products: null,
        features: { online_payments: true },
      });
    });

    it('recusa código fora do padrão, preço negativo, teste fora de 0-365 e limite < 1', async () => {
      expect(
        await messages(CreatePlanDto, {
          ...VALID,
          code: 'plano pro!',
          price: -1,
          trial_days: 400,
          max_staff_users: 0,
          max_monthly_orders: 2.5,
        }),
      ).toEqual(
        expect.arrayContaining([
          'Código do plano inválido: use letras minúsculas, números e hífens (ex.: essencial, pro-anual).',
          'O preço não pode ser negativo.',
          'Os dias de teste grátis devem ser um número inteiro de 0 a 365.',
          'O limite de usuários da equipe deve ser um número inteiro a partir de 1 (ou null para ilimitado).',
          'O limite de pedidos por mês deve ser um número inteiro a partir de 1 (ou null para ilimitado).',
        ]),
      );
    });

    it('recursos: só as chaves conhecidas, com true/false', async () => {
      expect(
        await messages(CreatePlanDto, {
          ...VALID,
          features: { online_payments: true, delivery_drones: true },
        }),
      ).toEqual([
        'Recurso desconhecido: "delivery_drones". Use: online_payments, advanced_reports, custom_branding.',
      ]);
      expect(
        await messages(CreatePlanDto, {
          ...VALID,
          features: { custom_branding: 'sim' },
        }),
      ).toEqual(['O recurso custom_branding deve ser true ou false.']);
      expect(
        await messages(CreatePlanDto, {
          ...VALID,
          features: ['online_payments'],
        }),
      ).toHaveLength(1);
    });

    it('obrigatórios, enums e campos extras', async () => {
      expect(await messages(CreatePlanDto, {})).toEqual(
        expect.arrayContaining([
          'O código do plano é obrigatório.',
          'O nome do plano é obrigatório.',
          'Informe um preço válido (ex.: 99.90).',
        ]),
      );
      expect(
        await messages(CreatePlanDto, {
          ...VALID,
          billing_interval: 'WEEKLY',
          status: 'DELETED',
        }),
      ).toEqual([
        'Periodicidade inválida. Use MONTHLY (mensal) ou YEARLY (anual).',
        'Situação do plano inválida. Use ACTIVE (disponível) ou INACTIVE (indisponível para novas contratações).',
      ]);
      expect(
        await messages(CreatePlanDto, { ...VALID, currency: 'USD' }),
      ).toEqual(['property currency should not exist']);
    });

    it('edição parcial: null recusado no que é obrigatório, aceito nos limites (ilimitado)', async () => {
      await expect(
        validate(UpdatePlanDto, { max_products: null, description: '' }),
      ).resolves.toMatchObject({ max_products: null, description: null });
      expect(await messages(UpdatePlanDto, { name: null })).toEqual([
        'O nome do plano é obrigatório.',
      ]);
      expect(await messages(UpdatePlanDto, { price: null })).toHaveLength(1);
    });

    it('filtros da lista', async () => {
      await expect(
        validate(
          PlanListQueryDto,
          { status: 'inactive', is_public: 'false', page: '2' },
          'query',
        ),
      ).resolves.toMatchObject({
        status: PlanStatus.INACTIVE,
        is_public: false,
        page: 2,
      });
    });
  });

  describe('PlansService', () => {
    it('cria com padrões (recursos todos explícitos) e audita', async () => {
      const { db, service, audit } = setup();
      const dto = await validate(CreatePlanDto, VALID);

      const created = await service.create(dto, actor);

      expect(created).toMatchObject({
        code: 'essencial',
        price: 99.9,
        currency: 'BRL',
        monthly_price: 99.9,
        status: PlanStatus.ACTIVE,
        is_public: true,
        sort_order: 0,
        features: {
          online_payments: true,
          advanced_reports: false,
          custom_branding: false,
        },
        active_subscriptions: 0,
      });
      expect(rowsWhere(db, 'plans')).toHaveLength(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'plan.create',
          targetId: created.id,
          actor: SUPER_ADMIN,
        }),
      );
    });

    it('limite de armazenamento (max_storage_mb): criar, validar, editar com auditoria e só no superpainel', async () => {
      expect(
        await messages(CreatePlanDto, { ...VALID, max_storage_mb: 0 }),
      ).toEqual([
        'O limite de armazenamento (MB) deve ser um número inteiro a partir de 1 (ou null para ilimitado).',
      ]);
      for (const invalid of [-5, 1.5, 'muito', true]) {
        expect(
          await messages(CreatePlanDto, { ...VALID, max_storage_mb: invalid }),
        ).toHaveLength(1);
      }
      await expect(
        validate(UpdatePlanDto, { max_storage_mb: null }),
      ).resolves.toMatchObject({ max_storage_mb: null });

      const { db, service, audit } = setup();
      const created = await service.create(
        await validate(CreatePlanDto, { ...VALID, max_storage_mb: ' 500 ' }),
        actor,
      );
      expect(created.max_storage_mb).toBe(500);
      expect(rowsWhere(db, 'plans')[0].max_storage_mb).toBe(500);
      // Padrão: ilimitado
      const other = await service.create(
        await validate(CreatePlanDto, { ...VALID, code: 'outro' }),
        actor,
      );
      expect(other.max_storage_mb).toBeNull();

      const updated = await service.update(
        created.id,
        await validate(UpdatePlanDto, { max_storage_mb: null }),
        actor,
      );
      expect(updated.max_storage_mb).toBeNull();
      expect(audit.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'plan.update',
          metadata: expect.objectContaining({
            fields: ['max_storage_mb'],
          }) as unknown,
        }),
      );
      // Por ora fora da página pública de planos (GET /plans)
      expect((await service.listPublic())[0]).not.toHaveProperty(
        'max_storage_mb',
      );
    });

    it('código repetido → 409', async () => {
      const { db, service } = setup();
      seedPlan(db, { code: 'essencial' });
      await expect(
        service.create(await validate(CreatePlanDto, VALID), actor),
      ).rejects.toThrow(new ConflictException(PLAN_CODE_TAKEN_MESSAGE));
    });

    it('edita só o que mudou, mescla recursos, confere código único e audita os campos', async () => {
      const { db, service, audit } = setup();
      const plan = seedPlan(db, {
        code: 'pro',
        price: 199.9,
        features: { online_payments: true, advanced_reports: true },
      });
      seedPlan(db, { code: 'basico' });

      const updated = await service.update(
        plan.id,
        await validate(UpdatePlanDto, {
          price: 149.9,
          features: { custom_branding: true },
          status: 'INACTIVE',
        }),
        actor,
      );
      expect(updated).toMatchObject({
        price: 149.9,
        status: PlanStatus.INACTIVE,
        features: {
          online_payments: true,
          advanced_reports: true,
          custom_branding: true,
        },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'plan.update',
          metadata: expect.objectContaining({
            fields: ['price', 'features', 'status'],
            price: { from: 199.9, to: 149.9 },
          }) as unknown,
        }),
      );

      // Nada mudou: sem escrita nem auditoria
      audit.record.mockClear();
      await service.update(
        plan.id,
        await validate(UpdatePlanDto, { price: 149.9 }),
        actor,
      );
      expect(audit.record).not.toHaveBeenCalled();

      await expect(
        service.update(
          plan.id,
          await validate(UpdatePlanDto, { code: 'basico' }),
          actor,
        ),
      ).rejects.toThrow(new ConflictException(PLAN_CODE_TAKEN_MESSAGE));
      await expect(
        service.update(999, await validate(UpdatePlanDto, {}), actor),
      ).rejects.toThrow(new NotFoundException(PLAN_NOT_FOUND_MESSAGE));
    });

    it('lista com filtros, busca e paginação; conta as assinaturas vigentes', async () => {
      const { db, service } = setup();
      seedStore(db, { id: 7 });
      seedStore(db, { id: 8 });
      const pro = seedPlan(db, { code: 'pro', name: 'Pro', sort_order: 2 });
      seedPlan(db, { code: 'essencial', name: 'Essencial', sort_order: 1 });
      seedPlan(db, {
        code: 'legado',
        name: 'Plano legado',
        status: PlanStatus.INACTIVE,
        is_public: false,
        sort_order: 999,
      });
      seedSubscription(db, { store_id: 7, plan_id: pro.id });
      seedSubscription(db, {
        store_id: 8,
        plan_id: pro.id,
        status: SubscriptionStatus.CANCELED,
      });

      const all = await service.list({});
      expect(all.total).toBe(3);
      expect(all.items.map((item) => item.code)).toEqual([
        'essencial',
        'pro',
        'legado',
      ]);
      expect(all.items[1].active_subscriptions).toBe(1);

      await expect(
        service.list({ status: PlanStatus.ACTIVE, search: 'PR' }),
      ).resolves.toMatchObject({ total: 1, items: [{ code: 'pro' }] });
      await expect(
        service.list({ page: 2, pageSize: 2 }),
      ).resolves.toMatchObject({
        total: 3,
        page: 2,
        pageSize: 2,
        items: [{ code: 'legado' }],
      });
      // % e _ na busca são literais
      await expect(service.list({ search: '%' })).resolves.toMatchObject({
        total: 0,
      });
    });

    it('públicos: só ACTIVE e is_public, com campos comerciais', async () => {
      const { db, service } = setup();
      seedPlan(db, { code: 'b', price: 199.9, sort_order: 1 });
      seedPlan(db, { code: 'a', price: 99.9, sort_order: 1 });
      seedPlan(db, { code: 'oculto', is_public: false });
      seedPlan(db, { code: 'inativo', status: PlanStatus.INACTIVE });
      seedPlan(db, {
        code: 'anual',
        price: 1200,
        billing_interval: BillingInterval.YEARLY,
        sort_order: 5,
      });
      // 1199.88 ÷ 12 em ponto flutuante = 99.99000000000001: a resposta vem em centavos
      seedPlan(db, {
        code: 'anual-quebrado',
        price: 1199.88,
        billing_interval: BillingInterval.YEARLY,
        sort_order: 6,
      });

      const plans = await service.listPublic();

      expect(plans.map((plan) => plan.code)).toEqual([
        'a',
        'b',
        'anual',
        'anual-quebrado',
      ]);
      expect(plans[2]).toMatchObject({ monthly_price: 100, price: 1200 });
      expect(plans[3].monthly_price).toBe(99.99);
      expect(Object.keys(plans[0]).sort()).toEqual(
        [
          'billing_interval',
          'code',
          'currency',
          'description',
          'features',
          'id',
          'max_monthly_orders',
          'max_products',
          'max_staff_users',
          'monthly_price',
          'name',
          'price',
          'trial_days',
        ].sort(),
      );
    });
  });
});
