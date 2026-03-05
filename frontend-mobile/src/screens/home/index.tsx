import React, { useContext, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, Image, ActivityIndicator, Alert } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { AuthContext } from '../../contexts/AuthContext';
import api from '../../services/api';
import { AppStackParamList } from '../../routes/app.routes'; 

interface Product {
  id: number;
  name: string;
  description: string;
  price: number;
  promotion_price: number | null;
  image: string | null;
  category: string;
  available: boolean;
}

export default function Home() {
  // Puxamos o user e o signOut do Contexto
  const { signOut, user } = useContext(AuthContext);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();

  useEffect(() => {
    fetchProducts();
  }, []);

  async function fetchProducts() {
    try {
      const response = await api.get('/products');
      setProducts(response.data);
    } catch (error) {
      console.error('Erro ao buscar produtos:', error);
      Alert.alert('Erro', 'Não foi possível carregar o cardápio.');
    } finally {
      setLoading(false);
    }
  }

  const formatPrice = (price: number) => {
    return Number(price).toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    });
  };

  const renderProduct = ({ item }: { item: Product }) => (
    <TouchableOpacity 
      className="bg-slate-800 p-4 rounded-2xl mb-4 flex-row items-center shadow-md active:scale-95"
      onPress={() => navigation.navigate('ProductDetails', { product_id: item.id })}
    >
      <Image 
        source={{ 
          uri: item.image 
            ? `${api.defaults.baseURL}/${item.image}` 
            : 'https://via.placeholder.com/100?text=Sem+Foto' 
        }} 
        className="w-24 h-24 rounded-xl bg-slate-700"
        resizeMode="cover"
      />
      
      <View className="flex-1 ml-4 justify-center">
        <Text className="text-white font-bold text-lg" numberOfLines={1}>
          {item.name}
        </Text>
        <Text className="text-slate-400 text-sm mt-1 mb-2" numberOfLines={2}>
          {item.description}
        </Text>
        
        <View className="flex-row items-center">
          {item.promotion_price ? (
            <>
              <Text className="text-orange-500 font-bold text-lg mr-2">
                {formatPrice(item.promotion_price)}
              </Text>
              <Text className="text-slate-500 text-sm line-through">
                {formatPrice(item.price)}
              </Text>
            </>
          ) : (
            <Text className="text-orange-500 font-bold text-lg">
              {formatPrice(item.price)}
            </Text>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );

  return (
    <View className="flex-1 p-6 bg-slate-900 pt-16">
      
      {/* HEADER DINÂMICO */}
      <View className="flex-row justify-between items-center mb-8">
        <View>
          <Text className="text-2xl font-bold text-white">
            Torres<Text className="text-orange-500">Burgers</Text>
          </Text>
          
          {/* Se o user existir, mostra o nome. Se não, mostra visitante */}
          {user ? (
            <Text className="text-lg text-slate-300 mt-1">
              E aí, <Text className="text-orange-500 font-bold">{user.name.split(' ')[0]}</Text>! 👋
            </Text>
          ) : (
            <Text className="text-lg text-slate-300 mt-1">
              Bem-vindo(a) visitante! 🍔
            </Text>
          )}
        </View>

        {/* Se o user existir, mostra o botão Sair. Se não, mostra o botão Entrar */}
        {user ? (
          <TouchableOpacity 
            onPress={signOut}
            className="bg-slate-800 px-4 py-2 rounded-lg border border-slate-700 active:scale-95"
          >
            <Text className="text-red-400 font-bold text-sm">Sair</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity 
            onPress={() => navigation.navigate('Welcome')}
            className="bg-orange-600 px-5 py-2 rounded-lg active:scale-95 shadow-md"
          >
            <Text className="text-white font-bold text-sm">Entrar</Text>
          </TouchableOpacity>
        )}
      </View>

      <Text className="text-xl font-bold text-white mb-4">Nosso Cardápio</Text>

      {loading ? (
        <View className="flex-1 justify-center items-center">
          <ActivityIndicator size="large" color="#f97316" />
        </View>
      ) : (
        <FlatList
          data={products}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderProduct}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 20 }}
          ListEmptyComponent={
            <Text className="text-slate-400 text-center mt-10">
              Nenhum produto encontrado. 🍔
            </Text>
          }
        />
      )}
    </View>
  );
}