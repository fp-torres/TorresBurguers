// Cores da identidade da loja (primary_color #RRGGBB vindo da API).

export const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** A cor no formato #RRGGBB ou null. */
export function validHexColor(color: string | null | undefined): string | null {
  return color && HEX_COLOR.test(color) ? color : null;
}

/** Luminância relativa (WCAG) de uma cor #RRGGBB. */
function relativeLuminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Texto escuro ou branco, o que tiver mais contraste sobre a cor. */
export function readableTextColor(hex: string): string {
  const luminance = relativeLuminance(hex);
  const contrastWithWhite = 1.05 / (luminance + 0.05);
  const contrastWithDark = (luminance + 0.05) / 0.0613; // #111827
  return contrastWithWhite >= contrastWithDark ? '#ffffff' : '#111827';
}
