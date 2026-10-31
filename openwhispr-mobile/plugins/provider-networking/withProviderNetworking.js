const { withAndroidManifest, withInfoPlist } = require('expo/config-plugins');

module.exports = function withProviderNetworking(config) {
  config = withInfoPlist(config, (mod) => {
    mod.modResults.NSLocalNetworkUsageDescription =
      'Connect to AI providers you configure on your local network.';
    mod.modResults.NSAppTransportSecurity = {
      ...mod.modResults.NSAppTransportSecurity,
      NSAllowsLocalNetworking: true,
    };
    return mod;
  });
  return withAndroidManifest(config, (mod) => {
    // Android's default blocks the private HTTP servers accepted by the provider
    // transport. User-supplied LAN IPs cannot be enumerated in domain-config.
    // This is app-wide permission: ProviderTransport must still reject public
    // HTTP URLs and disable redirects. TLS trust settings remain unchanged.
    mod.modResults.manifest.application[0].$['android:usesCleartextTraffic'] = 'true';
    return mod;
  });
};
