import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, MoreThanOrEqual, IsNull, Not } from 'typeorm'; 
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto'; 
import { Order, OrderStatus, OrderType, PaymentStatus } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { Product } from '../products/entities/product.entity';
import { User, UserRole } from '../users/entities/user.entity'; 
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
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private readonly storeService: StoreService,
  ) {}

  // Lógica simples de frete baseada no nome do bairro
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
    if (!isOpen) throw new BadRequestException('A loja está fechada no momento.');

    const order = new Order();
    order.user = { id: userId } as any; 
    order.status = OrderStatus.PENDING;
    
    // Tratamento de Pagamento
    if (createOrderDto.paymentId) {
      order.payment_status = PaymentStatus.PAID;
      // @ts-ignore: Propriedade dinâmica se não estiver na entidade tipada
      order.payment_id = createOrderDto.paymentId; 
    } else {
      order.payment_status = PaymentStatus.PENDING;
    }

    order.items = [];
    order.total_price = 0;
    order.payment_method = createOrderDto.paymentMethod;
    order.type = createOrderDto.type;
    order.change_for = (createOrderDto.changeFor || null) as any;

    // Tratamento de Endereço e Frete
    if (order.type === OrderType.DELIVERY) {
      if (!createOrderDto.addressId) throw new BadRequestException('Endereço obrigatório para delivery.');
      
      const address = await this.addressRepository.findOne({ where: { id: createOrderDto.addressId } });
      if (!address) throw new NotFoundException('Endereço não encontrado.');
      
      order.address = address;
      const logistics = this.calculateDeliveryFee(address.neighborhood || '');
      order.delivery_fee = logistics.fee;
      order.estimated_delivery_time = logistics.time;
    } else {
      // Retirada no balcão
      order.address = null;
      order.delivery_fee = 0;
      order.estimated_delivery_time = '15-20 min';
    }

    // Processamento dos Itens
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
      
      let itemPrice = Number(product.price);
      
      // Adicionais
      if (itemDto.addonIds?.length) {
        const addons = await this.addonRepository.findBy({ id: In(itemDto.addonIds) });
        orderItem.addons = addons;
        itemPrice += addons.reduce((sum, a) => sum + Number(a.price), 0);
      }
      
      // Associa item ao pedido
      orderItem.order = order; 
      order.items.push(orderItem);
      order.total_price += itemPrice * itemDto.quantity;
    }

    // Adiciona frete ao total
    order.total_price += order.delivery_fee;
    
    // Salva o pedido (cascade vai salvar os itens)
    const savedOrder = await this.orderRepository.save(order);

    // --- CORREÇÃO DO ERRO CIRCULAR ---
    // Removemos a referência 'order' de dentro dos itens antes de retornar o JSON
    if (savedOrder.items) {
      savedOrder.items.forEach(item => {
        delete (item as any).order; 
      });
    }

    return savedOrder;
  }

  async findAll() {
    return this.orderRepository.find({
      relations: ['items', 'items.product', 'items.addons', 'user', 'address', 'driver'],
      order: { created_at: 'DESC' } as any,
    });
  }

  async findMyOrders(userId: number) {
    return this.orderRepository.find({
      relations: ['items', 'items.product', 'items.addons', 'user', 'address', 'driver'], 
      where: { user: { id: userId } }, 
      order: { created_at: 'DESC' } as any,
    });
  }

  findOne(id: number) {
    return this.orderRepository.findOne({
      where: { id },
      relations: ['items', 'items.product', 'items.addons', 'user', 'address', 'driver'],
    });
  }

  async cancelOrder(orderId: number, user: any) {
    const order = await this.findOne(orderId);
    if (!order) throw new NotFoundException('Pedido não encontrado');

    // Validação de permissão
    if (user.role !== 'ADMIN' && order.user.id !== user.id) {
      throw new ForbiddenException('Você não tem permissão para cancelar este pedido.');
    }

    // Regra de negócio: Cliente só cancela se ainda estiver PENDING
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

  // --- MÉTODOS DE DRIVER / LOGÍSTICA ---

  // 1. Atribuir Motoboy e Mudar Status
  async assignDriver(orderId: number, driverId: number) {
    const order = await this.findOne(orderId);
    if (!order) throw new NotFoundException('Pedido não encontrado');

    // Verifica se o usuário é realmente um motoboy
    const driver = await this.userRepository.findOne({ where: { id: driverId, role: UserRole.COURIER } });
    if (!driver) throw new NotFoundException('Motoboy não encontrado ou usuário não possui cargo de entregador.');

    order.driver = driver;
    // Ao atribuir, já muda para 'DELIVERING' para agilizar
    order.status = OrderStatus.DELIVERING; 
    
    return this.orderRepository.save(order);
  }

  // 2. Listar Motoboys Disponíveis
  async getAvailableDrivers() {
    return this.userRepository.find({
      where: { role: UserRole.COURIER },
      select: ['id', 'name', 'phone', 'avatar'] // Retorna apenas dados seguros
    });
  }

  // 3. Sugestão de Pedidos Próximos (Lógica por Bairro COM LOGS)
  async getNearbyOrders(orderId: number) {
    console.log(`--- DEBUG LOGÍSTICA: Buscando vizinhos para o Pedido #${orderId} ---`);

    const targetOrder = await this.findOne(orderId);
    
    // Se não for delivery ou não tiver endereço, não tem vizinhos
    if (!targetOrder || targetOrder.type !== OrderType.DELIVERY || !targetOrder.address) {
      console.log('-> Pedido alvo não é delivery ou não tem endereço.');
      return [];
    }

    const neighborhood = targetOrder.address.neighborhood;
    console.log(`-> Bairro Alvo: "${neighborhood}"`);
    
    // Busca pedidos que:
    // 1. Estão prontos para entrega (READY_FOR_PICKUP)
    // 2. São do tipo Delivery
    // 3. São do MESMO bairro
    // 4. Ainda NÃO têm motoboy (driver is null)
    // 5. NÃO são o próprio pedido alvo
    const nearbyOrders = await this.orderRepository.find({
      where: {
        status: OrderStatus.READY_FOR_PICKUP,
        type: OrderType.DELIVERY,
        address: { neighborhood: neighborhood }, 
        driver: IsNull(), 
        id: Not(orderId) 
      },
      relations: ['address', 'user'],
    });

    console.log(`-> Encontrados: ${nearbyOrders.length} vizinhos disponíveis.`);
    if (nearbyOrders.length > 0) {
       // CORREÇÃO: Usando ?. para evitar erro caso address seja null
       nearbyOrders.forEach(o => console.log(`   * Pedido #${o.id} - ${o.address?.neighborhood}`));
    }

    return nearbyOrders;
  }

  // --- DASHBOARD (BI) ---
  async getDashboardSummary() {
    const totalOrders = await this.orderRepository.count({
      where: { 
        status: Not(OrderStatus.CANCELED)
      }
    });

    // Soma total de pedidos não cancelados
    const revenueQuery = await this.orderRepository
      .createQueryBuilder('order')
      .select('SUM(order.total_price)', 'total')
      .where('order.status != :st', { st: OrderStatus.CANCELED })
      .getRawOne();
    
    const revenue = revenueQuery && revenueQuery.total ? parseFloat(revenueQuery.total) : 0;

    const pendingOrders = await this.orderRepository.count({ where: { status: OrderStatus.PENDING } });
    const preparingOrders = await this.orderRepository.count({ where: { status: OrderStatus.PREPARING } });
    
    // Pedidos ativos com pagamento pendente
    const pendingPayments = await this.orderRepository.count({ 
      where: { 
        payment_status: PaymentStatus.PENDING,
        status: Not(OrderStatus.CANCELED)
      } 
    });

    return {
      totalOrders,
      revenue,
      pendingOrders,
      preparingOrders,
      pendingPayments
    };
  }

  // Gráficos para o Admin
  async getChartData() {
    // Últimos 7 dias
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const orders = await this.orderRepository.find({
      where: { 
        created_at: MoreThanOrEqual(sevenDaysAgo),
        status: Not(OrderStatus.CANCELED) 
      },
      relations: ['items', 'items.product'],
      order: { created_at: 'ASC' }
    });

    // Inicializa datas com 0
    const salesByDate: Record<string, number> = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
      salesByDate[key] = 0;
    }

    const topProducts: Record<string, number> = {};

    orders.forEach(order => {
      const dateKey = new Date(order.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
      
      // Soma Receita
      if (salesByDate[dateKey] !== undefined) {
        salesByDate[dateKey] += Number(order.total_price);
      }

      // Soma Produtos
      order.items.forEach(item => {
        const prodName = item.product?.name || 'Item Removido';
        topProducts[prodName] = (topProducts[prodName] || 0) + item.quantity;
      });
    });

    // Formata para o Front (Recharts, ApexCharts, etc)
    const revenueChart = Object.entries(salesByDate)
      .map(([date, total]) => ({ date, total }));
      
    const productsChart = Object.entries(topProducts)
      .map(([name, quantity]) => ({ name, quantity }))
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 5); // Top 5
      
    return { revenueChart, productsChart };
  }
}