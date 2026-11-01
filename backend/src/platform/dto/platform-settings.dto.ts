import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { toBoolean, toNumber } from '../../common/transforms';
import { IsNumberInRange, IsOptionalNotNull } from '../../common/validators';
import { idRules } from './platform-validators';

export const GRACE_PERIOD_DAYS_RANGE = { min: 0, max: 60 } as const;
export const SUPPORT_SESSION_MINUTES_RANGE = { min: 5, max: 240 } as const;

/** PATCH /platform/settings: envie só o que mudou (auditado). */
export class UpdatePlatformSettingsDto {
  @ApiPropertyOptional({
    example: 1,
    nullable: true,
    description:
      'Loja padrão das rotas antigas (app mobile e integrações): precisa existir e não estar desativada. null = nenhuma (as rotas antigas respondem 404). DEFAULT_STORE_SLUG, se definido no ambiente, tem prioridade.',
  })
  @Transform(({ value }) => toNumber(value))
  @IsOptional()
  @IsNumberInRange(idRules('default_store_id'))
  default_store_id?: number | null;

  @ApiPropertyOptional({
    example: 7,
    minimum: GRACE_PERIOD_DAYS_RANGE.min,
    maximum: GRACE_PERIOD_DAYS_RANGE.max,
    description:
      'Dias de tolerância da inadimplência antes da suspensão automática da assinatura.',
  })
  @Transform(({ value }) => toNumber(value))
  @IsOptionalNotNull()
  @IsNumberInRange({
    ...GRACE_PERIOD_DAYS_RANGE,
    integer: true,
    invalid: `grace_period_days deve ser um número inteiro de ${GRACE_PERIOD_DAYS_RANGE.min} a ${GRACE_PERIOD_DAYS_RANGE.max}.`,
  })
  grace_period_days?: number;

  @ApiPropertyOptional({
    example: 30,
    minimum: SUPPORT_SESSION_MINUTES_RANGE.min,
    maximum: SUPPORT_SESSION_MINUTES_RANGE.max,
    description: 'Duração das sessões de suporte (minutos).',
  })
  @Transform(({ value }) => toNumber(value))
  @IsOptionalNotNull()
  @IsNumberInRange({
    ...SUPPORT_SESSION_MINUTES_RANGE,
    integer: true,
    invalid: `support_session_minutes deve ser um número inteiro de ${SUPPORT_SESSION_MINUTES_RANGE.min} a ${SUPPORT_SESSION_MINUTES_RANGE.max}.`,
  })
  support_session_minutes?: number;

  @ApiPropertyOptional({
    example: false,
    description:
      'Cadastro de estabelecimentos pela página pública (POST /stores/signup). Exige self_signup_plan_id.',
  })
  @Transform(({ value }) => toBoolean(value))
  @IsOptionalNotNull()
  @IsBoolean({
    message: 'store_self_signup_enabled deve ser verdadeiro ou falso.',
  })
  store_self_signup_enabled?: boolean;

  @ApiPropertyOptional({
    example: 2,
    nullable: true,
    description:
      'Plano das lojas do autoatendimento: precisa estar disponível (ACTIVE) e público. null só com o autoatendimento desligado.',
  })
  @Transform(({ value }) => toNumber(value))
  @IsOptional()
  @IsNumberInRange(idRules('self_signup_plan_id'))
  self_signup_plan_id?: number | null;
}
