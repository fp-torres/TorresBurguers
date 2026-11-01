// Classes compartilhadas pelo kit de UI (mesmo visual do painel: cartões brancos/slate, laranja, cantos arredondados).
// Ficam fora dos componentes para que cada arquivo .tsx exporte só componentes (Fast Refresh).

/** Junta classes ignorando valores vazios: cx('a', cond && 'b', undefined) → "a b". */
export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

/** Cartão padrão das telas do painel. */
export const CARD_CLASS = 'bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-700 transition-colors';

/** Input, select e textarea do kit; com `invalid` a borda e o anel de foco ficam vermelhos. */
export function fieldControlClass(invalid = false, extra?: string): string {
  return cx(
    'w-full px-4 py-2.5 rounded-xl border outline-none transition-all text-sm',
    'bg-white dark:bg-slate-800 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500',
    'focus:ring-2 disabled:opacity-60 disabled:cursor-not-allowed',
    invalid
      ? 'border-red-400 dark:border-red-500 focus:ring-red-200 dark:focus:ring-red-900/60 focus:border-red-500'
      : 'border-gray-200 dark:border-slate-700 focus:ring-orange-500 focus:border-orange-500',
    extra,
  );
}

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
/** 'icon': botão quadrado só com ícone (dê um aria-label). */
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-orange-600 hover:bg-orange-700 text-white shadow-lg shadow-orange-200 dark:shadow-none',
  secondary: 'bg-white dark:bg-slate-700 border border-gray-300 dark:border-slate-600 text-gray-700 dark:text-white hover:bg-gray-100 dark:hover:bg-slate-600',
  danger: 'bg-red-600 hover:bg-red-700 text-white shadow-lg shadow-red-200 dark:shadow-none',
  ghost: 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'px-3 py-2 text-xs',
  md: 'px-5 py-2.5 text-sm',
  lg: 'px-6 py-3 text-sm',
  icon: 'p-2.5 text-sm',
};

/**
 * Classes de botão (também servem para <Link> com cara de botão).
 * Em `extra`, evite classes que disputam a mesma propriedade das do botão (ex.: padding, display):
 * no Tailwind a ordem das classes no atributo não define quem vence. Use variantes (ex.: max-sm:hidden).
 */
export function buttonClass(variant: ButtonVariant = 'primary', size: ButtonSize = 'md', extra?: string): string {
  return cx(
    'inline-flex items-center justify-center gap-2 rounded-xl font-bold transition-colors',
    'disabled:opacity-60 disabled:cursor-not-allowed',
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900',
    BUTTON_VARIANTS[variant],
    BUTTON_SIZES[size],
    extra,
  );
}
