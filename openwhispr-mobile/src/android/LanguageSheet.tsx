import { useState } from 'react';
import { Modal, View, TextInput, ScrollView, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/ui/Text';
import registry from '@/config/languageRegistry.json';
import { Button } from './ui';
import { useTheme } from './ThemeProvider';
export function LanguageSheet({
  visible,
  onClose,
  onSelect,
  selected,
  allowAuto = true,
}: {
  visible: boolean;
  onClose: () => void;
  onSelect: (code: string, label: string) => void;
  selected: string;
  allowAuto?: boolean;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const insets = useSafeAreaInsets();
  const th = useTheme();
  const k = th.tokens;
  // Rows kept the system's text colour in light; dark needs the ink.
  const rowInk = th.scheme === 'dark' ? k.ink : undefined;
  const languages = registry.languages.filter(
    (item) =>
      (allowAuto || item.code !== 'auto') &&
      item.label.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#00000055', justifyContent: 'flex-end' }}>
        <View
          style={{
            backgroundColor: k.canvas,
            borderTopLeftRadius: 32,
            borderTopRightRadius: 32,
            padding: 24,
            paddingBottom: Math.max(insets.bottom, 24),
            maxHeight: '85%',
            gap: 16,
          }}
        >
          <View
            style={{
              height: 4,
              width: 40,
              alignSelf: 'center',
              backgroundColor: th.scheme === 'dark' ? k.trackStrong : '#C9C3CD',
              borderRadius: 2,
            }}
          />
          <Text
            style={{
              fontSize: 21,
              lineHeight: 28,
              fontWeight: '600',
              color: k.ink,
              letterSpacing: -0.5,
            }}
          >
            {t('language')}
          </Text>
          <TextInput
            accessibilityLabel={t('searchLanguage')}
            placeholder={t('searchLanguage')}
            value={search}
            onChangeText={setSearch}
            placeholderTextColor={k.tertiary}
            selectionColor={k.selFill}
            cursorColor={k.accent}
            style={{
              borderRadius: 18,
              padding: 16,
              backgroundColor: k.surface,
              borderWidth: 1,
              borderColor: k.track,
              color: k.ink,
              fontSize: 17,
              minHeight: 56,
            }}
          />
          <ScrollView keyboardShouldPersistTaps="handled">
            {languages.map((item) => (
              <Pressable
                key={item.code}
                onPress={() => {
                  onSelect(item.code, item.label);
                  onClose();
                }}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  paddingVertical: 17,
                  borderBottomWidth: 1,
                  borderColor: k.track,
                }}
              >
                <Text style={{ fontSize: 18, color: rowInk }}>
                  {item.flag} {item.label}
                </Text>
                <Text style={{ color: rowInk }}>{selected === item.code ? '✓' : ''}</Text>
              </Pressable>
            ))}
          </ScrollView>
          <Button secondary label={t('close')} onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}
