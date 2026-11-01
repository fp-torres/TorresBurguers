import { useId, useState } from 'react';
import { ArrowDown, ArrowUp, Bike, Info, MapPinned, Plus, Trash2 } from 'lucide-react';
import { FormField, Switch, buttonClass, cx, fieldControlClass } from '../../../components/ui';
import { currencyToNumber, maskMoney } from '../../../utils/masks';
import { toMoneyInput } from '../../../utils/catalog';
import type { DeliveryZonesConfig, OutsideZonesPolicy, StoreSettings, ZipRange } from '../../../services/storeSettingsService';
import SettingsSection from '../SettingsSection';
import TagInput from '../TagInput';
import { changedFields, type SectionProps } from '../types';
import { useReportDirty, useSettingsSave } from '../useSettingsSave';
import { FIELD_LIMITS, ZONE_LIMITS, optionalText, parseZipRange, tooLong, zipRangeLabel, zonesError } from '../validation';

interface ZoneDraft {
  /** Identificador estável na tela (a ordem das zonas importa: vale a primeira com o bairro ou o CEP). */
  key: number;
  neighborhoods: string[];
  cities: string[];
  /** Faixas de CEP como exibidas ("22010-000 a 22099-999"). */
  zipRanges: string[];
  fee: string;
  time: string;
}

interface ZonesDraft {
  /** Endereço fora das zonas: entrega com a taxa padrão ou recusa. */
  outside: OutsideZonesPolicy;
  fallbackFee: string;
  fallbackTime: string;
  zones: ZoneDraft[];
}

interface Draft {
  delivery: boolean;
  takeout: boolean;
  takeoutEstimate: string;
  /** null = sem zonas próprias. */
  zones: ZonesDraft | null;
}

const DELIVERY_ZONES_REQUIRED = 'Configure as zonas de entrega (bairros, taxas e prazos) antes de habilitar a entrega.';
const FULFILLMENT_REQUIRED = 'Mantenha pelo menos uma forma de atendimento ativa: entrega ou retirada no balcão.';
/** Mesma mensagem que o cliente recebe da API no carrinho. */
const OUT_OF_AREA_MESSAGE = 'Este endereço está fora da área de entrega da loja.';

let zoneKeySequence = 0;
function nextZoneKey(): number {
  zoneKeySequence += 1;
  return zoneKeySequence;
}

function emptyZone(): ZoneDraft {
  return { key: nextZoneKey(), neighborhoods: [], cities: [], zipRanges: [], fee: '', time: '' };
}

function zonesDraftFrom(config: DeliveryZonesConfig | null): ZonesDraft | null {
  if (!config) return null;
  return {
    outside: config.outside_zones,
    fallbackFee: config.fallback ? toMoneyInput(config.fallback.fee) : '',
    fallbackTime: config.fallback?.time ?? '',
    zones: config.zones.map((zone) => ({
      key: nextZoneKey(),
      neighborhoods: [...zone.neighborhoods],
      cities: [...(zone.cities ?? [])],
      zipRanges: (zone.zip_ranges ?? []).map(zipRangeLabel),
      fee: toMoneyInput(zone.fee),
      time: zone.time,
    })),
  };
}

function draftFrom(settings: StoreSettings): Draft {
  return {
    delivery: settings.delivery_enabled,
    takeout: settings.takeout_enabled,
    takeoutEstimate: settings.takeout_estimate ?? '',
    zones: zonesDraftFrom(settings.delivery_zones),
  };
}

/**
 * Formato da API (mesma ordem de chaves do que a tela lê da resposta, para comparar com o salvo).
 * Recusando os endereços fora das zonas, a taxa padrão só vai se já tiver prazo (fica guardada para quando
 * a loja voltar a aceitar); senão, vai null.
 */
function toConfig(draft: ZonesDraft): DeliveryZonesConfig {
  const keepFallback = draft.outside === 'fallback' || draft.fallbackTime.trim() !== '';
  return {
    zones: draft.zones.map((zone) => {
      const zipRanges = zone.zipRanges.map(parseZipRange).filter((range): range is ZipRange => range !== null);
      return {
        neighborhoods: zone.neighborhoods,
        ...(zone.cities.length ? { cities: zone.cities } : {}),
        ...(zipRanges.length ? { zip_ranges: zipRanges } : {}),
        fee: currencyToNumber(zone.fee),
        time: zone.time.trim(),
      };
    }),
    fallback: keepFallback ? { fee: currencyToNumber(draft.fallbackFee), time: draft.fallbackTime.trim() } : null,
    outside_zones: draft.outside,
  };
}

