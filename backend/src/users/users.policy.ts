import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserRole } from './entities/user.entity';

/**
 * Regras de autorização dos usuários, em funções puras (sem banco) para facilitar os testes.
 * O "actor" é quem faz a requisição: req.user preenchido pela JwtStrategy, sempre com o perfil ATUAL.
 */
export interface Actor {
  id: number;
  role: UserRole;
}

export function isAdmin(actor?: Actor | null): boolean {
  return actor?.role === UserRole.ADMIN;
}

/** Ver ou editar um usuário: só o dono da conta ou um ADMIN. */
export function assertSelfOrAdmin(
  actor: Actor | null | undefined,
  userId: number,
): void {
  if (!actor || (!isAdmin(actor) && actor.id !== userId)) {
    throw new ForbiddenException(
      'Você não tem permissão para acessar este usuário.',
    );
  }
}

/**
 * Cadastro: sem perfil (ou CLIENT) cria um cliente.
 * Qualquer outro perfil (equipe ou ADMIN) exige um ADMIN autenticado.
 */
export function resolveSignupRole(
  requested: UserRole | undefined,
  actor?: Actor | null,
): UserRole {
  const role = requested ?? UserRole.CLIENT;
  if (role !== UserRole.CLIENT && !isAdmin(actor)) {
    throw new ForbiddenException(
      'Somente administradores podem cadastrar contas da equipe.',
    );
  }
  return role;
}

/**
 * Edição: só ADMIN altera o perfil de acesso, e nunca o próprio (400).
 * Reenviar o próprio perfil sem mudança é aceito e ignorado; um não-admin pedindo outro perfil → 403.
 * Retorna o perfil a gravar, ou undefined quando não há mudança.
 */
export function resolveRoleChange(
  requested: UserRole | undefined,
  actor: Actor,
  targetId: number,
): UserRole | undefined {
  if (requested === undefined) return undefined;
  const isSelf = actor.id === targetId;

  if (isAdmin(actor)) {
    if (!isSelf) return requested;
    if (requested !== actor.role) {
      throw new BadRequestException(
        'Um administrador não pode alterar o próprio perfil de acesso. Peça a outro administrador.',
      );
    }
    return undefined;
  }

  if (requested !== actor.role) {
    throw new ForbiddenException(
      'Somente administradores podem alterar o perfil de acesso.',
    );
  }
  return undefined;
}

export const LAST_ADMIN_MESSAGE =
  'Operação recusada: o sistema ficaria sem nenhum administrador ativo. Promova outro usuário a administrador antes.';

/** Conta afetada por uma alteração: perfil atual e se já está na lixeira. */
export interface AccountState {
  id: number;
  role: UserRole;
  deleted_at?: Date | null;
}

/**
 * A operação tira a conta do grupo de ADMINs ativos (rebaixamento, lixeira ou exclusão definitiva)?
 * nextRole: perfil depois da operação, ou null quando a conta sai (lixeira ou exclusão definitiva).
 */
export function removesActiveAdmin(
  target: AccountState,
  nextRole: UserRole | null,
): boolean {
  return (
    target.role === UserRole.ADMIN &&
    !target.deleted_at &&
    nextRole !== UserRole.ADMIN
  );
}

/**
 * Nenhuma operação pode deixar o sistema sem ADMIN ativo (400).
 * activeAdminIds: ids dos ADMINs ativos no momento (inclusive a própria conta afetada).
 */
export function assertKeepsAnAdmin(
  target: AccountState,
  nextRole: UserRole | null,
  activeAdminIds: number[],
): void {
  if (!removesActiveAdmin(target, nextRole)) return;
  if (!activeAdminIds.some((id) => id !== target.id)) {
    throw new BadRequestException(LAST_ADMIN_MESSAGE);
  }
}

/** Exclusão: a própria conta ou um ADMIN — mas o ADMIN não pode excluir a própria conta. */
export function assertCanDeleteUser(
  actor: Actor | null | undefined,
  userId: number,
): void {
  if (actor && isAdmin(actor)) {
    if (actor.id === userId) {
      throw new BadRequestException(
        'Um administrador não pode excluir a própria conta.',
      );
    }
    return;
  }
  if (!actor || actor.id !== userId) {
    throw new ForbiddenException(
      'Você não tem permissão para excluir este usuário.',
    );
  }
}
