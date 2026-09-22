import { useCallback, useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, TextInput, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { SpaceGrotesk } from '@/lib/fonts';
import { getStepProgress, useOnboardingStore } from '@/store/useOnboardingStore';
import { useConfigStore } from '@/store/useConfigStore';
import { detectPreferredLanguages } from '@/lib/deviceLanguages';
// TODO: extract this registry into a shared @openwhispr/language-registry package
// so the desktop and mobile apps can't drift. Currently this file is a snapshot
// copy of openwhispr/src/config/languageRegistry.json — re-copy after desktop
// adds new Whisper languages until the shared package exists.
import registry from '@/config/languageRegistry.json';

const STEP_ID = 'language';

interface RegistryEntry {
  code: string;
  label: string;
  whisper?: boolean;
}

interface SupportedLanguage {
  code: string;
  label: string;
  native: string;
  flag: string;
}

// Map of ISO 639-1 language codes → ISO 3166-1 alpha-2 country codes for flag
// rendering. Picks a representative country when a language spans many
// (Arabic→SA, Spanish→ES). Falls back to a globe emoji for codes not listed.
// Must be declared before WHISPER_LANGUAGES so flagFor() can read it at
// module init time.
const LANGUAGE_TO_COUNTRY: Record<string, string> = {
  af: 'ZA',
  ar: 'SA',
  hy: 'AM',
  az: 'AZ',
  be: 'BY',
  bs: 'BA',
  bg: 'BG',
  ca: 'ES',
  hr: 'HR',
  cs: 'CZ',
  da: 'DK',
  nl: 'NL',
  en: 'US',
  et: 'EE',
  fi: 'FI',
  fr: 'FR',
  gl: 'ES',
  de: 'DE',
  el: 'GR',
  he: 'IL',
  hi: 'IN',
  hu: 'HU',
  is: 'IS',
  id: 'ID',
  it: 'IT',
  ja: 'JP',
  kn: 'IN',
  kk: 'KZ',
  ko: 'KR',
  lv: 'LV',
  lt: 'LT',
  mk: 'MK',
  ms: 'MY',
  mr: 'IN',
  mi: 'NZ',
  ne: 'NP',
  no: 'NO',
  fa: 'IR',
  pl: 'PL',
  pt: 'PT',
  ro: 'RO',
  ru: 'RU',
  sr: 'RS',
  sk: 'SK',
  sl: 'SI',
  es: 'ES',
  sw: 'KE',
  sv: 'SE',
  tl: 'PH',
  ta: 'IN',
  th: 'TH',
  tr: 'TR',
  uk: 'UA',
  ur: 'PK',
  vi: 'VN',
  cy: 'GB',
  zh: 'CN',
};

function countryToFlag(country: string): string {
  return country
    .toUpperCase()
    .replace(/./g, (c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65));
}

function flagFor(code: string): string {
  if (code.includes('-')) {
    const region = code.split('-')[1];
    if (region && region.length === 2) return countryToFlag(region);
  }
  const country = LANGUAGE_TO_COUNTRY[code.toLowerCase()];
  return country ? countryToFlag(country) : '🌐';
}

function resolveNativeName(code: string, fallback: string): string {
  try {
    const base = code.split('-')[0];
    const native = new Intl.DisplayNames([code], { type: 'language' }).of(base);
    return native || fallback;
  } catch {
    return fallback;
  }
}

const WHISPER_LANGUAGES: SupportedLanguage[] = (registry.languages as RegistryEntry[])
  .filter((entry) => entry.whisper)
  .map((entry) => ({
    code: entry.code,
    label: entry.label,
    native: resolveNativeName(entry.code, entry.label),
    flag: flagFor(entry.code),
  }))
  .sort((a, b) => a.label.localeCompare(b.label));

const LANGUAGE_BY_CODE = new Map(WHISPER_LANGUAGES.map((l) => [l.code, l]));

export function LanguageStep() {
  const goNext = useOnboardingStore((s) => s.goNext);
  const goToStep = useOnboardingStore((s) => s.goToStep);
  const updateConfig = useConfigStore((s) => s.updateConfig);

  const detectedCodes = useMemo(detectPreferredLanguages, []);
  const [selected, setSelected] = useState<string[]>(() => detectedCodes);
  const [sheetVisible, setSheetVisible] = useState(false);

  const selectedLanguages = useMemo(
    () =>
      selected.map((code) => LANGUAGE_BY_CODE.get(code)).filter((l): l is SupportedLanguage => !!l),
    [selected],
  );

  const remove = useCallback((code: string) => {
    setSelected((prev) => prev.filter((c) => c !== code));
  }, []);

  const add = useCallback((code: string) => {
    setSelected((prev) => (prev.includes(code) ? prev : [...prev, code]));
    setSheetVisible(false);
  }, []);

  const handleContinue = useCallback(async () => {
    await updateConfig({ languages: selected });
    // The mode picked on the previous step decides what's next: private users download the
    // model their languages route to; cloud users skip the download step entirely.
    const mode = useConfigStore.getState().config?.defaultMode;
    if (mode === 'private') {
      await goNext(); // → 'private-download'
    } else {
      await goToStep('notifications');
    }
  }, [selected, updateConfig, goNext, goToStep]);

  const subtitle = detectedCodes.length
    ? 'We picked these from your keyboard. Add or remove based on your preference.'
    : 'Pick the languages you want OpenWhispr to recognize.';

  return (
    <>
      <OnboardingShell
        progress={getStepProgress(STEP_ID)}
        title="Choose your languages"
        titleAccent="languages"
        subtitle={subtitle}
        ctaLabel="Continue"
        ctaDisabled={selected.length === 0}
        onCta={handleContinue}
        secondaryCtaLabel="Add a language"
        onSecondaryCta={() => setSheetVisible(true)}
        secondaryCtaVariant="card"
      >
        {selectedLanguages.length === 0 ? (
          <View className="flex-1 items-center justify-center">
            <Text className="px-6 text-center text-[15px] text-tertiaryLabel">
              No languages selected. Tap "Add a language" to get started.
            </Text>
          </View>
        ) : (
          <FlatList
            data={selectedLanguages}
            keyExtractor={(item) => item.code}
            showsVerticalScrollIndicator={false}
            ItemSeparatorComponent={ListSeparator}
            renderItem={({ item }) => (
              <SelectedLanguageCard language={item} onRemove={() => remove(item.code)} />
            )}
          />
        )}
      </OnboardingShell>

      <AddLanguageSheet
        visible={sheetVisible}
        excludeCodes={selected}
        onPick={add}
        onClose={() => setSheetVisible(false)}
      />
    </>
  );
}

function ListSeparator() {
  return <View className="h-3" />;
}

function SelectedLanguageCard({
  language,
  onRemove,
}: {
  language: SupportedLanguage;
  onRemove: () => void;
}) {
  return (
    <View className="flex-row items-center rounded-2xl border border-separator bg-secondarySystemGroupedBackground px-4 py-3">
      <Text className="text-[28px]">{language.flag}</Text>
      <Text className="ml-3 flex-1 text-[16px] font-semibold text-label">
        {language.label}
        {language.native !== language.label ? (
          <Text className="text-secondaryLabel"> ({language.native})</Text>
        ) : null}
      </Text>
      <Pressable
        onPress={onRemove}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel={`Remove ${language.label}`}
        className="active:opacity-60"
      >
        <SystemIcon name="xmark" mdName="X" size={18} color="tertiaryLabel" />
      </Pressable>
    </View>
  );
}

function AddLanguageSheet({
  visible,
  excludeCodes,
  onPick,
  onClose,
}: {
  visible: boolean;
  excludeCodes: string[];
  onPick: (code: string) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');

  const excludeSet = useMemo(() => new Set(excludeCodes), [excludeCodes]);
  const available = useMemo(() => {
    const term = query.trim().toLowerCase();
    const filtered = WHISPER_LANGUAGES.filter((l) => !excludeSet.has(l.code));
    if (!term) return filtered;
    return filtered.filter(
      (l) => l.label.toLowerCase().includes(term) || l.native.toLowerCase().includes(term),
    );
  }, [excludeSet, query]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
      onDismiss={() => setQuery('')}
    >
      <View className="flex-1 bg-systemBackground">
        <View className="flex-row items-center justify-between px-6 pb-4 pt-8">
          <Text className="text-[22px] font-bold text-label">Add a language</Text>
          <Pressable
            onPress={onClose}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
          >
            <Text className="text-[17px] font-medium text-link">Cancel</Text>
          </Pressable>
        </View>

        <View className="px-6 pb-4">
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={`Search ${WHISPER_LANGUAGES.length} languages`}
            placeholderTextColor="#9CA3AF"
            autoCorrect={false}
            autoCapitalize="none"
            className="h-11 rounded-lg bg-secondarySystemGroupedBackground px-4 text-[15px] text-label"
            style={{ fontFamily: SpaceGrotesk.regular }}
          />
        </View>

        <FlatList
          data={available}
          keyExtractor={(item) => item.code}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: insets.bottom + 24 }}
          ItemSeparatorComponent={ListSeparator}
          ListEmptyComponent={
            <Text className="mt-12 text-center text-[15px] text-tertiaryLabel">
              No languages match "{query}".
            </Text>
          }
          renderItem={({ item }) => (
            <Pressable
              onPress={() => onPick(item.code)}
              accessibilityRole="button"
              accessibilityLabel={`Add ${item.label}`}
              className="flex-row items-center rounded-2xl border border-separator bg-secondarySystemGroupedBackground px-4 py-3 active:opacity-80"
            >
              <Text className="text-[28px]">{item.flag}</Text>
              <Text className="ml-3 flex-1 text-[16px] font-semibold text-label">
                {item.label}
                {item.native !== item.label ? (
                  <Text className="text-secondaryLabel"> ({item.native})</Text>
                ) : null}
              </Text>
              <SystemIcon name="plus" mdName="Plus" size={18} color="brand" />
            </Pressable>
          )}
        />
      </View>
    </Modal>
  );
}
