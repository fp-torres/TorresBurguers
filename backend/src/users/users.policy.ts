import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PlatformRole, UserRole } from './entities/user.entity';

/**
 * Regras de autorização das contas e da equipe da loja, em funções puras (sem banco) para facilitar
 * os testes. O "actor" é quem faz a requisição: req.user preenchido pela JwtStrategy, sempre com o
 * perfil, a loja e o papel global ATUAIS do banco (nunca do token, do corpo ou da URL).
 */
export interface Actor {
  id: number;
  role: UserRole;
  /** Loja da equipe (null para clientes e para a administração da plataforma). */
  storeId: number | null;
  platformRole?: PlatformRole | null;
  /** Token de acesso assistido do suporte (somente leitura). */
  supportSession?: unknown;
}

/** Perfis da equipe de uma loja (o resto é cliente). */
export const STAFF_ROLES: readonly UserRole[] = [
  UserRole.ADMIN,
  UserRole.EMPLOYEE,
  UserRole.KITCHEN,
  UserRole.COURIER,
];

export function isStaffRole(role: unknown): role is UserRole {
  return STAFF_ROLES.includes(role as UserRole);
}

export const STAFF_ROLE_REQUIRED_MESSAGE =
  'Escolha um perfil da equipe: ADMIN, EMPLOYEE, KITCHEN ou COURIER. Clientes se cadastram sozinhos pela loja.';
export const SUPPORT_READ_ONLY_MESSAGE =
  'Sessão de suporte é somente leitura: nenhuma alteração pode ser feita.';
export const ADMIN_SELF_DELETE_MESSAGE =
  'Um administrador não pode excluir a própria conta.';
export const PLATFORM_SELF_DELETE_MESSAGE =
  'A conta da administração da plataforma não pode ser excluída por aqui.';

/** Falha fechada: sem uma loja validada, nenhuma consulta ou escrita da equipe acontece. */
export function assertStoreId(storeId: unknown): asserts storeId is number {
  if (
    typeof storeId !== 'number' ||
    !Number.isInteger(storeId) ||
    storeId < 1
  ) {
    throw new ForbiddenException('Loja da equipe não identificada.');
  }
}

export function isAdmin(actor?: Pick<Actor, 'role'> | null): boolean {
  return actor?.role === UserRole.ADMIN;
}

/** ADMIN de uma loja (inclusive sessão de suporte, que só lê). */
export function isStoreAdmin(actor?: Actor | null): actor is Actor & {
  storeId: number;
} {
  return (
    isAdmin(actor) &&
    typeof actor?.storeId === 'number' &&
    Number.isInteger(actor.storeId) &&
    actor.storeId > 0
  );
}

/** Alterações nunca partem de uma sessão de suporte (somente leitura). */
export function assertWritable(actor?: Actor | null): void {
  if (actor?.supportSession) {
    throw new ForbiddenException(SUPPORT_READ_ONLY_MESSAGE);
  }
}

/**
 * Como a rota /users/:id alcança o usuário:
 * - self: a própria conta;
 * - team: ADMIN da loja agindo sobre a EQUIPE da própria loja (o serviço procura o alvo só nessa
 *   loja: cliente, outra loja, conta da plataforma ou inexistente → 404 uniforme).
 */
export type UserAccess = 'self' | 'team';

/** GET/PATCH /users/:id: a própria conta, ou ADMIN da loja (403 para os demais perfis). */
export function resolveUserAccess(
  actor: Actor | null | undefined,
  userId: number,
): UserAccess {
  if (actor && actor.id === userId) return 'self';
  if (isStoreAdmin(actor)) return 'team';
  throw new ForbiddenException(
    'Você não tem permissão para acessar este usuário.',
  );
}

/** Resultado do POST /users: cadastro público de cliente ou conta da equipe da loja do ADMIN. */
export type SignupPlan =
  | { kind: 'client' }
  | { kind: 'staff'; role: UserRole; storeId: number };

/**
 * POST /users:
 * - sem token, ou com token que não é de ADMIN de loja: cadastro de cliente (sem perfil ou CLIENT);
 *   perfil da equipe → 403;
 * - ADMIN de loja: conta da EQUIPE da própria loja (perfil obrigatório e da equipe; CLIENT → 400).
 * A loja vem sempre do ADMIN autenticado (nunca do corpo).
 */
