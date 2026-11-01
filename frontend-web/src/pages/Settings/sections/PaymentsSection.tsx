import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CreditCard, ExternalLink, Eye, EyeOff, Info, KeyRound, Lock, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { FormField, StatusBadge, buttonClass, fieldControlClass } from '../../../components/ui';
import ConfirmModal from '../../../components/ConfirmModal';
import { getApiErrorMessage } from '../../../services/api';
import { storeSettingsService } from '../../../services/storeSettingsService';
import SettingsSection from '../SettingsSection';
import type { SectionProps } from '../types';
import { useReportDirty } from '../useSettingsSave';
import { MP_CREDENTIAL_PATTERN, credentialEnvironment } from '../validation';

const MP_CREDENTIALS_URL = 'https://www.mercadopago.com.br/developers/panel/app';

interface Draft {
  publicKey: string;
  accessToken: string;
}

const EMPTY: Draft = { publicKey: '', accessToken: '' };

function validate(draft: Draft): Partial<Record<keyof Draft | 'pair', string>> {
  const errors: Partial<Record<keyof Draft | 'pair', string>> = {};
  const publicKey = draft.publicKey.trim();
  const accessToken = draft.accessToken.trim();
  if (!publicKey) errors.publicKey = 'Informe a chave pública (Public Key) do Mercado Pago.';
  else if (publicKey.length > 120) errors.publicKey = 'A chave pública pode ter no máximo 120 caracteres.';
  else if (!MP_CREDENTIAL_PATTERN.test(publicKey)) errors.publicKey = 'Chave pública inválida: ela começa com APP_USR- (produção) ou TEST- (teste).';
  if (!accessToken) errors.accessToken = 'Informe o Access Token do Mercado Pago.';
  else if (accessToken.length > 255) errors.accessToken = 'O Access Token pode ter no máximo 255 caracteres.';
  else if (!MP_CREDENTIAL_PATTERN.test(accessToken)) errors.accessToken = 'Access Token inválido: ele começa com APP_USR- (produção) ou TEST- (teste).';
  if (!errors.publicKey && !errors.accessToken && credentialEnvironment(publicKey) !== credentialEnvironment(accessToken)) {
    errors.pair = 'A chave pública e o Access Token precisam ser do mesmo tipo: os dois de produção (APP_USR-) ou os dois de teste (TEST-).';
  }
  return errors;
}

/**
 * Pagamentos online (PIX e cartão) com a conta Mercado Pago da PRÓPRIA loja: o dinheiro cai na conta da loja.
 * O Access Token é só de escrita (a API devolve apenas uma dica); a chave pública é usada na vitrine.
 */
