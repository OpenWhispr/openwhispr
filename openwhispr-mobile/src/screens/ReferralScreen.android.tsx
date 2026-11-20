import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  TextInput,
  Pressable,
  ActivityIndicator,
  Alert,
  Share,
  Platform,
} from 'react-native';
import { Text } from '@/components/ui/Text';
import * as Clipboard from 'expo-clipboard';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useAuthStore } from '@/store/useAuthStore';
import {
  fetchReferralStats,
  fetchReferralInvites,
  sendReferralInvite,
  type ReferralStats,
  type ReferralInvite,
} from '@/lib/referralApi';
import { safeHaptics, isValidEmail } from '@/lib/utils';
import { handleAccountRequiredError, requiresRealAccount } from '@/lib/accountAccess';
import { router } from 'expo-router';
import { home } from '@/android/home/kit';
import {
  Group,
  ListRow,
  PillAction,
  SettingsPage,
  settings,
  showToast,
} from '@/android/settings/kit';
import { bodyText, edgeField, look } from '@/android/settings/look';
import { settingsT } from '@/android/settings/strings';

const TITLE = 'Referral';

const STEPS = [
  'Share your invite link',
  'They sign up and get a free month of Pro',
  'You get a free month when they dictate 2,000 words',
];

/** The invite's state as a square tag, coloured by what it means. */
function InviteStatusBadge({ status }: { status: ReferralInvite['status'] }) {
  const config: Record<ReferralInvite['status'], { bg: string; text: string; label: string }> = {
    converted: { bg: 'rgba(31,157,85,0.12)', text: settings.success, label: 'Joined' },
    opened: { bg: look.selFill, text: home.accent, label: 'Opened' },
    failed: { bg: 'rgba(215,0,21,0.10)', text: look.error, label: 'Bounced' },
    sent: { bg: look.track, text: home.secondary, label: 'Sent' },
  };
  const c = config[status] ?? config.sent;

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 6,
        backgroundColor: c.bg,
      }}
    >
      {status === 'converted' && (
        <SystemIcon name="checkmark" mdName="Check" size={11} color={c.text} />
      )}
      <Text style={{ fontSize: 12, lineHeight: 16, fontWeight: '500', color: c.text }}>
        {c.label}
      </Text>
    </View>
  );
}

function HowItWorks() {
  return (
    <Group title="How it works" inset={14}>
      {STEPS.map((text, index) => (
        <ListRow key={text} title={`${index + 1}. ${text}`} trailing={null} />
      ))}
    </Group>
  );
}

/** "Months banked": white, corners 20, a label, the count in the accent and a line under it. */
function MonthsBanked({ months, children }: { months: number; children: React.ReactNode }) {
  return (
    <View
      style={{
        backgroundColor: home.surface,
        borderRadius: 20,
        paddingVertical: 18,
        paddingHorizontal: 20,
        gap: 4,
      }}
    >
      <Text
        style={{
          fontSize: 13,
          lineHeight: 18,
          color: home.text,
          opacity: 0.6,
          textTransform: 'uppercase',
        }}
      >
        Months banked
      </Text>
      <Text
        style={[
          settings.tabular,
          { fontSize: 32, lineHeight: 38, fontWeight: '700', color: home.accent },
        ]}
      >
        {months}
      </Text>
      {children}
    </View>
  );
}

const statLine = { ...bodyText, opacity: 0.7 };

// Guests have no session, so the referral API can never load. Instead of the
// generic error state, sell the reward and open sign-in. Android has no root auth
// gate, so signing a guest out would leave them here; an anonymous session must
// never be signed out either (it carries a purchase and notes).
function GuestReferralEmptyState() {
  const anonymous = useAuthStore((s) => s.user !== null);

  const handleSignIn = useCallback(() => {
    safeHaptics('medium');
    router.push('/auth?reason=referral');
  }, []);

  return (
    <SettingsPage title={TITLE}>
      <View style={{ gap: 12 }}>
        <Text
          accessibilityRole="header"
          style={{ fontSize: 32, lineHeight: 38, fontWeight: '700', color: home.text }}
        >
          Give a month, get a month
        </Text>
        <Text style={bodyText}>
          Invite friends to OpenWhispr. Each friend who dictates 2,000 words earns you a free month
          of Pro.
        </Text>
      </View>
      <MonthsBanked months={0}>
        <Text style={statLine}>free of Pro</Text>
        <Text style={statLine}>Sign in to start banking months</Text>
      </MonthsBanked>
      <HowItWorks />
      <PillAction
        primary
        label={anonymous ? 'Create an account to get your link' : 'Sign in to get your link'}
        onPress={handleSignIn}
      />
    </SettingsPage>
  );
}

