import { useId } from 'react';
import { BRAND } from '../../config/brand';

/** Fundo onde o logo aparece: 'light' (texto escuro), 'dark' (texto claro) ou 'auto' (segue o tema). */
export type BrandLogoTone = 'auto' | 'light' | 'dark';

interface BrandMarkProps {
  /** Lado do ícone em pixels. */
  size?: number;
  className?: string;
  /** Texto alternativo; sem ele o ícone é decorativo (o nome já aparece ao lado). */
  title?: string;
}

/** Ícone da marca (mesma arte do favicon): comanda com check sobre fundo laranja. */
export function BrandMark({ size = 40, className = '', title }: BrandMarkProps) {
  // Id único por instância: vários logos na mesma página não disputam o mesmo gradiente
  const gradientId = `brand-gradient-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 1024 1024"
      width={size}
      height={size}
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title && <title>{title}</title>}
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fb923c" />
          <stop offset="1" stopColor="#ea580c" />
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" rx="230" fill={`url(#${gradientId})`} />
      <path
        d="M359.68 248.8H664.32Q713.6 248.8 713.6 298.08V775.2L680 737.12L646.4 775.2L612.8 737.12L579.2 775.2L545.6 737.12L512 775.2L478.4 737.12L444.8 775.2L411.2 737.12L377.6 775.2L344 737.12L310.4 775.2V298.08Q310.4 248.8 359.68 248.8Z"
        fill="#ffffff"
      />
      <rect x="379.84" y="351.84" width="264.32" height="33.6" rx="16.8" fill="#ea580c" />
      <rect x="379.84" y="430.24" width="197.12" height="33.6" rx="16.8" fill="#ea580c" />
      <rect x="379.84" y="508.64" width="134.4" height="33.6" rx="16.8" fill="#ea580c" />
      <path
        d="M498.56 618.4l49.28 49.28l103.04-112"
        fill="none"
        stroke="#ea580c"
        strokeWidth="38.08"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface BrandLogoProps {
  /** Lado do ícone em pixels (o nome acompanha o tamanho). */
  size?: number;
  /** Exibe o nome do produto ao lado do ícone. */
  showName?: boolean;
  tone?: BrandLogoTone;
  /** Selo pequeno depois do nome (ex.: "Admin"). */
  badge?: string;
  className?: string;
  /** Classes extras do nome (ex.: esconder em telas estreitas). */
  nameClassName?: string;
}

const NAME_TONE: Record<BrandLogoTone, string> = {
  auto: 'text-gray-900 dark:text-white',
  light: 'text-gray-900',
  dark: 'text-white',
};

const BADGE_TONE: Record<BrandLogoTone, string> = {
  auto: 'bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300',
  light: 'bg-orange-100 text-orange-700',
  dark: 'bg-white/10 text-orange-300',
};

function nameSize(size: number): string {
  if (size >= 56) return 'text-3xl';
  if (size >= 44) return 'text-2xl';
  if (size >= 34) return 'text-xl';
  return 'text-lg';
}

/** Logo do produto: ícone + nome (BRAND.name, configurável por VITE_APP_NAME). */
export default function BrandLogo({
  size = 40,
  showName = true,
  tone = 'auto',
  badge,
  className = '',
  nameClassName = '',
}: BrandLogoProps) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <BrandMark size={size} title={showName ? undefined : BRAND.name} className="shrink-0 drop-shadow-sm" />
      {showName && (
        <span className={`font-extrabold tracking-tight leading-none ${nameSize(size)} ${NAME_TONE[tone]} ${nameClassName}`}>
          {BRAND.name}
        </span>
      )}
      {badge && (
        <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md leading-none ${BADGE_TONE[tone]}`}>
          {badge}
        </span>
      )}
    </span>
  );
}
