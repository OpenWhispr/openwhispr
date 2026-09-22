# Mobile Note Sharing Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task after implementation is requested. Steps use checkbox syntax. Do not commit or push without explicit user instructions.

**Goal:** Add desktop-compatible note sharing to mobile, with the existing notes website as the recipient experience.

**Architecture:** A native Share sheet consumes the current sharing/access APIs. Existing guarded sync publishes the current note before link creation; account-scoped secure storage preserves tokens. The website and backend remain the sharing authority.

**Tech Stack:** Strict TypeScript, React Native 0.83, Expo 55, Zustand, SQLite/Drizzle, Jest and React Native Testing Library. Use installed Expo Clipboard, SecureStore and WebBrowser plus React Native Share.

**Implementation base:** 2026-09-22; refreshed `OpenWhispr/openwhispr` main at `7991f9e6b08575debbf6f663149b24f0b9107f5e`, branch `feat/mobile-note-sharing`.

**Spec:** [Mobile note sharing design](./2026-09-20-note-sharing-design.md). Approved for implementation on 2026-09-22, including invitations, domains, and permissions in the same delivery.

## Global constraints

- Implementation repository: `OpenWhispr/openwhispr`, with mobile under `openwhispr-mobile/`; implementation base `7991f9e6b08575debbf6f663149b24f0b9107f5e`.
- All mobile `src/`, `app/`, test, and command paths below are relative to `openwhispr-mobile/`. Desktop reference paths are explicitly relative to the combined repository root.
- The plan documents were transferred into the combined repository worktree; implementation uses its current mobile source. No standalone source was overlaid.
- Keep the mobile npm/Metro/Jest boundary intact. No direct imports of root Electron services/types, root dependency installation, or shared-package extraction are required.
- Use Node 24.x and the mobile lockfile/Jest setup. Root npm commands run desktop workflows.
- No new packages, `.env` changes, automatic commits, or pushes.
- Use named exports, explicit return types, no avoidable `any`, and existing design components.
- The two sections below are implementation groupings delivered together, including invitations, domains, and permissions. Native recipient viewing is out of scope.
- Never auto-publish on sheet open, change privacy implicitly, or rotate a token implicitly.
- Preserve identity cancellation, policy enforcement, team/personal sync gates, and concurrent-edit acknowledgements.
- Exact API DTOs must be copied from the inspected desktop/API contract, not reconstructed from guessed endpoint responses. Recheck deployed staging capabilities before implementation.

## Phase 1: links and exports

### Task 1: Typed sharing API and token lifecycle

**Files:**

- Create `src/data/remote/noteSharingApi.ts` and `src/data/remote/noteSharingTypes.ts`.
- Create `src/lib/notes/noteShareTokens.ts` and `src/config/noteSharing.ts`; test viewer configuration in `src/config/__tests__/noteSharing.test.ts`.
- Modify `src/store/useAuthStore.ts` only for account-scoped token cleanup.
- Create `src/data/remote/__tests__/noteSharingApi.test.ts` and `src/lib/notes/__tests__/noteShareTokens.test.ts`.
- Extend `src/store/__tests__/useAuthStore.anonymous.test.ts` for cleanup without losing anonymous-account linking behavior.

**Interfaces:** Preserve server snake_case in DTOs; export these named wrappers:

```ts
export type ShareVisibility = 'private' | 'link' | 'domain' | 'invited';

export interface ShareSettings {
  visibility: ShareVisibility;
  token_prefix: string | null;
  domain_allowlist: string[];
  updated_by_user_id: string | null;
  updated_at: string | null;
}

// ShareStateResponse, ShareMutationResponse, RotateTokenResponse,
// NoteShareInvitation and NoteAccessState follow the inspected desktop DTOs.
// Their exact source is src/services/NoteSharingService.ts and
// src/types/electron.ts at the combined repository root. These are reference
// contracts; do not import Electron modules into the mobile runtime.
export declare function getNoteShareState(remoteId: string): Promise<ShareStateResponse>;
export declare function setNoteShareVisibility(
  remoteId: string,
  visibility: ShareVisibility,
  domainAllowlist: string[],
): Promise<ShareMutationResponse>;
export declare function disableNoteShare(remoteId: string): Promise<{ share: ShareSettings }>;
export declare function replaceNoteShareToken(remoteId: string): Promise<RotateTokenResponse>;
export declare function getNoteAccessState(remoteId: string): Promise<NoteAccessState>;
export declare function readNoteShareToken(
  userId: string,
  remoteId: string,
): Promise<string | null>;
export declare function saveNoteShareToken(
  userId: string,
  remoteId: string,
  token: string,
): Promise<void>;
export declare function removeNoteShareToken(userId: string, remoteId: string): Promise<void>;
export declare function clearNoteShareTokens(userId: string): Promise<void>;
export declare function buildNoteShareUrl(token: string): string;
```

