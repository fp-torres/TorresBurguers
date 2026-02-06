import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { CreateOrderDto } from './dto/create-order.dto';
import { Order, OrderStatus } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { Product } from '../products/entities/product.entity';
import { User } from '../users/entities/user.entity';

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order)
    private orderRepository: Repository<Order>,
    @InjectRepository(Product)
    private productRepository: Repository<Product>,
  ) {}

  async create(createOrderDto: CreateOrderDto, userId: number) {
    const order = new Order();
    order.user = { id: userId } as User; 
    order.status = OrderStatus.PENDING;
    order.items = [];
    order.total_price = 0;
    order.payment_method = 'PIX';

    const productIds = createOrderDto.items.map((item) => item.productId);
    const products = await this.productRepository.findBy({
      id: In(productIds),
    });

    for (const itemDto of createOrderDto.items) {
      const product = products.find((p) => p.id === itemDto.productId);
      
      if (!product) {
        throw new NotFoundException(`Produto com ID ${itemDto.productId} não encontrado`);
      }

      const orderItem = new OrderItem();
      orderItem.product = product;
      orderItem.quantity = itemDto.quantity;
      orderItem.observation = itemDto.observation || '';
      
      order.items.push(orderItem);
      order.total_price += Number(product.price) * itemDto.quantity;
    }

    return this.orderRepository.save(order);
  }

  // --- ATUALIZADO: Filtro de Privacidade ---
  async findAll(user: any) {
    const options = {
      relations: ['items', 'items.product', 'user'],
      order: { created_at: 'DESC' } as any,
    };

    // Se for CLIENT, filtra para mostrar só os dele
    if (user.role === 'CLIENT') {
      return this.orderRepository.find({
        ...options,
        where: { user: { id: user.id } },
      });
    }

    // Se for ADMIN, mostra tudo
    return this.orderRepository.find(options);
  }

  // --- NOVO: Resumo Financeiro para o Dashboard ---
  async getDashboardSummary() {
    const totalOrders = await this.orderRepository.count();
    
    // Soma o total de vendas (excluindo cancelados)
    const revenueQuery = await this.orderRepository
      .createQueryBuilder('order')
      .select('SUM(order.total_price)', 'total')
      .where('order.status != :status', { status: OrderStatus.CANCELED }) 
      .getRawOne();

    const pendingOrders = await this.orderRepository.count({
      where: { status: OrderStatus.PENDING }
    });

    const preparingOrders = await this.orderRepository.count({
      where: { status: OrderStatus.PREPARING }
    });

    return {
      totalOrders,
      revenue: Number(revenueQuery.total) || 0,
      pendingOrders,
      preparingOrders
    };
  }
  // ----------------------------------------

  findOne(id: number) {
    return this.orderRepository.findOne({
      where: { id },
      relations: ['items', 'items.product', 'user'],
    });
  }

  async update(id: number, updateOrderDto: any) {
    const order = await this.findOne(id);
    
    if (!order) {
       throw new NotFoundException(`Pedido ${id} não encontrado`);
    }

    this.orderRepository.merge(order, updateOrderDto);
    return this.orderRepository.save(order);
  }
}