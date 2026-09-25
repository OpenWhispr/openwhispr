# Creator links and verified monthly offers

Held iOS/iPadOS client port of the accepted flow from `OpenWhispr/openwhispr-mobile#96` (`b5c7124f`) into mobile main `6ecfea8c`. Backend dependency: `OpenWhispr/openwhispr-api#211`, contract reviewed at `13b8a14c21a50feba23bf62a7673cb49c7f55c4c` and unchanged in the subsequent approved head `f949fbe95898e39ba29beb705e4d121f69ae720b`. Android is excluded. This change does not enable production flags, codes, routing, payouts or store release.

## User journey

Cloud remains choose mode → existing consent → the shared Superwall paywall → remaining setup → optional signup. There is no separate creator-entry Continue screen. Monthly alone exposes the underlined **Have a creator code?** link, input and explicit **Use code**. Typing/pasting into the paywall does not submit. Annual hides creator controls without deleting saved attribution. The CTA is **Continue to payment**; the X closes the paywall. The Apple-next sentence and footer Not now/Keep using Local text were removed at Josh's request.

Short entry accepts an exact lowercase key (`[a-z0-9][a-z0-9_-]{0,63}`), never case-folding another identity. Full trusted HTTPS links retain their exact key case and tracking query/fragment. Identity comparison uses the exact key after trusted-domain validation. Domain case settings remain unverified; this implementation does not infer case-insensitivity or require a backend canonicalization change.

A trusted cold/warm inbound link retains its existing consented attribution path. A persisted `inboundOfferPending` bit records only that explicit inbound intent, survives its claim, and is consumed once for the first Cloud offer lookup. It is not a navigation route and is not inferred from a saved or merely typed candidate. An in-flight claim is allowed a bounded wait, avoiding duplicate claims. Failed optional storage or unavailable offers preserve ordinary Cloud purchasing.

**Account recovery:** the existing 17 px regular menu row, icon and chevron expand the creator code/link field. UIKit's completed system Paste or keyboard Go explicitly submits; ordinary editing does not. A valid completed entry prepares attribution, loads a verified offer, and opens the same monthly Superwall screen without another Plans & Billing tap. The private offer is passed inside the app, with only display strings and a presentation token forwarded to Superwall. Anonymous sessions can take this verified offer path and sign up later; ordinary Account billing retains its existing authentication rules. Leaving Account aborts pending registration. Offer dismissal does not open another paywall. Unavailable offers stay inline; View plans and Plans & Billing explicitly open ordinary purchasing without claiming a candidate or allocating stock.

Saving attribution and allocating an Apple offer are distinct mutations. `/api/affiliate/apple-offer` allocates stock; rendering an ordinary paywall never calls it. A discount is returned only after explicit preparation and verification of account/cookie/billing ownership, consent, current StoreKit monthly product, storefront, currency, regular price, expiry and rounded 20% terms. A presentation holds the Apple redemption URL privately. Redemption requires the same displayed price, renewal, product and presentation token and repeats the currentness/catalog/consent checks before opening the official Apple URL. The discounted action must never invoke ordinary Purchase.

The API keeps the first saved creator permanently. Anonymous purchase remains supported; commission waits for account linking and a verified registered creator. Restore and app return reconcile billing; signed server payment events own commissions. Personal annual purchases can earn commission without this monthly discount. Workspace purchases are excluded by the backend.

**Workspace-member entry is a deferred exception:** main represents workspace-only access as subscribed, and its Plans & Billing route manages that existing access. This port retains that behavior. The backend permits a separate personal purchase by a workspace member, but this client does not yet provide a separate entry for it. Josh chose to retain the current UI and explicitly confirmed this omission does not block launch on September 24. A later separate entry must preserve workspace access; its absence is an accepted deferred case, not passed acceptance or a programme launch gate.

## Configuration and consent

Leave `EXPO_PUBLIC_AFFILIATE_DOMAIN` and `EXPO_PUBLIC_AFFILIATE_PUBLISHABLE_KEY` empty for the held release. Only a public `dub_pk_` key belongs in the client. Development uses `open-whispr-affiliate-sandbox.dub.link`; production uses `try.openwhispr.com`. Mismatched environments fail configuration. Associated domains are added only when configured. Production association and App Store fallback remain separate setup.

Usage Analytics and iOS tracking authorization govern link resolution, claiming and offer allocation. Permission is checked before collection/allocation and before returning or redeeming an offer, including previously saved attribution. Cloud reuses the existing tracking education/native permission step after mode selection. Its original attempt marker prevents another request in the later step. Refusal leaves ordinary purchasing available.

## Superwall contract and current proof

