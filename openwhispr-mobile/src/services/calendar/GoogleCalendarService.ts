import { calendarRepository } from '@/data/calendarRepository';
import type { CalendarRepository, GoogleCalendarAccount } from '@/data/calendarTypes';
import {
  deleteGoogleCalendarTokens,
  exchangeGoogleCalendarCode,
  getGoogleCalendarTokens,
  revokeGoogleCalendarToken,
  saveGoogleCalendarTokens,
  type ExchangeGoogleCalendarCodeInput,
} from './googleCalendarAuth';
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
  const repo = deps.repo ?? calendarRepository;
  try {
    const { identity, tokens } = await exchangeGoogleCalendarCode(input);
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
