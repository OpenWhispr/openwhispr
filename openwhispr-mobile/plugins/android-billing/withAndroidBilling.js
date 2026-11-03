const { withProjectBuildGradle } = require('@expo/config-plugins');

const marker = '// OpenWhispr Android billing compatibility';

module.exports = (config) =>
  withProjectBuildGradle(config, (result) => {
    if (result.modResults.contents.includes(marker)) return result;
    // expo-superwall 1.2.0 ships Android 2.7.20, which loses product names when
    // restoring cached paywalls and can leave preview prices on screen.
    // 2.8.3 fixes that cache bug. Its documented Billing 8 compatibility keeps
    // RevenueCat on its supported API instead of pulling in Billing 9.
    // Apply to every project so the native bridge and app resolve the same API.
    result.modResults.contents += `
${marker}
allprojects {
    configurations.configureEach {
        resolutionStrategy.force 'com.superwall.sdk:superwall-android:2.8.3'
        resolutionStrategy.force 'com.android.billingclient:billing:8.3.0'
    }
}
`;
    return result;
  });
