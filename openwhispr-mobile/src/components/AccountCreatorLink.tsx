import { useCallback, useRef, useState } from 'react';
import { Keyboard, Pressable, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { SettingsRow } from '@/components/ui/SettingsSection';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { Text } from '@/components/ui/Text';
import { CreatorLinkInput } from '../../modules/creator-link-input/src';
import { getAffiliateClientConfig } from '@/lib/affiliateLink';
import { useAffiliateStore } from '@/store/useAffiliateStore';
import { useAuthStore } from '@/store/useAuthStore';

export type CreatorOfferResult = 'shown' | 'unavailable' | 'invalid' | 'cancelled';

export function AccountCreatorLink({
  onCheckOffer,
  onViewPlans,
}: {
  onCheckOffer: () => Promise<CreatorOfferResult>;
  onViewPlans: () => void;
}) {
  const { link, saved, checking, error, edit } = useAffiliateStore();
  const [open, setOpen] = useState(Boolean(link && !saved));
  const [phase, setPhase] = useState<'idle' | 'checking' | 'unavailable'>('idle');
  const [localError, setLocalError] = useState<string | null>(null);
  const [focused, setFocused] = useState(true);
  const { user, sessionCookie } = useAuthStore.getState();
  const context = useRef({ active: true, generation: 0, pending: false });
  const renderGeneration = context.current.generation;
  const isActive = () =>
    context.current.active &&
    context.current.generation === renderGeneration &&
    useAuthStore.getState().user?.id === user?.id &&
    useAuthStore.getState().sessionCookie === sessionCookie;
  useFocusEffect(
    useCallback(() => {
      context.current.active = true;
      setFocused(true);
      setPhase('idle');
      return () => {
        context.current.active = false;
        setFocused(false);
        setOpen(false);
        context.current.generation += 1;
      };
    }, []),
  );

  const checkOffer = async (pastedText?: string) => {
    if (!isActive() || context.current.pending || checking) return;
    const generation = context.current.generation;
    const isCurrent = () => isActive() && context.current.generation === generation;
    context.current.pending = true;
    setPhase('checking');
    setLocalError(null);
    try {
      if (pastedText !== undefined) await edit(pastedText);
      if (!isCurrent()) return;
      if (!useAffiliateStore.getState().link.trim()) {
        setPhase('idle');
        return;
      }
      Keyboard.dismiss();
      const result = await onCheckOffer();
      if (isCurrent()) setPhase(result === 'unavailable' ? 'unavailable' : 'idle');
    } catch {
      if (isCurrent()) {
        setPhase('idle');
        setLocalError('We couldn’t check your offer. Try again.');
      }
    } finally {
      context.current.pending = false;
    }
  };

  if (!getAffiliateClientConfig()) return null;
  const busy = phase === 'checking' || checking;
  const feedback = localError ?? error;

  return (
    <View>
      <SettingsRow
        iconStyle="line"
        icon="link"
        mdIcon="Link"
        title={saved ? 'Creator link saved' : 'Have a creator link?'}
        onPress={() => {
          if (!busy) setOpen(!open);
        }}
        accessibilityState={{ expanded: open, busy }}
        rightElement={
          <SystemIcon
            name={open ? 'chevron.down' : 'chevron.right'}
            mdName={open ? 'ChevronDown' : 'ChevronRight'}
            size={13}
            color="tertiaryLabel"
          />
        }
      />
      {open && (
        <View className="ml-14 mr-4 pb-4">
          {!saved && (
            <>
              <Text className="mb-2 text-[13px] text-secondaryLabel">Creator link</Text>
              <View className="rounded-xl border border-separator bg-secondarySystemGroupedBackground">
                <CreatorLinkInput
                  value={link}
                  editable={!busy && focused}
                  onChangeText={(value) => {
                    if (!isActive()) return;
                    setLocalError(null);
                    edit(value);
                  }}
                  onPaste={(value) => {
                    checkOffer(value);
                  }}
                  onSubmit={(value) => {
                    checkOffer(value);
                  }}
                  onInvalidPaste={() =>
                    setLocalError('This link is too long. Paste the original creator link.')
                  }
                />
              </View>
            </>
          )}
          <Text accessibilityLiveRegion="polite" className="mt-2 text-[13px] text-secondaryLabel">
            {busy
              ? 'Checking your offer…'
              : phase === 'unavailable'
                ? 'Your creator is saved, but we couldn’t verify an available offer right now.'
                : saved
                  ? 'Your creator link is saved. You can check your offer whenever you’re ready.'
                  : 'Paste your link. We’ll check it and open your offer. Typing instead? Tap Go.'}
          </Text>
          {feedback && (
            <Text accessibilityLiveRegion="polite" className="mt-2 text-[13px] text-systemRed">
              {feedback}
            </Text>
          )}
          {!busy && (saved || feedback) && (
            <View className="mt-1">
              <Pressable
                accessibilityRole="button"
                className="min-h-11 justify-center"
                onPress={() => {
                  checkOffer();
                }}
              >
                <Text className="text-[15px] text-brand">
                  {feedback || phase === 'unavailable' ? 'Try again' : 'Check offer'}
                </Text>
              </Pressable>
              {!saved && (
                <Pressable
                  accessibilityRole="button"
                  className="min-h-11 justify-center"
                  onPress={() => {
                    setLocalError(null);
                    edit('');
                  }}
                >
                  <Text className="text-[15px] text-brand">Clear link</Text>
                </Pressable>
              )}
              {phase === 'unavailable' && (
                <>
                  <Pressable
                    accessibilityRole="button"
                    className="min-h-11 justify-center"
                    onPress={onViewPlans}
                  >
                    <Text className="text-[15px] text-brand">View plans</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    className="min-h-11 justify-center"
                    onPress={() => {
                      setOpen(false);
                      setPhase('idle');
                    }}
                  >
                    <Text className="text-[15px] text-secondaryLabel">Not now</Text>
                  </Pressable>
                </>
              )}
            </View>
          )}
        </View>
      )}
    </View>
  );
}
