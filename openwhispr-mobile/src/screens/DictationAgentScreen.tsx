import React, { useCallback, useState } from 'react';
import { TextInput, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SettingsScreen } from '@/components/ui/SettingsScreen';
import { SettingsRow, SettingsSection } from '@/components/ui/SettingsSection';
import { SettingsSwitch } from '@/components/ui/SettingsSwitch';
import { useConfigStore } from '@/store/useConfigStore';
import { useConfigToggle } from '@/hooks/useConfigToggle';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { getDictationAgentName, isDictationAgentEnabled } from '@/lib/dictationAgent';
import { safeHaptics } from '@/lib/utils';
import { iosColor } from '@/config/colors';
import { SpaceGrotesk } from '@/lib/fonts';

const DEFAULT_AGENT_NAME = 'OpenWhispr';

export function DictationAgentScreen(): React.JSX.Element {
  const config = useConfigStore((state) => state.config);
  const updateConfig = useConfigStore((state) => state.updateConfig);
  const activeMode = useProcessingModeStore((state) => state.activeMode);

  const isCloudMode = activeMode === 'cloud';
  const enabled = config ? isDictationAgentEnabled(config) : true;
  const shareContext = config?.dictationAgentShareContext ?? false;
  const currentName = config ? getDictationAgentName(config) : DEFAULT_AGENT_NAME;

  const [nameValue, setNameValue] = useState(currentName);

  const handleToggleEnabled = useConfigToggle('dictationAgentEnabled');
  const handleToggleShareContext = useConfigToggle('dictationAgentShareContext');

  const commitName = useCallback((): void => {
    const trimmed = nameValue.trim();
    // Empty or whitespace-only falls back to default — persist undefined so
    // getDictationAgentName's default kicks in rather than storing an empty string.
    const nextName = trimmed.length > 0 ? trimmed : undefined;
    safeHaptics('light');
    updateConfig({ dictationAgentName: nextName });
    setNameValue(trimmed.length > 0 ? trimmed : DEFAULT_AGENT_NAME);
  }, [nameValue, updateConfig]);

  return (
    <View className="flex-1 bg-systemBackground">
      <SettingsScreen keyboardShouldPersistTaps="handled">
        <View className="mx-4 mb-2 px-4">
          <Text className="text-[13px] text-secondaryLabel">
            When you say your agent name while dictating, OpenWhispr rewrites what you said into
            polished, ready-to-use text instead of inserting it word for word. Requires Cloud mode.
          </Text>
        </View>

        {!isCloudMode ? (
          <View className="mx-4 mb-3">
            <View
              className="rounded-[14px] border border-separator bg-secondarySystemGroupedBackground px-4 py-3"
              style={{ borderCurve: 'continuous' }}
            >
              <Text className="text-[13px] text-secondaryLabel">
                Dictation Agent requires Cloud mode. Your settings are saved and will apply once
                Cloud mode is active.
              </Text>
            </View>
          </View>
        ) : null}

        <SettingsSection>
          <SettingsRow
            iconStyle="line"
            icon="person.wave.2"
            mdIcon="UserRoundCog"
            title="Enable Dictation Agent"
            description="Say your agent name while dictating to have OpenWhispr rewrite what you said."
            rightElement={
              <SettingsSwitch
                value={enabled}
                onValueChange={handleToggleEnabled}
                disabled={!isCloudMode}
              />
            }
            showChevron={false}
          />
        </SettingsSection>

        <SettingsSection title="Agent Name">
          <View className="px-4 py-3">
            <TextInput
              value={nameValue}
              onChangeText={setNameValue}
              onBlur={commitName}
              onSubmitEditing={commitName}
              placeholder={DEFAULT_AGENT_NAME}
              placeholderTextColor={iosColor('tertiaryLabel')}
              autoCapitalize="words"
              autoCorrect={false}
              returnKeyType="done"
              editable={isCloudMode}
              className={`text-[17px] text-label ${isCloudMode ? '' : 'opacity-40'}`}
              style={{ fontFamily: SpaceGrotesk.regular }}
            />
          </View>
        </SettingsSection>
        <View className="mx-4 -mt-5 mb-7 px-4">
          <Text className="text-[13px] text-secondaryLabel">
            Say this name anywhere while dictating to trigger the agent. The name is automatically
            added to your transcription hints so the speech model recognises it.
          </Text>
        </View>

        <SettingsSection>
          <SettingsRow
            iconStyle="line"
            icon="text.cursor"
            mdIcon="TextCursor"
            title="Share Cursor Context"
            description="Selected text is always sent when you use the agent. When on, the surrounding text near your cursor is also sent. Off by default."
            rightElement={
              <SettingsSwitch
                value={shareContext}
                onValueChange={handleToggleShareContext}
                disabled={!isCloudMode}
              />
            }
            showChevron={false}
          />
        </SettingsSection>
      </SettingsScreen>
    </View>
  );
}
