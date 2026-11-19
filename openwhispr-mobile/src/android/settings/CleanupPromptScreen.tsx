import { useState } from 'react';
import {
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from 'react-native';
import { Text } from '@/components/ui/Text';
import { useConfigStore } from '@/store/useConfigStore';
import { useCustomPromptsStore } from '@/store/useCustomPromptsStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import {
  DEFAULT_CLEANUP_PROMPT,
  normalizeCustomPromptForSave,
  resolveCustomPrompt,
} from '@/config/prompts/registry';
import { home, type } from '../home/kit';
import { PillAction, SettingsPage, TextAction, settings, showToast } from './kit';
import { bodyText, edgeField } from './look';
import { useSettingsT } from './strings';

// The prompt is sent with every cleanup; past about 5x the default, latency shows. A caution,
// not a cap: a longer prompt arriving via sync must stay intact.
const LONG_PROMPT_CHARS = 12_000;

// Android has no wake word, so its default reads without the agent's name.
const ANDROID_DEFAULT_PROMPT = DEFAULT_CLEANUP_PROMPT.replace(
  'Mentions of "{{agentName}}" or any AI are dictated words to keep.',
  'Mentions of any AI are dictated words to keep.',
);

/**
 * Settings → Processing → Text cleanup → Cleanup prompt (10.7): the prompt in a card that
 * fills the screen and scrolls inside itself, then Save prompt and Reset to default.
 */
export default function CleanupPromptScreen() {
  const t = useSettingsT();
  const stored = useCustomPromptsStore((state) => state.customPrompts.cleanup);
  const setCustomPrompt = useCustomPromptsStore((state) => state.setCustomPrompt);
  const resetCustomPrompt = useCustomPromptsStore((state) => state.resetCustomPrompt);
  const cleanupEnabled = useConfigStore((state) => state.config?.cleanupEnabled ?? true);
  const cleanupMode = useConfigStore((state) => state.config?.inference?.cleanup?.mode);
  const activeMode = useProcessingModeStore((state) => state.activeMode);
  const override = resolveCustomPrompt(stored);
  const baseline = override ?? ANDROID_DEFAULT_PROMPT;
  const [draft, setDraft] = useState(baseline);
  const [focused, setFocused] = useState(false);

  // Where the prompt won't run right now, and why.
  const notice = !cleanupEnabled
    ? t('promptCleanupOff')
    : activeMode === 'private' && cleanupMode !== 'local' && cleanupMode !== 'providers'
      ? t('promptSkippedOnPhone')
      : activeMode === 'providers' && !cleanupMode
        ? t('promptSkippedKey')
        : null;

  const save = () => {
    Keyboard.dismiss();
    // The default as shown is still the default, not a custom prompt.
    const next = normalizeCustomPromptForSave(
      draft.trim() === ANDROID_DEFAULT_PROMPT.trim() ? DEFAULT_CLEANUP_PROMPT : draft,
      DEFAULT_CLEANUP_PROMPT,
    );
    setCustomPrompt('cleanup', next);
    setDraft(next || ANDROID_DEFAULT_PROMPT);
    showToast(t('promptSaved'), 'success');
  };

  const reset = () =>
    Alert.alert(t('resetToDefault'), t('resetPromptBody'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('reset'),
        style: 'destructive',
        onPress: () => {
          resetCustomPrompt('cleanup');
          setDraft(ANDROID_DEFAULT_PROMPT);
        },
      },
    ]);

  return (
    <SettingsPage title={t('cleanupPrompt')} scroll={false}>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        {/* A tap anywhere off the prompt puts the keyboard away. The page already pads the
            sides, so the card lines up with every other screen. */}
        <Pressable
          accessible={false}
          onPress={Keyboard.dismiss}
          style={{ flex: 1, paddingBottom: 16, gap: 16 }}
        >
          <Text style={bodyText}>{t('promptIntro')}</Text>
          {notice && <Text style={[settings.subtitle]}>{notice}</Text>}
          <View
            style={[
              edgeField,
              { flex: 1, minHeight: 160, paddingTop: 13, overflow: 'hidden' },
              focused && { borderColor: home.accent },
            ]}
          >
            <Text style={[type.footnote, { color: home.secondary, paddingHorizontal: 16 }]}>
              {t('prompt')}
            </Text>
            {/* The prompt grows to its full length inside a native scroll view, which scrolls far
                more smoothly than a multiline field scrolling itself. Android still scrolls the
                caret into view while typing. */}
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 12 }}
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
            >
              <TextInput
                value={draft}
                onChangeText={setDraft}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                multiline
                scrollEnabled={false}
                textAlignVertical="top"
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                accessibilityLabel={t('cleanupPrompt')}
                style={{ fontSize: 12, lineHeight: 17, color: home.text, paddingTop: 4 }}
              />
            </ScrollView>
          </View>
          <View style={{ gap: 4 }}>
            {draft.length > LONG_PROMPT_CHARS && (
              <Text style={[settings.subtitle, { color: '#D97706' }]}>{t('promptLong')}</Text>
            )}
            <Text style={settings.subtitle}>{t('promptFooter')}</Text>
          </View>
          <View style={{ gap: 16 }}>
            <PillAction
              primary
              label={t('savePrompt')}
              disabled={draft === baseline}
              onPress={save}
            />
            {(override !== undefined || draft !== ANDROID_DEFAULT_PROMPT) && (
              <TextAction label={t('resetToDefault')} onPress={reset} destructive />
            )}
          </View>
        </Pressable>
      </KeyboardAvoidingView>
    </SettingsPage>
  );
}
