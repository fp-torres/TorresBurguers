import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PlatformRole, UserRole } from './entities/user.entity';
import {
  AccountState,
  Actor,
  assertCanDeleteUser,
  assertKeepsAnAdmin,
  assertStoreId,
  assertWritable,
  isAdmin,
  isStaffRole,
  isStoreAdmin,
  LAST_ADMIN_MESSAGE,
  removesActiveAdmin,
  resolveRoleChange,
  resolveSignup,
  resolveUserAccess,
  STAFF_ROLE_REQUIRED_MESSAGE,
  SUPPORT_READ_ONLY_MESSAGE,
} from './users.policy';

const STORE_A = 1;
const STORE_B = 2;

const adminA: Actor = { id: 1, role: UserRole.ADMIN, storeId: STORE_A };
const adminB: Actor = { id: 2, role: UserRole.ADMIN, storeId: STORE_B };
const client: Actor = { id: 10, role: UserRole.CLIENT, storeId: null };
const kitchen: Actor = { id: 20, role: UserRole.KITCHEN, storeId: STORE_A };
const employee: Actor = { id: 30, role: UserRole.EMPLOYEE, storeId: STORE_A };
const superAdmin: Actor = {
  id: 90,
  role: UserRole.CLIENT,
  storeId: null,
  platformRole: PlatformRole.SUPER_ADMIN,
};
/** Sessão de suporte: ADMIN somente leitura da loja da sessão. */
const support: Actor = {
  id: 90,
  role: UserRole.ADMIN,
  storeId: STORE_A,
  supportSession: { id: 5, storeId: STORE_A },
};
/** Dado inconsistente (ADMIN sem loja) nunca vira ADMIN de loja. */
const adminWithoutStore: Actor = {
  id: 3,
  role: UserRole.ADMIN,
  storeId: null,
};

