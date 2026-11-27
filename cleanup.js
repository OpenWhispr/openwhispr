const path = require("path");
const fs = require("fs");
const os = require("os");

// Clean build directories
console.log("🧹 Cleaning build directories...");
const dirsToClean = ["dist/", "src/dist/", "node_modules/.cache/"];

dirsToClean.forEach((dir) => {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`✅ Cleaned: ${dir}`);
  } else {
    console.log(`ℹ️ Directory not found: ${dir}`);
  }
});

// Clean development database
console.log("🗄️ Cleaning development database...");
try {
  // Electron's appData folder; development builds keep their userData in
  // OpenWhispr-development inside it (configureChannelUserDataPath in main.js)
  const appDataPath =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : process.platform === "win32"
        ? process.env.APPDATA || os.homedir()
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");

  const devDbPath = path.join(appDataPath, "OpenWhispr-development", "transcriptions-dev.db");
  // The database runs in WAL mode, so its -wal and -shm files go with it
  const devDbFiles = [devDbPath, `${devDbPath}-wal`, `${devDbPath}-shm`].filter((file) =>
    fs.existsSync(file)
  );

  if (devDbFiles.length > 0) {
    devDbFiles.forEach((file) => fs.unlinkSync(file));
    console.log(`✅ Development database cleaned: ${devDbPath}`);
  } else {
    console.log("ℹ️ No development database found to clean");
  }
} catch (error) {
  console.error("❌ Error cleaning database files:", error.message);
}

console.log("✨ Cleanup completed successfully!");
