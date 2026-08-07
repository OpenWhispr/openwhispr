function createElectronProcessIdProvider(mainProcessId, getAppMetrics) {
  return () => [mainProcessId, ...getAppMetrics().map(({ pid }) => pid)];
}

module.exports = createElectronProcessIdProvider;
