import { 
  Controller, Get, Post, Body, Patch, Param, Delete, 
  UseGuards, Request, ParseIntPipe 
} from '@nestjs/common';
import { AddressesService } from './addresses.service';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('addresses') // Organiza no Swagger
@ApiBearerAuth()      // Mostra o cadeado no Swagger
@Controller('addresses')
@UseGuards(AuthGuard('jwt')) // Protege TODAS as rotas
export class AddressesController {
  constructor(private readonly addressesService: AddressesService) {}

  @Post()
  create(@Body() createAddressDto: CreateAddressDto, @Request() req) {
    return this.addressesService.create(createAddressDto, req.user.id);
  }

  @Get()
  findAll(@Request() req) {
    return this.addressesService.findAll(req.user.id);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number, @Request() req) {
    return this.addressesService.findOne(id, req.user.id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number, 
    @Body() updateAddressDto: UpdateAddressDto,
    @Request() req
  ) {
    return this.addressesService.update(id, updateAddressDto, req.user.id);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @Request() req) {
    return this.addressesService.remove(id, req.user.id);
  }
}