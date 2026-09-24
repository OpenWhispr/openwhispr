# Creator links and verified monthly offers

Held iOS/iPadOS client port of the accepted flow from `OpenWhispr/openwhispr-mobile#96` (`b5c7124f`) into mobile main `6ecfea8c`. Backend dependency: `OpenWhispr/openwhispr-api#211`, contract reviewed at `13b8a14c21a50feba23bf62a7673cb49c7f55c4c` and unchanged in the subsequent approved head `f949fbe95898e39ba29beb705e4d121f69ae720b`. Android is excluded. This change does not enable production flags, codes, routing, payouts or store release.

## User journey

A trusted cold/warm creator link is retained for the current account. The existing early paywall screen offers normal text-field paste through “Have a creator link?”. Continue validates the link; empty input continues normally, and failure retains input for retry or clearing. There is no automatic clipboard reading or client-side commission reporting.

**Account recovery (approved option A):** a Free user, including someone who chose Local, expands “Have a creator link?” in Account’s Subscription section. The row uses the existing menu font, link icon, spacing and chevron. A deliberate system Paste starts “Checking your offer…” and opens the verified offer directly; no extra Plans & Billing tap is needed. Typing uses keyboard Go, so an unfinished link cannot commit the permanent creator. If a creator is saved but no offer can be verified, remain inline with Try again, View plans and Not now. View plans explicitly opens ordinary purchasing. Invalid, offline or refused-consent checks retain the input for retry or clearing. Dismissing an offer returns to Account with the creator saved and a Check offer action. Local onboarding and mode selection remain unchanged.

[Approved Account design reference](images/affiliate-account-inline-design.png): this is the September 24 simulated mockup, captured before implementation, with historical US example pricing. It is not a screenshot or acceptance of the native build.

Main's newer onboarding sequence is retained, as Josh selected on September 24: Cloud choice → early paywall → remaining setup → optional account creation → graduation. Creator entry appears before the early paywall opens; valid/empty input proceeds and a failed check remains editable. No separate affiliate route or persisted route flag is added. Graduation and its app shortcuts keep main's completion behavior. Local mode retains its purchase exclusion.

Saving a creator does not promise a discount. The client checks the account, session cookie, stable billing UUID, RevenueCat identity, StoreKit monthly product, storefront, currency, regular price, expiry and rounded 20% offer. A verified card shows three discounted monthly payments and the normal renewal price. Continue opens Apple's official prefilled code-redemption URL. “Not now” leaves without a second paywall. Missing, expired, mismatched or unavailable offers retain ordinary Superwall purchasing through onboarding Continue or an explicit Plans & Billing/View plans action; Account’s automatic paste path never opens the full-price paywall by itself.

The API keeps the first saved creator permanently. Anonymous purchase remains supported; commission waits for account linking and a verified registered creator. Restore and app return reconcile billing; signed server payment events own commissions. Personal annual purchases can earn commission without this monthly discount. Workspace purchases are excluded by the backend.

**Workspace-member entry is a deferred exception:** main represents workspace-only access as subscribed, and its Plans & Billing route manages that existing access. This port retains that behavior. The backend permits a separate personal purchase by a workspace member, but this client does not yet provide a separate entry for it. Josh chose to retain the current UI and explicitly confirmed this omission does not block launch on September 24. A later separate entry must preserve workspace access; its absence is an accepted deferred case, not passed acceptance or a programme launch gate.

## Configuration and consent

Leave `EXPO_PUBLIC_AFFILIATE_DOMAIN` and `EXPO_PUBLIC_AFFILIATE_PUBLISHABLE_KEY` empty for the held release. Only a public `dub_pk_` key belongs in the client. Development uses `open-whispr-affiliate-sandbox.dub.link`; production uses `try.openwhispr.com`. Mismatched environments fail configuration. Associated domains are added only when configured. Production association and App Store fallback remain separate setup.

Usage Analytics and iOS tracking authorization both govern link resolution/claim. Permission is rechecked after validation, before contacting Dub. Affiliate-enabled early paywalls reuse the existing tracking education/native permission step before creator entry. The original attempt marker is saved before requesting permission; the ordinary later step observes it and does not request again. Ordinary builds retain their original timing. Refusal cannot be bypassed; clearing the field permits ordinary continuation.

Josh approved moving the existing consent step before the offer. Authorized and denied responses both return to creator entry; a denied/restricted or disabled-analytics user can clear the field and continue ordinary purchasing. No tracking claim is attempted without permission. The first-install flow now has automated coverage, while clean-device ATT and native/store acceptance remain open.

## Account and lifecycle safety

Candidates and resolved click IDs persist before claim retries, with account/revision checks and a ten-second deadline. Switching users clears local ownership. Offer loading has an eight-second deadline; displayed offers remain bound to account, cookie and billing UUID. Dismissal or leaving Plans & Billing cancels late presentation. Reconciliation captures original credentials, discards stale results and serializes native identity changes with purchase sync so another account cannot take over a restore midway. Native callers time out after ten seconds while an uncancellable native operation retains its lock; expired queued operations are skipped. A hung native call requires retry after it settles or app restart, rather than unsafe concurrent identity changes.

The Account input uses the local iOS `creator-link-input` Expo module. UIKit’s final paste delegate supplies the complete inserted text; it never polls or reads the clipboard. Empty and oversized pastes cannot submit an existing prefix, and drag/drop does not trigger a claim. Event acknowledgements protect newer edits from stale controlled values. Go and accepted Paste dismiss the native keyboard. Leaving Account unmounts the field and invalidates pending callbacks; consent/account checks also guard the claim itself. Onboarding still uses its existing React Native field. **A rebuilt native binary is required** for this module; this is not an OTA-only update.

## Validation and release limits

The PR records current local/CI results. Package 0 demonstrated US redemption, discounted/normal renewals, refund and cold/warm links on its own build. That is historical evidence, not acceptance of this build. No proof screen or developer purchase/refund controls were ported.

Final acceptance still needs actual system Paste/selection/Go and keyboard dismissal on iPhone/iPad, anonymous purchase → signup → one commission, replay, refund/reversal, app-closed renewal, restore/account switching, fresh install, browser/in-app-browser entry, refused tracking, unavailable offer, offline/restart and mobile-to-desktop continuity. Record the exact sandbox account, app identity, build and impact before installation or purchase. Apple setup and connected acceptance remain in the requested new session. Store changes and public activation remain held for the coordinated desktop/mobile decision.
