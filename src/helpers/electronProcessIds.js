// Audio capture helpers (macOS audio tap, Linux portal capture, Windows
// loopback) are plain child processes, so they never appear in getAppMetrics()
// — yet the OS attributes their capture to their own pids. Without excluding
// them, the app's own system-audio capture reads as an external mic user and
// auto-end can never arm its countdown.
function collectAudioCaptureHelperPids(managers) {
  return managers
    .map((manager) => manager?.process?.pid)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function createElectronProcessIdProvider(
  mainProcessId,
  getAppMetrics,
  getAudioCaptureHelperPids = () => []
) {
  return () => [
    mainProcessId,
    ...getAppMetrics().map(({ pid }) => pid),
    ...getAudioCaptureHelperPids(),
  ];
}

module.exports = createElectronProcessIdProvider;
module.exports.collectAudioCaptureHelperPids = collectAudioCaptureHelperPids;
