import type { StatusTone } from '../../components/ui';
import type { PaymentTone } from '../../utils/orders';

// Tons dos selos (StatusBadge) de pedidos no painel: Clientes, Dashboard e relatórios.

/** Situação do pedido. */
export function orderStatusTone(status: string): StatusTone {
  switch (status) {
    case 'PENDING':
      return 'warning';
    case 'PREPARING':
    case 'READY_FOR_PICKUP':
    case 'DELIVERING':
      return 'info';
    case 'DONE':
      return 'success';
    default:
      return 'neutral';
  }
}

/** Situação do pagamento (paymentStatusTone de utils/orders). */
export const PAYMENT_STATUS_TONES: Record<PaymentTone, StatusTone> = {
  paid: 'success',
  refunded: 'info',
  alert: 'danger',
  pending: 'warning',
  none: 'neutral',
};
