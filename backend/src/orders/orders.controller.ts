import { 
  Controller, Get, Post, Body, Patch, Param, 
  UseGuards, Request, ParseIntPipe, ForbiddenException 
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto'; 
import { AuthGuard } from '@nestjs/passport';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  @UseGuards(AuthGuard('jwt')) 
  create(@Body() createOrderDto: CreateOrderDto, @Request() req) {
    if (req.user.role !== 'CLIENT') {
      throw new ForbiddenException('Administradores e Funcionários não podem realizar pedidos pelo sistema.');
    }
    return this.ordersService.create(createOrderDto, req.user.id);
  }

  @Get('my-orders')
  @UseGuards(AuthGuard('jwt'))
  findMyOrders(@Request() req) {
    return this.ordersService.findMyOrders(req.user.id);
  }

  // --- DASHBOARD (Financeiro) ---
  @Get('charts')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  getCharts() {
    return this.ordersService.getChartData();
  }

  @Get('summary')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  getSummary() {
    return this.ordersService.getDashboardSummary();
  }

  // --- LISTAR PEDIDOS GERAIS ---
  // Acessível para Admin, Cozinha e Motoboy
  @Get()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN', 'KITCHEN', 'COURIER') 
  findAll() {
    return this.ordersService.findAll();
  }

  @Get(':id')
  @UseGuards(AuthGuard('jwt'))
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.ordersService.findOne(id);
  }

  // Cancelamento pelo Cliente
  @Patch(':id/cancel')
  @UseGuards(AuthGuard('jwt'))
  async cancelMyOrder(@Param('id', ParseIntPipe) id: number, @Request() req) {
    return this.ordersService.cancelOrder(id, req.user);
  }

  // --- ATUALIZAR STATUS ---
  // Acessível para Admin, Cozinha e Motoboy
  @Patch(':id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN', 'KITCHEN', 'COURIER')
  update(@Param('id', ParseIntPipe) id: number, @Body() updateOrderDto: UpdateOrderDto) {
    return this.ordersService.update(id, updateOrderDto);
  }
}