export default function ReferralScreen() {
  const isAndroid = Platform.OS === 'android';
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
    try {
      await Clipboard.setStringAsync(stats.referralLink);
      safeHaptics('success');
      showToast(settingsT('linkCopied'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (copyError) {
      if (!isAndroid) throw copyError;
      Alert.alert('Could not copy link', 'Please try again.');
    }
  }, [stats, isAndroid]);

  const handleShareLink = useCallback(async () => {
    if (!stats?.referralLink) return;
    try {
      await Share.share({ message: stats.referralLink });
    } catch {
      Alert.alert('Could not share link', 'Please try again.');
    }
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
    try {
      const ok = await sendReferralInvite(trimmed, sessionCookie);
      if (!ok && isAndroid) throw new Error('Invite rejected');
      if (!isAndroid) setSendingInvite(false);
      if (ok) {
        setEmailInput('');
        safeHaptics('success');
        showToast(settingsT('inviteSent', { email: trimmed }));
        void loadData();
      } else {
        Alert.alert('Failed', 'Could not send invite. Please try again.');
      }
    } catch (inviteError) {
      if (!isAndroid) throw inviteError;
      Alert.alert('Failed', 'Could not send invite. Please try again.');
    } finally {
      if (isAndroid) setSendingInvite(false);
    }
  }, [emailInput, sendingInvite, sessionCookie, loadData, isAndroid]);

  // Referrals are account-gated on the API, so an anonymous session lands on
  // the same empty state a guest does rather than loading stats it refuses.
  if (requiresRealAccount(user)) {
    return <GuestReferralEmptyState />;
  }

  if (loading) {
    return (
      <SettingsPage title={TITLE} scroll={false}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color={home.accent} />
        </View>
      </SettingsPage>
    );
  }

  if (error || !stats) {
    return (
      <SettingsPage title={TITLE}>
        <Text style={bodyText}>{error || 'Unable to load referral data'}</Text>
        <PillAction label="Try Again" onPress={loadData} />
      </SettingsPage>
    );
  }

  const hasReward = stats.totalMonthsEarned > 0;
  const completed = stats.completedReferrals;
  const sendDisabled = !emailInput.trim() || sendingInvite;

  return (
    <SettingsPage title={TITLE}>
      <MonthsBanked months={stats.totalMonthsEarned}>
        <Text style={statLine}>free of Pro</Text>
        <Text style={statLine}>
          {hasReward ? (
            <>
              <Text style={[settings.tabular, { fontWeight: '500' }]}>
                {completed} {completed === 1 ? 'friend' : 'friends'}
              </Text>{' '}
              have crossed 2,000 words — one free month for each.
            </>
          ) : (
            'Invite your first friend to start earning free months.'
          )}
        </Text>
      </MonthsBanked>

      <View style={{ gap: 12 }}>
        <Group title="Invite a friend" inset={14}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              minHeight: 48,
              paddingLeft: 14,
              paddingRight: 4,
            }}
          >
            <Text
              {...(isAndroid ? {} : { numberOfLines: 1 })}
              selectable
              style={[settings.rowTitle, { flex: 1, paddingVertical: 12 }]}
            >
              {stats.referralLink}
            </Text>
            <Pressable
              onPress={handleCopyLink}
              {...(isAndroid
                ? {
                    accessibilityRole: 'button' as const,
                    accessibilityLabel: copied ? 'Link copied' : 'Copy referral link',
                  }
                : {})}
              style={({ pressed }) => ({
                width: 48,
                height: 48,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <SystemIcon
                name={copied ? 'checkmark' : 'doc.on.doc'}
                mdName={copied ? 'Check' : 'Copy'}
                size={18}
                color={copied ? settings.success : home.accent}
              />
            </Pressable>
          </View>
          {isAndroid && <ListRow title="Share referral link" onPress={handleShareLink} />}
        </Group>
        <TextInput
          value={emailInput}
          onChangeText={setEmailInput}
          placeholder="friend@example.com"
          placeholderTextColor="rgba(24,23,20,0.4)"
          keyboardType="email-address"
          autoCapitalize="none"
          returnKeyType="send"
          onSubmitEditing={handleSendInvite}
          editable={!sendingInvite}
          style={[
            edgeField,
            { ...bodyText, minHeight: 49, paddingHorizontal: 16, paddingVertical: 13 },
          ]}
        />
        <PillAction
          label="Send"
          busy={sendingInvite}
          disabled={sendDisabled}
          onPress={handleSendInvite}
        />
      </View>

      <HowItWorks />

      {invites.length > 0 && (
        <Group title={`Sent invites · ${invites.length}`} inset={14}>
          {invites.map((invite) => (
            <ListRow
              key={invite.id}
              title={invite.recipientEmail}
              trailing={<InviteStatusBadge status={invite.status} />}
            />
          ))}
        </Group>
      )}
    </SettingsPage>
  );
}
