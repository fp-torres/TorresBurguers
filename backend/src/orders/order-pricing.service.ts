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
import { StoreAccountStatus, type Store } from '../store/entities/store.entity';
import { StoreCustomerBlock } from '../store/entities/store-customer-block.entity';
import type { TenantContext } from '../tenancy/tenant-context';
import { TenantService } from '../tenancy/tenant.service';
import { QuoteOrderDto } from './dto/create-order.dto';
import type { OrderItemAddonSnapshot } from './entities/order-item.entity';
import { OrderType } from './order.enums';
import {
  DELIVERY_OUT_OF_AREA_CODE,
  DELIVERY_OUT_OF_AREA_MESSAGE,
  DELIVERY_ZONES_MISSING_MESSAGE,
  countAddonIds,
  deliveryEstimateAt,
  deliveryZonesMissing,
  effectiveUnitPriceCents,
  fromCents,
  orderTotalLimitError,
  orderTypeUnavailableMessage,
  priceLine,
  resolveDeliveryZones,
  storeDeliveryZones,
  takeoutEstimateFor,
  toCents,
  type DeliveryEstimate,
  type DeliveryZonesConfig,
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

export interface PriceOptions {
  /**
   * O pagamento já foi aprovado (recuperação do pedido de um pagamento pago): o bloqueio do cliente pela
   * loja não impede o pedido — ele nasce como os criados pela aprovação, e a loja pode cancelar e estornar.
   * Pelo mesmo motivo, a recusa de endereços fora das zonas também não vale (o endereço paga o "fallback").
   */
  alreadyPaid?: boolean;
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
  delivery_fee: number;
  total: number;
  totalCents: number;
  estimated_delivery_time: string;
  /** Aberta pela equipe (is_open) e podendo vender (situação da conta e da assinatura). */
  store_open: boolean;
}

/** Resposta de POST /orders/quote (contrato). */
export interface QuoteResponse {
  items: {
    productId: number;
    name: string;
    quantity: number;
    unitPrice: number;
    addonsTotal: number;
    lineTotal: number;
  }[];
  subtotal: number;
  delivery_fee: number;
  total: number;
  estimated_delivery_time: string;
  store_open: boolean;
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
    const logistics = address
      ? this.deliveryLogistics(address, store, options)
      : takeoutEstimateFor(store.takeout_estimate);

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
    const totalCents = subtotalCents + toCents(logistics.fee);

    // O banco guarda até R$ 99.999.999,99: recusa antes de cobrar (orçamento, pedido e pagamentos)
    const limitError = orderTotalLimitError(totalCents);
    if (limitError) throw new BadRequestException(limitError);

    return {
      storeId: store.id,
      type: dto.type,
      items,
      address,
      subtotal: fromCents(subtotalCents),
      delivery_fee: logistics.fee,
      total: fromCents(totalCents),
      totalCents,
      estimated_delivery_time: logistics.time,
      store_open: store.is_open === true && canSell,
    };
  }

  /**
   * Taxa e prazo da entrega: a zona pelo bairro e pela cidade canônicos do CEP (ou os digitados, quando o
   * CEP não confirmou o bairro) ou pela faixa de CEP; fora das zonas, o "fallback" — ou 400 quando a loja
   * recusa esses endereços. Pagamento já aprovado não é recusado (vale o "fallback"; a loja pode cancelar).
   */
  private deliveryLogistics(
    address: Address,
    store: Store,
    options: PriceOptions,
  ): DeliveryEstimate {
    const zones = this.zonesFor(store);
    const estimate = deliveryEstimateAt(deliveryLocationOf(address), zones);
    if (estimate) return estimate;
    if (options.alreadyPaid)
      return { fee: zones.fallback.fee, time: zones.fallback.time };
    throw deliveryOutOfAreaException();
  }

  /** Zonas da loja (stores.delivery_zones) ou as da plataforma. */
  private zonesFor(store: Store): DeliveryZonesConfig {
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
    return resolved.config;
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
    delivery_fee: priced.delivery_fee,
    total: priced.total,
    estimated_delivery_time: priced.estimated_delivery_time,
    store_open: priced.store_open,
  };
}
