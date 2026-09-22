import React, { useEffect, useState, useCallback } from 'react';
import { View, ScrollView, TextInput, Pressable, ActivityIndicator, Alert } from 'react-native';
import { Text } from '@/components/ui/Text';
import * as Clipboard from 'expo-clipboard';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { TabScreenHeader } from '@/components/ui/TabScreenHeader';
import { Button } from '@/components/ui/Button';
import { GradientGlassSurface } from '@/components/ui/GradientGlassSurface';
import { useAuthStore } from '@/store/useAuthStore';
import {
  fetchReferralStats,
  fetchReferralInvites,
  sendReferralInvite,
  type ReferralStats,
  type ReferralInvite,
} from '@/lib/referralApi';
import { safeHaptics, isValidEmail } from '@/lib/utils';
import { iosColor } from '@/config/colors';
import { SpaceGrotesk } from '@/lib/fonts';
import { handleAccountRequiredError, requiresRealAccount } from '@/lib/accountAccess';
import { router } from 'expo-router';

const LABEL_COLOR = iosColor('label');
const PLACEHOLDER_COLOR = iosColor('tertiaryLabel');

function InviteStatusBadge({ status }: { status: ReferralInvite['status'] }) {
  const config: Record<ReferralInvite['status'], { bg: string; text: string; label: string }> = {
    converted: { bg: 'bg-systemGreen/15', text: 'text-systemGreen', label: 'Joined' },
    opened: { bg: 'bg-link/15', text: 'text-link', label: 'Opened' },
    failed: { bg: 'bg-systemRed/15', text: 'text-systemRed', label: 'Bounced' },
    sent: { bg: 'bg-quaternarySystemFill', text: 'text-secondaryLabel', label: 'Sent' },
  };
  const c = config[status] ?? config.sent;

  return (
    <View
      style={{ borderCurve: 'continuous' }}
      className={`flex-row items-center gap-1 rounded-md px-2 py-0.5 ${c.bg}`}
    >
      {status === 'converted' && (
        <SystemIcon name="checkmark" mdName="Check" size={11} color="systemGreen" />
      )}
      <Text className={`text-[11px] font-semibold ${c.text}`}>{c.label}</Text>
    </View>
  );
}

function StepRow({ step, text }: { step: number; text: string }) {
  return (
    <View className="flex-row items-start gap-2.5">
      <View
        style={{ borderCurve: 'continuous' }}
        className="mt-0.5 h-[22px] w-[22px] items-center justify-center rounded-full bg-quaternarySystemFill"
      >
        <Text
          style={{ fontVariant: ['tabular-nums'] }}
          className="text-[11px] font-bold text-secondaryLabel"
        >
          {step}
        </Text>
      </View>
      <Text className="flex-1 text-[13px] leading-snug text-label">{text}</Text>
    </View>
  );
}

// Guests have no session, so the referral API can never load. Instead of the
// generic error state, sell the reward and route to sign-in (signOut clears the
// guest session, which surfaces AuthScreen from the root layout).
function GuestReferralEmptyState() {
  const signOut = useAuthStore((s) => s.signOut);
  // Non-null here means an anonymous onboarding session. Signing it out to
  // reach AuthScreen would revoke it, and the purchase and notes it carries.
  const anonymous = useAuthStore((s) => s.user !== null);
  const [leaving, setLeaving] = useState(false);

  const handleSignIn = useCallback(async () => {
    safeHaptics('medium');
    if (anonymous) {
      router.push('/auth');
      return;
    }
    setLeaving(true);
    await signOut();
  }, [anonymous, signOut]);

  return (
    <View className="flex-1 bg-systemBackground">
      <TabScreenHeader title="Referral" />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <View className="items-center px-6 pt-7">
          <View
            style={{ borderCurve: 'continuous' }}
            className="h-16 w-16 items-center justify-center overflow-hidden rounded-[18px] bg-brand"
          >
            <GradientGlassSurface radius={18} />
            <SystemIcon name="gift.fill" mdName="Gift" size={30} color="#FFFFFF" />
          </View>
          <Text className="mt-[18px] text-center text-[22px] font-bold tracking-tight text-label">
            Give a month, get a month
          </Text>
          <Text className="mt-2 text-center text-[14px] leading-snug text-secondaryLabel">
            Invite friends to OpenWhispr. Each friend who dictates 2,000 words earns you a free
            month of Pro.
          </Text>
        </View>

        <View className="mt-6 px-4">
          <View
            style={{ borderCurve: 'continuous' }}
            className="overflow-hidden rounded-[14px] border border-separator bg-secondarySystemGroupedBackground p-5"
          >
            <View className="opacity-50">
              <View className="flex-row items-center gap-2">
                <SystemIcon name="gift.fill" mdName="Gift" size={13} color="tertiaryLabel" />
                <Text className="text-xs font-semibold uppercase tracking-wider text-secondaryLabel">
                  Months banked
                </Text>
              </View>
              <View className="mt-2 flex-row items-baseline gap-2">
                <Text
                  style={{ fontVariant: ['tabular-nums'] }}
                  className="text-[56px] font-bold leading-none tracking-tighter text-tertiaryLabel"
                >
                  0
                </Text>
                <Text className="text-[15px] text-secondaryLabel">free of Pro</Text>
              </View>
            </View>
            <View
              style={{ borderCurve: 'continuous' }}
              className="mt-4 flex-row items-center gap-1.5 self-start rounded-md bg-quaternarySystemFill px-2.5 py-1.5"
            >
              <SystemIcon name="lock.fill" mdName="Lock" size={11} color="secondaryLabel" />
              <Text className="text-[12px] font-semibold text-secondaryLabel">
                Sign in to start banking months
              </Text>
            </View>
          </View>
        </View>

        <View className="mt-6 px-4">
          <Text className="mb-2 text-xs font-semibold uppercase tracking-wider text-secondaryLabel">
            How it works
          </Text>
          <View className="gap-2.5">
            <StepRow step={1} text="Share your invite link" />
            <StepRow step={2} text="They sign up and get a free month of Pro" />
            <StepRow step={3} text="You get a free month when they dictate 2,000 words" />
          </View>
        </View>

        <View className="mt-7 px-4">
          <Button onPress={handleSignIn} loading={leaving}>
            {anonymous ? 'Create an account to get your link' : 'Sign in to get your link'}
          </Button>
        </View>
      </ScrollView>
    </View>
  );
}

