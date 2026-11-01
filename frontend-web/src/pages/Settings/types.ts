import type { StoreSettings, StoreSettingsUpdate } from '../../services/storeSettingsService';

/** Seções da tela (também o valor de ?secao= na URL). */
export type SectionId = 'dados' | 'endereco' | 'operacao' | 'entrega' | 'horarios' | 'fuso' | 'identidade' | 'pagamentos';

export const SECTION_IDS: readonly SectionId[] = ['dados', 'endereco', 'operacao', 'entrega', 'horarios', 'fuso', 'identidade', 'pagamentos'];

/** Campos que cada seção edita ou exibe (a seção recomeça quando eles mudam na API). */
export const SECTION_FIELDS = {
  dados: ['name', 'legal_name', 'document', 'email', 'phone', 'description'],
  endereco: ['address_zip_code', 'address_street', 'address_number', 'address_complement', 'address_neighborhood', 'address_city', 'address_state'],
  operacao: ['opening_message', 'closing_message'],
  entrega: ['delivery_enabled', 'takeout_enabled', 'takeout_estimate', 'delivery_zones', 'is_default_store'],
  horarios: ['opening_hours'],
  fuso: ['time_zone'],
  // O logo é enviado na hora (sem rascunho): trocar o logo não descarta a cor em edição
  identidade: ['primary_color', 'features'],
  pagamentos: ['payments', 'features'],
} as const satisfies Record<SectionId, readonly (keyof StoreSettings)[]>;

export function isSectionId(value: unknown): value is SectionId {
  return typeof value === 'string' && (SECTION_IDS as readonly string[]).includes(value);
}

export interface SectionProps {
  settings: StoreSettings;
  /** Sessão de suporte: nada pode ser salvo. */
  readOnly: boolean;
  /** Configurações salvas: a página troca os dados e atualiza sessão/status conforme os campos alterados. */
  onSaved: (next: StoreSettings, changed: readonly string[]) => void;
  /** Avisa a página se a seção tem alterações não salvas (selo na aba e aviso ao sair). */
  onDirtyChange: (id: SectionId, dirty: boolean) => void;
}

/**
 * Chave de uma seção a partir dos campos que ela edita: muda quando esses campos mudam na API
 * (a seção recomeça com os valores salvos) e não muda quando outra seção salva (o rascunho fica).
 */
export function sectionKey(settings: StoreSettings, fields: readonly (keyof StoreSettings)[]): string {
  return JSON.stringify(fields.map((field) => settings[field] ?? null));
}

/** Comparação de valores (inclusive listas e objetos) para montar só o que mudou. */
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Mantém só os campos com valor diferente do salvo. */
export function changedFields(settings: StoreSettings, candidate: StoreSettingsUpdate): StoreSettingsUpdate {
  const changes: StoreSettingsUpdate = {};
  for (const [field, value] of Object.entries(candidate) as [keyof StoreSettingsUpdate, unknown][]) {
    if (value === undefined) continue;
    if (!sameValue(value, settings[field])) Object.assign(changes, { [field]: value });
  }
  return changes;
}
