# iOS subscription revenue attribution

RevenueCat is the authoritative source of subscription revenue, including
renewals while the app is closed. Superwall continues to complete the StoreKit
purchase; RevenueCat remains an observer and does not grant access.

`$appsflyerId` belongs to the RevenueCat customer (the billing account), not
to a device, and RevenueCat forwards every purchase and renewal of that account
with whatever value the account holds. The app treats it as the account's link,
set by the account's consenting devices.

A device links its own AppsFlyer identifier for the requested, identified billing
user when Usage Analytics is enabled and ATT is authorized (or unavailable on
that platform). The identifier is readable once the AppsFlyer SDK is initialized
with consent, before its first session starts, so a purchase made right after
the ATT prompt can carry it. A native lookup is bounded to two seconds; a
successful read is kept for the rest of the app session, and a failed one is
retried. Attribute writes share the existing RevenueCat identity queue with
logins, restores and purchase records.

## Consent

- **Granted** (Usage Analytics on, ATT authorized): the device links its
  identifier, and links it again before every purchase it records and every
  restore, since another device may have changed the account's link.
- **Revoked** (Usage Analytics off, ATT denied): an explicit opt-out on this
  device clears the account's link.
- **Undecided** (the ATT prompt not answered on this device, or a build without
  AppsFlyer) and **pending** (a decision not read yet: preference not hydrated,
  or a full ATT re-check in progress): the device never touches the account's
  link.

ATT is read in full, which briefly stops AppsFlyer and reads as pending, at
launch, on AppsFlyer's session-ready signal and when the app returns from the
background, since iOS Settings can change it. A return from an inactive state
(the StoreKit sheet, Face ID, or a paywall's own tracking prompt) re-reads it
without stopping anything and applies only a change, so a grant on a paywall
takes effect at once. The onboarding prompt reports its own result.

The device keeps a record, across launches, of the billing accounts whose link
it set. Signing out or switching accounts clears the departing account's link
only when this device set it, and a withdrawal of such a link is pushed to
RevenueCat at once, even in a later session. A device that never linked the
account leaves another device's link alone, and a pending or failed sign-out
cannot relink the departed account.

Accepted consequences of the account-level link:

- A purchase or restore on a device without consent is forwarded with the
  account's current link, which another, consenting device set. That device's
  own identifiers are never read or sent.
- Purchases RevenueCat posts by itself (an offer code redeemed in the App Store,
  Ask to Buy, or its observer-mode detection when the app becomes active) carry
  whatever the account's link is at that moment; the app does not link again
  first.
- The most recent consenting device to open the app or make a purchase supplies
  the link. An explicit opt-out on any device clears it until a consenting device
  next opens the app; that device then writes its identifier again, once per app
  session and before each purchase or restore, by clearing and setting it
  locally, since RevenueCat skips a value equal to its local copy. A RevenueCat
  sync that lands between those two local writes can send the cleared value; if
  the receipt post that follows reaches the server first, the account may hold
  no link until that device's next launch or purchase.
- After one device's explicit opt-out has cleared the link, that device's later
  clears are no-ops while its local copy stays empty, so a link a consenting
  device sets afterwards stays in place. RevenueCat forgets the local copy when
  the device switches accounts, so the opt-out clears once more after a switch.

## Device identifiers

The app never sends `$idfa`, `$idfv`, `$ip` or `$deviceVersion` as subscriber
attributes: RevenueCat cannot delete them once set, and AppsFlyer already holds
the install's device identifiers. It writes `$appsflyerId` with `setAttributes`,
never with `setAppsflyerID`, which collects all four on every call, including a
clear. RevenueCat's `automaticDeviceIdentifierCollectionEnabled` option would
turn that off, but PurchasesHybridCommon 19.0.0 (pinned by react-native-purchases
10.10.0) accepts it without applying it. Revisit this only on an SDK upgrade
that verifiably honours the option. A clear writes an empty string: the React
Native bridge drops keys whose value is `null`, so a `null` would clear nothing.

Independently of this change, the RevenueCat SDK sends the IDFV in a request
header on every call, and sends its own `$attConsentStatus` (the ATT status, not
an identifier) whenever that status changes.

## Synchronization

Attribute setters are local. RevenueCat pushes pending attributes before
`logIn` and `logOut` switch users (including the login to the same user on every
launch), with a receipt post (a recorded purchase, a restore that finds
transactions, or a purchase it detects itself), and in its own lifecycle syncs
when the app enters the foreground or resigns active (which a StoreKit sheet or
system alert also causes). The app asks for an immediate push
(`syncAttributesAndOfferingsIfNeeded`) only when it withdraws a link this device
set. That call is limited to 5 per 60 seconds (a throttled call skips the push
without failing), and it also fetches offerings, which fails in a project
without offerings after the attributes are sent; that failure is not reported.
It is not proof of delivery.

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

| Scenario                                                                     | Required observation                                                                                                                                                                |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New signed-in user; analytics and ATT allowed                                | Correct billing user has the device's `$appsflyerId` (a plain AppsFlyer ID string) before the purchase is recorded. Exactly one revenue event arrives with the expected USD amount. |
| Trial start and conversion                                                   | Trial is not a paid purchase. Conversion sends the actual paid value once.                                                                                                          |
| Renewal with app closed                                                      | One server revenue event is delivered, without a second client purchase.                                                                                                            |
| Analytics disabled, ATT denied or not determined (single device)             | This device's AppsFlyer ID is never read or attached, no device identifier (`$idfv`, `$idfa`, `$ip`) is sent as a subscriber attribute, and no revenue event is forwarded.          |
| Same account on two devices, one without consent                             | The device without consent never sends its own ID and, if undecided, never clears the account's link; an explicit opt-out clears it until the consenting device reopens.            |
| App foregrounded repeatedly after linking, and a purchase sheet closing      | `$appsflyerId` stays set on the server between foregrounds.                                                                                                                         |
| ATT allowed from a paywall's tracking prompt, then a purchase on it          | The purchase carries this device's `$appsflyerId` without leaving the app first.                                                                                                    |
| Consent withdrawn after a successful purchase                                | Server `$appsflyerId` is removed; a subsequent sandbox renewal produces no AppsFlyer delivery. Check reopening after an offline change and rapid changes that hit SDK rate limits.  |
| Sign-out, failed sign-out, or A-to-B switch while login/ID lookup is pending | No late ID write relinks A or attaches A's lookup to B; old account's attribute is cleared on the server.                                                                           |
| Restore or app restart                                                       | Access and reconciliation still work; no additional client purchase/revenue event is generated.                                                                                     |
| Sync/network failure                                                         | Billing remains observable/reconcilable; report attribute-delivery failure separately from purchase success, and confirm recovery on reconnect/reopen.                              |

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