export default function ReferralScreen() {
  const { user, sessionCookie } = useAuthStore();
  const [stats, setStats] = useState<ReferralStats | null>(null);
  const [invites, setInvites] = useState<ReferralInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [emailInput, setEmailInput] = useState('');
  const [sendingInvite, setSendingInvite] = useState(false);
  const [copied, setCopied] = useState(false);

  const loadData = useCallback(async () => {
    if (requiresRealAccount(user)) {
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const [statsData, invitesData] = await Promise.all([
        fetchReferralStats(sessionCookie),
        fetchReferralInvites(sessionCookie),
      ]);
      setStats(statsData);
      setInvites(invitesData);
    } catch (err) {
      // Backstop for a session the API considers account-less that the
      // pre-check above did not — e.g. a stale isAnonymous after a link.
      if (!handleAccountRequiredError(err, 'referrals')) {
        setError('Unable to load referral data.');
      }
    } finally {
      setLoading(false);
    }
  }, [user, sessionCookie]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleCopyLink = useCallback(async () => {
    if (!stats?.referralLink) return;
    await Clipboard.setStringAsync(stats.referralLink);
    safeHaptics('success');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [stats]);

  const handleSendInvite = useCallback(async () => {
    const trimmed = emailInput.trim();
    if (!trimmed || sendingInvite) return;
    if (!isValidEmail(trimmed)) {
      Alert.alert('Invalid email', 'Please enter a valid email address.');
      return;
    }
    safeHaptics('medium');
    setSendingInvite(true);
    const ok = await sendReferralInvite(trimmed, sessionCookie);
    setSendingInvite(false);
    if (ok) {
      setEmailInput('');
      safeHaptics('success');
      loadData();
    } else {
      Alert.alert('Failed', 'Could not send invite. Please try again.');
    }
  }, [emailInput, sendingInvite, sessionCookie, loadData]);

  // Referrals are account-gated on the API, so an anonymous session lands on
  // the same empty state a guest does rather than loading stats it refuses.
  if (requiresRealAccount(user)) {
    return <GuestReferralEmptyState />;
  }

  if (loading) {
    return (
      <View className="flex-1 bg-systemBackground">
        <TabScreenHeader title="Referral" />
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" />
        </View>
      </View>
    );
  }

  if (error || !stats) {
    return (
      <View className="flex-1 bg-systemBackground">
        <TabScreenHeader title="Referral" />
        <View className="flex-1 items-center justify-center p-8">
          <Text className="mb-4 text-center text-sm text-secondaryLabel">
            {error || 'Unable to load referral data'}
          </Text>
          <Pressable onPress={loadData} className="p-3">
            <Text className="text-[15px] text-link">Try Again</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const hasReward = stats.totalMonthsEarned > 0;
  const completed = stats.completedReferrals;
  const sendDisabled = !emailInput.trim() || sendingInvite;

  return (
    <View className="flex-1 bg-systemBackground">
      <TabScreenHeader title="Referral" />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <View className="mt-2 px-4">
          <View
            style={{ borderCurve: 'continuous' }}
            className="overflow-hidden rounded-[14px] border border-separator bg-secondarySystemGroupedBackground p-5"
          >
            <View className="flex-row items-center gap-2">
              <SystemIcon
                name="gift.fill"
                mdName="Gift"
                size={13}
                color={hasReward ? 'systemGreen' : 'tertiaryLabel'}
              />
              <Text className="text-xs font-semibold uppercase tracking-wider text-secondaryLabel">
                Months banked
              </Text>
            </View>
            <View className="mt-2 flex-row items-baseline gap-2">
              <Text
                style={{ fontVariant: ['tabular-nums'] }}
                className={`text-[56px] font-bold leading-none tracking-tighter ${
                  hasReward ? 'text-label' : 'text-tertiaryLabel'
                }`}
              >
                {stats.totalMonthsEarned}
              </Text>
              <Text className="text-[15px] text-secondaryLabel">free of Pro</Text>
            </View>
            <Text className="mt-3 text-[12.5px] leading-snug text-secondaryLabel">
              {hasReward ? (
                <>
                  <Text
                    style={{ fontVariant: ['tabular-nums'] }}
                    className="font-semibold text-label"
                  >
                    {completed} {completed === 1 ? 'friend' : 'friends'}
                  </Text>{' '}
                  have crossed 2,000 words — one free month for each.
                </>
              ) : (
                'Invite your first friend to start earning free months.'
              )}
            </Text>
          </View>
        </View>

        <View className="mt-5 px-4">
          <Text className="mb-2 text-xs font-semibold uppercase tracking-wider text-secondaryLabel">
            Invite a friend
          </Text>
          <View
            style={{ borderCurve: 'continuous' }}
            className="overflow-hidden rounded-[14px] border border-separator bg-secondarySystemGroupedBackground"
          >
            <View className="flex-row items-stretch">
              <View className="flex-1 flex-row items-center gap-2 px-3.5 py-3">
                <SystemIcon name="link" mdName="Link" size={13} color="secondaryLabel" />
                <Text
                  numberOfLines={1}
                  selectable
                  style={{ fontFamily: 'monospace' }}
                  className="flex-1 text-[13px] text-label"
                >
                  {stats.referralLink}
                </Text>
              </View>
              <Pressable
                onPress={handleCopyLink}
                style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
                className="w-[68px] items-center justify-center border-l border-separator"
              >
                <SystemIcon
                  name={copied ? 'checkmark' : 'doc.on.doc'}
                  mdName={copied ? 'Check' : 'Copy'}
                  size={16}
                  color={copied ? 'systemGreen' : 'link'}
                />
              </Pressable>
            </View>
            <View className="h-px bg-separator" />
            <View className="flex-row items-stretch">
              <View className="flex-1 flex-row items-center gap-2 px-3.5">
                <SystemIcon name="envelope" mdName="Mail" size={13} color="secondaryLabel" />
                <TextInput
                  value={emailInput}
                  onChangeText={setEmailInput}
                  placeholder="friend@example.com"
                  placeholderTextColor={PLACEHOLDER_COLOR}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  returnKeyType="send"
                  onSubmitEditing={handleSendInvite}
                  editable={!sendingInvite}
                  style={{ color: LABEL_COLOR, fontFamily: SpaceGrotesk.regular }}
                  className="flex-1 py-3 text-[14px]"
                />
              </View>
              <Pressable
                onPress={handleSendInvite}
                disabled={sendDisabled}
                style={({ pressed }) => ({
                  opacity: sendDisabled ? 0.4 : pressed ? 0.7 : 1,
                })}
                className="w-[68px] items-center justify-center border-l border-separator bg-brand"
              >
                {sendingInvite ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text className="text-[13px] font-semibold text-white">Send</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>

        <View className="mt-5 px-4">
          <Text className="mb-2 text-xs font-semibold uppercase tracking-wider text-secondaryLabel">
            How it works
          </Text>
          <View className="gap-2.5">
            <StepRow step={1} text="Share your invite link" />
            <StepRow step={2} text="They sign up and get a free month of Pro" />
            <StepRow step={3} text="You get a free month when they dictate 2,000 words" />
          </View>
        </View>

        {invites.length > 0 && (
          <View className="mt-5 px-4">
            <Text className="mb-2 text-xs font-semibold uppercase tracking-wider text-secondaryLabel">
              Sent invites · {invites.length}
            </Text>
            <View
              style={{ borderCurve: 'continuous' }}
              className="overflow-hidden rounded-[14px] border border-separator bg-secondarySystemGroupedBackground"
            >
              {invites.map((invite, idx) => (
                <View key={invite.id}>
                  {idx > 0 && <View className="h-px bg-separator" />}
                  <View className="flex-row items-center gap-3 px-3.5 py-2.5">
                    <SystemIcon name="envelope" mdName="Mail" size={13} color="secondaryLabel" />
                    <Text numberOfLines={1} className="flex-1 text-[13.5px] text-label">
                      {invite.recipientEmail}
                    </Text>
                    <InviteStatusBadge status={invite.status} />
                  </View>
                </View>
              ))}
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}
