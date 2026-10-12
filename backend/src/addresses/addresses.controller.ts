import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ParseIdPipe } from '../common/pipes/parse-id.pipe';
import { AddressesService } from './addresses.service';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';

/** Requisição autenticada: o JwtStrategy coloca o usuário logado em req.user. */
interface AuthenticatedRequest {
  user: { id: number };
}

@ApiTags('addresses')
@Controller('addresses')
export class AddressesController {
  constructor(private readonly addressesService: AddressesService) {}

  // Busca de CEP (proxy ViaCEP/BrasilAPI). Pública: usada também antes do login.
  @Get('cep/:cep')
  findCep(@Param('cep') cep: string) {
    return this.addressesService.findCep(cep);
  }

  // --- Endereços do usuário logado ---

  @Post()
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  create(
    @Body() createAddressDto: CreateAddressDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.addressesService.create(createAddressDto, req.user.id);
  }

  @Get()
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  findAll(@Request() req: AuthenticatedRequest) {
    return this.addressesService.findAll(req.user.id);
  }

  @Get(':id')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  findOne(
    @Param('id', ParseIdPipe) id: number,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.addressesService.findOne(id, req.user.id);
  }

  @Patch(':id')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  update(
    @Param('id', ParseIdPipe) id: number,
    @Body() updateAddressDto: UpdateAddressDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.addressesService.update(id, updateAddressDto, req.user.id);
  }

  @Delete(':id')
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  remove(
    @Param('id', ParseIdPipe) id: number,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.addressesService.remove(id, req.user.id);
  }
}
