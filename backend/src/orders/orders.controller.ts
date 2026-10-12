import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { OrdersService } from './orders.service';
import { CreateOrderDto, QuoteOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order.dto';
import { AssignDriverDto } from './dto/assign-driver.dto';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { ClientOnlyGuard } from './client-only.guard';
import { ParseIdPipe } from '../common/pipes/parse-id.pipe';
import {
  ORDER_MANAGER_ROLES,
  STAFF_ROLES,
  parseOrdersScope,
} from './order-rules';
import type { OrderActor } from './order-rules';

type ActorRequest = { user: OrderActor };

@ApiTags('Pedidos')
@ApiBearerAuth()
@Controller('orders')
@UseGuards(AuthGuard('jwt'))
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  // --- CLIENTE ---

  // Orçamento calculado no servidor (subtotal, taxa de entrega, total, tempo estimado)
  @Post('quote')
  @HttpCode(200)
  @UseGuards(ClientOnlyGuard)
  quote(@Body() dto: QuoteOrderDto, @Request() req: ActorRequest) {
    return this.ordersService.quote(dto, req.user);
  }

  @Post()
  @UseGuards(ClientOnlyGuard)
  create(@Body() dto: CreateOrderDto, @Request() req: ActorRequest) {
    return this.ordersService.create(dto, req.user);
  }

  @Get('my-orders')
  findMyOrders(@Request() req: ActorRequest) {
    return this.ordersService.findMyOrders(req.user.id);
  }

  // --- LOGÍSTICA (Administrador e Atendente) ---

  @Get('drivers/list')
  @UseGuards(RolesGuard)
  @Roles(...ORDER_MANAGER_ROLES)
  getDrivers() {
    return this.ordersService.getAvailableDrivers();
  }

  // --- DASHBOARD (somente Administrador) ---

  @Get('charts')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  getCharts() {
    return this.ordersService.getChartData();
  }

  @Get('summary')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  getSummary() {
    return this.ordersService.getDashboardSummary();
  }

  // --- PEDIDOS (equipe) ---

  // ?scope=active (quadros da equipe): em andamento, finalizados nas últimas 24 h e estornos pendentes.
  // Sem scope: todos.
  @Get()
  @UseGuards(RolesGuard)
  @Roles(...STAFF_ROLES)
  findAll(@Query('scope') rawScope?: string) {
    const scope = parseOrdersScope(rawScope);
    if (!scope)
      throw new BadRequestException(
        'scope inválido. Use scope=active ou omita o parâmetro.',
      );
    return this.ordersService.findAll(scope);
  }

  @Get(':id/nearby')
  @UseGuards(RolesGuard)
  @Roles(...ORDER_MANAGER_ROLES)
  getNearbyOrders(@Param('id', ParseIdPipe) id: number) {
    return this.ordersService.getNearbyOrders(id);
  }

  @Patch(':id/assign')
  @UseGuards(RolesGuard)
  @Roles(...ORDER_MANAGER_ROLES)
  assignDriver(
    @Param('id', ParseIdPipe) id: number,
    @Body() dto: AssignDriverDto,
  ) {
    return this.ordersService.assignDriver(id, dto.driverId);
  }

  // Cliente (dono, enquanto PENDING) ou Administrador/Atendente
  @Patch(':id/cancel')
  cancel(@Param('id', ParseIdPipe) id: number, @Request() req: ActorRequest) {
    return this.ordersService.cancel(id, req.user);
  }

  // Dono do pedido ou equipe
  @Get(':id')
  findOne(@Param('id', ParseIdPipe) id: number, @Request() req: ActorRequest) {
    return this.ordersService.findOneFor(id, req.user);
  }

  // Somente { status }, conforme o perfil (ver checkStatusChange)
  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(...STAFF_ROLES)
  updateStatus(
    @Param('id', ParseIdPipe) id: number,
    @Body() dto: UpdateOrderStatusDto,
    @Request() req: ActorRequest,
  ) {
    return this.ordersService.updateStatus(id, dto.status, req.user);
  }
}