- [ ] Add endpoint tests using the existing `billingApi.test.ts` mocking pattern. Assert path encoding, verbs/body, nullable raw tokens, 204 deletes where applicable, error propagation, and access fallback only on explicit 404.
- [ ] Implement wrappers through `api`; use `/api/notes/${encodeURIComponent(remoteId)}/share` and `/access`. No alternate fetch/auth stack.
- [ ] Add secure-storage tests for account isolation, malformed token rejection, prefix mismatch, deletion/index cleanup, storage failure, and account change during writes. Serialize index changes so simultaneous note operations cannot lose keys. Pending writes must not recreate secrets after logout cleanup.
- [ ] Configure the viewer base through proposed `EXPO_PUBLIC_NOTES_URL`. Default to `https://notes.openwhispr.com` only with the production API. A custom `EXPO_PUBLIC_API_URL` requires an explicit viewer URL before generating/copying/opening a share link. Accept HTTPS, plus HTTP loopback for local development; reject credentials/query/fragment in the configured base. Test defaults, custom pairing, invalid bases, and URL construction without live tokens. Document in mobile `CONTRIBUTING.md` without modifying `.env` files. Invitation emails still use the backend's `SHARE_VIEWER_BASE_URL`, which must match the same environment.
- [ ] Implement the token store with account/remote-note keys and an account key index. Use the observed full-token regex `^ow_share_[A-Za-z0-9_-]{32}$`; never construct a public URL from a prefix. Keep tokens out of exception payloads.
- [ ] Wire cleanup to sign-out/delete/account transitions without modifying the existing anonymous-linking semantics. Revalidate token availability against fresh share state each time; do not add token fields to the sync payload.
- [ ] Run `npm test -- --runInBand src/data/remote/__tests__/noteSharingApi.test.ts src/lib/notes/__tests__/noteShareTokens.test.ts src/store/__tests__/useAuthStore.anonymous.test.ts` and `npm run typecheck`.

Representative API test:

```ts
jest.mock('@/lib/apiClient', () => ({
  api: { get: jest.fn(), patch: jest.fn(), post: jest.fn(), delete: jest.fn() },
}));
import { api } from '@/lib/apiClient';
import { setNoteShareVisibility } from '../noteSharingApi';

it('sets link visibility through the authenticated API', async (): Promise<void> => {
  const response = { share: { visibility: 'link' }, raw_token: null };
  jest.mocked(api.patch).mockResolvedValueOnce(response);
  await expect(setNoteShareVisibility('note/id', 'link', [])).resolves.toEqual(response);
  expect(api.patch).toHaveBeenCalledWith('/api/notes/note%2Fid/share', {
    visibility: 'link',
    domain_allowlist: [],
  });
});
```

### Task 2: Await the correct note revision through existing sync

**Files:**

- Modify `src/sync/syncEngine.ts`.
- Create `src/sync/ensureNoteSynced.ts` and `src/sync/__tests__/ensureNoteSynced.test.ts`.
- Extend `src/sync/__tests__/syncEngine.test.ts` and `src/sync/__tests__/syncSecurity.test.ts`; cover sharing interactions in `src/sync/__tests__/privateNoteDeletion.test.ts` and `src/store/__tests__/useNotesStore.privacy.test.ts`.
- Reuse `src/sync/createSyncContext.ts`, `src/sync/pushNotes.ts`, and existing repository snapshot acknowledgements.

**Interface:**

```ts
export declare function ensureNoteSynced(
  noteId: number,
  options: { signal: AbortSignal; timeoutMs?: number },
): Promise<string>; // resolved remote UUID, never local integer ID
```

