import React, { useEffect, useRef, useState } from 'react';
import type { AndroidModelId } from '../models';
import { meetingModelRows, useModelsReady } from '../settings/modelCatalog';
import { ModelRow } from '../settings/ModelRow';
import { Group, useReduceMotion } from '../settings/kit';
import { ListRow } from './look';
import { useNotesT } from './strings';

/** How long a finished download shows its tick on the sheet before the row folds away (S6). */
export const FOLD_AFTER_MS = 1000;

/**
 * The sheet's third row for an On device meeting with no meeting model: "Choose a meeting
 * model", which opens the list (S1), or the model downloading in place (S5), which shows its
 * tick a beat after it lands, then folds away. Meeting speakers downloads by itself at launch
 * (liveSpeakers/speakerModel.ts), so it never shows here.
 */
export function MeetingModelRow({
  needsModel,
  onChoose,
  onLanded,
}: {
  needsModel: boolean;
  onChoose: () => void;
  /** A model finished downloading on the sheet; the parent reads readiness again. */
  onLanded: () => void;
}) {
  const t = useNotesT();
  const reduceMotion = useReduceMotion();
  const { ready, progress } = useModelsReady();
  const rows = meetingModelRows();
  const [landed, setLanded] = useState<AndroidModelId | null>(null);
  // A row whose download was seen stays put after the last byte, while its files are checked,
  // or it would unmount before it can say the model landed.
  const [watching, setWatching] = useState<AndroidModelId[]>([]);
  const downloading = rows.filter((row) => progress[row.id] !== undefined).map((row) => row.id);
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

  const model = rows.find(
    (row) => progress[row.id] !== undefined || landed === row.id || watching.includes(row.id),
  );
  if (model)
    return (
      <ModelRow
        row={model}
        ready={!!ready[model.id]}
        inUse={landed === model.id}
        progress={progress[model.id]}
        dimmed={false}
        reduceMotion={reduceMotion}
        inlineErrors
        onSettled={land(model.id)}
      />
    );
  if (needsModel)
    return (
      <ListRow
        icon="AudioLines"
        title={t('chooseMeetingModel')}
        subtitle={t('chooseMeetingModelBody')}
        subtitleLines={2}
        onPress={onChoose}
      />
    );
  return null;
}

/**
 * S2–S4: the models that can transcribe meetings, each with Download in place (the others dim
 * while one downloads). Downloading here never changes the dictation model.
 */
export function MeetingModelList({ onModelReady }: { onModelReady: () => void }) {
  const t = useNotesT();
  const reduceMotion = useReduceMotion();
  const { ready, progress } = useModelsReady();
  const rows = meetingModelRows();
  const downloading = rows.find((row) => progress[row.id] !== undefined)?.id;
  return (
    <Group footer={t('meetingModelListFooter')}>
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
          onSettled={(ok) => ok && onModelReady()}
        />
      ))}
    </Group>
  );
}
