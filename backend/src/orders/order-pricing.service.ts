import { readFileSync } from 'fs';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, IsNull, Repository } from 'typeorm';
import { Product } from '../products/entities/product.entity';
import { Addon } from '../products/entities/addon.entity';
import { Address } from '../addresses/entities/address.entity';
import { deliveryLocationOf } from '../addresses/address-location';
import { AddressLocationService } from '../addresses/address-location.service';
import { AddressGeoService } from '../addresses/address-geo.service';
import { GeocodingService } from '../addresses/geocoding.service';
import { StoreAccountStatus, type Store } from '../store/entities/store.entity';
import { StoreCustomerBlock } from '../store/entities/store-customer-block.entity';
import type { TenantContext } from '../tenancy/tenant-context';
import { TenantService } from '../tenancy/tenant.service';
import { QuoteOrderDto } from './dto/create-order.dto';
import type { OrderItemAddonSnapshot } from './entities/order-item.entity';
import { OrderType } from './order.enums';
import {
  ADDRESS_NOT_LOCATED_MESSAGE,
  ADDRESS_NOT_LOCATED_REASON,
  distanceDeliveryFor,
  storeDistanceSettings,
  straightDeliveryKm,
  validCoordinates,
  type Coordinates,
  type DeliveryMode,
  type DistanceSettings,
} from './delivery-distance';
import {
  DELIVERY_OUT_OF_AREA_CODE,
  DELIVERY_OUT_OF_AREA_MESSAGE,
  DELIVERY_ZONES_MISSING_MESSAGE,
  ORDER_BELOW_MINIMUM_CODE,
  applyOrderRules,
  countAddonIds,
  deliveryZonesMissing,
  effectiveUnitPriceCents,
  findDeliveryZone,
  fromCents,
  orderBelowMinimumMessage,
  orderRulesQuoteFields,
  orderTotalLimitError,
  orderTypeUnavailableMessage,
  outsideZonesPolicy,
  priceLine,
  resolveDeliveryZones,
  storeDeliveryZones,
  takeoutEstimateFor,
  toCents,
  type DeliveryEstimate,
  type DeliveryZonesConfig,
  type OrderRulesOutcome,
  type OrderRulesQuoteFields,
  type OrderValueRules,
} from './order-rules';

export const STORE_CLOSED_MESSAGE = 'A loja está fechada no momento.';
/**
 * Cliente bloqueado pela loja (store_customer_blocks): resposta 403 genérica no orçamento, no pedido e nas
 * cobranças PIX/cartão daquela loja. O motivo é interno da loja e nunca aparece para o cliente.
 */
export const CUSTOMER_BLOCKED_MESSAGE =
  'Não é possível fazer pedidos nesta loja. Fale com a loja.';

/**
 * Endereço fora das zonas numa loja que recusa esses endereços (delivery_zones.outside_zones = "refuse"):
 * 400 com { statusCode, message, error, code: "DELIVERY_OUT_OF_AREA" } no orçamento, no pedido e nas cobranças.
 */
export function deliveryOutOfAreaException(): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    message: DELIVERY_OUT_OF_AREA_MESSAGE,
    error: 'Bad Request',
    code: DELIVERY_OUT_OF_AREA_CODE,
  });
}

/**
 * Entrega por distância numa loja que recusa endereços fora da área, com o endereço não localizado no mapa:
 * o mesmo 400 DELIVERY_OUT_OF_AREA (o web e o app já tratam), com a explicação e "reason" aditivo.
 */
export function addressNotLocatedException(): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    message: ADDRESS_NOT_LOCATED_MESSAGE,
    error: 'Bad Request',
    code: DELIVERY_OUT_OF_AREA_CODE,
    reason: ADDRESS_NOT_LOCATED_REASON,
  });
}

/**
 * Pedido abaixo do pedido mínimo da loja (ou da zona): 400 com { statusCode, message, error,
 * code: "ORDER_BELOW_MINIMUM", min_order_value, missing_for_min_order } no pedido e nas cobranças.
 */
