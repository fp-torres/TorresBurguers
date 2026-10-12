import { readFileSync } from 'fs';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { Product } from '../products/entities/product.entity';
import { Addon } from '../products/entities/addon.entity';
import { Address } from '../addresses/entities/address.entity';
import { StoreService } from '../store/store.service';
import { QuoteOrderDto } from './dto/create-order.dto';
import type { OrderItemAddonSnapshot } from './entities/order-item.entity';
import { OrderType } from './order.enums';
import {
  TAKEOUT_ESTIMATE,
  countAddonIds,
  deliveryEstimate,
  effectiveUnitPriceCents,
  fromCents,
  orderTotalLimitError,
  priceLine,
  resolveDeliveryZones,
  toCents,
  type DeliveryZonesConfig,
} from './order-rules';

export const STORE_CLOSED_MESSAGE = 'A loja está fechada no momento.';

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
  type: OrderType;
  items: PricedOrderItem[];
  address: Address | null;
  subtotal: number;
  delivery_fee: number;
  total: number;
  totalCents: number;
  estimated_delivery_time: string;
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

/**
 * Valida o carrinho e calcula os valores no servidor — fonte única para o orçamento (/orders/quote),
 * para a criação do pedido e para o valor cobrado nos pagamentos online.
 */
@Injectable()
export class OrderPricingService {
  private readonly logger = new Logger(OrderPricingService.name);
  /** Zonas de entrega (delivery-zones.config.ts, DELIVERY_ZONES_JSON ou DELIVERY_ZONES_FILE). */
  private readonly deliveryZones: DeliveryZonesConfig;

  constructor(
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    @InjectRepository(Addon)
    private readonly addonRepository: Repository<Addon>,
    @InjectRepository(Address)
    private readonly addressRepository: Repository<Address>,
    private readonly storeService: StoreService,
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

  async price(dto: QuoteOrderDto, userId: number): Promise<PricedOrder> {
    const requested = dto.items ?? [];
    if (!requested.length)
      throw new BadRequestException('O pedido precisa ter pelo menos um item.');

    const [productsById, addonsById, address, storeOpen] = await Promise.all([
      this.loadProducts(requested.map((item) => item.productId)),
      this.loadAddons(requested.flatMap((item) => item.addonIds ?? [])),
      this.resolveAddress(dto, userId),
      this.storeService.isOpen(),
    ]);

    const items = requested.map((item): PricedOrderItem => {
      const product = productsById.get(item.productId);
      if (!product)
        throw new BadRequestException(
          `Produto #${item.productId} não encontrado.`,
        );
      if (product.deleted_at)
        throw new BadRequestException(
          `O produto "${product.name}" não está mais no cardápio.`,
        );
      if (!product.available)
        throw new BadRequestException(
          `O produto "${product.name}" está indisponível no momento.`,
        );

      // Quando o produto define adicionais permitidos, só eles valem
      const allowedIds = new Set(
        (product.allowed_addons ?? []).map((addon) => addon.id),
      );

      const addonLines = countAddonIds(item.addonIds).map(
        ({ id, quantity }) => {
          const addon = addonsById.get(id);
          if (!addon)
            throw new BadRequestException(`Adicional #${id} não encontrado.`);
          if (addon.deleted_at || !addon.available) {
            throw new BadRequestException(
              `O adicional "${addon.name}" está indisponível no momento.`,
            );
          }
          if (allowedIds.size > 0 && !allowedIds.has(addon.id)) {
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

    const logistics = address
      ? deliveryEstimate(address.neighborhood, address.city, this.deliveryZones)
      : TAKEOUT_ESTIMATE;
    const subtotalCents = items.reduce(
      (sum, item) => sum + toCents(item.lineTotal),
      0,
    );
    const totalCents = subtotalCents + toCents(logistics.fee);

    // O banco guarda até R$ 99.999.999,99: recusa antes de cobrar (orçamento, pedido e pagamentos)
    const limitError = orderTotalLimitError(totalCents);
    if (limitError) throw new BadRequestException(limitError);

    return {
      type: dto.type,
      items,
      address,
      subtotal: fromCents(subtotalCents),
      delivery_fee: logistics.fee,
      total: fromCents(totalCents),
      totalCents,
      estimated_delivery_time: logistics.time,
      store_open: storeOpen,
    };
  }

  // Inclui os itens da lixeira só para poder citar o nome na mensagem de erro
  private async loadProducts(ids: number[]): Promise<Map<number, Product>> {
    const products = await this.productRepository.find({
      where: { id: In([...new Set(ids)]) },
      relations: { allowed_addons: true },
      withDeleted: true,
    });
    return new Map(products.map((product) => [product.id, product]));
  }

  private async loadAddons(ids: number[]): Promise<Map<number, Addon>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    const addons = await this.addonRepository.find({
      where: { id: In(unique) },
      withDeleted: true,
    });
    return new Map(addons.map((addon) => [addon.id, addon]));
  }

  /** DELIVERY exige um endereço do próprio cliente; TAKEOUT ignora addressId. */
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
    return address;
  }

  /**
   * Quais produtos, adicionais e endereço de um retrato ainda existem no banco (lixeira conta como
   * existente). Usado ao criar um pedido pago horas depois do orçamento.
   */
  async existingReferences(input: {
    productIds: number[];
    addonIds: number[];
    addressId: number | null;
  }) {
    const productIds = [...new Set(input.productIds)];
    const addonIds = [...new Set(input.addonIds)];
    const [products, addons, address] = await Promise.all([
      productIds.length
        ? this.productRepository.find({
            where: { id: In(productIds) },
            select: { id: true },
            withDeleted: true,
          })
        : Promise.resolve([]),
      addonIds.length
        ? this.addonRepository.find({
            where: { id: In(addonIds) },
            select: { id: true },
            withDeleted: true,
          })
        : Promise.resolve([]),
      input.addressId
        ? this.addressRepository.exists({ where: { id: input.addressId } })
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
