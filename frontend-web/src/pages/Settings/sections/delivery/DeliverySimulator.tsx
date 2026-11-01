import { useId, useState } from 'react';
import { CheckCircle2, Loader2, MapPinned, Search, XCircle } from 'lucide-react';
import { FormField, buttonClass, cx, fieldControlClass } from '../../../../components/ui';
import { getApiErrorMessage } from '../../../../services/api';
import {
  storeSettingsService,
  type DeliverySimulation,
  type DeliveryZonesConfig,
} from '../../../../services/storeSettingsService';
import { formatCurrency } from '../../../../utils/format';
import { maskCEP } from '../../../../utils/masks';
import { decimalText } from './distanceDraft';

interface DeliverySimulatorProps {
  /** Configuração em edição (o teste usa o rascunho, sem salvar). */
  config: DeliveryZonesConfig | null;
  /** Local da loja em edição (modo distância). */
  location: { latitude: number | null; longitude: number | null } | null;
  /** Sessão de suporte: só leitura. */
  readOnly: boolean;
}

/**
 * "Teste um endereço": o dono da loja informa um CEP (e o número) e vê a distância, a faixa (ou a zona), a taxa
 * e o prazo que o cliente teria com a configuração na tela — antes de salvar.
 */
export default function DeliverySimulator({ config, location, readOnly }: DeliverySimulatorProps) {
  const [zipCode, setZipCode] = useState('');
  const [number, setNumber] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<DeliverySimulation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();
  const digits = zipCode.replace(/\D/g, '');

  async function run() {
    if (digits.length !== 8) {
      setError('Informe o CEP com 8 dígitos (ex.: 20040-003).');
      setResult(null);
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const simulation = await storeSettingsService.simulateDelivery({
        zip_code: digits,
        ...(number.trim() ? { number: number.trim() } : {}),
        ...(config ? { delivery_zones: config } : {}),
        ...(location ? { latitude: location.latitude, longitude: location.longitude } : {}),
      });
      setResult(simulation);
    } catch (failure) {
      setResult(null);
      setError(getApiErrorMessage(failure, 'Não foi possível testar o endereço agora.'));
    } finally {
      setRunning(false);
    }
  }

  return (
    <section aria-labelledby={headingId} className="p-4 rounded-xl border border-dashed border-orange-300 dark:border-orange-800 bg-orange-50/40 dark:bg-orange-900/10 space-y-4">
      <div>
        <h4 id={headingId} className="text-sm font-bold text-gray-800 dark:text-gray-100 flex items-center gap-2">
          <MapPinned size={16} className="text-orange-600 dark:text-orange-400" aria-hidden="true" /> Teste um endereço
        </h4>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          Veja a taxa e o prazo que um cliente teria, com as configurações desta tela (mesmo antes de salvar).
        </p>
      </div>
      {/* Dentro do formulário da seção: Enter aqui testa o endereço em vez de salvar a seção */}
      <div
        className="grid grid-cols-1 sm:grid-cols-[1fr_8rem_auto] gap-3 items-end"
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement)) return;
          event.preventDefault();
          if (!running && !readOnly) void run();
        }}
      >
        <FormField label="CEP do cliente">
          {(field) => (
            <input
              {...field}
              inputMode="numeric"
              value={zipCode}
              onChange={(event) => setZipCode(maskCEP(event.target.value))}
              placeholder="00000-000"
              maxLength={9}
              disabled={readOnly}
              className={fieldControlClass(!!error && digits.length !== 8)}
            />
          )}
        </FormField>
        <FormField label="Número">
          {(field) => (
            <input
              {...field}
              value={number}
              onChange={(event) => setNumber(event.target.value)}
              placeholder="Opcional"
              maxLength={20}
              disabled={readOnly}
              className={fieldControlClass()}
            />
          )}
        </FormField>
        <button type="button" onClick={() => void run()} disabled={running || readOnly} className={buttonClass('secondary', 'md')}>
          {running ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Search size={16} aria-hidden="true" />}
          {running ? 'Testando...' : 'Testar endereço'}
        </button>
      </div>

      <div aria-live="polite">
        {error && (
          <p role="alert" className="px-3 py-2 rounded-lg text-sm font-semibold bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800">
            {error}
          </p>
        )}
        {result && <SimulationResult result={result} />}
      </div>
    </section>
  );
}

function SimulationResult({ result }: { result: DeliverySimulation }) {
  const ok = !result.refused && result.delivery_fee !== null;
  const details: [string, string][] = [];
  if (result.distance_km !== null) details.push(['Distância', `${decimalText(result.distance_km, 1)} km${result.precision === 'ZIP_CENTER' ? ' (centro do CEP)' : ''}`]);
  if (result.band !== null) details.push(['Faixa', result.extra_km ? `${result.band} + ${result.extra_km} km adicional(is)` : String(result.band)]);
  if (result.zone !== null) details.push(['Zona', String(result.zone)]);
  if (result.delivery_fee !== null) details.push(['Taxa', result.delivery_fee > 0 ? formatCurrency(result.delivery_fee) : 'Grátis']);
  if (result.estimated_delivery_time) details.push(['Prazo', result.estimated_delivery_time]);
  if (result.min_order !== null) details.push(['Pedido mínimo', formatCurrency(result.min_order)]);
  if (result.free_delivery_above !== null) details.push(['Frete grátis a partir de', result.free_delivery_above > 0 ? formatCurrency(result.free_delivery_above) : 'sempre']);

  return (
    <div
      data-testid="delivery-simulation-result"
      className={cx(
        'p-3 rounded-lg border text-sm space-y-2',
        ok
          ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 text-green-900 dark:text-green-200'
          : 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-800 dark:text-red-200',
      )}
    >
      <p className="font-bold flex items-start gap-2">
        {ok ? <CheckCircle2 size={16} className="shrink-0 mt-0.5" aria-hidden="true" /> : <XCircle size={16} className="shrink-0 mt-0.5" aria-hidden="true" />}
        {result.message}
      </p>
      {details.length > 0 && (
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
          {details.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-2 sm:justify-start">
              <dt className="font-semibold">{label}:</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
