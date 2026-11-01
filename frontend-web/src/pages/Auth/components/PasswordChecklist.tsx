import { Check } from 'lucide-react';
import { PASSWORD_TOO_LONG_MESSAGE, checkPassword, isPasswordTooLong } from '../../../utils/password';

/** Requisitos da senha (mesma política da API), marcados conforme a pessoa digita. */
export default function PasswordChecklist({ password, id }: { password: string; id?: string }) {
  const checks = checkPassword(password);
  const items = [
    { ok: checks.length, label: 'Mínimo de 9 caracteres' },
    { ok: checks.upper, label: 'Uma letra maiúscula' },
    { ok: checks.numberOrSymbol, label: 'Um número ou símbolo' },
  ];

  return (
    <ul id={id} className="text-xs space-y-1" aria-label="Requisitos da senha">
      {items.map((item) => (
        <li key={item.label} className={`flex items-center gap-1.5 ${item.ok ? 'text-green-600 dark:text-green-400 font-bold' : 'text-gray-500 dark:text-gray-400'}`}>
          {item.ok
            ? <Check size={12} aria-hidden="true" />
            : <span className="w-3 h-3 rounded-full bg-gray-300 dark:bg-slate-600" aria-hidden="true" />}
          {item.label}
          <span className="sr-only">{item.ok ? '(atendido)' : '(pendente)'}</span>
        </li>
      ))}
      {isPasswordTooLong(password) && <li className="text-red-500 font-bold">{PASSWORD_TOO_LONG_MESSAGE}</li>}
    </ul>
  );
}
