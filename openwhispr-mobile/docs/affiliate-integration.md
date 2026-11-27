# Creator codes and verified monthly offers

iOS/iPadOS only; Android is excluded. The feature is off unless both affiliate environment variables are set.

## Configuration

- `EXPO_PUBLIC_AFFILIATE_DOMAIN` and `EXPO_PUBLIC_AFFILIATE_PUBLISHABLE_KEY`. Only a public `dub_pk_` key belongs in the client.
- Development uses `open-whispr-affiliate-sandbox.dub.link`, production `try.openwhispr.com`. A domain that doesn't match the app environment fails configuration.
- `applinks:<domain>` is added to Associated Domains only when the feature is configured; an unconfigured build gets no entitlement.
- The app calls Dub's `/track/open` endpoint directly, always with the explicit link, so nothing reads the clipboard and no extra native SDK is linked.
- The Account field uses the local `creator-link-input` Expo module (UIKit paste delegate, no pasteboard reads). A binary built without it falls back to a plain text field, so a JS update can't break Account on an older build.

## Consent

Usage Analytics and iOS tracking authorization (`authorized`, or `notSupported`) gate link resolution, claiming, offer allocation and redemption. Permission is checked before each of those steps.

- Onboarding: a user who arrived through a trusted creator link sees the existing tracking step before the paywall, so their offer can be checked. Everyone else keeps the usual order (tracking after signup).
- An explicit **Use code** on the paywall, or Go/Paste on Account, asks iOS for tracking permission if it hasn't asked yet.
- With tracking denied, Account offers **Open Settings**; with Usage Analytics off, **Open Privacy & Data**. Ordinary purchasing stays available either way.

## User journeys

- **Inbound link** (cold or warm start): `app/+native-intent.tsx` captures a trusted link (one trailing slash allowed) and opens Home. Any other link on the creator domain also opens Home, never a route. The candidate persists; `inboundOfferPending` is consumed once, for the first onboarding offer.
- **Onboarding paywall**: only confirmed free Cloud users see it. Monthly shows **Have a creator code?** with an explicit **Use code**; typing never submits. Annual hides the creator controls without deleting saved attribution.
- **Account**: the creator row expands a field that submits on a completed system Paste or keyboard Go. A verified offer opens the Monthly paywall directly. If the offer is unavailable, or the paywall doesn't show it (skipped or failed), the row offers **View plans**. Dismissal never opens another paywall. Leaving Account cancels pending work.
- **Anonymous sessions** can redeem and sign up later. An unclaimed candidate follows the anonymous session into the account it becomes; a claimed one transfers through the server's link workflow.

## Attribution and offer stock

Saving attribution (`/api/affiliate/claim`) and allocating an Apple offer (`/api/affiliate/apple-offer`) are separate mutations. Rendering an ordinary paywall calls neither. The server keeps the first saved creator permanently, and commissions are server-owned. A claim the server accepted is recorded locally even if the screen stopped waiting for it, so a retry finds the creator saved.

## Superwall contract

The paywall with the creator-code input runs under its own placement, `creator_code_paywall`. With creator codes configured, every onboarding paywall and Account's verified creator offer register that placement instead of `onboarding_paywall` / `account_billing_open`. Each keeps its own gate rules: onboarding never sends anyone to sign-in and moves on if Superwall fails; Account's offer fails closed. Plans & Billing and the feature paywalls keep their usual placements, and a build without creator codes never uses this one. The placement needs a campaign in Superwall; if Superwall reports it missing, onboarding moves on without a paywall.

Callback variables are flat dictionary keys, including their dots:

| Request | Name                 | Keys                                                                                                   |
| ------- | -------------------- | ------------------------------------------------------------------------------------------------------ |
| Apply   | `creatorCodeApply`   | the creator input's node value, `products.selectedIndex`, `products.secondary.identifier`              |
| Redeem  | `creatorOfferRedeem` | `products.selectedIndex`, `products.secondary.identifier`, `callbacks.creatorCodeApply.data.*` results |

- Apply returns `priceText`, `renewalText` and `offerToken`, which Redeem sends back as `callbacks.creatorCodeApply.data.<name>`.
- Initial Account/inbound offers use the params `creator_offer_ready`, `creator_offer_price`, `creator_offer_renewal` and `creator_offer_token` (`params.` prefix in callbacks). Superwall keeps omitted params on cached reuse, so every presentation sets all four, with false/empty values for an ordinary paywall.
- `CREATOR_INPUT_KEY` in `src/lib/affiliatePaywall.ts` is the node id of the paywall's creator input. Monthly is `products.selectedIndex === 1` (`secondary`). Update them with the paywall: a mismatch fails closed (codes stop working; ordinary purchase is unaffected).
- Only display strings and an opaque presentation token reach Superwall, never the Apple URL, code, cookies or billing ids.

## Redemption

Redeeming requires the displayed price, renewal text, product and token. It rechecks identity (user, session, RevenueCat app user id), consent, storefront, the StoreKit monthly product, currency, regular price and expiry, then opens the official Apple offer-code URL. It never calls ordinary Purchase.

On return from Apple the app reconciles billing up to three times over about seven seconds. A confirmed subscription completes the gate as a purchase (AppsFlyer subscription event and the usual purchase completion), then closes the paywall. **Use code** stays locked while that check runs, so a single-use code can't be opened twice.

## Release limits

- The native Account field needs a rebuilt binary; older binaries use the plain-field fallback.
- Production paywall routing, the production campaign association and activation are separate release work.
- Workspace members can't yet start a separate personal purchase from Account; this is a deferred case.
