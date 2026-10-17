const { withGradleProperties } = require('@expo/config-plugins');

module.exports = (config) =>
  withGradleProperties(config, (result) => {
    // The shipped llama.rn binaries log prompt tokens. Compile our privacy patch.
    const key = 'rnllamaBuildFromSource';
    result.modResults = result.modResults.filter((entry) => entry.key !== key);
    result.modResults.push({ type: 'property', key, value: 'true' });
    return result;
  });
