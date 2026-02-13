// --- MÁSCARAS DE PAGAMENTO (Novas) ---

// Formata: 0000 0000 0000 0000
export const maskCardNumber = (value: string) => {
  return value
    .replace(/\D/g, '') // Remove letras
    .replace(/(\d{4})/g, '$1 ') // Adiciona espaço a cada 4 dígitos
    .trim()
    .substring(0, 19); // Limita tamanho máximo
};

// Formata: MM/AA
export const maskDate = (value: string) => {
  return value
    .replace(/\D/g, '')
    .replace(/(\d{2})(\d)/, '$1/$2') // Adiciona a barra depois do mês
    .substring(0, 5); // Limita tamanho (ex: 12/25)
};

// Formata: 000.000.000-00
export const maskCPF = (value: string) => {
  return value
    .replace(/\D/g, '')
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d{1,2})/, '$1-$2')
    .replace(/(-\d{2})\d+?$/, '$1'); // Impede digitar mais que o necessário
};

// --- SUAS MÁSCARAS EXISTENTES (Formatadas e Padronizadas) ---

// Formata Telefone: (99) 99999-9999
export const maskPhone = (value: string) => {
  if (!value) return '';
  const onlyDigits = value.replace(/\D/g, '');
  return onlyDigits
    .replace(/^(\d{2})(\d)/g, '($1) $2')
    .replace(/(\d)(\d{4})$/, '$1-$2')
    .slice(0, 15);
};
// Mantive o nome antigo também caso você use em outros lugares
export const normalizePhone = maskPhone;

// Formata Moeda Visualmente: R$ 10,00
export const maskCurrency = (value: string | number) => {
  if (!value) return 'R$ 0,00';
  const onlyDigits = String(value).replace(/\D/g, '');
  const number = Number(onlyDigits) / 100;
  return number.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
};
// Mantive o nome antigo também
export const normalizeCurrency = maskCurrency;

// Converte R$ 10,00 para number (10.00) - Útil para enviar ao Backend
export const currencyToNumber = (value: string) => {
  if (!value) return 0;
  return Number(value.replace(/\D/g, '')) / 100;
};