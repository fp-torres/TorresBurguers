import { useId, useState, type FormEvent } from 'react';
import { AlertTriangle, Info, Loader2, Save } from 'lucide-react';
import toast from 'react-hot-toast';
import { FormField, Modal, buttonClass, fieldControlClass } from '../../../components/ui';
import ConfirmModal from '../../../components/ConfirmModal';
import { getApiErrorMessage } from '../../../services/api';
import {
  STATUS_REASON_MAX_LENGTH, platformStoresService, type PlatformStoreDetail, type StoreMutationResult, type StoreProfilePayload, type StoreStatusAction,
} from '../../../services/platform/storesService';
import ReasonField from '../Subscriptions/ReasonField';
import { reasonProblem } from '../Subscriptions/formRules';
import StoreProfileFields from '../StoreNew/StoreProfileFields';
import {
  STORE_FIELD_LIMITS, profileChanges, profileErrors, profileFromStore, profilePayload, slugProblem, type StoreProfileValues,
} from '../StoreNew/storeForm';
import { CUSTOM_DOMAIN_MAX_LENGTH, cleanSlugInput, domainError, normalizeDomain } from '../../../utils/validation';

// ---------------------------------------------------------------------------
// Situação da loja: suspender, reativar, desativar, restaurar
// ---------------------------------------------------------------------------

interface StatusChangeDialogProps {
  store: PlatformStoreDetail;
  /** Ação pedida (null = fechado). */
  action: StoreStatusAction | null;
  onClose: () => void;
  onDone: (result: StoreMutationResult, action: StoreStatusAction) => void;
}

const STATUS_COPY: Record<StoreStatusAction, { title: string; confirm: string; success: string; destructive: boolean }> = {
  suspend: { title: 'Suspender o estabelecimento?', confirm: 'Suspender', success: 'Estabelecimento suspenso.', destructive: true },
  reactivate: { title: 'Reativar o estabelecimento?', confirm: 'Reativar', success: 'Estabelecimento reativado.', destructive: false },
  deactivate: { title: 'Desativar o estabelecimento?', confirm: 'Desativar', success: 'Estabelecimento desativado.', destructive: true },
  restore: { title: 'Restaurar o estabelecimento?', confirm: 'Restaurar', success: 'Estabelecimento restaurado.', destructive: false },
};

function statusMessage(store: PlatformStoreDetail, action: StoreStatusAction): string {
  const name = store.name;
  switch (action) {
    case 'suspend':
      return `${name} deixa de aceitar pedidos novos e alterações (cardápio, equipe e configurações). A equipe continua consultando o painel e concluindo os pedidos em andamento; nada é apagado. O motivo aparece para a equipe.${store.is_default_store ? ' Esta é a loja padrão: as rotas antigas (app mobile) continuam respondendo, mas sem aceitar pedidos.' : ''}`;
    case 'deactivate':
      return `${name} sai do ar: a vitrine responde "não encontrada" e a equipe não entra no painel. Nada é apagado e a loja pode ser restaurada depois.${store.is_default_store ? ' Esta é a loja padrão: as rotas antigas sem o endereço da loja (app mobile) passam a responder 404 até restaurar a loja ou escolher outra loja padrão em Configurações.' : ''}`;
    case 'reactivate':
      return `${name} volta a vender e a equipe volta a alterar cardápio e configurações (se a assinatura permitir).`;
    case 'restore':
    default:
      return `${name} volta ao ar (vitrine e painel), como estava antes da desativação. A assinatura continua valendo as regras dela.`;
  }
}

/** POST /platform/stores/:id/{suspend,reactivate,deactivate,restore} com motivo (obrigatório ao suspender e desativar). */
export function StatusChangeDialog({ store, action, onClose, onDone }: StatusChangeDialogProps) {
  if (!action) return null;
  return <StatusChangeForm key={action} store={store} action={action} onClose={onClose} onDone={onDone} />;
}

