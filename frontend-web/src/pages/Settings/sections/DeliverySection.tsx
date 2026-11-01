import { useId, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Bike, Info, MapPinned, Plus, Ruler, ShoppingBag, Trash2 } from 'lucide-react';
import { FormField, Switch, buttonClass, cx, fieldControlClass } from '../../../components/ui';
import { currencyToNumber, maskMoney } from '../../../utils/masks';
import { toMoneyInput } from '../../../utils/catalog';
import { formatCurrency } from '../../../utils/format';
import type { DeliveryZonesConfig, DistanceSettings, OrderValueRules, OutsideZonesPolicy, StoreSettings, ZipRange } from '../../../services/storeSettingsService';
import SettingsSection from '../SettingsSection';
import TagInput from '../TagInput';
import { changedFields, type SectionProps } from '../types';
import { useReportDirty, useSettingsSave } from '../useSettingsSave';
import { FIELD_LIMITS, MAX_MONEY, ZONE_LIMITS, optionalText, parseZipRange, tooLong, zipRangeLabel, zonesError } from '../validation';
import DeliverySimulator from './delivery/DeliverySimulator';
import DistanceBandsEditor from './delivery/DistanceBandsEditor';
import StoreLocationField from './delivery/StoreLocationField';
import {
  LOCATION_INVALID_MESSAGE,
  LOCATION_REQUIRED_MESSAGE,
  distanceDraftFrom,
  distanceError,
  distanceWarnings,
  locationDraftFrom,
  newDistanceDraft,
  parseLocation,
  toDistanceConfig,
  type DistanceDraft,
  type LocationDraft,
} from './delivery/distanceDraft';

interface ZoneDraft {
  /** Identificador estável na tela (a ordem das zonas importa: vale a primeira com o bairro ou o CEP). */
  key: number;
  neighborhoods: string[];
  cities: string[];
  /** Faixas de CEP como exibidas ("22010-000 a 22099-999"). */
  zipRanges: string[];
  fee: string;
  time: string;
  /** Pedido mínimo e frete grátis próprios da zona ("" = os da loja). */
  minOrder: string;
  freeAbove: string;
}

interface ZonesDraft {
  /** Endereço fora das zonas: entrega com a taxa padrão ou recusa. */
  outside: OutsideZonesPolicy;
  fallbackFee: string;
  fallbackTime: string;
  zones: ZoneDraft[];
  /** Pedido mínimo da loja ("" = sem mínimo) e se ele vale também na retirada. */
  minOrder: string;
  minOrderTakeout: boolean;
  /** Frete grátis a partir deste subtotal ("" = sem frete grátis). */
  freeAbove: string;
  /** Como a taxa é cobrada: por bairro/CEP (zonas, o padrão) ou por distância em km. */
  mode: 'zones' | 'distance';
  /** Faixas de distância (null = nunca configuradas). Ficam guardadas também no modo por zonas. */
  distance: DistanceDraft | null;
}

interface Draft {
  delivery: boolean;
  takeout: boolean;
  takeoutEstimate: string;
  /** null = sem zonas próprias. */
  zones: ZonesDraft | null;
  /** Local da loja no mapa (latitude e longitude como digitadas). */
  location: LocationDraft;
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
  return { key: nextZoneKey(), neighborhoods: [], cities: [], zipRanges: [], fee: '', time: '', minOrder: '', freeAbove: '' };
}

function emptyZones(mode: ZonesDraft['mode'] = 'zones'): ZonesDraft {
  return {
    outside: 'fallback',
    fallbackFee: '',
    fallbackTime: '',
    zones: mode === 'zones' ? [emptyZone()] : [],
    minOrder: '',
    minOrderTakeout: false,
    freeAbove: '',
    mode,
    distance: mode === 'distance' ? newDistanceDraft() : null,
  };
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
      minOrder: toMoneyInput(zone.min_order),
      freeAbove: toMoneyInput(zone.free_delivery_above),
    })),
    minOrder: toMoneyInput(config.min_order),
    minOrderTakeout: config.min_order_takeout === true,
    freeAbove: toMoneyInput(config.free_delivery_above),
    mode: config.mode === 'distance' ? 'distance' : 'zones',
    distance: distanceDraftFrom(config.distance),
  };
}

