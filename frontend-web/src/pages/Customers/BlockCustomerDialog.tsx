import { useState } from 'react';
import toast from 'react-hot-toast';
import ConfirmModal from '../../components/ConfirmModal';
import ReasonField from '../Platform/Subscriptions/ReasonField';
import { reasonProblem } from '../Platform/Subscriptions/formRules';
import { getApiErrorMessage, getApiErrorStatus } from '../../services/api';
import { CUSTOMER_BLOCK_REASON_MAX_LENGTH, storeCustomerService } from '../../services/storeCustomerService';

export type BlockAction = 'block' | 'unblock';

interface BlockCustomerDialogProps {
  /** Cliente escolhido (null = fechado). */
  customer: { id: number; name: string } | null;
  action: BlockAction | null;
  onClose: () => void;
  /** Depois de bloquear/desbloquear (ou quando outra pessoa já tinha feito): recarregue a lista e o detalhe. */
  onDone: (action: BlockAction) => void;
}

/**
 * Bloquear (com motivo obrigatório) ou desbloquear um cliente NESTE estabelecimento (somente Administrador):
 * POST/DELETE /store/customers/:id/block. O cliente bloqueado não orça, não pede e não paga aqui, e
 * continua comprando nas outras lojas.
 */
export default function BlockCustomerDialog({ customer, action, onClose, onDone }: BlockCustomerDialogProps) {
  if (!customer || !action) return null;
  return <BlockCustomerForm key={`${customer.id}-${action}`} customer={customer} action={action} onClose={onClose} onDone={onDone} />;
}

function BlockCustomerForm({
  customer, action, onClose, onDone,
}: Omit<BlockCustomerDialogProps, 'customer' | 'action'> & { customer: { id: number; name: string }; action: BlockAction }) {
  const [reason, setReason] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const blocking = action === 'block';
  const name = customer.name || 'este cliente';
  const reasonError = blocking ? reasonProblem(reason, { required: true, maxLength: CUSTOMER_BLOCK_REASON_MAX_LENGTH }) : null;

  async function handleConfirm() {
    if (reasonError) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    try {
      if (blocking) await storeCustomerService.block(customer.id, reason.trim());
      else await storeCustomerService.unblock(customer.id);
      toast.success(blocking ? `${name} foi bloqueado neste estabelecimento.` : `${name} foi desbloqueado.`);
      onDone(action);
      onClose();
    } catch (error) {
      const status = getApiErrorStatus(error);
      toast.error(
        getApiErrorMessage(error, blocking ? 'Não foi possível bloquear o cliente.' : 'Não foi possível desbloquear o cliente.'),
        { duration: 6000 },
      );
      // 409/404: a situação mudou (outra pessoa já bloqueou ou desbloqueou): mostra a situação atual
      if (status === 409 || status === 404) {
        onDone(action);
        onClose();
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <ConfirmModal
      isOpen
      onClose={onClose}
      onConfirm={handleConfirm}
      closeOnConfirm={false}
      loading={saving}
      title={blocking ? `Bloquear ${name}?` : `Desbloquear ${name}?`}
      message={blocking
        ? 'O cliente deixa de fazer orçamentos, pedidos e pagamentos (PIX e cartão) neste estabelecimento e vê apenas a mensagem "Não é possível fazer pedidos nesta loja. Fale com a loja.". Ele continua comprando em outras lojas. Pedidos já feitos não mudam: cancele-os no quadro de pedidos, se precisar.'
        : 'O cliente volta a fazer orçamentos, pedidos e pagamentos neste estabelecimento.'}
      confirmLabel={blocking ? 'Bloquear cliente' : 'Desbloquear'}
      isDestructive={blocking}
    >
      {blocking && (
        <ReasonField
          label="Motivo"
          required
          value={reason}
          onChange={setReason}
          maxLength={CUSTOMER_BLOCK_REASON_MAX_LENGTH}
          placeholder="Ex.: três pedidos falsos com endereço inexistente."
          hint="Fica registrado para a equipe e na auditoria. O cliente não vê o motivo."
          showError={showErrors}
          disabled={saving}
        />
      )}
    </ConfirmModal>
  );
}
