import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
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

    const products = await this.productRepository.findBy({ id: In(createOrderDto.items.map(i => i.productId)) });

    for (const itemDto of createOrderDto.items) {
      const product = products.find(p => p.id === itemDto.productId);
      if (!product) continue;

      const orderItem = new OrderItem();
      orderItem.product = product;
      orderItem.quantity = itemDto.quantity;
      orderItem.observation = itemDto.observation || '';
      
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

  // --- BUSCAR PEDIDOS (COM FILTRO DE CLIENTE) ---
  async findAll(user: any) {
    const options = {
      // Carrega todas as relações necessárias para o histórico (itens, produtos, adicionais)
      relations: ['items', 'items.product', 'items.addons', 'user', 'address'], 
      order: { created_at: 'DESC' } as any,
    };

    if (user.role === 'CLIENT') {
      // Filtra apenas os pedidos DO PRÓPRIO CLIENTE
      return this.orderRepository.find({
        ...options,
        where: { user: { id: user.id } },
      });
    }

    // Se for ADMIN, retorna todos
    return this.orderRepository.find(options);
  }

  findOne(id: number) {
    return this.orderRepository.findOne({
      where: { id },
      relations: ['items', 'items.product', 'items.addons', 'user', 'address'],
    });
  }

  async update(id: number, updateOrderDto: UpdateOrderDto) {
    const order = await this.findOne(id);
    if (!order) throw new NotFoundException(`Pedido ${id} não encontrado`);
    
    this.orderRepository.merge(order, updateOrderDto);
    return this.orderRepository.save(order);
  }

  async getDashboardSummary() {
    const totalOrders = await this.orderRepository.count();
    const revenueQuery = await this.orderRepository.createQueryBuilder('order').select('SUM(order.total_price)', 'total').where('order.status != :st', { st: OrderStatus.CANCELED }).getRawOne();
    return {
      totalOrders, revenue: Number(revenueQuery.total) || 0,
      pendingOrders: await this.orderRepository.count({ where: { status: OrderStatus.PENDING } }),
      preparingOrders: await this.orderRepository.count({ where: { status: OrderStatus.PREPARING } }),
      pendingPayments: await this.orderRepository.count({ where: { payment_status: PaymentStatus.PENDING } })
    };
  }
}