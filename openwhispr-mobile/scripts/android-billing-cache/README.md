# Cached Android paywall price regression

The paywall uses `products.primary.price` and `products.secondary.price`. Native
Superwall 2.7.20 serializes each reference name under `product`, then reads only
`reference_name` when restoring it. Product loading can succeed while the cached
paywall loses those names and displays its preview price.

This narrow characterization probe exercises the actual released SDK serializer,
without mocking product data or a purchase. Run it with Java 17 and a classpath
containing `classes.jar` extracted from the selected Superwall AAR, Kotlin stdlib,
and Kotlinx serialization core/json JVM jars from the resolved Gradle dependencies:

```sh
java --class-path "$SDK_CLASSPATH" scripts/android-billing-cache/ProductCacheProbe.java
```

It fails against 2.7.20 and passes against 2.8.3. It does **not** prove rendered
pricing or purchase acceptance; those require the Play-installed app, including a
cold restart with existing cached paywalls.

`withAndroidBilling` pins Android 2.8.3 and Billing 8.3.0 across the native bridge
and app. RevenueCat currently uses Billing 8.3.0. Revisit these pins when upgrading
the Expo wrapper and RevenueCat; do not let a transitive Billing 9 upgrade bypass
purchase and restore validation.

Sources: [upstream fix](https://github.com/superwall/Superwall-Android/compare/2.8.2...2.8.3),
[Billing 8 compatibility](https://github.com/superwall/Superwall-Android/blob/2.8.3/CHANGELOG.md#280).
