/**
 * Banco em memória para os testes da cobrança (não é um teste: o nome termina em "-spec.ts" só para
 * ficar fora do build, que exclui "**\/*spec.ts"; o Jest só roda ".spec.ts").
 *
 * Imita o subconjunto do Repository/EntityManager do TypeORM usado pelos serviços: find, findOne,
 * findAndCount, count, exists, create, save, update e transaction (desfeita em caso de erro), com os
 * operadores de where (Not, In, LessThan, LessThanOrEqual, MoreThan, MoreThanOrEqual, IsNull, ILike),
 * relações many-to-one (no where e em relations) e índices únicos (inclusive parciais). Como o
 * invalidWhereValuesBehavior do projeto, null/undefined no where é erro.
 */
import { FindOperator, QueryFailedError } from 'typeorm';

export type Row = Record<string, unknown>;

export interface RelationDef {
  table: string;
  column: string;
}

export interface UniqueDef {
  columns: string[];
  /** Índice parcial: só as linhas que passam no filtro contam. */
  where?: (row: Row) => boolean;
}

export interface TableDef {
  entity: abstract new (...args: never[]) => unknown;
  name: string;
  relations?: Record<string, RelationDef>;
  unique?: UniqueDef[];
  /** Colunas preenchidas com "agora" na inserção (padrão: created_at). */
  createdColumns?: string[];
  /** Coluna atualizada com "agora" em save/update (padrão: updated_at; null = nenhuma). */
  updatedColumn?: string | null;
}

export interface QueryLog {
  table: string;
  method: string;
  where: unknown;
}

/**
 * Data de qualquer "realm": o Jest roda cada arquivo num contexto próprio e objetos criados fora
 * dele (ex.: pelo structuredClone global) não passam no instanceof Date.
 */
function isDate(value: unknown): value is Date {
  return Object.prototype.toString.call(value) === '[object Date]';
}

/** Cópia profunda com Dates do próprio contexto (o banco nunca devolve a mesma referência). */
function clone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (isDate(value)) return new Date(value.getTime()) as T;
  if (value instanceof FindOperator) return value;
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => clone(item)) as T;
  }
  if (value instanceof Map) {
    return new Map(
      [...(value as Map<unknown, unknown>)].map(([key, item]) => [
        key,
        clone(item),
      ]),
    ) as T;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      clone(item),
    ]),
  ) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !isDate(value) &&
    !(value instanceof FindOperator)
  );
}

function same(a: unknown, b: unknown): boolean {
  if (isDate(a) || isDate(b)) {
    return (
      a !== null &&
      b !== null &&
      a !== undefined &&
      b !== undefined &&
      new Date(a as Date).getTime() === new Date(b as Date).getTime()
    );
  }
  return a === b;
}

function compare(a: unknown, b: unknown): number {
  const left = isDate(a) ? a.getTime() : (a as number | string);
  const right = isDate(b) ? b.getTime() : (b as number | string);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Texto comparável no LIKE (colunas de texto ou número). */
function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : '';
}

/** Padrão LIKE (com % _ e escape \) → RegExp. */
function likeToRegExp(pattern: string, flags: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '\\' && index + 1 < pattern.length) {
      index += 1;
      source += pattern[index].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (char === '%') source += '.*';
    else if (char === '_') source += '.';
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, flags);
}

function matchOperator(
  value: unknown,
  operator: FindOperator<unknown>,
): boolean {
  const isNull = value === null || value === undefined;
  const operand = operator.value;
  switch (operator.type) {
    case 'not':
      if (operand instanceof FindOperator) {
        if (operand.type === 'isNull') return !isNull;
        return !isNull && !matchOperator(value, operand);
      }
      return !isNull && !same(value, operand);
    case 'in':
      return (
        !isNull && (operand as unknown[]).some((item) => same(value, item))
      );
    case 'lessThan':
      return !isNull && compare(value, operand) < 0;
    case 'lessThanOrEqual':
      return !isNull && compare(value, operand) <= 0;
    case 'moreThan':
      return !isNull && compare(value, operand) > 0;
    case 'moreThanOrEqual':
      return !isNull && compare(value, operand) >= 0;
    case 'isNull':
      return isNull;
    case 'equal':
      return !isNull && same(value, operand);
    case 'ilike':
      return !isNull && likeToRegExp(text(operand), 'i').test(text(value));
    case 'like':
      return !isNull && likeToRegExp(text(operand), '').test(text(value));
    default:
      throw new Error(
        `Operador não suportado no banco falso: ${operator.type}`,
      );
  }
}

