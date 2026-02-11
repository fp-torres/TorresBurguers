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
    // --- TRAVA DE SEGURANÇA ---
    // Impede que Admin ou Funcionário criem pedidos para si mesmos
    if (req.user.role !== 'CLIENT') {
      throw new ForbiddenException('Administradores e Funcionários não podem realizar pedidos pelo sistema.');
    }

    return this.ordersService.create(createOrderDto, req.user.id);
  }

  // --- ROTA DEDICADA: HISTÓRICO PESSOAL (BLINDADA) ---
  @Get('my-orders')
  @UseGuards(AuthGuard('jwt'))
  findMyOrders(@Request() req) {
    return this.ordersService.findMyOrders(req.user.id);
  }

  // --- DADOS PARA O DASHBOARD (GRÁFICOS) ---
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

  // --- ROTA GERAL (DASHBOARD DO ADMIN) ---
  @Get()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN') 
  findAll() {
    return this.ordersService.findAll();
  }

  @Get(':id')
  @UseGuards(AuthGuard('jwt'))
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.ordersService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  update(@Param('id', ParseIntPipe) id: number, @Body() updateOrderDto: UpdateOrderDto) {
    return this.ordersService.update(id, updateOrderDto);
  }
}