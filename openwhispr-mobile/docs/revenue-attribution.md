# iOS subscription revenue attribution

RevenueCat is the authoritative source of subscription revenue, including
renewals while the app is closed. Superwall continues to complete the StoreKit
purchase; RevenueCat remains an observer and does not grant access.

The app supplies `$appsflyerId` only for the requested, identified billing user
when Usage Analytics is enabled and ATT is authorized (or unavailable on that
platform). The AppsFlyer identifier is readable once the SDK is initialized with
consent, before its first session starts, so a purchase made right after the ATT
prompt can carry it. A native lookup is bounded to two seconds and read once per
install. Attribute writes share the existing RevenueCat identity queue with
logins, restores and purchase records.

## Consent

- **Granted** (Usage Analytics on, ATT authorized): the identifier is linked.
- **Revoked** (Usage Analytics off, ATT denied, or no AppsFlyer key in the
  build): the identifier is cleared.
- **Undecided** (the ATT prompt has not been answered on this device) and
  **pending** (a decision not read yet, including the ATT re-check that runs on
  every foreground): nothing changes in the background.

A purchase or restore posts its receipt, with the attributes, right after the
app writes them. Before it posts, the app waits up to one second for a pending
decision, then links the identifier only with this device's consent. Undecided,
revoked or still unknown consent clears it for that post, so a purchase made on a
device without consent is never attributed through another device's link.

An account change or sign-out clears the departing account's identifier, so its
later renewals are not attributed to this device's install. A pending or failed
sign-out cannot relink the departed account.

`$appsflyerId` belongs to the RevenueCat customer, not the device. On an account
used on several devices, the most recent consenting device to open the app or
make a purchase supplies it, and a device that clears it (opt-out, sign-out, or a
purchase without consent) removes it until a consenting device reopens. Each
consenting device writes its identifier again once per app session, since
RevenueCat would otherwise skip a value equal to its local copy and never send it.

## Device identifiers

The app never sends `$idfa`, `$idfv`, `$ip` or `$deviceVersion`: RevenueCat
cannot delete them once set, and AppsFlyer already holds the install's device
identifiers. It writes `$appsflyerId` with `setAttributes`, never with
`setAppsflyerID`, which collects all four on every call, including a clear.
RevenueCat's `automaticDeviceIdentifierCollectionEnabled` option would turn that
off, but PurchasesHybridCommon 19.0.0 (pinned by react-native-purchases 10.10.0)
accepts it without applying it. Revisit this only on an SDK upgrade that
verifiably honours the option.

## Synchronization

Attribute setters are local. RevenueCat pushes pending attributes before
`logIn` and `logOut` switch users (including the login to the same user on every
launch), with every receipt post (purchase record, restore), and in its own
lifecycle syncs. The app asks for an immediate push
(`syncAttributesAndOfferingsIfNeeded`) only when it withdraws an identifier it
linked in this session. That call is limited to 5 per 60 seconds (a throttled
call skips the push without failing), and it also fetches offerings, which fails
in a project without offerings after the attributes are sent; that failure is not
reported. It is not proof of delivery.

A device that is offline or has not reopened after an OS ATT change cannot
instantly notify RevenueCat. Verify actual server deletion and subsequent
renewal suppression before activation. This change does not claim immediate
offline revocation or retroactively remove events already delivered.

## Event ownership

- iOS client `subscription_completed`: product and placement only; a UX milestone.
  Do not map this event to an ad-network purchase or add revenue to it.
- RevenueCat initial paid purchase and trial conversion: `af_subscribe`.
  RevenueCat converts revenue to USD (`af_currency` is always USD) according to
  the project's sales reporting setting. A trial start must use a separate
  non-purchase event.
- RevenueCat paid renewal: `rc_renewal`, with its USD revenue.
- Refund/cancellation semantics must be checked against RevenueCat's actual
  outgoing payload. A cancellation is not automatically a refund; do not assign
  positive purchase revenue to a non-payment event.
