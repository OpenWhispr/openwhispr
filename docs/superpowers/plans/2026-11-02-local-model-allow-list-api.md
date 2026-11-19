# Local model allow list API implementation plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task by task after approval. Steps use checkboxes for tracking. Do not commit or push unless separately authorized.

**Execution status (2026-11-02):** Implementation is present on `feat/local-model-allow-list` in the isolated API worktree. All 2,861 API tests, TypeScript (`--incremental false`), ESLint and whitespace checks pass. The enforcement floor is **1.11.1**. Final review found no blocking issue. Real managed-device qualification and deployment remain separate release work.

**Goal:** Store and safely resolve scoped local-model approvals without allowing older consoles to erase restrictions.

**Architecture:** Extend the existing JSON policy and resolution pipeline. Keep mutable catalog and release-floor checks on saves, preserve omitted fields before parsing, and retain timestamp-based compare-and-write behavior.

**Tech stack:** TypeScript, Zod 3, Vercel handlers, existing PostgreSQL policy storage, Node test runner with tsx.

**Spec:** [Approved local models](../specs/2026-11-02-local-model-allow-list-design.md). All paths below are relative to `OpenWhispr/openwhispr-api` unless stated otherwise. Verified base: `11121f11a82388f990543347eb7b6223ecdeb8e2`.

## Global constraints

- Policy version stays 1. Fields are `transcription.allowedLocalModels` and `llm.allowedLocalModels`.
- `null` means unrestricted; effective `[]` means no models; explicit saved `[]` is invalid.
- Maximum 200 IDs, each 1–128 characters; duplicate writes are invalid.
- Catalog checks must not run during strict stored-row reads.
- No package installation, environment-file edits, database migration, branch creation, commit, or push is included.
- Work on the execution branch the user specifies. The observed local API checkout is not the verified base; do not modify its unrelated files.
- The numeric `LOCAL_MODEL_POLICY_MIN_VERSION` is finalized from the real desktop release before deploy; do not use current 1.11.0.

## Review focus

1. A stale/old admin client omitting fields must preserve restrictions (Task 2).
2. Retired IDs must not break reads or unrelated saves (Tasks 1–2).
3. Empty multi-workspace intersections must remain restrictive (Task 1).
4. Stale timestamps must not authorize either explicit changes or omission-preserving writes (Task 2).
5. A release-floor change must not retroactively make stored rows unreadable (Task 3).

## Task 1: Catalog, schema and policy resolution

**Files:** Modify `lib/policy-schema.ts`, `lib/__tests__/policy-schema.test.ts`, `lib/__tests__/policy.test.ts`, `lib/__tests__/policy-desktop-contract.test.ts`, `lib/__tests__/policy-client-compat.test.ts`. Create `lib/local-model-catalog.ts` and `lib/__tests__/fixtures/local-model-catalog.json`.

**Interfaces:**

- Export `TRANSCRIPTION_LOCAL_MODEL_IDS: readonly string[]`, `LLM_LOCAL_MODEL_IDS: readonly string[]` from the new catalog module.
- Extend inferred `Policy` with `allowedLocalModels: string[] | null` in each scope.
- Add internal `intersectLocalModelLists(lists: readonly (readonly string[] | null)[]): string[] | null` in `policy-schema.ts`.
- Keep existing `resolvePolicies(policies: Policy[]): Policy`, `resolveRows`, and client compatibility entry points.

- [ ] Add schema tests: old rows parse to two `null`s; lists round-trip; malformed element/length errors; unknown strings parse on reads; writes reject `[]` and duplicates; required-not-approved fails; `null` accepts all currently valid required models.
- [ ] Add resolver assertions: `null ∩ null = null`, `null ∩ [base] = [base]`, `[base,small] ∩ [small] = [small]`, `[base] ∩ [small] = []`. Check order, duplicates, both scopes, zero/one-policy branches, required union/pruning, and disabled-local required results.
- [ ] Add strict-row tests showing a stored retired approval still resolves managed and disjoint model sets do not become `POLICY_UNRESOLVABLE`. Keep existing no-common-mode failures unchanged.
- [ ] Add desktop validator mirror tests for absent/null/string-array/empty-array acceptance and malformed values. Verify the fields survive every existing client-compat version case.
- [ ] Run the named tests to establish failures for the new contract using the existing Node/tsx runner.
- [ ] Derive the catalogs from desktop `src/models/modelRegistryData.json` at the spec's revision: all 15 speech and 42 LLM IDs, including legacy entries. Store a small provenance-stamped fixture, not a network dependency in unit tests. Assert exact ID sets, not only counts. Extend required IDs by the five missing speech models; retain historic IDs.
- [ ] Add defaulted nullable shape fields and stable write invariants. Implement nullable intersection and required pruning. Reuse unchanged client-compat code unless tests identify a projection that drops the fields.
- [ ] Run `node --import tsx --test lib/__tests__/policy-schema.test.ts lib/__tests__/policy.test.ts lib/__tests__/policy-desktop-contract.test.ts lib/__tests__/policy-client-compat.test.ts`; all targeted assertions must pass. Use the repo's test environment when a test imports DB/auth helpers.

