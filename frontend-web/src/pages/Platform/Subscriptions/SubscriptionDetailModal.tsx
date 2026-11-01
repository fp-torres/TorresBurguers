import { Modal, buttonClass } from '../../../components/ui';
import type { PlatformSubscriptionDetail } from '../../../services/platform/billingParsers';
import SubscriptionManager from './SubscriptionManager';

interface SubscriptionDetailModalProps {
  /** Assinatura aberta (null = fechado). */
  subscriptionId: number | null;
  /** Nome da loja para o título enquanto o detalhe carrega (opcional). */
  storeName?: string | null;
  onClose: () => void;
  /** Alguma ação mudou a assinatura ou as faturas (a lista recarrega). */
  onChanged?: (detail: PlatformSubscriptionDetail) => void;
}

/** Detalhe da assinatura em diálogo (tela de Assinaturas): eventos, faturas e as mesmas ações da aba do estabelecimento. */
export default function SubscriptionDetailModal({ subscriptionId, storeName, onClose, onChanged }: SubscriptionDetailModalProps) {
  return (
    <Modal
      open={subscriptionId !== null}
      onClose={onClose}
      size="xl"
      title={storeName ? `Assinatura · ${storeName}` : `Assinatura #${subscriptionId ?? ''}`}
      description="Plano, situação, uso, faturas e histórico. Toda alteração é registrada na auditoria."
      footer={<button type="button" onClick={onClose} className={buttonClass('secondary')}>Fechar</button>}
    >
      {subscriptionId !== null && (
        <SubscriptionManager key={subscriptionId} subscriptionId={subscriptionId} showStoreLink headingLevel={3} onChanged={onChanged} />
      )}
    </Modal>
  );
}
