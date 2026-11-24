import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useReduceMotion } from '../settings/kit';
import { GlassButton } from '../processingFable/look';
import { Shimmer } from './noteParts';
import { useNotesLook } from './look';
import { useNotesT } from './strings';
import type { CloudFinishStage } from './cloudFinishStore';

export { useCloudFinishJob } from './cloudFinishStore';

type StepState = 'done' | 'active' | 'waiting';

function Spinner() {
  const n = useNotesLook();
  const reduce = useReduceMotion();
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduce) return;
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 1200,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [reduce, spin]);
  return (
    <Animated.View
      style={{
        width: 20,
        height: 20,
        borderRadius: 10,
        borderWidth: 2,
        borderStyle: 'dashed',
        borderColor: n.accent,
        transform: [
          { rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) },
        ],
      }}
    />
  );
}

function Step({ state, label }: { state: StepState; label: string }) {
  const n = useNotesLook();
  const dark = n.theme.scheme === 'dark';
  return (
    <View
      accessible
      accessibilityLabel={label}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 24 }}
    >
      {state === 'done' ? (
        <View
          style={{
            width: 20,
            height: 20,
            borderRadius: 10,
            backgroundColor: dark ? n.theme.tokens.successFill : 'rgba(52,168,83,0.16)',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <SystemIcon
            name="checkmark"
            mdName="Check"
            size={12}
            color={dark ? n.success : '#2E7D45'}
          />
        </View>
      ) : state === 'active' ? (
        <Spinner />
      ) : (
        <View
          style={{
            width: 20,
            height: 20,
            borderRadius: 10,
            borderWidth: 1.5,
            borderColor: dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.18)',
          }}
        />
      )}
      <Text
        style={{
          fontSize: 15,
          lineHeight: 20,
          color: state === 'active' ? n.text : n.tertiary,
          fontWeight: state === 'active' ? '500' : '400',
        }}
      >
        {label}
      </Text>
    </View>
  );
}

/** The Summary card while a Cloud note finishes: three steps ticking off over a shimmer. */
export function CloudFinishCard({
  stage,
  transcriptDone,
  onRetry,
}: {
  stage: CloudFinishStage;
  /** The transcript is stored and the note is `done`: only the summary is left. */
  transcriptDone: boolean;
  onRetry?: () => void;
}) {
  const t = useNotesT();
  const n = useNotesLook();
  if (stage === 'failed')
    return (
      <View testID="cloud-finish-failed" style={[n.edgeCard, { padding: 16, gap: 12 }]}>
        <View style={{ gap: 6 }}>
          <Text style={n.rowTitle}>{t('lastWordsFailed')}</Text>
          <Text style={{ fontSize: 14, lineHeight: 20, color: n.secondary }}>
            {t('lastWordsFailedBody')}
          </Text>
        </View>
        {onRetry ? <GlassButton label={t('tryAgain')} onPress={onRetry} /> : null}
      </View>
    );
  const saving = stage === 'saving';
  const speakers: StepState = saving ? 'waiting' : transcriptDone ? 'done' : 'active';
  const summary: StepState = saving || !transcriptDone ? 'waiting' : 'active';
  return (
    <View testID="cloud-finish" style={[n.edgeCard, { padding: 16, gap: 12 }]}>
      <Step
        state={saving ? 'active' : 'done'}
        label={saving ? t('savingLastWords') : t('transcriptSaved')}
      />
      <Step
        state={speakers}
        label={speakers === 'done' ? t('speakersSeparated') : t('namingSpeakers')}
      />
      <Step
        state={summary}
        label={summary === 'active' ? t('writingSummaryNow') : t('writingSummary')}
      />
      <Shimmer lines={5} />
    </View>
  );
}
