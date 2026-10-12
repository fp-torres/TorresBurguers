import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserRole } from './entities/user.entity';
import {
  AccountState,
  Actor,
  assertCanDeleteUser,
  assertKeepsAnAdmin,
  assertSelfOrAdmin,
  isAdmin,
  LAST_ADMIN_MESSAGE,
  removesActiveAdmin,
  resolveRoleChange,
  resolveSignupRole,
} from './users.policy';

const admin: Actor = { id: 1, role: UserRole.ADMIN };
const client: Actor = { id: 10, role: UserRole.CLIENT };
const kitchen: Actor = { id: 20, role: UserRole.KITCHEN };
const employee: Actor = { id: 30, role: UserRole.EMPLOYEE };

describe('users.policy', () => {
  describe('isAdmin', () => {
    it('só reconhece o perfil ADMIN', () => {
      expect(isAdmin(admin)).toBe(true);
      expect(isAdmin(employee)).toBe(false);
      expect(isAdmin(null)).toBe(false);
      expect(isAdmin(undefined)).toBe(false);
    });
  });

  describe('assertSelfOrAdmin (GET/PATCH /users/:id)', () => {
    it('permite o próprio usuário', () => {
      expect(() => assertSelfOrAdmin(client, client.id)).not.toThrow();
    });

    it('permite ADMIN acessar qualquer usuário', () => {
      expect(() => assertSelfOrAdmin(admin, client.id)).not.toThrow();
    });

    it('nega (403) acesso a outro usuário para quem não é ADMIN', () => {
      expect(() => assertSelfOrAdmin(client, admin.id)).toThrow(
        ForbiddenException,
      );
      expect(() => assertSelfOrAdmin(employee, client.id)).toThrow(
        ForbiddenException,
      );
    });

    it('nega (403) sem usuário autenticado', () => {
      expect(() => assertSelfOrAdmin(null, 1)).toThrow(ForbiddenException);
    });
  });

  describe('resolveSignupRole (POST /users)', () => {
    it('sem perfil cria CLIENT', () => {
      expect(resolveSignupRole(undefined, null)).toBe(UserRole.CLIENT);
    });

    it('CLIENT explícito é aceito sem token', () => {
      expect(resolveSignupRole(UserRole.CLIENT, undefined)).toBe(
        UserRole.CLIENT,
      );
    });

    it.each([
      UserRole.ADMIN,
      UserRole.EMPLOYEE,
      UserRole.KITCHEN,
      UserRole.COURIER,
    ])('perfil %s sem token de ADMIN → 403', (role) => {
      expect(() => resolveSignupRole(role, null)).toThrow(ForbiddenException);
      expect(() => resolveSignupRole(role, client)).toThrow(ForbiddenException);
      expect(() => resolveSignupRole(role, employee)).toThrow(
        ForbiddenException,
      );
    });

    it('ADMIN autenticado pode criar qualquer perfil', () => {
      expect(resolveSignupRole(UserRole.COURIER, admin)).toBe(UserRole.COURIER);
      expect(resolveSignupRole(UserRole.ADMIN, admin)).toBe(UserRole.ADMIN);
    });
  });

  describe('resolveRoleChange (PATCH /users/:id)', () => {
    it('sem perfil no corpo não altera nada', () => {
      expect(resolveRoleChange(undefined, client, client.id)).toBeUndefined();
      expect(resolveRoleChange(undefined, admin, admin.id)).toBeUndefined();
    });

    it('não-admin reenviando o próprio perfil é aceito e ignorado', () => {
      expect(
        resolveRoleChange(UserRole.CLIENT, client, client.id),
      ).toBeUndefined();
      expect(
        resolveRoleChange(UserRole.KITCHEN, kitchen, kitchen.id),
      ).toBeUndefined();
    });

    it('não-admin tentando mudar de perfil → 403 (sem escalada de privilégio)', () => {
      expect(() =>
        resolveRoleChange(UserRole.ADMIN, client, client.id),
      ).toThrow(ForbiddenException);
      expect(() =>
        resolveRoleChange(UserRole.ADMIN, employee, employee.id),
      ).toThrow(ForbiddenException);
      expect(() =>
        resolveRoleChange(UserRole.CLIENT, kitchen, kitchen.id),
      ).toThrow(ForbiddenException);
    });

    it('ADMIN pode alterar o perfil de outro usuário (inclusive de outro ADMIN)', () => {
      expect(resolveRoleChange(UserRole.EMPLOYEE, admin, client.id)).toBe(
        UserRole.EMPLOYEE,
      );
      expect(resolveRoleChange(UserRole.CLIENT, admin, 2)).toBe(
        UserRole.CLIENT,
      );
    });

    it('ADMIN não altera o próprio perfil → 400', () => {
      for (const role of [
        UserRole.CLIENT,
        UserRole.EMPLOYEE,
        UserRole.KITCHEN,
        UserRole.COURIER,
      ]) {
        expect(() => resolveRoleChange(role, admin, admin.id)).toThrow(
          BadRequestException,
        );
      }
    });

    it('ADMIN reenviando o próprio perfil (ADMIN) é aceito e ignorado', () => {
      expect(
        resolveRoleChange(UserRole.ADMIN, admin, admin.id),
      ).toBeUndefined();
    });
  });

  describe('último ADMIN ativo (rebaixamento, lixeira e exclusão definitiva)', () => {
    const activeAdmin: AccountState = { id: 1, role: UserRole.ADMIN };
    const trashedAdmin: AccountState = {
      id: 5,
      role: UserRole.ADMIN,
      deleted_at: new Date(),
    };
    const activeClient: AccountState = { id: 10, role: UserRole.CLIENT };

    it('removesActiveAdmin: só quando um ADMIN ativo deixa de ser ADMIN ou sai', () => {
      expect(removesActiveAdmin(activeAdmin, UserRole.CLIENT)).toBe(true);
      expect(removesActiveAdmin(activeAdmin, null)).toBe(true);
      expect(removesActiveAdmin(activeAdmin, UserRole.ADMIN)).toBe(false);
      expect(removesActiveAdmin(trashedAdmin, null)).toBe(false);
      expect(removesActiveAdmin(activeClient, null)).toBe(false);
      expect(removesActiveAdmin(activeClient, UserRole.ADMIN)).toBe(false);
    });

    it('rebaixar ou excluir o único ADMIN ativo → 400', () => {
      for (const nextRole of [UserRole.EMPLOYEE, null]) {
        expect(() => assertKeepsAnAdmin(activeAdmin, nextRole, [1])).toThrow(
          new BadRequestException(LAST_ADMIN_MESSAGE),
        );
      }
      // Lista vazia (ex.: dados inconsistentes) também protege
      expect(() => assertKeepsAnAdmin(activeAdmin, null, [])).toThrow(
        BadRequestException,
      );
    });

    it('com outro ADMIN ativo, a operação é permitida', () => {
      expect(() =>
        assertKeepsAnAdmin(activeAdmin, UserRole.CLIENT, [1, 2]),
      ).not.toThrow();
      expect(() => assertKeepsAnAdmin(activeAdmin, null, [2, 1])).not.toThrow();
    });

    it('contas que não são ADMIN ativo nunca são bloqueadas', () => {
      expect(() => assertKeepsAnAdmin(activeClient, null, [])).not.toThrow();
      expect(() => assertKeepsAnAdmin(trashedAdmin, null, [])).not.toThrow();
      expect(() =>
        assertKeepsAnAdmin(activeAdmin, UserRole.ADMIN, [1]),
      ).not.toThrow();
    });
  });

  describe('assertCanDeleteUser (DELETE /users/:id)', () => {
    it('usuário pode excluir a própria conta', () => {
      expect(() => assertCanDeleteUser(client, client.id)).not.toThrow();
    });

    it('ADMIN pode excluir outros usuários', () => {
      expect(() => assertCanDeleteUser(admin, client.id)).not.toThrow();
    });

    it('ADMIN não pode excluir a própria conta → 400', () => {
      expect(() => assertCanDeleteUser(admin, admin.id)).toThrow(
        BadRequestException,
      );
    });

    it('não-admin excluindo outra conta → 403 (e não 401)', () => {
      expect(() => assertCanDeleteUser(client, admin.id)).toThrow(
        ForbiddenException,
      );
      expect(() => assertCanDeleteUser(employee, client.id)).toThrow(
        ForbiddenException,
      );
    });

    it('sem usuário autenticado → 403', () => {
      expect(() => assertCanDeleteUser(undefined, 1)).toThrow(
        ForbiddenException,
      );
    });
  });
});
