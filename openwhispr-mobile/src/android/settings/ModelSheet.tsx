import { useCallback, useRef } from 'react';
import { View } from 'react-native';
import { useConfigStore } from '@/android/store/useConfigStore';
import { BottomSheet, Group, TextAction, showToast, useReduceMotion } from './kit';
import { ModelRow } from './ModelRow';
import { MODEL_ROWS, modelName, useModelsReady } from './modelCatalog';
import { useSettingsT } from './strings';
import type { AndroidSpeechModelId } from '../speechSelection';

/**
 * "On device needs one speech model": the V1 Ring runs here. When a model is ready the
 * sheet leaves 600 ms later and `onReady` finishes the switch behind it.
 */
export function SpeechModelSheet({
  visible,
  onClose,
  onReady,
}: {
  visible: boolean;
  onClose: () => void;
  onReady: () => void;
}) {
  const t = useSettingsT();
  const reduceMotion = useReduceMotion();
  const { ready, progress } = useModelsReady();
  const leaving = useRef<ReturnType<typeof setTimeout> | null>(null);
  const downloadingId = Object.keys(progress)[0];
  const finished = useCallback(
    (id: AndroidSpeechModelId) => {
      void useConfigStore.getState().updateConfig({ androidSpeechModel: id });
      if (leaving.current) clearTimeout(leaving.current);
      leaving.current = setTimeout(
        () => {
          onClose();
          showToast(t('isReady', { model: modelName(id) }));
          onReady();
        },
        reduceMotion ? 0 : 600,
      );
    },
    [onClose, onReady, reduceMotion, t],
  );
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={t('downloadSpeechTitle')}
      body={t('downloadSpeechBody')}
    >
      <View style={{ gap: 4 }}>
        <Group inset={56}>
          {MODEL_ROWS.filter((row) => row.kind === 'speech').map((row) => (
            <ModelRow
              key={row.id}
              row={row}
              ready={Boolean(ready[row.id])}
              inUse={false}
              progress={progress[row.id]}
              dimmed={downloadingId !== undefined && downloadingId !== row.id}
              reduceMotion={reduceMotion}
              onUse={() => finished(row.id as AndroidSpeechModelId)}
              onSettled={(ok) => ok && finished(row.id as AndroidSpeechModelId)}
            />
          ))}
        </Group>
        <TextAction label={t('notNow')} onPress={onClose} />
      </View>
    </BottomSheet>
  );
}
