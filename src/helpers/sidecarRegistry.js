const debugLogger = require("./debugLogger");

const SHUTDOWN_DEADLINE_MS = 8000;

const sidecars = [];

function register(name, stopFn) {
  sidecars.push({ name, stop: stopFn });
}

async function shutdownAll() {
  if (sidecars.length === 0) return;

  const deadline = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DEADLINE_MS));
  const stops = Promise.allSettled(
    sidecars.map(async ({ name, stop }) => {
      try {
        await stop();
      } catch (err) {
        debugLogger.error("sidecar stop failed", { name, error: err?.message });
      }
    })
  );
  await Promise.race([stops, deadline]);
}

module.exports = { register, shutdownAll };
