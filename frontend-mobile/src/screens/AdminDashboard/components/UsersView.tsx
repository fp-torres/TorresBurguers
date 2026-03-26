import React, { useState, useEffect, useMemo, useContext } from 'react';
import { 
  View, Text, TouchableOpacity, ScrollView, TextInput, 
  ActivityIndicator, Alert 
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { userService, User } from '../../../services/userService';
import { ThemeContext } from '../../../contexts/ThemeContext';

const ROLES = [
  { id: 'ALL', label: 'Todos', icon: 'users' },
  { id: 'ADMIN', label: 'Admin', icon: 'shield' },
  { id: 'KITCHEN', label: 'Cozinha', icon: 'thermometer' },
  { id: 'COURIER', label: 'Motoboys', icon: 'truck' },
  { id: 'CLIENT', label: 'Clientes', icon: 'user' },
];

export default function UsersView() {
  const { activeTheme } = useContext(ThemeContext);
  
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeTab, setActiveTab] = useState('ALL');

  useEffect(() => {
    loadUsers();
  }, []);

  async function loadUsers() {
    setLoading(true);
    try {
      const data = await userService.getAll();
      setUsers(data.sort((a, b) => b.id - a.id));
    } catch (error) {
      Alert.alert('Erro', 'Não foi possível carregar a equipe.');
    } finally {
      setLoading(false);
    }
  }

  function requestDelete(user: User) {
    Alert.alert(
      'Remover Usuário?',
      `Tem certeza que deseja remover ${user.name}? Esta ação não pode ser desfeita.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Remover', style: 'destructive', onPress: async () => {
            try {
              await userService.delete(user.id);
              loadUsers();
            } catch { Alert.alert('Erro', 'Não foi possível excluir o usuário.'); }
          } 
        }
      ]
    );
  }

  function openCreateModal() {
    Alert.alert('Em breve', 'A criação de usuários pelo app será liberada em breve.');
  }

  // --- Filtro Dinâmico Corrigido (Tipagem Explícita) ---
  const filteredList: User[] = useMemo(() => {
    return users.filter(u => {
      const matchesSearch = u.name.toLowerCase().includes(searchTerm.toLowerCase()) || String(u.id).includes(searchTerm);
      const matchesRole = activeTab === 'ALL' || u.role === activeTab;
      return matchesSearch && matchesRole;
    });
  }, [users, searchTerm, activeTab]);

  return (
    <View className="flex-1">
      {/* HEADER E BUSCA */}
      <View className="px-4 py-4 bg-white dark:bg-slate-800 border-b border-gray-100 dark:border-slate-700">
        <View className="flex-row justify-between items-center mb-4">
          <View>
            <Text className="text-xl font-bold text-gray-800 dark:text-white">Equipe e Usuários</Text>
            <Text className="text-xs text-gray-500 dark:text-gray-400">Gerencie permissões de acesso</Text>
          </View>
          <TouchableOpacity onPress={openCreateModal} className="bg-orange-600 px-4 py-2 rounded-xl flex-row items-center active:scale-95 shadow-sm shadow-orange-600/30 opacity-50">
            <Feather name="plus" size={16} color="#fff" />
            <Text className="text-white font-bold ml-1 text-sm">Novo</Text>
          </TouchableOpacity>
        </View>

        <View className="flex-row items-center bg-gray-50 dark:bg-slate-900 rounded-xl px-3 py-2 border border-gray-100 dark:border-slate-700">
          <Feather name="search" size={18} color={activeTheme === 'dark' ? '#64748b' : '#9ca3af'} />
          <TextInput 
            placeholder="Buscar por Nome ou ID..." 
            placeholderTextColor={activeTheme === 'dark' ? '#64748b' : '#9ca3af'}
            className="flex-1 ml-2 text-gray-800 dark:text-white text-sm py-1"
            value={searchTerm}
            onChangeText={setSearchTerm}
          />
        </View>
      </View>

      {/* ABAS HORIZONTAIS DE CARGOS */}
      <View className="border-b border-gray-100 dark:border-slate-700 bg-white dark:bg-slate-800">
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 12 }}>
          {ROLES.map((r) => (
            <TouchableOpacity
              key={r.id}
              onPress={() => setActiveTab(r.id)}
              className={`flex-row items-center px-4 py-2 rounded-xl mr-2 border ${
                activeTab === r.id 
                  ? 'bg-orange-50 dark:bg-orange-900/30 border-orange-200 dark:border-orange-800' 
                  : 'bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-700'
              }`}
            >
              <Feather name={r.icon as any} size={14} color={activeTab === r.id ? '#ea580c' : (activeTheme === 'dark' ? '#94a3b8' : '#64748b')} />
              <Text className={`ml-2 text-sm font-bold ${activeTab === r.id ? 'text-orange-600 dark:text-orange-500' : 'text-gray-500 dark:text-gray-400'}`}>
                {r.label}
              </Text>
              <View className={`ml-2 px-1.5 py-0.5 rounded-full ${activeTab === r.id ? 'bg-orange-200 dark:bg-orange-800' : 'bg-gray-100 dark:bg-slate-700'}`}>
                <Text className={`text-[10px] font-bold ${activeTab === r.id ? 'text-orange-800 dark:text-orange-200' : 'text-gray-500 dark:text-gray-300'}`}>
                  {r.id === 'ALL' ? users.length : users.filter(u => u.role === r.id).length}
                </Text>
              </View>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* LISTA DE USUÁRIOS */}
      <ScrollView className="flex-1 px-4 pt-4" showsVerticalScrollIndicator={false}>
        {loading ? (
          <ActivityIndicator size="large" color="#ea580c" className="mt-10" />
        ) : filteredList.length === 0 ? (
          <Text className="text-center text-gray-500 dark:text-gray-400 mt-10">Nenhum usuário encontrado.</Text>
        ) : (
          filteredList.map(u => (
            <View key={u.id} className="bg-white dark:bg-slate-800 rounded-2xl p-4 mb-3 flex-row items-center border border-gray-100 dark:border-slate-700 shadow-sm">
              
              {/* Avatar Simulador */}
              <View className={`w-12 h-12 rounded-full flex items-center justify-center mr-3 border ${
                u.role === 'ADMIN' ? 'bg-purple-100 dark:bg-purple-900/30 border-purple-200 dark:border-purple-800' : 
                u.role === 'KITCHEN' ? 'bg-orange-100 dark:bg-orange-900/30 border-orange-200 dark:border-orange-800' : 
                u.role === 'COURIER' ? 'bg-blue-100 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800' : 
                'bg-gray-100 dark:bg-gray-800 border-gray-200 dark:border-gray-700'
              }`}>
                <Text className={`font-bold text-lg ${
                  u.role === 'ADMIN' ? 'text-purple-600 dark:text-purple-400' : 
                  u.role === 'KITCHEN' ? 'text-orange-600 dark:text-orange-400' : 
                  u.role === 'COURIER' ? 'text-blue-600 dark:text-blue-400' : 
                  'text-gray-500 dark:text-gray-400'
                }`}>{u.name.charAt(0).toUpperCase()}</Text>
              </View>

              <View className="flex-1">
                <View className="flex-row items-center">
                  <Text className="font-bold text-gray-800 dark:text-white text-base mr-2">{u.name}</Text>
                  <Text className="text-[10px] text-gray-400 dark:text-gray-500 font-mono">ID: {u.id}</Text>
                </View>
                <Text className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{u.email}</Text>
                
                {/* Badge do Cargo */}
                <View className="flex-row mt-1">
                  <View className={`px-2 py-0.5 rounded border flex-row items-center ${
                    u.role === 'ADMIN' ? 'bg-purple-50 dark:bg-purple-900/20 border-purple-100 dark:border-purple-800' : 
                    u.role === 'KITCHEN' ? 'bg-orange-50 dark:bg-orange-900/20 border-orange-100 dark:border-orange-800' : 
                    u.role === 'COURIER' ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-100 dark:border-blue-800' : 
                    'bg-gray-50 dark:bg-gray-800 border-gray-100 dark:border-gray-700'
                  }`}>
                    <Text className={`text-[10px] font-bold ${
                      u.role === 'ADMIN' ? 'text-purple-700 dark:text-purple-300' : 
                      u.role === 'KITCHEN' ? 'text-orange-700 dark:text-orange-300' : 
                      u.role === 'COURIER' ? 'text-blue-700 dark:text-blue-300' : 
                      'text-gray-600 dark:text-gray-400'
                    }`}>{u.role}</Text>
                  </View>
                </View>
              </View>

              <View className="flex-row gap-2 ml-2">
                <TouchableOpacity onPress={() => requestDelete(u)} className="p-2 bg-red-50 dark:bg-red-900/20 rounded-lg">
                  <Feather name="trash-2" size={16} color="#ef4444" />
                </TouchableOpacity>
              </View>

            </View>
          ))
        )}
        <View className="h-20" />
      </ScrollView>
    </View>
  );
}