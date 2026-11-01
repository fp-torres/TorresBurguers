import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Camera, Edit, Loader2, Plus, Shield, UserCog } from 'lucide-react';
import { openMyAccount } from '../../components/Account/events';
import toast from 'react-hot-toast';
import { Modal, buttonClass, fieldControlClass } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { avatarUrl, getApiErrorMessage } from '../../services/api';
import { sessionFromUpdate, userService, type UpdateUserPayload, type User } from '../../services/userService';
import { planRestrictionMessage } from '../../services/storeSubscriptionService';
import { toastPlanLimit } from '../../layouts/DefaultLayout/planLimit';
import { usePanelStore } from '../../layouts/DefaultLayout/panelStore';
import { normalizePhone } from '../../utils/masks';
import { PASSWORD_RULES_MESSAGE, PASSWORD_TOO_LONG_MESSAGE, isPasswordTooLong, isStrongPassword, passwordScore } from '../../utils/password';
import { TEAM_ROLE_OPTIONS, isTeamRole, type TeamRole } from './teamRoles';

// Novo membro começa com o perfil de menor acesso da gestão; Administrador é escolha explícita
const DEFAULT_NEW_ROLE: TeamRole = 'EMPLOYEE';

// Mesmas regras da API para a foto: JPG, PNG ou WebP até 5 MB
const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

interface FormState {
  name: string;
  phone: string;
  email: string;
  confirmEmail: string;
  role: TeamRole;
  password: string;
  confirmPassword: string;
}

interface MemberModalProps {
  open: boolean;
  /** Membro em edição (null = cadastro). */
  member: User | null;
  onClose: () => void;
  /** Depois de salvar: a tela recarrega a equipe (e o uso do plano). */
  onSaved: () => void;
}

/** Cadastro direto ou edição de um membro da equipe da loja. */
export default function MemberModal({ open, member, onClose, onSaved }: MemberModalProps) {
  if (!open) return null;
  // Cada abertura monta o formulário do zero (sem foto ou campos de uma edição anterior)
  return <MemberForm key={member?.id ?? 'novo'} member={member} onClose={onClose} onSaved={onSaved} />;
}

function initialForm(member: User | null): FormState {
  if (!member) {
    return { name: '', phone: '', email: '', confirmEmail: '', role: DEFAULT_NEW_ROLE, password: '', confirmPassword: '' };
  }
  return {
    name: member.name,
    phone: normalizePhone(member.phone || ''),
    email: member.email,
    confirmEmail: member.email,
    role: isTeamRole(member.role) ? member.role : DEFAULT_NEW_ROLE,
    password: '',
    confirmPassword: '',
  };
}