export default function PaymentsSection({ settings, readOnly, onSaved, onDirtyChange }: SectionProps) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [showErrors, setShowErrors] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmRemoveOpen, setConfirmRemoveOpen] = useState(false);

  const payments = settings.payments;
  const planAllows = settings.features.online_payments;
  const configured = payments.access_token_configured;
  const environment = credentialEnvironment(payments.mp_public_key);

  const dirty = draft.publicKey.trim() !== '' || draft.accessToken.trim() !== '';
  useReportDirty('pagamentos', dirty, onDirtyChange);
  const errors = showErrors ? validate(draft) : {};

  async function handleSubmit() {
    if (Object.keys(validate(draft)).length > 0) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    try {
      const next = await storeSettingsService.setPaymentCredentials({
        mp_public_key: draft.publicKey.trim(),
        mp_access_token: draft.accessToken.trim(),
      });
      onSaved({ ...settings, payments: next }, ['payments']);
      setDraft(EMPTY);
      setShowErrors(false);
      setShowToken(false);
      toast.success('Credenciais do Mercado Pago salvas.');
    } catch (error) {
      // 400 (formato/ambiente) e 503 (plataforma sem chave de criptografia) trazem a explicação
      toast.error(getApiErrorMessage(error, 'Não foi possível salvar as credenciais.'), { duration: 7000 });
    } finally {
      setSaving(false);
    }
  }

  async function removeCredentials() {
    setRemoving(true);
    try {
      const next = await storeSettingsService.removePaymentCredentials();
      onSaved({ ...settings, payments: next }, ['payments']);
      toast.success('Credenciais removidas.');
      setConfirmRemoveOpen(false);
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Não foi possível remover as credenciais.'));
    } finally {
      setRemoving(false);
    }
  }

  return (
    <SettingsSection
      title="Pagamentos online"
      description="PIX e cartão na vitrine, com a conta Mercado Pago da sua loja: o dinheiro cai direto na conta da loja."
      icon={<CreditCard size={20} />}
      dirty={dirty}
      saving={saving}
      readOnly={readOnly}
      onSubmit={handleSubmit}
      onDiscard={() => {
        setDraft(EMPTY);
        setShowErrors(false);
      }}
      saveLabel={configured ? 'Substituir credenciais' : 'Salvar credenciais'}
    >
      {!planAllows && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 p-4 rounded-xl bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
          <Lock size={20} className="shrink-0" aria-hidden="true" />
          <p className="flex-1 text-sm">
            <span className="font-bold">O plano atual não inclui pagamentos online.</span> Mesmo com as credenciais cadastradas, a vitrine
            oferece só pagamento na entrega ou na retirada.
          </p>
          <Link to="/subscription" className={buttonClass('secondary', 'sm')}>Ver plano</Link>
        </div>
      )}

      {/* Situação atual das credenciais (o token nunca volta da API) */}
      <div className="p-4 rounded-xl border border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-900/40 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {configured ? (
            <StatusBadge tone="success" dot>Credenciais da loja configuradas</StatusBadge>
          ) : payments.using_platform_credentials ? (
            <StatusBadge tone="info" dot>Usando a conta da plataforma</StatusBadge>
          ) : (
            <StatusBadge tone="neutral" dot>Sem credenciais</StatusBadge>
          )}
          {configured && environment && (
            <StatusBadge tone={environment === 'TEST' ? 'warning' : 'info'}>
              {environment === 'TEST' ? 'Ambiente de teste' : 'Produção'}
            </StatusBadge>
          )}
        </div>

        {configured ? (
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <div className="min-w-0">
              <dt className="text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400">Chave pública</dt>
              <dd className="font-mono text-gray-800 dark:text-gray-100 break-all">{payments.mp_public_key ?? '—'}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400">Access Token</dt>
              <dd className="font-mono text-gray-800 dark:text-gray-100 break-all">
                {payments.access_token_hint ?? 'Gravado (não foi possível exibir a dica)'}
              </dd>
            </div>
          </dl>
        ) : payments.using_platform_credentials ? (
          <p className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-300">
            <Info size={16} className="shrink-0 mt-0.5 text-blue-600 dark:text-blue-400" aria-hidden="true" />
            Esta é a loja padrão da plataforma: sem credenciais próprias, os pagamentos online usam a conta Mercado Pago da plataforma.
            Cadastre as credenciais da sua conta para receber diretamente.
          </p>
        ) : (
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Sem credenciais, a vitrine não oferece PIX nem cartão online: o cliente paga na entrega ou na retirada.
          </p>
        )}

        {configured && !readOnly && (
          <button
            type="button"
            onClick={() => setConfirmRemoveOpen(true)}
            disabled={removing}
            className={buttonClass('ghost', 'sm', 'text-red-600 dark:text-red-400')}
          >
            <Trash2 size={14} aria-hidden="true" /> Remover credenciais
          </button>
        )}
      </div>

      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-bold text-gray-800 dark:text-white flex items-center gap-2">
            <KeyRound size={18} className="text-orange-600 dark:text-orange-400" aria-hidden="true" />
            {configured ? 'Substituir as credenciais' : 'Cadastrar as credenciais'}
          </h3>
          <a
            href={MP_CREDENTIALS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm font-bold text-orange-600 dark:text-orange-400 hover:underline rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
          >
            Onde encontrar <ExternalLink size={14} aria-hidden="true" /><span className="sr-only">(abre o Mercado Pago em outra aba)</span>
          </a>
        </div>

        {errors.pair && (
          <p role="alert" className="px-4 py-3 rounded-xl text-sm font-semibold bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800">
            {errors.pair}
          </p>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <FormField label="Chave pública (Public Key)" error={errors.publicKey} hint="Começa com APP_USR- (produção) ou TEST- (teste).">
            {(field) => (
              <input
                {...field}
                value={draft.publicKey}
                onChange={(event) => {
                  const publicKey = event.target.value;
                  setDraft((current) => ({ ...current, publicKey }));
                }}
                maxLength={120}
                autoComplete="off"
                spellCheck={false}
                placeholder="APP_USR-..."
                disabled={readOnly}
                className={fieldControlClass(!!errors.publicKey, 'font-mono')}
              />
            )}
          </FormField>
          <FormField label="Access Token" error={errors.accessToken} hint="Só de escrita: depois de salvo, aparece apenas uma dica.">
            {(field) => (
              <div className="flex gap-2">
                <input
                  {...field}
                  type={showToken ? 'text' : 'password'}
                  value={draft.accessToken}
                  onChange={(event) => {
                    const accessToken = event.target.value;
                    setDraft((current) => ({ ...current, accessToken }));
                  }}
                  maxLength={255}
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder="APP_USR-..."
                  disabled={readOnly}
                  className={fieldControlClass(!!errors.accessToken, 'font-mono')}
                />
                <button
                  type="button"
                  onClick={() => setShowToken((current) => !current)}
                  aria-pressed={showToken}
                  aria-label={showToken ? 'Ocultar o Access Token' : 'Mostrar o Access Token'}
                  disabled={readOnly}
                  className={buttonClass('secondary', 'icon', 'shrink-0')}
                >
                  {showToken ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
                </button>
              </div>
            )}
          </FormField>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Use credenciais de produção para receber de verdade. As de teste (TEST-) servem para simular pagamentos e não são aceitas em produção.
        </p>
      </div>

      <ConfirmModal
        isOpen={confirmRemoveOpen}
        onClose={() => setConfirmRemoveOpen(false)}
        onConfirm={removeCredentials}
        closeOnConfirm={false}
        loading={removing}
        title="Remover as credenciais?"
        message={settings.is_default_store
          ? 'Sem credenciais próprias, a loja padrão volta a usar a conta Mercado Pago da plataforma (quando configurada); sem ela, a vitrine deixa de oferecer PIX e cartão online. O pagamento na entrega ou na retirada continua.'
          : 'A vitrine deixa de oferecer PIX e cartão online até novas credenciais serem cadastradas. O pagamento na entrega ou na retirada continua.'}
        confirmLabel="Remover credenciais"
        isDestructive
      />
    </SettingsSection>
  );
}
