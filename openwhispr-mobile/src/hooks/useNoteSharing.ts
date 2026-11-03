import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform, Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import { notesRepository, type Note } from '@/data';
import { ApiError } from '@/lib/apiClient';
import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import {
  NoteSharingError,
  noteSharingFeedback,
  type NoteSharingFeedbackCode,
} from '@/lib/notes/noteSharingFeedback';
import { isValidEmail } from '@/lib/utils';
import type { AuthUser } from '@/lib/authClient';
import { getNoteShareViewerBaseUrl } from '@/config/noteSharing';
import { useAuthStore } from '@/store/useAuthStore';
import { useNotesStore } from '@/store/useNotesStore';
import * as api from '@/data/remote/noteSharingApi';
import type {
  ExternalSharingMode,
  ShareSettings,
  ShareStateResponse,
  ShareVisibility,
  NoteAccessGrant,
  NoteShareInvitation,
  AccessPrincipalSuggestion,
} from '@/data/remote/noteSharingTypes';
import {
  buildNoteInviteUrl,
  buildNoteShareUrl,
  readNoteShareToken,
  saveNoteShareToken,
  removeNoteShareToken,
} from '@/lib/notes/noteShareTokens';
import { canChangeGrant, isGroupPrincipal, isScopeGrant } from '@/lib/notes/noteShareAccess';
import { ensureNoteSynced } from '@/sync/ensureNoteSynced';
import { requestSync } from '@/sync/syncEngine';

export interface NoteSharingController {
  state: ShareStateResponse | null;
  loading: boolean;
  busy: boolean;
  /** The running operation is still waiting for the note upload, so abandoning it changes nothing. */
  cancellable: boolean;
  error: string | null;
  /** Stable app-owned identity; provider text has no local code. */
  errorCode: NoteSharingFeedbackCode | null;
  message: string | null;
  /** Invited sharing links to the invitation page; other modes need the full link stored here. */
  hasLink: boolean;
  /** Null while unknown; the server enforces the policy either way. */
  sharingMode: ExternalSharingMode | null;
  note: Note | undefined;
  user: AuthUser | null;
  refresh: () => Promise<void>;
  dismissError: () => void;
  setVisibility: (visibility: ShareVisibility, domainAllowlist?: string[]) => Promise<void>;
  replaceLink: () => Promise<void>;
  copyLink: () => Promise<void>;
  shareLink: () => Promise<void>;
  openLink: () => Promise<void>;
  /** Resolves true once the invitation is confirmed. */
  inviteEmail: (email: string) => Promise<boolean>;
  addPrincipal: (principal: AccessPrincipalSuggestion) => Promise<void>;
  updateGrant: (grant: NoteAccessGrant, permission: NoteAccessGrant['permission']) => Promise<void>;
  removeGrant: (grant: NoteAccessGrant) => Promise<void>;
  revokeInvitation: (invitation: NoteShareInvitation) => Promise<void>;
  resendInvitation: (invitation: NoteShareInvitation) => Promise<void>;
}

interface SharingOperation {
  remoteId: string;
  userId: string;
  signal: AbortSignal;
  current: ShareStateResponse;
  check: () => void;
  mutate: <Result>(request: () => Promise<Result>) => Promise<Result>;
  /** Ends the operation before handing off to OS UI that stays open until the user dismisses it. */
  release: () => void;
}

interface RunOptions {
  /** Flush the draft and wait for its acknowledged upload before reading settings. */
  publish?: boolean;
  /** Allow a locally private note, e.g. to disable a link left over from its old cloud copy. */
  allowPrivate?: boolean;
}

export const INVALID_EMAIL_ERROR = noteSharingFeedback.invalidEmail;

const GENERIC_ERROR = new NoteSharingError('generic');

const ERROR_MESSAGES: Record<string, NoteSharingFeedbackCode> = {
  POLICY_SHARING_BLOCKED: 'policy',
  POLICY_UNRESOLVABLE: 'policy',
  note_access_denied: 'denied',
  SSO_REQUIRED: 'sso',
  space_archived: 'archived',
  email_verification_required: 'verifyEmail',
  invitations_per_day_exceeded: 'dailyLimit',
  resend_cooldown: 'cooldown',
};

