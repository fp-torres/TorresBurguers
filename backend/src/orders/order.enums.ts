// Enums do pedido em arquivo próprio: as regras puras (order-rules.ts) e os testes
// usam estes valores sem carregar as entidades do TypeORM.

export enum OrderStatus {
  PENDING = 'PENDING', // Aguardando a loja aceitar
  PREPARING = 'PREPARING', // Em preparo na cozinha
  READY_FOR_PICKUP = 'READY_FOR_PICKUP', // Pronto (retirada no balcão ou aguardando entregador)
  DELIVERING = 'DELIVERING', // Saiu para entrega
  DONE = 'DONE', // Entregue / retirado (final)
  CANCELED = 'CANCELED', // Cancelado (final)
}

export enum OrderType {
  DELIVERY = 'DELIVERY',
  TAKEOUT = 'TAKEOUT',
}

/**
 * Valores novos entram no fim: o synchronize do TypeORM recria o tipo enum do Postgres
 * (renomeia o antigo, cria o novo e converte a coluna via ::text), e todos os valores já
 * gravados continuam existindo.
 */
export enum PaymentStatus {
  PENDING = 'PENDING',
  PAID = 'PAID',
  FAILED = 'FAILED',
  /** Pago online e estornado depois do cancelamento. */
  REFUNDED = 'REFUNDED',
  /** Pago online, cancelado, e o estorno falhou: a equipe precisa resolver. */
  REFUND_PENDING = 'REFUND_PENDING',
}
