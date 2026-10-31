import { useState } from 'react';
import { Modal, View, TextInput, ScrollView, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/ui/Text';
import registry from '@/config/languageRegistry.json';
import { Button, styles, palette } from './ui';
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
            backgroundColor: palette.background,
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
              backgroundColor: '#C9C3CD',
              borderRadius: 2,
            }}
          />
          <Text style={styles.heading}>{t('language')}</Text>
          <TextInput
            accessibilityLabel={t('searchLanguage')}
            placeholder={t('searchLanguage')}
            value={search}
            onChangeText={setSearch}
            style={styles.input}
          />
          <ScrollView keyboardShouldPersistTaps="handled">
            {languages.map((item) => (
              <Pressable
                key={item.code}
                onPress={() => {
                  onSelect(item.code, item.label);
                  onClose();
                }}
                style={[
                  styles.row,
                  { paddingVertical: 17, borderBottomWidth: 1, borderColor: palette.line },
                ]}
              >
                <Text style={{ fontSize: 18 }}>
                  {item.flag} {item.label}
                </Text>
                <Text>{selected === item.code ? '✓' : ''}</Text>
              </Pressable>
            ))}
          </ScrollView>
          <Button secondary label={t('close')} onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}