export function orderBelowMinimumException(
  type: OrderType,
  outcome: Pick<OrderRulesOutcome, 'minOrderCents' | 'missingForMinOrderCents'>,
): BadRequestException {
  const minOrderCents = outcome.minOrderCents ?? 0;
  const missingCents = outcome.missingForMinOrderCents ?? 0;
  return new BadRequestException({
    statusCode: 400,
    message: orderBelowMinimumMessage(type, minOrderCents, missingCents),
    error: 'Bad Request',
    code: ORDER_BELOW_MINIMUM_CODE,
    min_order_value: fromCents(minOrderCents),
    missing_for_min_order: fromCents(missingCents),
  });
}

export interface PriceOptions {
  /**
   * O pagamento já foi aprovado (recuperação do pedido de um pagamento pago): o bloqueio do cliente pela
   * loja não impede o pedido — ele nasce como os criados pela aprovação, e a loja pode cancelar e estornar.
   * Pelo mesmo motivo, a recusa de endereços fora das zonas também não vale (o endereço paga o "fallback"),
   * nem o pedido mínimo.
   */
  alreadyPaid?: boolean;
  /**
   * Orçamento (POST /orders/quote): abaixo do pedido mínimo NÃO recusa — a resposta traz quanto falta
   * (missing_for_min_order) para a tela avisar. O pedido e as cobranças recusam (400 ORDER_BELOW_MINIMUM).
   */
  allowBelowMinimum?: boolean;
}

/**
 * Taxa e prazo da entrega (ou da retirada) e as regras de valor da zona ou faixa atendida (null = as da loja),
 * com o modo de cobrança (null na retirada) e a distância (só no modo distância, quando localizada).
 */
interface Logistics extends DeliveryEstimate {
  area: OrderValueRules | null;
  mode: DeliveryMode | null;
  distanceKm: number | null;
}

/**
 * Zonas em uso e se são as próprias da loja (só elas trazem pedido mínimo e frete grátis). "distance": as faixas
 * de km quando a loja cobra por distância (só com configuração própria e válida).
 */
interface ZonesInUse {
  config: DeliveryZonesConfig;
  own: boolean;
  distance: DistanceSettings | null;
}

/** Modo de cobrança e distância do orçamento (campos aditivos delivery_mode e distance_km). */
export interface PricedDelivery {
  /** null na retirada. */
  mode: DeliveryMode | null;
  /** km com 1 casa (modo distância com o endereço localizado); senão null. */
  distanceKm: number | null;
}

/** Loja do orçamento: o contexto da vitrine (com a situação da assinatura) ou só a entidade. */
export type PricingStore = TenantContext | Store;

/** Item validado e precificado no servidor. */
export interface PricedOrderItem {
  product: Product;
  /** Adicionais distintos (referência ao catálogo). */
  addons: Addon[];
  /** Adicionais cobrados por unidade, com quantidade. */
  addonsSnapshot: OrderItemAddonSnapshot[];
  quantity: number;
  observation: string;
  meatPoint: string | null;
  removedIngredients: string[];
  unitPrice: number;
  /** Adicionais de UMA unidade do item. */
  addonsTotal: number;
  /** (unitPrice + addonsTotal) × quantity */
  lineTotal: number;
}

export interface PricedOrder {
  /** Loja do orçamento (todos os produtos e adicionais são dela). */
  storeId: number;
  type: OrderType;
  items: PricedOrderItem[];
  address: Address | null;
  subtotal: number;
  /** Taxa cobrada (já zerada quando o frete grátis vale). */
  delivery_fee: number;
  total: number;
  totalCents: number;
  estimated_delivery_time: string;
  /** Aberta pela equipe (is_open) e podendo vender (situação da conta e da assinatura). */
  store_open: boolean;
  /** Pedido mínimo e frete grátis aplicados (ausente = nenhuma regra: só em objetos montados fora de price()). */
  rules?: OrderRulesOutcome;
  /** Modo de cobrança e distância (ausente: só em objetos montados fora de price()). */
  delivery?: PricedDelivery;
}