function validate(draft: Draft, settings: StoreSettings): { general?: string; takeoutEstimate?: string; zones?: string } {
  const errors: { general?: string; takeoutEstimate?: string; zones?: string } = {};
  if (!draft.delivery && !draft.takeout) errors.general = FULFILLMENT_REQUIRED;
  else if (draft.delivery && !draft.zones && !settings.is_default_store) errors.general = DELIVERY_ZONES_REQUIRED;
  if (draft.takeoutEstimate.trim().length > FIELD_LIMITS.takeout_estimate) {
    errors.takeoutEstimate = tooLong('O prazo da retirada', FIELD_LIMITS.takeout_estimate);
  }
  if (draft.zones) {
    const config = toConfig(draft.zones);
    const zones = draft.zones.zones.map((zone, index) => ({
      neighborhoods: zone.neighborhoods,
      cities: zone.cities,
      zipRanges: zone.zipRanges,
      fee: config.zones[index].fee,
      time: config.zones[index].time,
    }));
    const message = zonesError(config.fallback, zones, draft.zones.outside);
    if (message) errors.zones = message;
  }
  return errors;
}

/**
 * Entrega e retirada: formas de atendimento, prazo da retirada, zonas de entrega (bairros e/ou faixas de CEP,
 * taxas e prazos) e o que fazer com endereços fora das zonas (taxa padrão ou recusa).
 */
