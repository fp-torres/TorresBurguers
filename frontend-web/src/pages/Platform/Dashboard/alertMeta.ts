import type { StatusTone } from '../../../components/ui';
import type { AlertSeverity } from '../../../services/platform/dashboardService';

/** Gravidade dos alertas do dashboard: selo com ícone + texto (a cor nunca vai sozinha). */
export const ALERT_SEVERITY_META: Record<AlertSeverity, { label: string; plural: string; tone: StatusTone }> = {
  critical: { label: 'Crítico', plural: 'Críticos', tone: 'danger' },
  warning: { label: 'Atenção', plural: 'Atenção', tone: 'warning' },
  info: { label: 'Informativo', plural: 'Informativos', tone: 'info' },
};

/** Título de cada tipo de alerta (backend/src/platform/metrics.ts → PLATFORM_ALERT_TYPES). */
const ALERT_TYPE_LABELS: Record<string, string> = {
  PAST_DUE_GRACE_ENDING: 'Tolerância da inadimplência terminando',
  SUBSCRIPTION_SUSPENDED: 'Assinatura suspensa',
  REFUND_PENDING: 'Estorno pendente',
  INVOICE_FAILED: 'Fatura recusada',
  NO_ACTIVE_ADMIN: 'Loja sem administrador ativo',
  STORE_SUSPENDED: 'Loja suspensa',
  INACTIVE_STORE_BILLED: 'Loja desativada com assinatura vigente',
  CANCELED_STILL_BILLED: 'Assinatura cancelada ainda cobrada',
  TRIAL_ENDING: 'Teste grátis terminando',
  ONLINE_PAYMENTS_WITHOUT_CREDENTIALS: 'Pagamento online sem conta do Mercado Pago',
};

export function alertTypeLabel(type: string): string {
  return Object.hasOwn(ALERT_TYPE_LABELS, type) ? ALERT_TYPE_LABELS[type] : type.replaceAll('_', ' ').toLowerCase() || 'Alerta';
}
