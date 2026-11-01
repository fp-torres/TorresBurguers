import { useState } from 'react';
import { Globe2 } from 'lucide-react';
import { FormField, fieldControlClass } from '../../../components/ui';
import type { StoreSettings } from '../../../services/storeSettingsService';
import { useNow } from '../../../hooks/useNow';
import SettingsSection from '../SettingsSection';
import { changedFields, type SectionProps } from '../types';
import { useReportDirty, useSettingsSave } from '../useSettingsSave';
import { canonicalTimeZone } from '../validation';

/** Fusos oficiais do Brasil (IANA), com as regiões de cada um. */
const BRAZIL_TIME_ZONES: { id: string; label: string }[] = [
  { id: 'America/Sao_Paulo', label: 'Brasília (UTC−3) — SP, RJ, MG, ES, Sul, GO, DF' },
  { id: 'America/Bahia', label: 'Bahia (UTC−3)' },
  { id: 'America/Fortaleza', label: 'Fortaleza (UTC−3) — CE, RN, PB, PI, MA' },
  { id: 'America/Recife', label: 'Recife (UTC−3) — PE' },
  { id: 'America/Maceio', label: 'Maceió (UTC−3) — AL, SE' },
  { id: 'America/Belem', label: 'Belém (UTC−3) — PA (leste), AP' },
  { id: 'America/Santarem', label: 'Santarém (UTC−3) — PA (oeste)' },
  { id: 'America/Araguaina', label: 'Araguaína (UTC−3) — TO' },
  { id: 'America/Manaus', label: 'Manaus (UTC−4) — AM' },
  { id: 'America/Cuiaba', label: 'Cuiabá (UTC−4) — MT' },
  { id: 'America/Campo_Grande', label: 'Campo Grande (UTC−4) — MS' },
  { id: 'America/Porto_Velho', label: 'Porto Velho (UTC−4) — RO' },
  { id: 'America/Boa_Vista', label: 'Boa Vista (UTC−4) — RR' },
  { id: 'America/Rio_Branco', label: 'Rio Branco (UTC−5) — AC' },
  { id: 'America/Eirunepe', label: 'Eirunepé (UTC−5) — AM (oeste)' },
  { id: 'America/Noronha', label: 'Fernando de Noronha (UTC−2)' },
];

const OTHER = 'OTHER';

interface Draft {
  choice: string;
  other: string;
}

function draftFrom(settings: StoreSettings): Draft {
  const known = BRAZIL_TIME_ZONES.some((zone) => zone.id === settings.time_zone);
  return known ? { choice: settings.time_zone, other: '' } : { choice: OTHER, other: settings.time_zone };
}

function formatNowIn(timeZone: string, now: number): string | null {
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone,
      weekday: 'long',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(now);
  } catch {
    return null;
  }
}

/** Fuso da loja: define o "hoje" dos relatórios, o mês do limite de pedidos e os horários de funcionamento. */
export default function TimeZoneSection({ settings, readOnly, onSaved, onDirtyChange }: SectionProps) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(settings));
  const [showErrors, setShowErrors] = useState(false);
  const { saving, save } = useSettingsSave(onSaved);
  const now = useNow(30_000);

  const typed = draft.choice === OTHER ? draft.other.trim() : draft.choice;
  const canonical = canonicalTimeZone(typed);
  const changes = changedFields(settings, { time_zone: canonical ?? typed });
  const dirty = Object.keys(changes).length > 0;
  useReportDirty('fuso', dirty, onDirtyChange);

  const error = showErrors && !canonical ? 'Fuso horário inválido. Use um nome como America/Sao_Paulo.' : undefined;
  const preview = canonical ? formatNowIn(canonical, now) : null;

  async function handleSubmit() {
    if (!canonical) {
      setShowErrors(true);
      return;
    }
    await save(changedFields(settings, { time_zone: canonical }), 'Fuso horário salvo.');
  }

  return (
    <SettingsSection
      title="Fuso horário"
      description="Define o “hoje” dos relatórios e do Dashboard, o mês do limite de pedidos do plano e os horários de funcionamento."
      icon={<Globe2 size={20} />}
      dirty={dirty}
      saving={saving}
      readOnly={readOnly}
      onSubmit={handleSubmit}
      onDiscard={() => {
        setDraft(draftFrom(settings));
        setShowErrors(false);
      }}
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <FormField label="Fuso da loja" error={draft.choice === OTHER ? undefined : error}>
          {(field) => (
            <select
              {...field}
              value={draft.choice}
              onChange={(event) => {
                const choice = event.target.value;
                setDraft((current) => ({ ...current, choice }));
              }}
              disabled={readOnly}
              className={fieldControlClass(false)}
            >
              {BRAZIL_TIME_ZONES.map((zone) => <option key={zone.id} value={zone.id}>{zone.label}</option>)}
              <option value={OTHER}>Outro fuso (fora do Brasil)</option>
            </select>
          )}
        </FormField>

        {draft.choice === OTHER && (
          <FormField label="Nome do fuso (IANA)" error={error} hint="Ex.: America/Argentina/Buenos_Aires, Europe/Lisbon, UTC.">
            {(field) => (
              <input
                {...field}
                value={draft.other}
                onChange={(event) => {
                  const other = event.target.value;
                  setDraft((current) => ({ ...current, other }));
                }}
                maxLength={64}
                spellCheck={false}
                autoComplete="off"
                placeholder="America/Sao_Paulo"
                disabled={readOnly}
                className={fieldControlClass(!!error, 'font-mono')}
              />
            )}
          </FormField>
        )}
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-300" aria-live="polite">
        {preview
          ? <>Agora no fuso escolhido: <span className="font-bold capitalize">{preview}</span>.</>
          : 'Escolha um fuso válido para ver o horário local.'}
      </p>
    </SettingsSection>
  );
}
