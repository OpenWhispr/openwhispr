import { useEffect, useRef, useState } from 'react';
import { Alert, View } from 'react-native';
import { useNavigation, usePreventRemove, type NavigationAction } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Button, palette } from './ui';

interface Props {
  isStarting: boolean;
  isRecording: boolean;
  isProcessing: boolean;
  disabled: boolean;
  keyboardVisible: boolean;
  onStart: () => Promise<void>;
  onStop: () => Promise<boolean | undefined>;
  onDiscard: () => Promise<void>;
  onFlush: () => void;
}

export function NoteRecordingControls(props: Props) {
  const { t } = useTranslation('android');
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [working, setWorking] = useState(false);
  const [leave, setLeave] = useState<NavigationAction | null>(null);
  const running = useRef(false);
  const active = working || props.isStarting || props.isRecording || props.isProcessing;
  const run = async (work: () => Promise<unknown>) => {
    if (running.current) return;
    running.current = true;
    setWorking(true);
    try {
      await work();
    } catch (error) {
      Alert.alert(t('errorTitle'), (error as Error).message);
    } finally {
      running.current = false;
      setWorking(false);
    }
  };
  useEffect(() => {
    if (leave && !active) {
      props.onFlush();
      setLeave(null);
      navigation.dispatch(leave);
    }
  }, [leave, active, navigation, props.onFlush]);
  usePreventRemove(active, ({ data }) => {
    if (working || props.isStarting || props.isProcessing) {
      Alert.alert(t('noteFinishingTitle'), t('noteFinishingBody'));
      return;
    }
    Alert.alert(t('noteLeaveTitle'), t('noteLeaveBody'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('noteDiscard'),
        style: 'destructive',
        onPress: () => {
          void run(async () => {
            await props.onDiscard();
            setLeave(data.action);
          });
        },
      },
      {
        text: t('noteFinish'),
        onPress: () => {
          void run(async () => {
            if (await props.onStop()) setLeave(data.action);
          });
        },
      },
    ]);
  });
  return (
    <View
      style={{
        padding: 16,
        paddingBottom: props.keyboardVisible ? 12 : Math.max(insets.bottom, 12),
        borderTopWidth: 1,
        borderTopColor: palette.line,
        backgroundColor: palette.background,
      }}
    >
      <Button
        label={props.isRecording ? t('noteStop') : active ? t('processing') : t('noteStart')}
        busy={working || props.isStarting || props.isProcessing}
        disabled={
          working ||
          props.isStarting ||
          props.isProcessing ||
          (!props.isRecording && props.disabled)
        }
        onPress={() => {
          void run(props.isRecording ? props.onStop : props.onStart);
        }}
      />
    </View>
  );
}
