import { 
  Controller, Get, Post, Body, Patch, Param, Delete, 
  UseGuards, ParseIntPipe, UseInterceptors, UploadedFile, Request, UnauthorizedException
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { AuthGuard } from '@nestjs/passport';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { OptimizeImagePipe } from '../common/pipes/optimize-image.pipe'; // <--- IMPORT NOVO

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('trash')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  findDeleted() {
    return this.usersService.findDeleted();
  }

  @Patch(':id/restore')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  restore(@Param('id', ParseIntPipe) id: number) {
    return this.usersService.restore(id);
  }

  @Post()
  @UseInterceptors(FileInterceptor('file')) // <--- Removemos diskStorage e config manual
  create(
    @Body() createUserDto: CreateUserDto,
    @UploadedFile(OptimizeImagePipe) file?: Express.Multer.File // <--- Pipe aqui
  ) {
    if (file) {
      // O Pipe converte para WebP e define o filename correto
      (createUserDto as any).avatar = `/uploads/${file.filename}`;
    }
    return this.usersService.create(createUserDto);
  }

  @Get()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  findAll() {
    return this.usersService.findAll();
  }

  @Get(':id')
  @UseGuards(AuthGuard('jwt'))
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.usersService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(AuthGuard('jwt'))
  @UseInterceptors(FileInterceptor('file')) // <--- Removemos diskStorage
  update(
    @Param('id', ParseIntPipe) id: number, 
    @Body() updateUserDto: UpdateUserDto,
    @UploadedFile(OptimizeImagePipe) file?: Express.Multer.File // <--- Pipe aqui
  ) {
    if (file) {
      (updateUserDto as any).avatar = `/uploads/${file.filename}`;
    }
    return this.usersService.update(id, updateUserDto);
  }

  @Delete(':id')
  @UseGuards(AuthGuard('jwt'))
  remove(@Param('id', ParseIntPipe) id: number, @Request() req) {
    if (req.user.role === 'ADMIN' || req.user.id === id) {
       return this.usersService.remove(id);
    }
    throw new UnauthorizedException('Você não tem permissão para realizar esta ação.');
  }

  @Delete(':id/permanent')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('ADMIN')
  removePermanent(@Param('id', ParseIntPipe) id: number) {
    return this.usersService.hardDelete(id);
  }
}