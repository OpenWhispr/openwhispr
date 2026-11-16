import { useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/Text';
import { AppFont } from '@/lib/fonts';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useConfigStore } from '@/store/useConfigStore';
import { LANGUAGES, byCode, initialLanguages } from './languages';
import { AccentText, GlassButton, PillButton, Screen, SecondaryButton, colors, s } from './kit';
import { useOnboardingT } from './strings';

export function LanguagesScreen({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const t = useOnboardingT();
  const config = useConfigStore((state) => state.config);
  const [codes, setCodes] = useState(() =>
    initialLanguages(config?.languages, config?.preferredLanguage),
  );
  const [adding, setAdding] = useState(false);
  const save = () => {
    // The onboarding list feeds transcription; a stale single pick from Settings would override it.
    void useConfigStore.getState().updateConfig({ languages: codes, preferredLanguage: undefined });
    onNext();
  };
  return (
    <Screen
      onBack={onBack}
      right={<PillButton label={t('skip')} onPress={onNext} />}
      footer={
        <>
          <GlassButton label={t('continue')} onPress={save} />
          <SecondaryButton label={t('addLanguage')} onPress={() => setAdding(true)} />
        </>
      }
    >
      <AccentText text={t('languagesTitle')} />
      <Text style={s.body}>{t(codes.length ? 'languagesBody' : 'autoDetect')}</Text>
      <View style={{ gap: 12 }}>
        {codes.map((code) => {
          const language = byCode.get(code);
          if (!language) return null;
          return (
            <View key={code} style={l.row}>
              <Text style={{ fontSize: 18 }}>{language.flag}</Text>
              <Text style={l.label}>{language.label}</Text>
              <Pressable
                cssInterop={false}
                accessibilityRole="button"
                accessibilityLabel={t('removeLanguage', { language: language.label })}
                onPress={() => setCodes((current) => current.filter((item) => item !== code))}
                hitSlop={10}
              >
                <SystemIcon name="xmark" mdName="X" size={18} color={colors.tertiary} />
              </Pressable>
            </View>
          );
        })}
      </View>
      <AddLanguageSheet
        visible={adding}
        selected={codes}
        onClose={() => setAdding(false)}
        onAdd={(code) => {
          setCodes((current) => (current.includes(code) ? current : [...current, code]));
          setAdding(false);
        }}
      />
    </Screen>
  );
}

function AddLanguageSheet({
  visible,
  selected,
  onClose,
  onAdd,
}: {
  visible: boolean;
  selected: string[];
  onClose: () => void;
  onAdd: (code: string) => void;
}) {
  const t = useOnboardingT();
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState('');
  const results = useMemo(() => {
    const query = search.trim().toLowerCase();
    return LANGUAGES.filter(
      (item) => !selected.includes(item.code) && item.label.toLowerCase().includes(query),
    );
  }, [search, selected]);
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={l.scrim}>
        <View style={[l.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <View style={l.grabber} />
          <View style={[s.header, { paddingHorizontal: 0 }]}>
            <Text style={l.sheetTitle}>{t('addLanguageTitle')}</Text>
            <Pressable
              cssInterop={false}
              accessibilityRole="button"
              accessibilityLabel={t('cancel')}
              onPress={onClose}
              style={l.cancel}
            >
              <Text style={{ color: colors.accent, fontSize: 16, fontFamily: AppFont.medium }}>
                {t('cancel')}
              </Text>
            </Pressable>
          </View>
          <View style={l.search}>
            <SystemIcon name="magnifyingglass" mdName="Search" size={16} color={colors.tertiary} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder={t('searchLanguages', { count: LANGUAGES.length })}
              placeholderTextColor={colors.tertiary}
              accessibilityLabel={t('searchLanguages', { count: LANGUAGES.length })}
              style={l.searchInput}
            />
          </View>
          <View style={l.list}>
            <FlatList
              data={results}
              keyExtractor={(item) => item.code}
              keyboardShouldPersistTaps="handled"
              ItemSeparatorComponent={() => <View style={l.separator} />}
              renderItem={({ item }) => (
                <Pressable
                  cssInterop={false}
                  accessibilityRole="button"
                  accessibilityLabel={t('addThisLanguage', { language: item.label })}
                  onPress={() => {
                    setSearch('');
                    onAdd(item.code);
                  }}
                  style={({ pressed }) => [
                    l.option,
                    pressed && { backgroundColor: colors.surface2 },
                  ]}
                >
                  <Text style={{ fontSize: 18 }}>{item.flag}</Text>
                  <Text style={l.label}>{item.label}</Text>
                  <SystemIcon name="plus" mdName="Plus" size={20} color={colors.accent} />
                </Pressable>
              )}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const l = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: colors.surface,
    borderRadius: 16,
    paddingHorizontal: 16,
    minHeight: 56,
    shadowColor: '#000000',
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  label: { flex: 1, fontSize: 17, color: colors.ink },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.canvas,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 16,
    paddingTop: 8,
    height: '92%',
    gap: 12,
  },
  grabber: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#C9C6C0',
    alignSelf: 'center',
  },
  sheetTitle: { fontSize: 22, fontFamily: AppFont.bold, color: colors.ink },
  cancel: {
    backgroundColor: colors.surface,
    borderRadius: 18,
    paddingHorizontal: 14,
    minHeight: 36,
    justifyContent: 'center',
  },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.fill,
    borderRadius: 14,
    paddingHorizontal: 14,
    minHeight: 48,
  },
  searchInput: { flex: 1, fontSize: 17, color: colors.ink },
  list: { flex: 1, backgroundColor: colors.surface, borderRadius: 18, overflow: 'hidden' },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    minHeight: 54,
  },
  separator: { height: 1, backgroundColor: colors.divider, marginLeft: 56 },
});
