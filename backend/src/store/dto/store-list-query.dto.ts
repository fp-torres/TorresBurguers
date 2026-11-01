import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional } from 'class-validator';
import { emptyToNull, toNumber } from '../../common/transforms';
import { IsNumberInRange, IsText } from '../../common/validators';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
/** Evita OFFSET gigantes (varredura inteira da tabela) com páginas impossíveis. */
const MAX_PAGE = 100_000;

/** ?search=&page=&pageSize= das listas paginadas da loja e do diretório público. */
export class StoreListQueryDto {
  @ApiPropertyOptional({
    example: 'maria',
    maxLength: 100,
    description: 'Busca por parte do nome (e de outros campos de texto).',
  })
  @Transform(({ value }) => emptyToNull(value) ?? undefined)
  @IsOptional()
  @IsText({
    maxLength: 100,
    invalid: 'A busca deve ser um texto.',
    tooLong: 'A busca pode ter no máximo 100 caracteres.',
  })
  search?: string;

  @ApiPropertyOptional({ example: 1, minimum: 1, default: 1 })
  @Transform(({ value }) => toNumber(value) ?? undefined)
  @IsOptional()
  @IsNumberInRange({
    min: 1,
    max: MAX_PAGE,
    integer: true,
    invalid: 'page deve ser um número inteiro a partir de 1.',
  })
  page?: number;

  @ApiPropertyOptional({
    example: DEFAULT_PAGE_SIZE,
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: DEFAULT_PAGE_SIZE,
    description: `Itens por página (valores acima de ${MAX_PAGE_SIZE} usam ${MAX_PAGE_SIZE}).`,
  })
  @Transform(({ value }) => toNumber(value) ?? undefined)
  @IsOptional()
  @IsNumberInRange({
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    integer: true,
    invalid: 'pageSize deve ser um número inteiro a partir de 1.',
  })
  pageSize?: number;
}

export interface PageRequest {
  search: string | null;
  page: number;
  pageSize: number;
  offset: number;
}

/** Página efetiva: padrão 1 × 20, no máximo 100 itens por página. */
export function pageRequest(query: StoreListQueryDto = {}): PageRequest {
  const page = query.page ?? 1;
  const pageSize = Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  return {
    search: query.search?.trim() || null,
    page,
    pageSize,
    offset: (page - 1) * pageSize,
  };
}

/** Termo para ILIKE com %, _ e \ escapados (a busca é por "contém", nunca um padrão do usuário). */
export function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}
