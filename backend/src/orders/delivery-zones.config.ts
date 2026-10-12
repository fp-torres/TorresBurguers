/**
 * Zonas de entrega padrão (taxa e tempo estimado por bairro).
 *
 * Valores de demonstração (bairros do Rio de Janeiro). Para cada instalação, edite esta tabela
 * ou defina no .env, sem recompilar:
 * - DELIVERY_ZONES_JSON: o JSON da configuração na própria variável;
 * - DELIVERY_ZONES_FILE: caminho de um arquivo .json com a configuração.
 * Formato: { "fallback": { "fee": 15, "time": "50-60 min" },
 *            "zones": [{ "neighborhoods": ["Centro"], "cities": ["Rio de Janeiro"], "fee": 5, "time": "30-40 min" }] }
 * ("cities" é opcional; sem ele a zona vale para qualquer cidade.)
 *
 * O bairro precisa casar com o nome INTEIRO (sem diferenciar maiúsculas e acentos):
 * "Barra Funda" não cai em "Barra". Bairro fora de todas as zonas usa o "fallback".
 */
import type { DeliveryZonesConfig } from './order-rules';

export const DEFAULT_DELIVERY_ZONES: DeliveryZonesConfig = {
  fallback: { fee: 15, time: '50-60 min' },
  zones: [
    {
      neighborhoods: ['Centro', 'Lapa', 'Santa Teresa'],
      fee: 5,
      time: '30-40 min',
    },
    {
      neighborhoods: ['Flamengo', 'Botafogo', 'Laranjeiras'],
      fee: 7,
      time: '40-50 min',
    },
    {
      neighborhoods: ['Copacabana', 'Ipanema', 'Leblon'],
      fee: 10,
      time: '50-60 min',
    },
    {
      neighborhoods: [
        'Barra da Tijuca',
        'Barra',
        'Recreio dos Bandeirantes',
        'Recreio',
      ],
      fee: 20,
      time: '60-80 min',
    },
    {
      neighborhoods: ['Tijuca', 'Maracanã'],
      fee: 12,
      time: '50-60 min',
    },
  ],
};
