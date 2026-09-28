import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';

type ConflictBannerProps = {
  /** False when the parked server copy failed to parse — "Use server copy" has nothing to
   * apply in that case, so only Keep mine is offered (see notesRepository.resolveConflictUseServer). */
  canUseServerCopy: boolean;
  onKeepMine: () => void;
  onUseServer: () => void;
};

/** Shown on the note editor when the note has a server copy parked from a push-time conflict
 * (see notesRepository.listConflictedNotes). Card/CTA layout matches VoiceProfilePromptCard and
 * ParakeetNudgeBanner — the app's existing inline-alert pattern. */
export function ConflictBanner({ canUseServerCopy, onKeepMine, onUseServer }: ConflictBannerProps) {
  return (
    <View
      className="mb-4 gap-3 rounded-xl border border-separator bg-secondarySystemGroupedBackground p-4"
      style={{ borderCurve: 'continuous' }}
      testID="conflict-banner"
    >
      <View className="flex-row items-start gap-3">
        <View className="h-9 w-9 items-center justify-center rounded-lg bg-systemOrange/10">
          <SystemIcon
            name="exclamationmark.triangle.fill"
            mdName="TriangleAlert"
            size={20}
            color="systemOrange"
          />
        </View>
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-[16px] font-semibold text-label">Edited elsewhere</Text>
          <Text className="text-[14px] leading-5 text-secondaryLabel">
            This note was edited on another device.
          </Text>
        </View>
      </View>
      <View className="flex-row gap-3">
        <Pressable
          onPress={onKeepMine}
          accessibilityRole="button"
          accessibilityLabel="Keep mine"
          testID="conflict-banner-keep-mine"
          className="h-9 items-center justify-center rounded-lg bg-brand px-4"
          style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1, borderCurve: 'continuous' })}
        >
          <Text className="text-[14px] font-semibold text-white">Keep mine</Text>
        </Pressable>
        {canUseServerCopy && (
          <Pressable
            onPress={onUseServer}
            accessibilityRole="button"
            accessibilityLabel="Use server copy"
            testID="conflict-banner-use-server"
            className="h-9 items-center justify-center rounded-lg bg-tertiarySystemFill px-4"
            style={({ pressed }) => ({ opacity: pressed ? 0.75 : 1, borderCurve: 'continuous' })}
          >
            <Text className="text-[14px] font-medium text-label">Use server copy</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}
