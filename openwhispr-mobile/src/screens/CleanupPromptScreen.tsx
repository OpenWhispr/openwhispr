import React, { useCallback, useState } from 'react';
import { Keyboard, Pressable, TextInput, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SettingsScreen } from '@/components/ui/SettingsScreen';
import { SettingsSection } from '@/components/ui/SettingsSection';
import { useConfigStore } from '@/store/useConfigStore';
import { useCustomPromptsStore } from '@/store/useCustomPromptsStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { useKeyboardHeight } from '@/hooks/useKeyboardHeight';
import {
  AGENT_NAME_PLACEHOLDER,
  DEFAULT_CLEANUP_PROMPT,
  hasAgentNamePlaceholder,
  normalizeCustomPromptForSave,
  resolveCustomPrompt,
} from '@/config/prompts/registry';
import { confirmDestructive } from '@/lib/alerts';
import { safeHaptics } from '@/lib/utils';
import { SpaceGrotesk } from '@/lib/fonts';

// The prompt is re-sent with every cleanup request; ~5x the shipped default
// is where latency becomes noticeable. A caution, not a cap: the server has
// none, and a longer prompt arriving via sync must stay intact.
const LONG_PROMPT_CHARS = 12_000;

export default function CleanupPromptScreen() {
  const stored = useCustomPromptsStore((state) => state.customPrompts.cleanup);
  const setCustomPrompt = useCustomPromptsStore((state) => state.setCustomPrompt);
  const resetCustomPrompt = useCustomPromptsStore((state) => state.resetCustomPrompt);
  const cleanupEnabled = useConfigStore((state) => state.config?.cleanupEnabled ?? true);
  const activeMode = useProcessingModeStore((state) => state.activeMode);
  const keyboardHeight = useKeyboardHeight();

  const override = resolveCustomPrompt(stored);
  const baseline = override ?? DEFAULT_CLEANUP_PROMPT;
  const [draft, setDraft] = useState(baseline);

  const isActive = activeMode === 'cloud' && cleanupEnabled;
  const isDirty = draft !== baseline;
  const missingPlaceholder = !hasAgentNamePlaceholder(draft);

  const save = useCallback((): void => {
    Keyboard.dismiss();
    const next = normalizeCustomPromptForSave(draft, DEFAULT_CLEANUP_PROMPT);
    setCustomPrompt('cleanup', next);
    setDraft(next || DEFAULT_CLEANUP_PROMPT);
    safeHaptics('success');
  }, [draft, setCustomPrompt]);

  const reset = useCallback((): void => {
    confirmDestructive(
      'Reset to Default',
      'Your custom cleanup prompt will be removed and the built-in prompt used instead.',
      () => {
        resetCustomPrompt('cleanup');
        setDraft(DEFAULT_CLEANUP_PROMPT);
        safeHaptics('medium');
      },
      { destructiveLabel: 'Reset' },
    );
  }, [resetCustomPrompt]);

  return (
    <View className="flex-1 bg-systemBackground">
      <SettingsScreen
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerStyle={{ paddingBottom: keyboardHeight + 40 }}
      >
        <View className="mx-4 mb-2 px-4">
          <Text className="text-[13px] text-secondaryLabel">
            The instructions OpenWhispr's cloud AI follows when it cleans up dictation from the app,
            the keyboard, and uploaded recordings. Keep {AGENT_NAME_PLACEHOLDER} where your agent's
            name belongs.
          </Text>
        </View>

        {!isActive ? (
          <View className="mx-4 mb-3">
            <View className="rounded-[14px] border border-separator bg-secondarySystemGroupedBackground px-4 py-3">
              <Text className="text-[13px] text-secondaryLabel">
                The cleanup prompt requires Cloud mode with Dictation Cleanup turned on. Your prompt
                is saved and will apply once both are active.
              </Text>
            </View>
          </View>
        ) : null}

        <SettingsSection title="Prompt">
          <View className="px-4 py-3">
            <TextInput
              accessibilityLabel="Cleanup prompt"
              value={draft}
              onChangeText={setDraft}
              multiline
              textAlignVertical="top"
              scrollEnabled={false}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              className="min-h-[240px] text-[15px] leading-[22px] text-label"
              style={{ fontFamily: SpaceGrotesk.regular }}
            />
          </View>
        </SettingsSection>

        <View className="mx-4 -mt-5 mb-6 gap-1 px-4">
          {missingPlaceholder ? (
            <Text className="text-[13px] text-systemOrange">
              {AGENT_NAME_PLACEHOLDER} is missing, so the prompt won't know your agent's name.
            </Text>
          ) : null}
          {draft.length > LONG_PROMPT_CHARS ? (
            <Text className="text-[13px] text-systemOrange">Long prompts slow down cleanup.</Text>
          ) : null}
          <Text className="text-[13px] text-secondaryLabel">
            Sent to OpenWhispr's cloud with every cleanup request. Language, dictionary, and tone
            instructions are added automatically.
          </Text>
        </View>

        <View className="mx-4 gap-2">
          <Pressable
            onPress={save}
            disabled={!isDirty}
            className={'items-center rounded-[10px] py-3 ' + (isDirty ? 'bg-brand' : 'bg-brand/30')}
            style={({ pressed }) => ({
              borderCurve: 'continuous',
              opacity: pressed ? 0.85 : 1,
              transform: [{ scale: pressed ? 0.98 : 1 }],
            })}
          >
            <Text className="text-[15px] font-semibold text-white">Save Prompt</Text>
          </Pressable>
          {override !== undefined || isDirty ? (
            <Pressable
              onPress={reset}
              className="items-center py-2"
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            >
              <Text className="text-[15px] font-semibold text-systemRed">Reset to Default</Text>
            </Pressable>
          ) : null}
        </View>
      </SettingsScreen>
    </View>
  );
}
