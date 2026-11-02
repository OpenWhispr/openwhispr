# Local model allow list admin implementation plan

> **For agentic workers:** Use `superpowers:executing-plans` after approval, task by task. Track checkboxes. Do not commit or push unless separately authorized.

**Execution status (2026-11-02):** All three tasks are implemented on `feat/local-model-allow-list` in the isolated admin worktree and passed task/final review. Browser run: 101 passed, two flag-dependent skips, one locator failure subsequently fixed and verified by four targeted tests. TypeScript, lint and changed-file formatting pass. The reviewed floor is **1.11.1**; `NEXT_PUBLIC_LOCAL_MODEL_POLICY_ENABLED` defaults off until the release is qualified. Staging/native-device QA and deployment remain separate.

**Goal:** Let admins approve local speech/AI text models and require approved speech downloads in one safe save.

**Architecture:** Replace the required-model card with a combined approval card, retain existing full-document optimistic saves, and give each card exclusive ownership of its fields. Gate editing on explicit API support and a released enforcing desktop.

**Tech stack:** Next.js/React, TypeScript, Zod, TanStack Query, existing UI components and Playwright mocked-API tests.

**Spec:** [Approved local models](../specs/2026-11-02-local-model-allow-list-design.md). Paths are relative to `OpenWhispr/openwhispr-admin`. Verified base: `b06de60423e8508a874bbcd3969cd9b5a2dbc7f1`; the local primary checkout has unrelated changes and must not be used as the source of current behavior.

## Global constraints

- No new dependencies; reuse existing form controls, `PolicyCard`, `ConfirmDialog` and unsaved-change protection.
- Blank admin selection serializes `null`; API effective `[]` is never interpreted as allow-all.
- Approval/required edits are atomic; unapproving speech clears its Require switch.
- Saved Local mode determines disabled controls; dormant approvals survive mode changes.
- Provider-card saves preserve current model approvals; model-card saves preserve mode/provider fields.
- No environment-file edits, branch creation, commits, pushes or deployment included.
- Use the actual first enforcing desktop release for `LOCAL_MODEL_POLICY_MIN_VERSION`; do not reuse 1.11.0.

## Review focus

1. Saving a previously opened provider card must not overwrite new model approvals (Task 1).
2. An older API must not appear to accept unsupported restrictions (Tasks 1–2).
3. Unknown/legacy saved IDs must remain visible and recoverable (Task 2).
4. Clearing the last approved checkbox must visibly mean Allow all before Save (Task 2).
5. Raising the floor affects members; stale timestamps and failures must leave the confirmation/draft intact (Task 3).

## Task 1: Schema, capabilities and safe card ownership

**Files:** Modify `lib/policy-schema.ts`, `lib/hooks/{use-policy,use-policy-section}.ts`, `components/console/policy/provider-policy-cards.tsx`. Create `e2e/local-model-policy.spec.ts` using `e2e/audio-feature-controls.spec.ts`'s mocked API setup.

**Interfaces:**

- Mirror `allowedLocalModels: string[] | null` and defaults in both policy scopes; expand required enum to the API's 15 speech IDs.
- `PolicyState.localModelPolicyVersion?: number` comes from API GET and successful PUT; only version 1 enables editing. Assert editing stays enabled after the PUT response replaces query data.
- `usePolicySection` additionally returns `saveError: ApiError | Error | null`; retain existing save result/toasts and optional generic error handling. Clear errors on retry/reset; preserve errors on failed save.
- Provider cards select/apply only `allowedModes`, `allowedByokProviders`, `allowedEnterpriseProviders`, spreading the latest `base.transcription` / `base.llm` on apply.

- [ ] Add Playwright fixtures for current API, legacy API, null policy, and seeded restricted policy. Record request bodies and revisions. Add assertions for schema defaults and preservation of absent-versus-explicit values through the actual browser save path.
- [ ] Add a regression: edit a provider card, deliver a refreshed saved policy containing a different approved-model list through the mocked API, then save the still-mounted provider card. Both changes must survive. Cover both scopes. In Task 2, repeat with a real models-card save in the same page and reverse the order. Assert unrelated dirty cards do not save their drafts accidentally.
- [ ] Add API-failure and code-less/coded 409 cases, checking inline error versus actual concurrency conflict behavior. A delayed save from another workspace must not update the current workspace's draft.
- [ ] Run `npm run test:e2e -- e2e/local-model-policy.spec.ts` and establish the missing-behavior failures.
- [ ] Add schema/capability fields and narrow card selection/application. Extend `usePolicySection` without changing the semantics of other cards. Preserve existing conflict invalidation and manual reset/review flow.
- [ ] Rerun the new suite and existing `e2e/audio-feature-controls.spec.ts`, plus `npm run check`.

