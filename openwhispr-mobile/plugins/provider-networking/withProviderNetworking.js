const { withInfoPlist } = require('expo/config-plugins');

module.exports = function withProviderNetworking(config) {
  return withInfoPlist(config, (mod) => {
    mod.modResults.NSLocalNetworkUsageDescription =
      'Connect to AI providers you configure on your local network.';
    mod.modResults.NSAppTransportSecurity = {
      ...mod.modResults.NSAppTransportSecurity,
      NSAllowsLocalNetworking: true,
    };
    return mod;
  });
};
