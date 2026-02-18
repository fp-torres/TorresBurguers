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
  @MinLength(10, { message: 'O telefone deve ter pelo menos 10 dígitos (DDD + Número)' })
  phone?: string;

  @ApiProperty({ example: 'SenhaForte123!', minLength: 9 })
  @IsString()
  @MinLength(9, { message: 'A senha deve ter no mínimo 9 caracteres' })
  // Regex: Pelo menos 1 maiúscula, E (1 número OU 1 símbolo)
  @Matches(/((?=.*\d)|(?=.*\W+))(?![.\n])(?=.*[A-Z]).*$/, { 
    message: 'A senha deve conter pelo menos uma letra maiúscula e um número ou símbolo.' 
  })
  password: string;

  @ApiProperty({ enum: UserRole, default: UserRole.CLIENT, required: false })
  @IsEnum(UserRole)
  @IsOptional()
  role?: UserRole; 
}