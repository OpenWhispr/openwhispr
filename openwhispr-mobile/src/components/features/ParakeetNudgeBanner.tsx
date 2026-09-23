import { useEffect, useState, useCallback } from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { useModelDownloadStore } from '@/store/useModelDownloadStore';
import { LocalTranscriptionService } from '@/services/transcription/LocalTranscriptionService';
import { getPreferredTranscriptionLanguages } from '@/lib/transcriptionLanguage';
import { detectPreferredLanguages } from '@/lib/deviceLanguages';
import { getParakeetNudge, type ParakeetNudge } from '@/lib/parakeetNudges';
import { LANGUAGES } from '@/lib/languages';
import { safeHaptics } from '@/lib/utils';

/** "en" → "English" (the app list only has regional entries like en-US; drop the region). */
function labelForBaseCode(code: string | undefined): string | null {
  if (!code) return null;
  const match = LANGUAGES.find(
    (language) => language.code === code || language.code.startsWith(`${code}-`),
  );
  return match ? match.label.replace(/\s*\(.*\)$/, '') : null;
}

/**
 * One-time Home banner steering private-mode users toward Parakeet: either "pick a language"
 * (selection routes to Whisper) or "download the faster model" (qualifying language, model not
 * installed). Decision logic lives in lib/parakeetNudges; this component owns dismissal writes
 * and navigation.
 */
export function ParakeetNudgeBanner() {
  const config = useConfigStore((s) => s.config);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const activeMode = useProcessingModeStore((s) => s.activeMode);
  const downloadCompletedCount = useModelDownloadStore((s) => s.completedCount);
  const [nudge, setNudge] = useState<ParakeetNudge | null>(null);

  useEffect(() => {
    if (!config) {
      setNudge(null);
      return;
    }
    let cancelled = false;
    LocalTranscriptionService.getAvailability()
      .then((availability) => {
        if (cancelled) return;
        setNudge(
          getParakeetNudge({
            activeMode,
            languages: getPreferredTranscriptionLanguages(),
            deviceLanguages: detectPreferredLanguages(),
            availability,
            config,
          }),
        );
      })
      .catch(() => {
        if (!cancelled) setNudge(null);
      });
    return () => {
      cancelled = true;
    };
  }, [config, activeMode, downloadCompletedCount]);

  const dismiss = useCallback(() => {
    if (!nudge) return;
    safeHaptics('light');
    setNudge(null);
    updateConfig(
      nudge.kind === 'pick-language'
        ? { parakeetAutoLanguageNudgeDismissedAt: new Date().toISOString() }
        : { parakeetUpgradeNudgeDismissedAt: new Date().toISOString() },
    );
  }, [nudge, updateConfig]);

  const openCta = useCallback(() => {
    if (!nudge) return;
    safeHaptics('selection');
    router.push(
      nudge.kind === 'pick-language'
        ? '/(account)/transcription-language'
        : '/(account)/model-download',
    );
  }, [nudge]);

  if (!nudge) return null;

  const suggestedLabel = labelForBaseCode(nudge.suggestedLanguageCode);
  const message =
    nudge.kind === 'pick-language'
      ? suggestedLabel
        ? `Dictating in ${suggestedLabel}? Set your language to unlock a faster on-device model.`
        : 'Pick your language to unlock the faster on-device model.'
      : `A faster on-device model is available${suggestedLabel ? ` for ${suggestedLabel}` : ''}.`;
  const ctaLabel = nudge.kind === 'pick-language' ? 'Choose Language' : 'Get Model';

  return (
    <View
      className="mb-4 gap-3 rounded-xl border border-separator bg-secondarySystemGroupedBackground p-4"
      style={{ borderCurve: 'continuous' }}
      testID="parakeet-nudge-banner"
    >
      <View className="flex-row items-start gap-3">
        <View className="h-9 w-9 items-center justify-center rounded-lg bg-tertiarySystemFill">
          <SystemIcon name="bolt.fill" mdName="Zap" size={20} color="brand" />
        </View>
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-[16px] font-semibold text-label">Faster private dictation</Text>
          <Text className="text-[14px] leading-5 text-secondaryLabel">{message}</Text>
        </View>
      </View>
      <View className="flex-row gap-3">
        <Pressable
          onPress={openCta}
          accessibilityRole="button"
          accessibilityLabel={ctaLabel}
          testID="parakeet-nudge-cta"
          className="h-9 items-center justify-center rounded-lg bg-brand px-4"
          style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1, borderCurve: 'continuous' })}
        >
          <Text className="text-[14px] font-semibold text-white">{ctaLabel}</Text>
        </Pressable>
        <Pressable
          onPress={dismiss}
          accessibilityRole="button"
          accessibilityLabel="Dismiss faster model suggestion"
          testID="parakeet-nudge-dismiss"
          className="h-9 items-center justify-center rounded-lg bg-tertiarySystemFill px-4"
          style={({ pressed }) => ({ opacity: pressed ? 0.75 : 1, borderCurve: 'continuous' })}
        >
          <Text className="text-[14px] font-medium text-label">Dismiss</Text>
        </Pressable>
      </View>
    </View>
  );
}
