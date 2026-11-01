import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Brackets,
  FindOptionsRelations,
  In,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { isUniqueViolation } from '../common/database-errors';
import { Order } from '../orders/entities/order.entity';
import { presentOrder, type PresentedOrder } from '../orders/order-presenter';
import { fromCents, toCents } from '../orders/order-rules';
import { OrderStatus, PaymentStatus } from '../orders/order.enums';
import type { StoreCustomersQueryDto } from './dto/store-customers.dto';
import { likeContains, pageRequest } from './dto/store-list-query.dto';
import { StoreCustomerBlock } from './entities/store-customer-block.entity';
import type { Paginated } from './store-presenter';
import type { StoreActor } from './store.service';

export const CUSTOMER_NOT_FOUND_MESSAGE = 'Cliente não encontrado.';
export const CUSTOMER_ALREADY_BLOCKED_MESSAGE =
  'Este cliente já está bloqueado nesta loja.';
export const CUSTOMER_NOT_BLOCKED_MESSAGE =
  'Este cliente não está bloqueado nesta loja.';
/** Pedidos devolvidos no detalhe do cliente (os mais recentes); as estatísticas contam todos. */
export const CUSTOMER_ORDERS_LIMIT = 50;

/** Bloqueio do cliente NESTA loja, como sai para a equipe (o cliente nunca vê o motivo). */
export interface StoreCustomerBlockView {
  reason: string;
  blocked_at: Date;
  /** ADMIN que bloqueou (null se a conta dele foi excluída de vez). */
  blocked_by: { id: number; name: string } | null;
}

export interface StoreCustomerSummary {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  orders_count: number;
  /** Soma dos pedidos pagos e não cancelados desta loja. */
  total_spent: number;
  last_order_at: Date | null;
  /** Bloqueado nesta loja: não orça, não pede e não paga aqui (as outras lojas não são afetadas). */
  blocked: boolean;
  block: StoreCustomerBlockView | null;
}

export interface StoreCustomerStats {
  orders_count: number;
  total_spent: number;
  first_order_at: Date | null;
  last_order_at: Date | null;
}

export interface StoreCustomerDetail {
  customer: { id: number; name: string; email: string; phone: string | null };
  stats: StoreCustomerStats;
  /** Bloqueio nesta loja (null = o cliente pode comprar aqui). */
  block: StoreCustomerBlockView | null;
  orders: PresentedOrder[];
}

interface CustomerRow {
  id: number | string;
  name: string;
  email: string;
  phone: string | null;
  orders_count: number | string;
  total_spent: number | string | null;
  first_order_at?: Date | string | null;
  last_order_at: Date | string | null;
}

// Relações do pedido completo (mesmas do OrdersService); withDeleted mantém no histórico produtos,
// adicionais e entregadores que foram para a lixeira.
const ORDER_RELATIONS: FindOptionsRelations<Order> = {
  items: { product: true, addons: true },
  user: true,
  address: true,
  driver: true,
};

const toDate = (value: Date | string | null | undefined): Date | null =>
  value === null || value === undefined ? null : new Date(value);

const money = (value: number | string | null): number =>
  fromCents(toCents(value ?? 0));

function presentBlock(block: StoreCustomerBlock): StoreCustomerBlockView {
  return {
    reason: block.reason,
    blocked_at: block.blocked_at,
    blocked_by: block.blocked_by
      ? { id: block.blocked_by.id, name: block.blocked_by.name }
      : null,
  };
}

/**
 * Clientes da loja = contas que fizeram pedidos NESTA loja. Tudo é derivado de orders.store_id
 * (clientes são globais: a mesma conta compra em várias lojas, e cada loja só vê os próprios pedidos).
 * Contas excluídas (lixeira) não aparecem.
 *
 * Bloqueio (store_customer_blocks): o ADMIN bloqueia um cliente da loja (abuso, pedidos falsos) e ele
 * deixa de orçar, pedir e pagar NESTA loja (403 genérico, conferido no OrderPricingService). Bloquear e
 * desbloquear são auditados (store.customer.block / store.customer.unblock).
 */
@Injectable()
export class StoreCustomersService {
  constructor(
    @InjectRepository(Order)
    private readonly orders: Repository<Order>,
    private readonly audit: AuditService,
  ) {}

