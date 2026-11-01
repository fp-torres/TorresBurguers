import { parseStoreDeliveryZones } from '../store/store-rules';
import {
  parseDeliveryMode,
  parseDistanceSettings,
  type DeliveryMode,
  type DistanceSettings,
} from './delivery-distance';
import {
  parseOutsideZones,
  parseStoreOrderValueRules,
  type StoreDeliveryZonesConfig,
} from './order-rules';

/**
 * Configuração de entrega gravada em stores.delivery_zones: as zonas (com as regras de valor) e, aditivos, o
 * modo de cobrança ("mode": só "distance" é gravado; ausente = por zonas) e as faixas de distância.
 */
export type StoreDeliverySettings = StoreDeliveryZonesConfig & {
  mode?: Extract<DeliveryMode, 'distance'>;
  distance?: DistanceSettings;
};

/**
 * "delivery_zones" de PATCH /store/settings: as zonas da loja (parseStoreDeliveryZones, com o pedido mínimo e o
 * frete grátis próprios de cada zona), as regras da loja no topo do JSON — "min_order", "free_delivery_above"
 * e "min_order_takeout" (parseStoreOrderValueRules) — e o modo de cobrança: "mode" ("zones" ou "distance") com
 * as faixas em "distance" (parseDistanceSettings). Nada disso configurado → exatamente o JSON de antes.
 *
 * No modo "distance": "distance" é obrigatório, "zones" pode faltar ou vir vazia (fica guardada para quando a
 * loja voltar ao modo por zonas) e "fallback"/"outside_zones" valem para endereços além do raio ou que não
 * foram localizados no mapa. No modo por zonas, um "distance" enviado é validado e guardado (as faixas não se
 * perdem ao trocar de modo). Devolve a configuração normalizada (aplicar de novo dá o mesmo resultado); null
 * limpa. Inválido → Error.
 */
export function parseStoreDeliverySettings(
  raw: unknown,
): StoreDeliverySettings | null {
  if (raw === null || raw === undefined) return null;
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error('o texto enviado não é um JSON válido.');
    }
  }
  const object =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  const mode = parseDeliveryMode(object?.mode);
  const byDistance = mode === 'distance';

  if (byDistance && object) {
    const hasFallback =
      object.fallback !== undefined && object.fallback !== null;
    if (!hasFallback && parseOutsideZones(object.outside_zones) !== 'refuse') {
      throw new Error(
        'informe em "fallback" a taxa e o prazo para endereços além do raio de entrega ou que não forem localizados no mapa (ou recuse esses endereços com "outside_zones": "refuse").',
      );
    }
    if (object.distance === undefined || object.distance === null) {
      throw new Error(
        'no modo por distância ("mode": "distance"), informe as faixas em "distance": { "bands": [{ "up_to_km", "fee", "time" }] }.',
      );
    }
  }
  const zonesInput =
    byDistance && object && object.zones === undefined
      ? { ...object, zones: [] }
      : data;
  const zones = parseStoreDeliveryZones(zonesInput, {
    allowNoZones: byDistance,
  });
  if (!zones) return null;
  const distance =
    object && object.distance !== undefined && object.distance !== null
      ? parseDistanceSettings(object.distance)
      : undefined;
  return {
    ...zones,
    ...parseStoreOrderValueRules(data),
    ...(byDistance ? { mode: 'distance' as const } : {}),
    ...(distance ? { distance } : {}),
  };
}
