import React, { useState } from 'react';
import { Alert, Platform, Pressable } from 'react-native';
import { MenuView } from '@react-native-menu/menu';
import { router } from 'expo-router';
import { SettingsRow, SettingsSection } from '@/components/ui/SettingsSection';
import { SettingsScreen } from '@/components/ui/SettingsScreen';
import { SettingsSwitch } from '@/components/ui/SettingsSwitch';
import { SoonBadge } from '@/components/ui/SoonBadge';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { Text } from '@/components/ui/Text';
import { useConfigStore } from '@/store/useConfigStore';
import { useConfigToggle } from '@/hooks/useConfigToggle';
import { DEFAULT_LANGUAGE, getLanguage } from '@/lib/languages';
import { toneLabel, DEFAULT_KEYBOARD_TONE } from '@/lib/keyboardTone';
import { getDictationAgentName } from '@/lib/dictationAgent';
import {
  KEYBOARD_TYPING_LANGUAGES,
  KEYBOARD_TYPING_LAYOUTS,
  clearKeyboardLearnedWords,
  keyboardHapticsEnabled,
  keyboardTypingLanguage,
  keyboardTypingLayout,
  setKeyboardHapticsEnabled,
  setKeyboardTypingLanguage,
  setKeyboardTypingLayout,
} from '@/lib/keyboardTypingSync';
import { safeHaptics } from '@/lib/utils';
import { AppGroupStorage } from '../../modules/app-group-storage/src';
import { LiveActivity } from '../../modules/live-activity/src';

const AUTOMATIC = 'automatic';

type TypingPickerProps<Value extends string> = {
  label: string;
  options: { value: Value; label: string }[];
  // null is Automatic: the keyboard picks.
  value: Value | null;
  onChange: (value: Value | null) => void;
};