  /** Bloqueios (mesma conexão dos pedidos: o módulo não precisa registrar outro repositório). */
  private get blocks(): Repository<StoreCustomerBlock> {
    return this.orders.manager.getRepository(StoreCustomerBlock);
  }

  /** GET /store/customers: paginado no banco, mais recentes primeiro (?blocked filtra os bloqueados). */
  async list(
    storeId: number,
    query: StoreCustomersQueryDto,
  ): Promise<Paginated<StoreCustomerSummary>> {
    const { search, page, pageSize, offset } = pageRequest(query);
    const base = this.customersOf(storeId, search, query.blocked);

    const [count, rows] = await Promise.all([
      base
        .clone()
        .select('COUNT(DISTINCT u.id)', 'total')
        .getRawOne<{ total: number | string }>(),
      this.withStats(base.clone())
        .groupBy('u.id')
        .orderBy('MAX(o.created_at)', 'DESC')
        .addOrderBy('u.id', 'DESC')
        .offset(offset)
        .limit(pageSize)
        .getRawMany<CustomerRow>(),
    ]);
    const blocks = await this.blocksOf(
      storeId,
      rows.map((row) => Number(row.id)),
    );

    return {
      items: rows.map((row) => {
        const id = Number(row.id);
        const block = blocks.get(id) ?? null;
        return {
          id,
          name: row.name,
          email: row.email,
          phone: row.phone ?? null,
          orders_count: Number(row.orders_count),
          total_spent: money(row.total_spent),
          last_order_at: toDate(row.last_order_at),
          blocked: block !== null,
          block,
        };
      }),
      total: Number(count?.total ?? 0),
      page,
      pageSize,
    };
  }

  /** GET /store/customers/:userId: 404 (uniforme) se o cliente não tem pedido nesta loja. */
  async detail(storeId: number, userId: number): Promise<StoreCustomerDetail> {
    const row = await this.withStats(this.customersOf(storeId, null))
      .addSelect('MIN(o.created_at)', 'first_order_at')
      .andWhere('u.id = :userId', { userId })
      .groupBy('u.id')
      .getRawOne<CustomerRow>();
    if (!row) throw new NotFoundException(CUSTOMER_NOT_FOUND_MESSAGE);

    const [orders, blocks] = await Promise.all([
      this.orders.find({
        where: { store_id: storeId, user: { id: userId } },
        relations: ORDER_RELATIONS,
        withDeleted: true,
        order: { created_at: 'DESC', id: 'DESC' },
        take: CUSTOMER_ORDERS_LIMIT,
      }),
      this.blocksOf(storeId, [userId]),
    ]);

    return {
      customer: {
        id: Number(row.id),
        name: row.name,
        email: row.email,
        phone: row.phone ?? null,
      },
      stats: {
        orders_count: Number(row.orders_count),
        total_spent: money(row.total_spent),
        first_order_at: toDate(row.first_order_at),
        last_order_at: toDate(row.last_order_at),
      },
      block: blocks.get(userId) ?? null,
      orders: orders.map((order) => presentOrder(order)),
    };
  }

  /**
   * POST /store/customers/:userId/block — só clientes que já pediram NESTA loja (404 uniforme, como o
   * detalhe); 409 se já estiver bloqueado. Pagamentos já aprovados continuam virando pedido.
   */
  async block(
    storeId: number,
    userId: number,
    reason: string,
    actor: StoreActor,
  ): Promise<StoreCustomerBlockView> {
    const isCustomer = await this.customersOf(storeId, null)
      .andWhere('u.id = :userId', { userId })
      .getExists();
    if (!isCustomer) throw new NotFoundException(CUSTOMER_NOT_FOUND_MESSAGE);

    try {
      await this.blocks.insert({
        store_id: storeId,
        user_id: userId,
        reason,
        blocked_by_user_id: actor.user.id,
      });
    } catch (error) {
      // PK (loja + cliente): já bloqueado (inclusive por outro ADMIN ao mesmo tempo)
      if (isUniqueViolation(error))
        throw new ConflictException(CUSTOMER_ALREADY_BLOCKED_MESSAGE);
      throw error;
    }

    await this.audit.record({
      actor: actor.user,
      storeId,
      action: 'store.customer.block',
      targetType: 'user',
      targetId: userId,
      metadata: { reason },
      request: actor.request,
    });

    const block = (await this.blocksOf(storeId, [userId])).get(userId);
    // Desbloqueado por outro ADMIN entre a gravação e a leitura
    if (!block) throw new NotFoundException(CUSTOMER_NOT_BLOCKED_MESSAGE);
    return block;
  }

