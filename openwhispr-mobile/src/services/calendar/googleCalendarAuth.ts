import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import { Buffer } from 'buffer';
import {
  GOOGLE_AUTH_DISCOVERY,
  getGoogleCalendarRedirectUri,
  getGoogleCalendarRequestScopes,
  getGoogleCalendarRequiredScopes,
} from './googleCalendarConfig';

const TOKEN_KEY_PREFIX = 'google-calendar.tokens';
const EXPIRY_SKEW_MS = 60_000;

export interface GoogleCalendarTokenBundle {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  expiresAt: number;
  scopes: string[];
}

export interface GoogleIdentityClaims {
  sub: string;
  email?: string;
  name?: string;
}

export interface GoogleCalendarAuthorizationResult {
  tokens: GoogleCalendarTokenBundle;
  identity: GoogleIdentityClaims;
}

export interface ExchangeGoogleCalendarCodeInput {
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri?: string;
}

export interface RefreshGoogleCalendarTokenInput {
  clientId: string;
  googleSubject: string;
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface TokenStorage {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

interface TokenHttpClient {
  (url: string, init: RequestInit): Promise<Response>;
}

export class GoogleCalendarAuthError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'GoogleCalendarAuthError';
    this.code = code;
  }
}

const tokenStorageKey = (googleSubject: string): string => `${TOKEN_KEY_PREFIX}.${googleSubject}`;

const parseScopes = (value: string | string[] | null | undefined): string[] => {
  if (Array.isArray(value)) return value;
  return value?.split(/\s+/).filter(Boolean) ?? [];
};

export function hasRequiredGoogleCalendarScopes(
  grantedScopes: string | string[] | null | undefined,
): boolean {
  const granted = new Set(parseScopes(grantedScopes));
  return getGoogleCalendarRequiredScopes().every((scope) => granted.has(scope));
}

export function buildGoogleCalendarAuthRequest(clientId: string): AuthSession.AuthRequest {
  return new AuthSession.AuthRequest({
    clientId,
    redirectUri: getGoogleCalendarRedirectUri(),
    responseType: AuthSession.ResponseType.Code,
    scopes: getGoogleCalendarRequestScopes(),
    usePKCE: true,
    extraParams: {
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: 'consent select_account',
    },
  });
}

export function decodeGoogleIdToken(idToken: string): GoogleIdentityClaims {
  const [, payload] = idToken.split('.');
  if (!payload) {
    throw new GoogleCalendarAuthError('invalid_id_token', 'Google ID token is malformed');
  }
  const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
  const claims = JSON.parse(Buffer.from(normalized, 'base64').toString('utf8')) as {
    sub?: unknown;
    email?: unknown;
    name?: unknown;
  };
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
    throw new GoogleCalendarAuthError('missing_subject', 'Google ID token is missing subject');
  }
  return {
    sub: claims.sub,
    email: typeof claims.email === 'string' ? claims.email : undefined,
    name: typeof claims.name === 'string' ? claims.name : undefined,
  };
}

function mapTokenResponse(
  response: GoogleTokenResponse,
  fallback?: {
    refreshToken?: string | null;
    scopes?: string[];
  },
) {
  if (!response.access_token) {
    throw new GoogleCalendarAuthError(
      response.error || 'missing_access_token',
      response.error_description || 'Google token response did not include an access token',
    );
  }
  const scopes =
    response.scope === undefined ? (fallback?.scopes ?? []) : parseScopes(response.scope);
  const granted = new Set(scopes);
  const missingScopes = getGoogleCalendarRequiredScopes().filter((scope) => !granted.has(scope));
  if (missingScopes.length > 0) {
    throw new GoogleCalendarAuthError(
      'missing_required_scopes',
      `Google Calendar did not grant required scopes: ${missingScopes.join(', ')}`,
    );
  }
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token ?? fallback?.refreshToken ?? null,
    idToken: response.id_token ?? null,
    expiresAt: Date.now() + Math.max(response.expires_in ?? 0, 0) * 1000,
    scopes,
  } satisfies GoogleCalendarTokenBundle;
}

