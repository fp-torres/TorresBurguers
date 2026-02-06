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
    order.user = { id: userId } as User; // Associa ao usuário logado
    order.status = OrderStatus.PENDING;
    order.items = [];
    order.total_price = 0;
    order.payment_method = 'PIX'; // Fixo por enquanto, depois mudamos

    // 1. Busca todos os produtos do pedido no banco
    const productIds = createOrderDto.items.map((item) => item.productId);
    const products = await this.productRepository.findBy({
      id: In(productIds),
    });

    // 2. Monta os itens do pedido e calcula o total
    for (const itemDto of createOrderDto.items) {
      const product = products.find((p) => p.id === itemDto.productId);
      
      if (!product) {
        throw new NotFoundException(`Produto com ID ${itemDto.productId} não encontrado`);
      }

      const orderItem = new OrderItem();
      orderItem.product = product;
      orderItem.quantity = itemDto.quantity;
      orderItem.observation = itemDto.observation || '';
      
      // Adiciona ao pedido
      order.items.push(orderItem);
      
      // Soma ao total (Preço x Quantidade)
      order.total_price += Number(product.price) * itemDto.quantity;
    }

    // 3. Salva o pedido (o TypeORM salva os itens automaticamente por causa do cascade)
    return this.orderRepository.save(order);
  }

  async findAll() {
    // Retorna pedidos trazendo os Itens, os Produtos e os Dados do Usuário
    return this.orderRepository.find({
      relations: ['items', 'items.product', 'user'],
      order: { created_at: 'DESC' }
    });
  }

  findOne(id: number) {
    return this.orderRepository.findOne({
      where: { id },
      relations: ['items', 'items.product', 'user'],
    });
  }

  async update(id: number, updateOrderDto: any) { // Usamos any no DTO temporariamente para simplificar
    const order = await this.findOne(id);
    
    if (!order) {
       // O findOne já lança erro se não achar, mas é bom garantir
       throw new NotFoundException(`Pedido ${id} não encontrado`);
    }

    // Atualiza apenas os campos enviados
    this.orderRepository.merge(order, updateOrderDto);
    
    return this.orderRepository.save(order);
  }
}