  /** DELETE /store/customers/:userId/block — 404 se o cliente não está bloqueado nesta loja. */
  async unblock(
    storeId: number,
    userId: number,
    actor: StoreActor,
  ): Promise<void> {
    const current = await this.blocks.findOne({
      where: { store_id: storeId, user_id: userId },
    });
    if (!current) throw new NotFoundException(CUSTOMER_NOT_BLOCKED_MESSAGE);

    const { affected } = await this.blocks.delete({
      store_id: storeId,
      user_id: userId,
    });
    if (!affected) throw new NotFoundException(CUSTOMER_NOT_BLOCKED_MESSAGE);

    await this.audit.record({
      actor: actor.user,
      storeId,
      action: 'store.customer.unblock',
      targetType: 'user',
      targetId: userId,
      // O bloqueio desfeito (a linha some da tabela; o histórico fica aqui)
      metadata: {
        reason: current.reason,
        blocked_at: current.blocked_at,
        blocked_by_user_id: current.blocked_by_user_id,
      },
      request: actor.request,
    });
  }

  /** Bloqueios desta loja para os clientes informados (com o nome de quem bloqueou). */
  private async blocksOf(
    storeId: number,
    userIds: number[],
  ): Promise<Map<number, StoreCustomerBlockView>> {
    if (!userIds.length) return new Map();
    const rows = await this.blocks.find({
      where: { store_id: storeId, user_id: In(userIds) },
      relations: { blocked_by: true },
      // Quem bloqueou pode estar na lixeira: o nome continua aparecendo
      withDeleted: true,
    });
    return new Map(rows.map((row) => [row.user_id, presentBlock(row)]));
  }

  /** Pedidos desta loja com o cliente (conta ativa), opcionalmente filtrados pela busca e pelo bloqueio. */
  private customersOf(
    storeId: number,
    search: string | null,
    blocked?: boolean,
  ): SelectQueryBuilder<Order> {
    const qb = this.orders
      .createQueryBuilder('o')
      .innerJoin('o.user', 'u')
      .where('o.store_id = :storeId', { storeId });

    if (search) {
      const digits = search.replace(/\D/g, '');
      qb.andWhere(
        new Brackets((match) => {
          match
            .where('u.name ILIKE :term')
            .orWhere('u.email ILIKE :term')
            .orWhere('u.phone ILIKE :term');
          // "(21) 99999-0000" encontra o telefone gravado com ou sem pontuação
          if (digits.length >= 3) {
            match.orWhere(
              "regexp_replace(COALESCE(u.phone, ''), '[^0-9]', '', 'g') LIKE :digits",
            );
          }
        }),
        { term: likeContains(search), digits: `%${digits}%` },
      );
    }

    if (blocked !== undefined) {
      qb.andWhere(
        `${blocked ? '' : 'NOT '}EXISTS (SELECT 1 FROM "store_customer_blocks" "blk" WHERE "blk"."store_id" = :storeId AND "blk"."user_id" = u.id)`,
      );
    }
    return qb;
  }

  private withStats(qb: SelectQueryBuilder<Order>): SelectQueryBuilder<Order> {
    return qb
      .select('u.id', 'id')
      .addSelect('u.name', 'name')
      .addSelect('u.email', 'email')
      .addSelect('u.phone', 'phone')
      .addSelect('COUNT(o.id)', 'orders_count')
      .addSelect(
        'COALESCE(SUM(o.total_price) FILTER (WHERE o.payment_status = :paid AND o.status <> :canceled), 0)',
        'total_spent',
      )
      .addSelect('MAX(o.created_at)', 'last_order_at')
      .setParameter('paid', PaymentStatus.PAID)
      .setParameter('canceled', OrderStatus.CANCELED);
  }
}
