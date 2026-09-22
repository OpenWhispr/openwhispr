import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform, Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import { notesRepository, type Note } from '@/data';
import { ApiError } from '@/lib/apiClient';
import type { AuthUser } from '@/lib/authClient';
import { getNoteShareViewerBaseUrl } from '@/config/noteSharing';
import { useAuthStore } from '@/store/useAuthStore';
import { useNotesStore } from '@/store/useNotesStore';
import * as api from '@/data/remote/noteSharingApi';
import type {
  ShareStateResponse,
  ShareVisibility,
  NoteAccessGrant,
  NoteShareInvitation,
  AccessPrincipalSuggestion,
} from '@/data/remote/noteSharingTypes';
import {
  buildNoteShareUrl,
  readNoteShareToken,
  saveNoteShareToken,
  removeNoteShareToken,
} from '@/lib/notes/noteShareTokens';
import { canChangeGrant, isGroupPrincipal } from '@/lib/notes/noteShareAccess';
import { ensureNoteSynced } from '@/sync/ensureNoteSynced';
import { requestSync } from '@/sync/syncEngine';

export interface NoteSharingController {
  state: ShareStateResponse | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  message: string | null;
  hasToken: boolean;
  note: Note | undefined;
  user: AuthUser | null;
  refresh: () => Promise<void>;
  setVisibility: (visibility: ShareVisibility, domainAllowlist?: string[]) => Promise<void>;
  replaceLink: () => Promise<void>;
  copyLink: () => Promise<void>;
  shareLink: () => Promise<void>;
  openLink: () => Promise<void>;
  inviteEmail: (email: string) => Promise<void>;
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

function sharingError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  if (code === 'POLICY_SHARING_BLOCKED' || code === 'POLICY_UNRESOLVABLE') {
    return 'Sharing is restricted by your organization.';
  }
  if (code === 'ACCOUNT_REQUIRED') return 'Sign in to an account to share notes.';
  if (code === 'email_verification_required') return 'Verify your email before inviting people.';
  if (code === 'resend_cooldown') return 'Please wait a minute before resending.';
  return error instanceof Error ? error.message : 'Unable to update sharing. Please try again.';
}

