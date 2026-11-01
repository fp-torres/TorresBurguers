/**
 * Pede ao menu do painel/superpainel para abrir "Minha conta" (e-mail e senha da própria conta). Usado por
 * telas que não têm acesso ao estado do menu, como o MemberModal ao editar a si mesmo.
 */
export const OPEN_MY_ACCOUNT_EVENT = 'comestra:open-my-account';

export function openMyAccount(): void {
  window.dispatchEvent(new Event(OPEN_MY_ACCOUNT_EVENT));
}
