import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ClientOnlyGuard } from './client-only.guard';

function contextWith(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('ClientOnlyGuard', () => {
  const guard = new ClientOnlyGuard();

  it('cliente compra', () => {
    expect(
      guard.canActivate(contextWith({ role: 'CLIENT', platformRole: null })),
    ).toBe(true);
  });

  it.each(['ADMIN', 'EMPLOYEE', 'KITCHEN', 'COURIER'])(
    'equipe (%s) não compra: 403 com a mensagem da equipe',
    (role) => {
      expect(() =>
        guard.canActivate(contextWith({ role, platformRole: null })),
      ).toThrow(
        new ForbiddenException(
          'Somente clientes fazem pedidos e pagamentos. Contas da equipe não compram pelo sistema.',
        ),
      );
    },
  );

  it('superadmin (role CLIENT + papel global) não compra: papéis da plataforma e da loja são separados', () => {
    expect(() =>
      guard.canActivate(
        contextWith({ role: 'CLIENT', platformRole: 'SUPER_ADMIN' }),
      ),
    ).toThrow(
      new ForbiddenException(
        'Contas da administração da plataforma não fazem pedidos. Use uma conta de cliente.',
      ),
    );
  });

  it('sem usuário → 403', () => {
    expect(() => guard.canActivate(contextWith(null))).toThrow(
      ForbiddenException,
    );
  });
});