/**
 * Resposta de POST /orders/quote (contrato). Os campos de OrderRulesQuoteFields são aditivos: delivery_fee já
 * vem zerada quando o frete grátis vale (delivery_fee_original guarda a taxa da zona) e o orçamento abaixo do
 * pedido mínimo NÃO falha (missing_for_min_order > 0).
 */
export interface QuoteResponse extends OrderRulesQuoteFields {
  items: {
    productId: number;
    name: string;
    quantity: number;
    unitPrice: number;
    addonsTotal: number;
    lineTotal: number;
  }[];
  subtotal: number;
  total: number;
  estimated_delivery_time: string;
  store_open: boolean;
  /** Aditivo: "zones" ou "distance" na entrega; null na retirada. */
  delivery_mode: DeliveryMode | null;
  /** Aditivo: distância em km (1 casa) no modo distância com o endereço localizado; senão null. */
  distance_km: number | null;
}

function isTenantContext(input: PricingStore): input is TenantContext {
  return 'access' in input && 'storeId' in input;
}

/**
 * Loja e se ela pode vender. Com o contexto da vitrine vale a situação completa (conta + assinatura);
 * com a entidade sozinha, só a situação da conta (quem chama já conferiu a assinatura).
 */
function resolvePricingStore(input: PricingStore): {
  store: Store;
  canSell: boolean;
} {
  if (isTenantContext(input))
    return { store: input.store, canSell: input.access.canSell };
  return {
    store: input,
    canSell: input.account_status === StoreAccountStatus.ACTIVE,
  };
}

/**
 * Valida o carrinho e calcula os valores no servidor — fonte única para o orçamento (/orders/quote),
 * para a criação do pedido e para o valor cobrado nos pagamentos online.
 * Tudo é da loja informada: produto ou adicional de outra loja é tratado como inexistente.
 */
@Injectable()
export class OrderPricingService {
  private readonly logger = new Logger(OrderPricingService.name);
  /**
   * Zonas de entrega padrão da plataforma (delivery-zones.config.ts, DELIVERY_ZONES_JSON ou
   * DELIVERY_ZONES_FILE), lidas uma vez na subida. Valem para as lojas sem zonas próprias.
   */
  private readonly deliveryZones: DeliveryZonesConfig;
  /** Lojas com zonas inválidas já avisadas no log (um aviso por loja, não um por pedido). */
  private readonly invalidZonesWarned = new Set<number>();
  /** Lojas no modo distância sem local já avisadas no log (um aviso por loja). */
  private readonly missingLocationWarned = new Set<number>();

  constructor(
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    @InjectRepository(Addon)
    private readonly addonRepository: Repository<Addon>,
    @InjectRepository(Address)
    private readonly addressRepository: Repository<Address>,
    private readonly tenants: TenantService,
    @InjectRepository(StoreCustomerBlock)
    private readonly blockRepository: Repository<StoreCustomerBlock>,
    private readonly locations: AddressLocationService,
    private readonly addressGeo: AddressGeoService,
    private readonly geocoder: GeocodingService,
  ) {
    const resolved = resolveDeliveryZones(process.env, (path) =>
      readFileSync(path, 'utf8'),
    );
    this.deliveryZones = resolved.config;
    if (resolved.error) {
      this.logger.error(
        `Zonas de entrega inválidas (${resolved.error}). Usando as zonas padrão.`,
      );
    } else if (resolved.source !== 'padrão') {
      this.logger.log(
        `Zonas de entrega carregadas de ${resolved.source} (${resolved.config.zones.length} zonas).`,
      );
    }
  }

