import { useId, useState, type FormEvent } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, MailCheck, MailPlus, UserPlus } from 'lucide-react';
import toast from 'react-hot-toast';
import { CopyField, FormField, Modal, buttonClass, fieldControlClass } from '../../components/ui';
import { getApiErrorMessage, getApiErrorStatus } from '../../services/api';
import { storeInvitationService, type CreatedInvitation } from '../../services/storeInvitationService';
import { planRestrictionMessage } from '../../services/storeSubscriptionService';
import { toastPlanLimit } from '../../layouts/DefaultLayout/planLimit';
import { usePanelStore } from '../../layouts/DefaultLayout/panelStore';
import { formatDateTime } from '../../utils/format';
import { roleLabel } from '../../utils/roles';
import { isValidEmail } from '../../utils/validation';
import { TEAM_ROLE_OPTIONS, type TeamRole } from './teamRoles';

interface InviteModalProps {
  open: boolean;
  onClose: () => void;
  /** Convite criado: a tela recarrega a lista de convites pendentes. */
  onCreated: () => void;
}

/**
 * Convidar alguém para a equipe por e-mail (POST /store/invitations). O link de aceite aparece uma única
 * vez (sem provedor de e-mail, é por ele que a pessoa entra): copie e envie.
 */
export default function InviteModal({ open, onClose, onCreated }: InviteModalProps) {
  if (!open) return null;
  return <InviteForm onClose={onClose} onCreated={onCreated} />;
}

function InviteForm({ onClose, onCreated }: Omit<InviteModalProps, 'open'>) {
  const formId = useId();
  const { refresh: refreshPanel } = usePanelStore();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TeamRole>('EMPLOYEE');
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<CreatedInvitation | null>(null);
  // Recusa que não se resolve tentando de novo agora (429: limite diário de convites; 409: e-mail com conta ou
  // com convite de troca do responsável): fica no formulário, com a mensagem da API
  const [refusal, setRefusal] = useState<string | null>(null);

  const emailError = !email.trim()
    ? 'Informe o e-mail da pessoa convidada.'
    : !isValidEmail(email) ? 'Informe um e-mail válido.' : null;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (emailError) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    setRefusal(null);
    try {
      const result = await storeInvitationService.create(email.trim().toLowerCase(), role);
      setCreated(result);
      onCreated();
      toast.success('Convite criado!');
    } catch (error) {
      // 403 = equipe do plano completa; 409 = e-mail já tem conta; 400 = e-mail/perfil inválido
      const planMessage = planRestrictionMessage(error);
      if (planMessage) {
        toastPlanLimit(planMessage);
        // O selo de uso da equipe na tela acompanha o que a API contou
        void refreshPanel();
      } else {
        const status = getApiErrorStatus(error);
        // 429 traz o motivo (limite por e-mail ou da loja); sem mensagem, o texto genérico abaixo
        const message = getApiErrorMessage(error, status === 429
          ? 'Limite de convites das últimas 24 horas atingido. Tente de novo amanhã.'
          : 'Não foi possível criar o convite.');
        if (status === 429 || status === 409) setRefusal(message);
        toast.error(message, { duration: 6000 });
      }
    } finally {
      setSaving(false);
    }
  }

  function inviteAnother() {
    setCreated(null);
    setRefusal(null);
    setEmail('');
    setRole('EMPLOYEE');
    setShowErrors(false);
  }

  if (created) {
    return (
      <Modal
        open
        onClose={onClose}
        title={created.delivered ? 'Convite enviado' : 'Convite criado'}
        description={`${created.invitation.email} · ${roleLabel(created.invitation.role)}`}
        closeOnOverlayClick={false}
        footer={(
          <>
            <button type="button" onClick={inviteAnother} className={buttonClass('secondary')}>
              <UserPlus size={16} aria-hidden="true" /> Convidar outra pessoa
            </button>
            <button type="button" onClick={onClose} className={buttonClass('primary')}>Concluir</button>
          </>
        )}
      >
        <div className="space-y-4">
          <p className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-300">
            <CheckCircle2 size={18} className="shrink-0 mt-0.5 text-green-600 dark:text-green-400" aria-hidden="true" />
            <span>
              {created.delivered
                ? 'O convite foi enviado ao e-mail da pessoa: pelo link, ela cria a senha e entra direto no painel com o perfil escolhido.'
                : 'Envie o link para a pessoa: ela cria a senha e entra direto no painel com o perfil escolhido.'}
              {created.invitation.expires_at && <> O convite vale até <span className="font-bold">{formatDateTime(created.invitation.expires_at)}</span>.</>}
            </span>
          </p>
          {created.url ? (
            <CopyField label="Link de convite" value={created.url} notice={created.message || undefined} />
          ) : created.delivered ? (
            // Enviado só ao e-mail do convidado: o link não aparece para quem convidou
            <p role="status" className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200">
              <MailCheck size={18} className="shrink-0 mt-0.5 text-orange-600 dark:text-orange-400" aria-hidden="true" />
              <span>{created.message || 'Convite enviado por e-mail.'}</span>
            </p>
          ) : (
            <p className="text-sm text-amber-700 dark:text-amber-300">A API não devolveu o link. O convite também é enviado por e-mail quando houver provedor configurado.</p>
          )}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Convidar por e-mail"
      description="A pessoa recebe um link para criar a própria senha. Criar e aceitar o convite exigem uma vaga livre na equipe do plano."
      dismissible={!saving}
      footer={(
        <>
          <button type="button" onClick={onClose} disabled={saving} className={buttonClass('secondary')}>Cancelar</button>
          <button type="submit" form={formId} disabled={saving} className={buttonClass('primary')}>
            {saving ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <MailPlus size={16} aria-hidden="true" />}
            Criar convite
          </button>
        </>
      )}
    >
      <form id={formId} onSubmit={handleSubmit} noValidate className="space-y-4">
        {refusal && (
          <p role="alert" className="flex items-start gap-2 px-3 py-2.5 rounded-xl text-sm bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-200 border border-amber-200 dark:border-amber-800">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
            <span>{refusal}</span>
          </p>
        )}
        <FormField label="E-mail" required error={showErrors ? emailError : undefined}>
          {(field) => (
            <input
              {...field}
              type="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setRefusal(null);
              }}
              maxLength={160}
              placeholder="pessoa@email.com"
              autoComplete="off"
              className={fieldControlClass(showErrors && !!emailError)}
            />
          )}
        </FormField>
        <FormField label="Perfil" hint="Administrador acessa tudo; Atendente, pedidos e clientes; Cozinha, o preparo; Entregador, as entregas.">
          {(field) => (
            <select
              {...field}
              value={role}
              onChange={(event) => setRole(event.target.value as TeamRole)}
              className={fieldControlClass()}
            >
              {TEAM_ROLE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          )}
        </FormField>
      </form>
    </Modal>
  );
}
