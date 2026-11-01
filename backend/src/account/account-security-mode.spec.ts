import {
  accountSecurityMode,
  accountSecurityModeWarnings,
  configuredAccountSecurityMode,
} from './account-security-mode';

describe('ACCOUNT_SECURITY_MODE', () => {
  it('padrão compat; strict é lido; valor inválido vira compat', () => {
    expect(configuredAccountSecurityMode({})).toBe('compat');
    expect(
      configuredAccountSecurityMode({ ACCOUNT_SECURITY_MODE: ' Compat ' }),
    ).toBe('compat');
    expect(
      configuredAccountSecurityMode({ ACCOUNT_SECURITY_MODE: 'STRICT' }),
    ).toBe('strict');
    expect(
      configuredAccountSecurityMode({ ACCOUNT_SECURITY_MODE: 'rigido' }),
    ).toBe('invalid');
    expect(accountSecurityMode({ ACCOUNT_SECURITY_MODE: 'rigido' })).toBe(
      'compat',
    );
  });

  it('nesta versão (fase 1a) o strict ainda não existe: a API segue em compat e avisa na subida', () => {
    expect(accountSecurityMode({ ACCOUNT_SECURITY_MODE: 'strict' })).toBe(
      'compat',
    );
    expect(
      accountSecurityModeWarnings({ ACCOUNT_SECURITY_MODE: 'strict' }, true),
    ).toEqual([expect.stringContaining('ainda não está disponível')]);
    expect(
      accountSecurityModeWarnings({ ACCOUNT_SECURITY_MODE: 'x' }, true),
    ).toEqual([expect.stringContaining('inválido')]);
    expect(accountSecurityModeWarnings({}, false)).toEqual([]);
  });
});