/** Valor em reais digitado ("R$ 30,00") ou undefined quando o campo está vazio. */
function moneyOrUndefined(text: string): number | undefined {
  return text.trim() === '' ? undefined : currencyToNumber(text);
}

/** Pedido mínimo e frete grátis de uma zona (vazios = os da loja), na ordem de chaves da API. */
function zoneRules(zone: ZoneDraft): OrderValueRules {
  const minOrder = moneyOrUndefined(zone.minOrder);
  const freeAbove = moneyOrUndefined(zone.freeAbove);
  return {
    ...(minOrder !== undefined ? { min_order: minOrder } : {}),
    ...(freeAbove !== undefined ? { free_delivery_above: freeAbove } : {}),
  };
}

/** Pedido mínimo (só acima de zero), frete grátis e "vale na retirada" da loja, na ordem de chaves da API. */
function storeRules(draft: ZonesDraft): Pick<DeliveryZonesConfig, 'min_order' | 'free_delivery_above' | 'min_order_takeout'> {
  const minOrder = moneyOrUndefined(draft.minOrder);
  const freeAbove = moneyOrUndefined(draft.freeAbove);
  const hasMin = minOrder !== undefined && minOrder > 0;
  return {
    ...(hasMin ? { min_order: minOrder } : {}),
    ...(freeAbove !== undefined ? { free_delivery_above: freeAbove } : {}),
    ...(hasMin && draft.minOrderTakeout ? { min_order_takeout: true } : {}),
  };
}

/**
 * Pedido mínimo e frete grátis: valores acima do permitido bloqueiam; frete grátis menor que o pedido mínimo
 * (da loja ou de uma zona) só gera um aviso — todo pedido aceito já sairia com frete grátis.
 */
function orderRulesCheck(draft: ZonesDraft): { error?: string; warnings: string[] } {
  const warnings: string[] = [];
  const store = storeRules(draft);
  const values = [store.min_order, store.free_delivery_above, ...draft.zones.flatMap((zone) => Object.values(zoneRules(zone)))];
  if (values.some((value) => value !== undefined && value > MAX_MONEY)) {
    return { error: `O pedido mínimo e o frete grátis podem ser de no máximo ${formatCurrency(MAX_MONEY)}.`, warnings };
  }
  const check = (minOrder: number | undefined, freeAbove: number | undefined, where: string) => {
    if (minOrder !== undefined && minOrder > 0 && freeAbove !== undefined && freeAbove < minOrder) {
      warnings.push(`${where}: o frete grátis (${formatCurrency(freeAbove)}) é menor que o pedido mínimo (${formatCurrency(minOrder)}), então todo pedido aceito já terá frete grátis.`);
    }
  };
  check(store.min_order, store.free_delivery_above, 'Loja');
  draft.zones.forEach((zone, index) => {
    const own = zoneRules(zone);
    if (own.min_order === undefined && own.free_delivery_above === undefined) return;
    check(own.min_order ?? store.min_order, own.free_delivery_above ?? store.free_delivery_above, `Zona ${index + 1}`);
  });
  return { warnings };
}

function draftFrom(settings: StoreSettings): Draft {
  return {
    delivery: settings.delivery_enabled,
    takeout: settings.takeout_enabled,
    takeoutEstimate: settings.takeout_estimate ?? '',
    zones: zonesDraftFrom(settings.delivery_zones),
    location: locationDraftFrom(settings.latitude, settings.longitude),
  };
}

/**
 * Formato da API (mesma ordem de chaves do que a tela lê da resposta, para comparar com o salvo).
 * Recusando os endereços fora das zonas, a taxa padrão só vai se já tiver prazo (fica guardada para quando
 * a loja voltar a aceitar); senão, vai null.
 */