## Task 2: Combined on-device models card

**Files:** Replace `components/console/policy/required-models-policy-card.tsx` with `components/console/policy/local-models-policy-card.tsx`; modify `app/(console)/policies/providers/page.tsx`, `lib/local-model-catalog.ts`, and `e2e/local-model-policy.spec.ts`.

**Interfaces:**

- Export `LocalModelsPolicyCard({ workspaceId }: { workspaceId: string })`.
- Its slice is `{ transcription: string[] | null; llm: string[] | null; requiredLocalModels: string[] }`; apply only those three fields to the latest base.
- Catalog entries contain `id`, `name`, `description`, numeric `sizeBytes`, `family`, and `legacy`; declared companion bytes contribute to displayed download size. Preserve any other existing catalog exports until their importers are migrated.
- Catalog provenance is the verified desktop registry SHA; use the same complete ID set as API, preserving existing legacy display distinctions.

- [ ] Add browser tests for each scope: Allow all → restricted preselects catalog; checkbox changes; last checkbox visibly returns to Allow all and sends null; required follows approved; LLM has no Required control; family grouping/numeric size order; disabled scope with hint; saved dormant list survives.
- [ ] Test old API support absent, unsupported capability version, initial `policy: null` on a supporting API, unavailable IDs already stored, successful save/reload/reset, navigation with unsaved edits, and unknown-ID/required-subset inline errors.
- [ ] Implement the combined card with existing components and the spec's copy. Disabled Local sections remain visible. Explain all-model selection before save so clearing a list never silently broadens access.
- [ ] Keep unknown saved IDs as labeled unavailable entries. Unrelated saves preserve them; editing that list requires removing unknown IDs before save. Legacy rows remain identifiable and existing required models are not lost.
- [ ] For API version support absent, show an upgrade/support message and disable approval writes; do not rely on HTTP 200 or field omission as proof that the server enforces the contract.
- [ ] Verify the replacement has no dangling `RequiredModelsPolicyCard` imports. Run the new Playwright suite and `npm run check`.

## Task 3: Release floor, disclosure and end-to-end save verification

**Files:** Modify `lib/policy-schema.ts`, `components/console/policy/{local-models-policy-card,provider-policy-cards,enforcement-disclosure}.tsx`, `e2e/local-model-policy.spec.ts`. Reuse member-version information and confirmation patterns already in `provider-policy-cards.tsx`.

**Interfaces:** `LOCAL_MODEL_POLICY_MIN_VERSION` matches API and the actual qualifying desktop release. A proposed floor increase is added to the models-card save only after explicit confirmation, without lowering an already higher floor. Existing Minimum app version card must show API save errors when a restricted policy prevents lowering the floor.

- [ ] Finalize the numeric version with desktop/API before enabling the card in a deployment. API capability alone is insufficient if the desktop release is not available.
- [ ] Add tests for below-floor/current/higher-floor policies; affected member counts including prereleases/unknown versions; Cancel leaves draft; confirmation applies approvals and floor atomically; failed/conflicting save leaves recoverable draft and dialog; allowing all leaves the existing floor unchanged.
- [ ] Implement confirmation and inline validation using existing version/member helpers. The Save operation persists only this card's slice plus the explicitly approved floor against the latest base/timestamp. Do not save a sibling Minimum app version draft.
- [ ] Add accurate disclosure: desktop-only, app-enforced; older apps ignore approval fields; updating the desktop fleet is necessary for full main/CLI coverage. Do not say setting the floor alone secures old direct-main paths. Keep mobile and BYOK/LAN exclusions clear.
- [ ] Run `npm run check`, `npm run test:e2e`, and `npm run format:check`. Require no new failures; report unrelated baselines separately.
- [ ] With the new API, manually save speech and LLM restrictions together, verify the API row and desktop picker/main refusal, update another card, and verify approvals survive. Test a second admin's conflict, old-console omission, explicit null reset and no-common-model effective policy.

**Release order:** API → qualified desktop → enabled console. The final version and real managed-device qualification are release dependencies. This plan authorizes no publishing or external writes.
