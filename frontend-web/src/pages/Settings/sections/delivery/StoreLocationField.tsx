import { Suspense, lazy, useId, useState } from 'react';
import toast from 'react-hot-toast';
import { ExternalLink, Loader2, LocateFixed, MapPin } from 'lucide-react';
import { FormField, buttonClass, fieldControlClass } from '../../../../components/ui';
import { getApiErrorMessage } from '../../../../services/api';
import { storeSettingsService } from '../../../../services/storeSettingsService';
import { decimalText, mapLink, parseLocation, type LocationDraft } from './distanceDraft';

const StoreLocationMap = lazy(() => import('./StoreLocationMap'));

interface StoreLocationFieldProps {
  value: LocationDraft;
  onChange: (value: LocationDraft) => void;
  readOnly: boolean;
  /** Mensagem de erro da validação (local obrigatório ou inválido). */
  error?: string;
  /** A loja tem CEP salvo (seção Endereço): dá para localizar pelo endereço. */
  hasSavedAddress: boolean;
}

/**
 * Local da loja (ponto de partida da distância): localizar pelo endereço salvo, ajustar no mapa (pino arrastável)
 * ou digitar latitude e longitude. Nada é gravado até salvar a seção.
 */
export default function StoreLocationField({ value, onChange, readOnly, error, hasSavedAddress }: StoreLocationFieldProps) {
  const [locating, setLocating] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const headingId = useId();
  const parsed = parseLocation(value);
  const point = parsed !== 'invalid' && parsed.latitude !== null ? parsed : null;

  function setPoint(latitude: number, longitude: number) {
    onChange({ latitude: decimalText(latitude, 6), longitude: decimalText(longitude, 6) });
  }

  async function locate() {
    setLocating(true);
    setNote(null);
    try {
      const found = await storeSettingsService.geocodeStore();
      setPoint(found.latitude, found.longitude);
      const message =
        found.precision === 'ZIP_CENTER'
          ? 'Encontramos só o centro do CEP. Arraste o pino até a porta da loja e salve.'
          : 'Loja localizada pelo endereço. Confira o pino no mapa (arraste se precisar) e salve.';
      setNote(message);
      toast.success('Local da loja encontrado.');
    } catch (failure) {
      toast.error(getApiErrorMessage(failure, 'Não foi possível localizar a loja agora.'), { duration: 6000 });
    } finally {
      setLocating(false);
    }
  }

  return (
    <section aria-labelledby={headingId} className="p-4 rounded-xl border border-gray-200 dark:border-slate-700 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 id={headingId} className="text-sm font-bold text-gray-800 dark:text-gray-100 flex items-center gap-2">
            <MapPin size={16} className="text-orange-600 dark:text-orange-400" aria-hidden="true" /> Local da loja no mapa
          </h4>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            A distância é medida a partir deste ponto até o endereço do cliente.
          </p>
        </div>
        {!readOnly && (
          <button
            type="button"
            onClick={() => void locate()}
            disabled={locating || !hasSavedAddress}
            className={buttonClass('secondary', 'sm')}
          >
            {locating ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <LocateFixed size={14} aria-hidden="true" />}
            {locating ? 'Localizando...' : 'Localizar pelo endereço da loja'}
          </button>
        )}
      </div>
      {!hasSavedAddress && !readOnly && (
        <p className="text-xs text-gray-500 dark:text-gray-400">Salve o CEP da loja na seção Endereço para localizar automaticamente, ou marque o ponto no mapa.</p>
      )}
      {note && (
        <p role="status" className="px-3 py-2 rounded-lg text-xs font-semibold bg-sky-50 dark:bg-sky-900/20 text-sky-900 dark:text-sky-200 border border-sky-200 dark:border-sky-800">
          {note}
        </p>
      )}

      <Suspense
        fallback={
          <div className="h-64 sm:h-72 w-full rounded-xl border border-gray-200 dark:border-slate-700 flex items-center justify-center text-sm text-gray-500">
            <Loader2 size={18} className="animate-spin mr-2" aria-hidden="true" /> Carregando o mapa...
          </div>
        }
      >
        <StoreLocationMap latitude={point?.latitude ?? null} longitude={point?.longitude ?? null} readOnly={readOnly} onChange={setPoint} />
      </Suspense>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {point ? 'Arraste o pino (ou clique no mapa) para ajustar o local exato.' : 'Clique no mapa para marcar a loja, ou localize pelo endereço.'}
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FormField label="Latitude" error={error}>
          {(field) => (
            <input
              {...field}
              inputMode="decimal"
              value={value.latitude}
              onChange={(event) => onChange({ ...value, latitude: event.target.value })}
              placeholder="Ex.: -22,903500"
              disabled={readOnly}
              className={fieldControlClass(!!error)}
            />
          )}
        </FormField>
        <FormField label="Longitude">
          {(field) => (
            <input
              {...field}
              inputMode="decimal"
              value={value.longitude}
              onChange={(event) => onChange({ ...value, longitude: event.target.value })}
              placeholder="Ex.: -43,209600"
              disabled={readOnly}
              className={fieldControlClass(!!error)}
            />
          )}
        </FormField>
      </div>
      {point && (
        <a
          href={mapLink(point.latitude, point.longitude)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-sm font-bold text-orange-700 dark:text-orange-300 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 rounded"
        >
          <ExternalLink size={14} aria-hidden="true" /> Ver no mapa (abre em nova aba)
        </a>
      )}
    </section>
  );
}
