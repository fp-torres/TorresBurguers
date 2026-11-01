import { maskPhone } from '../../utils/masks';

// O telefone do cliente é texto livre no cadastro (ex.: "(21) 98765-4321", "+55 21 98765-4321").

/** DDD + número (10 ou 11 dígitos, sem o código do país) ou null se o texto não tiver esse formato. */
export function customerPhoneDigits(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  const local = /^55\d{10,11}$/.test(digits) ? digits.slice(2) : digits;
  return /^\d{10,11}$/.test(local) ? local : null;
}

/** Telefone para exibir: com máscara quando reconhecido; senão, como foi cadastrado. */
export function formatCustomerPhone(phone: string | null | undefined): string {
  const digits = customerPhoneDigits(phone);
  return digits ? maskPhone(digits) : (phone ?? '').trim();
}