// A row's value that opens a menu of choices, with Automatic first.
function TypingPicker<Value extends string>({
  label,
  options,
  value,
  onChange,
}: TypingPickerProps<Value>): React.ReactElement {
  const current = options.find((option) => option.value === value);
  const currentLabel = current?.label ?? 'Automatic';
  return (
    <MenuView
      title={label}
      shouldOpenOnLongPress={false}
      actions={[
        { id: AUTOMATIC, title: 'Automatic', state: current ? 'off' : 'on' },
        ...options.map((option) => ({
          id: option.value,
          title: option.label,
          state: option.value === current?.value ? ('on' as const) : ('off' as const),
        })),
      ]}
      onPressAction={({ nativeEvent }) => {
        const next = options.find((option) => option.value === nativeEvent.event)?.value ?? null;
        if (next === (current?.value ?? null)) return;
        safeHaptics('selection');
        onChange(next);
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${currentLabel}`}
        className="flex-row items-center gap-1.5"
      >
        <Text numberOfLines={1} className="text-[15px] text-secondaryLabel">
          {currentLabel}
        </Text>
        <SystemIcon
          name="chevron.up.chevron.down"
          mdName="ChevronsUpDown"
          size={13}
          color="tertiaryLabel"
        />
      </Pressable>
    </MenuView>
  );
}

function confirmClearLearnedWords(): void {
  Alert.alert(
    'Clear learned words?',
    'The keyboard forgets the words it has learned from your typing.',
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: clearKeyboardLearnedWords },
    ],
  );
}

export default function PreferencesScreen() {
  const config = useConfigStore((state) => state.config);
  const autoLearn = config?.autoLearnCorrections ?? true;
  const language = getLanguage(config?.preferredLanguage ?? DEFAULT_LANGUAGE);
  const keyboardTone = config?.keyboardTone ?? DEFAULT_KEYBOARD_TONE;
  const agentName = config ? getDictationAgentName(config) : 'OpenWhispr';
  const handleToggleAutoLearn = useConfigToggle('autoLearnCorrections');
  const supportsDirectDictation =
    Platform.OS === 'ios' &&
    Number.parseInt(String(Platform.Version), 10) >= 26 &&
    AppGroupStorage.supportsKeyboardDirectDictation;
  const directDictation = config?.keyboardDirectDictation ?? false;
  const handleToggleDirectDictation = useConfigToggle('keyboardDirectDictation');
  const [dictationMode, setDictationMode] = useState(() => LiveActivity.isDictationModeEnabled());

  return (
    <SettingsScreen>
      <SettingsSection title="General">
        <SettingsRow
          iconStyle="line"
          icon="paintbrush"
          mdIcon="Paintbrush"
          title="Appearance"
          rightElement={<SoonBadge />}
          showChevron={false}
        />
        <SettingsRow
          iconStyle="line"
          icon="globe"
          mdIcon="Globe"
          title="Transcription Language"
          subtitle={language.label}
          onPress={() => router.push('/(account)/transcription-language')}
        />
        <SettingsRow
          iconStyle="line"
          icon="text.book.closed"
          mdIcon="BookText"
          title="Auto-learn from Corrections"
          description="Words you edit into a transcription are automatically added to your dictionary."
          rightElement={<SettingsSwitch value={autoLearn} onValueChange={handleToggleAutoLearn} />}
          showChevron={false}
        />
      </SettingsSection>
      <SettingsSection title="Keyboard">
        {/* First in the section because it is the prerequisite for everything
            below it, and because the person who needs it most is the one whose
            dictation just died. Routes to the recovery screen rather than
            Linking.openSettings(): iOS only ever lands on Settings > OpenWhispr,
            and Full Access is two levels deeper, so the taps have to be taught. */}
        <SettingsRow
          iconStyle="line"
          icon="lock.shield"
          mdIcon="ShieldCheck"
          title="Full Access"
          description="Required for keyboard dictation. Tap for setup steps."
          onPress={() => router.push('/keyboard-full-access')}
        />
        {supportsDirectDictation ? (
          <SettingsRow
            iconStyle="line"
            icon="mic"
            mdIcon="Mic"
            title="Dictate without opening OpenWhispr"
            description="Beta. Records in the keyboard for OpenWhispr Cloud. Bring Your Own Key, Local Mode, a custom cleanup prompt and the assistant still open the app, and so does dictating while music plays or with Bluetooth audio."
            rightElement={
              <SettingsSwitch
                accessibilityLabel="Dictate without opening OpenWhispr"
                value={directDictation}
                onValueChange={handleToggleDirectDictation}
              />
            }
            showChevron={false}
          />
        ) : null}
        <SettingsRow
          iconStyle="line"
          icon="keyboard"
          mdIcon="Keyboard"
          title="Keyboard Tone"
          description="Applies to keyboard dictation only"
          subtitle={toneLabel(keyboardTone)}
          onPress={() => router.push('/(account)/keyboard-tone')}
        />
        <SettingsRow
          iconStyle="line"
          icon="person.wave.2"
          mdIcon="UserRoundCog"
          title="Voice Assistant"
          description="Have the keyboard’s wand write for you"
          subtitle={agentName}
          onPress={() => router.push('/(account)/dictation-agent')}
        />
        <SettingsRow
          iconStyle="line"
          icon="waveform"
          mdIcon="Activity"
          title="Dictation mode"
          description="Show OpenWhispr in the Dynamic Island while you dictate"
          rightElement={
            <SettingsSwitch
              value={dictationMode}
              onValueChange={(next) => {
                LiveActivity.setDictationMode(next);
                setDictationMode(next);
              }}
            />
          }
          showChevron={false}
        />
        {Platform.OS === 'ios' ? (
          <SettingsRow
            iconStyle="line"
            icon="command"
            mdIcon="Command"
            title="Hardware keyboard shortcut"
            description="Dictate into any app from a Magic Keyboard or other hardware keyboard"
            onPress={() => router.push('/(account)/hardware-keyboard')}
          />
        ) : null}
      </SettingsSection>
      {Platform.OS === 'ios' ? (
        <SettingsSection title="Keyboard typing">
          <SettingsRow
            iconStyle="line"
            icon="character.bubble"
            mdIcon="Languages"
            title="Typing language"
            rightElement={
              <TypingPicker
                label="Typing language"
                options={KEYBOARD_TYPING_LANGUAGES}
                value={keyboardTypingLanguage(config)}
                onChange={setKeyboardTypingLanguage}
              />
            }
            showChevron={false}
          />
          <SettingsRow
            iconStyle="line"
            icon="keyboard"
            mdIcon="Keyboard"
            title="Layout"
            rightElement={
              <TypingPicker
                label="Layout"
                options={KEYBOARD_TYPING_LAYOUTS}
                value={keyboardTypingLayout(config)}
                onChange={setKeyboardTypingLayout}
              />
            }
            showChevron={false}
          />
          <SettingsRow
            iconStyle="line"
            icon="hand.tap"
            mdIcon="Vibrate"
            title="Haptic feedback"
            description="A light tap on every key"
            rightElement={
              <SettingsSwitch
                accessibilityLabel="Haptic feedback"
                value={keyboardHapticsEnabled(config)}
                onValueChange={setKeyboardHapticsEnabled}
              />
            }
            showChevron={false}
          />
          <SettingsRow
            iconStyle="line"
            icon="trash"
            mdIcon="Trash2"
            title="Clear learned words"
            destructive
            showChevron={false}
            onPress={confirmClearLearnedWords}
          />
        </SettingsSection>
      ) : null}
    </SettingsScreen>
  );
}