function StatusChangeForm({ store, action, onClose, onDone }: Omit<StatusChangeDialogProps, 'action'> & { action: StoreStatusAction }) {
  const requiresReason = action === 'suspend' || action === 'deactivate';
  const [reason, setReason] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const reasonError = reasonProblem(reason, { required: requiresReason, maxLength: STATUS_REASON_MAX_LENGTH });
  const copy = STATUS_COPY[action];

  async function handleConfirm() {
    if (reasonError) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    try {
      const result = await platformStoresService.changeStatus(store.id, action, reason.trim() || null);
      toast.success(copy.success);
      onDone(result, action);
      onClose();
    } catch (error) {
      // 409: a situação não permite a transição ou mudou durante a operação (a API explica)
      toast.error(getApiErrorMessage(error, 'Não foi possível mudar a situação do estabelecimento.'), { duration: 6000 });
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
      title={copy.title}
      message={statusMessage(store, action)}
      confirmLabel={copy.confirm}
      isDestructive={copy.destructive}
    >
      <ReasonField
        label={requiresReason ? 'Motivo' : 'Observação (opcional)'}
        required={requiresReason}
        value={reason}
        onChange={setReason}
        maxLength={STATUS_REASON_MAX_LENGTH}
        placeholder={requiresReason ? 'Ex.: solicitação do responsável, loja fechada para reforma.' : 'Ex.: pendência resolvida no chamado 1234.'}
        hint={requiresReason ? 'Aparece para a equipe da loja e fica na auditoria.' : 'Vai só para a auditoria.'}
        showError={showErrors}
      />
    </ConfirmModal>
  );
}

// ---------------------------------------------------------------------------
// Dados administrativos e endereço (slug)
// ---------------------------------------------------------------------------

interface EditStoreDialogProps {
  open: boolean;
  store: PlatformStoreDetail;
  onClose: () => void;
  onDone: (result: StoreMutationResult) => void;
}

type StoreChanges = Partial<StoreProfilePayload> & { name?: string; slug?: string; custom_domain?: string | null };

/**
 * PATCH /platform/stores/:id (só o que mudou): nome, endereço da loja (slug), domínio próprio e cadastro.
 * Mudar o slug pede confirmação: links e QR codes antigos deixam de funcionar.
 */
export function EditStoreDialog({ open, store, onClose, onDone }: EditStoreDialogProps) {
  if (!open) return null;
  return <EditStoreForm store={store} onClose={onClose} onDone={onDone} />;
}

function EditStoreForm({ store, onClose, onDone }: Omit<EditStoreDialogProps, 'open'>) {
  const formId = useId();
  const [name, setName] = useState(store.name);
  const [slug, setSlug] = useState(store.slug);
  const [domain, setDomain] = useState(store.custom_domain ?? '');
  const [profile, setProfile] = useState<StoreProfileValues>(() => profileFromStore(store));
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmSlug, setConfirmSlug] = useState<StoreChanges | null>(null);

  const trimmedName = name.trim();
  const nameError = !trimmedName ? 'Informe o nome do estabelecimento.' : trimmedName.length > STORE_FIELD_LIMITS.name ? `Use no máximo ${STORE_FIELD_LIMITS.name} caracteres.` : null;
  const slugError = slugProblem(slug);
  const domainIssue = domainError(domain);
  const problems = profileErrors(profile);
  const hasErrors = !!nameError || !!slugError || !!domainIssue || Object.keys(problems).length > 0;

  async function save(changes: StoreChanges) {
    setSaving(true);
    try {
      const result = await platformStoresService.update(store.id, changes);
      toast.success('Dados do estabelecimento atualizados.');
      onDone(result);
      onClose();
    } catch (error) {
      // 409: slug ou domínio em uso; 400: dado inválido (a API explica)
      toast.error(getApiErrorMessage(error, 'Não foi possível salvar os dados.'), { duration: 6000 });
      setConfirmSlug(null);
    } finally {
      setSaving(false);
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (hasErrors) {
      setShowErrors(true);
      return;
    }
    const nextDomain = normalizeDomain(domain) || null;
    const changes: StoreChanges = { ...profileChanges(store, profilePayload(profile)) };
    if (trimmedName !== store.name) changes.name = trimmedName;
    if (slug !== store.slug) changes.slug = slug;
    if (nextDomain !== (store.custom_domain ?? null)) changes.custom_domain = nextDomain;
    if (Object.keys(changes).length === 0) {
      toast('Nada mudou.', { icon: 'ℹ️' });
      onClose();
      return;
    }
    if (changes.slug !== undefined) {
      setConfirmSlug(changes);
      return;
    }
    void save(changes);
  }

  return (
    <>
      <Modal
        open
        onClose={onClose}
        size="xl"
        title="Editar dados do estabelecimento"
        description="Dados administrativos e endereço da loja. Operação, identidade visual e entrega são configurados pela equipe da loja."
        dismissible={!saving}
        footer={(
          <>
            <button type="button" onClick={onClose} disabled={saving} className={buttonClass('secondary')}>Cancelar</button>
            <button type="submit" form={formId} disabled={saving} className={buttonClass('primary')}>
              {saving ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}
              Salvar
            </button>
          </>
        )}
      >
        <form id={formId} onSubmit={handleSubmit} noValidate className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label="Nome do estabelecimento" required error={showErrors ? nameError ?? undefined : undefined}>
              {(field) => (
                <input
                  {...field}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={STORE_FIELD_LIMITS.name}
                  className={fieldControlClass(showErrors && !!nameError)}
                />
              )}
            </FormField>
            <FormField
              label="Endereço da loja"
              required
              error={showErrors ? slugError ?? undefined : undefined}
              hint={slug !== store.slug
                ? <span className="text-amber-700 dark:text-amber-300">Mudar o endereço quebra os links e QR codes de /loja/{store.slug}.</span>
                : 'Minúsculas, números e hífens (3 a 60).'}
            >
              {(field) => (
                <div className="flex items-stretch">
                  <span className="inline-flex items-center px-3 rounded-l-xl border border-r-0 border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-900 text-sm text-gray-500 dark:text-gray-400 font-mono" aria-hidden="true">/loja/</span>
                  <input
                    {...field}
                    value={slug}
                    onChange={(event) => setSlug(cleanSlugInput(event.target.value))}
                    onBlur={() => setSlug((current) => current.replace(/^-+|-+$/g, ''))}
                    autoComplete="off"
                    spellCheck={false}
                    className={fieldControlClass(showErrors && !!slugError, 'rounded-l-none font-mono')}
                  />
                </div>
              )}
            </FormField>
          </div>

          <FormField
            label="Domínio próprio (opcional)"
            error={showErrors ? domainIssue ?? undefined : undefined}
            hint="Fica registrado, mas ainda não é roteado automaticamente (DNS, certificado e roteamento são uma evolução futura). Vazio remove."
          >
            {(field) => (
              <input
                {...field}
                value={domain}
                onChange={(event) => setDomain(event.target.value)}
                maxLength={CUSTOM_DOMAIN_MAX_LENGTH}
                placeholder="pedidos.minhaloja.com.br"
                autoComplete="off"
                spellCheck={false}
                className={fieldControlClass(showErrors && !!domainIssue, 'font-mono')}
              />
            )}
          </FormField>

          <StoreProfileFields
            values={profile}
            onChange={(changes) => setProfile((current) => ({ ...current, ...changes }))}
            errors={problems}
            showErrors={showErrors}
            disabled={saving}
            headingLevel={3}
          />

          <p className="flex items-start gap-2 text-xs text-gray-500 dark:text-gray-400">
            <Info size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
            <span>Só os campos alterados são enviados. Vazio limpa o campo. Toda alteração fica na auditoria.</span>
          </p>
        </form>
      </Modal>

      <ConfirmModal
        isOpen={!!confirmSlug}
        onClose={() => setConfirmSlug(null)}
        onConfirm={() => confirmSlug && void save(confirmSlug)}
        closeOnConfirm={false}
        loading={saving}
        title="Mudar o endereço da loja?"
        message={`De /loja/${store.slug} para /loja/${confirmSlug?.slug ?? slug}: links, QR codes e favoritos com o endereço antigo deixam de funcionar.`}
        confirmLabel="Mudar endereço"
        isDestructive
      >
        <p className="flex items-start gap-2 text-sm text-amber-800 dark:text-amber-300">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
          <span>Avise a loja para atualizar o material de divulgação.</span>
        </p>
      </ConfirmModal>
    </>
  );
}