function MemberForm({ member, onClose, onSaved }: Omit<MemberModalProps, 'open'>) {
  const formId = useId();
  const nameId = useId();
  const phoneId = useId();
  const emailId = useId();
  const confirmEmailId = useId();
  const roleId = useId();
  const passwordId = useId();
  const confirmPasswordId = useId();
  const ownRoleHintId = useId();

  const { user: currentUser, updateUser, applyAuthResponse, refreshUser } = useAuth();
  const { refresh: refreshPanel } = usePanelStore();
  const [form, setForm] = useState<FormState>(() => initialForm(member));
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(() => avatarUrl(member?.avatar) ?? null);
  const [saving, setSaving] = useState(false);
  const objectUrlRef = useRef<string | null>(null);

  // Libera a pré-visualização local da foto ao fechar
  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
  }, []);

  const isEditing = !!member;
  // A API não deixa ninguém trocar o próprio cargo (evita a loja ficar sem Administrador)
  const isEditingSelf = !!member && member.id === currentUser?.id;

  // Mesmas regras da API: 9+ caracteres, letra maiúscula e número ou símbolo (0 a 3), até 72 bytes
  const passwordStrength = useMemo(() => passwordScore(form.password), [form.password]);
  const passwordTooLong = useMemo(() => isPasswordTooLong(form.password), [form.password]);
  const emailMismatch = !!form.confirmEmail && form.email.trim().toLowerCase() !== form.confirmEmail.trim().toLowerCase();
  const passwordMismatch = !!form.confirmPassword && form.password !== form.confirmPassword;

  function update<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) { toast.error('Use uma imagem JPG, PNG ou WebP.'); return; }
    if (file.size > MAX_IMAGE_BYTES) { toast.error('Imagem muito grande! O limite é 5MB.'); return; }
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = URL.createObjectURL(file);
    setAvatarFile(file);
    setAvatarPreview(objectUrlRef.current);
  }

  /** Só os campos alterados na edição (telefone apagado vai vazio, o que limpa o telefone na API). */
  function buildUpdatePayload(target: User): UpdateUserPayload {
    const payload: UpdateUserPayload = {};
    const name = form.name.trim();
    const email = form.email.trim();
    if (name !== target.name) payload.name = name;
    if (form.phone !== normalizePhone(target.phone || '')) payload.phone = form.phone;
    // O próprio e-mail e a própria senha mudam em "Minha conta" (com a senha atual e a confirmação do e-mail
    // novo); o cargo próprio nunca muda por aqui
    if (isEditingSelf) return payload;
    if (email !== target.email) payload.email = email;
    if (form.role !== target.role) payload.role = form.role;
    if (form.password) payload.password = form.password;
    return payload;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (!form.name.trim()) { toast.error('Informe o nome do membro.'); return; }
    if (!isEditingSelf) {
      if (emailMismatch || form.email.trim().toLowerCase() !== form.confirmEmail.trim().toLowerCase()) { toast.error('Os e-mails não coincidem.'); return; }
      if (!isEditing && !form.password) { toast.error('Senha é obrigatória para novos usuários.'); return; }
      if (form.password && form.password !== form.confirmPassword) { toast.error('As senhas não coincidem.'); return; }
      if (form.password && !isStrongPassword(form.password)) { toast.error(PASSWORD_RULES_MESSAGE); return; }
      if (passwordTooLong) { toast.error(PASSWORD_TOO_LONG_MESSAGE); return; }
    }

    const payload = member ? buildUpdatePayload(member) : null;
    if (member && payload && Object.keys(payload).length === 0 && !avatarFile) {
      toast('Nenhuma alteração para salvar!', { icon: '👍' });
      return;
    }

    setSaving(true);
    try {
      if (member && payload) {
        const updated = await userService.update(member.id, payload, avatarFile || undefined);
        if (isEditingSelf && currentUser) {
          // Trocar o próprio e-mail ou a senha encerra as outras sessões: a resposta traz o token novo desta
          const session = sessionFromUpdate(updated);
          if (session) {
            try {
              applyAuthResponse(session);
            } catch {
              void refreshUser();
            }
          } else {
            updateUser({
              ...currentUser,
              name: updated.name,
              email: updated.email,
              phone: updated.phone ?? undefined,
              avatar: updated.avatar ?? undefined,
            });
          }
        }
        toast.success('Membro atualizado com sucesso!');
      } else {
        await userService.create({
          name: form.name.trim(),
          email: form.email.trim(),
          phone: form.phone,
          role: form.role,
          password: form.password,
        }, avatarFile || undefined);
        toast.success('Novo membro cadastrado!');
      }
      onSaved();
      onClose();
    } catch (error) {
      // 403 = equipe do plano completa; 409 = e-mail já cadastrado; 400 = regras de senha ou último Administrador
      const planMessage = planRestrictionMessage(error);
      if (planMessage) {
        toastPlanLimit(planMessage);
        // O selo de uso da equipe na tela acompanha o que a API contou
        void refreshPanel();
      } else {
        toast.error(getApiErrorMessage(error, 'Erro ao salvar usuário.'), { duration: 6000 });
      }
    } finally {
      setSaving(false);
    }
  }

  const title = isEditing ? 'Editar Membro' : 'Novo Membro';
  const labelClass = 'block text-xs font-bold text-gray-700 dark:text-gray-300 uppercase mb-1';

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      description={isEditing ? 'Altere os dados de acesso do membro da equipe.' : 'O membro entra pelo /login com o e-mail e a senha definidos aqui.'}
      dismissible={!saving}
      closeOnOverlayClick={false}
      footer={(
        <>
          <button type="button" onClick={onClose} disabled={saving} className={buttonClass('secondary')}>Cancelar</button>
          <button type="submit" form={formId} disabled={saving} className={buttonClass('primary')}>
            {saving ? <Loader2 className="animate-spin" size={18} aria-hidden="true" /> : isEditing ? <Edit size={18} aria-hidden="true" /> : <Plus size={18} aria-hidden="true" />}
            {isEditing ? 'Salvar Alterações' : 'Cadastrar Membro'}
          </button>
        </>
      )}
    >
      <form id={formId} onSubmit={handleSubmit} className="space-y-4">
        <div className="flex flex-col items-center mb-2">
          <div className="relative group cursor-pointer rounded-full focus-within:ring-2 focus-within:ring-orange-500 focus-within:ring-offset-2 dark:focus-within:ring-offset-slate-900">
            <div className="w-24 h-24 rounded-full bg-gray-100 dark:bg-slate-800 border-2 border-dashed border-gray-300 dark:border-slate-600 flex items-center justify-center overflow-hidden hover:border-orange-500 transition-colors">
              {avatarPreview ? (
                <img src={avatarPreview} alt="Foto do membro" className="w-full h-full object-cover" />
              ) : (
                <Camera size={32} className="text-gray-400 dark:text-gray-500" aria-hidden="true" />
              )}
            </div>
            <input
              type="file"
              accept={ACCEPTED_IMAGE_TYPES.join(',')}
              onChange={handleFileChange}
              aria-label="Foto do membro (JPG, PNG ou WebP até 5MB)"
              className="absolute inset-0 opacity-0 cursor-pointer"
            />
            <div className="absolute bottom-0 right-0 bg-orange-600 text-white p-1.5 rounded-full shadow-sm border-2 border-white dark:border-slate-900" aria-hidden="true">
              <Edit size={12} />
            </div>
          </div>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">Clique para alterar a foto</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor={nameId} className={labelClass}>Nome Completo</label>
            <input
              id={nameId}
              required
              value={form.name}
              onChange={(event) => update('name', event.target.value)}
              className={fieldControlClass()}
              placeholder="Ex: João Silva"
              maxLength={50}
              autoComplete="name"
            />
          </div>
          <div>
            <label htmlFor={phoneId} className={labelClass}>Celular</label>
            <input
              id={phoneId}
              type="tel"
              inputMode="tel"
              value={form.phone}
              onChange={(event) => update('phone', normalizePhone(event.target.value))}
              className={fieldControlClass()}
              placeholder="(99) 99999-9999"
              autoComplete="tel"
            />
          </div>
        </div>

        {isEditingSelf ? (
          // O próprio e-mail e a própria senha: só em "Minha conta" (senha atual e confirmação do e-mail novo)
          <div className="rounded-xl border border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/50 p-4 space-y-2" data-testid="member-self-credentials">
            <p className="text-xs font-bold text-gray-700 dark:text-gray-300 uppercase">E-mail e senha</p>
            <p className="text-sm text-gray-700 dark:text-gray-200 break-all">{member?.email}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Para trocar o seu e-mail ou a sua senha, use Minha conta: a troca pede a senha atual e o e-mail novo só vale depois de confirmado.
            </p>
            <button
              type="button"
              onClick={() => {
                onClose();
                openMyAccount();
              }}
              className={buttonClass('secondary', 'sm')}
            >
              <UserCog size={14} aria-hidden="true" /> Abrir Minha conta
            </button>
          </div>
        ) : (
        <div>
          <label htmlFor={emailId} className={labelClass}>Email</label>
          <input
            id={emailId}
            required
            type="email"
            value={form.email}
            onChange={(event) => update('email', event.target.value)}
            className={fieldControlClass(false, 'mb-3')}
            autoComplete="off"
          />
          <label htmlFor={confirmEmailId} className={labelClass}>Confirmar Email</label>
          <input
            id={confirmEmailId}
            required
            type="email"
            value={form.confirmEmail}
            onChange={(event) => update('confirmEmail', event.target.value)}
            className={fieldControlClass(emailMismatch)}
            placeholder="Repita o email"
            aria-invalid={emailMismatch || undefined}
            autoComplete="off"
          />
          {emailMismatch && <p className="text-xs text-red-500 mt-1" role="alert">Os e-mails não conferem.</p>}
        </div>
        )}

        <div>
          <label htmlFor={roleId} className={labelClass}>Cargo / Função</label>
          {/* O próprio cargo fica travado: a API recusa a troca (a loja nunca fica sem Administrador) */}
          <select
            id={roleId}
            value={form.role}
            onChange={(event) => update('role', event.target.value as TeamRole)}
            disabled={isEditingSelf}
            aria-describedby={isEditingSelf ? ownRoleHintId : undefined}
            className={fieldControlClass()}
          >
            {TEAM_ROLE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          {isEditingSelf && (
            <p id={ownRoleHintId} className="text-[11px] text-gray-500 dark:text-gray-400 mt-1">
              Você não pode alterar o próprio cargo. Outro administrador pode fazer isso.
            </p>
          )}
        </div>

        {!isEditingSelf && (
        <fieldset className="bg-gray-50 dark:bg-slate-800/50 p-4 rounded-xl border border-gray-100 dark:border-slate-700 space-y-3">
          <legend className="sr-only">Senha de acesso</legend>
          <div className="flex items-center gap-2 mb-1" aria-hidden="true">
            <Shield size={14} className="text-orange-600 dark:text-orange-400" />
            <span className="text-xs font-bold text-gray-700 dark:text-gray-300 uppercase">Segurança</span>
          </div>

          <div>
            <label htmlFor={passwordId} className="sr-only">{isEditing ? 'Nova senha (opcional)' : 'Senha de acesso'}</label>
            <input
              id={passwordId}
              type="password"
              value={form.password}
              onChange={(event) => update('password', event.target.value)}
              className={fieldControlClass()}
              placeholder={isEditing ? 'Nova Senha (opcional)' : 'Senha de Acesso'}
              required={!isEditing}
              autoComplete="new-password"
            />
            {form.password && (
              <div className="flex gap-1 mt-2 h-1" aria-hidden="true">
                {[1, 2, 3].map((level) => (
                  <div
                    key={level}
                    className={`flex-1 rounded-full transition-all duration-300 ${passwordStrength >= level
                      ? (passwordStrength === 1 ? 'bg-red-400' : passwordStrength === 2 ? 'bg-yellow-400' : 'bg-green-500')
                      : 'bg-gray-200 dark:bg-slate-600'}`}
                  />
                ))}
              </div>
            )}
            {form.password && <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-1 text-right" aria-live="polite">{['Fraca', 'Média', 'Forte'][passwordStrength - 1] || 'Muito Fraca'}</p>}
            <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-1">Mínimo 9 caracteres, com letra maiúscula e número ou símbolo.</p>
            {passwordTooLong && <p role="alert" className="text-xs font-bold text-red-500 mt-1">{PASSWORD_TOO_LONG_MESSAGE}</p>}
          </div>

          <div>
            <label htmlFor={confirmPasswordId} className="sr-only">Confirmar senha</label>
            <input
              id={confirmPasswordId}
              type="password"
              value={form.confirmPassword}
              onChange={(event) => update('confirmPassword', event.target.value)}
              className={fieldControlClass(passwordMismatch)}
              placeholder="Confirmar Senha"
              required={!isEditing || !!form.password}
              aria-invalid={passwordMismatch || undefined}
              autoComplete="new-password"
            />
            {passwordMismatch && <p className="text-xs text-red-500 mt-1" role="alert">As senhas não conferem.</p>}
          </div>
        </fieldset>
        )}
      </form>
    </Modal>
  );
}