async function postTokenRequest(
  body: URLSearchParams,
  httpClient: TokenHttpClient,
): Promise<GoogleTokenResponse> {
  const res = await httpClient(GOOGLE_AUTH_DISCOVERY.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = (await res.json().catch(() => ({}))) as GoogleTokenResponse;
  if (!res.ok) {
    throw new GoogleCalendarAuthError(
      json.error || `http_${res.status}`,
      json.error_description || `Google token request failed with HTTP ${res.status}`,
    );
  }
  return json;
}

export async function exchangeGoogleCalendarCode(
  input: ExchangeGoogleCalendarCodeInput,
  httpClient: TokenHttpClient = globalThis.fetch,
): Promise<GoogleCalendarAuthorizationResult> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    code: input.code,
    code_verifier: input.codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: input.redirectUri ?? getGoogleCalendarRedirectUri(),
  });
  const raw = await postTokenRequest(body, httpClient);
  if (!raw.id_token) {
    throw new GoogleCalendarAuthError('missing_id_token', 'Google token response omitted ID token');
  }
  const tokens = mapTokenResponse(raw);
  const identity = decodeGoogleIdToken(raw.id_token);
  return { tokens, identity };
}

export async function saveGoogleCalendarTokens(
  googleSubject: string,
  tokens: GoogleCalendarTokenBundle,
  storage: TokenStorage = SecureStore,
): Promise<void> {
  await storage.setItemAsync(tokenStorageKey(googleSubject), JSON.stringify(tokens));
}

export async function getGoogleCalendarTokens(
  googleSubject: string,
  storage: TokenStorage = SecureStore,
): Promise<GoogleCalendarTokenBundle | null> {
  const raw = await storage.getItemAsync(tokenStorageKey(googleSubject));
  if (!raw) return null;
  return JSON.parse(raw) as GoogleCalendarTokenBundle;
}

export async function deleteGoogleCalendarTokens(
  googleSubject: string,
  storage: TokenStorage = SecureStore,
): Promise<void> {
  await storage.deleteItemAsync(tokenStorageKey(googleSubject));
}

export function isGoogleCalendarAccessTokenFresh(tokens: GoogleCalendarTokenBundle): boolean {
  return tokens.expiresAt - EXPIRY_SKEW_MS > Date.now();
}

export async function refreshStoredGoogleCalendarToken(
  input: RefreshGoogleCalendarTokenInput,
  deps: {
    storage?: TokenStorage;
    httpClient?: TokenHttpClient;
  } = {},
): Promise<GoogleCalendarTokenBundle> {
  const storage = deps.storage ?? SecureStore;
  const httpClient = deps.httpClient ?? globalThis.fetch;
  const existing = await getGoogleCalendarTokens(input.googleSubject, storage);
  if (!existing?.refreshToken) {
    throw new GoogleCalendarAuthError(
      'missing_refresh_token',
      'Google Calendar account must reconnect',
    );
  }
  if (isGoogleCalendarAccessTokenFresh(existing)) return existing;

  const body = new URLSearchParams({
    client_id: input.clientId,
    grant_type: 'refresh_token',
    refresh_token: existing.refreshToken,
  });
  const raw = await postTokenRequest(body, httpClient);
  const refreshed = mapTokenResponse(raw, {
    refreshToken: existing.refreshToken,
    scopes: existing.scopes,
  });
  await saveGoogleCalendarTokens(input.googleSubject, refreshed, storage);
  return refreshed;
}

export async function revokeGoogleCalendarToken(
  token: string,
  httpClient: TokenHttpClient = globalThis.fetch,
): Promise<void> {
  await httpClient(
    `${GOOGLE_AUTH_DISCOVERY.revocationEndpoint}?token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
    },
  );
}