function toConfig(draft: ZonesDraft, savedDistance?: DistanceSettings): DeliveryZonesConfig {
  const keepFallback = draft.outside === 'fallback' || draft.fallbackTime.trim() !== '';
  const byDistance = draft.mode === 'distance';
  // As faixas vão quando estão completas; incompletas no modo por zonas, fica a versão salva
  const distance =
    draft.distance && (byDistance || !distanceError(draft.distance)) ? toDistanceConfig(draft.distance) : savedDistance;
  // No modo por distância as zonas ficam guardadas (sem uso): só as completas, para não bloquear o salvar
  const zones = byDistance ? draft.zones.filter(isCompleteZone) : draft.zones;
  return {
    zones: zones.map((zone) => {
      const zipRanges = zone.zipRanges.map(parseZipRange).filter((range): range is ZipRange => range !== null);
      return {
        neighborhoods: zone.neighborhoods,
        ...(zone.cities.length ? { cities: zone.cities } : {}),
        ...(zipRanges.length ? { zip_ranges: zipRanges } : {}),
        fee: currencyToNumber(zone.fee),
        time: zone.time.trim(),
        ...zoneRules(zone),
      };
    }),
    fallback: keepFallback ? { fee: currencyToNumber(draft.fallbackFee), time: draft.fallbackTime.trim() } : null,
    outside_zones: draft.outside,
    ...storeRules(draft),
    ...(byDistance ? { mode: 'distance' as const } : {}),
    ...(distance ? { distance } : {}),
  };
}

/** Zona com bairros ou faixas de CEP válidas e prazo: pode ser guardada mesmo no modo por distância. */
function isCompleteZone(zone: ZoneDraft): boolean {
  const input = {
    neighborhoods: zone.neighborhoods,
    cities: zone.cities,
    zipRanges: zone.zipRanges,
    fee: currencyToNumber(zone.fee),
    time: zone.time.trim(),
  };
  return zonesError({ fee: 0, time: 'ok' }, [input], 'fallback') === null;
}

type DeliveryErrors = { general?: string; takeoutEstimate?: string; zones?: string; location?: string };

function validate(draft: Draft, settings: StoreSettings): DeliveryErrors {
  const errors: DeliveryErrors = {};
  if (!draft.delivery && !draft.takeout) errors.general = FULFILLMENT_REQUIRED;
  else if (draft.delivery && !draft.zones && !settings.is_default_store) errors.general = DELIVERY_ZONES_REQUIRED;
  if (draft.takeoutEstimate.trim().length > FIELD_LIMITS.takeout_estimate) {
    errors.takeoutEstimate = tooLong('O prazo da retirada', FIELD_LIMITS.takeout_estimate);
  }
  const location = parseLocation(draft.location);
  if (location === 'invalid') errors.location = LOCATION_INVALID_MESSAGE;
  else if (draft.zones?.mode === 'distance' && location.latitude === null) errors.location = LOCATION_REQUIRED_MESSAGE;
  if (draft.zones?.mode === 'distance') {
    const message = distanceOutsideError(draft.zones) ?? (draft.zones.distance ? distanceError(draft.zones.distance) : 'Cadastre as faixas de distância.') ?? orderRulesCheck(draft.zones).error;
    if (message) errors.zones = message;
  } else if (draft.zones) {
    const config = toConfig(draft.zones);
    const zones = draft.zones.zones.map((zone, index) => ({
      neighborhoods: zone.neighborhoods,
      cities: zone.cities,
      zipRanges: zone.zipRanges,
      fee: config.zones[index].fee,
      time: config.zones[index].time,
    }));
    const message = zonesError(config.fallback, zones, draft.zones.outside) ?? orderRulesCheck(draft.zones).error;
    if (message) errors.zones = message;
  }
  return errors;
}

