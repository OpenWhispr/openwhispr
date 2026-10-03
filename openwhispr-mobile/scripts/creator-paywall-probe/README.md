# Creator paywall callback probe

This standalone development entry exercises the isolated Superwall draft using fictional `DEMO_ONLY` input. It is not imported by the customer app. It does not load OpenWhispr authentication, API, Dub, RevenueCat, attribution, or billing stores. Its custom purchase controller refuses every purchase and restore; creator redemption is always refused. Returned prices are labeled TEST.

The probe requires all three boundaries: `__DEV__`, native bundle ID `com.openwhispr.creatorcode.probe20260925`, and `EXPO_PUBLIC_CREATOR_PROBE_SUPERWALL_KEY`. Configure the public SDK key for app **38286** privately in the standalone project's ignored environment file. Never paste keys into evidence or source.

Dashboard route: campaign **109201**, placement `creator_code_probe_20260925`, with the sole audience filter `device.bundleId == "com.openwhispr.creatorcode.probe20260925"`. The audience allocates 100% to paywall **271365**, `Creator Code TEST DRAFT 2026-09-25`. It has no catch-all audience. Do not add this route to a production bundle or change the existing Cloud sync campaign.

## Reproduce

1. Use Node 24 and the installed Expo 55 / React Native 0.83.10 dependencies, `expo-superwall` 1.2.0, `expo-application` 55.0.19. Create a separate temporary Expo project, copy `Probe.tsx` and `callback.ts`, and use an `index.tsx` that calls `registerRootComponent(Probe)` from `expo`.
2. Set its iOS bundle identifier to the probe ID above. Prebuild only that temporary project and install its CocoaPods dependencies; the resulting lockfile must retain SuperwallKit 4.16.1. Cold launch in a dedicated simulator. Never import the probe into the customer app: native Superwall configuration is one-shot and a prior purchase controller can survive a JavaScript reload.
3. Start Metro on a free localhost port. Build and install only the separate probe binary. If needed, launch it with the React Native development argument `-RCT_jsLocation localhost:<port>` to select that local server. No customer application is replaced.
4. Open the isolated paywall and enter `DEMO_ONLY`. Record only callback names, variable **paths and types**, fictional-marker presence, public paywall/product identifiers, and visible TEST results. The callback helper intentionally does not log scalar input values. Never enter a real creator code.
5. Exercise failure, success, Annual hiding, Monthly return, ordinary product action refusal, offer action refusal, X while pending and repeat presentation. Report native results separately from the unit tests. A passing fixture does not prove real offers, Apple eligibility, or payment acceptance.

The discovery helper accepts the marker at any nested path solely to discover the native SDK's request shape. A production parser must validate exact observed keys, types and selected plan; it must never reuse that recursive discovery logic. A fixture response must never reach real attribution, offer allocation or redemption services.

## Final-contract fixtures

The buttons select `valid`, `seed`, `seed-missing`, `retry-missing`, `missing`, `malformed`, `failure`, or `slow`. Every presentation supplies all four seed parameters; ordinary scenarios explicitly send `false` and empty strings because the native SDK retains omitted keys on cached reuse. Seed scenarios use only TEST display strings and a fictional presentation token. `retry-missing` returns a token once and omits it on subsequent applies in the same presentation. `slow` waits 15 seconds so dismissal can precede its completion.

On September 25, the isolated native probe rendered seeded Account display values, hid/restored them on Annual/Monthly, invoked `creatorOfferRedeem` with exact `params.*` display/token keys, and displayed returned callback-token values. A seeded-to-ordinary cached repeat reproduced parameter retention; explicit clearing then restored the collapsed ordinary screen. The unique bundle has no StoreKit product catalog, so `products.secondary.identifier` was omitted in actual callback requests. Product-binding configuration is read back, but native catalog acceptance remains pending.

The final saved revision also passed a same-presentation complete-response → redemption refusal → missing-token retry (old token not reused), a numeric malformed-price response (no payment callback), visible explicit regular-plan recovery, blocked input edits during checking, X before a delayed response, and a clean replacement presentation after that response completed. These are isolated fixture observations, not full customer-app or physical-device acceptance.
