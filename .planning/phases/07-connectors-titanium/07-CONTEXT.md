# Phase 7: Connectors on Titanium accounts - Context

**Gathered:** 2026-11-18
**Status:** Ready for planning
**Mode:** auto-decided (planner, no owner questions; gray areas resolved below)

<domain>
## Phase Boundary

Connectors (Gmail send, Slack, Linear, GitHub, find_contact, note attendees) run for a user signed in with
Titanium on a licensed copy, with logins stored under the stable Titanium account id (IDP-32). All UI and
assistant capability text points at Titanium sign-in and the Titanium license, never at OpenWhispr sign-in,
an OpenWhispr plan, or a hidden settings section. Every entry point to a feature the fork dropped (sync /
cloud backup, cloud note search, referral, leaderboard, team workspaces / enterprise console, mobile sync,
developer integrations, OpenWhispr upgrade prompts) is hidden in a fork build.

Requirements: FEAT-04, FEAT-05, FEAT-06.

Not in this phase (owned by Phase 6, see 06-CONTEXT.md): web search transport and its `webSearch` capability,
the Slack/Linear OAuth relay, calendar OAuth, `SERVICES_URL`, build-time OAuth client ids.
</domain>

<live_findings>
## Live findings (checked 2026-11-18 in this session)

| # | Finding | How checked |
|---|---------|-------------|
| L1 | IDP-32 is MERGED (titanium-licensing PR #304, 2026-10-14). `/api/exchange`, whoami and the token carry an optional `accountId`; the consumer doc says to key users on it. | git on titanium-licensing origin/main, docs/consumer-integration/tauri.md |
| L2 | `titaniumSession.handleCallback` posts `{act, code_verifier}` only, accepts a response with no `appSlug`, and stores `{email, licenseKey, signedInAt}` with no account id. tauri.md marks sending `app_slug` and requiring `appSlug === ours` MANDATORY. | Read src/helpers/titanium/titaniumSession.js |
| L3 | Connector account scope comes from the OpenWhispr better-auth token binding (`main.js` `getConnectorAccountScope` -> `accountScopeBinding.resolveActiveAccountScope(tokenStore)`), which is always empty in a fork build, so every connector action is refused `signed_out`. | Read main.js ~537-577, ipcHandlers.js ~6543-6620, connectorManager.js |
| L4 | Connector policy resolver returns `signed_out` with no OpenWhispr Authorization/Cookie header and otherwise needs the OpenWhispr org-policy endpoint (`workspacePolicyManager` errors "OpenWhispr API URL not configured"). There is no such endpoint in the fork. | Read connectorIpc.js, workspacePolicyManager.js |
| L5 | Renderer gating: `useConnectorAccess.isPaid = isSignedIn && hasConnectorPlan(usage, isSubscribed)` and `useChatStreaming.connectorsAvailable = allowConnectors && settings.isSignedIn && connectorPlan && isConnectorsAllowed(policy)`: both read the OpenWhispr session and plan, so connectors are always locked. | Read useConnectorAccess.ts, useChatStreaming.ts 418-494 |
| L6 | `agentCapabilities.describeOne` emits "needs the user to sign in to OpenWhispr" and "needs a paid OpenWhispr plan"; `useChatStreaming` points `locations.account`/`plans` at `settingsModal.sections.account` / `plansBilling`, both hidden by `CLOUD_ONLY_SECTIONS` in a fork build (dead end). | Read agentCapabilities.ts, cloudSections.ts |
| L7 | en locale: `connectors.{slack,github,gmail,linear}.errors.signed_out` = "Sign in to {{brand}} to connect X."; `connectors.upsell` / `connectors.locked` talk about paid plans and Upgrade. `ConnectorsSection` `onUpgrade` comes from `IntegrationsView` <- `ControlPanel` 1292, which opens Settings > Plans & Billing (hidden). | grep src/locales/en, src/components |
| L8 | `TITANIUM.keygenProductId` is `""` in fork.config.json, and `parseAndVerifyLicenseKey` throws `unconfigured` when the product id is empty, so `licensed` can never be true today. No `titanium-whisper` string exists in titanium-licensing origin/main (app registration lives in the portal DB / Keygen, not the repo). Phase 6 CONTEXT does not mention it. | grep licenseKey.js:55, git grep titanium-licensing |
| L9 | Dropped-feature entry points still mounted in a fork build: `WorkspaceSwitcher` in ControlPanelSidebar (ungated), the Insights `leaderboard` tab (`InsightsView`, ungated tab content), the referral sidebar row (gated only by the OpenWhispr `isSignedIn`), `UpgradePrompt` on `onLimitReached`, `useSignInCloudNudge` toast, the leaderboard participation toggle and cloud backup rows in SettingsPage, `JoinYourTeamModal`, `EnterpriseCheckoutDialog`. Some are hidden today only because the OpenWhispr session is signed out (incidental, not a gate). | grep ControlPanel.tsx, ControlPanelSidebar.tsx, InsightsView.tsx, SettingsPage.tsx |
| L10 | Already gated by `CLOUD_ENABLED`: Settings sections account/plansBilling/workspace (`cloudSections.ts`), the Integrations developer group (API/MCP/CLI), the sidebar upsell banner (`decideUpsell` -> "hide"), policy store (`cloudDisabledPolicyState` -> `unmanaged`). | Read cloudSections.ts, integrationsSections.ts, ControlPanel.tsx 188, policyRules.ts |
</live_findings>

<decisions>
## Implementation Decisions

### Titanium account identity (FEAT-04)
- **D-01:** The Titanium session stores `accountId` from the exchange response (string, non-empty) and persists/loads it with the rest of the encrypted session. `TitaniumSession.getAccountScope()` returns `{accountId, authGeneration: generation}` or null. The renderer never receives the raw id; `getState()` adds `accountBound: boolean`. No email fallback: a session without an account id (saved before Phase 7, or a portal response without `accountId`) is "signed in but unbound", and connectors ask the user to sign in again.
- **D-02:** The exchange body sends `app_slug: TITANIUM.appSlug`, and the response is rejected (`app_mismatch`) unless `body.appSlug === TITANIUM.appSlug` exactly (missing counts as mismatch). This closes the tauri.md MANDATORY gap in the same function D-01 edits.
- **D-03:** In a fork build (`CLOUD_ENABLED === false`, read from `forkConfig.js` in main) the connector account scope comes from the Titanium session, not from `accountScopeBinding`. `accountScopeBinding` stays untouched (it also scopes notes/DB and the upstream cloud path). Connector credential slots stay `${connectorId}-${sha256(accountId)[:24]}`, now fed the Titanium account id. Titanium sign-out or an account change (pure `titaniumAccountChanged(prev, next)`) calls `connectorManager.accountChanged()` and the connector status broadcast, like the better-auth sign-out path does today.

### Paid plan and connector policy without an OpenWhispr policy endpoint (FEAT-04)
- **D-04:** "Paid plan" = `TitaniumSession.getState().licensed === true` (offline Ed25519-verified license for product `TITANIUM.keygenProductId`, not expired). Signed in without a license (AUTH_ONLY, `licenseKey: null`), an expired, tampered or audience-mismatched key, or an unconfigured product id = no plan. No server call; no org policy in a fork build.
- **D-05:** New pure, Electron-free module `src/helpers/connectors/titaniumConnectorPolicy.js` decides the fork connector policy state from `{signedIn, accountBound, licensed}`: `signed_out` | `reauth_required` | `plan_required` | `allowed`. In a fork build `ipcHandlers.js` passes `registerConnectorIpc` a `getPolicyState` and `getAccountScope` built from the Titanium session through this module; the OpenWhispr org-policy resolver is not called. `connectorPolicy.policyRefusal` maps the two new states to refusal codes `reauth_required` and `plan_required` (fails closed: any unknown state stays `policy_unavailable`). Selecting the Titanium resolver by `CLOUD_ENABLED` is build-mode selection, not a fallback: the upstream resolver remains the only path when cloud is enabled.
- **D-06:** `TITANIUM.keygenProductId` must hold the Keygen product UUID for app slug `titanium-whisper` (L8). The executor resolves the real value from the Titanium portal / Keygen product registry (a product id is an audience identifier, not a secret) and sets it in `src/config/fork.config.json`. If no product is registered for the slug, that is BLOCKED-ON-titanium-licensing (memlog_note to titanium-licensing), not a reason to weaken D-04.

### Renderer gating and capability messaging (FEAT-04, FEAT-05)
- **D-07:** Renderer connector eligibility in a fork build reads Titanium state through one pure helper (`connectorEligibilityFor` in `src/utils/connectorEligibility.ts`): `isPaid = signedIn && accountBound && licensed`, org block never applies (no org policy). Consumers: `useConnectorAccess`, `useChatStreaming` (`connectorsAvailable` and its cache key), `integrationsSections` connector badge. Upstream (`CLOUD_ENABLED`) keeps its current inputs.
- **D-08:** Capability text (`agentCapabilities.describeOne`) in a fork build: `signedOut` -> "needs the user to sign in with their Titanium account"; `planRequired` -> "needs an active {BRAND_NAME} license"; new reason `reauthRequired` -> "needs the user to sign in to their Titanium account again". `locations.account` and `locations.plans` both point at Settings > `settingsModal.sections.titaniumAccount.label` (visible in a fork build). The modelTooSmall docs line uses `DOCS_ORIGIN` without naming OpenWhispr.
- **D-09:** Connector copy in all 9 locales: `connectors.*.errors.signed_out` -> "Sign in with your Titanium account to connect X."; new `reauth_required` / `plan_required` error copy; `connectors.upsell` / `connectors.locked` -> Titanium license wording. The Upgrade action on the connectors upsell opens Settings > Titanium account (sign in or get a license there), never Plans & Billing.
- **D-10:** Guard test (fails on regression): scans every `src/locales/*/translation.json` value reachable from connector, capability and account keys plus `agentCapabilities.ts` output for "sign in to OpenWhispr", "OpenWhispr account", "OpenWhispr plan", "Plans & Billing" style targets, and asserts fork capability text never names a hidden settings section.
- **D-11:** Gmail send row: hidden in a fork build unless a dedicated `GMAIL_CLIENT_ID`/`GMAIL_CLIENT_SECRET` pair is set (Phase 6 cross-phase note: the calendar Google project lacks `gmail.send`). Implemented in the Gmail connector's `configured` check, fork-only.

### Dropped features (FEAT-06)
- **D-12:** One pure registry `src/config/cloudFeatures.ts`: `CLOUD_ONLY_FEATURES` (referral, leaderboard, workspaceSwitcher, teamJoin, upgradePrompt, signInCloudNudge, cloudBackup, enterpriseCheckout) and `cloudFeatureVisible(id, cloudEnabled)`. Every mount site listed in L9 gates on it explicitly (not on the incidental OpenWhispr `isSignedIn`). `decideSignInCloudNudge` takes `cloudEnabled` and returns `skip` when false.
- **D-13:** Guard test lists each dropped-feature mount site and fails if a site stops routing through `cloudFeatureVisible`, plus unit tests of the registry. Mobile sync and developer integrations: verify by grep that no entry point exists (developer group already gated, L10); no new code unless the grep finds one.

### Claude's Discretion
- Exact English wording of the new strings (keep them short; translations by the executor for es, fr, de, pt, it, ru, zh-CN, zh-TW).
- Whether `accountBound` or a separate `reason` value carries the "sign in again" state on `TitaniumAuthState` (chosen: `accountBound` boolean).
- File placement of the new guard tests (chosen: `test/config/`).
</decisions>

<canonical_refs>
## Canonical References

- `.planning/REQUIREMENTS.md` FEAT-04, FEAT-05, FEAT-06; `.planning/PROJECT.md` out-of-scope list (dropped features)
- `.planning/OpenWhispr Fork Gap Analysis.md` P01 (connectors), P18 (lost cloud features)
- `.planning/phases/06-hosted-services/06-CONTEXT.md` (web search, relay, calendar OAuth, Gmail client note)
- titanium-licensing `docs/consumer-integration/tauri.md` (exchange contract, app_slug mandate, accountId) and `README.md` (keygenProductId audience check)
- `.claude/CLAUDE.md` (fork index): pure policy module + test pattern, i18n in 9 locales, Node 24
</canonical_refs>

<code_context>
## Existing Code Insights

- Titanium: `src/helpers/titanium/titaniumSession.js`, `titaniumIpc.js` (`getTitaniumSession()`), `licenseKey.js`; renderer mirror `src/hooks/useTitaniumAuth.ts`; type `TitaniumAuthState` in `src/types/electron.d.ts`.
- Connectors (main): `connectorCredentials.js` (slot per account), `connectorManager.js` (`signed_out` refusal, `accountChanged()`), `connectorPolicy.js` (`connectorPolicyState`, `policyRefusal`), `connectorIpc.js` (`registerConnectorIpc`, `createConnectorPolicyResolver`, `sameAccountScope`), wiring in `main.js` ~537-577 and `ipcHandlers.js` ~6543-6620.
- Renderer: `src/utils/connectorEligibility.ts`, `src/hooks/useConnectorAccess.ts`, `src/components/chat/useChatStreaming.ts`, `src/config/agentCapabilities.ts`, `src/components/ConnectorsSection.tsx`, `src/components/connectors/ConnectorLoginRow.tsx`, `src/components/integrations/integrationsSections.ts`, `src/utils/connectorErrorCopy.ts`.
- Existing tests to extend: `test/helpers/titaniumSession.test.js`, `test/helpers/connectors/connectorPolicy.test.js`, `connectorIpc.test.js`, `connectorCredentials.test.js`, `gmailAuth.test.js`, `test/helpers/useChatStreamingConnectors.test.js`, `test/config/agentCapabilities.test.js`, `test/utils/signInCloudNudge.test.js`, `test/config/forkRebrand.test.js`.
</code_context>

<cross_phase>
## Cross-phase notes

- Phase 7 executes after Phase 6: both touch `titaniumIpc.js`, `fork.config.json`, `useChatStreaming.ts` and the locale files.
- L8 (empty `keygenProductId`) also blocks Phase 6 web search (license-gated). Whichever phase executes first sets it (D-06).
- AUTH-05 is marked "Moved" to Phase 6 in REQUIREMENTS.md but appears in no Phase 6 plan. Not planned here (outside FEAT-04..06); flagged for the orchestrator.
- The `accountId` from IDP-32 is optional (fail-soft) on the portal side; D-01 treats its absence as "sign in again", never as an email-keyed login.
</cross_phase>

<deferred>
## Deferred Ideas

- Revocable desktop account token (titanium-licensing PR #335) for server-side connector policy: not needed while the license is verified offline.
- Org/workspace connector policy for Titanium teams: no Titanium org-policy surface exists; revisit if one ships.
</deferred>

---
*Phase: 07-connectors-titanium*