The operation requests a manual pass, joins the existing serialized pipeline including queued follow-up passes, and resolves only after reading a ready row from the repository. Default timeout: 30 seconds. Keep `requestSync(reason): void` compatible for existing callers. Cancellation/timeout stops waiting and publishing; it does not cancel unrelated background sync.

- [ ] Write tests for new unsynced notes, already-synced notes, edits during upload, a pre-existing in-flight pass, missing remote ID, dirty transcript, conflict, deletion/folder hold, lost space access, account switch, privacy change, offline timeout, subscription gates, and independent team sync eligibility.
- [ ] Add a completion/subscription seam inside the sync engine that signals settled passes even on early gates/errors. Subscribe before scheduling manual sync so a fast pass cannot be missed. Do not expose `runSyncNow` as an unguarded second entry point.
- [ ] Implement a bounded readiness waiter using repository re-reads after pass completion. Resolve only with matching account/note identity, `remoteId`, cleared `pendingSync`, no dirty transcript, and no conflict/deletion/folder hold. Return actionable failures rather than treating global idle as success.
- [ ] Preserve existing snapshot comparison when uploads acknowledge newer local edits. Never clear pending flags in the waiter.
- [ ] Preserve the imported `privateNoteDeletion.ts` / `noteCreateAttempts.ts` flow: opt-out retains IDs until confirmed cleanup; re-enable generates fresh IDs and queues the retired copy. Bind the waiter to current account/client/remote identity, abort on privacy changes, and never use a remote ID retained only for deletion as publication readiness. Failure to clean up an unrelated retired copy must not block an eligible current copy.
- [ ] Preserve transcript metadata via the current `serializeSegmentsForSync(..., originalRaw)` path and run `src/lib/notes/__tests__/remoteTranscript.test.ts` plus `src/data/synced/__tests__/SyncedNotesRepository.transcriptSync.test.ts` with the sync regression suite.
- [ ] Keep settings reads/revocation independent of this readiness barrier; only publishing current content needs it.
- [ ] Run `npm test -- --runInBand src/sync/__tests__/ensureNoteSynced.test.ts src/sync/__tests__/syncEngine.test.ts src/sync/__tests__/syncSecurity.test.ts src/sync/__tests__/pushNotes.test.ts src/data/local/__tests__/notesRepository.pushAck.test.ts`.

Required concurrent-edit regression sequence:

| Step | Input/event                                       | Required assertion                                                  |
| ---- | ------------------------------------------------- | ------------------------------------------------------------------- |
| 1    | Start waiting while revision A uploads            | Promise remains pending                                             |
| 2    | Edit to revision B, then acknowledge A            | Repository still has B with `pendingSync=1`; waiter remains pending |
| 3    | Complete the queued upload of B                   | Waiter resolves with the remote UUID; no edits are lost             |
| 4    | Repeat with account switch before acknowledgement | Waiter rejects and no share mutation is sent                        |

### Task 3: Share controller and native sheet

**Files:**

- Create `src/hooks/useNoteSharing.ts` and `src/hooks/__tests__/useNoteSharing.test.ts`.
- Create `src/components/notes/NoteShareSheet.tsx` and `src/components/notes/__tests__/NoteShareSheet.test.tsx`.
- Reuse `src/components/ui/{Text,Button,SystemIcon,GlassIconButton}.tsx`, `src/components/notes/MoveToFolderSheet.tsx` composition, `src/lib/accountAccess.ts`, and installed clipboard/browser APIs.

**Component contract:**

```ts
export interface NoteShareSheetProps {
  noteId: number;
  visible: boolean;
  onClose: () => void;
  onFlushDraft: () => void;
  onExport: (format: 'md' | 'txt') => void;
}
```

The hook owns the fetch/mutation state; the component renders it. Keep per-sheet state scoped to account and note. Reuse fresh server settings and stored tokens rather than storing redundant `isShared` flags in SQLite.