export class FakeDb {
  readonly queries: QueryLog[] = [];
  /** SQL direto (manager.query): travas consultivas e afins. */
  readonly rawQueries: { sql: string; params: unknown[] }[] = [];
  /**
   * Gancho do teste para simular o efeito de um SQL direto (ex.: outra requisição dentro da trava).
   * Devolvendo uma lista, ela vira o resultado do SQL (ex.: [{ locked: false }] = trava ocupada).
   */
  onRawQuery?: (sql: string, params: unknown[]) => unknown[] | void;
  /** Relógio dos created_at/updated_at gravados. */
  now: () => Date = () => new Date();
  readonly manager: FakeManager;

  private tables = new Map<string, Row[]>();
  private sequences = new Map<string, number>();
  private readonly defs = new Map<unknown, TableDef>();
  private readonly byName = new Map<string, TableDef>();

  constructor(defs: TableDef[]) {
    for (const def of defs) {
      this.defs.set(def.entity, def);
      this.byName.set(def.name, def);
      this.tables.set(def.name, []);
      this.sequences.set(def.name, 0);
    }
    this.manager = new FakeManager(this);
  }

  tableDef(name: string): TableDef | undefined {
    return this.byName.get(name);
  }

  def(entity: unknown): TableDef {
    const def = this.defs.get(entity);
    if (!def) throw new Error('Entidade não registrada no banco falso.');
    return def;
  }

  table(name: string): Row[] {
    const rows = this.tables.get(name);
    if (!rows) throw new Error(`Tabela ${name} não registrada no banco falso.`);
    return rows;
  }

  hasTable(name: string): boolean {
    return this.tables.has(name);
  }

  relationsOf(name: string): Record<string, RelationDef> {
    return this.byName.get(name)?.relations ?? {};
  }

  /** Cópia das linhas (para conferir nos testes). */
  rows(name: string): Row[] {
    return clone(this.table(name));
  }

  /** Linha pronta (dados iniciais do teste), sem passar pelas regras do repositório. */
  seed(name: string, row: Row): Row {
    const stored = { ...row };
    if (stored.id === undefined) stored.id = this.nextId(name);
    else
      this.sequences.set(
        name,
        Math.max(this.sequences.get(name) ?? 0, Number(stored.id)),
      );
    this.table(name).push(clone(stored));
    return clone(stored);
  }

  nextId(name: string): number {
    const next = (this.sequences.get(name) ?? 0) + 1;
    this.sequences.set(name, next);
    return next;
  }

  repository<T>(entity: unknown): FakeRepository<T> {
    return new FakeRepository<T>(this, this.def(entity));
  }

  snapshot(): { tables: Map<string, Row[]>; sequences: Map<string, number> } {
    return { tables: clone(this.tables), sequences: clone(this.sequences) };
  }

  restore(state: {
    tables: Map<string, Row[]>;
    sequences: Map<string, number>;
  }): void {
    this.tables = state.tables;
    this.sequences = state.sequences;
  }

  matches(tableName: string, row: Row, where: unknown): boolean {
    if (Array.isArray(where)) {
      return where.some((item) => this.matches(tableName, row, item));
    }
    if (!isPlainObject(where)) {
      throw new Error('where inválido no banco falso.');
    }
    const relations = this.relationsOf(tableName);
    for (const [key, condition] of Object.entries(where)) {
      if (condition === undefined || condition === null) {
        // Igual ao invalidWhereValuesBehavior { null: 'throw', undefined: 'throw' } do projeto
        throw new Error(
          `where com ${key} = ${String(condition)} (use IsNull() para comparar com NULL)`,
        );
      }
      const relation = relations[key];
      if (relation && isPlainObject(condition)) {
        const related = this.hasTable(relation.table)
          ? this.table(relation.table).find(
              (item) => item.id === row[relation.column],
            )
          : undefined;
        if (!related || !this.matches(relation.table, related, condition)) {
          return false;
        }
        continue;
      }
      const ok =
        condition instanceof FindOperator
          ? matchOperator(row[key], condition)
          : row[key] !== null &&
            row[key] !== undefined &&
            same(row[key], condition);
      if (!ok) return false;
    }
    return true;
  }