  async price(
    dto: QuoteOrderDto,
    userId: number,
    pricingStore: PricingStore,
    options: PriceOptions = {},
  ): Promise<PricedOrder> {
    const { store, canSell } = resolvePricingStore(pricingStore);
    // Antes de tudo: cliente bloqueado por esta loja não orça, não pede e não paga aqui (outras lojas: ok)
    if (!options.alreadyPaid)
      await this.assertCustomerNotBlocked(store.id, userId);
    const requested = dto.items ?? [];
    if (!requested.length)
      throw new BadRequestException('O pedido precisa ter pelo menos um item.');

    // Entrega ou retirada desligada nas configurações da loja
    const typeUnavailable = orderTypeUnavailableMessage(dto.type, store);
    if (typeUnavailable) throw new BadRequestException(typeUnavailable);
    // Sem zonas próprias, só a loja padrão entrega (com as zonas da plataforma)
    if (
      dto.type === OrderType.DELIVERY &&
      deliveryZonesMissing(store, false) &&
      deliveryZonesMissing(
        store,
        (await this.tenants.defaultStore())?.id === store.id,
      )
    ) {
      throw new BadRequestException(DELIVERY_ZONES_MISSING_MESSAGE);
    }

    const [productsById, addonsById, address] = await Promise.all([
      this.loadProducts(
        store.id,
        requested.map((item) => item.productId),
      ),
      this.loadAddons(
        store.id,
        requested.flatMap((item) => item.addonIds ?? []),
      ),
      this.resolveAddress(dto, userId),
    ]);

    // Antes dos itens: endereço fora da área de uma loja que recusa esses endereços → 400
    const zones = this.zonesFor(store);
    const logistics: Logistics = address
      ? zones.distance
        ? await this.distanceLogistics(
            address,
            store,
            zones,
            zones.distance,
            options,
          )
        : this.deliveryLogistics(address, zones, options)
      : {
          ...takeoutEstimateFor(store.takeout_estimate),
          area: null,
          mode: null,
          distanceKm: null,
        };

    const items = requested.map((item): PricedOrderItem => {
      // Produto de outra loja ou da lixeira não é carregado: mesma resposta de um id inexistente
      // (o nome de um item da lixeira só a equipe vê)
      const product = productsById.get(item.productId);
      if (!product || product.deleted_at)
        throw new BadRequestException(
          `Produto #${item.productId} não encontrado.`,
        );
      if (!product.available)
        throw new BadRequestException(
          `O produto "${product.name}" está indisponível no momento.`,
        );

      // Só os adicionais permitidos no produto (e só os da mesma loja). Lista vazia = o produto não
      // aceita adicionais: é o que a vitrine (web e app) e o painel mostram.
      const allowedIds = new Set(
        (product.allowed_addons ?? [])
          .filter((addon) => addon.store_id === store.id)
          .map((addon) => addon.id),
      );

      const addonLines = countAddonIds(item.addonIds).map(
        ({ id, quantity }) => {
          const addon = addonsById.get(id);
          if (!addon || addon.deleted_at)
            throw new BadRequestException(`Adicional #${id} não encontrado.`);
          if (!addon.available) {
            throw new BadRequestException(
              `O adicional "${addon.name}" está indisponível no momento.`,
            );
          }
          if (!allowedIds.size) {
            throw new BadRequestException(
              `O produto "${product.name}" não aceita adicionais.`,
            );
          }
          if (!allowedIds.has(addon.id)) {
            throw new BadRequestException(
              `O adicional "${addon.name}" não pode ser adicionado ao produto "${product.name}".`,
            );
          }
          return { addon, quantity, priceCents: toCents(addon.price) };
        },
      );

      const line = priceLine(
        effectiveUnitPriceCents(product.price, product.promotion_price),
        addonLines,
        item.quantity,
      );

      return {
        product,
        addons: addonLines.map(({ addon }) => addon),
        addonsSnapshot: addonLines.map(({ addon, quantity, priceCents }) => ({
          id: addon.id,
          name: addon.name,
          price: fromCents(priceCents),
          quantity,
        })),
        quantity: item.quantity,
        observation: item.observation?.trim() ?? '',
        meatPoint: item.meatPoint?.trim() || null,
        removedIngredients: (item.removedIngredients ?? [])
          .map((name) => name.trim())
          .filter(Boolean),
        unitPrice: fromCents(line.unitPriceCents),
        addonsTotal: fromCents(line.addonsCents),
        lineTotal: fromCents(line.lineCents),
      };
    });

    const subtotalCents = items.reduce(
      (sum, item) => sum + toCents(item.lineTotal),
      0,
    );
    // Pedido mínimo e frete grátis: os da zona atendida ou os da loja (só nas zonas próprias da loja)
    const rules = applyOrderRules(
      { type: dto.type, subtotalCents, feeCents: toCents(logistics.fee) },
      zones.own ? zones.config : null,
      logistics.area,
    );
    const totalCents = subtotalCents + rules.feeCents;

    // O banco guarda até R$ 99.999.999,99: recusa antes de cobrar (orçamento, pedido e pagamentos)
    const limitError = orderTotalLimitError(totalCents);
    if (limitError) throw new BadRequestException(limitError);

    // Abaixo do mínimo: o pedido e as cobranças recusam; o orçamento mostra quanto falta. Pagamento já
    // aprovado nunca é recusado (a loja pode cancelar e estornar).
    if (
      (rules.missingForMinOrderCents ?? 0) > 0 &&
      !options.alreadyPaid &&
      !options.allowBelowMinimum
    ) {
      throw orderBelowMinimumException(dto.type, rules);
    }

    return {
      storeId: store.id,
      type: dto.type,
      items,
      address,
      subtotal: fromCents(subtotalCents),
      delivery_fee: fromCents(rules.feeCents),
      total: fromCents(totalCents),
      totalCents,
      estimated_delivery_time: logistics.time,
      store_open: store.is_open === true && canSell,
      rules,
      delivery: { mode: logistics.mode, distanceKm: logistics.distanceKm },
    };
  }

