import { 
  Controller, Get, Post, Body, Patch, Param, 
  UseGuards, Request, ParseIntPipe 
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto'; 
import { AuthGuard } from '@nestjs/passport';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  @UseGuards(AuthGuard('jwt')) 
  create(@Body() createOrderDto: CreateOrderDto, @Request() req) {
    // req.user vem do JWT decodificado
    return this.ordersService.create(createOrderDto, req.user.id);
  }

  // --- ROTA DE DASHBOARD (Resumo Financeiro) ---
  // IMPORTANTE: Esta rota deve vir ANTES de rotas com :id
  @Get('summary')
  @UseGuards(AuthGuard('jwt'))
  getSummary() {
    return this.ordersService.getDashboardSummary();
  }
  // ---------------------------------------------

  @Get()
  @UseGuards(AuthGuard('jwt'))
  findAll(@Request() req) {
    return this.ordersService.findAll(req.user);
  }

  @Get(':id')
  @UseGuards(AuthGuard('jwt'))
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.ordersService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(AuthGuard('jwt'))
  update(@Param('id', ParseIntPipe) id: number, @Body() updateOrderDto: UpdateOrderDto) {
    return this.ordersService.update(id, updateOrderDto);
  }
}