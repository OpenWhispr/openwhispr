# Creator-code mobile integration implementation plan

> **For agentic workers:** The main agent implements and repairs with `code-quality`; planning and final `deep-review` agents are read-only apart from this assigned plan. Execute the tasks below in order. This is the technical execution record of the already-approved sequence, not a new design proposal.

**Goal:** Connect the approved shared Monthly/Annual Superwall screen to existing creator attribution and verified monthly Apple offers, preserving ordinary purchasing, anonymous onboarding and Local's Account shortcut.

**Architecture:** Reuse the affiliate parser/store/services and billing identity guards. Give each Superwall presentation an app-owned creator callback context; only display strings return to the paywall. Explicit Use code, keyboard Go or completed Account system Paste may commit a creator; rendering, typing and fictional proof cannot.

**Tech stack:** React Native/Expo, TypeScript, Zustand, `expo-superwall` 1.2.0 / SuperwallKit 4.16.1, existing Dub/RevenueCat clients, Jest; Node 24.

**Spec:** [Current approved handover](../../../titan-affiliate-handoff-20260916/docs/handovers/2026-09-25-affiliate-native-catalog-device-verification-next.md), [approved visual](../../../titan-affiliate-handoff-20260916/artefacts/reports/2026-09-25-affiliate-creator-code-designs.html), [completed feasibility research](../../../titan-affiliate-handoff-20260916/artefacts/reports/2026-09-25-affiliate-creator-code-feasibility.md), and [saved draft bindings](../../../titan-affiliate-handoff-20260916/docs/evidence/affiliate-superwall-test-20260925/binding-readback.json).

## Authority and workflow record