  /**
   * Taxa e prazo da entrega: a zona pelo bairro e pela cidade canônicos do CEP (ou os digitados, quando o
   * CEP não confirmou o bairro) ou pela faixa de CEP; fora das zonas, o "fallback" — ou 400 quando a loja
   * recusa esses endereços. Pagamento já aprovado não é recusado (vale o "fallback"; a loja pode cancelar).
   */
  private deliveryLogistics(
    address: Address,
    zones: ZonesInUse,
    options: PriceOptions,
  ): Logistics {
    const { config } = zones;
    const zone = findDeliveryZone(deliveryLocationOf(address), config);
    const by = { mode: 'zones' as const, distanceKm: null };
    // Mínimo e frete grátis próprios da zona só nas zonas da loja (as da plataforma não têm regras)
    if (zone)
      return {
        fee: zone.fee,
        time: zone.time,
        area: zones.own ? zone : null,
        ...by,
      };
    if (outsideZonesPolicy(config) === 'refuse' && !options.alreadyPaid)
      throw deliveryOutOfAreaException();
    // Fora das zonas: o "fallback", com as regras da loja
    return {
      fee: config.fallback.fee,
      time: config.fallback.time,
      area: null,
      ...by,
    };
  }

  /**
   * Entrega por distância: km entre a loja e o endereço (linha reta × fator de rota, ou por rua quando a loja
   * pediu e a plataforma tem a chave do Google — com queda para a linha reta) e a faixa dessa distância, com o
   * pedido mínimo e o frete grátis próprios da faixa. Além do raio, ou sem coordenadas (endereço não localizado
   * ou loja sem local), vale a política de fora da área: o "fallback" ou 400. Pagamento já aprovado nunca é
   * recusado (vale o "fallback"). Os provedores têm prazo curto: nunca travam o orçamento.
   */
  private async distanceLogistics(
    address: Address,
    store: Store,
    zones: ZonesInUse,
    settings: DistanceSettings,
    options: PriceOptions,
  ): Promise<Logistics> {
    const { config } = zones;
    const origin = validCoordinates(store.latitude, store.longitude);
    if (!origin) this.warnMissingStoreLocation(store.id);
    const located = origin ? await this.addressGeo.refresh(address) : address;
    const destination = validCoordinates(
      located.geo_latitude,
      located.geo_longitude,
    );
    const distanceKm =
      origin && destination
        ? await this.distanceKm(origin, destination, settings)
        : null;
    const pick =
      distanceKm === null ? null : distanceDeliveryFor(distanceKm, settings);
    if (pick)
      return {
        fee: pick.fee,
        time: pick.time,
        area: pick.area,
        mode: 'distance',
        distanceKm,
      };
    if (outsideZonesPolicy(config) === 'refuse' && !options.alreadyPaid)
      throw distanceKm === null
        ? addressNotLocatedException()
        : deliveryOutOfAreaException();
    return {
      fee: config.fallback.fee,
      time: config.fallback.time,
      area: null,
      mode: 'distance',
      distanceKm,
    };
  }

