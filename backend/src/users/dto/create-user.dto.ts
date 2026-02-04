import { IsEmail, IsEnum, IsString, MinLength } from 'class-validator';
import { UserRole } from '../entities/user.entity';

export class CreateUserDto {
  @IsString()
  name: string;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(4, { message: 'A senha deve ter no mínimo 4 caracteres' })
  password: string;

  @IsEnum(UserRole)
  role: UserRole; // 'ADMIN' ou 'CLIENT'
}