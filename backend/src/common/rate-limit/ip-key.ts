import { isIPv4, isIPv6 } from 'node:net';

/** Endereço IPv4 escrito como IPv6 (::ffff:a.b.c.d), como o Node entrega em sockets dual-stack. */
const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** Grupos de 16 bits de um IPv6 válido (8 grupos; o IPv4 embutido no fim conta como 2). */
function ipv6Groups(address: string): string[] | null {
  const [head, tail, ...rest] = address.split('::');
  if (rest.length > 0) return null;
  const parse = (part: string | undefined): string[] => {
    if (!part) return [];
    return part.split(':').flatMap((group) => {
      if (!group.includes('.')) return [group];
      // IPv4 embutido (::1.2.3.4): vira dois grupos de 16 bits
      const [a, b, c, d] = group.split('.').map(Number);
      return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
    });
  };
  const left = parse(head);
  const right = parse(tail);
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 0) return null;
  return [...left, ...Array<string>(Math.max(missing, 0)).fill('0'), ...right];
}

/**
 * Chave de IP dos limites de tentativas:
 * - IPv4 (inclusive o IPv4 escrito como IPv6, ::ffff:a.b.c.d) → o próprio endereço;
 * - IPv6 → a rede /64 (os 4 primeiros grupos, sem zeros à esquerda): uma única conexão residencial
 *   ou um único servidor recebe um /64 inteiro (2^64 endereços), então contar endereço por endereço
 *   deixaria qualquer limite por IP sem efeito;
 * - qualquer outra coisa → o texto recebido, sem mudanças.
 */
export function ipRateLimitKey(ip: string): string {
  const text = ip.trim();
  const mapped = IPV4_MAPPED.exec(text);
  if (mapped && isIPv4(mapped[1])) return mapped[1];
  // Zona do IPv6 (fe80::1%eth0) não muda a rede
  const address = text.split('%')[0];
  if (!isIPv6(address)) return text;
  const groups = ipv6Groups(address.toLowerCase());
  if (!groups) return text;
  const prefix = groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ''))
    .join(':');
  return `${prefix}::/64`;
}