  /** Por rua (quando pedido e disponível) ou linha reta × fator de rota; km com 1 casa. */
  private async distanceKm(
    origin: Coordinates,
    destination: Coordinates,
    settings: DistanceSettings,
  ): Promise<number> {
    if (settings.road_distance) {
      const road = await this.geocoder.roadDistanceKm(origin, destination);
      if (road !== null) return road;
    }
    return straightDeliveryKm(origin, destination, settings.route_factor);
  }

  private warnMissingStoreLocation(storeId: number): void {
    if (this.missingLocationWarned.has(storeId)) return;
    this.missingLocationWarned.add(storeId);
    this.logger.warn(
      `A loja #${storeId} cobra a entrega por distância, mas não tem o local (latitude e longitude): os endereços seguem a política de fora da área.`,
    );
  }

  /**
   * Zonas da loja (stores.delivery_zones) ou as da plataforma. "own" = as próprias da loja e válidas: só elas
   * trazem pedido mínimo e frete grátis (a loja padrão com as zonas da plataforma não tem essas regras).
   */
  private zonesFor(store: Store): ZonesInUse {
    const resolved = storeDeliveryZones(
      store.delivery_zones,
      this.deliveryZones,
    );
    if (resolved.error && !this.invalidZonesWarned.has(store.id)) {
      this.invalidZonesWarned.add(store.id);
      this.logger.error(
        `Zonas de entrega da loja #${store.id} inválidas (${resolved.error}). Usando as zonas padrão da plataforma.`,
      );
    }
    const own =
      store.delivery_zones !== null &&
      store.delivery_zones !== undefined &&
      !resolved.error;
    // Cobrança por distância: só com a configuração própria da loja (a da plataforma é sempre por zonas)
    return {
      config: resolved.config,
      own,
      distance: own ? storeDistanceSettings(store.delivery_zones) : null,
    };
  }

  // Sem a lixeira: item excluído responde como um id inexistente (nunca revela o nome)
  private async loadProducts(
    storeId: number,
    ids: number[],
  ): Promise<Map<number, Product>> {
    const products = await this.productRepository.find({
      where: { id: In([...new Set(ids)]), store_id: storeId },
      relations: { allowed_addons: true },
    });
    return new Map(products.map((product) => [product.id, product]));
  }