The isolated draft is **app 38286 / paywall 271365**, `Creator Code TEST DRAFT 2026-09-25`. Its probe campaign **109201** serves only placement `creator_code_probe_20260925` when `device.bundleId == "com.openwhispr.creatorcode.probe20260925"`; no catchall audience exists. Original paywall **239043** and live Cloud sync **93302** are unchanged. Production `onboarding_paywall` association remains unresolved and held. Installed versions are `expo-superwall` **1.2.0** / SuperwallKit **4.16.1**.

The fixture-only separate native probe in `scripts/creator-paywall-probe/` exercised actual callbacks, asynchronous checking, returned fictional price/renewal rendering, Annual hiding/Monthly restoration, custom offer-action routing, X dismissal and clean cached repeat presentation. It loads no attribution/API service and refuses purchase, restore and redemption. Its unique bundle has no real StoreKit catalog, so this does not prove ordinary product pricing or Apple purchasing.

Observed request dictionary keys are **flat strings including dots**, not nested objects:

| Request | Name                 | Keys                                                                                                                 |
| ------- | -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Apply   | `creatorCodeApply`   | `node.o9Et2gOJEgdSPj0nV1CkE.value`, `products.selectedIndex`                                                         |
| Redeem  | `creatorOfferRedeem` | `products.selectedIndex`, `callbacks.creatorCodeApply.data.priceText`, `callbacks.creatorCodeApply.data.renewalText` |

The renderer stores returned data at exact leaf paths. The parent `callbacks.creatorCodeApply.data` stays empty; testing that parent or omitting exact Liquid `requiredStateIds` silently loses display data. The test draft was repaired to reference price/renewal/message leaves.

**Final binding work is still pending.** Source additionally requires `products.secondary.identifier` on both callbacks and `callbacks.creatorCodeApply.data.offerToken` on redemption. Initial Account/inbound offers use placement parameters `creator_offer_ready`, `creator_offer_price`, `creator_offer_renewal`, `creator_offer_token` (callback keys prefixed `params.`). The final editor contract must bind these, render initial state, clear it on repeat presentation, and choose only the custom redemption action whenever a discount is shown. The current native fixture proof predates these additions. The editor relay disconnected while the shared browser moved to unrelated work; no final product/token/seed edit or native retest is claimed. Do not route customer journeys to this draft until that contract passes.

Product bindings remain annual `primary`/index 0 and monthly `secondary`/index 1, with Monthly default in the test copy. Ordinary prices use SDK product variables. Failure or malformed/missing display data must retain an editable/recoverable state without silently purchasing full price. Keep URL/code, cookies, billing identifiers and creator identifiers out of returned display data and logs.

## Account and lifecycle safety

Candidates and resolved click IDs persist before claim retries, with account/revision checks and a ten-second deadline. Switching users clears local ownership. Offer loading has an eight-second deadline; displayed offers remain bound to account, cookie and billing UUID. Dismissal or leaving Plans & Billing cancels late presentation. Reconciliation captures original credentials, discards stale results and serializes native identity changes with purchase sync so another account cannot take over a restore midway. Native callers time out after ten seconds while an uncancellable native operation retains its lock; expired queued operations are skipped. A hung native call requires retry after it settles or app restart, rather than unsafe concurrent identity changes.

The Account input uses the local iOS `creator-link-input` Expo module. UIKit’s final paste delegate supplies the complete inserted text; it never polls or reads the clipboard. Empty and oversized pastes cannot submit an existing prefix, and drag/drop does not trigger a claim. Event acknowledgements protect newer edits from stale controlled values. Go and accepted Paste dismiss the native keyboard. Leaving Account unmounts the field and invalidates pending callbacks; consent/account checks also guard the claim itself. The paywall uses Superwall’s native input; Account keeps the local input module. **A rebuilt native binary is required** for this module; this is not an OTA-only update.

## Validation and release limits

The PR records current local/CI results. Package 0 demonstrated US redemption, discounted/normal renewals, refund and cold/warm links on its own build. That is historical evidence, not acceptance of this build. No financial test controls were ported. The separate probe is fixture-only and cannot purchase or redeem.

Final acceptance still needs actual system Paste/selection/Go and keyboard dismissal on iPhone/iPad, anonymous purchase → signup → one commission, replay, refund/reversal, app-closed renewal, restore/account switching, fresh install, browser/in-app-browser entry, refused tracking, unavailable offer, offline/restart and mobile-to-desktop continuity. Record the exact sandbox account, app identity, build and impact before installation or purchase. Apple setup and connected acceptance remain in the requested new session. Store changes and public activation remain held for the coordinated desktop/mobile decision.
