import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { CreateOrderDto } from './dto/create-order.dto';
import { Order, OrderStatus, OrderType } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { Product } from '../products/entities/product.entity';
import { User } from '../users/entities/user.entity';
import { Address } from '../addresses/entities/address.entity';

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order)
    private orderRepository: Repository<Order>,
    @InjectRepository(Product)
    private productRepository: Repository<Product>,
    @InjectRepository(Address) // <--- Injetamos o repositório de endereços
    private addressRepository: Repository<Address>,
  ) {}

  async create(createOrderDto: CreateOrderDto, userId: number) {
    const order = new Order();
    order.user = { id: userId } as User;
    order.status = OrderStatus.PENDING;
    order.items = [];
    order.total_price = 0;
    
    // 1. Recebe dados do DTO
    order.payment_method = createOrderDto.paymentMethod;
    order.type = createOrderDto.type;

    // 2. Lógica de Entrega vs Retirada
    if (order.type === OrderType.DELIVERY) {
      if (!createOrderDto.addressId) {
        throw new BadRequestException('Para entrega, o ID do endereço é obrigatório.');
      }

      // Busca o endereço e garante que pertence ao usuário logado (Segurança)
      const address = await this.addressRepository.findOne({
        where: { id: createOrderDto.addressId, user: { id: userId } },
      });

      if (!address) {
        throw new NotFoundException('Endereço não encontrado ou não pertence a este usuário.');
      }

      order.address = address;
      order.delivery_fee = 5.00; // Taxa fixa (Simulação)
    } else {
      // Se for Retirada (TAKEOUT)
      order.address = null;
      order.delivery_fee = 0;
    }

    // 3. Busca Produtos
    const productIds = createOrderDto.items.map((item) => item.productId);
    const products = await this.productRepository.findBy({
      id: In(productIds),
    });

    // 4. Monta os Itens e Calcula Total dos Produtos
    for (const itemDto of createOrderDto.items) {
      const product = products.find((p) => p.id === itemDto.productId);
      
      if (!product) {
        throw new NotFoundException(`Produto ID ${itemDto.productId} não encontrado`);
      }

      const orderItem = new OrderItem();
      orderItem.product = product;
      orderItem.quantity = itemDto.quantity;
      orderItem.observation = itemDto.observation || '';
      
      order.items.push(orderItem);
      order.total_price += Number(product.price) * itemDto.quantity;
    }

    // 5. Soma o Frete ao Total Final
    order.total_price += order.delivery_fee;

    return this.orderRepository.save(order);
  }

  async findAll(user: any) {
    const options = {
      // Adicionei 'address' nas relações para o Admin saber onde entregar
      relations: ['items', 'items.product', 'user', 'address'], 
      order: { created_at: 'DESC' } as any,
    };

    if (user.role === 'CLIENT') {
      return this.orderRepository.find({
        ...options,
        where: { user: { id: user.id } },
      });
    }

    return this.orderRepository.find(options);
  }

  async getDashboardSummary() {
    const totalOrders = await this.orderRepository.count();
    
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

  findOne(id: number) {
    return this.orderRepository.findOne({
      where: { id },
      relations: ['items', 'items.product', 'user', 'address'], // Traz endereço no detalhe
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