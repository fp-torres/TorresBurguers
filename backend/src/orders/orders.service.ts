import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, MoreThanOrEqual } from 'typeorm';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto'; 
import { Order, OrderStatus, OrderType, PaymentStatus } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { Product } from '../products/entities/product.entity';
import { User } from '../users/entities/user.entity';
import { Address } from '../addresses/entities/address.entity';
import { Addon } from '../products/entities/addon.entity';
import { StoreService } from '../store/store.service'; 

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order)
    private orderRepository: Repository<Order>,
    @InjectRepository(Product)
    private productRepository: Repository<Product>,
    @InjectRepository(Address)
    private addressRepository: Repository<Address>,
    @InjectRepository(Addon)
    private addonRepository: Repository<Addon>,
    private readonly storeService: StoreService,
  ) {}

  private calculateDeliveryFee(neighborhood: string): { fee: number, time: string } {
    const bairro = neighborhood ? neighborhood.toLowerCase() : '';
    if (bairro.includes('centro') || bairro.includes('lapa')) return { fee: 5.00, time: '30-40 min' };
    if (bairro.includes('flamengo') || bairro.includes('botafogo')) return { fee: 7.00, time: '40-50 min' };
    if (bairro.includes('copacabana') || bairro.includes('ipanema')) return { fee: 10.00, time: '50-60 min' };
    if (bairro.includes('barra')) return { fee: 20.00, time: '60-80 min' };
    return { fee: 15.00, time: '50-60 min' };
  }

  async create(createOrderDto: CreateOrderDto, userId: number) {
    const isOpen = await this.storeService.isOpen();
    if (!isOpen) throw new BadRequestException('A loja está fechada.');

    const order = new Order();
    order.user = { id: userId } as User;
    order.status = OrderStatus.PENDING;
    order.payment_status = PaymentStatus.PENDING;
    order.items = [];
    order.total_price = 0;
    order.payment_method = createOrderDto.paymentMethod;
    order.type = createOrderDto.type;

    if (order.type === OrderType.DELIVERY) {
      if (!createOrderDto.addressId) throw new BadRequestException('Endereço obrigatório');
      const address = await this.addressRepository.findOne({ where: { id: createOrderDto.addressId } });
      if (!address) throw new NotFoundException('Endereço não encontrado');
      
      order.address = address;
      const logistics = this.calculateDeliveryFee(address.neighborhood);
      order.delivery_fee = logistics.fee;
      order.estimated_delivery_time = logistics.time;
    } else {
      order.address = null;
      order.delivery_fee = 0;
      order.estimated_delivery_time = '15-20 min';
    }

    const productIds = createOrderDto.items.map(i => i.productId);
    const products = await this.productRepository.findBy({ id: In(productIds) });

    for (const itemDto of createOrderDto.items) {
      const product = products.find(p => p.id === itemDto.productId);
      if (!product) continue;

      const orderItem = new OrderItem();
      orderItem.product = product;
      orderItem.quantity = itemDto.quantity;
      orderItem.observation = itemDto.observation || '';
      
      orderItem.meat_point = itemDto.meatPoint || null;
      orderItem.removed_ingredients = itemDto.removedIngredients || []; 
      
      let price = Number(product.price);
      if (itemDto.addonIds?.length) {
        const addons = await this.addonRepository.findBy({ id: In(itemDto.addonIds) });
        orderItem.addons = addons;
        price += addons.reduce((sum, a) => sum + Number(a.price), 0);
      }
      order.items.push(orderItem);
      order.total_price += price * itemDto.quantity;
    }

    order.total_price += order.delivery_fee;
    return this.orderRepository.save(order);
  }

  async findAll() {
    return this.orderRepository.find({
      relations: ['items', 'items.product', 'items.addons', 'user', 'address'], 
      order: { created_at: 'DESC' } as any,
    });
  }

  async findMyOrders(userId: number) {
    return this.orderRepository.find({
      relations: ['items', 'items.product', 'items.addons', 'user', 'address'], 
      where: { user: { id: userId } }, 
      order: { created_at: 'DESC' } as any,
    });
  }

  findOne(id: number) {
    return this.orderRepository.findOne({
      where: { id },
      relations: ['items', 'items.product', 'items.addons', 'user', 'address'],
    });
  }

  async cancelOrder(orderId: number, user: any) {
    const order = await this.findOne(orderId);
    if (!order) throw new NotFoundException('Pedido não encontrado');

    if (user.role !== 'ADMIN' && order.user.id !== user.id) {
      throw new ForbiddenException('Você não tem permissão para cancelar este pedido.');
    }

    if (user.role !== 'ADMIN' && order.status !== OrderStatus.PENDING) {
      throw new BadRequestException('O pedido já está em preparo e não pode mais ser cancelado pelo cliente.');
    }

    order.status = OrderStatus.CANCELED;
    return this.orderRepository.save(order);
  }

  async update(id: number, updateOrderDto: UpdateOrderDto) {
    const order = await this.findOne(id);
    if (!order) throw new NotFoundException(`Pedido ${id} não encontrado`);
    this.orderRepository.merge(order, updateOrderDto);
    return this.orderRepository.save(order);
  }

  // --- CORREÇÃO DO DASHBOARD AQUI ---
  async getDashboardSummary() {
    // 1. Total de pedidos (exceto cancelados)
    const totalOrders = await this.orderRepository.count({
      where: { status: In([OrderStatus.PENDING, OrderStatus.PREPARING, OrderStatus.READY, OrderStatus.DELIVERED]) }
    });

    // 2. Faturamento (seguro contra NULL)
    const revenueQuery = await this.orderRepository
      .createQueryBuilder('order')
      .select('SUM(order.total_price)', 'total')
      .where('order.status != :st', { st: OrderStatus.CANCELED })
      .getRawOne();
    
    // Se revenueQuery for null ou undefined, retorna 0. Senão, converte string para float.
    const revenue = revenueQuery && revenueQuery.total ? parseFloat(revenueQuery.total) : 0;

    // 3. Contadores de status
    const pendingOrders = await this.orderRepository.count({ where: { status: OrderStatus.PENDING } });
    const preparingOrders = await this.orderRepository.count({ where: { status: OrderStatus.PREPARING } });
    
    // 4. Pagamentos pendentes (apenas de pedidos ativos)
    const pendingPayments = await this.orderRepository.count({ 
      where: { 
        payment_status: PaymentStatus.PENDING,
        status: In([OrderStatus.PENDING, OrderStatus.PREPARING, OrderStatus.READY, OrderStatus.DELIVERED])
      } 
    });

    return {
      totalOrders,
      revenue, // Agora garantido que é number
      pendingOrders,
      preparingOrders,
      pendingPayments
    };
  }

  async getChartData() {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const orders = await this.orderRepository.find({
      where: { created_at: MoreThanOrEqual(sevenDaysAgo) },
      relations: ['items', 'items.product'],
      order: { created_at: 'ASC' }
    });

    const salesByDate: Record<string, number> = {};
    // Inicializa os últimos 7 dias com 0
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
      salesByDate[key] = 0;
    }

    const topProducts: Record<string, number> = {};

    orders.forEach(order => {
      if (order.status === OrderStatus.CANCELED) return;
      
      const dateKey = new Date(order.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
      // Verifica se a data está no range (segurança)
      if (salesByDate[dateKey] !== undefined) {
        salesByDate[dateKey] += Number(order.total_price);
      }

      order.items.forEach(item => {
        const prodName = item.product?.name || 'Item Removido';
        topProducts[prodName] = (topProducts[prodName] || 0) + item.quantity;
      });
    });

    const revenueChart = Object.entries(salesByDate)
      .map(([date, total]) => ({ date, total }))
      .reverse(); // Coloca em ordem cronológica
      
    const productsChart = Object.entries(topProducts)
      .map(([name, quantity]) => ({ name, quantity }))
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 5);
      
    return { revenueChart, productsChart };
  }
}