import React, { useCallback, useMemo, useState } from 'react';
import { View, FlatList, TextInput, Pressable, type ListRenderItem } from 'react-native';
import { Text } from '@/components/ui/Text';
import { useHeaderHeight } from '@react-navigation/elements';
import { router } from 'expo-router';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useConfigStore } from '@/store/useConfigStore';
import { SpaceGrotesk } from '@/lib/fonts';
import { safeHaptics } from '@/lib/utils';
import { LANGUAGES, DEFAULT_LANGUAGE, type Language } from '@/lib/languages';

const ROW_HEIGHT = 52;

function RowSeparator() {
  return <View className="ml-14 h-px bg-separator" />;
}

type LanguageRowProps = {
  language: Language;
  isSelected: boolean;
  onPress: (code: string) => void;
};

function LanguageRow({ language, isSelected, onPress }: LanguageRowProps) {
  return (
    <Pressable
      onPress={() => onPress(language.code)}
      className={isSelected ? 'bg-brand/10 active:bg-brand/20' : 'active:bg-tertiarySystemFill'}
      style={{ height: ROW_HEIGHT }}
    >
      <View className="flex-row items-center gap-3 px-4 py-3">
        <Text className="text-[22px]">{language.flag}</Text>
        <Text className="flex-1 text-[17px] text-label" numberOfLines={1}>
          {language.label}
        </Text>
        {isSelected ? (
          <SystemIcon name="checkmark" mdName="Check" size={18} color="systemBlue" />
        ) : null}
      </View>
    </Pressable>
  );
}

export default function TranscriptionLanguageScreen() {
  const config = useConfigStore((s) => s.config);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const selected = config?.preferredLanguage ?? DEFAULT_LANGUAGE;
  const [query, setQuery] = useState('');
  const headerHeight = useHeaderHeight();

  const filtered = useMemo<Language[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return LANGUAGES;
    return LANGUAGES.filter(
      (l) => l.label.toLowerCase().includes(q) || l.code.toLowerCase().includes(q),
    );
  }, [query]);

  const handleSelect = useCallback(
    (code: string) => {
      safeHaptics('light');
      if (code !== selected) updateConfig({ preferredLanguage: code });
      if (router.canGoBack()) {
        router.back();
      } else {
        router.replace('/(account)');
      }
    },
    [selected, updateConfig],
  );

  const renderItem = useCallback<ListRenderItem<Language>>(
    ({ item }) => (
      <LanguageRow language={item} isSelected={item.code === selected} onPress={handleSelect} />
    ),
    [selected, handleSelect],
  );

  return (
    <View className="flex-1 bg-systemBackground" style={{ paddingTop: headerHeight }}>
      <View className="border-b border-separator px-4 py-2">
        <View
          style={{ borderCurve: 'continuous' }}
          className="flex-row items-center gap-2 rounded-[10px] bg-secondarySystemBackground px-3 py-2"
        >
          <SystemIcon name="magnifyingglass" mdName="Search" size={15} color="secondaryLabel" />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search languages"
            placeholderTextColor="#9CA3AF"
            autoCorrect={false}
            autoCapitalize="none"
            className="flex-1 text-[16px] text-label"
            returnKeyType="search"
            style={{ fontFamily: SpaceGrotesk.regular }}
          />
          {query.length > 0 ? (
            <Pressable onPress={() => setQuery('')} hitSlop={8}>
              <SystemIcon
                name="xmark.circle.fill"
                mdName="XCircle"
                size={16}
                color="tertiaryLabel"
              />
            </Pressable>
          ) : null}
        </View>
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.code}
        contentInsetAdjustmentBehavior="never"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerStyle={{ paddingBottom: 40 }}
        getItemLayout={(_, index) => ({
          length: ROW_HEIGHT,
          offset: ROW_HEIGHT * index,
          index,
        })}
        ItemSeparatorComponent={RowSeparator}
        renderItem={renderItem}
        ListEmptyComponent={
          <View className="items-center px-6 py-12">
            <Text className="text-[15px] text-tertiaryLabel">
              No languages match &quot;{query}&quot;
            </Text>
          </View>
        }
      />
    </View>
  );
}