  checkUnique(tableName: string, candidate: Row): void {
    const def = this.byName.get(tableName);
    for (const unique of def?.unique ?? []) {
      if (unique.where && !unique.where(candidate)) continue;
      if (unique.columns.some((column) => candidate[column] == null)) continue;
      const clash = this.table(tableName).some(
        (row) =>
          row.id !== candidate.id &&
          (!unique.where || unique.where(row)) &&
          unique.columns.every((column) =>
            same(row[column], candidate[column]),
          ),
      );
      if (clash) {
        throw new QueryFailedError(
          `INSERT/UPDATE ${tableName}`,
          [],
          Object.assign(
            new Error(
              `duplicate key value violates unique constraint (${unique.columns.join(', ')})`,
            ),
            { code: '23505' },
          ),
        );
      }
    }
  }

  withRelations(tableName: string, row: Row, relations: unknown): Row {
    const names = Array.isArray(relations)
      ? (relations as string[])
      : isPlainObject(relations)
        ? Object.entries(relations)
            .filter(([, wanted]) => !!wanted)
            .map(([name]) => name)
        : [];
    const result = clone(row);
    const defs = this.relationsOf(tableName);
    for (const name of names) {
      const relation = defs[name];
      if (!relation)
        throw new Error(`Relação ${name} não definida em ${tableName}.`);
      const related = this.hasTable(relation.table)
        ? this.table(relation.table).find(
            (item) => item.id === row[relation.column],
          )
        : undefined;
      result[name] = related ? clone(related) : null;
    }
    return result;
  }
}

export class FakeManager {
  private depth = 0;

  constructor(private readonly db: FakeDb) {}

  getRepository<T>(entity: unknown): FakeRepository<T> {
    return this.db.repository<T>(entity);
  }

  /** SQL direto: só registrado (e o gancho do teste, se houver). A trava sem espera sai livre. */
  query(sql: string, params: unknown[] = []): Promise<unknown[]> {
    this.db.rawQueries.push({ sql, params });
    const rows = this.db.onRawQuery?.(sql, params);
    if (Array.isArray(rows)) return Promise.resolve(rows);
    if (sql.includes('pg_try_advisory_xact_lock')) {
      return Promise.resolve([{ locked: true }]);
    }
    return Promise.resolve([]);
  }

  /** Transação: tudo é desfeito se o callback lançar erro. */
  async transaction<T>(work: (manager: FakeManager) => Promise<T>): Promise<T> {
    if (this.depth > 0) return work(this);
    const state = this.db.snapshot();
    this.depth += 1;
    try {
      return await work(this);
    } catch (error) {
      this.db.restore(state);
      throw error;
    } finally {
      this.depth -= 1;
    }
  }
}

interface FindOptions {
  where?: unknown;
  order?: Record<string, 'ASC' | 'DESC'>;
  relations?: unknown;
  skip?: number;
  take?: number;
  select?: unknown;
  lock?: unknown;
}

export class FakeRepository<T> {
  constructor(
    private readonly db: FakeDb,
    private readonly def: TableDef,
  ) {}

  get manager(): FakeManager {
    return this.db.manager;
  }

  /** Datas geradas pelo banco (created_at/updated_at e afins). */
  private stamps(now: Date): { created: Row; updated: Row } {
    const created = Object.fromEntries(
      (this.def.createdColumns ?? ['created_at']).map((column) => [
        column,
        now,
      ]),
    );
    const column =
      this.def.updatedColumn === undefined
        ? 'updated_at'
        : this.def.updatedColumn;
    return { created, updated: column ? { [column]: now } : {} };
  }

  private log(method: string, where: unknown): void {
    this.db.queries.push({ table: this.def.name, method, where });
  }

