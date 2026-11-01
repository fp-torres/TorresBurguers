import type { ValueTransformer } from 'typeorm';

/** decimal/bigint chegam do Postgres como texto: na entidade ficam como number. */
export const numericTransformer: ValueTransformer = {
  to: (value: unknown) => value,
  from: (value: unknown) =>
    value === null || value === undefined ? value : Number(value),
};