export function resolveSignup(
  requested: UserRole | undefined,
  actor?: Actor | null,
): SignupPlan {
  if (isStoreAdmin(actor)) {
    assertWritable(actor);
    if (!isStaffRole(requested)) {
      throw new BadRequestException(STAFF_ROLE_REQUIRED_MESSAGE);
    }
    return { kind: 'staff', role: requested, storeId: actor.storeId };
  }
  if (requested !== undefined && requested !== UserRole.CLIENT) {
    throw new ForbiddenException(
      'Somente administradores podem cadastrar contas da equipe.',
    );
  }
  return { kind: 'client' };
}

/**
 * Edição do perfil de acesso (PATCH /users/:id). Retorna o perfil a gravar, ou undefined sem mudança.
 * - Na própria conta ninguém muda o perfil: reenviar o mesmo é aceito e ignorado; ADMIN pedindo outro
 *   → 400; demais perfis → 403 (sem escalada de privilégio).
 * - ADMIN da loja na equipe da própria loja: só entre perfis da equipe (CLIENT → 400).
 */
export function resolveRoleChange(
  requested: UserRole | undefined,
  actor: Actor,
  targetId: number,
): UserRole | undefined {
  if (requested === undefined) return undefined;

  if (actor.id === targetId) {
    if (requested === actor.role) return undefined;
    if (isAdmin(actor)) {
      throw new BadRequestException(
        'Um administrador não pode alterar o próprio perfil de acesso. Peça a outro administrador.',
      );
    }
    throw new ForbiddenException(
      'Somente administradores podem alterar o perfil de acesso.',
    );
  }

  if (!isStoreAdmin(actor)) {
    throw new ForbiddenException(
      'Somente administradores podem alterar o perfil de acesso.',
    );
  }
  if (!isStaffRole(requested)) {
    throw new BadRequestException(
      'O perfil de um membro da equipe só pode ser trocado por outro perfil da equipe (ADMIN, EMPLOYEE, KITCHEN ou COURIER).',
    );
  }
  return requested;
}

/**
 * DELETE /users/:id (lixeira): a própria conta ou ADMIN da loja na equipe da própria loja.
 * O ADMIN não exclui a própria conta (400) e a administração da plataforma não é excluída por aqui.
 */
export function assertCanDeleteUser(
  actor: Actor | null | undefined,
  userId: number,
): UserAccess {
  if (actor && actor.id === userId) {
    if (isAdmin(actor)) {
      throw new BadRequestException(ADMIN_SELF_DELETE_MESSAGE);
    }
    if (actor.platformRole) {
      throw new BadRequestException(PLATFORM_SELF_DELETE_MESSAGE);
    }
    return 'self';
  }
  if (isStoreAdmin(actor)) return 'team';
  throw new ForbiddenException(
    'Você não tem permissão para excluir este usuário.',
  );
}

export const LAST_ADMIN_MESSAGE =
  'Operação recusada: a loja ficaria sem administrador. Promova outro membro da equipe a administrador antes.';

/** Conta afetada por uma alteração: perfil atual, lixeira e bloqueio. */
export interface AccountState {
  id: number;
  role: UserRole;
  deleted_at?: Date | null;
  blocked_at?: Date | null;
}

/**
 * A operação tira a conta do grupo de ADMINs ativos da loja (rebaixamento, lixeira ou exclusão)?
 * Ativo = fora da lixeira e sem bloqueio. nextRole: perfil depois da operação, ou null quando a conta sai.
 */
export function removesActiveAdmin(
  target: AccountState,
  nextRole: UserRole | null,
): boolean {
  return (
    target.role === UserRole.ADMIN &&
    !target.deleted_at &&
    !target.blocked_at &&
    nextRole !== UserRole.ADMIN
  );
}

/**
 * Nenhuma operação pode deixar a loja sem ADMIN ativo (400).
 * activeAdminIds: ids dos ADMINs ativos da loja do alvo (inclusive a própria conta afetada).
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
