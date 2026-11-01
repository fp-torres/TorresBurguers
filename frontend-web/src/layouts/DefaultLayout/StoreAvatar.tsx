import { useState } from 'react';
import { assetUrl } from '../../services/api';
import { cx } from '../../components/ui';
import { readableTextColor, validHexColor } from './color';

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0][0] ?? '';
  const last = words.length > 1 ? words[words.length - 1][0] ?? '' : '';
  return `${first}${last}`.toUpperCase();
}

interface StoreAvatarProps {
  name: string;
  /** Arquivo do logo servido pela API (ou URL absoluta / blob de pré-visualização). */
  logo?: string | null;
  /** Cor principal da loja (#RRGGBB): fundo das iniciais quando não há logo. */
  color?: string | null;
  /** Lado em pixels (padrão: 40). */
  size?: number;
  /** Texto alternativo; sem ele o logo é decorativo (o nome da loja aparece ao lado). */
  alt?: string;
  className?: string;
}

/** Logo da loja ou, sem logo (ou se a imagem falhar), as iniciais sobre a cor principal. */
export default function StoreAvatar({ name, logo, color, size = 40, alt, className }: StoreAvatarProps) {
  const src = logo ? assetUrl(logo) : undefined;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const background = validHexColor(color);
  const style = { width: size, height: size };

  if (src && failedSrc !== src) {
    return (
      <img
        src={src}
        alt={alt ?? ''}
        onError={() => setFailedSrc(src)}
        style={style}
        className={cx('shrink-0 rounded-xl object-cover bg-white dark:bg-slate-700 border border-gray-200 dark:border-slate-600', className)}
      />
    );
  }

  return (
    <span
      role={alt ? 'img' : undefined}
      aria-label={alt}
      aria-hidden={alt ? undefined : true}
      style={{ ...style, fontSize: Math.max(11, Math.round(size * 0.38)), ...(background ? { backgroundColor: background, color: readableTextColor(background) } : {}) }}
      className={cx(
        'shrink-0 inline-flex items-center justify-center rounded-xl font-extrabold tracking-tight select-none',
        !background && 'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300',
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  );
}
