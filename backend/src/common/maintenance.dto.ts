import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, ValidateBy, type ValidationArguments } from 'class-validator';
import type { UploadsCleanupMode } from './entities/maintenance-job.entity';
import { UPLOADS_CLEANUP_MODES } from './maintenance.uploads-cleanup';

export const CLEANUP_MODE_MESSAGE =
  'Informe o modo da limpeza: check (só verificar) ou delete (apagar os arquivos sem uso).';
export const CLEANUP_CONFIRM_MESSAGE =
  'Para apagar os arquivos sem uso, confirme com confirm: true.';
export const CLEANUP_CONFIRM_TYPE_MESSAGE = 'confirm deve ser true ou false.';

const isDeleteMode = (args?: ValidationArguments) =>
  (args?.object as Partial<StartUploadsCleanupDto> | undefined)?.mode ===
  'delete';

/** confirm: obrigatório e true no modo delete; opcional (true/false) no check. */
function IsCleanupConfirmation(): PropertyDecorator {
  return ValidateBy({
    name: 'isCleanupConfirmation',
    validator: {
      validate: (value: unknown, args?: ValidationArguments) =>
        isDeleteMode(args)
          ? value === true
          : value === undefined || typeof value === 'boolean',
      defaultMessage: (args?: ValidationArguments) =>
        isDeleteMode(args)
          ? CLEANUP_CONFIRM_MESSAGE
          : CLEANUP_CONFIRM_TYPE_MESSAGE,
    },
  });
}

/**
 * POST /platform/maintenance/cleanup-uploads: check só conta os arquivos sem uso (quantidade e
 * tamanho); delete os apaga e exige confirm: true (nada é apagado por engano, nem por um corpo vazio).
 */
export class StartUploadsCleanupDto {
  @ApiProperty({
    enum: UPLOADS_CLEANUP_MODES,
    example: 'check',
    description:
      'check = só relatório (nada é apagado); delete = apaga as imagens sem uso há mais de 24 h.',
  })
  @IsIn(UPLOADS_CLEANUP_MODES, { message: CLEANUP_MODE_MESSAGE })
  mode: UploadsCleanupMode;

  @ApiPropertyOptional({
    example: true,
    description: 'Obrigatório (true) no modo delete.',
  })
  @IsCleanupConfirmation()
  confirm?: boolean;
}
