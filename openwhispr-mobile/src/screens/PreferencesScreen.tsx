import React, { useState } from 'react';
import { router } from 'expo-router';
import { SettingsRow, SettingsSection } from '@/components/ui/SettingsSection';
import { SettingsScreen } from '@/components/ui/SettingsScreen';
import { SettingsSwitch } from '@/components/ui/SettingsSwitch';
import { SoonBadge } from '@/components/ui/SoonBadge';
import { useConfigStore } from '@/store/useConfigStore';
import { useConfigToggle } from '@/hooks/useConfigToggle';
import { DEFAULT_LANGUAGE, getLanguage } from '@/lib/languages';
import { toneLabel, DEFAULT_KEYBOARD_TONE } from '@/lib/keyboardTone';
import { getDictationAgentName } from '@/lib/dictationAgent';
import { LiveActivity } from '../../modules/live-activity/src';

export default function PreferencesScreen() {
  const config = useConfigStore((state) => state.config);
  const autoLearn = config?.autoLearnCorrections ?? true;
  const language = getLanguage(config?.preferredLanguage ?? DEFAULT_LANGUAGE);
  const keyboardTone = config?.keyboardTone ?? DEFAULT_KEYBOARD_TONE;
  const agentName = config ? getDictationAgentName(config) : 'OpenWhispr';
  const handleToggleAutoLearn = useConfigToggle('autoLearnCorrections');
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
          title="Dictation Agent"
          description="Trigger AI actions by saying your agent name"
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
      </SettingsSection>
    </SettingsScreen>
  );
}