## Task 2: Preserve and validate policy updates

**Files:** Modify `api/workspaces/[id]/policy.ts`; create `lib/__tests__/workspace-policy-put-local-models.test.ts`. Reuse the mocked-handler pattern in `lib/__tests__/workspace-policy-put-audio.test.ts`.

**Interfaces:**

- GET policy-state envelope adds `localModelPolicyVersion: 1`, including when `policy: null`.
- PUT remains `{ policy, updated_at }` and returns the existing row envelope plus `localModelPolicyVersion: 1`, so an admin cache replacement retains capability.
- Unknown-ID response is `{ error: string, code: "UNKNOWN_LOCAL_MODEL", scope: "transcription" | "llm", ids: string[] }`, status 400.
- Add internal `withStoredLocalModels(stored: Policy | null | undefined, body: unknown): unknown`, composed with existing audio-field preservation.

- [ ] Add handler tests: fresh default, valid restricted save, explicit-null reset, one/both fields omitted, disabled-local dormant list retained, required-not-approved, wrong-scope ID, duplicate ID, invalid shape, and exact error payload.
- [ ] Add compatibility assertions: unchanged stored retired list survives a provider-only save, including a full echoed list; changed list with a retired ID fails; editing the other scope does not validate unchanged retired IDs against today's catalog.
- [ ] Add concurrent-save tests: current timestamp succeeds, stale or missing timestamp on an existing row produces 409, and no failed validation/conflict persists a new document. Keep admin-role and plan checks intact.
- [ ] Run new handler tests and confirm they fail at the missing behavior.
- [ ] Preserve omitted fields from the stored row before schema defaults run. Validate changed non-null lists against scope catalogs after shape validation. Do not normalize missing scopes or malformed structures into valid input. Keep explicit null distinct from omission.
- [ ] Preserve the existing single compare-and-write and audit event. Add capability to GET and successful PUT, and assert it survives a save response. Do not change client-compat behavior based on the desktop version: old clients may ignore the fields, but new clients must receive empty effective arrays intact.
- [ ] Run the new suite together with `workspace-policy-put-audio.test.ts` and `workspace-policy-handler.test.ts`; require zero failures.

## Task 3: Release-floor validation and qualification

**Files:** Modify `lib/policy-schema.ts`, `lib/__tests__/policy-schema.test.ts`, `lib/__tests__/workspace-policy-put-local-models.test.ts`; coordinate the same release constant in admin.

**Interfaces:** `LOCAL_MODEL_POLICY_MIN_VERSION: string` is the actual release containing full desktop enforcement. Restricted list saves and floor lowering are validated in `policySaveSchema` only.

- [ ] Finalize the desktop release number before completing this task or deploying writes. Until then, this is an explicit release dependency, not a guessed version literal.
- [ ] Add tests: restricted save with missing/below-floor version fails at `minAppVersion`; exact floor/higher succeeds; unrestricted policy follows existing rules; both scopes covered; lowering a restricted policy's floor fails; strict reads still accept historical rows below a subsequently changed floor.
- [ ] Add the constant and save-only refinement using existing canonical version comparison. Keep model-catalog checks in the handler, where stored-vs-edited list context exists.
- [ ] Run `npm test`, `npm run build`, and `npm run lint` in the authorized implementation checkout. Report any baseline failure separately; do not alter unrelated code to make this feature green.
- [ ] Compare the API fixture with the exact desktop release registry, and compare API/admin field/default/error/version contracts. Record both revisions in release notes.
- [ ] Exercise API → desktop with an empty intersection, malformed stored row, offline cache, and explicit reset. Verify capability/omission behavior against an old-console-shaped PUT.

**Deployment dependency:** API can land with null defaults before desktop. Restriction editing must remain unavailable until the compliant desktop release exists. Console rollback keeps this API's omission-preservation logic. This plan does not authorize deployment.
