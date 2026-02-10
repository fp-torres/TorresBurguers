import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class UpdateStoreDto {
  @IsBoolean()
  is_open: boolean;

  @IsOptional()
  @IsString()
  opening_message?: string;

  @IsOptional()
  @IsString()
  closing_message?: string;
}