- [ ] Test that opening only reads; Create flushes and awaits sync before PATCH; Copy/Open/Share never rotate; explicit Replace invalidates the old token; Disable succeeds even when the draft conflicts; failed mutations preserve confirmed state; and logout/note switch ignores late responses.
- [ ] Implement Create → persist returned token → OS Share, and separate Copy/Open operations. Refresh settings before using cached tokens. If a timeout leaves a mutation outcome unknown, re-read settings before offering retry; never blindly repeat rotation/invitations.
- [ ] Use React Native `Share.share` with `url` on iOS and URL text on Android. Preserve successful publication if the user cancels the OS sheet or local clipboard/storage fails. Show a recoverable copy/storage error without automatically changing access again.
- [ ] Show explicit Create link/Replace link/Disable external sharing copy from the design. Unknown/error states disable mutations and show Retry. Existing invited/domain modes remain intact in Phase 1.
- [ ] Add account/cloud-sync prerequisite actions using existing app flows. After any prerequisite transition, require the user to invoke publication again; do not resume a stale pending publish automatically.
- [ ] Reconcile after mutations using normal sync. Test post-share content editing against the staging API because sharing changes server `updated_at`; retain real conflict resolution and treat false metadata-only conflicts as a release blocker requiring a focused API decision.
- [ ] Test opt-out with an open Share sheet, a lost create acknowledgement, pending deletion offline, and re-enabling sync under a fresh identity. Clear the retired identity's token from active UI/storage; do not mistake local token removal for server revocation. Display cleanup pending until confirmed, and never let an old request restore an old link after republishing.
- [ ] Test OS cancellation, offline errors, permission/policy rejection, loading tap suppression, accessibility labels, and export availability when sharing is unavailable.
- [ ] Run `npm test -- --runInBand src/hooks/__tests__/useNoteSharing.test.ts src/components/notes/__tests__/NoteShareSheet.test.tsx` and `npm run typecheck`.

### Task 4: Wire the editor and preserve exports

**Files:**

- Modify `src/screens/NoteEditorScreen.tsx` and only the necessary props in `src/components/notes/NoteActionsMenu.tsx`.
- Extend `src/screens/__tests__/NoteEditorScreen.conflictBanner.test.tsx` with editor sharing regressions, reusing its screen fixture.
- Preserve `src/lib/noteExport.ts` and `src/lib/__tests__/noteExport.test.ts` unless a concrete export integration change requires editing them.

- [ ] Add editor tests that type and immediately share before 800 ms, change only title, navigate between notes, and share a meeting with structured transcript. Assert the flushed body/title match the editor and transcript structure stays intact.
- [ ] Extract a synchronous `flushDraft` callback from the current debounce/unmount save logic: cancel timer, compare refs to saved baselines, persist changed fields through `updateNote`, and retain existing correction-learning/segment guards. Reuse it for share and unmount so two save implementations do not diverge.
- [ ] Route the existing `onShare` to the new sheet. Replace the export-only action sheet with two export actions that call `exportNote` and `buildNoteShareContent` directly, which also avoids introducing an iOS-only chooser into the new Android flow.
- [ ] Preserve summary/original view export content and formatted speaker transcript; link publication always uses the actual synced note fields. Retain recording/processing restrictions and ensure an already-shared empty note can still expose revocation controls.
- [ ] Run `npm test -- --runInBand src/screens/__tests__/NoteEditorScreen.conflictBanner.test.tsx src/screens/__tests__/NoteEditorScreen.calendarContext.test.tsx src/lib/__tests__/noteExport.test.ts`.

## Phase 2: remaining desktop access controls

### Task 5: Invitations, domain sharing, and grants

**Files:**

- Extend `src/data/remote/noteSharingApi.ts`, `src/data/remote/noteSharingTypes.ts`, and their tests.
- Extend `src/hooks/useNoteSharing.ts` and its tests.
- Create `src/components/notes/NoteShareAccessList.tsx` and `src/components/notes/__tests__/NoteShareAccessList.test.tsx`.
- Extend `src/components/notes/NoteShareSheet.tsx` and tests.
- Create `src/lib/notes/noteShareDomains.ts` and its tests, using desktop's repository-root `src/utils/personalEmailDomains.ts` rules.