/** Modo por distância: a taxa padrão (além do raio ou endereço não localizado) precisa de prazo, salvo na recusa. */
function distanceOutsideError(draft: ZonesDraft): string | null {
  if (draft.outside === 'refuse') return null;
  const time = draft.fallbackTime.trim();
  if (!time) return 'Informe o prazo para endereços além do raio ou não localizados (ex.: 60-70 min).';
  if (time.length > ZONE_LIMITS.timeLength) return `O prazo dos endereços além do raio pode ter no máximo ${ZONE_LIMITS.timeLength} caracteres.`;
  if (currencyToNumber(draft.fallbackFee) > MAX_MONEY) return 'Taxa inválida para os endereços além do raio.';
  return null;
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
  const modeName = useId();

  const savedDistance = settings.delivery_zones?.distance;
  const location = parseLocation(draft.location);
  const config = draft.zones ? toConfig(draft.zones, savedDistance) : null;
  const changes = changedFields(settings, {
    delivery_enabled: draft.delivery,
    takeout_enabled: draft.takeout,
    takeout_estimate: optionalText(draft.takeoutEstimate),
    delivery_zones: config,
    // Coordenadas inválidas não entram (a validação aponta o campo)
    ...(location !== 'invalid' ? { latitude: location.latitude, longitude: location.longitude } : {}),
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
  const byDistance = zones?.mode === 'distance';

  function setMode(mode: ZonesDraft['mode']) {
    setZones((current) => ({
      ...current,
      mode,
      // Primeira vez no modo distância: faixas sugeridas (só os km; taxa e prazo em branco)
      distance: mode === 'distance' && !current.distance ? newDistanceDraft() : current.distance,
      // Voltando às zonas sem nenhuma: uma zona em branco para preencher
      zones: mode === 'zones' && current.zones.length === 0 ? [emptyZone()] : current.zones,
    }));
  }

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
              <MapPinned size={18} className="text-orange-600 dark:text-orange-400" aria-hidden="true" /> {byDistance ? 'Taxa de entrega por distância' : 'Zonas de entrega'}
            </h3>
            {byDistance ? (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                A taxa depende de quantos km o cliente está da loja. O endereço do cliente é localizado no mapa automaticamente.
              </p>
            ) : (
              <>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  Vale a primeira zona que tiver o bairro do cliente (nome inteiro, sem diferenciar acentos) ou o CEP dele numa das faixas. Cidades são opcionais.
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  O bairro é conferido pelo CEP do endereço: use os nomes de bairro dos Correios (os mesmos que aparecem na busca do CEP). Se o CEP não informar o bairro, vale o que o cliente digitou.
                </p>
              </>
            )}
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
              {' '}Com as zonas cadastradas, você também pode definir um pedido mínimo e frete grátis acima de um valor.
            </p>
            {!readOnly && (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setDraft((current) => ({ ...current, zones: emptyZones() }))}
                  className={buttonClass('primary', 'sm')}
                >
                  <Plus size={14} aria-hidden="true" /> Cadastrar zonas
                </button>
                <button
                  type="button"
                  onClick={() => setDraft((current) => ({ ...current, zones: emptyZones('distance') }))}
                  className={buttonClass('secondary', 'sm')}
                >
                  <Ruler size={14} aria-hidden="true" /> Cobrar por distância
                </button>
              </div>
            )}
          </div>
        ) : (
          <>
            <fieldset className="p-4 rounded-xl border border-gray-200 dark:border-slate-700 space-y-3">
              <legend className="px-1 text-sm font-bold text-gray-800 dark:text-gray-100">Como cobrar a entrega</legend>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <OutsideOption
                  name={modeName}
                  checked={!byDistance}
                  disabled={readOnly}
                  onSelect={() => setMode('zones')}
                  title="Por bairro ou CEP (zonas)"
                  description="Cada região (bairros ou faixas de CEP) tem a sua taxa e o seu prazo."
                />
                <OutsideOption
                  name={modeName}
                  checked={byDistance}
                  disabled={readOnly}
                  onSelect={() => setMode('distance')}
                  title="Por distância (km)"
                  description="A taxa depende de quantos km o cliente está da loja (ex.: até 2 km R$ 5,00; até 5 km R$ 8,00)."
                />
              </div>
              {byDistance && zones.zones.length > 0 && (
                <p className="text-xs text-gray-500 dark:text-gray-400">As zonas completas que você já cadastrou ficam guardadas para quando voltar a cobrar por bairro.</p>
              )}
            </fieldset>

            <fieldset className="p-4 rounded-xl border border-gray-200 dark:border-slate-700 space-y-3" aria-describedby={outsideHintId}>
              <legend className="px-1 text-sm font-bold text-gray-800 dark:text-gray-100">{byDistance ? 'Endereços além do raio ou não localizados' : 'Endereços fora das zonas'}</legend>
              <p id={outsideHintId} className="text-xs text-gray-500 dark:text-gray-400">
                {byDistance
                  ? 'O que acontece quando o cliente está mais longe que a última faixa (ou o raio máximo) ou quando o endereço dele não é encontrado no mapa.'
                  : 'O que acontece quando o bairro (conferido pelo CEP) e o CEP do cliente não estão em nenhuma zona abaixo.'}
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
                  <FormField label={byDistance ? 'Taxa fora do raio' : 'Taxa fora das zonas'}>
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
                  <FormField label={byDistance ? 'Prazo fora do raio' : 'Prazo fora das zonas'} required>
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

            <OrderRulesFieldset
              zones={zones}
              readOnly={readOnly}
              takeoutEnabled={draft.takeout}
              onChange={(patch) => setZones((current) => ({ ...current, ...patch }))}
            />

            {byDistance && (
              <>
                <StoreLocationField
                  value={draft.location}
                  onChange={(next) => setDraft((current) => ({ ...current, location: next }))}
                  readOnly={readOnly}
                  error={errors.location}
                  hasSavedAddress={!!settings.address_zip_code}
                />
                {zones.distance && (
                  <DistanceBandsEditor
                    draft={zones.distance}
                    onChange={(patch) => setZones((current) => (current.distance ? { ...current, distance: { ...current.distance, ...patch } } : current))}
                    readOnly={readOnly}
                    showErrors={showErrors}
                    storeMinOrder={zones.minOrder}
                    storeFreeAbove={zones.freeAbove}
                    roadDistanceAvailable={settings.road_distance_available}
                    warnings={distanceWarnings(zones.distance, storeRules(zones))}
                  />
                )}
              </>
            )}

            {!byDistance && (
            <ol className="space-y-4">
              {zones.zones.map((zone, index) => (
                <li key={zone.key}>
                  <ZoneEditor
                    zone={zone}
                    position={index + 1}
                    total={zones.zones.length}
                    storeMinOrder={zones.minOrder}
                    storeFreeAbove={zones.freeAbove}
                    readOnly={readOnly}
                    showErrors={showErrors}
                    onChange={(patch) => updateZone(zone.key, patch)}
                    onMove={(offset) => moveZone(index, offset)}
                    onRemove={() => setZones((current) => ({ ...current, zones: current.zones.filter((item) => item.key !== zone.key) }))}
                  />
                </li>
              ))}
            </ol>
            )}

            {!readOnly && !byDistance && (
              <button
                type="button"
                onClick={() => setZones((current) => ({ ...current, zones: [...current.zones, emptyZone()] }))}
                disabled={zones.zones.length >= ZONE_LIMITS.zones}
                className={buttonClass('secondary', 'sm')}
              >
                <Plus size={14} aria-hidden="true" /> Adicionar zona
              </button>
            )}

            <DeliverySimulator
              config={config}
              location={location !== 'invalid' ? location : null}
              readOnly={readOnly}
            />
          </>
        )}
      </section>
    </SettingsSection>
  );
}

