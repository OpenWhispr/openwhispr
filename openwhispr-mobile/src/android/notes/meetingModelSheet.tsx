import React, { useEffect, useRef, useState } from 'react';
import type { AndroidModelId } from '../models';
import { MODEL_ROWS, meetingModelRows, useModelsReady } from '../settings/modelCatalog';
import { ModelRow } from '../settings/ModelRow';
import { Group, useReduceMotion } from '../settings/kit';
import { ListRow } from './look';
import { useNotesT } from './strings';

/** How long a finished download shows its tick on the sheet before the row folds away (S6). */
export const FOLD_AFTER_MS = 1000;

const SPEAKERS = MODEL_ROWS.find((row) => row.id === 'meeting-speakers')!;

/** Whether the optional Meeting speakers model is missing, read again as downloads end. */
export function useNeedsSpeakers(onDevice: boolean): boolean {
  const { ready, checked } = useModelsReady();
  return onDevice && checked && !ready['meeting-speakers'];
}

/**
 * The sheet's third row for an On device meeting. With no meeting model: "Choose a speech
 * model", which opens the list (S1), or the model downloading in place (S5). With one but no
 * Meeting speakers: that model with Download (S9, S10). Each folds away a beat after it lands.
 */
export function MeetingModelRow({
  needsSpeech,
  needsSpeakers,
  onChoose,
  onLanded,
}: {
  needsSpeech: boolean;
  needsSpeakers: boolean;
  onChoose: () => void;
  /** A model finished downloading on the sheet; the parent reads readiness again. */
  onLanded: () => void;
}) {
  const t = useNotesT();
  const reduceMotion = useReduceMotion();
  const { ready, progress } = useModelsReady();
  const [landed, setLanded] = useState<AndroidModelId | null>(null);
  // A row whose download was seen stays put after the last byte, while its files are checked,
  // or it would unmount before it can say the model landed.
  const [watching, setWatching] = useState<AndroidModelId[]>([]);
  const downloading = Object.keys(progress) as AndroidModelId[];
  useEffect(() => {
    const fresh = downloading.filter((id) => !watching.includes(id));
    if (fresh.length) setWatching((current) => [...current, ...fresh]);
  }, [downloading, watching]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const land = (id: AndroidModelId) => (ok: boolean) => {
    setWatching((current) => current.filter((item) => item !== id));
    if (!ok) return;
    setLanded(id);
    timer.current = setTimeout(() => {
      setLanded(null);
      onLanded();
    }, FOLD_AFTER_MS);
  };

  const shown = (id: AndroidModelId) =>
    progress[id] !== undefined || landed === id || watching.includes(id);
  const speech = meetingModelRows().find((row) => shown(row.id));
  if (speech)
    return (
      <ModelRow
        row={speech}
        ready={!!ready[speech.id]}
        inUse={landed === speech.id}
        progress={progress[speech.id]}
        dimmed={false}
        reduceMotion={reduceMotion}
        inlineErrors
        onSettled={land(speech.id)}
      />
    );
  if (needsSpeech)
    return (
      <ListRow
        icon="AudioLines"
        title={t('chooseSpeechModel')}
        subtitle={t('chooseSpeechModelBody')}
        subtitleLines={2}
        onPress={onChoose}
      />
    );
  if (needsSpeakers || shown(SPEAKERS.id))
    return (
      <ModelRow
        row={SPEAKERS}
        ready={!!ready[SPEAKERS.id]}
        inUse={landed === SPEAKERS.id}
        progress={progress[SPEAKERS.id]}
        dimmed={false}
        reduceMotion={reduceMotion}
        line={t('meetingSpeakersOptional')}
        inlineErrors
        onSettled={land(SPEAKERS.id)}
      />
    );
  return null;
}

/**
 * S2–S4 and S11: the meeting speech models, each with Download in place (the others dim while
 * one downloads), then Meeting speakers as an optional group while it isn't on the phone.
 * Downloading here never changes the dictation model.
 */
export function MeetingModelList({ onSpeechReady }: { onSpeechReady: () => void }) {
  const t = useNotesT();
  const reduceMotion = useReduceMotion();
  const { ready, checked, progress } = useModelsReady();
  const rows = meetingModelRows();
  // Only another speech model dims a row; Meeting speakers can download at the same time.
  const downloading = rows.find((row) => progress[row.id] !== undefined)?.id;
  // Meeting speakers shows once it is known to be missing, and stays while it downloads or lands.
  const [showSpeakers, setShowSpeakers] = useState(false);
  useEffect(() => {
    if (checked && !ready[SPEAKERS.id]) setShowSpeakers(true);
  }, [checked, ready]);
  return (
    <>
      <Group footer={t('speechModelListFooter')}>
        {rows.map((row) => (
          <ModelRow
            key={row.id}
            row={row}
            ready={!!ready[row.id]}
            inUse={false}
            progress={progress[row.id]}
            dimmed={downloading !== undefined && downloading !== row.id}
            reduceMotion={reduceMotion}
            inlineErrors
            onSettled={(ok) => ok && onSpeechReady()}
          />
        ))}
      </Group>
      {showSpeakers ? (
        <Group title={t('speakerNamesOptional').toUpperCase()} footer={t('speakersListFooter')}>
          <ModelRow
            row={SPEAKERS}
            ready={!!ready[SPEAKERS.id]}
            inUse={false}
            progress={progress[SPEAKERS.id]}
            dimmed={false}
            reduceMotion={reduceMotion}
            line={t('namesWhoSpoke')}
            inlineErrors
          />
        </Group>
      ) : null}
    </>
  );
}