export default function DeliverySection({ settings, readOnly, onSaved, onDirtyChange }: SectionProps) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(settings));
  const [showErrors, setShowErrors] = useState(false);
  const { saving, save } = useSettingsSave(onSaved);
  const zonesHeadingId = useId();
  const outsideHintId = useId();
  const outsideName = useId();

  const changes = changedFields(settings, {
    delivery_enabled: draft.delivery,
    takeout_enabled: draft.takeout,
    takeout_estimate: optionalText(draft.takeoutEstimate),
    delivery_zones: draft.zones ? toConfig(draft.zones) : null,
  });
  const dirty = Object.keys(changes).length > 0;
  useReportDirty('entrega', dirty, onDirtyChange);

  const errors = showErrors ? validate(draft, settings) : {};

  function setZones(update: (zones: ZonesDraft) => ZonesDraft) {
    setDraft((current) => (current.zones ? { ...current, zones: update(current.zones) } : current));
  }

  function updateZone(key: number, patch: Partial<ZoneDraft>) {
    setZones((zones) => ({ ...zones, zones: zones.zones.map((zone) => (zone.key === key ? { ...zone, ...patch } : zone)) }));
  }

  function moveZone(index: number, offset: -1 | 1) {
    setZones((zones) => {
      const target = index + offset;
      if (target < 0 || target >= zones.zones.length) return zones;
      const next = [...zones.zones];
      [next[index], next[target]] = [next[target], next[index]];
      return { ...zones, zones: next };
    });
  }

  async function handleSubmit() {
    if (Object.keys(validate(draft, settings)).length > 0) {
      setShowErrors(true);
      return;
    }
    await save(changes, 'Entrega e retirada salvas.');
  }

  const zones = draft.zones;
  const refusing = zones?.outside === 'refuse';

  return (
    <SettingsSection
      title="Entrega e retirada"
      description="Como o cliente recebe o pedido, a taxa e o prazo de cada região e o que fazer fora delas."
      icon={<Bike size={20} />}
      dirty={dirty}
      saving={saving}
      readOnly={readOnly}
      onSubmit={handleSubmit}
      onDiscard={() => {
        setDraft(draftFrom(settings));
        setShowErrors(false);
      }}
    >
      {errors.general && (
        <p role="alert" className="px-4 py-3 rounded-xl text-sm font-semibold bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800">
          {errors.general}
        </p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="p-4 rounded-xl border border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-900/40">
          <Switch
            checked={draft.delivery}
            onChange={(checked) => setDraft((current) => ({ ...current, delivery: checked }))}
            label="Entrega"
            description="O cliente informa o endereço; a taxa e o prazo vêm das zonas abaixo."
            disabled={readOnly}
          />
        </div>
        <div className="p-4 rounded-xl border border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-900/40 space-y-4">
          <Switch
            checked={draft.takeout}
            onChange={(checked) => setDraft((current) => ({ ...current, takeout: checked }))}
            label="Retirada no balcão"
            description="Sem taxa: o cliente busca no endereço da loja."
            disabled={readOnly}
          />
          <FormField label="Prazo da retirada" error={errors.takeoutEstimate} hint="Vazio: usa o padrão da plataforma (15-20 min).">
            {(field) => (
              <input
                {...field}
                value={draft.takeoutEstimate}
                onChange={(event) => setDraft((current) => ({ ...current, takeoutEstimate: event.target.value }))}
                maxLength={FIELD_LIMITS.takeout_estimate}
                placeholder="Ex.: 15-20 min"
                disabled={readOnly}
                className={fieldControlClass(!!errors.takeoutEstimate)}
              />
            )}
          </FormField>
        </div>
      </div>

      <section aria-labelledby={zonesHeadingId} className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 id={zonesHeadingId} className="text-base font-bold text-gray-800 dark:text-white flex items-center gap-2">
              <MapPinned size={18} className="text-orange-600 dark:text-orange-400" aria-hidden="true" /> Zonas de entrega
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              Vale a primeira zona que tiver o bairro do cliente (nome inteiro, sem diferenciar acentos) ou o CEP dele numa das faixas. Cidades são opcionais.
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              O bairro é conferido pelo CEP do endereço: use os nomes de bairro dos Correios (os mesmos que aparecem na busca do CEP). Se o CEP não informar o bairro, vale o que o cliente digitou.
            </p>
          </div>
          {zones && !readOnly && (
            <button
              type="button"
              onClick={() => setDraft((current) => ({ ...current, zones: null }))}
              className={buttonClass('ghost', 'sm', 'text-red-600 dark:text-red-400')}
            >
              <Trash2 size={14} aria-hidden="true" /> Remover zonas próprias
            </button>
          )}
        </div>

        {errors.zones && (
          <p role="alert" className="px-4 py-3 rounded-xl text-sm font-semibold bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800">
            {errors.zones}
          </p>
        )}

        {!zones ? (
          <div className="flex flex-col sm:flex-row sm:items-center gap-4 p-5 rounded-xl border border-dashed border-gray-300 dark:border-slate-600">
            <Info size={22} className="shrink-0 text-gray-400" aria-hidden="true" />
            <p className="flex-1 text-sm text-gray-600 dark:text-gray-300">
              {settings.is_default_store
                ? 'Sem zonas próprias: como esta é a loja padrão da plataforma, as entregas usam as taxas e os prazos padrão da plataforma.'
                : 'Sem zonas próprias. Para fazer entregas, cadastre os bairros ou as faixas de CEP atendidos com a taxa e o prazo de cada região.'}
            </p>
            {!readOnly && (
              <button
                type="button"
                onClick={() => setDraft((current) => ({ ...current, zones: { outside: 'fallback', fallbackFee: '', fallbackTime: '', zones: [emptyZone()] } }))}
                className={buttonClass('primary', 'sm')}
              >
                <Plus size={14} aria-hidden="true" /> Cadastrar zonas
              </button>
            )}
          </div>
        ) : (
          <>
            <fieldset className="p-4 rounded-xl border border-gray-200 dark:border-slate-700 space-y-3" aria-describedby={outsideHintId}>
              <legend className="px-1 text-sm font-bold text-gray-800 dark:text-gray-100">Endereços fora das zonas</legend>
              <p id={outsideHintId} className="text-xs text-gray-500 dark:text-gray-400">
                O que acontece quando o bairro (conferido pelo CEP) e o CEP do cliente não estão em nenhuma zona abaixo.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <OutsideOption
                  name={outsideName}
                  checked={!refusing}
                  disabled={readOnly}
                  onSelect={() => setZones((current) => ({ ...current, outside: 'fallback' }))}
                  title="Entregar com uma taxa padrão"
                  description="O pedido é aceito com a taxa e o prazo informados aqui."
                />
                <OutsideOption
                  name={outsideName}
                  checked={refusing}
                  disabled={readOnly}
                  onSelect={() => setZones((current) => ({ ...current, outside: 'refuse' }))}
                  title="Recusar a entrega"
                  description={`O cliente vê "${OUT_OF_AREA_MESSAGE}" no carrinho, antes de pagar, e pode escolher outro endereço ou a retirada.`}
                />
              </div>

              {!refusing && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <FormField label="Taxa fora das zonas">
                    {(field) => (
                      <input
                        {...field}
                        inputMode="numeric"
                        value={zones.fallbackFee}
                        onChange={(event) => setZones((current) => ({ ...current, fallbackFee: maskMoney(event.target.value) }))}
                        placeholder="R$ 0,00 (grátis)"
                        disabled={readOnly}
                        className={fieldControlClass()}
                      />
                    )}
                  </FormField>
                  <FormField label="Prazo fora das zonas" required>
                    {(field) => (
                      <input
                        {...field}
                        value={zones.fallbackTime}
                        onChange={(event) => setZones((current) => ({ ...current, fallbackTime: event.target.value }))}
                        maxLength={ZONE_LIMITS.timeLength}
                        placeholder="Ex.: 50-60 min"
                        disabled={readOnly}
                        className={fieldControlClass(showErrors && !zones.fallbackTime.trim())}
                      />
                    )}
                  </FormField>
                </div>
              )}
            </fieldset>

            <ol className="space-y-4">
              {zones.zones.map((zone, index) => (
                <li key={zone.key}>
                  <ZoneEditor
                    zone={zone}
                    position={index + 1}
                    total={zones.zones.length}
                    readOnly={readOnly}
                    showErrors={showErrors}
                    onChange={(patch) => updateZone(zone.key, patch)}
                    onMove={(offset) => moveZone(index, offset)}
                    onRemove={() => setZones((current) => ({ ...current, zones: current.zones.filter((item) => item.key !== zone.key) }))}
                  />
                </li>
              ))}
            </ol>

            {!readOnly && (
              <button
                type="button"
                onClick={() => setZones((current) => ({ ...current, zones: [...current.zones, emptyZone()] }))}
                disabled={zones.zones.length >= ZONE_LIMITS.zones}
                className={buttonClass('secondary', 'sm')}
              >
                <Plus size={14} aria-hidden="true" /> Adicionar zona
              </button>
            )}
          </>
        )}
      </section>
    </SettingsSection>
  );
}

