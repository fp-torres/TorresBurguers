import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import { emptyToNull, toBoolean, toNumber } from '../../common/transforms';
import {
  IsNumberInRange,
  IsText,
  MAX_DB_INT,
  type NumberRules,
} from '../../common/validators';
import {
  AUDIT_ACTION_PATTERN,
  INSTANT_FORMAT_HINT,
  INSTANT_PATTERN,
} from '../platform-filters';
import {
  CUSTOM_DOMAIN_FORMAT_MESSAGE,
  customDomainError,
  SLUG_FORMAT_MESSAGE,
  storeSlugError,
} from '../store-identity-rules';

/**
 * Validadores e conversores dos DTOs do superpainel. Listas fechadas (situações, ordenação) são
 * validadas por lista de permitidos; cada problema gera UMA mensagem em português.
 */

/** Endereço da loja (slug): formato do roteamento e fora da lista de reservados. */
export function IsStoreSlug(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isStoreSlug',
      target: target.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate: (value: unknown) => storeSlugError(value) === null,
        defaultMessage: ({ value }: ValidationArguments) =>
          storeSlugError(value) ?? SLUG_FORMAT_MESSAGE,
      },
    });
  };
}

/**
 * Objeto aninhado (com @ValidateNested + @Type): recusa listas, inclusive vazias. O @ValidateNested
 * do class-validator valida listas item a item, então sem isto `owner: []` chegaria ao serviço como
 * array (500). Ausente fica para o @IsDefined (uma mensagem só).
 */
export function IsNestedObject(
  message: string,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isNestedObject',
      target: target.constructor,
      propertyName: propertyName as string,
      options: { ...validationOptions, message },
      validator: {
        validate: (value: unknown) =>
          value === undefined ||
          (value !== null &&
            typeof value === 'object' &&
            !Array.isArray(value)),
      },
    });
  };
}

/** Domínio próprio (hostname sem protocolo, porta ou caminho). */
export function IsCustomDomain(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isCustomDomain',
      target: target.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate: (value: unknown) => customDomainError(value) === null,
        defaultMessage: ({ value }: ValidationArguments) =>
          customDomainError(value) ?? CUSTOM_DOMAIN_FORMAT_MESSAGE,
      },
    });
  };
}

export interface TextLengthRules {
  min: number;
  max: number;
  required: string;
  invalid: string;
  tooShort: string;
  tooLong: string;
}

/** Texto com tamanho mínimo e máximo, com UMA mensagem por problema. */
export function IsTextLength(
  rules: TextLengthRules,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isTextLength',
      target: target.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' &&
          value.length >= rules.min &&
          value.length <= rules.max,
        defaultMessage: ({ value }: ValidationArguments) => {
          if (value === undefined || value === null || value === '') {
            return rules.required;
          }
          if (typeof value !== 'string') return rules.invalid;
          return value.length < rules.min ? rules.tooShort : rules.tooLong;
        },
      },
    });
  };
}

/** Regras de um id (coluna integer do PostgreSQL). */
export function idRules(field: string): NumberRules {
  return {
    min: 1,
    max: MAX_DB_INT,
    integer: true,
    invalid: `${field} deve ser um id válido (número inteiro positivo).`,
  };
}

/** ?campo=12 opcional na query (vazio = ausente). */
export const OptionalQueryId = (field: string) =>
  applyDecorators(
    Transform(({ value }) => toNumber(value) ?? undefined),
    IsOptional(),
    IsNumberInRange(idRules(field)),
  );

/** ?campo=true|false opcional na query (aceita também 1/0, sim/não). */
export const OptionalQueryBoolean = (field: string) =>
  applyDecorators(
    Transform(({ value }) => toBoolean(value) ?? undefined),
    IsOptional(),
    IsBoolean({ message: `${field} deve ser true ou false.` }),
  );

/** Valor de uma lista fechada, sem diferenciar maiúsculas (normalizado para a caixa da lista). */
export const OptionalQueryChoice = (
  values: readonly string[],
  message: string,
  casing: 'upper' | 'lower' = 'upper',
) =>
  applyDecorators(
    Transform(({ value }) => {
      const text = emptyToNull(value);
      if (typeof text !== 'string') return text ?? undefined;
      return casing === 'upper' ? text.toUpperCase() : text.toLowerCase();
    }),
    IsOptional(),
    IsIn(values, { message }),
  );

/** Data AAAA-MM-DD ou data e hora ISO 8601 com fuso (filtros de auditoria). */
export const OptionalQueryInstant = (field: string) =>
  applyDecorators(
    Transform(({ value }) => emptyToNull(value) ?? undefined),
    IsOptional(),
    IsText({
      maxLength: 40,
      pattern: INSTANT_PATTERN,
      invalid: `${field} inválido: ${INSTANT_FORMAT_HINT}.`,
      tooLong: `${field} inválido: ${INSTANT_FORMAT_HINT}.`,
    }),
  );

/** Data do calendário AAAA-MM-DD (relatórios e financeiro). */
export const OptionalQueryDate = (field: string) =>
  applyDecorators(
    Transform(({ value }) => emptyToNull(value) ?? undefined),
    IsOptional(),
    IsText({
      maxLength: 10,
      pattern: /^\d{4}-\d{2}-\d{2}$/,
      invalid: `${field} deve ser uma data no formato AAAA-MM-DD.`,
      tooLong: `${field} deve ser uma data no formato AAAA-MM-DD.`,
    }),
  );

/** Tipo do alvo de uma ação da auditoria, ex.: user, store, subscription_invoice. */
export const OptionalQueryTargetType = () =>
  applyDecorators(
    Transform(({ value }) => {
      const text = emptyToNull(value);
      return typeof text === 'string'
        ? text.toLowerCase()
        : (text ?? undefined);
    }),
    IsOptional(),
    IsText({
      maxLength: 40,
      pattern: /^[a-z][a-z0-9_]{0,39}$/,
      invalid:
        'Tipo do alvo inválido: use letras minúsculas, números e "_" (ex.: user, store, subscription).',
      tooLong: 'O tipo do alvo pode ter no máximo 40 caracteres.',
    }),
  );

/** Identificador do alvo de uma ação da auditoria (texto: ids numéricos ou chaves). */
export const OptionalQueryTargetId = () =>
  applyDecorators(
    Transform(({ value }) => emptyToNull(value) ?? undefined),
    IsOptional(),
    IsText({
      maxLength: 64,
      pattern: /^[\w.:-]{1,64}$/,
      invalid:
        'Identificador do alvo inválido: use letras, números, ".", ":", "-" ou "_".',
      tooLong: 'O identificador do alvo pode ter no máximo 64 caracteres.',
    }),
  );

/** Nome de uma ação ou de um grupo da auditoria, ex.: platform.store ou auth.login.failure. */
export const OptionalQueryAction = () =>
  applyDecorators(
    Transform(({ value }) => {
      const text = emptyToNull(value);
      return typeof text === 'string'
        ? text.toLowerCase()
        : (text ?? undefined);
    }),
    IsOptional(),
    IsText({
      maxLength: 80,
      pattern: AUDIT_ACTION_PATTERN,
      invalid:
        'Ação inválida: use o nome da ação ou de um grupo (ex.: platform.store ou auth.login.failure).',
      tooLong: 'A ação pode ter no máximo 80 caracteres.',
    }),
  );
