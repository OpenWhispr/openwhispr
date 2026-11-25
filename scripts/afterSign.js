// electron-builder awaits this hook before NSIS builds or publishes the installer.
const {
  inspectWindowsSignatures,
  isApprovedSignature,
  isSignedWindowsBuild,
} = require("./lib/windows-signatures");

exports.default = async function (context) {
  if (!isSignedWindowsBuild(context)) return;

  const report = await inspectWindowsSignatures(context);
  if (report.length === 0) {
    throw new Error("afterSign: no Windows binaries found to verify");
  }
  const failures = report
    .filter((signature) => !isApprovedSignature(signature, context.packager))
    .map(
      ({ file, error, publisher }) => `${file}: ${error || `unexpected publisher ${publisher}`}`
    );
  if (failures.length > 0) {
    throw new Error(
      `afterSign: Windows Authenticode verification failed:\n  ${failures.join("\n  ")}`
    );
  }

  console.log(`  afterSign: verified ${report.length} timestamped Windows binary signatures`);
};
