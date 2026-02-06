import { IsString, IsNotEmpty, Length, IsOptional, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateAddressDto {
  @ApiProperty({ example: 'Casa' })
  @IsString()
  @IsOptional()
  nickname?: string;

  @ApiProperty({ example: '22000-000' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{5}-\d{3}$|^\d{8}$/, { message: 'CEP inválido (Use 12345-678 ou 12345678)' })
  zipCode: string;

  @ApiProperty({ example: 'Av. Atlântica' })
  @IsString()
  @IsNotEmpty()
  street: string;

  @ApiProperty({ example: '1500' })
  @IsString()
  @IsNotEmpty()
  number: string;

  @ApiProperty({ example: 'Apto 202' })
  @IsString()
  @IsOptional()
  complement?: string;

  @ApiProperty({ example: 'Copacabana' })
  @IsString()
  @IsNotEmpty()
  neighborhood: string;

  @ApiProperty({ example: 'Rio de Janeiro' })
  @IsString()
  @IsNotEmpty()
  city: string;

  @ApiProperty({ example: 'RJ' })
  @IsString()
  @Length(2, 2, { message: 'O estado deve ter 2 letras (ex: RJ)' })
  state: string;
}