function sharingError(error: unknown): string | NoteSharingError {
  if (error instanceof NoteSharingError) return error;
  if (error instanceof ApiError) {
    const known = error.code ? ERROR_MESSAGES[error.code] : undefined;
    if (known) return new NoteSharingError(known);
    if (error.status === 401) return new NoteSharingError('sessionExpired');
    if (error.status === 409) return new NoteSharingError('settingsChanged');
    // Validation messages (an invalid email, a personal domain) are written for people; a bare
    // status from a response without a body is not.
    if ((error.status === 400 || error.status === 426) && !error.message.startsWith('HTTP '))
      return error.message;
    return GENERIC_ERROR;
  }
  // expo/fetch rejects with a FetchError (not exported) when the request never reaches the server.
  if (error instanceof Error && error.message.startsWith('fetch failed'))
    return new NoteSharingError('connection');
  return error instanceof Error ? error.message : GENERIC_ERROR;
}

function sameSettings(left: ShareSettings, right: ShareSettings): boolean {
  return (
    left.visibility === right.visibility &&
    left.domain_allowlist.join(',') === right.domain_allowlist.join(',')
  );
}

/** Invited sharing hands out the invitation link, which stays closed if visibility later widens. */
function invitationLink(share: ShareSettings): string | null {
  return share.visibility === 'invited' && share.token_prefix
    ? buildNoteInviteUrl(share.token_prefix)
    : null;
}

/** The cloud copy whose settings can load; private notes still load to manage an old link. */
function loadableRemoteId(user: AuthUser | null, local: Note | null | undefined): string | null {
  return user && !user.isAnonymous && local?.remoteId && !local.deletedAt ? local.remoteId : null;
}

/** A stored full link is kept only while it matches the server's current token. */
function loadToken(
  userId: string,
  remoteId: string,
  current: ShareStateResponse,
): Promise<string | null> {
  return readNoteShareToken(
    userId,
    remoteId,
    current.share.visibility === 'private' ? null : current.share.token_prefix,
  );
}

