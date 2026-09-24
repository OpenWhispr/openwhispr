import React, { useCallback, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { SettingsRow, SettingsSection } from '@/components/ui/SettingsSection';
import {
  getLocalModelCatalog,
  LOCAL_MODEL_TITLES,
  type LocalModelKey,
} from '@/lib/localModelCatalog';
import { getPreferredTranscriptionLanguages } from '@/lib/transcriptionLanguage';
import { pickLocalModel } from '@/lib/workflowModeSwitch';
import { LocalTranscriptionService } from '@/services/transcription/LocalTranscriptionService';
import {
  localModelCoversLanguages,
  selectLocalEngine,
  type LocalEngineAvailability,
  type LocalEngineChoice,
} from '@/services/transcription/localEngine';
import { useModelDownloadStore } from '@/store/useModelDownloadStore';

type Props = {
  scope: 'dictation' | 'upload';
  picked: LocalModelKey | undefined;
};

function modelInUse(choice: LocalEngineChoice): string {
  if (choice.engine === 'none') return 'No model is downloaded yet.';
  const key: LocalModelKey =
    choice.engine === 'whisper' ? 'whisper-base' : `parakeet-${choice.version}`;
  return `Using ${LOCAL_MODEL_TITLES[key]}.`;
}

function radio(selected: boolean): { icon: string; mdIcon: 'CircleCheck' | 'Circle' } {
  return selected
    ? { icon: 'checkmark.circle.fill', mdIcon: 'CircleCheck' }
    : { icon: 'circle', mdIcon: 'Circle' };
}

export function OnDeviceModelSection({ scope, picked }: Props): React.JSX.Element | null {
  const [availability, setAvailability] = useState<LocalEngineAvailability | null>(null);
  const completedCount = useModelDownloadStore((state) => state.completedCount);

  // Refresh on return from the download screen, where models are added or deleted.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      LocalTranscriptionService.getAvailability()
        .then((next) => {
          if (!cancelled) setAvailability(next);
        })
        .catch(() => {
          /* The list stays hidden; switching modes already checked the model. */
        });
      return (): void => {
        cancelled = true;
      };
      // completedCount re-runs this when a download finishes while this page is open.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [completedCount]),
  );

  if (!availability) return null;
  const languages = getPreferredTranscriptionLanguages();
  const catalog = getLocalModelCatalog(languages, availability);
  const usable = (key: LocalModelKey): boolean =>
    !!catalog.find((entry) => entry.key === key)?.downloaded &&
    localModelCoversLanguages(key, languages);
  // A pick that is deleted or misses a language runs as Automatic, so show it that way.
  const effectivePick = picked && usable(picked) ? picked : undefined;

  return (
    <SettingsSection title="On-Device Model">
      <SettingsRow
        {...radio(!effectivePick)}
        iconStyle="line"
        title="Automatic"
        description={`Best downloaded model for your languages. ${modelInUse(selectLocalEngine(languages, availability))}`}
        selected={!effectivePick}
        showChevron={false}
        onPress={() => pickLocalModel(scope, undefined)}
      />
      {catalog.map((entry) =>
        entry.downloaded ? (
          <SettingsRow
            key={entry.key}
            {...radio(effectivePick === entry.key)}
            iconStyle="line"
            title={entry.title}
            description={
              usable(entry.key)
                ? entry.languagesNote
                : `${entry.languagesNote} · Doesn't cover your languages`
            }
            selected={effectivePick === entry.key}
            showChevron={false}
            onPress={usable(entry.key) ? () => pickLocalModel(scope, entry.key) : undefined}
          />
        ) : (
          <SettingsRow
            key={entry.key}
            icon="arrow.down.circle"
            mdIcon="Download"
            iconStyle="line"
            title={entry.title}
            description={entry.languagesNote}
            subtitle="Download"
            onPress={() => router.push('/(account)/model-download')}
          />
        ),
      )}
      <SettingsRow
        icon="externaldrive"
        mdIcon="HardDrive"
        iconStyle="line"
        title="Manage downloads"
        onPress={() => router.push('/(account)/model-download')}
      />
    </SettingsSection>
  );
}
