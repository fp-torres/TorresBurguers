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
    // Bloqueia Admin/Funcionario de fazer pedido como se fosse cliente na loja (regra de negócio)
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

  // --- LOGÍSTICA & ENTREGAS (NOVAS ROTAS) ---

  // 1. Listar Motoboys Disponíveis
  @Get('drivers/list')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  getDrivers() {
    return this.ordersService.getAvailableDrivers();
  }

  // 2. Sugestão de Pedidos Próximos (Para agrupar entregas)
  @Get(':id/nearby')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  getNearbyOrders(@Param('id', ParseIntPipe) id: number) {
    return this.ordersService.getNearbyOrders(id);
  }

  // 3. Atribuir Motoboy ao Pedido
  @Patch(':id/assign')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  assignDriver(
    @Param('id', ParseIntPipe) id: number, 
    @Body('driverId', ParseIntPipe) driverId: number
  ) {
    return this.ordersService.assignDriver(id, driverId);
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

  // --- ATUALIZAR STATUS (Genérico) ---
  @Patch(':id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN', 'KITCHEN', 'COURIER')
  update(@Param('id', ParseIntPipe) id: number, @Body() updateOrderDto: UpdateOrderDto) {
    return this.ordersService.update(id, updateOrderDto);
  }
}