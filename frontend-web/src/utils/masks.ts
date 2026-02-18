// --- MÁSCARAS GERAIS ---

// Formata Moeda (Input): Transforma 1000 em "R$ 10,00"
export const maskMoney = (value: string | number) => {
  if (!value) return '';
  const onlyDigits = String(value).replace(/\D/g, '');
  const number = Number(onlyDigits) / 100;
  return number.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
};

// Aliases para evitar erros de importação em outros componentes
export const normalizeCurrency = maskMoney;
export const maskCurrency = maskMoney;

// Formata Celular ou Fixo:
// 11 dígitos: (21) 96760-0280
// 10 dígitos: (21) 2555-5555
export const maskPhone = (value: string) => {
  if (!value) return '';
  
  // Remove tudo que não é dígito
  let r = value.replace(/\D/g, '');
  
  // Limita a 11 dígitos (2 DDD + 9 Número)
  r = r.substring(0, 11);

  // Se tiver mais de 10 dígitos, é Celular (9 dígitos no número)
  if (r.length > 10) {
    return r.replace(/^(\d\d)(\d{5})(\d{4}).*/, '($1) $2-$3');
  }
  
  // Se tiver mais de 5 dígitos, já começa a formatar como Fixo ou Celular incompleto
  if (r.length > 5) {
    return r.replace(/^(\d\d)(\d{4})(\d{0,4}).*/, '($1) $2-$3');
  }
  
  // Apenas DDD e começo do número
  if (r.length > 2) {
    return r.replace(/^(\d\d)(\d{0,5}).*/, '($1) $2');
  }
  
  // Apenas DDD
  if (r.length > 0) {
    return r.replace(/^(\d*)/, '($1');
  }
  
  return r;
};

export const normalizePhone = maskPhone;

// Formata CPF: 000.000.000-00
export const maskCPF = (value: string) => {
  return value
    .replace(/\D/g, '')
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d{1,2})/, '$1-$2')
    .replace(/(-\d{2})\d+?$/, '$1');
};

// --- MÁSCARAS DE CARTÃO ---

export const maskCardNumber = (value: string) => {
  return value
    .replace(/\D/g, '')
    .replace(/(\d{4})/g, '$1 ')
    .trim()
    .substring(0, 19);
};

export const maskDate = (value: string) => {
  return value
    .replace(/\D/g, '')
    .replace(/(\d{2})(\d)/, '$1/$2')
    .substring(0, 5);
};

// --- UTILITÁRIOS EXTRAS ---

export const currencyToNumber = (value: string) => {
  if (!value) return 0;
  return Number(value.replace(/\D/g, '')) / 100;
};