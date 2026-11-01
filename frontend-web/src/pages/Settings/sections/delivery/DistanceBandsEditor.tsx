import { useId } from 'react';
import { AlertTriangle, Plus, Ruler, Trash2 } from 'lucide-react';
import { FormField, Switch, buttonClass, fieldControlClass } from '../../../../components/ui';
import { maskMoney } from '../../../../utils/masks';
import { formatCurrency } from '../../../../utils/format';
import { currencyToNumber } from '../../../../utils/masks';
import { ZONE_LIMITS } from '../../validation';
import {
  MAX_DISTANCE_BANDS,
  decimalText,
  draftMaxKm,
  emptyBand,
  parseDecimal,
  type BandDraft,
  type DistanceDraft,
} from './distanceDraft';

interface DistanceBandsEditorProps {
  draft: DistanceDraft;
  onChange: (patch: Partial<DistanceDraft>) => void;
  readOnly: boolean;
  showErrors: boolean;
  /** Pedido mínimo e frete grátis da loja (como digitados), mostrados quando a faixa herda. */
  storeMinOrder: string;
  storeFreeAbove: string;
  /** A plataforma oferece a distância real por rua (Google). */
  roadDistanceAvailable: boolean;
  /** Avisos que não bloqueiam (frete grátis menor que o mínimo). */
  warnings: string[];
}

const moneyText = (text: string) => (text.trim() === '' ? undefined : currencyToNumber(text));

/**
 * Faixas de distância ("até 2 km: R$ 5,00, 25-35 min"), cobrança por km adicional até o raio máximo e o fator de
 * rota (linha reta × fator). Cada faixa pode ter pedido mínimo e frete grátis próprios, como as zonas.
 */