**Additional named API wrappers:** `searchNoteAccessPrincipals(remoteId, query)`, `createNoteAccessGrant(remoteId, input)`, `updateNoteAccessGrant(remoteId, grantId, permission)`, `removeNoteAccessGrant(remoteId, grantId)`, `inviteNoteEmails(remoteId, emails)`, `revokeNoteInvitation(remoteId, invitationId)`, and `resendNoteInvitation(remoteId, invitationId)`. Give each the exact request/result types from desktop `NoteSharingService.ts`; permissions are `editor | viewer`, not `owner`.

- [ ] Add request tests for all endpoints in the design contract and controller tests for stale principal searches, case-insensitive duplicate invitations, partial email delivery failure, 60-second resend cooldown, and private-to-invited promotion.
- [ ] Implement the wrappers and a debounced principal search. Keep typed email invitation fallback only for the verified legacy ACL-404 case; never fall back after authorization/policy failures.
- [ ] Render General access with `private`, `link`, `invited`, and eligible business-domain mode. Do not broaden access just to obtain a copyable token. Reuse the explicit replacement workflow when the full token is missing.
- [ ] Render People with access using authoritative access state. Mark inherited and pending entries; gate each action by `can_manage_access` / `can_manage_inherited_access`. Refresh after mutations, and avoid duplicate invitation/grant rows for the same email.
- [ ] Implement grant role changes/removal, invitation revoke/resend, and actionable delivery/cooldown feedback. Changing external visibility to private must not claim that all team access or stored grant records were deleted.
- [ ] Test API rejections even when the UI previously allowed a control, including archived spaces and `POLICY_SHARING_BLOCKED` / `POLICY_UNRESOLVABLE`.
- [ ] Run all sharing tests plus `npm run typecheck` and `npm run lint`.

## Task 6: cross-device acceptance and release verification

**Files:** Update this plan with evidence and add the final supported behavior to `README.md` if product documentation belongs there. No backend/web implementation is included without a demonstrated contract gap.

- [ ] Before implementation setup, use Node 24 from mobile `.nvmrc` and read `openwhispr-mobile/CONTRIBUTING.md` plus `.github/workflows/mobile-ci.yml`. Tell the user before installing existing dependencies. Match CI: `npm ci --ignore-scripts --no-audit --no-fund`, then `node_modules/.bin/patch-package --error-on-fail`, then `npm rebuild better-sqlite3`, all from the mobile directory. Preserve the secure UUID implementation and `jest.setup.js`.
- [ ] On a staging account with disposable notes, create a desktop public link; open the corresponding mobile note and verify state. If token absent, confirm mobile offers Replace rather than rotating on open. Repeat mobile → desktop.
- [ ] Verify Create/Copy/Share/Open, replace invalidation, disable invalidation, content updates, unsynced drafts, existing conflicts, privacy opt-out during upload, account switch, and no-account/offline export on iOS. Keep Android-compatible sharing/export paths; Android runtime acceptance is deferred until it becomes an active release target, matching the imported repository policy.
- [ ] Verify viewer behavior signed out and signed in: public links, invited email, wrong email, unverified email, allowed/blocked domain, deleted note, and restrictive organization policy. Browser sessions are separate from mobile sessions; do not transfer cookies through links.
- [ ] Check the next content edit after every sharing mutation. Record whether server metadata timestamps produce a false conflict; resolve that contract issue before releasing if reproducible.
- [ ] Test guest/read-only viewing does not grant sharing-management rights. Re-sharing the same URL must retain the same access conditions.
- [ ] Run the imported mobile CI checks from `openwhispr-mobile/`: `npm run test --ignore-scripts -- --ci --runInBand`, `npm run typecheck`, `npm run lint`, `npm run format`, and `npm run doctor`. Match CI environment values `CI=true`, `EXPO_NO_DOTENV=1`, and `SENTRY_DISABLE_AUTO_UPLOAD=true`.
- [ ] Verify development/production configs with `OPENWHISPR_APP_ENV=development node_modules/.bin/expo config --type public` and the production equivalent; keep generated config out of public artifacts. Run `OPENWHISPR_APP_ENV=production node_modules/.bin/expo export --platform ios --max-workers 2 --output-dir /tmp/openwhispr-note-sharing-export` using a fresh output directory. Do not claim a JavaScript bundle verifies native signing/compilation or Android runtime behavior.
- [ ] Match Mobile CI's lockfile checks: `node_modules/.bin/lockfile-lint --path package-lock.json --type npm --validate-https --allowed-hosts npm --validate-integrity` and `npm audit --package-lock-only --ignore-scripts --audit-level=high`. All credentials/live accounts stay out of unit tests; manual hosted acceptance runs separately. Desktop tests are additionally required if root desktop/shared files are changed; preserve existing Mobile CI and CodeQL path routing.
- [ ] Record baseline failures separately from new failures; do not expand scope into unrelated fixes. Verify no tokens, invitee data, or shared note content appear in telemetry.
- [ ] Review the final diff with code-quality and design-quality. Deliver links and access controls together; cross-device acceptance remains required before claiming release parity.

