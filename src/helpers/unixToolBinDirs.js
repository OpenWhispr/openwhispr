const os = require("os");
const path = require("path");

// GUI-launched Electron never sources the user's shell rc, so Nix and Homebrew
// prefixes are missing from PATH even when the tools are installed. Keep the
// extra dirs in one place for ffmpeg resolution and production PATH setup.
function getUnixToolBinDirs({
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
} = {}) {
  const dirs = [];
  if (platform === "darwin") {
    dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  } else if (platform === "linux") {
    dirs.push("/usr/bin", "/usr/local/bin");
  }

  dirs.push("/run/current-system/sw/bin");
  const home = env.HOME || homedir || "";
  if (home) {
    dirs.push(path.join(home, ".nix-profile", "bin"));
    dirs.push(path.join(home, ".local", "state", "nix", "profile", "bin"));
  }
  dirs.push("/nix/var/nix/profiles/default/bin");
  return [...new Set(dirs)];
}

function getSystemFfmpegCandidates(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return ["C:\\ffmpeg\\bin\\ffmpeg.exe"];
  }
  return getUnixToolBinDirs(options).map((dir) => path.join(dir, "ffmpeg"));
}

module.exports = { getUnixToolBinDirs, getSystemFfmpegCandidates };
