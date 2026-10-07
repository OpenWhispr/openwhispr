import { useEffect, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useAffiliateStore } from '@/store/useAffiliateStore';
import { getAffiliateClientConfig } from '@/lib/affiliateLink';

export function CreatorLinkField({ onSubmit }: { onSubmit: () => void }) {
  const { link, saved, checking, error, edit } = useAffiliateStore();
  const [open, setOpen] = useState(Boolean(link && !saved));
  useEffect(() => {
    if (error) setOpen(true);
  }, [error]);
  if (!getAffiliateClientConfig()) return null;
  if (saved)
    return (
      <View
        className="mb-3 rounded-xl bg-secondarySystemGroupedBackground p-3"
        accessibilityLiveRegion="polite"
      >
        <Text className="text-[14px] font-medium text-label">Creator link saved.</Text>
        <Text className="mt-1 text-[13px] text-secondaryLabel">
          We’ll check your offer before payment.
        </Text>
      </View>
    );
  return (
    <View className="mb-3">
      <Pressable
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        className="min-h-11 flex-row items-center justify-between py-3 active:opacity-80"
      >
        <Text className="flex-1 pr-3 text-[15px] font-medium text-secondaryLabel">
          Have a creator link?
        </Text>
        <SystemIcon
          name={open ? 'chevron.up' : 'chevron.down'}
          mdName={open ? 'ChevronUp' : 'ChevronDown'}
          size={15}
          color="secondaryLabel"
        />
      </Pressable>
      {open && (
        <View>
          <Text className="mb-2 text-[13px] text-secondaryLabel">Creator link (optional)</Text>
          <TextInput
            value={link}
            onChangeText={(value) => {
              edit(value);
            }}
            editable={!checking}
            onSubmitEditing={onSubmit}
            accessibilityLabel="Creator link (optional)"
            placeholder="Paste your creator’s link"
            placeholderTextColor="#77747a"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            maxLength={2048}
            className="rounded-xl border border-separator bg-secondarySystemGroupedBackground px-3 py-3 text-[16px] text-label"
          />
          {error && (
            <Text accessibilityLiveRegion="polite" className="mt-2 text-[13px] text-systemRed">
              {error}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}
