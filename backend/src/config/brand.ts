/**
 * Identidade do produto (white-label).
 * Para renomear o sistema altere aqui; para trocar apenas o nome exibido em uma instalação,
 * defina APP_NAME no .env. O getter lê o .env em tempo de uso (ele é carregado pelo ConfigModule).
 */
export const BRAND = {
  get name(): string {
    return process.env.APP_NAME || 'Comestra';
  },
  slug: 'comestra',
  domain: 'comestra.com.br',
};