- `deep_research: yes` — dedicated feasibility research and editor inspection are already complete; no repeat research phase.
- `codex_review: no` — no additional Codex review stage selected; independent final deep review remains required.
- `plan_status: approved` — refers to the existing handover sequence, not an unreviewed expansion. After approving the finished screen (including removing the Apple explanation and footer dismissal text), Josh said “cool whats next? looks good”. The stated next sequence was isolated fictional callback proof, mobile wiring on draft #2334, checks/independent review, then separately authorized device/Apple acceptance. Josh replied **“Cool go for it”** in this session. This plan supplies implementation detail within that authority.
- Owned worktree/branch: `/Users/joshuadavidpadoa/dev/openwhispr-mobile-affiliate-port-20260924`, `feat/mobile-affiliate-port-20260924`; starting head `73614e017331de90fae6d063481bc066972f31f7`; existing [draft #2334](https://github.com/OpenWhispr/openwhispr/pull/2334).
- Read root `CLAUDE.md` and mobile `CONTRIBUTING.md`. No `AGENTS.md` exists in this owned checkout. Run mobile commands inside `openwhispr-mobile/`; do not change dependencies or lockfiles for this work unless a concrete incompatibility requires it.

## Current execution status (September 25)

- Step 1: isolated native fixture callback/display/action/reset proof passed on the separate iPhone simulator app. Campaign 109201 is restricted to its unique bundle and placement. Final product/token/seed bindings are configured. Native seed/token display and action routing passed; explicit false/empty seed parameters repaired and passed cached reuse. The separate bundle omits native product identifiers because it has no StoreKit catalog. Final-revision retry/malformed guards, reachable recovery, pending input locking and X/late-callback isolation passed on the separate iPhone probe; full device/keyboard and iPad checks remain; real app/catalog acceptance is not established.
- Step 2: source implementation prepared on the owned branch: exact short keys, per-presentation callbacks/private offers, direct Cloud paywall, explicit Account shortcut, one-shot inbound intent, consent/identity/currentness guards and tests. Final real-app acceptance remains dependent on Step 1’s native product/catalog and remaining device checks.
- Step 3: full source checks and independent review are recorded with the final source checkpoint. Connected Apple acceptance, correct real app/catalog/stock, native Account input/iPad coverage, production association and joint desktop/mobile activation remain separately held.

## Next fresh session: app/catalog and native device verification

Josh explicitly parked further execution for a new session on September 25. Begin with a read-only inventory of the existing staging app/catalog identity, current source/PR checks, available test binaries and iPhone/iPad targets. Match Superwall, RevenueCat, API environment, bundle identity and monthly/annual products before choosing a compatible full-app development runtime. Reuse completed staging setup and the existing isolated paywall; do not replace a personal app or loosen product/ownership guards.

Then exercise native Account completed system Paste/Go, normal typing, full/inbound links, Cloud/Local, Monthly/Annual, refusal/unavailable/offline/repeat/session changes and layout/keyboard/lifecycle on iPhone and iPad. Use fictional non-claiming data for presentation checks. Real creator saving, code allocation, redemption, purchase/restore and financial/recovery acceptance remain a later separately authorized session. Production routing and the single desktop/mobile activation decision remain held. Record exact proof, defects and dependencies in the current handover and existing evidence.

## Global constraints and acceptance

- Cloud remains **choose mode → existing consent → existing paywall → optional account later**. Remove the separate creator-entry Continue stage. Refused consent preserves ordinary purchasing.
- Keep the exact approved heading, subtitle, five benefits, Restore and Terms. Monthly alone exposes creator controls; Annual remains purchasable and retains permanent attribution. Use **Continue to payment** and X-only dismissal; no Apple-next sentence, Cancel/Clear link, or footer Not now/Keep using Local.
- Preserve Account row/icon/17 px regular text/chevron, normal editing, full trusted links and deliberate completed-system-Paste/Go shortcut. Typing never submits; no automatic clipboard access. Valid completed entry opens its monthly offer without another Plans & Billing tap.
- The first creator stays permanent. Saving attribution is distinct from checking a link and from allocating an Apple offer. `/api/affiliate/apple-offer` allocates stock; no presentation-only “quote” call.
- Return only formatted price/renewal text, an opaque presentation token and bounded public error text. Keep real creator identifiers, Apple redemption URL/code, session cookie and billing identifiers out of paywall display variables, logs and saved proof.
- Never display a creator discount while invoking ordinary Purchase. Recheck private offer, current account/cookie/billing identity, subscription state, expiry, product/storefront/currency and consent at the relevant boundaries.
- Existing test paywall **app 38286 / 271365** is the sole draft. Original **239043** and live campaigns/global products are untouched. Production onboarding routing remains unresolved and held.
- No merge, production traffic, release, installation over a personal app, purchase, payouts, outbound message or website checkout work. Existing staging Apple/desktop setup is reused in the later separately authorized session.

## Review focus

1. Late callbacks after X, timeout, session switch or a new presentation must never save another user's state or open Apple's redemption URL.
2. Missing/malformed callback data, rejected offers and unresolved input must never fall through to ordinary full-price payment while a discount is shown.
3. Uppercase/Unicode/URL-shaped input must not be silently lowercased into a different creator; trusted full links retain their exact key.
4. Refused tracking, Analytics off and unavailable attribution must preserve normal Monthly/Annual purchasing without claiming or allocating.
5. Repeat Account Paste/Go, switching Annual/Monthly, cached paywall presentation and anonymous signup recovery must not duplicate claims, allocate during rendering or replace the first creator.

## Task 1: Establish the isolated callback contract

**Files:** `src/lib/superwall.ts`, `src/components/superwall/SuperwallGateProvider.tsx`, the existing draft evidence/handover in the owned Titan worktree; a narrowly scoped development-only fixture helper/test if required. Any configuration additions belong to existing app configuration conventions and `docs/affiliate-integration.md`.

**Interfaces:** Installed `usePlacement` accepts `onCustomCallback(callback: CustomCallback): Promise<CustomCallbackResult> | CustomCallbackResult`; callback is `{ name: string, variables?: Record<string, unknown> }`, result is `{ status: 'success' | 'failure', data?: Record<string, unknown> }`. Names are `creatorCodeApply` and `creatorOfferRedeem`. Draft binds input `state:node.o9Et2gOJEgdSPj0nV1CkE.value` and selected index; display namespace is `callbacks.creatorCodeApply.data` with `priceText`, `renewalText`, or failure `message`. Native flat dictionary keys were observed; see the final contract/status below.

- [x] Refresh the intended app and establish the isolated test route: app 38286/paywall 271365, campaign 109201, sole probe placement and unique probe bundle filter. Final save/reload readbacks verified it. Do not route `onboarding_paywall` into live Cloud sync.
- [x] Add fixture callbacks behind an explicit development/test boundary, without importing/calling real claim, Dub tracking, stock allocation or URL-opening functions. Fictional prices must be visibly labeled as test data. Return, for example:

```ts
return {
  status: 'success',
  data: {
    priceText: 'TEST $7.99',
    renewalText: 'TEST ONLY — no subscription or offer',
    offerToken: 'FICTIONAL_PRESENTATION_TOKEN',
  },
};
```

- [x] Record sanitized native input/plan/token/seed keys and bind parsing to them. Product identifier is configured but absent from the distinct probe bundle, which has no StoreKit catalog; actual product/catalog acceptance remains open. Unknown names/keys/types fail without invoking services.
- [ ] Verify returned strings, missing data, explicit failure, repeated presentation, annual hiding, X dismissal, waiting, edited input and late completion. Fixture redemption returns a non-purchasing result; fixture ordinary-purchase actions also remain disabled during this proof.
- [x] Prove the initial display-state contract: native fixture seed/token rendering, custom action and Annual/Monthly behavior passed. Explicit false/empty parameters repaired cached reuse. Private offer authority remains app-owned; native real product/catalog acceptance is still separate.
- [x] Save exact route/binding evidence and limits. Native proof may depend on a compatible new development binary; source tests can proceed with that dependency recorded, but Step 1 remains partly open until actual execution is observed.

## Task 2: Add exact short-code mapping and explicit submission semantics

**Files:** `src/lib/affiliateLink.ts`, `src/lib/affiliateAttribution.ts`, `src/store/useAffiliateStore.ts`; tests `src/lib/__tests__/affiliateLink.test.ts`, `src/lib/__tests__/affiliateAttribution.test.ts`, and the existing store/intent tests.

**Interfaces:** Add `parseAffiliateInput(input: string, domain: string): URL`, retaining `parseAffiliateLink` for inbound full-link routing. A short input is a bounded lowercase exact key, constructed on the configured trusted domain. Keep `checkAndClaimAffiliate(...)` as the explicit mutation path; extract/reuse its non-claiming check-link operation only where separate validation is needed. `prepare(isCallerCurrent)` remains an explicit submission operation, not a render hook.

- [x] Add failing parser tests for lowercase key mapping, leading/trailing whitespace, full-link key case preservation, and rejection of mixed/uppercase short codes, Unicode, spaces, slashes, schemes, query fragments and oversized input. Use a concrete bound of 64 characters for short entry; longer trusted full links retain the existing 2048-character limit. Do not use `toLowerCase()` on creator keys.

```ts
expect(parseAffiliateInput(' demo_creator-1 ', 'creators.example.com').pathname).toBe(
  '/demo_creator-1',
);
expect(() => parseAffiliateInput('Demo_Creator', 'creators.example.com')).toThrow();
expect(
  parseAffiliateInput('https://creators.example.com/Demo_Creator', 'creators.example.com').pathname,
).toBe('/Demo_Creator');
```

- [x] Implement the minimum parser and reuse it only at deliberate user-entry boundaries. Preserve strict trusted HTTPS/domain/credentials/port rules and explicit Dub `trackOpen(link)` validation of returned domain/key.
- [x] Pin validation-only behavior: check-link may validate but must not call trackOpen, claim or apple-offer. Pin explicit-submit behavior: permission → check-link → permission/currentness → explicit Dub → durable click ID → permission/currentness → claim, with one ten-second bound and existing account/revision guards.
- [x] Preserve saved first creator even when another entry is attempted. Make mismatched saved-creator attempts explain the state rather than presenting the new typed code as saved. Typing and editing remain local candidates; error copy must not require a removed Clear hyperlink.
- [x] Run parser/attribution/intent tests and commit only the named implementation and test files when green. No canonicalization API change or domain-setting change is implied; the exact-key subset avoids unverified case folding.

## Task 3: Bind both Superwall handlers to verified app-owned offers

**Files:** `src/components/superwall/SuperwallGateProvider.tsx`, `src/lib/affiliateOffer.ts`, `src/lib/billingIdentity.ts` (reuse), `src/store/useAffiliateStore.ts` (reuse), a focused `src/lib/affiliatePaywall.ts` helper if needed, and matching `src/lib/__tests__/affiliatePaywall.test.ts` / `src/components/superwall/__tests__/SuperwallGateProvider.test.tsx`.

**Interfaces:** A presentation-owned callback handler exposes `(callback: CustomCallback) => Promise<CustomCallbackResult>` and invalidation on terminal events. It privately retains `{ offer: AffiliateOffer, identity: BillingIdentity, generation }`. SDK callers never receive the offer object. Both ordinary `usePlacement(placementCallbacks)` and `OnboardingOfferHandler` forward `onCustomCallback` using their own gate identity.

- [x] Add behavior tests first: monthly apply succeeds only after explicit preparation and `loadAffiliateOffer()` verifies the offer; callback success contains display strings only; invalid/denied/offline/unavailable/malformed requests return failure. Annual or unknown callbacks do no affiliate work.
- [x] On apply, reject concurrent work, stale gate, missing identity or changed session. Parse explicit input, prepare attribution once, recheck currentness, then allocate/verify through existing `loadAffiliateOffer()` (eight-second bound). Use `Intl.NumberFormat` and returned verified values for three payments plus regular renewal text.
- [x] Keep display authority tied to the exact private offer. On redeem ignore untrusted price/URL data from the paywall, require selected Monthly and the same live private offer, recheck current billing identity/subscriber/expiry/consent, then open only its already validated official Apple URL. Prevent duplicate redemption taps.
- [x] Invalidate pending completion/private offer on X/dismiss, skip/error, abort, account/cookie/billing change, or next presentation. Test deferred promises resolving after each invalidation and assert no state update or URL open.
- [x] Reuse billing session and app-return reconciliation semantics from `AffiliateOfferModal`; do not manufacture purchase/commission events from the custom callback. Ordinary purchased/restored callbacks and exactly-once gate completion retain their existing behavior.
- [x] Test both handler instances, malformed selected index, missing display fields, duplicate apply/redeem and stale offer; run the existing Superwall/billing suites and commit named files when green.

## Task 4: Connect the approved Cloud and Account journeys

**Files:** `src/screens/onboarding/steps/PaywallStep.tsx`, `src/screens/AccountScreen.tsx`, `src/components/AccountCreatorLink.tsx`, `src/components/onboarding/CreatorLinkField.tsx` only if no callers remain, `src/hooks/useSuperwallGate.ts` only for minimal typed initial-offer parameters; preserve `AffiliateOfferModal.tsx` as the reviewed fallback. Tests: corresponding `PaywallStep`, `AccountCreatorLink`, `AccountScreen.billing` and onboarding transition suites.

- [x] Test Cloud consent authorization/refusal proceeds directly to the existing Superwall registration; no separate CreatorLinkField/Continue screen and no automatic offer allocation on screen mount. Keep SDK ready/escape behavior, optional anonymous purchase, abort handling and later signup recovery.
- [x] Remove the pre-paywall creator-entry gate from `PaywallStep`; present shared paywall after existing consent. Preserve trusted inbound candidates without auto-claiming typed values, and preserve the separately existing authorized inbound-link consent flow.
- [x] Update Account copy to creator code, retain full-link support, native completed Paste and Go, approved row styling, and no Clear/Cancel link. The existing `CreatorLinkInput` module stays the source of completed paste; typing/onChange only edits.
- [x] Source implements guarded Account submission and immediate monthly offer presentation; source tests and seeded inline fixture contract pass. Actual Account system Paste/Go in the full native app remains pending. Reuse the proven initial inline state contract from Task 1; if unavailable, use the dedicated offer fallback. Never open ordinary full-price purchasing automatically after an unavailable creator offer or dismissal. Ordinary Plans & Billing remains an explicit normal path.
- [x] Test typing/paste/Go distinctions, repeated paste, focus loss, consent refusal, invalid/offline/unavailable/saved creator, no duplicate registration, Account offer X returns to Account, and Cloud X advances once without a second paywall. Test Annual switching preserves saved attribution and normal purchasing.
- [x] Run focused journey tests and commit named files when green. Remove obsolete component code only after searching all callers; avoid unrelated onboarding refactors.

## Task 5: Verify, independently review, and refresh the existing draft

**Files:** `docs/affiliate-integration.md`, this plan's task checkboxes, related release evidence/handover in the owned Titan worktree; only source/tests needed for validated review repairs.

- [x] Update integration documentation to the final implementation, callback request/response contract, isolated route, no-case-folding rule, fixture boundary and actual remaining native proof. Remove superseded claims about the separate Cloud entry screen. Record exact tested source head and evidence dates.
- [x] With Node 24, run focused tests during each task, then required full checks from the mobile folder:

```sh
npm run check
npm test -- --runInBand
git diff --check
```

- [x] Commit intended code/tests and give a fresh independent `deep-review` + `code-quality` reviewer the full feature diff, original approved design/handover, this plan, baseline/current head and validation evidence. Cover user journeys, neighboring billing/onboarding regressions, SDK lifecycle, tests and iOS/Android exclusion. Main agent validates and repairs findings; reviewer rechecks affected repairs.
- [x] Refresh the existing draft #2334 and remote branch before pushing; preserve concurrent work. Update the draft with final behavior and proof limits, then inspect CI on the pushed head. Engineering owns merge. No extra review-message/comment/send is implied.
- [x] Update the resumable handover with Step 1/2/3 completed-versus-pending status and exact next action. Keep desktop readiness and the joint activation decision separate.

## Source validation checkpoint

`npm run check` passed using Node 24 and the existing CocoaPods toolchain: formatting, ESLint (zero errors; 159 warnings), TypeScript, Expo Doctor 20/20 and dependency compatibility. Full Jest and final source head are recorded in the PR/evidence. Independent read-only reviews covered payments/callbacks and Account/Cloud/inbound journeys; findings were repaired and re-reviewed. Repairs include explicit Account cancellation, saved-creator consent, anonymous offer access, inbound provenance, ordinary fallback after storage failure, expiry after asynchronous reads and full-link/short-key identity equivalence.

## Native and connected acceptance still required

The separate fixture established native input/selected-plan keys, returned price/renewal rendering and cached repeat reset. Native follow-up established seed/token display/action keys and explicit clearing on cached repeat. The real product identifier remains absent from the isolated bundle; the complete iPhone/iPad layout/keyboard/lifecycle and native Account system Paste remain pending. The separate probe passed missing-token retry, malformed-price refusal, reachable regular recovery, pending input locking and X/late completion isolation. A compatible new binary is required for the native creator input; an OTA to an old binary is insufficient. Any local runtime proof must retain a distinct development identity and avoid personal-app replacement.

Later separately authorized Apple acceptance uses current catalog, stock, correct app identity/storefront and existing staging setup: real discounted terms, redemption return, anonymous purchase → signup recovery, restore/account switching, app-closed renewals, exactly-once server commission/refund processing and iPhone/iPad coverage. Historical expired codes and previous builds are not acceptance of this change. Production onboarding association and live activation remain held even when all source checks pass.

## Planner self-check

The tasks cover both placement handlers, parser/case boundaries, consent and permanent ownership, explicit stock allocation, Cloud/Account entry, ordinary Annual/Monthly purchasing, safe offer redemption, fixture isolation and stale callbacks. Each review-focus risk has an owning behavior-test task. This was true of the initial read-only planning pass; the execution status above supersedes that pass for subsequent source and isolated probe work.