- Android client `af_subscribe` remains unchanged. No Android ID bridge is added.

Using the existing iOS `af_subscribe` partner mapping for RevenueCat's initial
paid event avoids duplicating the old client purchase signal on this app version.
It also changes when `af_subscribe` fires: the old client event fired when
Superwall reported a purchase, including a free-trial start or an offer-code
redemption; RevenueCat's fires on the first payment or trial conversion, which
can fall outside short ad-network and SKAN windows. The client event was also
queued until AppsFlyer started, so a purchase made before the first session still
counted; RevenueCat forwards only a purchase whose customer already had
`$appsflyerId`, and never later. Decide whether that loss is acceptable before
activation. Renewal partner mapping is a separate reviewed configuration step.

Builds without this change never set `$appsflyerId`, and RevenueCat forwards
nothing to AppsFlyer without it, so enabling forwarding cannot double-count old
clients. Existing subscribers are linked when they update and open the app,
after which their renewals are forwarded. Do not backfill identifiers for
customers who have not updated, and do not turn on a second AppsFlyer purchase
connector.

## Configuration and activation sequence

The code change enables no RevenueCat integration, but it does change campaign
signal: from this build on, iOS clients stop sending `af_subscribe`. Until
RevenueCat forwarding is live, updated iOS users produce no `af_subscribe` at
all, so forwarding and SKAN must be ready before the build reaches users.

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
   Compare each received amount to its RevenueCat transaction converted to USD;
   do not compare unrelated aggregate totals or count an SDK call as a delivery
   receipt.
5. Before releasing the build:
   - Enable production forwarding. This is safe ahead of the release, since
     older builds never set `$appsflyerId`.
   - In AppsFlyer's SKAN Conversion Studio, check every rule keyed on
     `af_subscribe`. SKAN conversion values are set on the device from SDK
     events, so the client event no longer feeds them on iOS: enable server
     events for SKAN where the mode supports it, or remap the rule, in the same
     window.
   - Update the App Store privacy label: purchases are now linked to the user's
     identity and used for tracking and third-party advertising. The app's
     privacy manifest declares no collected data types; review it at the same
     time.
6. Release the approved app build. Verify one naturally occurring eligible
   production transaction and a renewal. No synthetic production purchase,
   historical backfill, campaign optimization changes, or merge/release
   approval is implied by this runbook.

## Required sandbox evidence

Record build/commit, environment, deidentified event and transaction IDs, event
name, USD amount, RevenueCat delivery status and AppsFlyer receipt. Keep customer
identifiers and credentials out of committed evidence.

| Scenario                                                                     | Required observation                                                                                                                                                               |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New signed-in user; analytics and ATT allowed                                | Correct billing user has the device's `$appsflyerId` before the purchase is recorded. Exactly one revenue event arrives with the expected USD amount.                              |
| Trial start and conversion                                                   | Trial is not a paid purchase. Conversion sends the actual paid value once.                                                                                                         |
| Renewal with app closed                                                      | One server revenue event is delivered, without a second client purchase.                                                                                                           |
| Analytics disabled, ATT denied or not determined                             | No AppsFlyer ID or device identifier (`$idfv`, `$idfa`, `$ip`) is attached and no revenue event is forwarded.                                                                      |
| App foregrounded repeatedly after linking                                    | `$appsflyerId` stays set on the server; no clear-and-reset between foregrounds.                                                                                                    |
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
[RevenueCat AppsFlyer event delivery](https://www.revenuecat.com/docs/integrations/attribution/reference/appsflyer),
[attribute deletion and synchronization](https://www.revenuecat.com/docs/customers/customer-attributes),
[iOS synchronization implementation and rate limit](https://github.com/RevenueCat/purchases-ios/blob/main/Sources/Purchasing/Purchases/Purchases.swift),
[AppsFlyer SKAN Conversion Studio](https://support.appsflyer.com/hc/en-us/articles/4403727223185).