  private filtered(options: FindOptions = {}): Row[] {
    let rows = this.db
      .table(this.def.name)
      .filter((row) =>
        options.where === undefined
          ? true
          : this.db.matches(this.def.name, row, options.where),
      );
    const order = Object.entries(options.order ?? {});
    if (order.length) {
      rows = [...rows].sort((a, b) => {
        for (const [column, direction] of order) {
          const left = a[column];
          const right = b[column];
          const leftNull = left === null || left === undefined;
          const rightNull = right === null || right === undefined;
          // Como no PostgreSQL: NULL por último no ASC e primeiro no DESC
          if (leftNull || rightNull) {
            if (leftNull && rightNull) continue;
            return (leftNull ? 1 : -1) * (direction === 'DESC' ? -1 : 1);
          }
          const result = compare(left, right);
          if (result !== 0) return direction === 'DESC' ? -result : result;
        }
        return 0;
      });
    }
    const skip = options.skip ?? 0;
    return rows.slice(
      skip,
      options.take === undefined ? undefined : skip + options.take,
    );
  }

  create(data: Partial<T> = {}): T {
    return { ...(data as Row) } as T;
  }

  async find(options: FindOptions = {}): Promise<T[]> {
    this.log('find', options.where);
    return Promise.resolve(
      this.filtered(options).map(
        (row) =>
          this.db.withRelations(this.def.name, row, options.relations) as T,
      ),
    );
  }

  async findOne(options: FindOptions): Promise<T | null> {
    this.log('findOne', options.where);
    const [row] = this.filtered({ ...options, skip: 0, take: 1 });
    return Promise.resolve(
      row
        ? (this.db.withRelations(this.def.name, row, options.relations) as T)
        : null,
    );
  }

  async findOneBy(where: unknown): Promise<T | null> {
    return this.findOne({ where });
  }

  async findAndCount(options: FindOptions = {}): Promise<[T[], number]> {
    this.log('findAndCount', options.where);
    const total = this.filtered({ where: options.where }).length;
    const rows = this.filtered(options).map(
      (row) =>
        this.db.withRelations(this.def.name, row, options.relations) as T,
    );
    return Promise.resolve([rows, total]);
  }

  async count(options: FindOptions = {}): Promise<number> {
    this.log('count', options.where);
    return Promise.resolve(this.filtered({ where: options.where }).length);
  }

  async exists(options: FindOptions = {}): Promise<boolean> {
    this.log('exists', options.where);
    return Promise.resolve(this.filtered({ where: options.where }).length > 0);
  }

  /** Insere ou atualiza (pelo id), como o save do TypeORM; preenche id e datas no objeto. */
  async save(entity: T): Promise<T> {
    const input = entity as Row;
    const relationNames = Object.keys(this.def.relations ?? {});
    const data: Row = {};
    for (const [key, value] of Object.entries(input)) {
      if (!relationNames.includes(key)) data[key] = value;
    }
    const rows = this.db.table(this.def.name);
    const now = this.db.now();
    const stamps = this.stamps(now);
    const index =
      data.id === undefined ? -1 : rows.findIndex((row) => row.id === data.id);
    if (index >= 0) {
      const updated = { ...rows[index], ...clone(data), ...stamps.updated };
      this.db.checkUnique(this.def.name, updated);
      rows[index] = updated;
      Object.assign(input, stamps.updated);
    } else {
      const id = data.id ?? this.db.nextId(this.def.name);
      const generated = { ...stamps.created, ...stamps.updated };
      const created = { ...generated, ...clone(data), id };
      this.db.checkUnique(this.def.name, created);
      rows.push(created);
      Object.assign(input, generated, { id });
    }
    return Promise.resolve(entity);
  }

  async update(
    criteria: unknown,
    partial: Partial<T>,
  ): Promise<{ affected: number }> {
    const where = typeof criteria === 'number' ? { id: criteria } : criteria;
    this.log('update', where);
    const changes = partial as Row;
    for (const [key, value] of Object.entries(changes)) {
      if (typeof value === 'function') {
        throw new Error(`update com SQL bruto (${key}) não é suportado.`);
      }
    }
    const rows = this.db.table(this.def.name);
    let affected = 0;
    for (let index = 0; index < rows.length; index += 1) {
      if (!this.db.matches(this.def.name, rows[index], where)) continue;
      const updated = {
        ...rows[index],
        ...clone(changes),
        ...this.stamps(this.db.now()).updated,
      };
      this.db.checkUnique(this.def.name, updated);
      rows[index] = updated;
      affected += 1;
    }
    return Promise.resolve({ affected });
  }
}
