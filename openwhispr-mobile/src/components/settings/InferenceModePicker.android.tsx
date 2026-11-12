import React from 'react';
import { useAndroidCopy } from '@/hooks/useAndroidCopy';
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
  // Modes waiting on something outside the app, each with its status shown in place of its
  // description. They stay tappable.
  statuses?: Partial<Record<InferenceMode, string>>;
};

export function InferenceModePicker({
  scope,
  selectedMode,
  onSelect,
  unavailable,
  statuses,
}: Props) {
  const { copy } = useAndroidCopy();
  const modes = getInferenceModes(scope);
  return (
    <SettingsSection title={copy('workflowSettings.mode', 'Mode')}>
      {modes.map((opt) => (
        <SettingsRow
          key={opt.mode}
          iconStyle="line"
          icon={opt.icon}
          mdIcon={opt.mdIcon}
          title={copy(
            `workflowSettings.${opt.mode === 'providers' ? 'byok' : opt.mode === 'openwhispr' ? 'cloud' : 'local'}`,
            opt.title,
          )}
          description={
            unavailable?.[opt.mode] ??
            statuses?.[opt.mode] ??
            copy(
              `workflowSettings.${opt.mode === 'providers' ? 'byokBody' : opt.mode === 'openwhispr' ? 'cloudBody' : scope === 'speech' ? 'localSpeechBody' : 'localTextBody'}`,
              opt.description,
            )
          }
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
