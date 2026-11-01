import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';
import { NormalizeEmail } from '../../users/dto/transforms';

export const TEST_EMAIL_INVALID_MESSAGE =
  'Informe um e-mail válido para o teste.';

/**
 * POST /platform/settings/test-email: destinatário do e-mail de teste (auditado e limitado). O IsEmail
 * já limita o tamanho do endereço (até 254 caracteres; 64 antes do @).
 */
export class SendTestEmailDto {
  @ApiProperty({
    example: 'ops@suaempresa.com.br',
    description:
      'Destinatário do e-mail de teste (sai pelo driver configurado em MAIL_DRIVER).',
  })
  @NormalizeEmail()
  @IsEmail({}, { message: TEST_EMAIL_INVALID_MESSAGE })
  to: string;
}
