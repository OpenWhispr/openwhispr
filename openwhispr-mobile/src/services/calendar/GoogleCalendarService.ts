import { Platform } from 'react-native';
import { calendarRepository } from '@/data/calendarRepository';
import type { CalendarRepository, GoogleCalendarAccount } from '@/data/calendarTypes';
import {
  deleteGoogleCalendarTokens,
  exchangeGoogleCalendarCode,
  getGoogleCalendarTokens,
  revokeGoogleCalendarToken,
  saveGoogleCalendarTokens,
  type ExchangeGoogleCalendarCodeInput,
  type GoogleCalendarAuthorizationResult,
} from './googleCalendarAuth';
import { forgetAndroidGoogleCalendarToken } from './googleCalendarAndroidAuth';
import {
  syncGoogleCalendarList,
  syncSelectedGoogleCalendarEventWindow,
} from './googleCalendarSync';
import { captureGoogleCalendarException } from './googleCalendarTelemetry';

interface GoogleCalendarServiceDeps {
  repo?: CalendarRepository;
}

const serializeScopes = (scopes: string[]): string => scopes.join(' ');

export async function connectGoogleCalendarAccount(
  input: ExchangeGoogleCalendarCodeInput,
  deps: GoogleCalendarServiceDeps = {},
): Promise<GoogleCalendarAccount> {
  return saveConnectedAccount(() => exchangeGoogleCalendarCode(input), deps);
}

/** Android: Play services already authorized the account, so there is no code to exchange. */
export async function connectAuthorizedGoogleCalendarAccount(
  authorization: GoogleCalendarAuthorizationResult,
  deps: GoogleCalendarServiceDeps = {},
): Promise<GoogleCalendarAccount> {
  return saveConnectedAccount(async () => authorization, deps);
}

async function saveConnectedAccount(
  authorize: () => Promise<GoogleCalendarAuthorizationResult>,
  deps: GoogleCalendarServiceDeps,
): Promise<GoogleCalendarAccount> {
  const repo = deps.repo ?? calendarRepository;
  try {
    const { identity, tokens } = await authorize();
    const account = repo.upsertAccount({
      googleSubject: identity.sub,
      email: identity.email ?? null,
      displayName: identity.name ?? null,
      grantedScopes: serializeScopes(tokens.scopes),
      status: 'connected',
      lastError: null,
    });
    await saveGoogleCalendarTokens(identity.sub, tokens);
    await syncGoogleCalendarList(account.id, { repo });
    await syncSelectedGoogleCalendarEventWindow(account.id, { repo });
    return repo.getAccountById(account.id) ?? account;
  } catch (error) {
    captureGoogleCalendarException(error, 'connect');
    throw error;
  }
}

export async function refreshGoogleCalendarAccount(
  accountId: number,
  deps: GoogleCalendarServiceDeps = {},
): Promise<void> {
  const repo = deps.repo ?? calendarRepository;
  await syncGoogleCalendarList(accountId, { repo });
  await syncSelectedGoogleCalendarEventWindow(accountId, { repo });
}

export async function disconnectGoogleCalendarAccount(
  accountId: number,
  deps: GoogleCalendarServiceDeps = {},
): Promise<void> {
  const repo = deps.repo ?? calendarRepository;
  const account = repo.getAccountById(accountId);
  if (!account) return;
  try {
    const tokens = await getGoogleCalendarTokens(account.googleSubject);
    const tokenToRevoke = tokens?.refreshToken ?? tokens?.accessToken;
    if (tokenToRevoke) await revokeGoogleCalendarToken(tokenToRevoke);
    if (Platform.OS === 'android' && tokens?.accessToken)
      await forgetAndroidGoogleCalendarToken(tokens.accessToken);
  } catch (error) {
    captureGoogleCalendarException(error, 'disconnect_revoke');
    // Local disconnect must complete even if Google revoke fails.
  } finally {
    try {
      await deleteGoogleCalendarTokens(account.googleSubject);
    } finally {
      repo.deleteAccountData(accountId);
    }
  }
}