  private async loadAddons(
    storeId: number,
    ids: number[],
  ): Promise<Map<number, Addon>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    const addons = await this.addonRepository.find({
      where: { id: In(unique), store_id: storeId },
    });
    return new Map(addons.map((addon) => [addon.id, addon]));
  }

  /**
   * DELIVERY exige um endereço do próprio cliente (endereços são globais); TAKEOUT ignora addressId.
   * Endereço ainda não conferido pelo CEP (cadastrado antes da conferência) ou conferido com o serviço de CEP
   * fora do ar há mais de 1 h: confere agora e grava (nunca impede o orçamento).
   */
  private async resolveAddress(
    dto: QuoteOrderDto,
    userId: number,
  ): Promise<Address | null> {
    if (dto.type !== OrderType.DELIVERY) return null;
    if (!dto.addressId)
      throw new BadRequestException('Endereço obrigatório para delivery.');

    // Endereços excluídos pelo cliente (deleted_at preenchido) não recebem pedidos novos
    const address = await this.addressRepository.findOne({
      where: { id: dto.addressId, user: { id: userId }, deleted_at: IsNull() },
    });
    if (!address) throw new NotFoundException('Endereço não encontrado.');
    return this.locations.refresh(address);
  }

  /**
   * Quais produtos, adicionais e endereço de um retrato ainda existem no banco (lixeira conta como
   * existente). Usado ao criar um pedido pago horas depois do orçamento. Produtos e adicionais só
   * contam se forem da loja do pedido; o endereço, se for do cliente (quando informado).
   */
  /** Cliente bloqueado por esta loja → 403 genérico (as outras lojas não são afetadas). */
  private async assertCustomerNotBlocked(
    storeId: number,
    userId: number,
  ): Promise<void> {
    const blocked = await this.blockRepository.exists({
      where: { store_id: storeId, user_id: userId },
    });
    if (blocked) throw new ForbiddenException(CUSTOMER_BLOCKED_MESSAGE);
  }

  async existingReferences(input: {
    storeId: number;
    productIds: number[];
    addonIds: number[];
    addressId: number | null;
    userId?: number;
  }) {
    const productIds = [...new Set(input.productIds)];
    const addonIds = [...new Set(input.addonIds)];
    const addressWhere: FindOptionsWhere<Address> | null = input.addressId
      ? {
          id: input.addressId,
          ...(input.userId !== undefined ? { user: { id: input.userId } } : {}),
        }
      : null;
    const [products, addons, address] = await Promise.all([
      productIds.length
        ? this.productRepository.find({
            where: { id: In(productIds), store_id: input.storeId },
            select: { id: true },
            withDeleted: true,
          })
        : Promise.resolve([]),
      addonIds.length
        ? this.addonRepository.find({
            where: { id: In(addonIds), store_id: input.storeId },
            select: { id: true },
            withDeleted: true,
          })
        : Promise.resolve([]),
      addressWhere
        ? this.addressRepository.exists({ where: addressWhere })
        : Promise.resolve(false),
    ]);
    return {
      productIds: new Set(products.map((product) => product.id)),
      addonIds: new Set(addons.map((addon) => addon.id)),
      addressExists: address,
    };
  }
}

export function toQuoteResponse(priced: PricedOrder): QuoteResponse {
  // Sem o resultado das regras (objeto montado fora de price()): a taxa como veio, sem mínimo nem frete grátis
  const rules: OrderRulesOutcome = priced.rules ?? {
    feeCents: toCents(priced.delivery_fee),
    originalFeeCents: toCents(priced.delivery_fee),
    freeDeliveryApplied: false,
    freeDeliveryThresholdCents: null,
    missingForFreeDeliveryCents: null,
    minOrderCents: null,
    missingForMinOrderCents: null,
  };
  return {
    items: priced.items.map((item) => ({
      productId: item.product.id,
      name: item.product.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      addonsTotal: item.addonsTotal,
      lineTotal: item.lineTotal,
    })),
    subtotal: priced.subtotal,
    total: priced.total,
    estimated_delivery_time: priced.estimated_delivery_time,
    store_open: priced.store_open,
    ...orderRulesQuoteFields(rules),
    // Sem o resultado (objeto montado fora de price()): entrega por zonas, sem distância
    delivery_mode:
      priced.delivery?.mode ??
      (priced.type === OrderType.DELIVERY ? 'zones' : null),
    distance_km: priced.delivery?.distanceKm ?? null,
  };
}