describe('users.policy', () => {
  describe('perfis', () => {
    it('isStaffRole: só os perfis da equipe', () => {
      for (const role of [
        UserRole.ADMIN,
        UserRole.EMPLOYEE,
        UserRole.KITCHEN,
        UserRole.COURIER,
      ]) {
        expect(isStaffRole(role)).toBe(true);
      }
      expect(isStaffRole(UserRole.CLIENT)).toBe(false);
      expect(isStaffRole(undefined)).toBe(false);
      expect(isStaffRole('ROOT')).toBe(false);
    });

    it('isAdmin olha só o perfil; isStoreAdmin exige a loja', () => {
      expect(isAdmin(adminA)).toBe(true);
      expect(isAdmin(employee)).toBe(false);
      expect(isAdmin(null)).toBe(false);
      expect(isStoreAdmin(adminA)).toBe(true);
      expect(isStoreAdmin(support)).toBe(true);
      expect(isStoreAdmin(adminWithoutStore)).toBe(false);
      expect(isStoreAdmin(superAdmin)).toBe(false);
      expect(isStoreAdmin(client)).toBe(false);
    });

    it('assertStoreId: sem loja válida, nada acontece (falha fechada)', () => {
      expect(() => assertStoreId(1)).not.toThrow();
      for (const invalid of [0, -1, 1.5, null, undefined, '1', NaN]) {
        expect(() => assertStoreId(invalid)).toThrow(ForbiddenException);
      }
    });

    it('assertWritable: sessão de suporte é somente leitura (403)', () => {
      expect(() => assertWritable(support)).toThrow(
        new ForbiddenException(SUPPORT_READ_ONLY_MESSAGE),
      );
      expect(() => assertWritable(adminA)).not.toThrow();
      expect(() => assertWritable(null)).not.toThrow();
    });
  });

  describe('resolveUserAccess (GET/PATCH /users/:id)', () => {
    it('a própria conta é sempre "self" (inclusive cliente e superadmin)', () => {
      expect(resolveUserAccess(client, client.id)).toBe('self');
      expect(resolveUserAccess(kitchen, kitchen.id)).toBe('self');
      expect(resolveUserAccess(superAdmin, superAdmin.id)).toBe('self');
    });

    it('ADMIN de loja acessando outra conta → "team" (o serviço procura só na loja dele)', () => {
      expect(resolveUserAccess(adminA, 999)).toBe('team');
      expect(resolveUserAccess(adminB, adminA.id)).toBe('team');
      expect(resolveUserAccess(support, 999)).toBe('team');
    });

    it('demais perfis acessando outra conta → 403', () => {
      for (const actor of [
        client,
        kitchen,
        employee,
        superAdmin,
        adminWithoutStore,
      ]) {
        expect(() => resolveUserAccess(actor, 4242)).toThrow(
          ForbiddenException,
        );
      }
      expect(() => resolveUserAccess(null, 1)).toThrow(ForbiddenException);
    });
  });

  describe('resolveSignup (POST /users)', () => {
    it('anônimo: sem perfil ou CLIENT cria cliente', () => {
      expect(resolveSignup(undefined, null)).toEqual({ kind: 'client' });
      expect(resolveSignup(UserRole.CLIENT, undefined)).toEqual({
        kind: 'client',
      });
    });

    it.each([
      UserRole.ADMIN,
      UserRole.EMPLOYEE,
      UserRole.KITCHEN,
      UserRole.COURIER,
    ])('perfil %s sem token de ADMIN de loja → 403', (role) => {
      for (const actor of [
        null,
        client,
        employee,
        kitchen,
        superAdmin,
        adminWithoutStore,
      ]) {
        expect(() => resolveSignup(role, actor)).toThrow(ForbiddenException);
      }
    });

    it('não-ADMIN autenticado ainda pode fazer o cadastro público de cliente', () => {
      expect(resolveSignup(undefined, employee)).toEqual({ kind: 'client' });
      expect(resolveSignup(UserRole.CLIENT, superAdmin)).toEqual({
        kind: 'client',
      });
    });

    it('ADMIN da loja cria EQUIPE na própria loja (a loja vem do ADMIN)', () => {
      expect(resolveSignup(UserRole.COURIER, adminA)).toEqual({
        kind: 'staff',
        role: UserRole.COURIER,
        storeId: STORE_A,
      });
      expect(resolveSignup(UserRole.ADMIN, adminB)).toEqual({
        kind: 'staff',
        role: UserRole.ADMIN,
        storeId: STORE_B,
      });
    });

    it('ADMIN da loja pedindo CLIENT (ou sem perfil) → 400', () => {
      for (const role of [UserRole.CLIENT, undefined]) {
        expect(() => resolveSignup(role, adminA)).toThrow(
          new BadRequestException(STAFF_ROLE_REQUIRED_MESSAGE),
        );
      }
    });

    it('sessão de suporte não cria contas (403)', () => {
      expect(() => resolveSignup(UserRole.KITCHEN, support)).toThrow(
        ForbiddenException,
      );
    });
  });

  describe('resolveRoleChange (PATCH /users/:id)', () => {
    it('sem perfil no corpo não altera nada', () => {
      expect(resolveRoleChange(undefined, client, client.id)).toBeUndefined();
      expect(resolveRoleChange(undefined, adminA, 999)).toBeUndefined();
    });

    it('reenviar o próprio perfil é aceito e ignorado', () => {
      expect(
        resolveRoleChange(UserRole.CLIENT, client, client.id),
      ).toBeUndefined();
      expect(
        resolveRoleChange(UserRole.KITCHEN, kitchen, kitchen.id),
      ).toBeUndefined();
      expect(
        resolveRoleChange(UserRole.ADMIN, adminA, adminA.id),
      ).toBeUndefined();
    });

    it('não-admin mudando de perfil → 403 (sem escalada de privilégio)', () => {
      expect(() =>
        resolveRoleChange(UserRole.ADMIN, client, client.id),
      ).toThrow(ForbiddenException);
      expect(() =>
        resolveRoleChange(UserRole.ADMIN, employee, employee.id),
      ).toThrow(ForbiddenException);
      expect(() => resolveRoleChange(UserRole.ADMIN, kitchen, 999)).toThrow(
        ForbiddenException,
      );
    });

    it('ADMIN não altera o próprio perfil → 400', () => {
      for (const role of [
        UserRole.CLIENT,
        UserRole.EMPLOYEE,
        UserRole.KITCHEN,
        UserRole.COURIER,
      ]) {
        expect(() => resolveRoleChange(role, adminA, adminA.id)).toThrow(
          BadRequestException,
        );
      }
    });

    it('ADMIN da loja troca o perfil de outro membro só entre perfis da equipe', () => {
      expect(resolveRoleChange(UserRole.EMPLOYEE, adminA, 50)).toBe(
        UserRole.EMPLOYEE,
      );
      expect(resolveRoleChange(UserRole.ADMIN, adminA, 50)).toBe(
        UserRole.ADMIN,
      );
      expect(() => resolveRoleChange(UserRole.CLIENT, adminA, 50)).toThrow(
        BadRequestException,
      );
    });
  });

  describe('assertCanDeleteUser (DELETE /users/:id)', () => {
    it('cliente e equipe podem excluir a própria conta', () => {
      expect(assertCanDeleteUser(client, client.id)).toBe('self');
      expect(assertCanDeleteUser(kitchen, kitchen.id)).toBe('self');
    });

    it('ADMIN e superadmin não excluem a própria conta por aqui → 400', () => {
      expect(() => assertCanDeleteUser(adminA, adminA.id)).toThrow(
        BadRequestException,
      );
      expect(() => assertCanDeleteUser(superAdmin, superAdmin.id)).toThrow(
        BadRequestException,
      );
    });

    it('ADMIN de loja excluindo outra conta → "team" (só a equipe da própria loja)', () => {
      expect(assertCanDeleteUser(adminA, client.id)).toBe('team');
    });

    it('não-admin excluindo outra conta → 403 (e não 401)', () => {
      expect(() => assertCanDeleteUser(client, adminA.id)).toThrow(
        ForbiddenException,
      );
      expect(() => assertCanDeleteUser(employee, client.id)).toThrow(
        ForbiddenException,
      );
      expect(() => assertCanDeleteUser(undefined, 1)).toThrow(
        ForbiddenException,
      );
    });
  });

  describe('último ADMIN ativo da loja (rebaixamento, lixeira e exclusão definitiva)', () => {
    const activeAdmin: AccountState = { id: 1, role: UserRole.ADMIN };
    const trashedAdmin: AccountState = {
      id: 5,
      role: UserRole.ADMIN,
      deleted_at: new Date(),
    };
    const blockedAdmin: AccountState = {
      id: 6,
      role: UserRole.ADMIN,
      blocked_at: new Date(),
    };
    const courier: AccountState = { id: 10, role: UserRole.COURIER };

    it('removesActiveAdmin: só quando um ADMIN ativo deixa de ser ADMIN ou sai', () => {
      expect(removesActiveAdmin(activeAdmin, UserRole.EMPLOYEE)).toBe(true);
      expect(removesActiveAdmin(activeAdmin, null)).toBe(true);
      expect(removesActiveAdmin(activeAdmin, UserRole.ADMIN)).toBe(false);
      expect(removesActiveAdmin(trashedAdmin, null)).toBe(false);
      expect(removesActiveAdmin(blockedAdmin, null)).toBe(false);
      expect(removesActiveAdmin(courier, null)).toBe(false);
      expect(removesActiveAdmin(courier, UserRole.ADMIN)).toBe(false);
    });

    it('rebaixar ou excluir o único ADMIN ativo → 400 "a loja ficaria sem administrador"', () => {
      for (const nextRole of [UserRole.EMPLOYEE, null]) {
        expect(() => assertKeepsAnAdmin(activeAdmin, nextRole, [1])).toThrow(
          new BadRequestException(LAST_ADMIN_MESSAGE),
        );
      }
      expect(LAST_ADMIN_MESSAGE).toContain('a loja ficaria sem administrador');
      // Lista vazia (ex.: dados inconsistentes) também protege
      expect(() => assertKeepsAnAdmin(activeAdmin, null, [])).toThrow(
        BadRequestException,
      );
    });

    it('com outro ADMIN ativo na loja, a operação é permitida', () => {
      expect(() =>
        assertKeepsAnAdmin(activeAdmin, UserRole.KITCHEN, [1, 2]),
      ).not.toThrow();
      expect(() => assertKeepsAnAdmin(activeAdmin, null, [2, 1])).not.toThrow();
    });

    it('contas que não são ADMIN ativo nunca são barradas', () => {
      expect(() => assertKeepsAnAdmin(courier, null, [])).not.toThrow();
      expect(() => assertKeepsAnAdmin(trashedAdmin, null, [])).not.toThrow();
      expect(() =>
        assertKeepsAnAdmin(activeAdmin, UserRole.ADMIN, [1]),
      ).not.toThrow();
    });
  });
});
