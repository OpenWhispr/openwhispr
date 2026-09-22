import { useCallback, useEffect, useState } from 'react';
import { Image, Linking, Platform, Pressable, View, type ImageSourcePropType } from 'react-native';
import { Text } from '@/components/ui/Text';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { SystemIcon, type LucideIconName } from '@/components/ui/SystemIcon';
import { useOnboardingStore } from '@/store/useOnboardingStore';

interface AppTarget {
  key: string;
  title: string;
  icon: string;
  mdIcon: LucideIconName;
  iconBg: string;
  /**
   * Optional real app icon (PNG dropped into assets/onboarding/app-icons/).
   * When set, renders in place of the SF Symbol + colored background.
   * See assets/onboarding/app-icons/README.md.
   */
  iconAsset?: ImageSourcePropType;
  url: string;
  /** Skip canOpenURL check; always show this target. */
  alwaysAvailable?: boolean;
  /** Fallback URLs to probe in order if `url` isn't installed. */
  fallbackUrls?: string[];
}

const isIOS = Platform.OS === 'ios';

// To swap in additional real app icons, drop the PNG into
// assets/onboarding/app-icons/ then uncomment the matching iconAsset line.
const TARGETS: AppTarget[] = [
  {
    key: 'messages',
    title: 'Messages',
    icon: 'message.fill',
    mdIcon: 'MessageCircle',
    iconBg: '#34C759',
    // iconAsset: require('../../../../assets/onboarding/app-icons/messages.png'),
    url: 'sms:',
    alwaysAvailable: true,
  },
  {
    key: 'mail',
    title: isIOS ? 'Mail' : 'Gmail',
    icon: 'envelope.fill',
    mdIcon: 'Mail',
    iconBg: '#007AFF',
    iconAsset: isIOS
      ? require('../../../../assets/onboarding/app-icons/mail.png')
      : require('../../../../assets/onboarding/app-icons/gmail.png'),
    url: 'mailto:',
    alwaysAvailable: true,
  },
  ...(isIOS
    ? [
        {
          key: 'apple-notes',
          title: 'Apple Notes',
          icon: 'note.text',
          mdIcon: 'StickyNote' as LucideIconName,
          iconBg: '#FFCC00',
          iconAsset: require('../../../../assets/onboarding/app-icons/apple-notes.png'),
          url: 'mobilenotes://',
          alwaysAvailable: true,
        },
      ]
    : []),
  {
    key: 'safari',
    title: isIOS ? 'Safari' : 'Chrome',
    icon: 'safari.fill',
    mdIcon: 'Compass',
    iconBg: '#0A84FF',
    iconAsset: isIOS
      ? require('../../../../assets/onboarding/app-icons/safari.png')
      : require('../../../../assets/onboarding/app-icons/chrome.png'),
    url: 'https://www.google.com',
    alwaysAvailable: true,
  },
  {
    key: 'chatgpt',
    title: 'ChatGPT',
    icon: 'bubble.left.and.bubble.right.fill',
    mdIcon: 'MessageCircle',
    iconBg: '#000000',
    iconAsset: require('../../../../assets/onboarding/app-icons/chatgpt.png'),
    // Universal link: opens the ChatGPT app if installed, otherwise the website.
    url: 'https://chatgpt.com',
    alwaysAvailable: true,
  },
  {
    key: 'claude',
    title: 'Claude',
    icon: 'sparkles',
    mdIcon: 'Sparkles',
    iconBg: '#D97757',
    iconAsset: require('../../../../assets/onboarding/app-icons/claude.png'),
    // Universal link: opens the Claude app if installed, otherwise the website.
    // (Custom scheme claude:// caused a deep-link bounce loop on return, so we
    // use the universal link like ChatGPT.)
    url: 'https://claude.ai',
    alwaysAvailable: true,
  },
  {
    key: 'whatsapp',
    title: 'WhatsApp',
    icon: 'message.fill',
    mdIcon: 'MessageSquare',
    iconBg: '#25D366',
    iconAsset: require('../../../../assets/onboarding/app-icons/whatsapp.png'),
    url: 'whatsapp://send',
  },
  {
    key: 'slack',
    title: 'Slack',
    icon: 'number',
    mdIcon: 'Hash',
    iconBg: '#4A154B',
    iconAsset: require('../../../../assets/onboarding/app-icons/slack.png'),
    url: 'slack://open',
  },
  {
    key: 'twitter',
    title: 'X',
    icon: 'xmark',
    mdIcon: 'X',
    iconBg: '#000000',
    iconAsset: require('../../../../assets/onboarding/app-icons/x.png'),
    url: 'twitter://',
    fallbackUrls: ['x://'],
  },
];

export function GraduationStep() {
  const goNext = useOnboardingStore((s) => s.goNext);
  const [installedKeys, setInstalledKeys] = useState<Set<string>>(() => {
    return new Set(TARGETS.filter((t) => t.alwaysAvailable).map((t) => t.key));
  });

  useEffect(() => {
    let cancelled = false;
    const probeTargets = TARGETS.filter((t) => !t.alwaysAvailable);

    Promise.all(
      probeTargets.map(async (target) => {
        const urls = [target.url, ...(target.fallbackUrls ?? [])].filter(
          (u): u is string => typeof u === 'string',
        );
        for (const candidate of urls) {
          try {
            if (await Linking.canOpenURL(candidate)) return { target, url: candidate };
          } catch {
            // fall through to next candidate
          }
        }
        return null;
      }),
    ).then((results) => {
      if (cancelled) return;
      setInstalledKeys((prev) => {
        const next = new Set(prev);
        for (const result of results) {
          if (result) {
            next.add(result.target.key);
            result.target.url = result.url;
          }
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const visibleTargets = TARGETS.filter((t) => installedKeys.has(t.key));

  // Launching an external app deliberately does NOT advance. The next step
  // presents a paywall from an effect, and iOS cannot present from a
  // backgrounded app — it would fail open and skip the paywall entirely. The
  // user comes back to this screen and continues from the CTA.
  const handleTarget = useCallback((target: AppTarget) => {
    Linking.openURL(target.url).catch(() => {});
  }, []);

  return (
    <OnboardingShell
      title="Start speaking instead of typing."
      titleAccent="speaking"
      subtitle="Try OpenWhispr anywhere — tap and hold the globe key in any app to switch keyboards."
      ctaLabel="Start using OpenWhispr"
      onCta={goNext}
    >
      <View className="flex-1 flex-row flex-wrap gap-3 pt-2">
        {visibleTargets.map((target) => (
          <TargetCard key={target.key} target={target} onPress={() => handleTarget(target)} />
        ))}
      </View>
    </OnboardingShell>
  );
}

function TargetCard({ target, onPress }: { target: AppTarget; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={target.title}
      className="w-[48%] items-center rounded-xl border border-separator bg-secondarySystemGroupedBackground py-4 active:opacity-90"
    >
      {target.iconAsset ? (
        <Image source={target.iconAsset} className="h-12 w-12 rounded-lg" />
      ) : (
        <View
          className="h-12 w-12 items-center justify-center rounded-lg"
          style={{ backgroundColor: target.iconBg }}
        >
          <SystemIcon name={target.icon} mdName={target.mdIcon} size={22} color="#FFFFFF" />
        </View>
      )}
      <Text numberOfLines={1} className="mt-2 px-2 text-[14px] font-semibold text-label">
        {target.title}
      </Text>
    </Pressable>
  );
}