## Planning verification

Only these two Markdown documents were added. No application code, dependencies, API state, or public notes were changed. Tests were inventoried and their commands included; no application test baseline was run in the dependency-free planning worktree. Verify Markdown formatting, diff whitespace, branch/base, and document links before handoff.

## Migration review verification — 2026-09-21

Fetched the combined repository's main reference and inspected its merged import, contributor guide, separate package/lockfile boundary, Mobile CI/CodeQL routing, privacy deletion/create recovery, transcript serialization, and existing test targets. Compared the plan's key mobile modules with the original base and confirmed the desktop share dialog/service/domain helper did not change. API/web repositories were not relocated or revalidated against production in this review.

The two existing plan documents were revised in place. No application source, worktree registration, branch, dependency, credential, or deployment was changed. No application tests were needed or run for this documentation review; final checks cover formatting, referenced existing files, and whitespace.

## Implementation evidence — 2026-09-22

Implemented the typed API and account-scoped token cache, native share/access sheet, guarded sync readiness, immediate draft flush, invitations, business-domain restrictions, direct viewer/editor grants, and existing file exports. No new package, schema migration, root desktop change, backend change, environment edit, commit, or push was made.

The original checklist above records acceptance criteria; unchecked live scenarios remain manual acceptance work rather than a claim they ran. The implementation reuses editor fixtures instead of duplicating a sharing screen test harness. The existing `sync_state` table records rejected note pushes so a cleared pending flag cannot be mistaken for a successful upload. Legacy failed uploads from before this marker cannot be distinguished retrospectively.

Focused regressions cover lost/late responses, privacy/account changes, inherited read-only access, invite delivery feedback, token replacement and storage failure, queued sync runs, current draft uploads, and structured transcript preservation. A real SQLite pull/push test verifies that a sharing revision pulled normally becomes the next content update base. Source inspection revalidated the local desktop and API contracts; it does not establish which backend version is deployed.

### Remaining release acceptance

- Run disposable-account desktop ↔ mobile links and recipient authorization checks on staging, including invited email, wrong/unverified email, permitted/blocked domain, and organization policy.
- Validate native iOS sharing, clipboard, browser, keyboard/layout, dark mode, and accessibility on device. A production JavaScript export does not verify native compilation/signing or OS sheet behavior. Android runtime acceptance remains deferred by the repository’s release policy.
- Backend versioning limitation: external-share revocation stays available while content is dirty or conflicted. Because the backend advances the content version for sharing metadata, a dirty local note may subsequently park a conflict even if content was unchanged remotely. The app preserves local edits and requires explicit conflict resolution; it never stamps the share timestamp as a content acknowledgement. Normal publication waits for an actual sync pull of the new revision. Removing this edge case requires a separate backend content-version contract, rather than bypassing conflict protection in mobile.

### Verification record

- Full Jest suite: **175 suites, 1,675 tests passed**.
- TypeScript: passed. ESLint: passed with zero errors; repository warnings remain.
- Expo Doctor: **20/20 checks passed**; dependency compatibility and development/production config checks passed.
- Production iOS JavaScript export: passed. Native app compilation and device acceptance were not run.
- Lockfile HTTPS/integrity validation: passed. Dependency audit met the high/critical threshold; **16 moderate advisories** remain in the unchanged dependency tree.
- Diff whitespace checks: passed. Formatting checked after the final documentation update.
- Code-quality/OSS review blockers addressed: uncertain mutation state, failed access refresh, legacy/private old-link revocation, and email delivery feedback. The backend versioning limitation above remains.

No live note was published during automated testing.
