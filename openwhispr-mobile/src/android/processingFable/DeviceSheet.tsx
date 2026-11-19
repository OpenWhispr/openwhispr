import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { ANDROID_MODELS, type AndroidModelId } from '../models';
import { BottomSheet, TextAction, settings } from '../settings/kit';
import { MODEL_ROWS, formatSize, modelName } from '../settings/modelCatalog';
import { useFableT } from './strings';
import { GlassButton, Tile } from './look';
import { SheetCard } from './ui';

const ICON = { speech: 'AudioLines', text: 'CaseSensitive', diarization: 'Users' } as const;

/**
 * D1: "Use for everything" on device with models still to download. Not a picker: the model
 * each job needs, with its size and the total. Tasks move over as each model lands (D2).
 */
export function DeviceSheet({
  needs: requested,
  onClose,
  onDownload,
  onCheckFirst,
}: {
  needs: AndroidModelId[] | null;
  onClose: () => void;
  onDownload: () => void;
  onCheckFirst: () => void;
}) {
  const t = useFableT();
  // The sheet keeps its list while it slides away.
  const [needs, setNeeds] = useState<AndroidModelId[]>(requested ?? []);
  useEffect(() => {
    if (requested) setNeeds(requested);
  }, [requested]);
  const total = needs.reduce((sum, id) => sum + ANDROID_MODELS[id].bytes, 0);
  const size = formatSize(total);

  return (
    <BottomSheet
      visible={!!requested}
      onClose={onClose}
      title={t('runEverythingTitle')}
      body={t('runEverythingBody', { size })}
    >
      <SheetCard>
        {needs.map((id) => {
          const row = MODEL_ROWS.find((item) => item.id === id)!;
          const bytes = formatSize(ANDROID_MODELS[id].bytes);
          const line =
            row.kind === 'speech'
              ? row.line
                ? t('speechLineLanguages', { languages: t(row.line), size: bytes })
                : t('speechLine', { size: bytes })
              : row.kind === 'text'
                ? t('textLine', { size: bytes })
                : t('speakersLine', { size: bytes });
          return (
            <View
              key={id}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                paddingHorizontal: 16,
                paddingVertical: 12,
                minHeight: 60,
              }}
            >
              <Tile kind="idle" icon={ICON[row.kind]} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={settings.title}>{modelName(id)}</Text>
                <Text style={settings.subtitle}>{line}</Text>
              </View>
            </View>
          );
        })}
      </SheetCard>
      <View style={{ paddingTop: 4, gap: 4 }}>
        <GlassButton label={t('downloadSize', { size })} onPress={onDownload} />
        <TextAction label={t('checkPhoneFirst')} onPress={onCheckFirst} />
      </View>
    </BottomSheet>
  );
}
