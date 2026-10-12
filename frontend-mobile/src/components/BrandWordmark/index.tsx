import React from 'react';
import { View, Text, Image } from 'react-native';

import { BRAND } from '../../config/brand';

type Size = 'sm' | 'md' | 'lg' | 'xl';

interface BrandWordmarkProps {
  size?: Size;
  /** Mostra o ícone do app antes do nome. */
  showMark?: boolean;
  /** Selo ao lado do nome (ex.: "Admin", "Cozinha"). */
  badge?: string;
  /** "light" força texto branco (fundos escuros fixos). */
  tone?: 'auto' | 'light';
}

const TEXT_SIZE: Record<Size, string> = {
  sm: 'text-lg',
  md: 'text-xl',
  lg: 'text-2xl',
  xl: 'text-4xl',
};

const MARK_SIZE: Record<Size, string> = {
  sm: 'w-6 h-6 rounded-md',
  md: 'w-7 h-7 rounded-lg',
  lg: 'w-8 h-8 rounded-lg',
  xl: 'w-12 h-12 rounded-xl',
};

/** Nome do produto (BRAND.name) com o ponto da marca em laranja. */
export default function BrandWordmark({ size = 'md', showMark = false, badge, tone = 'auto' }: BrandWordmarkProps) {
  const textColor = tone === 'light' ? 'text-white' : 'text-slate-900 dark:text-white';

  return (
    <View className="flex-row items-center">
      {showMark && (
        <Image source={require('../../../assets/icon.png')} className={`${MARK_SIZE[size]} mr-2`} />
      )}
      <Text className={`${TEXT_SIZE[size]} font-black ${textColor}`} numberOfLines={1}>
        {BRAND.name}
        <Text className="text-orange-500">.</Text>
      </Text>
      {badge ? (
        <View className="ml-2 px-2 py-0.5 rounded-md bg-orange-100 dark:bg-orange-900/40">
          <Text className="text-[10px] font-bold uppercase text-orange-700 dark:text-orange-300">{badge}</Text>
        </View>
      ) : null}
    </View>
  );
}
