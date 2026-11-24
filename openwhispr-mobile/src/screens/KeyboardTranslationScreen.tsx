import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SettingsScreen } from '@/components/ui/SettingsScreen';
import { SettingsRow, SettingsSection } from '@/components/ui/SettingsSection';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useConfigStore } from '@/store/useConfigStore';
import { useAuthStore } from '@/store/useAuthStore';
import { requiresRealAccount } from '@/lib/accountAccess';
import { AppleLLM } from '@/lib/appleLLM';
import { dictationRoute } from '@/lib/keyboardDirectInputs';
import {
  isTranslationApplicable,
  translationLanguagesFor,
  type CleanupRouteMode,
} from '@/lib/keyboardTranslation';
import { setKeyboardTranslationTarget } from '@/lib/keyboardTranslationSync';
import { safeHaptics } from '@/lib/utils';

export default function KeyboardTranslationScreen(): React.JSX.Element {
  const selected = useConfigStore((state) => state.config?.keyboardTranslationTarget ?? null);
  const user = useAuthStore((state) => state.user);
  const route = dictationRoute();
  const mode: CleanupRouteMode = route?.cleanupMode ?? null;
  const guest = requiresRealAccount(user);
  const applicable = isTranslationApplicable({
    mode,
    cleanupUnavailable: route?.cleanupUnavailable ?? false,
    guest,
  });
  // Only the sign-in note when that is the actual reason; other reasons just dim the rows.
  const needsSignIn = mode === 'openwhispr' && guest;

  // [] from the module means unknown, which the language list treats as "all".
  const [onDeviceCodes, setOnDeviceCodes] = useState<string[] | null>(null);
  useEffect(() => {
    if (mode !== 'local') return;
    let cancelled = false;
    AppleLLM.getSupportedLanguages().then((codes) => {
      if (!cancelled) setOnDeviceCodes(codes.length > 0 ? codes : null);
    });
    return () => {
      cancelled = true;
    };
  }, [mode]);

  const languages = translationLanguagesFor(mode, onDeviceCodes);

  const onSelect = useCallback((code: string | null): void => {
    safeHaptics('selection');
    setKeyboardTranslationTarget(code);
  }, []);

  const renderRow = (code: string | null, label: string): React.JSX.Element => (
    <SettingsRow
      key={code ?? 'off'}
      iconStyle="line"
      icon="character.bubble"
      mdIcon="Languages"
      title={label}
      onPress={() => onSelect(code)}
      // Off must stay reachable so a stored target can always be cleared.
      disabled={code !== null && !applicable}
      selected={selected === code}
      rightElement={
        selected === code ? (
          <SystemIcon name="checkmark" mdName="Check" size={18} color="systemBlue" />
        ) : undefined
      }
      showChevron={false}
    />
  );

  return (
    <View className="flex-1 bg-systemBackground">
      <SettingsScreen>
        <View className="mx-4 mb-2 px-4">
          <Text className="text-[13px] text-secondaryLabel">
            Types your keyboard dictations in another language. Applies to keyboard dictation only,
            not personal recordings, uploaded files, or meetings.
          </Text>
        </View>

        {needsSignIn ? (
          <View className="mx-4 mb-3" style={{ borderCurve: 'continuous' }}>
            <View className="rounded-[14px] border border-separator bg-secondarySystemGroupedBackground px-4 py-3">
              <Text className="text-[13px] text-secondaryLabel">
                Sign in to translate dictation.
              </Text>
            </View>
          </View>
        ) : null}

        <SettingsSection title="Translate to">
          {renderRow(null, 'Off')}
          {languages.map((language) => renderRow(language.code, language.label))}
        </SettingsSection>
      </SettingsScreen>
    </View>
  );
}
