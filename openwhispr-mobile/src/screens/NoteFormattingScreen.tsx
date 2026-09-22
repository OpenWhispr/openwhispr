import React from 'react';
import { SettingsRow, SettingsSection } from '@/components/ui/SettingsSection';
import { SettingsScreen } from '@/components/ui/SettingsScreen';
import { SettingsSwitch } from '@/components/ui/SettingsSwitch';
import { useConfigStore } from '@/store/useConfigStore';
import { useConfigToggle } from '@/hooks/useConfigToggle';

export default function NoteFormattingScreen() {
  const config = useConfigStore((state) => state.config);
  const autoGenerateTitle = config?.autoGenerateNoteTitle ?? true;
  const handleToggleAutoTitle = useConfigToggle('autoGenerateNoteTitle');

  return (
    <SettingsScreen>
      <SettingsSection>
        <SettingsRow
          iconStyle="line"
          icon="textformat"
          mdIcon="Type"
          title="Auto-generate Note Titles"
          description="Use AI to generate a short title for notes after enhancement. Runs in the cloud."
          rightElement={
            <SettingsSwitch value={autoGenerateTitle} onValueChange={handleToggleAutoTitle} />
          }
          showChevron={false}
        />
      </SettingsSection>
    </SettingsScreen>
  );
}