export default function DistanceBandsEditor({
  draft,
  onChange,
  readOnly,
  showErrors,
  storeMinOrder,
  storeFreeAbove,
  roadDistanceAvailable,
  warnings,
}: DistanceBandsEditorProps) {
  const headingId = useId();
  const factorHintId = useId();
  const maxKm = draftMaxKm(draft);

  function updateBand(key: number, patch: Partial<BandDraft>) {
    onChange({ bands: draft.bands.map((band) => (band.key === key ? { ...band, ...patch } : band)) });
  }

  function addBand() {
    const last = parseDecimal(draft.bands[draft.bands.length - 1]?.upToKm ?? '');
    onChange({ bands: [...draft.bands, emptyBand(Number.isFinite(last) ? decimalText(last + 3) : '')] });
  }

  const storeMin = moneyText(storeMinOrder);
  const storeFree = moneyText(storeFreeAbove);
  const inheritedMin = storeMin !== undefined && storeMin > 0 ? `Igual ao da loja (${formatCurrency(storeMin)})` : 'Igual ao da loja (sem mínimo)';
  const inheritedFree = storeFree !== undefined ? `Igual ao da loja (${formatCurrency(storeFree)})` : 'Igual ao da loja (sem frete grátis)';

  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <div>
        <h4 id={headingId} className="text-sm font-bold text-gray-800 dark:text-gray-100 flex items-center gap-2">
          <Ruler size={16} className="text-orange-600 dark:text-orange-400" aria-hidden="true" /> Faixas de distância
        </h4>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          Vale a primeira faixa que cobre a distância até o cliente (ex.: até 2 km R$ 5,00; até 5 km R$ 8,00). Em ordem crescente de km.
          {maxKm !== null && ` Raio de entrega: até ${decimalText(maxKm)} km.`}
        </p>
      </div>

      <ol className="space-y-3">
        {draft.bands.map((band, index) => {
          const position = index + 1;
          const km = parseDecimal(band.upToKm);
          const previous = index > 0 ? parseDecimal(draft.bands[index - 1].upToKm) : 0;
          const badKm = showErrors && (!(km > 0) || (index > 0 && km <= previous));
          const missingTime = showErrors && !band.time.trim();
          return (
            <li key={band.key}>
              <fieldset className="p-4 rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800/60 space-y-4">
                <legend className="px-1 text-sm font-bold text-gray-800 dark:text-gray-100">
                  Faixa {position}
                  {km > 0 && ` · ${index > 0 && previous > 0 ? `de ${decimalText(previous)} ` : ''}até ${decimalText(km)} km`}
                </legend>
                {!readOnly && draft.bands.length > 1 && (
                  <div className="flex justify-end -mt-2">
                    <button
                      type="button"
                      onClick={() => onChange({ bands: draft.bands.filter((item) => item.key !== band.key) })}
                      aria-label={`Remover a faixa ${position}`}
                      title="Remover faixa"
                      className={buttonClass('ghost', 'icon', 'text-red-600 dark:text-red-400')}
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <FormField label={`Até quantos km (faixa ${position})`} required error={badKm ? 'Maior que a faixa anterior (ex.: 2 ou 3,5).' : undefined}>
                    {(field) => (
                      <input
                        {...field}
                        inputMode="decimal"
                        value={band.upToKm}
                        onChange={(event) => updateBand(band.key, { upToKm: event.target.value })}
                        placeholder="Ex.: 3"
                        disabled={readOnly}
                        className={fieldControlClass(badKm)}
                      />
                    )}
                  </FormField>
                  <FormField label={`Taxa (faixa ${position})`}>
                    {(field) => (
                      <input
                        {...field}
                        inputMode="numeric"
                        value={band.fee}
                        onChange={(event) => updateBand(band.key, { fee: maskMoney(event.target.value) })}
                        placeholder="R$ 0,00 (grátis)"
                        disabled={readOnly}
                        className={fieldControlClass()}
                      />
                    )}
                  </FormField>
                  <FormField label={`Prazo (faixa ${position})`} required error={missingTime ? 'Informe o prazo (ex.: 30-40 min).' : undefined}>
                    {(field) => (
                      <input
                        {...field}
                        value={band.time}
                        onChange={(event) => updateBand(band.key, { time: event.target.value })}
                        maxLength={ZONE_LIMITS.timeLength}
                        placeholder="Ex.: 30-40 min"
                        disabled={readOnly}
                        className={fieldControlClass(missingTime)}
                      />
                    )}
                  </FormField>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <FormField label={`Pedido mínimo (faixa ${position})`} hint="Vazio: usa o da loja. R$ 0,00: sem mínimo nesta faixa.">
                    {(field) => (
                      <input
                        {...field}
                        inputMode="numeric"
                        value={band.minOrder}
                        onChange={(event) => updateBand(band.key, { minOrder: maskMoney(event.target.value) })}
                        placeholder={inheritedMin}
                        disabled={readOnly}
                        className={fieldControlClass()}
                      />
                    )}
                  </FormField>
                  <FormField label={`Frete grátis a partir de (faixa ${position})`} hint="Vazio: usa o da loja. R$ 0,00: sempre grátis nesta faixa.">
                    {(field) => (
                      <input
                        {...field}
                        inputMode="numeric"
                        value={band.freeAbove}
                        onChange={(event) => updateBand(band.key, { freeAbove: maskMoney(event.target.value) })}
                        placeholder={inheritedFree}
                        disabled={readOnly}
                        className={fieldControlClass()}
                      />
                    )}
                  </FormField>
                </div>
              </fieldset>
            </li>
          );
        })}
      </ol>

      {!readOnly && (
        <button type="button" onClick={addBand} disabled={draft.bands.length >= MAX_DISTANCE_BANDS} className={buttonClass('secondary', 'sm')}>
          <Plus size={14} aria-hidden="true" /> Adicionar faixa
        </button>
      )}

      <div className="p-4 rounded-xl border border-gray-200 dark:border-slate-700 space-y-4">
        <Switch
          checked={draft.extraEnabled}
          onChange={(checked) => onChange({ extraEnabled: checked })}
          label="Cobrar por km adicional além da última faixa"
          description="Ex.: depois de 8 km, mais R$ 1,50 por km (cada km começado conta), até o raio máximo. Desligado: o raio é a última faixa."
          disabled={readOnly}
        />
        {draft.extraEnabled && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label="Raio máximo (km)" required hint="Além dele vale o que você escolheu para endereços fora da área.">
              {(field) => (
                <input
                  {...field}
                  inputMode="decimal"
                  value={draft.maxKm}
                  onChange={(event) => onChange({ maxKm: event.target.value })}
                  placeholder="Ex.: 12"
                  disabled={readOnly}
                  className={fieldControlClass()}
                />
              )}
            </FormField>
            <FormField label="Valor por km adicional" required>
              {(field) => (
                <input
                  {...field}
                  inputMode="numeric"
                  value={draft.extraFee}
                  onChange={(event) => onChange({ extraFee: maskMoney(event.target.value) })}
                  placeholder="Ex.: R$ 1,50"
                  disabled={readOnly}
                  className={fieldControlClass()}
                />
              )}
            </FormField>
          </div>
        )}
      </div>

      <div className="p-4 rounded-xl border border-gray-200 dark:border-slate-700 space-y-4">
        <FormField
          label="Fator de rota"
          hint={
            <span id={factorHintId}>
              As ruas fazem curvas: a distância cobrada é a linha reta entre a loja e o cliente multiplicada por este número. O padrão 1,3 costuma
              ficar perto do caminho real na cidade (2 km em linha reta viram 2,6 km). Aumente se a região tem rio, morro ou poucas ruas. De 1 a 3.
            </span>
          }
        >
          {(field) => (
            <input
              {...field}
              inputMode="decimal"
              value={draft.routeFactor}
              onChange={(event) => onChange({ routeFactor: event.target.value })}
              placeholder="1,3"
              disabled={readOnly}
              className={fieldControlClass()}
            />
          )}
        </FormField>
        {roadDistanceAvailable && (
          <Switch
            checked={draft.road}
            onChange={(checked) => onChange({ road: checked })}
            label="Usar a distância real pelas ruas"
            description="Calculada pelo serviço de mapas do Google. Se ele não responder, vale a linha reta com o fator acima."
            disabled={readOnly}
          />
        )}
      </div>

      {warnings.length > 0 && (
        <ul role="status" className="px-4 py-3 rounded-xl text-xs font-semibold bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-200 border border-amber-200 dark:border-amber-800 space-y-1">
          {warnings.map((warning) => (
            <li key={warning} className="flex items-start gap-2">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" aria-hidden="true" /> {warning}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
