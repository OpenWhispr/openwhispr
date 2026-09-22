import React from 'react';
import { SettingsRow, SettingsSection } from '@/components/ui/SettingsSection';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { getInferenceModes, type InferenceScope } from '@/lib/inferenceModes';
import type { InferenceMode } from '@/types';

type Props = {
  scope: InferenceScope;
  selectedMode: InferenceMode;
  onSelect: (mode: InferenceMode) => void;
  title?: string;
};

export function InferenceModePicker({
  scope,
  selectedMode,
  onSelect,
  title = 'Inference Mode',
}: Props) {
  const modes = getInferenceModes(scope);
  return (
    <SettingsSection title={title}>
      {modes.map((opt) => (
        <SettingsRow
          key={opt.mode}
          iconStyle="line"
          icon={opt.icon}
          mdIcon={opt.mdIcon}
          title={opt.title}
          description={opt.description}
          onPress={() => onSelect(opt.mode)}
          selected={selectedMode === opt.mode}
          rightElement={
            selectedMode === opt.mode ? (
              <SystemIcon name="checkmark" mdName="Check" size={18} color="systemBlue" />
            ) : undefined
          }
          showChevron={false}
        />
      ))}
    </SettingsSection>
  );
}