interface OutsideOptionProps {
  /** name do grupo de rádios. */
  name: string;
  checked: boolean;
  disabled: boolean;
  onSelect: () => void;
  title: string;
  description: string;
}

/** Opção da política para endereços fora das zonas (rádio com título e explicação). */
function OutsideOption({ name, checked, disabled, onSelect, title, description }: OutsideOptionProps) {
  return (
    <label
      className={cx(
        'flex items-start gap-3 p-3 rounded-xl border-2 transition-all',
        checked ? 'border-orange-500 bg-orange-50 dark:bg-orange-900/20' : 'border-gray-100 dark:border-slate-700',
        disabled ? 'opacity-60' : 'cursor-pointer hover:border-gray-200 dark:hover:border-slate-600',
      )}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onSelect}
        disabled={disabled}
        className="mt-1 accent-orange-600"
      />
      <span className="min-w-0">
        <span className="block text-sm font-bold text-gray-800 dark:text-gray-100">{title}</span>
        <span className="block text-xs text-gray-500 dark:text-gray-400 mt-0.5">{description}</span>
      </span>
    </label>
  );
}

interface ZoneEditorProps {
  zone: ZoneDraft;
  position: number;
  total: number;
  readOnly: boolean;
  showErrors: boolean;
  onChange: (patch: Partial<ZoneDraft>) => void;
  onMove: (offset: -1 | 1) => void;
  onRemove: () => void;
}

/** Faixa válida vira o texto padrão ("22010-000 a 22099-999"); inválida fica como digitada (a validação aponta). */
function normalizeZipRanges(values: string[]): string[] {
  return values.map((value) => {
    const range = parseZipRange(value);
    return range ? zipRangeLabel(range) : value;
  });
}

