import React, { useCallback } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SettingsScreen } from '@/components/ui/SettingsScreen';
import { SettingsRow, SettingsSection } from '@/components/ui/SettingsSection';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useConfigStore } from '@/store/useConfigStore';
import { KEYBOARD_LETTER_LAYOUTS, coerceLetterLayout } from '@/lib/keyboardLayout';
import { setKeyboardLetterLayout } from '@/lib/keyboardLayoutSync';
import { safeHaptics } from '@/lib/utils';
import type { KeyboardLetterLayout } from '@/types';

export default function KeyboardLayoutScreen() {
  const selected = useConfigStore((state) =>
    coerceLetterLayout(state.config?.keyboardLetterLayout),
  );

  const onSelect = useCallback((layout: KeyboardLetterLayout): void => {
    safeHaptics('selection');
    setKeyboardLetterLayout(layout);
  }, []);

  return (
    <View className="flex-1 bg-systemBackground">
      <SettingsScreen>
        <View className="mx-4 mb-2 px-4">
          <Text className="text-[13px] text-secondaryLabel">
            The letter keys you type with between dictations. Dictation and its language don’t
            change. The keyboard needs Full Access to read this setting, and shows the new keys the
            next time it opens.
          </Text>
        </View>

        <SettingsSection title="Layout">
          {KEYBOARD_LETTER_LAYOUTS.map((layout) => (
            <SettingsRow
              key={layout.value}
              iconStyle="line"
              icon="keyboard"
              mdIcon="Keyboard"
              title={layout.label}
              description={layout.description}
              onPress={() => onSelect(layout.value)}
              selected={selected === layout.value}
              rightElement={
                selected === layout.value ? (
                  <SystemIcon name="checkmark" mdName="Check" size={18} color="systemBlue" />
                ) : undefined
              }
              showChevron={false}
            />
          ))}
        </SettingsSection>
      </SettingsScreen>
    </View>
  );
}
