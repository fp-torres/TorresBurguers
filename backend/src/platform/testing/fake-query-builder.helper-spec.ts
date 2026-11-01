/**
 * QueryBuilder falso para os testes do superpainel (não é um teste: o nome termina em "-spec.ts" só
 * para ficar fora do build, que exclui "**\/*spec.ts"; o Jest só roda ".spec.ts").
 *
 * Todo método encadeável devolve o próprio objeto e fica registrado em `calls`; os métodos finais
 * (getMany, getRawMany, getManyAndCount...) devolvem o resultado configurado.
 */
export interface QueryCall {
  method: string;
  args: unknown[];
}

export type FakeQueryBuilder = { calls: QueryCall[] } & Record<string, unknown>;

const TERMINALS = [
  'getMany',
  'getManyAndCount',
  'getRawOne',
  'getRawMany',
  'getCount',
  'getOne',
] as const;

type Terminal = (typeof TERMINALS)[number];

function defaultResult(method: Terminal): unknown {
  switch (method) {
    case 'getMany':
    case 'getRawMany':
      return [];
    case 'getManyAndCount':
      return [[], 0];
    case 'getCount':
      return 0;
    default:
      return undefined;
  }
}

function isTerminal(method: string): method is Terminal {
  return (TERMINALS as readonly string[]).includes(method);
}

export function fakeQueryBuilder(
  results: Partial<Record<Terminal, unknown>> = {},
): FakeQueryBuilder {
  const calls: QueryCall[] = [];
  const proxy = new Proxy(
    { calls },
    {
      get(_target, property) {
        if (typeof property !== 'string') return undefined;
        if (property === 'calls') return calls;
        // Não é uma Promise (await no objeto não pode chamar "then")
        if (property === 'then') return undefined;
        return (...args: unknown[]) => {
          calls.push({ method: property, args });
          if (isTerminal(property)) {
            return Promise.resolve(
              property in results ? results[property] : defaultResult(property),
            );
          }
          return proxy;
        };
      },
    },
  ) as FakeQueryBuilder;
  return proxy;
}

/** Textos (SQL) passados aos métodos encadeados, para conferir as condições montadas. */
export function sqlOf(qb: FakeQueryBuilder): string {
  return qb.calls
    .map((call) => call.args.filter((arg) => typeof arg === 'string').join(' '))
    .join('\n');
}

/** Parâmetros passados em where/andWhere/setParameter(s)/select... (objetos simples). */
export function paramsOf(qb: FakeQueryBuilder): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const call of qb.calls) {
    if (call.method === 'setParameter') {
      params[String(call.args[0])] = call.args[1];
      continue;
    }
    for (const arg of call.args) {
      if (
        arg &&
        typeof arg === 'object' &&
        !Array.isArray(arg) &&
        Object.getPrototypeOf(arg) === Object.prototype
      ) {
        Object.assign(params, arg);
      }
    }
  }
  return params;
}

/** Chamadas de um método (ex.: todas as orderBy). */
export function callsOf(qb: FakeQueryBuilder, method: string): unknown[][] {
  return qb.calls
    .filter((call) => call.method === method)
    .map((call) => call.args);
}
