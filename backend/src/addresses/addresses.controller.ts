import { 
  Controller, Get, Post, Body, Patch, Param, Delete, 
  UseGuards, Request, ParseIntPipe 
} from '@nestjs/common';
import { AddressesService } from './addresses.service';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('addresses')
@ApiBearerAuth()
@Controller('addresses')
export class AddressesController {
  constructor(private readonly addressesService: AddressesService) {}

  // --- NOVA ROTA: Busca de CEP (Proxy) ---
  // Não usa @UseGuards porque pode ser usado no cadastro antes de logar
  @Get('cep/:cep')
  findCep(@Param('cep') cep: string) {
    return this.addressesService.findCep(cep);
  }

  @Post()
  @UseGuards(AuthGuard('jwt'))
  create(@Body() createAddressDto: CreateAddressDto, @Request() req) {
    return this.addressesService.create(createAddressDto, req.user.id);
  }

  @Get()
  @UseGuards(AuthGuard('jwt'))
  findAll(@Request() req) {
    return this.addressesService.findAll(req.user.id);
  }

  @Get(':id')
  @UseGuards(AuthGuard('jwt'))
  findOne(@Param('id', ParseIntPipe) id: number, @Request() req) {
    return this.addressesService.findOne(id, req.user.id);
  }

  @Patch(':id')
  @UseGuards(AuthGuard('jwt'))
  update(
    @Param('id', ParseIntPipe) id: number, 
    @Body() updateAddressDto: UpdateAddressDto,
    @Request() req
  ) {
    return this.addressesService.update(id, updateAddressDto, req.user.id);
  }

  @Delete(':id')
  @UseGuards(AuthGuard('jwt'))
  remove(@Param('id', ParseIntPipe) id: number, @Request() req) {
    return this.addressesService.remove(id, req.user.id);
  }
}