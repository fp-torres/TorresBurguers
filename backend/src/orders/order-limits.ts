import { ForbiddenException, type Logger } from '@nestjs/common';
import type { PlanLimitsService } from '../billing/plan-limits.service';
import { resolvePolicy } from '../common/rate-limit/rate-limit.service';
import { envFlag } from '../config/env';
import { MONTHLY_ORDERS_LIMIT_MESSAGE } from './order-rules';

/**
 * Teto de pedidos pagos na entrega/retirada que um cliente deixa aguardando a confirmação (PENDING)
 * numa mesma loja. Usa o mesmo número da política ORDER_CREATE (RATE_LIMIT_ORDER_CREATE, padrão 10):
 * um só ajuste controla o volume de pedidos de um cliente numa loja. RATE_LIMIT_ENABLED=false desliga.
 */
export function maxPendingOrdersPerCustomer(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  if (!envFlag('RATE_LIMIT_ENABLED', true, env)) return null;
  return resolvePolicy('ORDER_CREATE', env).limit;
}

export function pendingOrdersLimitMessage(limit: number): string {
  return `Você já tem ${limit} ${limit === 1 ? 'pedido' : 'pedidos'} aguardando a confirmação desta loja. Aguarde a loja confirmar ou cancele algum antes de fazer outro.`;
}

/**
 * Limite de pedidos do mês do plano da loja para o pedido pago na entrega/retirada.
 * `reserved` = pedidos que os pagamentos online em andamento ainda podem gerar
 * (PaymentService.reservedOrderSlots: aprovados sem pedido e cartões em análise da loja, mais os PIX
 * pendentes do próprio cliente): o pedido novo precisa caber junto com eles, como a cobrança online
 * nova já confere.
 * O 403 do PlanLimitsService fala com a equipe (nome do plano, "mude de plano"): para o cliente que
 * está comprando, a resposta é a mensagem neutra; o motivo original fica no log para a operação.
 */
export async function assertCanTakeNewOrder(
  planLimits: Pick<PlanLimitsService, 'assertWithinLimit'>,
  storeId: number,
  logger?: Pick<Logger, 'warn'>,
  reserved = 0,
): Promise<void> {
  try {
    await planLimits.assertWithinLimit(storeId, 'monthly_orders', 1 + reserved);
  } catch (error) {
    if (!(error instanceof ForbiddenException)) throw error;
    logger?.warn(
      `Loja #${storeId}: novo pedido recusado (${error.message}; ${reserved} pagamento(s) online em andamento).`,
    );
    throw new ForbiddenException(MONTHLY_ORDERS_LIMIT_MESSAGE);
  }
}