function ZoneEditor({ zone, position, total, readOnly, showErrors, onChange, onMove, onRemove }: ZoneEditorProps) {
  const neighborhoodsId = useId();
  const citiesId = useId();
  const zipRangesId = useId();
  const neighborhoodsHintId = useId();
  const zipRangesHintId = useId();
  const missingArea = showErrors && zone.neighborhoods.length === 0 && zone.zipRanges.length === 0;
  const badRange = showErrors && zone.zipRanges.some((range) => !parseZipRange(range));
  const missingTime = showErrors && !zone.time.trim();

  return (
    <fieldset className="p-4 rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800/60 space-y-4">
      <legend className="px-1 text-sm font-bold text-gray-800 dark:text-gray-100">Zona {position}</legend>
      {!readOnly && (
        <div className="flex justify-end gap-1 -mt-2">
          <button type="button" onClick={() => onMove(-1)} disabled={position === 1} aria-label={`Subir a zona ${position}`} title="Subir (mais prioridade)" className={buttonClass('ghost', 'icon')}>
            <ArrowUp size={16} aria-hidden="true" />
          </button>
          <button type="button" onClick={() => onMove(1)} disabled={position === total} aria-label={`Descer a zona ${position}`} title="Descer (menos prioridade)" className={buttonClass('ghost', 'icon')}>
            <ArrowDown size={16} aria-hidden="true" />
          </button>
          <button type="button" onClick={onRemove} aria-label={`Remover a zona ${position}`} title="Remover zona" className={buttonClass('ghost', 'icon', 'text-red-600 dark:text-red-400')}>
            <Trash2 size={16} aria-hidden="true" />
          </button>
        </div>
      )}

      <div className="space-y-1.5">
        <label htmlFor={neighborhoodsId} className="block text-xs font-bold uppercase tracking-wide text-gray-700 dark:text-gray-300">
          Bairros atendidos
        </label>
        <TagInput
          id={neighborhoodsId}
          values={zone.neighborhoods}
          onChange={(neighborhoods) => onChange({ neighborhoods })}
          itemLabel="bairro"
          listLabel={`Bairros da zona ${position}`}
          placeholder="Digite um bairro e tecle Enter"
          maxItems={ZONE_LIMITS.neighborhoods}
          maxLength={ZONE_LIMITS.nameLength}
          disabled={readOnly}
          invalid={missingArea}
          aria-describedby={neighborhoodsHintId}
        />
        <p id={neighborhoodsHintId} className={cx('text-xs', missingArea ? 'font-semibold text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400')}>
          {missingArea ? 'Informe pelo menos um bairro ou uma faixa de CEP.' : 'Cole vários separados por vírgula. Até 200 bairros.'}
        </p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor={citiesId} className="block text-xs font-bold uppercase tracking-wide text-gray-700 dark:text-gray-300">
          Cidades (opcional)
        </label>
        <TagInput
          id={citiesId}
          values={zone.cities}
          onChange={(cities) => onChange({ cities })}
          itemLabel="cidade"
          listLabel={`Cidades da zona ${position}`}
          placeholder="Só nestas cidades (deixe vazio para qualquer uma)"
          maxItems={ZONE_LIMITS.cities}
          maxLength={ZONE_LIMITS.nameLength}
          disabled={readOnly}
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor={zipRangesId} className="block text-xs font-bold uppercase tracking-wide text-gray-700 dark:text-gray-300">
          Faixas de CEP (opcional)
        </label>
        <TagInput
          id={zipRangesId}
          values={zone.zipRanges}
          onChange={(zipRanges) => onChange({ zipRanges: normalizeZipRanges(zipRanges) })}
          itemLabel="faixa de CEP"
          listLabel={`Faixas de CEP da zona ${position}`}
          placeholder="Ex.: 22010-000 a 22099-999"
          maxItems={ZONE_LIMITS.zipRanges}
          maxLength={ZONE_LIMITS.zipRangeLength}
          disabled={readOnly}
          invalid={missingArea || badRange}
          aria-describedby={zipRangesHintId}
        />
        <p id={zipRangesHintId} className={cx('text-xs', badRange ? 'font-semibold text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400')}>
          {badRange
            ? 'Use o formato 22010-000 a 22099-999 (início a fim) ou um CEP só.'
            : 'Um CEP ou uma faixa (início a fim). Vale em qualquer cidade, mesmo que o bairro não esteja na lista.'}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FormField label="Taxa">
          {(field) => (
            <input
              {...field}
              inputMode="numeric"
              value={zone.fee}
              onChange={(event) => onChange({ fee: maskMoney(event.target.value) })}
              placeholder="R$ 0,00 (grátis)"
              disabled={readOnly}
              className={fieldControlClass()}
            />
          )}
        </FormField>
        <FormField label="Prazo" required error={missingTime ? 'Informe o prazo (ex.: 30-40 min).' : undefined}>
          {(field) => (
            <input
              {...field}
              value={zone.time}
              onChange={(event) => onChange({ time: event.target.value })}
              maxLength={ZONE_LIMITS.timeLength}
              placeholder="Ex.: 30-40 min"
              disabled={readOnly}
              className={fieldControlClass(missingTime)}
            />
          )}
        </FormField>
      </div>
    </fieldset>
  );
}
