// Kit de UI do painel, do superpainel e das telas de conta (tema claro/escuro, acessível e responsivo).
// Uso: import { PageHeader, DataTable, Pagination } from '../../components/ui';

export { default as PageHeader } from './PageHeader';
export type { PageHeaderProps } from './PageHeader';

export { default as DataTable } from './DataTable';
export type { ColumnAlign, ColumnMobileRole, DataTableColumn, DataTableProps } from './DataTable';

export { default as Pagination } from './Pagination';
export type { PaginationProps } from './Pagination';

export { default as SearchInput } from './SearchInput';
export type { SearchInputProps } from './SearchInput';

export { default as FilterTabs } from './FilterTabs';
export type { FilterTabOption, FilterTabsProps } from './FilterTabs';

export { default as StatusBadge } from './StatusBadge';
export type { StatusBadgeProps, StatusTone } from './StatusBadge';

export { default as EmptyState } from './EmptyState';
export type { EmptyStateProps } from './EmptyState';

export { default as ErrorState } from './ErrorState';
export type { ErrorStateProps } from './ErrorState';

export { default as Modal } from './Modal';
export type { ModalProps, ModalSize } from './Modal';

export { default as FormField } from './FormField';
export type { FormFieldControlProps, FormFieldProps } from './FormField';

export { default as StatCard } from './StatCard';
export type { StatCardProps, StatCardTone } from './StatCard';

export { default as Tabs } from './Tabs';
export type { TabItem, TabsProps } from './Tabs';

export { default as CopyField } from './CopyField';
export type { CopyFieldProps } from './CopyField';

export { CARD_CLASS, buttonClass, cx, fieldControlClass } from './styles';
export type { ButtonSize, ButtonVariant } from './styles';

export { default as Switch } from './Switch';
export type { SwitchProps } from './Switch';
