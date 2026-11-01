import { useState } from 'react';
import { assetUrl } from '../../services/api';
import { contrastRatio, normalizeHexColor } from '../../services/storefrontDisplay';

interface StoreLogoProps {
  /** Nome da loja: texto alternativo do logo e inicial quando não há logo. */
  name: string;
  /** Arquivo do logo em /uploads (ou URL absoluta). */
  logo: string | null | undefined;
  /** Lado em pixels. */
  size?: number;
  /**
   * Cor da loja para a inicial (#RRGGBB). Sem ela, a inicial usa os tokens da vitrine
   * (bg-brand: a cor da loja aberta ou o laranja da plataforma).
   */
  color?: string | null;
  /** true: o nome já aparece ao lado (o logo vira decorativo para leitores de tela). */
  decorative?: boolean;
  className?: string;
}

/** Logo da loja (identidade da LOJA, vinda da API) ou a inicial do nome se não houver logo ou ele falhar. */
export default function StoreLogo({ name, logo, size = 40, color, decorative = false, className = '' }: StoreLogoProps) {
  const src = assetUrl(logo);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const radius = size >= 56 ? 'rounded-2xl' : 'rounded-xl';
  const dimensions = { width: size, height: size };

  if (src && failedSrc !== src) {
    return (
      <img
        src={src}
        alt={decorative ? '' : `Logo de ${name}`}
        width={size}
        height={size}
        loading="lazy"
        onError={() => setFailedSrc(src)}
        style={dimensions}
        className={`${radius} object-cover bg-white dark:bg-slate-800 border border-gray-100 dark:border-slate-700 shrink-0 ${className}`}
      />
    );
  }

  const hex = normalizeHexColor(color);
  const initial = name.trim().charAt(0).toUpperCase() || '?';
  const style = hex
    ? { ...dimensions, backgroundColor: hex, color: contrastRatio(hex, '#ffffff') >= 3 ? '#ffffff' : '#111827' }
    : dimensions;

  return (
    <span
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : `Logo de ${name}`}
      aria-hidden={decorative ? true : undefined}
      style={style}
      className={`${radius} ${hex ? '' : 'bg-brand text-brand-contrast'} inline-flex items-center justify-center font-extrabold shrink-0 select-none ${className}`}
    >
      <span style={{ fontSize: Math.max(12, Math.round(size * 0.45)) }} className="leading-none">{initial}</span>
    </span>
  );
}
