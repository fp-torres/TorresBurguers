import {
  actionFilter,
  AUDIT_ACTION_PATTERN,
  INSTANT_PATTERN,
  numericSearchDigits,
  parseInstant,
  parseInstantRange,
} from './platform-filters';

const SP = 'America/Sao_Paulo';

describe('platform-filters', () => {
  it('busca por dígitos só quando o termo parece um número (telefone/documento)', () => {
    expect(numericSearchDigits('(21) 99999-0000')).toBe('21999990000');
    expect(numericSearchDigits('+55 21 9999')).toBe('55219999');
    expect(numericSearchDigits(' 11.222.333/0001-81 ')).toBe('11222333000181');
    expect(numericSearchDigits('219')).toBe('219');
    // Nome ou e-mail com números: os dígitos soltos não viram busca por telefone
    expect(numericSearchDigits('Cliente Unidade 219 Centro')).toBeNull();
    expect(numericSearchDigits('plat-219-abc@e2e.test')).toBeNull();
    expect(numericSearchDigits('Loja 2192')).toBeNull();
    // Poucos dígitos: nada a procurar
    expect(numericSearchDigits('(21)')).toBeNull();
    expect(numericSearchDigits('  ')).toBeNull();
  });

  it('data sem hora vale o dia inteiro no fuso da plataforma', () => {
    expect(parseInstant('2026-10-11', 'start', SP)?.toISOString()).toBe(
      '2026-10-11T03:00:00.000Z',
    );
    // "to" exclusivo: começo do dia seguinte
    expect(parseInstant('2026-10-11', 'end', SP)?.toISOString()).toBe(
      '2026-10-12T03:00:00.000Z',
    );
  });

  it('data e hora com fuso: "to" inclui o próprio instante', () => {
    expect(
      parseInstant('2026-10-11T15:00:00Z', 'start', SP)?.toISOString(),
    ).toBe('2026-10-11T15:00:00.000Z');
    expect(
      parseInstant('2026-10-11T15:00:00-03:00', 'end', SP)?.toISOString(),
    ).toBe('2026-10-11T18:00:00.001Z');
  });

  it('formato inválido, data inexistente ou hora sem fuso → null', () => {
    for (const value of [
      '2026-02-30',
      '11/10/2026',
      '2026-10-11T15:00',
      'ontem',
      '',
    ]) {
      expect(parseInstant(value, 'start', SP)).toBeNull();
    }
    expect(INSTANT_PATTERN.test('2026-10-11T15:00')).toBe(false);
  });

  it('intervalo: limites opcionais, mensagens e ordem', () => {
    expect(parseInstantRange(undefined, undefined, SP)).toEqual({
      ok: true,
      from: null,
      toExclusive: null,
    });
    const same = parseInstantRange('2026-10-11', '2026-10-11', SP);
    expect(same.ok).toBe(true);
    expect(parseInstantRange('2026-10-12', '2026-10-11', SP)).toEqual({
      ok: false,
      message: 'A data inicial (from) não pode ser depois da data final (to).',
    });
    expect(parseInstantRange('x', undefined, SP)).toMatchObject({
      ok: false,
      message: expect.stringContaining('from inválido') as unknown,
    });
    expect(parseInstantRange(undefined, '2026-13-01', SP)).toMatchObject({
      ok: false,
      message: expect.stringContaining('to inválido') as unknown,
    });
  });

  it('filtro de ação respeita os segmentos e escapa os curingas do LIKE', () => {
    // "plan" traz plan e plan.*, nunca platform.*
    expect(actionFilter('plan')).toEqual({ exact: 'plan', prefix: 'plan.%' });
    expect(actionFilter('platform.store')).toEqual({
      exact: 'platform.store',
      prefix: 'platform.store.%',
    });
    // Terminado em ponto: só o grupo
    expect(actionFilter('auth.')).toEqual({ exact: null, prefix: 'auth.%' });
    expect(actionFilter('auth.login_x')).toEqual({
      exact: 'auth.login_x',
      prefix: 'auth.login\\_x.%',
    });
    expect(actionFilter('a%b').prefix).toBe('a\\%b.%');
    expect(AUDIT_ACTION_PATTERN.test('platform.store.create')).toBe(true);
    expect(AUDIT_ACTION_PATTERN.test("x' OR 1=1")).toBe(false);
  });
});
