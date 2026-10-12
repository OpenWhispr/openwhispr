import { fetch } from 'expo/fetch';
import { ApiError, getClientVersionHeader } from '@/lib/apiClient';
import { parseApiErrorBody } from '@/lib/apiErrorBody';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'https://api.openwhispr.com';

export interface ReferralStats {
  referralCode: string;
  referralLink: string;
  totalReferrals: number;
  completedReferrals: number;
  totalMonthsEarned: number;
  referrals: Referral[];
}

export interface Referral {
  id: string;
  email: string;
  name: string;
  status: 'pending' | 'completed' | 'rewarded';
  created_at: string;
  words_used: number;
}

export interface ReferralInvite {
  id: string;
  recipientEmail: string;
  status: 'sent' | 'opened' | 'converted' | 'failed';
  sentAt: string;
}

function authHeaders(sessionCookie: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...getClientVersionHeader(),
  };
  if (sessionCookie) headers['Cookie'] = sessionCookie;
  return headers;
}

export async function fetchReferralStats(sessionCookie: string | null): Promise<ReferralStats> {
  const res = await fetch(`${API_URL}/api/referrals/stats`, {
    headers: authHeaders(sessionCookie),
  });
  if (!res.ok) {
    // Raw fetch rather than apiClient, so decode the envelope here too: the
    // API gates referrals behind a real account and the screen needs the code
    // to offer sign-up instead of a generic failure.
    const { message, code } = parseApiErrorBody(await res.json().catch(() => null));
    throw new ApiError(message || 'Failed to fetch referral stats', res.status, code);
  }
  return res.json();
}

export async function fetchReferralInvites(
  sessionCookie: string | null,
): Promise<ReferralInvite[]> {
  const res = await fetch(`${API_URL}/api/referrals/invites`, {
    headers: authHeaders(sessionCookie),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.invites ?? [];
}

export async function sendReferralInvite(
  email: string,
  sessionCookie: string | null,
): Promise<boolean> {
  const res = await fetch(`${API_URL}/api/referrals/invite`, {
    method: 'POST',
    headers: authHeaders(sessionCookie),
    body: JSON.stringify({ email }),
  });
  return res.ok;
}
