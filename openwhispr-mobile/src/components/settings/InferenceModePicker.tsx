import React from 'react';
import { SettingsRow, SettingsSection } from '@/components/ui/SettingsSection';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { getInferenceModes, type InferenceScope } from '@/lib/inferenceModes';
import type { InferenceMode } from '@/types';

type Props = {
  scope: InferenceScope;
  // null when no mode is saved and none applies, so nothing is shown as picked.
  selectedMode: InferenceMode | null;
  onSelect: (mode: InferenceMode) => void;
  // Modes this phone can never run, each with the reason shown in place of its description.
  unavailable?: Partial<Record<InferenceMode, string>>;
};

export function InferenceModePicker({ scope, selectedMode, onSelect, unavailable }: Props) {
  const modes = getInferenceModes(scope);
  return (
    <SettingsSection title="Mode">
      {modes.map((opt) => (
        <SettingsRow
          key={opt.mode}
          iconStyle="line"
          icon={opt.icon}
          mdIcon={opt.mdIcon}
          title={opt.title}
          description={unavailable?.[opt.mode] ?? opt.description}
          disabled={!!unavailable?.[opt.mode]}
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