export function useNoteSharing(
  noteId: number,
  visible: boolean,
  onFlushDraft: () => void,
): NoteSharingController {
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
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [hasToken, setHasToken] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const loadRequest = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const previousIdentity = useRef<{ userId: string; remoteId: string } | null>(null);

  const loadToken = useCallback(
    async (remoteId: string, current: ShareStateResponse): Promise<string | null> => {
      if (!user) return null;
      const token = await readNoteShareToken(user.id, remoteId);
      if (
        current.share.visibility === 'private' ||
        !token ||
        !current.share.token_prefix ||
        !token.startsWith(current.share.token_prefix)
      ) {
        if (token) await removeNoteShareToken(user.id, remoteId);
        return null;
      }
      return token;
    },
    [user],
  );

  const refresh = useCallback(async (): Promise<void> => {
    if (operation.current) return;
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
    setState(null);
    setError(null);
    setHasToken(false);
    if (!visible || !user || user.isAnonymous || !local?.remoteId || local.deletedAt) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      controller.abort();
      if (loadRequest.current === controller) {
        setLoading(false);
        setError('Sharing settings timed out. Check your connection and retry.');
      }
    }, 30_000);
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    try {
      const current = await api.getNoteShareState(local.remoteId, { signal: controller.signal });
      if (!valid()) return;
      const token = local.isPrivate === 1 ? null : await loadToken(local.remoteId, current);
      if (!valid()) return;
      setState(current);
      setHasToken(Boolean(token));
    } catch (failure) {
      if (valid()) setError(sharingError(failure));
    } finally {
      clearTimeout(timer);
      if (loadRequest.current === controller) setLoading(false);
    }
  }, [visible, user, cookie, noteId, loadToken]);

  useEffect(() => {
    generation.current += 1;
    operation.current?.abort();
    operation.current = null;
    setBusy(false);
    setMessage(null);
    refresh();
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active' && visible) refresh();
    });
    return (): void => {
      generation.current += 1;
      operation.current?.abort();
      loadRequest.current?.abort();
      subscription.remove();
    };
  }, [refresh, visible, note?.isPrivate, note?.clientNoteId]);

  useEffect(() => {
    const previous = previousIdentity.current;
    if (
      previous &&
      (previous.userId !== user?.id ||
        previous.remoteId !== note?.remoteId ||
        note?.isPrivate === 1)
    ) {
      removeNoteShareToken(previous.userId, previous.remoteId).catch(() => undefined);
      setHasToken(false);
    }
    if (previous && previous.userId === user?.id && previous.remoteId !== note?.remoteId) {
      generation.current += 1;
      operation.current?.abort();
      operation.current = null;
      setBusy(false);
      refresh();
    }
    previousIdentity.current =
      user && note?.remoteId ? { userId: user.id, remoteId: note.remoteId } : null;
  }, [user, note?.remoteId, note?.isPrivate, refresh]);

  const run = async (
    task: (context: SharingOperation) => Promise<void>,
    { publish = false, allowPrivate = false }: RunOptions = {},
  ): Promise<void> => {
    if (operation.current || !visible) return;
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
        setError('Sharing timed out. Refresh settings to check whether the change completed.');
      }
    }, 60_000);
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    const release = (): void => {
      clearTimeout(timer);
      if (operation.current === controller) {
        operation.current = null;
        setBusy(false);
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
        throw new Error('Sharing cancelled because the account or note changed.');
      }
      if (!auth.user || auth.user.isAnonymous)
        throw new Error('Sign in to an account to share notes.');
      if (!current || current.deletedAt) throw new Error('This note is no longer available.');
      if (current.isPrivate === 1 && !allowPrivate)
        throw new Error('Enable cloud sync for this note before sharing.');
    };
    try {
      check();
      let remoteId = original?.remoteId;
      if (publish) {
        getNoteShareViewerBaseUrl();
        onFlushDraft();
        remoteId = await ensureNoteSynced(noteId, { signal: controller.signal });
        check();
      }
      if (!remoteId || !user) throw new Error('Sync this note before sharing.');
      const current = await api.getNoteShareState(remoteId, { signal: controller.signal });
      check();
      setState(current);
      if (current.access?.can_manage_access === false)
        throw new Error('You do not have permission to manage sharing.');
      const mutate = async <Result>(request: () => Promise<Result>): Promise<Result> => {
        try {
          return await request();
        } catch (failure) {
          check();
          if (!(failure instanceof ApiError) || failure.status >= 500) {
            setState(null);
            setHasToken(false);
            throw new Error(
              'The sharing change could not be confirmed. Refresh settings before trying again.',
            );
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
    } catch (failure) {
      if (!controller.signal.aborted && version === generation.current)
        setError(sharingError(failure));
    } finally {
      release();
    }
  };

  const adopt = async (context: SharingOperation): Promise<ShareStateResponse> => {
    let current: ShareStateResponse;
    try {
      current = await api.getNoteShareState(context.remoteId, { signal: context.signal });
      context.check();
    } catch {
      context.check();
      setState(null);
      setMessage(null);
      throw new Error(
        'Sharing changed, but the updated settings could not be loaded. Refresh to continue.',
      );
    }
    setState(current);
    requestSync('manual');
    return current;
  };
  const sendUrl = async (context: SharingOperation, url: string): Promise<void> => {
    context.release();
    await Share.share(
      Platform.OS === 'ios' ? { url, title: note?.title } : { message: url, title: note?.title },
    );
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
    const shown = state?.share.visibility ?? 'private';
    return run(
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
        if (context.current.share.visibility !== shown)
          throw new Error('Sharing settings changed. Review them and try again.');
        getNoteShareViewerBaseUrl();
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
          const token = await loadToken(context.remoteId, next);
          context.check();
          setHasToken(Boolean(token));
        }
      },
      { publish: visibility !== 'private', allowPrivate: visibility === 'private' },
    );
  };

  const replaceLink = async (): Promise<void> =>
    run(
      async (context) => {
        getNoteShareViewerBaseUrl();
        const result = await context.mutate(() =>
          api.replaceNoteShareToken(context.remoteId, { signal: context.signal }),
        );
        context.check();
        setState({ ...context.current, share: result.share });
        requestSync('manual');
        await remember(context, result.raw_token);
        await Clipboard.setStringAsync(buildNoteShareUrl(result.raw_token));
        context.check();
        setMessage('New link copied. The previous link no longer works.');
      },
      { publish: true },
    );

  const sendLink = async (destination: 'copy' | 'share' | 'open'): Promise<void> =>
    run(async (context) => {
      const token = await loadToken(context.remoteId, context.current);
      context.check();
      setHasToken(Boolean(token));
      if (!token)
        throw new Error(
          'The link is unavailable on this device. Choose Replace link to create a new one.',
        );
      const url = buildNoteShareUrl(token);
      if (destination === 'copy') {
        await Clipboard.setStringAsync(url);
        context.check();
        setMessage('Link copied.');
      } else if (destination === 'open') {
        context.release();
        await WebBrowser.openBrowserAsync(url);
      } else await sendUrl(context, url);
    });

  const inviteEmail = async (input: string): Promise<void> =>
    run(
      async (context) => {
        const email = input.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
          throw new Error('Enter a valid email address.');
        if (
          context.current.access?.grants.some(
            (grant) => grant.principal.email?.toLowerCase() === email,
          ) ||
          context.current.invitations.some(
            (invite) => !invite.revoked_at && invite.email.toLowerCase() === email,
          )
        ) {
          throw new Error('This person already has access or an invitation.');
        }
        if (context.current.access) {
          await context.mutate(() =>
            api.createNoteAccessGrant(
              context.remoteId,
              { principal_type: 'email', email, permission: 'viewer' },
              { signal: context.signal },
            ),
          );
          context.check();
          setMessage('Access granted.');
        } else {
          const result = await context.mutate(() =>
            api.inviteNoteEmails(context.remoteId, [email], {
              signal: context.signal,
            }),
          );
          context.check();
          setMessage(
            result.email_failed_ids.length
              ? 'Invitation saved, but email delivery failed. Use Resend to try again.'
              : result.already_invited.length
                ? 'This person is already invited.'
                : 'Invitation sent.',
          );
        }
        const updated = await adopt(context);
        if (
          context.current.access &&
          updated.invitations.some(
            (invite) =>
              invite.email.toLowerCase() === email && !invite.revoked_at && !invite.last_emailed_at,
          )
        ) {
          setMessage(
            'Access granted, but the invitation email was not sent. Use Resend to try again.',
          );
        }
      },
      { publish: true },
    );

  const addPrincipal = async (principal: AccessPrincipalSuggestion): Promise<void> =>
    run(
      async (context) => {
        if (
          isGroupPrincipal(principal.type) &&
          !context.current.access?.can_manage_inherited_access
        ) {
          throw new Error('You do not have permission to manage group access.');
        }
        await context.mutate(() =>
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
        setMessage('Access granted.');
      },
      { publish: true },
    );
  const changeGrant = async (
    grant: NoteAccessGrant,
    permission: NoteAccessGrant['permission'] | null,
  ): Promise<void> =>
    run(async (context) => {
      const fresh = context.current.access?.grants.find((item) => item.id === grant.id);
      if (!fresh) throw new Error('Access changed. Refresh and try again.');
      if (!canChangeGrant(context.current.access, fresh)) {
        if (fresh.id.startsWith('scope:'))
          throw new Error('Inherited access is managed in its team or space.');
        throw new Error('You do not have permission to change inherited access.');
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
  const invitationAction = async (
    invitation: NoteShareInvitation,
    resend: boolean,
  ): Promise<void> =>
    run(async (context) => {
      if (resend) {
        // A resend only sends email, so a failure never leaves sharing settings unconfirmed.
        try {
          await api.resendNoteInvitation(context.remoteId, invitation.id, {
            signal: context.signal,
          });
        } catch (failure) {
          context.check();
          if (failure instanceof ApiError && failure.status === 502)
            throw new Error('The invitation email could not be sent. Try again later.');
          throw failure;
        }
        context.check();
        setMessage('Invitation sent.');
      } else
        await context.mutate(() =>
          api.revokeNoteInvitation(context.remoteId, invitation.id, { signal: context.signal }),
        );
      context.check();
      await adopt(context);
    });

  return {
    state,
    loading,
    busy,
    error,
    message,
    hasToken,
    note,
    user,
    refresh,
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
