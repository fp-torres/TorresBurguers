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
export const maskPhone = (value: string) => {
  if (!value) return '';
  let r = value.replace(/\D/g, '');
  r = r.substring(0, 11);

  if (r.length > 10) {
    return r.replace(/^(\d\d)(\d{5})(\d{4}).*/, '($1) $2-$3');
  }
  if (r.length > 5) {
    return r.replace(/^(\d\d)(\d{4})(\d{0,4}).*/, '($1) $2-$3');
  }
  if (r.length > 2) {
    return r.replace(/^(\d\d)(\d{0,5}).*/, '($1) $2');
  }
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

// --- MÁSCARA DE CEP ---
export const maskCEP = (value: string) => {
  return value
    .replace(/\D/g, '') // Remove tudo que não é dígito
    .replace(/^(\d{5})(\d)/, '$1-$2') // Coloca o traço após o 5º dígito
    .substring(0, 9); // Limita a 9 caracteres
};

// --- UTILITÁRIOS EXTRAS ---

export const currencyToNumber = (value: string) => {
  if (!value) return 0;
  return Number(value.replace(/\D/g, '')) / 100;
};