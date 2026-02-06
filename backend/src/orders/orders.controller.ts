import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Request } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { AuthGuard } from '@nestjs/passport';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  @UseGuards(AuthGuard('jwt')) // <--- Só logado faz pedido
  create(@Body() createOrderDto: CreateOrderDto, @Request() req) {
    // req.user vem do Token JWT (o ID do usuário está lá)
    return this.ordersService.create(createOrderDto, req.user.id);
  }

  @Get()
  @UseGuards(AuthGuard('jwt'))
  findAll() {
    return this.ordersService.findAll();
  }

  @Get(':id')
  @UseGuards(AuthGuard('jwt'))
  findOne(@Param('id') id: string) {
    return this.ordersService.findOne(+id);
  }
}