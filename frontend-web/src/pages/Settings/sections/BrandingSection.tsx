import { useId, useState, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { ImageUp, Loader2, Lock, Palette, RotateCcw, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { FormField, buttonClass, fieldControlClass } from '../../../components/ui';
import ConfirmModal from '../../../components/ConfirmModal';
import { getApiErrorMessage } from '../../../services/api';
import { storeSettingsService } from '../../../services/storeSettingsService';
import { planRestrictionMessage } from '../../../services/storeSubscriptionService';
import { toastPlanLimit } from '../../../layouts/DefaultLayout/planLimit';
import StoreAvatar from '../../../layouts/DefaultLayout/StoreAvatar';
import { readableTextColor, validHexColor } from '../../../layouts/DefaultLayout/color';
import SettingsSection from '../SettingsSection';
import { changedFields, type SectionProps } from '../types';
import { useReportDirty, useSettingsSave } from '../useSettingsSave';
import { colorError } from '../validation';

// Mesmas regras da API para o logo (convertido para WebP)
const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Cor do tema quando a loja não tem cor própria (laranja da plataforma). */
const DEFAULT_COLOR = '#EA580C';

/** Identidade visual: logo (envio imediato) e cor principal da vitrine. Exige o recurso custom_branding do plano. */
export default function BrandingSection({ settings, readOnly, onSaved, onDirtyChange }: SectionProps) {
  const allowed = settings.features.custom_branding;
  const [color, setColor] = useState(settings.primary_color ?? '');
  const [showErrors, setShowErrors] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmRemoveOpen, setConfirmRemoveOpen] = useState(false);
  const { saving, save } = useSettingsSave(onSaved);
  const fileInputId = useId();
  const colorPickerId = useId();

  const typedColor = color.trim().toUpperCase();
  const changes = allowed ? changedFields(settings, { primary_color: typedColor || null }) : {};
  const dirty = Object.keys(changes).length > 0;
  useReportDirty('identidade', dirty, onDirtyChange);

  const error = showErrors ? colorError(typedColor) ?? undefined : undefined;
  const previewColor = validHexColor(typedColor) ?? validHexColor(settings.primary_color) ?? DEFAULT_COLOR;
  const disabled = readOnly || !allowed;
  const busy = uploading || removing;

  function handleRestrictedError(error: unknown, fallback: string) {
    const planMessage = planRestrictionMessage(error);
    if (planMessage) toastPlanLimit(planMessage);
    else toast.error(getApiErrorMessage(error, fallback), { duration: 6000 });
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ''; // permite escolher o mesmo arquivo de novo
    if (!file) return;
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      toast.error('Use uma imagem JPG, PNG ou WebP.');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      toast.error('Imagem muito grande! O limite é 5 MB.');
      return;
    }
    setUploading(true);
    try {
      const logo = await storeSettingsService.uploadLogo(file);
      onSaved({ ...settings, logo }, ['logo']);
      toast.success('Logo atualizado.');
    } catch (uploadError) {
      handleRestrictedError(uploadError, 'Não foi possível enviar o logo.');
    } finally {
      setUploading(false);
    }
  }

  async function removeLogo() {
    setRemoving(true);
    try {
      await storeSettingsService.removeLogo();
      onSaved({ ...settings, logo: null }, ['logo']);
      toast.success('Logo removido.');
      setConfirmRemoveOpen(false);
    } catch (removeError) {
      handleRestrictedError(removeError, 'Não foi possível remover o logo.');
    } finally {
      setRemoving(false);
    }
  }

  async function handleSubmit() {
    if (colorError(typedColor)) {
      setShowErrors(true);
      return;
    }
    await save(changes, 'Cor principal salva.');
  }

  return (
    <SettingsSection
      title="Identidade visual"
      description="Logo e cor principal exibidos na vitrine, no diretório de lojas e no painel."
      icon={<Palette size={20} />}
      dirty={dirty}
      saving={saving}
      readOnly={readOnly}
      onSubmit={allowed ? handleSubmit : undefined}
      onDiscard={() => {
        setColor(settings.primary_color ?? '');
        setShowErrors(false);
      }}
    >
      {!allowed && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-4 p-4 rounded-xl bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
          <Lock size={22} className="shrink-0" aria-hidden="true" />
          <p className="flex-1 text-sm">
            <span className="font-bold">Recurso fora do plano atual.</span> Enviar logo e escolher a cor fazem parte da identidade
            visual personalizada, disponível em planos que incluem esse recurso.
            {settings.logo && ' O logo atual pode ser removido a qualquer momento.'}
          </p>
          <Link to="/subscription" className={buttonClass('secondary', 'sm')}>Ver plano e assinatura</Link>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-5">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-gray-700 dark:text-gray-300 mb-2">Logo</p>
            <div className="flex flex-wrap items-center gap-4">
              <StoreAvatar name={settings.name} logo={settings.logo} color={previewColor} size={80} alt={`Logo de ${settings.name}`} />
              <div className="flex flex-col gap-2">
                <input
                  id={fileInputId}
                  type="file"
                  accept={ACCEPTED_IMAGE_TYPES.join(',')}
                  onChange={handleFileChange}
                  disabled={disabled || busy}
                  className="sr-only peer"
                />
                <label
                  htmlFor={fileInputId}
                  aria-disabled={disabled || busy || undefined}
                  className={buttonClass('secondary', 'sm', `peer-focus-visible:ring-2 peer-focus-visible:ring-orange-500 ${disabled || busy ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`)}
                >
                  {uploading ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <ImageUp size={14} aria-hidden="true" />}
                  {uploading ? 'Enviando...' : settings.logo ? 'Trocar logo' : 'Enviar logo'}
                </label>
                {/* Remover não exige o recurso do plano (a API permite tirar o logo depois de mudar de plano) */}
                {settings.logo && (
                  <button
                    type="button"
                    onClick={() => setConfirmRemoveOpen(true)}
                    disabled={readOnly || busy}
                    className={buttonClass('ghost', 'sm', 'text-red-600 dark:text-red-400')}
                  >
                    <Trash2 size={14} aria-hidden="true" /> Remover logo
                  </button>
                )}
              </div>
            </div>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">JPG, PNG ou WebP até 5 MB (convertido para WebP). Prefira uma imagem quadrada.</p>
          </div>

          <div className="space-y-2">
            <FormField label="Cor principal" error={error} hint="Formato #RRGGBB. Vazio: usa a cor padrão da plataforma.">
              {(field) => (
                <div className="flex gap-2">
                  <input
                    id={colorPickerId}
                    type="color"
                    value={(validHexColor(typedColor) ?? previewColor).toLowerCase()}
                    onChange={(event) => setColor(event.target.value.toUpperCase())}
                    disabled={disabled}
                    aria-label="Escolher a cor principal"
                    className="h-11 w-14 shrink-0 cursor-pointer rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-1 disabled:cursor-not-allowed disabled:opacity-60"
                  />
                  <input
                    {...field}
                    value={color}
                    onChange={(event) => setColor(event.target.value)}
                    maxLength={7}
                    placeholder={DEFAULT_COLOR}
                    spellCheck={false}
                    autoComplete="off"
                    disabled={disabled}
                    className={fieldControlClass(!!error, 'font-mono uppercase')}
                  />
                </div>
              )}
            </FormField>
            {!disabled && typedColor && (
              <button type="button" onClick={() => setColor('')} className={buttonClass('ghost', 'sm')}>
                <RotateCcw size={14} aria-hidden="true" /> Usar a cor padrão
              </button>
            )}
          </div>
        </div>

        {/* Prévia de como o cabeçalho da vitrine fica com o logo e a cor */}
        <figure className="space-y-2">
          <figcaption className="text-xs font-bold uppercase tracking-wide text-gray-700 dark:text-gray-300">Prévia na vitrine</figcaption>
          <div className="rounded-2xl overflow-hidden border border-gray-200 dark:border-slate-700 shadow-sm">
            <div className="h-2" style={{ backgroundColor: previewColor }} aria-hidden="true" />
            <div className="flex flex-wrap items-center gap-3 p-4 bg-white dark:bg-slate-900">
              <StoreAvatar name={settings.name} logo={settings.logo} color={previewColor} size={48} />
              <div className="min-w-0 flex-1">
                <p className="font-bold text-gray-900 dark:text-white truncate">{settings.name || 'Sua loja'}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{settings.description || 'Descrição da loja'}</p>
              </div>
              <span
                className="px-4 py-2 rounded-xl text-sm font-bold shadow-sm"
                style={{ backgroundColor: previewColor, color: readableTextColor(previewColor) }}
              >
                Ver cardápio
              </span>
            </div>
          </div>
        </figure>
      </div>

      <ConfirmModal
        isOpen={confirmRemoveOpen}
        onClose={() => setConfirmRemoveOpen(false)}
        onConfirm={removeLogo}
        closeOnConfirm={false}
        loading={removing}
        title="Remover o logo?"
        message="A vitrine e o painel passam a mostrar as iniciais da loja até um novo logo ser enviado."
        confirmLabel="Remover logo"
        isDestructive
      />
    </SettingsSection>
  );
}
