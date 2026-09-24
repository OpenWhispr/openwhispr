# Creator links and verified monthly offers

Held iOS/iPadOS client port of the accepted flow from `OpenWhispr/openwhispr-mobile#96` (`b5c7124f`) into mobile main `6ecfea8c`. Backend dependency: `OpenWhispr/openwhispr-api#211`, contract reviewed at `13b8a14c21a50feba23bf62a7673cb49c7f55c4c` and unchanged in the subsequent approved head `f949fbe95898e39ba29beb705e4d121f69ae720b`. Android is excluded. This change does not enable production flags, codes, routing, payouts or store release.

## User journey

A trusted cold/warm creator link is retained for the current account. Graduation offers normal text-field paste through “Have a creator link?”. Its main button validates the link; empty input continues normally, and failure retains input for retry or clearing. Plans & Billing offers recovery before a first personal purchase. There is no automatic clipboard reading or client-side commission reporting.

Main changed onboarding since the old draft: Cloud purchasing now occurs before graduation. Fresh setups with affiliate configuration retain the approved graduation → offer/paywall → optional account creation order. The route persists with onboarding progress. Ordinary builds and existing in-progress setups retain main's route, retry controls, private-mode purchase exclusion and completion behavior. Graduation app cards still open the selected app; they cannot skip the affiliate step.

Saving a creator does not promise a discount. The client checks the account, session cookie, stable billing UUID, RevenueCat identity, StoreKit monthly product, storefront, currency, regular price, expiry and rounded 20% offer. A verified card shows three discounted monthly payments and the normal renewal price. Continue opens Apple's official prefilled code-redemption URL. “Not now” leaves without a second paywall. Missing, expired, mismatched or unavailable offers fall back to ordinary Superwall purchasing.

The API keeps the first saved creator permanently. Anonymous purchase remains supported; commission waits for account linking and a verified registered creator. Restore and app return reconcile billing; signed server payment events own commissions. Personal annual purchases can earn commission without this monthly discount. Workspace purchases are excluded by the backend.

**Workspace-member entry remains open:** main represents workspace-only access as subscribed, and its Plans & Billing route manages that existing access. This port retains that behavior. The backend permits a separate personal purchase by a workspace member, but this client does not yet provide a separate entry for it. Define that entry without interrupting workspace access before claiming the full personal-purchase scope is accepted.

## Configuration and consent

Leave `EXPO_PUBLIC_AFFILIATE_DOMAIN` and `EXPO_PUBLIC_AFFILIATE_PUBLISHABLE_KEY` empty for the held release. Only a public `dub_pk_` key belongs in the client. Development uses `open-whispr-affiliate-sandbox.dub.link`; production uses `try.openwhispr.com`. Mismatched environments fail configuration. Associated domains are added only when configured. Production association and App Store fallback remain separate setup.

Usage Analytics and iOS tracking authorization both govern link resolution/claim. Permission is rechecked after validation, before contacting Dub. No new prompt is introduced. Refusal cannot be bypassed; clearing the field permits ordinary continuation.

**First-install acceptance remains open:** tracking authorization is currently requested near the end of onboarding, after purchasing. A fresh device with `notDetermined` cannot claim a creator before that prompt under the existing consent rule. This port preserves the rule and does not infer permission or move the prompt. Decide and validate a consent-compatible first-install journey before activation. Package 0's previous permission state is not proof of this case.

## Account and lifecycle safety

Candidates and resolved click IDs persist before claim retries, with account/revision checks and a ten-second deadline. Switching users clears local ownership. Offer loading has an eight-second deadline; displayed offers remain bound to account, cookie and billing UUID. Dismissal or leaving Plans & Billing cancels late presentation. Reconciliation captures original credentials, discards stale results and serializes native identity changes with purchase sync so another account cannot take over a restore midway. Native callers time out after ten seconds while an uncancellable native operation retains its lock; expired queued operations are skipped. A hung native call requires retry after it settles or app restart, rather than unsafe concurrent identity changes.

## Validation and release limits

The PR records current local/CI results. Package 0 demonstrated US redemption, discounted/normal renewals, refund and cold/warm links on its own build. That is historical evidence, not acceptance of this build. No proof screen or developer purchase/refund controls were ported.

Final acceptance still needs anonymous purchase → signup → one commission, replay, refund/reversal, app-closed renewal, restore/account switching, fresh install, iPad, browser/in-app-browser entry, refused tracking, unavailable offer, offline/restart and mobile-to-desktop continuity. Record the exact sandbox account, app identity, build and impact before installation or purchase. Store changes and public activation remain held for the coordinated desktop/mobile decision.
