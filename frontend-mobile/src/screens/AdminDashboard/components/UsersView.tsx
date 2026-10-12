import React, { useState, useEffect, useMemo, useContext, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, TextInput,
  ActivityIndicator, Alert, Modal, KeyboardAvoidingView, RefreshControl,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { userService, User, UserPayload } from '../../../services/userService';
import { ThemeContext } from '../../../contexts/ThemeContext';
import { AuthContext } from '../../../contexts/AuthContext';
import type { FeatherIconName } from '../../../utils/catalog';
import { ALL_ROLES, ROLE_LABELS, UserRole } from '../../../utils/roles';
import { getErrorMessage } from '../../../utils/errors';

const FILTERS: { id: 'ALL' | UserRole; label: string; icon: FeatherIconName }[] = [
  { id: 'ALL', label: 'Todos', icon: 'users' },
  { id: 'ADMIN', label: 'Administradores', icon: 'shield' },
  { id: 'EMPLOYEE', label: 'Atendentes', icon: 'headphones' },
  { id: 'KITCHEN', label: 'Cozinha', icon: 'thermometer' },
  { id: 'COURIER', label: 'Entregadores', icon: 'truck' },
  { id: 'CLIENT', label: 'Clientes', icon: 'user' },
];

const ROLE_STYLE: Record<UserRole, { avatar: string; avatarText: string; badge: string; badgeText: string }> = {
  ADMIN: {
    avatar: 'bg-purple-100 dark:bg-purple-900/30 border-purple-200 dark:border-purple-800',
    avatarText: 'text-purple-600 dark:text-purple-400',
    badge: 'bg-purple-50 dark:bg-purple-900/20 border-purple-100 dark:border-purple-800',
    badgeText: 'text-purple-700 dark:text-purple-300',
  },
  EMPLOYEE: {
    avatar: 'bg-teal-100 dark:bg-teal-900/30 border-teal-200 dark:border-teal-800',
    avatarText: 'text-teal-600 dark:text-teal-400',
    badge: 'bg-teal-50 dark:bg-teal-900/20 border-teal-100 dark:border-teal-800',
    badgeText: 'text-teal-700 dark:text-teal-300',
  },
  KITCHEN: {
    avatar: 'bg-orange-100 dark:bg-orange-900/30 border-orange-200 dark:border-orange-800',
    avatarText: 'text-orange-600 dark:text-orange-400',
    badge: 'bg-orange-50 dark:bg-orange-900/20 border-orange-100 dark:border-orange-800',
    badgeText: 'text-orange-700 dark:text-orange-300',
  },
  COURIER: {
    avatar: 'bg-blue-100 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800',
    avatarText: 'text-blue-600 dark:text-blue-400',
    badge: 'bg-blue-50 dark:bg-blue-900/20 border-blue-100 dark:border-blue-800',
    badgeText: 'text-blue-700 dark:text-blue-300',
  },
  CLIENT: {
    avatar: 'bg-gray-100 dark:bg-gray-800 border-gray-200 dark:border-gray-700',
    avatarText: 'text-gray-500 dark:text-gray-400',
    badge: 'bg-gray-50 dark:bg-gray-800 border-gray-100 dark:border-gray-700',
    badgeText: 'text-gray-600 dark:text-gray-400',
  },
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Mesma regra de senha do backend: 9+ caracteres, uma maiúscula e um número ou símbolo
const PASSWORD_REGEX = /^(?=.*[A-Z])(?=.*(\d|\W)).{9,}$/;

export default function UsersView() {
  const { activeTheme } = useContext(ThemeContext);
  const { user: loggedUser, updateUser } = useContext(AuthContext);
  const isDark = activeTheme === 'dark';

  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeTab, setActiveTab] = useState<'ALL' | UserRole>('ALL');

  // Modal de criação/edição
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('EMPLOYEE');

  const loadUsers = useCallback(async () => {
    try {
      const data = await userService.getAll();
      setUsers([...data].sort((a, b) => b.id - a.id));
    } catch (error) {
      Alert.alert('Erro', getErrorMessage(error, 'Não foi possível carregar a equipe.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  async function handleRefresh() {
    setRefreshing(true);
    await loadUsers();
    setRefreshing(false);
  }

  function requestDelete(target: User) {
    Alert.alert(
      'Remover Usuário?',
      `Tem certeza que deseja remover ${target.name}? A conta deixa de acessar o sistema.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Remover', style: 'destructive', onPress: async () => {
            try {
              await userService.delete(target.id);
              loadUsers();
            } catch (error) {
              Alert.alert('Erro', getErrorMessage(error, 'Não foi possível excluir o usuário.'));
            }
          }
        }
      ]
    );
  }

  function openCreateModal() {
    setEditingUser(null);
    setName(''); setEmail(''); setPhone(''); setPassword('');
    setRole(activeTab !== 'ALL' ? activeTab : 'EMPLOYEE');
    setIsModalOpen(true);
  }

  function openEditModal(target: User) {
    setEditingUser(target);
    setName(target.name);
    setEmail(target.email);
    setPhone(target.phone ?? '');
    setPassword('');
    setRole(target.role);
    setIsModalOpen(true);
  }

  function closeModal() {
    if (!saving) setIsModalOpen(false);
  }

  async function handleSave() {
    const isNew = !editingUser;
    if (!name.trim() || !email.trim() || (isNew && !password)) {
      Alert.alert('Atenção', isNew ? 'Nome, e-mail e senha são obrigatórios.' : 'Nome e e-mail são obrigatórios.');
      return;
    }
    if (!EMAIL_REGEX.test(email.trim())) {
      Alert.alert('E-mail inválido', 'Confira o e-mail digitado.');
      return;
    }
    const digits = phone.replace(/\D/g, '');
    if (digits && digits.length < 10) {
      Alert.alert('Telefone inválido', 'Informe o celular com DDD (ex.: 21999999999) ou deixe em branco (sem telefone).');
      return;
    }
    if (password && !PASSWORD_REGEX.test(password)) {
      Alert.alert('Senha fraca', 'A senha deve ter no mínimo 9 caracteres, com letra maiúscula e um número ou símbolo.');
      return;
    }

    const isSelf = !!editingUser && editingUser.id === loggedUser?.id;
    const phoneUnchanged = !!editingUser && digits === (editingUser.phone ?? '').replace(/\D/g, '');
    const payload: UserPayload = {
      name,
      email,
      // Na edição, telefone em branco apaga o número; no cadastro, é o mesmo que não informar
      phone: phoneUnchanged ? undefined : digits,
      password: password || undefined,
      // O próprio perfil não muda por aqui (o backend recusa); perfil igual não precisa ir
      role: isSelf || editingUser?.role === role ? undefined : role,
    };

    setSaving(true);
    try {
      if (editingUser) {
        const updated = await userService.update(editingUser.id, payload);
        // Editou a própria conta: mantém a sessão com os dados novos
        if (isSelf) {
          await updateUser({
            name: updated?.name ?? name.trim(),
            email: updated?.email ?? email.trim(),
            phone: updated && 'phone' in updated ? updated.phone ?? null : (digits || null),
          });
        }
      } else {
        await userService.create(payload);
      }
      setIsModalOpen(false);
      Alert.alert('Pronto!', editingUser
        ? (password ? 'Usuário atualizado e senha redefinida.' : 'Usuário atualizado.')
        : `${ROLE_LABELS[role]} cadastrado(a) com sucesso.`);
      loadUsers();
    } catch (error) {
      // 409 = e-mail já cadastrado; 400 = validação (mensagens do backend)
      Alert.alert('Não foi possível salvar', getErrorMessage(error, 'Verifique os dados e tente novamente.'));
    } finally {
      setSaving(false);
    }
  }

  // --- Filtro Dinâmico ---
  const filteredList: User[] = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return users.filter(u => {
      const matchesSearch = u.name.toLowerCase().includes(term)
        || u.email.toLowerCase().includes(term)
        || String(u.id).includes(term);
      const matchesRole = activeTab === 'ALL' || u.role === activeTab;
      return matchesSearch && matchesRole;
    });
  }, [users, searchTerm, activeTab]);

  const inputClass = 'bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl px-4 py-3 text-gray-800 dark:text-white';
  const placeholderColor = isDark ? '#64748b' : '#9ca3af';

  return (
    <View className="flex-1">
      {/* HEADER E BUSCA */}
      <View className="px-4 py-4 bg-white dark:bg-slate-800 border-b border-gray-100 dark:border-slate-700">
        <View className="flex-row justify-between items-center mb-4">
          <View>
            <Text className="text-xl font-bold text-gray-800 dark:text-white">Equipe e Usuários</Text>
            <Text className="text-xs text-gray-500 dark:text-gray-400">Perfis de acesso e redefinição de senha</Text>
          </View>
          <TouchableOpacity onPress={openCreateModal} className="bg-orange-600 px-4 py-2 rounded-xl flex-row items-center active:scale-95 shadow-sm shadow-orange-600/30">
            <Feather name="plus" size={16} color="#fff" />
            <Text className="text-white font-bold ml-1 text-sm">Novo</Text>
          </TouchableOpacity>
        </View>

        <View className="flex-row items-center bg-gray-50 dark:bg-slate-900 rounded-xl px-3 py-2 border border-gray-100 dark:border-slate-700">
          <Feather name="search" size={18} color={placeholderColor} />
          <TextInput
            placeholder="Buscar por nome, e-mail ou ID..."
            placeholderTextColor={placeholderColor}
            className="flex-1 ml-2 text-gray-800 dark:text-white text-sm py-1"
            value={searchTerm}
            onChangeText={setSearchTerm}
            autoCapitalize="none"
          />
        </View>
      </View>

      {/* ABAS HORIZONTAIS DE CARGOS */}
      <View className="border-b border-gray-100 dark:border-slate-700 bg-white dark:bg-slate-800">
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 12 }}>
          {FILTERS.map((filter) => (
            <TouchableOpacity
              key={filter.id}
              onPress={() => setActiveTab(filter.id)}
              className={`flex-row items-center px-4 py-2 rounded-xl mr-2 border ${
                activeTab === filter.id
                  ? 'bg-orange-50 dark:bg-orange-900/30 border-orange-200 dark:border-orange-800'
                  : 'bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-700'
              }`}
            >
              <Feather name={filter.icon} size={14} color={activeTab === filter.id ? '#ea580c' : (isDark ? '#94a3b8' : '#64748b')} />
              <Text className={`ml-2 text-sm font-bold ${activeTab === filter.id ? 'text-orange-600 dark:text-orange-500' : 'text-gray-500 dark:text-gray-400'}`}>
                {filter.label}
              </Text>
              <View className={`ml-2 px-1.5 py-0.5 rounded-full ${activeTab === filter.id ? 'bg-orange-200 dark:bg-orange-800' : 'bg-gray-100 dark:bg-slate-700'}`}>
                <Text className={`text-[10px] font-bold ${activeTab === filter.id ? 'text-orange-800 dark:text-orange-200' : 'text-gray-500 dark:text-gray-300'}`}>
                  {filter.id === 'ALL' ? users.length : users.filter(u => u.role === filter.id).length}
                </Text>
              </View>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* LISTA DE USUÁRIOS */}
      <ScrollView
        className="flex-1 px-4 pt-4"
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#f97316" colors={['#f97316']} />}
      >
        {loading ? (
          <ActivityIndicator size="large" color="#ea580c" className="mt-10" />
        ) : filteredList.length === 0 ? (
          <Text className="text-center text-gray-500 dark:text-gray-400 mt-10">Nenhum usuário encontrado.</Text>
        ) : (
          filteredList.map(u => {
            const style = ROLE_STYLE[u.role] ?? ROLE_STYLE.CLIENT;
            const isSelf = u.id === loggedUser?.id;
            return (
              <View key={u.id} className="bg-white dark:bg-slate-800 rounded-2xl p-4 mb-3 flex-row items-center border border-gray-100 dark:border-slate-700 shadow-sm">

                {/* Avatar com a inicial */}
                <View className={`w-12 h-12 rounded-full flex items-center justify-center mr-3 border ${style.avatar}`}>
                  <Text className={`font-bold text-lg ${style.avatarText}`}>{u.name.charAt(0).toUpperCase()}</Text>
                </View>

                <View className="flex-1">
                  <View className="flex-row items-center">
                    <Text className="font-bold text-gray-800 dark:text-white text-base mr-2 flex-shrink" numberOfLines={1}>{u.name}</Text>
                    <Text className="text-[10px] text-gray-400 dark:text-gray-500 font-mono">ID: {u.id}</Text>
                  </View>
                  <Text className="text-xs text-gray-500 dark:text-gray-400 mt-0.5" numberOfLines={1}>{u.email}</Text>

                  {/* Badge do Cargo */}
                  <View className="flex-row mt-1">
                    <View className={`px-2 py-0.5 rounded border flex-row items-center ${style.badge}`}>
                      <Text className={`text-[10px] font-bold ${style.badgeText}`}>{ROLE_LABELS[u.role] ?? u.role}{isSelf ? ' • você' : ''}</Text>
                    </View>
                  </View>
                </View>

                <View className="flex-row ml-2">
                  <TouchableOpacity
                    onPress={() => openEditModal(u)}
                    accessibilityRole="button"
                    accessibilityLabel={`Editar ${u.name}`}
                    className="p-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg"
                  >
                    <Feather name="edit-2" size={16} color="#3b82f6" />
                  </TouchableOpacity>
                  {!isSelf && (
                    <TouchableOpacity
                      onPress={() => requestDelete(u)}
                      accessibilityRole="button"
                      accessibilityLabel={`Remover ${u.name}`}
                      className="p-2 bg-red-50 dark:bg-red-900/20 rounded-lg ml-2"
                    >
                      <Feather name="trash-2" size={16} color="#ef4444" />
                    </TouchableOpacity>
                  )}
                </View>

              </View>
            );
          })
        )}
        <View className="h-20" />
      </ScrollView>

      {/* MODAL DE CRIAR/EDITAR (o botão voltar do Android fecha via onRequestClose) */}
      <Modal visible={isModalOpen} animationType="slide" transparent onRequestClose={closeModal}>
        {/* "padding" nas duas plataformas: o "height" não encolhe o flex-1 do NativeWind (ver KeyboardAwareScreen) */}
        <KeyboardAvoidingView behavior="padding" className="flex-1 justify-end bg-black/50">
          <View className="bg-white dark:bg-slate-900 rounded-t-3xl p-6 h-[85%]">
            <View className="flex-row justify-between items-center mb-6">
              <Text className="text-xl font-bold text-gray-800 dark:text-white">{editingUser ? 'Editar Usuário' : 'Novo Usuário'}</Text>
              <TouchableOpacity onPress={closeModal} accessibilityRole="button" accessibilityLabel="Fechar">
                <Feather name="x" size={24} color={isDark ? '#94a3b8' : '#64748b'} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <View className="mb-4">
                <Text className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase mb-1">Nome</Text>
                <TextInput value={name} onChangeText={setName} maxLength={50} className={inputClass} placeholder="Ex: Maria Silva" placeholderTextColor={placeholderColor} />
              </View>

              <View className="mb-4">
                <Text className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase mb-1">E-mail</Text>
                <TextInput value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} className={inputClass} placeholder="nome@empresa.com" placeholderTextColor={placeholderColor} />
              </View>

              <View className="mb-4">
                <Text className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase mb-1">Celular (opcional)</Text>
                <TextInput value={phone} onChangeText={setPhone} keyboardType="phone-pad" maxLength={15} className={inputClass} placeholder="21999999999" placeholderTextColor={placeholderColor} />
              </View>

              <View className="mb-4">
                <Text className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase mb-1">
                  {editingUser ? 'Nova senha (deixe em branco para manter)' : 'Senha'}
                </Text>
                <TextInput value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" className={inputClass} placeholder="Mín. 9 caracteres, 1 maiúscula e 1 número" placeholderTextColor={placeholderColor} />
              </View>

              <View className="mb-8">
                <Text className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase mb-2">Perfil de acesso</Text>
                {editingUser?.id === loggedUser?.id ? (
                  <Text className="text-sm text-gray-500 dark:text-gray-400">
                    {ROLE_LABELS[role]} — o seu próprio perfil não pode ser alterado por aqui.
                  </Text>
                ) : (
                  <View className="flex-row flex-wrap">
                    {ALL_ROLES.map((option) => {
                      const selected = role === option;
                      return (
                        <TouchableOpacity
                          key={option}
                          onPress={() => setRole(option)}
                          className={`px-3 py-2 rounded-xl mr-2 mb-2 border ${selected ? 'bg-orange-50 dark:bg-orange-900/30 border-orange-300 dark:border-orange-700' : 'bg-gray-50 dark:bg-slate-800 border-gray-200 dark:border-slate-700'}`}
                        >
                          <Text className={`text-sm font-bold ${selected ? 'text-orange-600 dark:text-orange-400' : 'text-gray-600 dark:text-gray-300'}`}>{ROLE_LABELS[option]}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}
              </View>

              <TouchableOpacity onPress={handleSave} disabled={saving} className="bg-orange-600 py-4 rounded-xl items-center shadow-sm shadow-orange-600/30 mb-8">
                {saving ? <ActivityIndicator color="#fff" /> : <Text className="text-white font-bold text-lg">{editingUser ? 'Salvar Alterações' : 'Cadastrar Usuário'}</Text>}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}
