# iOS subscription revenue attribution

RevenueCat is the authoritative source of subscription amounts and currencies,
including renewals while the app is closed. Superwall continues to complete the
StoreKit purchase; RevenueCat remains an observer and does not grant access.

The app supplies `$appsflyerId` only for the requested, identified billing user
when Usage Analytics is enabled and ATT is authorized (or unavailable on that
platform). It waits for a started AppsFlyer session, discards stale lookups, and
bounds a native ID lookup to two seconds. It requests deletion of the identifier
on consent loss and before an account change or sign-out. Attribute writes share
the existing RevenueCat identity queue with logins, restores and purchase records.
A pending/failed sign-out cannot relink the departed account.

Attribute setters are local, so the app also requests an explicit server sync.
A failed or rate-limited sync is not proof of opt-out delivery. Requests are
repeated on later policy/session/purchase signals; the SDK also performs its
normal lifecycle sync. A device that is offline or has not reopened after an OS
ATT change cannot instantly notify RevenueCat. Verify actual server deletion and
subsequent renewal suppression before activation. This change does not claim
immediate offline revocation or retroactively remove events already delivered.

## Event ownership

- iOS client `subscription_completed`: product and placement only; a UX milestone.
  Do not map this event to an ad-network purchase or add revenue to it.
- RevenueCat initial paid purchase and trial conversion: `af_subscribe` with the
  actual amount and currency. A trial start must use a separate non-purchase event.
- RevenueCat paid renewal: `rc_renewal`, retaining the real amount and currency.
- Refund/cancellation semantics must be checked against RevenueCat's actual
  outgoing payload. A cancellation is not automatically a refund; do not assign
  positive purchase revenue to a non-payment event.
- Android client `af_subscribe` remains unchanged. No Android ID bridge is added.

Using the existing iOS `af_subscribe` partner mapping for RevenueCat's initial
paid event avoids duplicating the old client purchase signal on this app version.
Renewal partner mapping is a separate reviewed configuration step. Existing
clients do not implement the identifier bridge; do not backfill identifiers into
old customers or turn on a second AppsFlyer purchase connector.

## Configuration and activation sequence

The code change does not enable a RevenueCat integration or alter ad campaigns.

1. Review and merge the app change, then produce the agreed iOS test build. Check
   its exact commit/build version and that both SDK public configuration keys are
   present. Use an AppsFlyer test device and a dedicated test destination where
   available; keep sandbox events out of production campaign conversion goals.
2. In RevenueCat project `a7fed962`, prepare an **iOS app-specific** AppsFlyer
   integration for App Store ID `6763804420`. Do not enable a general integration
   that also routes Android or web-store transactions. Enter credentials through
   the provider UI/secret configuration, never in this file or a PR.
3. Configure sandbox credentials first, event names as above, and **gross revenue**
   for customer purchase value. Verify the actual UI's initial purchase, trial
   conversion, renewal, cancellation and optional-event behavior before saving;
   retain a redacted configuration receipt. Keep production forwarding off during
   sandbox acceptance. If sandbox-only saving is unavailable, stop at a prepared
   configuration rather than enabling production to obtain a test.
4. Complete the acceptance checks below, including the server-side opt-out check.
   Compare each received amount/currency to its RevenueCat transaction; do not
   compare unrelated aggregate totals or count an SDK call as a delivery receipt.
5. Release the approved app build and enable production forwarding only after
   that evidence is reviewed. Verify one naturally occurring eligible production
   transaction and a renewal. No synthetic production purchase, historical
   backfill, campaign optimization changes, or merge/release approval is implied
   by this runbook.

## Required sandbox evidence

Record build/commit, environment, deidentified event and transaction IDs, event
name, amount/currency, RevenueCat delivery status and AppsFlyer receipt. Keep
customer identifiers and credentials out of committed evidence.

| Scenario                                                                     | Required observation                                                                                                                                                               |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New signed-in user; analytics and ATT allowed                                | Correct billing user has the device's `$appsflyerId` before the purchase is recorded. Exactly one revenue event arrives with the correct currency and amount.                      |
| Trial start and conversion                                                   | Trial is not a paid purchase. Conversion sends the actual paid value once.                                                                                                         |
| Renewal with app closed                                                      | One server revenue event is delivered, without a second client purchase.                                                                                                           |
| Analytics disabled, ATT denied or not determined                             | No AppsFlyer ID is attached and no revenue event is forwarded.                                                                                                                     |
| Consent withdrawn after a successful purchase                                | Server `$appsflyerId` is removed; a subsequent sandbox renewal produces no AppsFlyer delivery. Check reopening after an offline change and rapid changes that hit SDK rate limits. |
| Sign-out, failed sign-out, or A-to-B switch while login/ID lookup is pending | No late ID write relinks A or attaches A's lookup to B; old account's attribute is cleared on the server.                                                                          |
| Restore or app restart                                                       | Access and reconciliation still work; no additional client purchase/revenue event is generated.                                                                                    |
| Sync/network failure                                                         | Billing remains observable/reconcilable; report attribute-delivery failure separately from purchase success, and confirm recovery on reconnect/reopen.                             |

The native SDK queue retains its existing deadline behavior: a hung native call
releases its caller at the deadline but holds the identity lock until it settles.
This prevents a late native operation from mutating a different user's identity;
it is not a guarantee that purchase observation completes while native calls hang.

Configuration, app release, provider delivery and campaign attribution are
separate acceptance results. Passing unit tests does not prove any of the latter.

References: [RevenueCat AppsFlyer integration](https://www.revenuecat.com/docs/integrations/attribution/appsflyer),
[attribute deletion and synchronization](https://www.revenuecat.com/docs/customers/customer-attributes),
[iOS synchronization implementation and rate limit](https://github.com/RevenueCat/purchases-ios/blob/main/Sources/Purchasing/Purchases/Purchases.swift).