export function useNoteSharing(noteId: number, onFlushDraft: () => void): NoteSharingController {
  const { copy } = useAndroidCopy();
  const user = useAuthStore((s) => s.user);
  const cookie = useAuthStore((s) => s.sessionCookie);
  const notes = useNotesStore((s) => s.notes);
  // The store only holds the current folder/space/search view; like the editor, fall back to the
  // repository so a note outside that view keeps its identity (and its stored link).
  const note = useMemo<Note | undefined>(
    () =>
      notes.find((item) => item.id === noteId) ?? notesRepository.getNoteById(noteId) ?? undefined,
    [notes, noteId],
  );
  const [state, setState] = useState<ShareStateResponse | null>(null);
  const [loading, setLoading] = useState(() =>
    Boolean(loadableRemoteId(user, notesRepository.getNoteById(noteId))),
  );
  const [busy, setBusy] = useState(false);
  const [cancellable, setCancellable] = useState(false);
  const [error, setError] = useState<string | NoteSharingError | null>(null);
  const [message, setMessage] = useState<string | NoteSharingError | null>(null);
  const [hasToken, setHasToken] = useState(false);
  const [sharingMode, setSharingMode] = useState<ExternalSharingMode | null>(null);
  const operation = useRef<AbortController | null>(null);
  const loadRequest = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const previousIdentity = useRef<{ userId: string; remoteId: string } | null>(null);
  const observedRemoteId = useRef(note?.remoteId ?? null);

  /** A silent refresh keeps the current settings on screen and only replaces them on success. */
  const refresh = useCallback(
    async (silent?: boolean): Promise<void> => {
      // A quiet refresh must not replace a load in flight, which would hide that load's error.
      if (operation.current || (silent && loadRequest.current)) return;
      loadRequest.current?.abort();
      const controller = new AbortController();
      loadRequest.current = controller;
      const version = generation.current;
      const local = notesRepository.getNoteById(noteId);
      const valid = (): boolean =>
        !controller.signal.aborted &&
        version === generation.current &&
        useAuthStore.getState().user?.id === user?.id &&
        useAuthStore.getState().sessionCookie === cookie &&
        notesRepository.getNoteById(noteId)?.remoteId === local?.remoteId &&
        notesRepository.getNoteById(noteId)?.isPrivate === local?.isPrivate;
      const remoteId = loadableRemoteId(user, local);
      if (!silent || !user || !remoteId) {
        setState(null);
        setError(null);
        setHasToken(false);
      }
      if (!user || !remoteId) {
        loadRequest.current = null;
        setLoading(false);
        return;
      }
      if (!silent) setLoading(true);
      const timer = setTimeout(() => {
        controller.abort();
        if (loadRequest.current === controller) {
          setLoading(false);
          if (!silent) setError(new NoteSharingError('loadTimeout'));
        }
      }, 30_000);
      controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
      try {
        const current = await api.getNoteShareState(remoteId, { signal: controller.signal });
        if (!valid()) return;
        const token = local?.isPrivate === 1 ? null : await loadToken(user.id, remoteId, current);
        if (!valid()) return;
        setState(current);
        setError(null);
        setHasToken(Boolean(token));
      } catch (failure) {
        if (valid() && !silent) setError(sharingError(failure));
      } finally {
        clearTimeout(timer);
        if (loadRequest.current === controller) {
          loadRequest.current = null;
          setLoading(false);
        }
      }
    },
    [user, cookie, noteId],
  );

  useEffect(() => {
    generation.current += 1;
    operation.current?.abort();
    operation.current = null;
    setBusy(false);
    setCancellable(false);
    setMessage(null);
    refresh();
    // Returning from the share sheet or browser must not blank the sheet or drop a search.
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') refresh(true);
    });
    return (): void => {
      generation.current += 1;
      operation.current?.abort();
      loadRequest.current?.abort();
      subscription.remove();
    };
  }, [refresh, note?.isPrivate, note?.clientNoteId]);

  const policyUserId = user && !user.isAnonymous ? user.id : null;
  useEffect(() => {
    setSharingMode(null);
    if (!policyUserId) return;
    const controller = new AbortController();
    api
      .getExternalSharingMode({ signal: controller.signal })
      .then((mode) => {
        if (!controller.signal.aborted) setSharingMode(mode);
      })
      .catch(() => undefined);
    return (): void => controller.abort();
  }, [policyUserId, cookie]);

  useEffect(() => {
    const previous = previousIdentity.current;
    // Stored links survive sign-out and account switches; they are only dropped for this account.
    if (previous && previous.userId !== user?.id) setHasToken(false);
    else if (previous && (previous.remoteId !== note?.remoteId || note?.isPrivate === 1)) {
      removeNoteShareToken(previous.userId, previous.remoteId).catch(() => undefined);
      setHasToken(false);
    }
    if (previous && previous.userId === user?.id && previous.remoteId !== note?.remoteId) {
      generation.current += 1;
      operation.current?.abort();
      operation.current = null;
      setBusy(false);
      setCancellable(false);
      refresh();
    } else if (!observedRemoteId.current && note?.remoteId) {
      // Background sync uploaded the note while the sheet was open, so it now has settings to load.
      // A running operation loads them itself, and refresh() leaves it alone.
      refresh();
    }
    observedRemoteId.current = note?.remoteId ?? null;
    previousIdentity.current =
      user && note?.remoteId ? { userId: user.id, remoteId: note.remoteId } : null;
  }, [user, note?.remoteId, note?.isPrivate, refresh]);

  /** Resolves true when the task completed. */
  const run = async (
    task: (context: SharingOperation) => Promise<void>,
    { publish = false, allowPrivate = false }: RunOptions = {},
  ): Promise<boolean> => {
    if (operation.current) return false;
    const controller = new AbortController();
    operation.current = controller;
    loadRequest.current?.abort();
    setLoading(false);
    setBusy(true);
    setError(null);
    setMessage(null);
    const original = notesRepository.getNoteById(noteId);
    const version = generation.current;
    const timer = setTimeout(() => {
      controller.abort();
      if (operation.current === controller) {
        setState(null);
        setBusy(false);
        setError(new NoteSharingError('operationTimeout'));
      }
    }, 60_000);
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    const release = (): void => {
      clearTimeout(timer);
      if (operation.current === controller) {
        operation.current = null;
        setBusy(false);
        setCancellable(false);
      }
    };
    const check = (): void => {
      const auth = useAuthStore.getState();
      const current = notesRepository.getNoteById(noteId);
      if (
        controller.signal.aborted ||
        version !== generation.current ||
        auth.user?.id !== user?.id ||
        auth.sessionCookie !== cookie ||
        auth.isGuest ||
        auth.isLoading ||
        current?.clientNoteId !== original?.clientNoteId ||
        (original?.remoteId && current?.remoteId !== original.remoteId)
      ) {
        throw new NoteSharingError('contextChanged');
      }
      if (!auth.user || auth.user.isAnonymous) throw new NoteSharingError('signIn');
      if (!current || current.deletedAt) throw new NoteSharingError('noteUnavailable');
      if (current.isPrivate === 1 && !allowPrivate) throw new NoteSharingError('notePrivate');
    };
    try {
      check();
      let remoteId = original?.remoteId;
      if (publish) {
        getNoteShareViewerBaseUrl();
        onFlushDraft();
        setCancellable(true);
        remoteId = await ensureNoteSynced(noteId, { signal: controller.signal });
        setCancellable(false);
        check();
      }
      if (!remoteId || !user) throw new NoteSharingError('syncFirst');
      const current = await api.getNoteShareState(remoteId, { signal: controller.signal });
      check();
      setState(current);
      const mutate = async <Result>(request: () => Promise<Result>): Promise<Result> => {
        try {
          return await request();
        } catch (failure) {
          check();
          if (!(failure instanceof ApiError) || failure.status >= 500) {
            setState(null);
            setHasToken(false);
            throw new NoteSharingError('unconfirmed');
          }
          // A refused change can still leave sharing different from what the sheet shows: a row
          // removed elsewhere answers 404, and older servers lift a paused note before the daily
          // invitation cap.
          try {
            const latest = await api.getNoteShareState(remoteId, { signal: controller.signal });
            check();
            setState(latest);
          } catch {
            // The refusal is the error worth showing.
          }
          throw failure;
        }
      };
      await task({
        remoteId,
        userId: user.id,
        signal: controller.signal,
        current,
        check,
        mutate,
        release,
      });
      return true;
    } catch (failure) {
      if (!controller.signal.aborted && version === generation.current)
        setError(sharingError(failure));
      return false;
    } finally {
      release();
    }
  };

  const adopt = async (context: SharingOperation): Promise<ShareStateResponse> => {
    let current: ShareStateResponse;
    try {
      current = await api.getNoteShareState(context.remoteId, { signal: context.signal });
      context.check();
    } catch (failure) {
      context.check();
      setState(null);
      setMessage(null);
      // Removing or demoting your own access leaves nothing this account may load.
      if (failure instanceof ApiError && (failure.status === 403 || failure.status === 404))
        throw new NoteSharingError('accessLost');
      throw new NoteSharingError('reloadFailed');
    }
    setState(current);
    requestSync('manual');
    return current;
  };
  const sendUrl = async (context: SharingOperation, url: string): Promise<void> => {
    context.release();
    const title = note?.title || 'Untitled';
    await Share.share(Platform.OS === 'ios' ? { url, title } : { message: url, title });
  };
  const remember = async (context: SharingOperation, token: string): Promise<void> => {
    context.check();
    await saveNoteShareToken(context.userId, context.remoteId, token);
    context.check();
    setHasToken(true);
  };

  const setVisibility = async (
    visibility: ShareVisibility,
    domainAllowlist: string[] = [],
  ): Promise<void> => {
    // Compare-and-set against what the sheet showed, so a restricted share changed elsewhere (or
    // unknown locally) is never widened by a tap that was meant for different settings.
    const shown = state?.share;
    await run(
      async (context) => {
        if (visibility === 'private') {
          const result = await context.mutate(() =>
            api.disableNoteShare(context.remoteId, { signal: context.signal }),
          );
          context.check();
          setState({ ...context.current, share: result.share });
          setHasToken(false);
          await removeNoteShareToken(context.userId, context.remoteId);
          requestSync('manual');
          return;
        }
        if (
          shown
            ? !sameSettings(context.current.share, shown)
            : context.current.share.visibility !== 'private'
        )
          throw new NoteSharingError('reviewSettings');
        const result = await context.mutate(() =>
          api.setNoteShareVisibility(context.remoteId, visibility, domainAllowlist, {
            signal: context.signal,
          }),
        );
        context.check();
        const next = { ...context.current, share: result.share };
        setState(next);
        requestSync('manual');
        if (result.raw_token) {
          await remember(context, result.raw_token);
          if (visibility === 'link') await sendUrl(context, buildNoteShareUrl(result.raw_token));
        } else {
          const token = await loadToken(context.userId, context.remoteId, next);
          context.check();
          setHasToken(Boolean(token));
        }
      },
      { publish: visibility !== 'private', allowPrivate: visibility === 'private' },
    );
  };

  const replaceLink = async (): Promise<void> => {
    await run(
      async (context) => {
        const result = await context.mutate(() =>
          api.replaceNoteShareToken(context.remoteId, { signal: context.signal }),
        );
        context.check();
        setState({ ...context.current, share: result.share });
        requestSync('manual');
        await remember(context, result.raw_token);
        await Clipboard.setStringAsync(
          invitationLink(result.share) ?? buildNoteShareUrl(result.raw_token),
        );
        context.check();
        setMessage(new NoteSharingError('linkReplaced'));
      },
      { publish: true },
    );
  };

  // The server mints a first invitation's link without returning it, so mint it here to keep the
  // full link; otherwise switching to a link share later could only replace it, breaking the emails.
  // Lifting a private note restores paused grants and invitations (listed as `invite:` grants), so
  // only do it when there are none: a request the server then rejects must not reopen them.
  // The grant is checked only after the lift, so a refused grant turns the empty share back off.
  const grantWithFullLink = async (
    context: SharingOperation,
    grant: () => Promise<unknown>,
  ): Promise<void> => {
    const { share, access } = context.current;
    if (share.visibility !== 'private' || access.grants.some((item) => !isScopeGrant(item))) {
      await context.mutate(grant);
      return;
    }
    const lifted = await context.mutate(() =>
      api.setNoteShareVisibility(context.remoteId, 'invited', [], { signal: context.signal }),
    );
    context.check();
    setState({ ...context.current, share: lifted.share });
    requestSync('manual');
    if (lifted.raw_token) await remember(context, lifted.raw_token);
    try {
      await context.mutate(grant);
    } catch (failure) {
      // Only a refusal leaves the grant unmade; an unconfirmed request may have gone through.
      if (failure instanceof ApiError) {
        const restored = await api
          .disableNoteShare(context.remoteId, { signal: context.signal })
          .catch(() => null);
        context.check();
        if (restored) {
          setState((shown) => shown && { ...shown, share: restored.share });
          setHasToken(false);
          await removeNoteShareToken(context.userId, context.remoteId).catch(() => undefined);
        }
      }
      throw failure;
    }
  };

  const linkFor = async (context: SharingOperation): Promise<string> => {
    const invitation = invitationLink(context.current.share);
    if (invitation) return invitation;
    const token = await loadToken(context.userId, context.remoteId, context.current);
    context.check();
    setHasToken(Boolean(token));
    if (!token) throw new NoteSharingError('linkUnavailable');
    return buildNoteShareUrl(token);
  };

  const sendLink = async (destination: 'copy' | 'share' | 'open'): Promise<void> => {
    await run(async (context) => {
      const url = await linkFor(context);
      if (destination === 'copy') {
        await Clipboard.setStringAsync(url);
        context.check();
        setMessage(new NoteSharingError('linkCopied'));
      } else if (destination === 'open') {
        context.release();
        await WebBrowser.openBrowserAsync(url);
      } else await sendUrl(context, url);
    });
  };

  const inviteEmail = async (input: string): Promise<boolean> => {
    const email = input.trim().toLowerCase();
    if (!isValidEmail(email)) {
      setMessage(null);
      setError(new NoteSharingError('invalidEmail'));
      return false;
    }
    return run(
      async (context) => {
        if (
          context.current.access.grants.some(
            (grant) => grant.principal.email?.toLowerCase() === email,
          ) ||
          context.current.invitations.some(
            (invite) => !invite.revoked_at && invite.email.toLowerCase() === email,
          )
        ) {
          throw new NoteSharingError('alreadyInvited');
        }
        await grantWithFullLink(context, () =>
          api.createNoteAccessGrant(
            context.remoteId,
            { principal_type: 'email', email, permission: 'viewer' },
            { signal: context.signal },
          ),
        );
        context.check();
        setMessage(new NoteSharingError('accessGranted'));
        const updated = await adopt(context);
        if (
          updated.invitations.some(
            (invite) =>
              invite.email.toLowerCase() === email && !invite.revoked_at && !invite.last_emailed_at,
          )
        ) {
          setMessage(new NoteSharingError('emailNotSent'));
        }
      },
      { publish: true },
    );
  };

  const addPrincipal = async (principal: AccessPrincipalSuggestion): Promise<void> => {
    await run(
      async (context) => {
        if (
          isGroupPrincipal(principal.type) &&
          !context.current.access.can_manage_inherited_access
        ) {
          throw new NoteSharingError('groupDenied');
        }
        await grantWithFullLink(context, () =>
          api.createNoteAccessGrant(
            context.remoteId,
            {
              principal_type: principal.type,
              ...(principal.id ? { principal_id: principal.id } : { email: principal.email ?? '' }),
              permission: 'viewer',
            },
            { signal: context.signal },
          ),
        );
        context.check();
        await adopt(context);
        setMessage(new NoteSharingError('accessGranted'));
      },
      { publish: true },
    );
  };
  const changeGrant = async (
    grant: NoteAccessGrant,
    permission: NoteAccessGrant['permission'] | null,
  ): Promise<void> => {
    await run(async (context) => {
      const fresh = context.current.access.grants.find((item) => item.id === grant.id);
      if (!fresh) throw new NoteSharingError('accessChanged');
      if (!canChangeGrant(context.current.access, fresh)) {
        if (isScopeGrant(fresh)) throw new NoteSharingError('inheritedManaged');
        throw new NoteSharingError('inheritedDenied');
      }
      if (permission)
        await context.mutate(() =>
          api.updateNoteAccessGrant(context.remoteId, grant.id, permission, {
            signal: context.signal,
          }),
        );
      else
        await context.mutate(() =>
          api.removeNoteAccessGrant(context.remoteId, grant.id, { signal: context.signal }),
        );
      context.check();
      await adopt(context);
    });
  };
  const invitationAction = async (
    invitation: NoteShareInvitation,
    resend: boolean,
  ): Promise<void> => {
    await run(async (context) => {
      if (resend) {
        // A resend only sends email, so a failure never leaves sharing settings unconfirmed.
        try {
          await api.resendNoteInvitation(context.remoteId, invitation.id, {
            signal: context.signal,
          });
        } catch (failure) {
          context.check();
          if (failure instanceof ApiError && failure.status === 502)
            throw new NoteSharingError('sendFailed');
          throw failure;
        }
        context.check();
        setMessage(new NoteSharingError('invitationSent'));
      } else
        await context.mutate(() =>
          api.revokeNoteInvitation(context.remoteId, invitation.id, { signal: context.signal }),
        );
      context.check();
      await adopt(context);
    });
  };

  return {
    state,
    loading,
    busy,
    cancellable,
    error:
      error instanceof NoteSharingError
        ? copy(`noteSharingFeedback.${error.code}`, error.message)
        : error,
    errorCode: error instanceof NoteSharingError ? error.code : null,
    message:
      message instanceof NoteSharingError
        ? copy(`noteSharingFeedback.${message.code}`, message.message)
        : message,
    hasLink: hasToken || Boolean(state && invitationLink(state.share)),
    sharingMode,
    note,
    user,
    refresh: (): Promise<void> => refresh(),
    dismissError: (): void => setError(null),
    setVisibility,
    replaceLink,
    copyLink: (): Promise<void> => sendLink('copy'),
    shareLink: (): Promise<void> => sendLink('share'),
    openLink: (): Promise<void> => sendLink('open'),
    inviteEmail,
    addPrincipal,
    updateGrant: (
      grant: NoteAccessGrant,
      permission: NoteAccessGrant['permission'],
    ): Promise<void> => changeGrant(grant, permission),
    removeGrant: (grant: NoteAccessGrant): Promise<void> => changeGrant(grant, null),
    revokeInvitation: (invitation: NoteShareInvitation): Promise<void> =>
      invitationAction(invitation, false),
    resendInvitation: (invitation: NoteShareInvitation): Promise<void> =>
      invitationAction(invitation, true),
  };
}
