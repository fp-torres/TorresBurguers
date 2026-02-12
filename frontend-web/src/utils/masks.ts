export const normalizeCurrency = (value: string | number) => {
  if (!value) return '';
  // Remove tudo que não é dígito
  const onlyDigits = String(value).replace(/\D/g, '');
  // Divide por 100 para ter os centavos
  const number = Number(onlyDigits) / 100;
  // Formata para BRL
  return number.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
};

export const normalizePhone = (value: string) => {
  if (!value) return '';
  
  // Remove tudo que não é dígito
  const onlyDigits = value.replace(/\D/g, '');
  
  // Aplica a máscara (99) 99999-9999
  return onlyDigits
    .replace(/^(\d{2})(\d)/g, '($1) $2')
    .replace(/(\d)(\d{4})$/, '$1-$2')
    .slice(0, 15); // Limita tamanho
};

// Remove a formatação para enviar ao banco (R$ 10,00 -> 10.00)
export const currencyToNumber = (value: string) => {
  if (!value) return 0;
  return Number(value.replace(/\D/g, '')) / 100;
};