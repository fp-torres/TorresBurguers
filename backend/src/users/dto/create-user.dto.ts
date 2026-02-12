import { IsEmail, IsEnum, IsNotEmpty, IsOptional, IsString, MinLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '../entities/user.entity';

export class CreateUserDto {
  @ApiProperty({ example: 'Felipe Torres' })
  @IsString()
  @IsNotEmpty({ message: 'O nome é obrigatório' })
  name: string;

  @ApiProperty({ example: 'felipe@email.com' })
  @IsEmail({}, { message: 'Email inválido' })
  email: string;

  @ApiProperty({ example: '21999999999', required: false })
  @IsString()
  @IsOptional()
  // Valida se tem pelo menos 10 dígitos (considerando DDD) e permite caracteres de formatação
  // Ou usa uma regex para garantir formato, ou apenas verifica tamanho mínimo limpo
  @MinLength(10, { message: 'O telefone deve ter pelo menos 10 dígitos (DDD + Número)' })
  phone?: string;

  @ApiProperty({ example: '123456', minLength: 6 })
  @IsString()
  @MinLength(6, { message: 'A senha deve ter no mínimo 6 caracteres' })
  password: string;

  @ApiProperty({ enum: UserRole, default: UserRole.CLIENT, required: false })
  @IsEnum(UserRole)
  @IsOptional()
  role?: UserRole; 
}