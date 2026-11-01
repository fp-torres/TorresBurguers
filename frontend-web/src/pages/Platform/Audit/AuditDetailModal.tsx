import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Modal, StatusBadge, buttonClass } from '../../../components/ui';
import type { AuditLogEntry } from '../../../services/platform/auditService';
import { formatDateTime } from '../../../utils/format';
import MetadataView from './MetadataView';
import { actionLabel, resultMeta, scopeLabel, targetLabel, targetPath, userAgentSummary } from './auditLabels';

interface AuditDetailModalProps {
  /** Registro escolhido (null = fechado). */
  entry: AuditLogEntry | null;
  onClose: () => void;
}

const LINK_CLASS = 'font-semibold text-orange-700 dark:text-orange-400 hover:underline rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="mt-0.5 text-sm text-gray-800 dark:text-gray-100 wrap-break-word">{children}</dd>
    </div>
  );
}

/** Detalhe de um registro da auditoria (ou evento de autenticação): quem, o quê, onde, de onde e os metadados. */
export default function AuditDetailModal({ entry, onClose }: AuditDetailModalProps) {
  return (
    <Modal
      open={!!entry}
      onClose={onClose}
      size="lg"
      title={entry ? actionLabel(entry.action) : 'Registro'}
      description={entry ? `Registro #${entry.id} · ${formatDateTime(entry.created_at)}` : undefined}
      footer={<button type="button" onClick={onClose} className={buttonClass('secondary')}>Fechar</button>}
    >
      {entry && <AuditDetail entry={entry} onNavigate={onClose} />}
    </Modal>
  );
}

function AuditDetail({ entry, onNavigate }: { entry: AuditLogEntry; onNavigate: () => void }) {
  const result = resultMeta(entry.result);
  const target = targetLabel(entry);
  const targetLink = targetPath(entry);
  const browser = userAgentSummary(entry.user_agent);

  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Ação">
          {actionLabel(entry.action)}
          <code className="block mt-0.5 text-xs font-mono text-gray-500 dark:text-gray-400">{entry.action}</code>
        </Field>
        <Field label="Resultado">
          <StatusBadge tone={result.tone} dot>{result.label}</StatusBadge>
        </Field>
        <Field label="Quem fez">
          {entry.actor ? (
            <>
              {entry.actor.id ? (
                <Link to={`/platform/users?usuario=${entry.actor.id}`} onClick={onNavigate} className={LINK_CLASS}>
                  {entry.actor.name || entry.actor.email || `Conta #${entry.actor.id}`}
                </Link>
              ) : (
                <span className="font-semibold">{entry.actor.name || entry.actor.email}</span>
              )}
              {entry.actor.email && entry.actor.name && (
                <span className="block text-xs text-gray-500 dark:text-gray-400 break-all">{entry.actor.email}</span>
              )}
              {!entry.actor.id && (
                <span className="block text-xs text-gray-500 dark:text-gray-400">E-mail informado na tentativa (sem conta identificada).</span>
              )}
            </>
          ) : (
            <span className="text-gray-500 dark:text-gray-400">
              {entry.actor_scope === 'SYSTEM' ? 'Rotina automática da plataforma' : 'Ninguém identificado'}
            </span>
          )}
          <span className="block text-xs text-gray-500 dark:text-gray-400">Origem: {scopeLabel(entry.actor_scope)}</span>
        </Field>
        <Field label="Estabelecimento">
          {entry.store ? (
            <Link to={`/platform/stores/${entry.store.id}`} onClick={onNavigate} className={LINK_CLASS}>{entry.store.name}</Link>
          ) : entry.store_id ? (
            `Loja #${entry.store_id}`
          ) : (
            <span className="text-gray-500 dark:text-gray-400">Nenhum (ação global)</span>
          )}
        </Field>
        <Field label="Alvo">
          {target ? (
            targetLink ? <Link to={targetLink} onClick={onNavigate} className={LINK_CLASS}>{target}</Link> : target
          ) : (
            <span className="text-gray-500 dark:text-gray-400">—</span>
          )}
        </Field>
        <Field label="Endereço IP">
          {entry.ip ? <code className="font-mono text-xs">{entry.ip}</code> : <span className="text-gray-500 dark:text-gray-400">Não registrado</span>}
        </Field>
        <div className="sm:col-span-2">
          <Field label="Navegador / aplicativo">
            {entry.user_agent ? (
              <>
                {browser && <span className="font-semibold">{browser}</span>}
                <span className="block text-xs font-mono text-gray-500 dark:text-gray-400 break-all">{entry.user_agent}</span>
              </>
            ) : (
              <span className="text-gray-500 dark:text-gray-400">Não registrado</span>
            )}
          </Field>
        </div>
      </dl>

      <MetadataView metadata={entry.metadata} />
    </div>
  );
}
