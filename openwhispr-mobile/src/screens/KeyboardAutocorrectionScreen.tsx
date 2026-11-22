import React, { useCallback } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SettingsScreen } from '@/components/ui/SettingsScreen';
import { SettingsRow, SettingsSection } from '@/components/ui/SettingsSection';
import { SettingsSwitch } from '@/components/ui/SettingsSwitch';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useConfigStore } from '@/store/useConfigStore';
import {
  KEYBOARD_AUTOCORRECTION_LANGUAGES,
  MAX_KEYBOARD_AUTOCORRECTION_LANGUAGES,
  normalizeKeyboardAutocorrectionLanguages,
  toggleKeyboardAutocorrectionLanguage,
  type KeyboardAutocorrectionLanguage,
} from '@/lib/keyboardAutocorrection';
import {
  setKeyboardAutocorrectionEnabled,
  setKeyboardAutocorrectionLanguages,
} from '@/lib/keyboardAutocorrectionSync';
import { safeHaptics } from '@/lib/utils';

export default function KeyboardAutocorrectionScreen() {
  const config = useConfigStore((state) => state.config);
  const enabled = config?.keyboardAutocorrectionEnabled ?? true;
  const selected = normalizeKeyboardAutocorrectionLanguages(
    config?.keyboardAutocorrectionLanguages,
  );
  const atLimit = selected.length >= MAX_KEYBOARD_AUTOCORRECTION_LANGUAGES;

  const onToggleEnabled = useCallback((next: boolean): void => {
    safeHaptics('light');
    setKeyboardAutocorrectionEnabled(next);
  }, []);

  const onToggleLanguage = useCallback(
    (code: KeyboardAutocorrectionLanguage): void => {
      const next = toggleKeyboardAutocorrectionLanguage(selected, code);
      if (next.join(',') === selected.join(',')) return;
      safeHaptics('selection');
      setKeyboardAutocorrectionLanguages(next);
    },
    [selected],
  );

  return (
    <View className="flex-1 bg-systemBackground">
      <SettingsScreen>
        <View className="mx-4 mb-2 px-4">
          <Text className="text-[13px] text-secondaryLabel">
            Fixes obvious typos in words you type on the OpenWhispr keyboard when you tap space.
            Backspace right after a correction restores what you typed. Dictations are never
            changed.
          </Text>
        </View>

        <SettingsSection>
          <SettingsRow
            iconStyle="line"
            icon="textformat.abc.dottedunderline"
            mdIcon="SpellCheck"
            title="Autocorrection"
            rightElement={<SettingsSwitch value={enabled} onValueChange={onToggleEnabled} />}
            showChevron={false}
          />
        </SettingsSection>

        <SettingsSection title="Languages">
          {KEYBOARD_AUTOCORRECTION_LANGUAGES.map((language) => {
            const isSelected = selected.includes(language.code);
            const isLast = isSelected && selected.length === 1;
            return (
              <SettingsRow
                key={language.code}
                iconStyle="line"
                icon="globe"
                mdIcon="Globe"
                title={language.label}
                description={isLast ? 'At least one language stays selected' : undefined}
                onPress={() => onToggleLanguage(language.code)}
                selected={isSelected}
                disabled={!enabled || (!isSelected && atLimit)}
                rightElement={
                  isSelected ? (
                    <SystemIcon name="checkmark" mdName="Check" size={18} color="systemBlue" />
                  ) : undefined
                }
                showChevron={false}
              />
            );
          })}
        </SettingsSection>

        <View className="mx-4 mb-6 px-4">
          <Text className="text-[13px] text-secondaryLabel">
            {`Pick the languages you type in, up to ${MAX_KEYBOARD_AUTOCORRECTION_LANGUAGES}. A word any of them knows is left as typed, so fewer languages means more corrections. Without Full Access the keyboard can't read these settings, so it keeps correcting German and English.`}
          </Text>
        </View>
      </SettingsScreen>
    </View>
  );
}