interface OrderRulesFieldsetProps {
  zones: ZonesDraft;
  readOnly: boolean;
  takeoutEnabled: boolean;
  onChange: (patch: Partial<Pick<ZonesDraft, 'minOrder' | 'minOrderTakeout' | 'freeAbove'>>) => void;
}

/** Pedido mínimo e frete grátis da loja (cada zona pode ter os próprios, nos campos da zona). */
function OrderRulesFieldset({ zones, readOnly, takeoutEnabled, onChange }: OrderRulesFieldsetProps) {
  const hintId = useId();
  const { warnings } = orderRulesCheck(zones);
  const minValue = moneyOrUndefined(zones.minOrder);
  const hasMin = minValue !== undefined && minValue > 0;
  return (
    <fieldset className="p-4 rounded-xl border border-gray-200 dark:border-slate-700 space-y-4" aria-describedby={hintId}>
      <legend className="px-1 text-sm font-bold text-gray-800 dark:text-gray-100 flex items-center gap-2">
        <ShoppingBag size={16} className="text-orange-600 dark:text-orange-400" aria-hidden="true" /> Pedido mínimo e frete grátis
      </legend>
      <p id={hintId} className="text-xs text-gray-500 dark:text-gray-400">
        Os valores comparam o total dos produtos do pedido (já com as promoções, sem a taxa de entrega). Deixe em branco para não usar. Cada zona abaixo pode ter valores próprios.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FormField label="Pedido mínimo para entrega" hint="Abaixo dele, o cliente vê quanto falta e não consegue finalizar.">
          {(field) => (
            <input
              {...field}
              inputMode="numeric"
              value={zones.minOrder}
              onChange={(event) => onChange({ minOrder: maskMoney(event.target.value) })}
              placeholder="Sem pedido mínimo"
              disabled={readOnly}
              className={fieldControlClass()}
            />
          )}
        </FormField>
        <FormField label="Frete grátis a partir de" hint="Pedidos com este valor em produtos (ou mais) não pagam a taxa de entrega.">
          {(field) => (
            <input
              {...field}
              inputMode="numeric"
              value={zones.freeAbove}
              onChange={(event) => onChange({ freeAbove: maskMoney(event.target.value) })}
              placeholder="Sem frete grátis"
              disabled={readOnly}
              className={fieldControlClass()}
            />
          )}
        </FormField>
      </div>
      <Switch
        checked={hasMin && zones.minOrderTakeout}
        onChange={(checked) => onChange({ minOrderTakeout: checked })}
        label="Pedido mínimo também na retirada no balcão"
        description={
          !hasMin
            ? 'Informe um pedido mínimo para usar esta opção.'
            : takeoutEnabled
              ? 'Desligado: o pedido mínimo vale só para entrega.'
              : 'A retirada no balcão está desligada; a opção vale quando ela for ligada.'
        }
        disabled={readOnly || !hasMin}
      />
      {warnings.length > 0 && (
        <ul role="status" className="px-4 py-3 rounded-xl text-xs font-semibold bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-200 border border-amber-200 dark:border-amber-800 space-y-1">
          {warnings.map((warning) => (
            <li key={warning} className="flex items-start gap-2">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" aria-hidden="true" /> {warning}
            </li>
          ))}
        </ul>
      )}
    </fieldset>
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
  /** Pedido mínimo e frete grátis da loja (como digitados), mostrados quando a zona herda. */
  storeMinOrder: string;
  storeFreeAbove: string;
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

function ZoneEditor({ zone, position, total, storeMinOrder, storeFreeAbove, readOnly, showErrors, onChange, onMove, onRemove }: ZoneEditorProps) {
  const storeMin = moneyOrUndefined(storeMinOrder);
  const inheritedMin = storeMin !== undefined && storeMin > 0 ? `Igual ao da loja (${formatCurrency(storeMin)})` : 'Igual ao da loja (sem mínimo)';
  const storeFree = moneyOrUndefined(storeFreeAbove);
  const inheritedFree = storeFree !== undefined ? `Igual ao da loja (${formatCurrency(storeFree)})` : 'Igual ao da loja (sem frete grátis)';
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

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FormField label={`Pedido mínimo (zona ${position})`} hint="Vazio: usa o da loja. R$ 0,00: sem mínimo nesta zona.">
          {(field) => (
            <input
              {...field}
              inputMode="numeric"
              value={zone.minOrder}
              onChange={(event) => onChange({ minOrder: maskMoney(event.target.value) })}
              placeholder={inheritedMin}
              disabled={readOnly}
              className={fieldControlClass()}
            />
          )}
        </FormField>
        <FormField label={`Frete grátis a partir de (zona ${position})`} hint="Vazio: usa o da loja. R$ 0,00: entrega sempre grátis nesta zona.">
          {(field) => (
            <input
              {...field}
              inputMode="numeric"
              value={zone.freeAbove}
              onChange={(event) => onChange({ freeAbove: maskMoney(event.target.value) })}
              placeholder={inheritedFree}
              disabled={readOnly}
              className={fieldControlClass()}
            />
          )}
        </FormField>
      </div>
    </fieldset>
  );
}
