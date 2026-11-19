# Salesforce Integration Implementation Plan

> Use the parallel-agent and code-quality workflows to implement the independent modules below, then integrate and review the complete change. Do not commit or push.

**Goal:** Implement reviewed conversation export and selected-record customer briefings.

**Architecture:** Add a desktop Salesforce connector to the existing per-account connector manager, query tools, and approval cards. Keep durable note/export associations local. Use Salesforce REST under the signed-in user's permissions and existing note retrieval for briefing evidence.

**Tech stack:** Existing Electron CommonJS helpers, React/strict TypeScript renderer, SQLite, node:test; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-02-salesforce-integration-design.md`.

## Constraints and review focus

- Existing checkout only; no commits, pushes, package installation, or `.env` changes.
- Individual connection, manual selection and approved writes only; no automatic matching, team admin, pipeline analysis, arbitrary SOQL, or general CRM mutation.
- Test stale account/org bindings, URL/token boundaries, uncertain writes/restarts, repeat exports, inaccessible notes, and stale Salesforce fields.
- Third-party CRM text is data; enforce destinations and write allowlists in main, not only model instructions.
- Live OAuth and organization validation remain dependent on a supplied registered app and test org.

## Task 1 Salesforce REST and authentication

Files: new `src/helpers/connectors/salesforceApi.js`, `salesforceAuth.js`; corresponding `test/helpers/connectors/salesforceApi.test.js` and `salesforceAuth.test.js`.

Interfaces: `createSalesforceApi({fetchImpl})` returns `request({instanceUrl, accessToken, method, path, body, headers})`, `exchangeToken(params, loginUrl)`, `refreshToken(params, loginUrl)`, and `revokeToken(token, loginUrl)`. Results use `{ok:true,data}` or `{ok:false,errorCode,outcome,refused?}`. `createSalesforceAuth` mirrors the existing bound-login API (`authorize`, `getAccessToken`, `statusOf`, `isConfigured`, `revoke`). Credentials include userId, organizationId, instanceUrl, loginUrl, userName, organizationName, tokens and reconnect state. Bindings include ownerAccountId/accountId/workspaceId/generation/instanceUrl.

- [x] Write and run failing tests for origin/path restrictions, OAuth state/PKCE, token refresh and stale bindings, REST error/uncertain-write classification.
- [x] Implement using existing HTTP helpers and `boundLogin.js`; pin a documented API version and callback. No secrets in desktop builds.
- [x] Run targeted tests and provide setup requirements.

## Task 2 Connector behavior and durable associations

Files: new `salesforceConnector.js`, `salesforceExports.js` in `src/helpers/connectors`, associated tests. Add narrowly scoped persistence/lifecycle integration as needed.

Interfaces: `createSalesforceConnector({api,auth,credentials,exports,getNote,i18n})` and `buildSalesforceConnector(deps)`. Factory consumes `deps.database` and `deps.getSalesforceNote(noteId, ownerAccountId)` supplied by main. Actions: queries `search_records`, `get_record`, `describe_fields`, `get_briefing`; approvals `export_conversation`, `update_fields`. Record arguments `{objectType,recordId}`; export additionally `{noteId,title,body}`; field update additionally `{noteId,fields:[{name,value}]}`. Field update requires a confirmed export of that note to that Opportunity. Search takes `{query,objectType?}`. Briefing returns record facts and linked accessible note ids/titles for existing `get_note` retrieval, never arbitrary other notes.

Field preview contract: verb `salesforceFields`; `fields` contains `value0`, `value1`, `value2` and `include0`, etc. with string values `yes`/`no`. Add a typed `salesforceFields` preview property containing `{key,name,label,before,maxLength}[]`. Main stores the actual field names/current values and record binding in payload; edits cannot change destinations. Activity preview verb `salesforceActivity`, editable title/body.

- [x] Write and run failing tests for explicit record resolution, no prepare writes, normal export/update, duplicate and uncertain operations, note access/account scope, field allowlist/stale values, and scoped briefing evidence.
- [x] Implement durable associations keyed by account/org/instance/note/destination. Reconcile interrupted writes to unknown, preserve separate activity/field outcomes, and clear local data through account/reset lifecycle.
- [x] Implement bounded REST queries and metadata-driven Task status/text fields. Re-read records/permissions at commit and never blindly retry uncertain writes.
- [x] Run targeted connector and store tests.

## Task 3 Renderer tools and approval UI

Files: new `src/services/tools/connectors/salesforceTools.ts`, field UI/utilities as needed; existing connector module registry, rows, ApprovalCard, connector types, capabilities, localized strings, chat history. Relevant service/component/config tests.

Interfaces: tool names `salesforce_search_records`, `salesforce_get_record`, `salesforce_describe_fields`, `salesforce_get_briefing`, `salesforce_export_conversation`, `salesforce_update_fields`; corresponding main action names in Task 2. Use `runQueryAction` and `runApprovalAction`. Follow the Task 2 preview contract. Record selection is through returned exact identifiers and the user's chat choice; never hidden automatic selection.

- [x] Write and run failing tests for registration, input validation, approvals, field edits/omissions, and outcome handling.
- [x] Implement tools, Salesforce connection row and before/after editable field card. Guide briefings to fetch only linked/explicit notes with existing note tools, cite sources, and distinguish missing context.
- [x] Integrate Salesforce capabilities and history receipts without leaking queried content or enabling excluded workflows.
- [x] Run targeted tests and TypeScript checks.

## Task 4 Integration and verification

Files: `main.js`, `createConnectors.js`, applicable lifecycle/help files, `docs/integrations/salesforce.md`, registration regression tests.

- [x] Wire the factory with account-scoped note lookup and database dependency; update registration tests.
- [x] Verify the complete export → association → briefing sequence with a fixture-backed integration test.
- [x] Document exact OAuth registration, test fixtures, launch configuration, limitations, and live-test checklist.
- [x] Run targeted and full tests, lint, typecheck, and diff checks; review the assembled changes and fix actionable findings.

## Execution notes

User explicitly authorized implementation of the approved design. Proceed without another plan approval. Keep new backend modules consistent with the repository's CommonJS helpers, and strict TypeScript for renderer code. Existing source-note lookup must enforce active-account scope in main; associations confer no extra access.

## Verification results

- Final Salesforce and affected regression run: 189 passed, no failures or skips.
- Remaining connector-registration and capability-prompt regression run: 57 passed.
- Independent review found two lookup issues; both fixed and re-reviewed, with 34 targeted tests passing independently.
- TypeScript, ESLint (existing unrelated warnings only), changed-file Prettier, locale consistency, renderer build, and diff checks passed.
- Full Node 24 run: 9,739 passed, 23 failed, 541 skipped, 1 todo. Six outdated connector inventory assertions were corrected and rerun; the other 17 failures came from the installed SQLite binary targeting Electron's ABI rather than Node 24.
- Full run using the installed Electron Node runtime after fixes: 10,330 passed, 8 failed, 14 skipped, 1 todo. All eight failures were in the unrelated `whisperVadModelPath` fixture suite, whose resource-path simulation differs under Electron. That entire suite passed separately under Node 24 (9 tests). No dependency rebuild or installation was performed.
- Live OAuth, refresh-token behavior in the actual org, and Salesforce-specific validation rules are pending the user's registered OAuth app and test organization. Setup and manual checklist: `docs/integrations/salesforce.md`.

No commits or pushes were made.

## Main integration verification — 2026-11-17

- Advanced this existing detached checkout from `7155b905d` to fetched `origin/main` at `ad7424068`; restored the uncommitted Salesforce changes. Preserved the pre-update snapshot in stash `salesforce-before-main-2026-11-17`.
- Resolved approval-card, capability, translation, and fixture conflicts while retaining main's current layout, Slack outcomes, account scopes, and interaction tools. Salesforce uses the shared action-claim and connection-card APIs.
- Salesforce/capability tests: 79 passed. New Salesforce connection-card test: 1 passed.
- Affected regressions: 1,184 passed; two localhost OAuth tests timed out in the sandbox and both passed when rerun with localhost access. Electron account-ownership tests: 12 passed.
- Typecheck, lint (existing warnings only), changed-file formatting, locale consistency, renderer build, and diff checks passed.
- Full repository run under the sandbox: 15,082 passed, 262 failed, 17 skipped, 1 todo. Local sockets and the shared dependency cache were blocked; three stuck sandbox workers were stopped. All 36 affected files were rerun with localhost/cache access and a 60-second timeout per file: 1,028 passed, zero failures/skips. No unrelated code was changed.
- Live Salesforce OAuth and manual workflows remain unverified.
- No new branch, package installation, application commit, push, or `.env` modification.
