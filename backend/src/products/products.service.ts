import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { Product } from './entities/product.entity';

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private productRepository: Repository<Product>,
  ) {}

  create(createProductDto: CreateProductDto) {
    const product = this.productRepository.create(createProductDto);
    return this.productRepository.save(product);
  }

  findAll() {
    // Retorna todos (o frontend pode filtrar se quiser mostrar só os ativos)
    return this.productRepository.find();
  }

  findOne(id: number) {
    return this.productRepository.findOneBy({ id });
  }

  update(id: number, updateProductDto: UpdateProductDto) {
    return this.productRepository.update(id, updateProductDto);
  }

  async remove(id: number) {
    try {
      // 1. TENTA APAGAR FISICAMENTE
      // Se o produto foi criado errado e nunca vendido, ele será apagado do banco.
      return await this.productRepository.delete(id);
    } catch (error) {
      // 2. SE DER ERRO (Proteção de Chave Estrangeira / Pedidos Existentes)
      console.log(`Erro ao deletar produto ${id}. Motivo: Vendas vinculadas. Arquivando...`);
      
      // Ao invés de apagar, atualizamos para INDISPONÍVEL
      // Isso faz ele sumir do cardápio do cliente, mas mantém no histórico do admin
      return await this.productRepository.update(id, { available: false });
    }
  }
}