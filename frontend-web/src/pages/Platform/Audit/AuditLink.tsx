import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { History } from 'lucide-react';
import { buttonClass, type ButtonSize, type ButtonVariant } from '../../../components/ui';

interface AuditLinkProps {
  /** Endereço da auditoria já filtrada (auditUrl em ./urlFilters). */
  to: string;
  /** Nome acessível completo e dica (ex.: "Ver auditoria da fatura #9"); começa pelo texto visível, se houver. */
  label: string;
  /** Texto visível ao lado do ícone (pode ser escondido em telas pequenas pelo chamador). */
  children?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Ex.: fechar o diálogo que contém o link. */
  onClick?: () => void;
  className?: string;
}

/**
 * Link "Ver auditoria" com cara de botão: abre /platform/audit filtrada (por alvo, autor ou loja). Usado no
 * detalhe da conta, nos planos, no detalhe da assinatura e nas faturas.
 */
export default function AuditLink({ to, label, children, variant = 'secondary', size = 'sm', onClick, className }: AuditLinkProps) {
  return (
    <Link to={to} onClick={onClick} aria-label={label} title={label} className={buttonClass(variant, size, className)}>
      <History size={size === 'icon' ? 16 : 14} aria-hidden="true" />
      {children}
    </Link>
  );
}
