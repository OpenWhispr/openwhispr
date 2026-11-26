import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SettingsScreen } from '@/components/ui/SettingsScreen';
import { SettingsRow, SettingsSection } from '@/components/ui/SettingsSection';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useConfigStore } from '@/store/useConfigStore';
import { useAuthStore } from '@/store/useAuthStore';
import { requiresRealAccount } from '@/lib/accountAccess';
import { dictationRoute } from '@/lib/keyboardDirectInputs';
import {
  isTranslationApplicable,
  translationLabel,
  translationLanguagesFor,
  type CleanupRouteMode,
} from '@/lib/keyboardTranslation';
import {
  readOnDeviceTranslationSupport,
  setKeyboardTranslationTarget,
  type OnDeviceTranslationSupport,
} from '@/lib/keyboardTranslationSync';
import { getLocalReasoningUnavailableMessage } from '@/lib/localReasoning';
import { safeHaptics } from '@/lib/utils';

export default function KeyboardTranslationScreen(): React.JSX.Element {
  const selected = useConfigStore((state) => state.config?.keyboardTranslationTarget ?? null);
  const user = useAuthStore((state) => state.user);
  const route = dictationRoute();
  const mode: CleanupRouteMode = route?.cleanupMode ?? null;
  const guest = requiresRealAccount(user);

  // Unknown (null) lists every language and counts as ready, as the keyboard sync does.
  const [onDevice, setOnDevice] = useState<OnDeviceTranslationSupport | null>(null);
  useEffect(() => {
    if (mode !== 'local') return;
    let cancelled = false;
    readOnDeviceTranslationSupport()
      .then((support) => {
        if (!cancelled) setOnDevice(support);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [mode]);

  const onDeviceUnavailable =
    mode === 'local' && onDevice !== null && onDevice.readiness.status !== 'ready';
  const applicable = isTranslationApplicable({
    mode,
    cleanupUnavailable: route?.cleanupUnavailable ?? false,
    guest,
    onDeviceUnavailable,
  });
  const languages = translationLanguagesFor(mode, onDevice?.codes ?? null);
  // A language On-Device can't translate into is kept for when the route changes (the keyboard
  // shows Off meanwhile), so say why it isn't used. Other routes list every language.
  const selectedUnlisted =
    mode === 'local' &&
    selected !== null &&
    !languages.some((language) => language.code === selected);

  // Say why the languages are locked, or why a saved one isn't used.
  let note: string | null = null;
  if (route === null || route.cleanupUnavailable) {
    note = 'Translation runs on your cleanup model. Finish setting it up in AI Models.';
  } else if (mode === 'openwhispr' && guest) {
    note = `${user?.isAnonymous ? 'Create an account' : 'Sign in'} to translate dictation.`;
  } else if (onDeviceUnavailable && onDevice) {
    note = getLocalReasoningUnavailableMessage(onDevice.readiness);
  } else if (selectedUnlisted) {
    note = `Apple Intelligence can't translate into ${translationLabel(selected)}, so dictation isn't translated while cleanup runs On-Device. Your choice is saved.`;
  }

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

        {note ? (
          <View className="mx-4 mb-3" style={{ borderCurve: 'continuous' }}>
            <View className="rounded-[14px] border border-separator bg-secondarySystemGroupedBackground px-4 py-3">
              <Text className="text-[13px] text-secondaryLabel">{note}</Text>
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
