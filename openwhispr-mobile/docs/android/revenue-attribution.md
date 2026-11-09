# Android revenue account attribution

The Android RevenueCat entry point opts into the shared consent-aware AppsFlyer
account link. The iOS entry point and its existing behavior are unchanged.

With Usage Analytics granted, the currently requested and identified billing
account receives the install's `$appsflyerId`. Unknown/pending consent does not
link; explicit withdrawal clears the attribute. Sign-out and account switching
clear departing links recorded by this device. Delayed lookups cannot attach an
identifier to a superseded account.

The same identity queue covers login, logout, purchase, restore and attribution.
Android store operations refresh the link before posting and recheck the caller's
account-validity guard after asynchronous linking. Attribute failures do not
prevent the store operation. No new purchase event or RevenueCat forwarding
configuration is enabled by this change.

Attributes use `setAttributes`, not the SDK convenience setter that also collects
additional device identifiers. A local setter completion is not server receipt:
normal SDK synchronization sends the pending link; withdrawal requests an
immediate attribute synchronization, which can be rate limited. Offline and
already-in-flight requests retain the existing SDK limitations described in
[the consent contract](../revenue-attribution.md).

This bridge links RevenueCat billing accounts to AppsFlyer installation IDs. It
does not set AppsFlyer's separate customer user ID on client events, retroactively
attribute installs, or prove a paid campaign conversion. Verify provider-side
linking/deletion for allocated A/B accounts on the exact signed candidate before
calling installed acceptance complete.
